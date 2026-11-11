"""Fixed, offline ext4 copy/grow/verify primitive. Never changes a registry pointer."""
import hashlib
import json
import os
import pathlib
import re
import selectors
import signal
import stat
import subprocess
import time
import uuid
from contextlib import contextmanager

MiB = 1024 * 1024
TOOLS = {
    'check': '/usr/sbin/e2fsck', 'resize': '/usr/sbin/resize2fs',
    'geometry': '/usr/sbin/dumpe2fs', 'mkfs': '/usr/sbin/mkfs.ext4',
    'findmnt': '/usr/bin/findmnt', 'mount': '/usr/bin/mount', 'umount': '/usr/bin/umount',
}
ALLOWED_SIZES = (256 * MiB, 512 * MiB, 1024 * MiB)
UUID = re.compile(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$')


class Ext4MigrationError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def refuse(message, code='EXT4_MIGRATION_REVIEW_REQUIRED'):
    raise Ext4MigrationError(code, message + '; original and any new image were retained')


def parse_geometry(output):
    values = {}
    wanted = {'Block count', 'Free blocks', 'Block size', 'Inode count', 'Free inodes',
              'Filesystem state', 'Filesystem UUID', 'Filesystem features'}
    for line in output.splitlines():
        if ':' not in line:
            continue
        key, value = (item.strip() for item in line.split(':', 1))
        if key in wanted:
            if key in values:
                refuse('Duplicate ext4 geometry field')
            values[key] = value
    if set(values) != wanted:
        refuse('Incomplete ext4 geometry')
    result = {}
    for key, name in [('Block count', 'blocks'), ('Free blocks', 'freeBlocks'),
                      ('Block size', 'blockSize'), ('Inode count', 'inodes'), ('Free inodes', 'freeInodes')]:
        if not re.fullmatch(r'[0-9]+', values[key]):
            refuse('Invalid ext4 geometry number')
        result[name] = int(values[key])
    if (result['blockSize'] not in (1024, 2048, 4096) or result['blocks'] < 1
            or result['freeBlocks'] > result['blocks'] or result['inodes'] < 1
            or result['freeInodes'] > result['inodes'] or values['Filesystem state'] != 'clean'
            or not UUID.fullmatch(values['Filesystem UUID'])):
        refuse('Unclean or unsupported ext4 geometry')
    result.update(bytes=result['blocks'] * result['blockSize'],
                  freeBytes=result['freeBlocks'] * result['blockSize'],
                  uuid=values['Filesystem UUID'], features=values['Filesystem features'].split())
    return result


class Ext4MigrationBackend:
    """The caller supplies a trusted project outer directory and a live host lease checker.

    Supported layout: outer/disk.img (legacy), images/<32hex-or-UUID>.img. New targets
    are only below images/. No model argument can supply tool paths or commands.
    """
    def __init__(self, root, assert_lease, check_cancel=None):
        self.root = pathlib.Path(root)
        if not callable(assert_lease) or (check_cancel is not None and not callable(check_cancel)):
            refuse('A trusted live lease callback is required')
        self.assert_lease = assert_lease
        self.check_cancel = check_cancel
        self._private(self.root)

    def _checkpoint(self):
        self.assert_lease()
        if self.check_cancel is not None:
            self.check_cancel()

    def _private(self, directory):
        info = directory.lstat()
        if (not stat.S_ISDIR(info.st_mode) or directory.resolve() != directory
                or info.st_uid != os.getuid() or info.st_mode & 0o077):
            refuse('Unsafe private migration directory')
        return info

    def _path(self, image, target=False):
        image = pathlib.Path(image)
        if not image.is_absolute() or image.parent not in (self.root, self.root / 'images'):
            refuse('Image path is outside the trusted project layout')
        if image.parent == self.root:
            if target or image.name != 'disk.img':
                refuse('Only the legacy source may use disk.img')
        elif image.suffix != '.img' or not (UUID.fullmatch(image.stem) or re.fullmatch(r'[a-f0-9]{32}', image.stem)):
            refuse('Image identity is not a fixed identifier')
        self._private(self.root)
        if image.parent != self.root:
            if target and not os.path.lexists(image.parent):
                self._checkpoint()
                image.parent.mkdir(mode=0o700)
            self._private(image.parent)
        return image

    def _tool(self, key):
        file = pathlib.Path(TOOLS[key])
        resolved = file.resolve(strict=True)
        expected = '/usr/sbin/mke2fs' if key == 'mkfs' else str(file)
        if str(resolved) != expected:
            refuse('Fixed filesystem tool resolves to an unexpected path', 'EXT4_TOOL_UNAVAILABLE')
        for parent in (resolved.parent, resolved.parent.parent):
            info = parent.stat()
            if info.st_uid != 0 or info.st_mode & 0o022:
                refuse('Filesystem tool directory is writable', 'EXT4_TOOL_UNAVAILABLE')
        info = resolved.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or not info.st_mode & 0o111:
            refuse('Fixed filesystem tool is unsafe', 'EXT4_TOOL_UNAVAILABLE')
        return str(file)

    def _run(self, key, args, accepted=(0,), cleanup=False, timeout=120):
        if os.geteuid() != 0:
            refuse('Filesystem maintenance requires the root controller', 'EXT4_TOOL_UNAVAILABLE')
        if not cleanup:
            self._checkpoint()
        command = [self._tool(key), *map(str, args)]
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, start_new_session=True,
                                 env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'HOME': '/nonexistent'})
        output = bytearray()
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + timeout
        try:
            while selector.get_map():
                if not cleanup:
                    self._checkpoint()
                if time.monotonic() >= deadline:
                    refuse('Filesystem tool timed out', 'EXT4_TOOL_FAILED')
                for selected, _ in selector.select(0.1):
                    chunk = os.read(selected.fileobj.fileno(), 8192)
                    if not chunk:
                        selector.unregister(selected.fileobj)
                    else:
                        output.extend(chunk)
                        if len(output) > 65536:
                            refuse('Filesystem tool output exceeded its bound', 'EXT4_TOOL_FAILED')
            code = child.wait(timeout=5)
            if code not in accepted:
                refuse('Fixed filesystem tool refused the operation', 'EXT4_TOOL_FAILED')
            return output.decode('utf-8', errors='strict')
        finally:
            selector.close()
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=5)
            child.stdout.close()

    def _unattached(self, image, after_unmount=False):
        # Linux loop autoclear destroys devices asynchronously after a successful
        # umount. Only that owned cleanup may wait; an existing attachment at
        # entry is never detached, reused, or accepted as a new operation.
        deadline = time.monotonic() + 3 if after_unmount else None
        while True:
            attached = False
            for file in pathlib.Path('/sys/block').glob('loop*/loop/backing_file'):
                try:
                    attached = attached or file.read_text().strip() == str(image)
                except FileNotFoundError:
                    # The kernel may remove the sysfs node while it is scanned.
                    continue
            if not attached:
                return
            if deadline is None or time.monotonic() >= deadline:
                refuse('Image has an existing loop attachment', 'EXT4_IMAGE_BUSY')
            time.sleep(0.02)

    def _identity(self, image, size):
        if size not in ALLOWED_SIZES:
            refuse('Unsupported image size')
        handle = os.open(image, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(handle)
            if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.getuid()
                    or before.st_mode & 0o177 or before.st_size != size):
                refuse('Unsafe image identity, mode, ownership or size')
            digest = hashlib.sha256()
            while True:
                self._checkpoint()
                block = os.read(handle, 256 * 1024)
                if not block:
                    break
                digest.update(block)
            after = image.lstat()
            keys = ('st_dev', 'st_ino', 'st_size', 'st_mode', 'st_uid', 'st_gid', 'st_mtime_ns', 'st_ctime_ns')
            if any(getattr(before, key) != getattr(after, key) for key in keys):
                refuse('Image changed during complete verification')
            return {'sha256': digest.hexdigest(), 'allocatedBytes': before.st_blocks * 512,
                    'identity': tuple(getattr(before, key) for key in keys)}
        finally:
            os.close(handle)

    def _geometry(self, image):
        self._run('check', ['-fn', image])
        return parse_geometry(self._run('geometry', ['-h', image]))

    def _mount_identity(self, image, mount):
        output = self._run('findmnt', ['-rn', '--mountpoint', mount, '--output', 'SOURCE,FSTYPE,OPTIONS'], cleanup=True)
        fields = output.strip().split()
        options = set(fields[2].split(',')) if len(fields) == 3 else set()
        if (len(fields) != 3 or fields[1] != 'ext4' or not re.fullmatch(r'/dev/loop[0-9]+', fields[0])
                or not {'ro', 'nodev', 'nosuid', 'noexec'} <= options
                or not {'noload', 'norecovery'} & options):
            refuse('Read-only ext4 mount identity is not confirmed', 'EXT4_CLEANUP_UNKNOWN')
        loop = pathlib.Path('/sys/block') / pathlib.Path(fields[0]).name
        if ((loop / 'loop/backing_file').read_text().strip() != str(image)
                or int((loop / 'loop/offset').read_text()) or int((loop / 'loop/sizelimit').read_text())
                or int((loop / 'ro').read_text()) != 1 or mount.stat().st_dev != os.stat(fields[0]).st_rdev):
            refuse('Read-only loop identity changed', 'EXT4_CLEANUP_UNKNOWN')

    @contextmanager
    def _readonly(self, image):
        self._checkpoint()
        self._unattached(image)
        mount = self.root / ('.migration-mount-' + str(uuid.uuid4()))
        mount.mkdir(mode=0o700)
        mounted = False
        try:
            self._run('mount', ['-t', 'ext4', '-o', 'loop,ro,noload,nodev,nosuid,noexec', image, mount])
            mounted = True
            self._mount_identity(image, mount)
            yield mount
        finally:
            if mounted or os.path.ismount(mount):
                self._mount_identity(image, mount)
                self._run('umount', [mount], cleanup=True)
                self._unattached(image, after_unmount=True)
            if mount.exists() and not os.path.ismount(mount):
                mount.rmdir()

    def _tree(self, mount):
        digest, owners = hashlib.sha256(), hashlib.sha256()
        links = {}
        entries = 0
        def visit(file, relative):
            nonlocal entries
            self._checkpoint()
            entries += 1
            if entries > 65536:
                refuse('Filesystem tree entry limit exceeded')
            info = file.lstat()
            row = {'path': relative, 'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid,
                   'gid': info.st_gid, 'mtimeNs': info.st_mtime_ns}
            owners.update(json.dumps([relative, row['uid'], row['gid'], row['mode']], ensure_ascii=True).encode())
            attributes = []
            for name in sorted(os.listxattr(file, follow_symlinks=False)):
                attributes.append([name, hashlib.sha256(os.getxattr(file, name, follow_symlinks=False)).hexdigest()])
            row['xattrs'] = attributes
            if stat.S_ISDIR(info.st_mode):
                row['kind'] = 'directory'
            elif stat.S_ISLNK(info.st_mode):
                row.update(kind='symlink', target=os.readlink(file))
            elif stat.S_ISREG(info.st_mode):
                key = (info.st_dev, info.st_ino)
                row.update(kind='file', size=info.st_size, hardlinkTo=links.setdefault(key, relative))
                handle = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                try:
                    before = os.fstat(handle)
                    if (before.st_dev, before.st_ino) != key:
                        refuse('Filesystem file changed before verification')
                    content = hashlib.sha256()
                    while True:
                        self._checkpoint()
                        block = os.read(handle, 256 * 1024)
                        if not block:
                            break
                        content.update(block)
                    after = file.lstat()
                    if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns):
                        refuse('Filesystem file changed during verification')
                    row['sha256'] = content.hexdigest()
                finally:
                    os.close(handle)
            else:
                refuse('Unsupported special filesystem entry')
            digest.update(json.dumps(row, sort_keys=True, ensure_ascii=True, separators=(',', ':')).encode() + b'\n')
            if row['kind'] == 'directory':
                for child in sorted(file.iterdir(), key=lambda value: value.name):
                    visit(child, relative + '/' + child.name)
        visit(mount, '')
        disk = os.statvfs(mount)
        return {'treeHash': digest.hexdigest(), 'ownershipHash': owners.hexdigest(), 'treeEntries': entries,
                'availableBytes': disk.f_bavail * disk.f_frsize, 'availableInodes': disk.f_favail}

    def inspect(self, image, expected_bytes, expected_sha256=None):
        image = self._path(image)
        self._checkpoint()
        self._unattached(image)
        before = self._identity(image, expected_bytes)
        if expected_sha256 is not None and before['sha256'] != expected_sha256:
            refuse('Complete original image hash differs')
        geometry = self._geometry(image)
        if geometry['bytes'] != expected_bytes:
            refuse('Actual filesystem geometry differs from the image contract')
        with self._readonly(image) as mount:
            tree = self._tree(mount)
        after = self._identity(image, expected_bytes)
        if before != after:
            refuse('Read-only verification changed the original image')
        return {'imageSha256': after['sha256'], 'allocatedBytes': after['allocatedBytes'],
                'imageIdentity': list(after['identity']), 'geometry': geometry, **tree}

    def copy_resize_verify(self, source_image, target_image, source_bytes, target_bytes,
                           expected_source_sha256, expected_target_inodes=None):
        if source_bytes not in ALLOWED_SIZES or target_bytes not in ALLOWED_SIZES or target_bytes <= source_bytes:
            refuse('Only supported filesystem growth is allowed')
        source, target = self._path(source_image), self._path(target_image, target=True)
        if os.path.lexists(target):
            refuse('The original target must be inspected; it cannot be overwritten or recopied')
        original = self.inspect(source, source_bytes, expected_source_sha256)
        disk = os.statvfs(self.root)
        if disk.f_bavail * disk.f_frsize < target_bytes + 1024 * MiB + 2 * MiB or disk.f_favail < 8:
            refuse('Insufficient independent filesystem space or inodes', 'EXT4_MIGRATION_CAPACITY')
        self._checkpoint()
        input_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            output_fd = os.open(target, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except BaseException:
            os.close(input_fd)
            raise
        try:
            remaining = source_bytes
            while remaining:
                self._checkpoint()
                block = os.read(input_fd, min(256 * 1024, remaining))
                if not block:
                    refuse('Original image became incomplete during copy')
                remaining -= len(block)
                view = memoryview(block)
                while view:
                    written = os.write(output_fd, view)
                    if not written:
                        refuse('New image copy made no progress')
                    view = view[written:]
            if os.read(input_fd, 1):
                refuse('Original image grew during copy')
            os.fsync(output_fd)
            self._checkpoint()
            os.ftruncate(output_fd, target_bytes)
            os.fsync(output_fd)
        finally:
            os.close(input_fd)
            os.close(output_fd)
        self._checkpoint()
        if self._identity(source, source_bytes)['sha256'] != original['imageSha256']:
            refuse('Original image changed during copy')
        self._geometry(target)
        self._run('resize', [target])
        self._checkpoint()
        for file in (target, target.parent):
            descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        resized = self.inspect(target, target_bytes)
        if (resized['geometry']['uuid'] != original['geometry']['uuid']
                or resized['geometry']['blocks'] <= original['geometry']['blocks']
                or resized['geometry']['inodes'] < original['geometry']['inodes']
                or expected_target_inodes is not None and resized['geometry']['inodes'] < expected_target_inodes
                or resized['treeHash'] != original['treeHash'] or resized['ownershipHash'] != original['ownershipHash']):
            refuse('Resized filesystem geometry, ownership or full tree does not match')
        retained = self.inspect(source, source_bytes, expected_source_sha256)
        if retained != original:
            refuse('Original filesystem changed during target growth')
        self._checkpoint()
        return {'version': 1, 'source': retained, 'target': resized, 'originalRetained': True,
                'filesystemResized': True, 'registryChanged': False, 'interruptedCopyContinuation': 'unsupported',
                'automaticRollback': 'unsupported'}
