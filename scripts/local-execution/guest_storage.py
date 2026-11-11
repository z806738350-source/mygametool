"""Root-only bounded project storage; untrusted tasks never receive this interface."""
import base64
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import tarfile
import time
import uuid
import zlib
import fcntl
import pwd
import grp
import stat
from contextlib import contextmanager
import guest_lifecycle as lifecycle
from guest_runtime_capacity import PROFILE_ID, RUNTIME_PROFILE, RUNTIME_PROFILES, runtime_profile, runtime_media_file_limit

ROOT = pathlib.Path('/var/lib/ohmygame/volumes')
LOCK = pathlib.Path('/run/ohmygame-storage.lock')
MAX_REQUEST = 24 * 1024 * 1024
MAX_FILES = 2000
MAX_BYTES = 8 * 1024 * 1024
MEDIA_FILE = 32 * 1024 * 1024
MEDIA_TOTAL = 64 * 1024 * 1024


def media_file_limit(relative, profile_id=None):
    limit = runtime_media_file_limit(relative, profile_id)
    return MEDIA_FILE if limit == RUNTIME_PROFILE['mediaFileBytes'] else limit
RASTER_RETURN_BYTES = 512 * 1024
STATIC_RASTER_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp'}
MEDIA_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mp3', '.wav', '.ogg', '.glb', '.mov', '.m4a', '.avif'}
GAME_ASSET_EXTENSIONS = MEDIA_EXTENSIONS | {'.svg', '.fbx', '.bmp', '.gltf', '.obj', '.mtl'}
GENERATED = {'node_modules', 'dist', 'build', 'out'}
PRIVATE_DIRECTORIES = {'.ssh', '.aws', '.azure', '.gnupg', '.kube', '.codex', '.claude', '.agents',
    'pi-agent', 'agent-runtimes', 'external-mcp', 'plugin-data', 'plugin-setup', 'agent-attachments',
    'request-image-previews', 'request-files', 'agent-media', 'audio-attempts', 'image-requests',
    'provider-image-sources', 'video-tasks', 'model3d-tasks', 'manual-vm.lock'}
PRIVATE_SETTINGS = {'openai-images.json', 'seedance.json', 'minimax.json', 'volcengine-tts.json',
    'volcengine-seed-audio.json', 'meshy.json', 'tripo.json', 'hyper3d.json', 'network-settings.json',
    'web-search-settings.json', 'plugin-settings.json', 'isolated-execution.json'}
VOLUME_BYTES = 256 * 1024 * 1024
_REVIEW_LOCKED = False
_EX_LOCK = None

@contextmanager
def locked():
    global _EX_LOCK
    if _EX_LOCK is not None:
        raise lifecycle.LifecycleError('ACTIVE_OPERATION', 'A storage mutation lease is already held')
    descriptor = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid()
                or info.st_mode & 0o022 or LOCK.resolve() != LOCK):
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'The exclusive storage lock is not private and stable')
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        _EX_LOCK = (descriptor, info.st_dev, info.st_ino, os.getpid())
        assert_storage_lease()
        yield
    finally:
        _EX_LOCK = None
        os.close(descriptor)


def assert_storage_lease():
    if _EX_LOCK is None or _EX_LOCK[3] != os.getpid():
        raise lifecycle.LifecycleError('CAPACITY_LEASE_REQUIRED', 'The original exclusive storage lease is no longer held')
    fd, device, inode, _ = _EX_LOCK
    info, current = os.fstat(fd), LOCK.lstat()
    if ((info.st_dev, info.st_ino) != (device, inode) or (current.st_dev, current.st_ino) != (device, inode)
            or not stat.S_ISREG(current.st_mode) or current.st_nlink != 1 or current.st_uid != os.getuid()
            or current.st_mode & 0o022 or LOCK.resolve() != LOCK):
        raise lifecycle.LifecycleError('CAPACITY_LEASE_REQUIRED', 'The original exclusive storage lock identity changed')

@contextmanager
def read_locked():
    """Inspect an existing lock only; an overview must never initialize guest state."""
    descriptor = None
    try:
        descriptor = os.open(LOCK, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        value = os.fstat(descriptor)
        if (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1
                or value.st_uid != os.getuid() or value.st_mode & 0o022 or LOCK.resolve() != LOCK):
            raise OSError('Unsafe storage lock')
        fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
        current = LOCK.lstat()
        if ((current.st_dev, current.st_ino) != (value.st_dev, value.st_ino)
                or not stat.S_ISREG(current.st_mode) or current.st_nlink != 1
                or current.st_uid != os.getuid() or current.st_mode & 0o022):
            raise OSError('Storage lock changed')
    except OSError:
        if descriptor is not None:
            os.close(descriptor)
        raise lifecycle.LifecycleError('OVERVIEW_UNAVAILABLE', 'Storage inspection is busy or unavailable') from None
    try:
        yield
    finally:
        os.close(descriptor)

@contextmanager
def review_locked(initialize=False):
    """Only explicit retained review may create an empty control lock; no registry is initialized."""
    global _REVIEW_LOCKED, _EX_LOCK
    if _EX_LOCK is not None:
        raise lifecycle.LifecycleError('ACTIVE_OPERATION', 'A storage mutation lease is already held')
    descriptor = None
    try:
        try:
            descriptor = os.open(LOCK, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            if not initialize:
                raise
            parent = LOCK.parent.lstat()
            if (not stat.S_ISDIR(parent.st_mode) or LOCK.parent.resolve() != LOCK.parent
                    or parent.st_uid != os.getuid() or parent.st_mode & 0o022):
                raise OSError('Unsafe storage lock directory')
            try:
                descriptor = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
            except FileExistsError:
                descriptor = os.open(LOCK, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid()
                or info.st_mode & 0o022 or LOCK.resolve() != LOCK):
            raise OSError('Unsafe storage lock')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = LOCK.lstat()
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise OSError('Storage lock changed')
    except OSError:
        if descriptor is not None:
            os.close(descriptor)
        raise lifecycle.LifecycleError('ACTIVE_OPERATION', 'Storage review is busy or unavailable; no volume was changed') from None
    try:
        _REVIEW_LOCKED = True
        _EX_LOCK = (descriptor, info.st_dev, info.st_ino, os.getpid())
        yield
    finally:
        _REVIEW_LOCKED = False
        _EX_LOCK = None
        os.close(descriptor)

def command(args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)

def identifier(value):
    result = str(uuid.UUID(value))
    if result != value:
        raise ValueError('Invalid project identity')
    return result

def private_name(value):
    name = value.lower().rstrip('. ')
    if (name in PRIVATE_DIRECTORIES or name in PRIVATE_SETTINGS or name.startswith('.env')
            or re.search(r'\.(?:pem|key|p12|pfx|jks|keystore)(?:[._-]|$)|^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-]|$)', name)):
        return True
    if pathlib.PurePosixPath(name).suffix in GAME_ASSET_EXTENSIONS and not re.search(r'\.(?:json|ya?ml|toml|ini|conf|txt)\.', name):
        return False
    return bool(re.search(r'(?:^|[._-])(?:auth|credentials?|secrets?|keys?|api[-_]?keys?|local[-_]?api[-_]?keys?|tokens?|passwords?|daemon[-_]runtime)(?:[._-]|$)', name))

def excluded_source_path(relative):
    return any(part.startswith('.') or private_name(part) for part in relative.split('/'))

def safe_path(value):
    parts = value.split('/')
    if not value or len(value.encode('utf-16-le')) // 2 > 1000 or any(not p or p in ('.', '..') or p.startswith('.') or '\\' in p or '\x00' in p for p in parts):
        raise ValueError('Invalid transfer path')
    if any(private_name(part) for part in parts):
        raise ValueError('Private transfer path')
    return pathlib.PurePosixPath(value)

def runtime_media_path(relative):
    name = pathlib.PurePosixPath(relative)
    return name.suffix.lower() in MEDIA_EXTENSIONS and (bool(set(name.parts[:-1]) & {'public', 'src'})
        or name.parts[:2] in (('assets', 'imported'), ('assets', 'generated'), ('assets', 'files')))

def media_header(path, data, size, profile_id=None):
    if size > MEDIA_FILE:
        if size > media_file_limit(path, profile_id):
            return False
        if data[4:8] == b'ftyp':
            box_size, header = int.from_bytes(data[:4], 'big'), 8
            if box_size == 1:
                if len(data) < 16: return False
                box_size, header = int.from_bytes(data[8:16], 'big'), 16
            if box_size < header + 8 or box_size > 256 or box_size > len(data) or (box_size - header) % 4:
                return False
            image_brands = {b'avif', b'avis', b'mif1', b'msf1', b'miaf', b'heic', b'heix', b'hevc', b'hevx', b'heim', b'heis', b'hevm', b'hevs', b'heif'}
            brands = [data[header:header + 4], *[data[offset:offset + 4] for offset in range(header + 8, box_size, 4)]]
            if any(brand in image_brands for brand in brands): return False
    kind = pathlib.PurePosixPath(path).suffix.lower()
    if kind == '.png':
        return data.startswith(b'\x89PNG\r\n\x1a\n')
    if kind in ('.jpg', '.jpeg'):
        return data.startswith(b'\xff\xd8\xff')
    if kind in ('.webp', '.wav'):
        return data.startswith(b'RIFF') and data[8:12] == (b'WEBP' if kind == '.webp' else b'WAVE')
    if kind == '.gif':
        return data[:6] in (b'GIF87a', b'GIF89a')
    if kind == '.avif':
        return data[4:8] == b'ftyp' and data[8:12] in (b'avif', b'avis', b'mif1')
    if kind == '.mov':
        return len(data) >= 12 and data[4:8] in (b'ftyp', b'moov', b'mdat', b'wide')
    if kind in ('.mp4', '.m4a'):
        return len(data) >= 12 and data[4:8] == b'ftyp'
    if kind == '.webm':
        return data.startswith(b'\x1a\x45\xdf\xa3')
    if kind == '.mp3':
        return data.startswith(b'ID3') or len(data) >= 2 and data[0] == 255 and data[1] & 224 == 224
    if kind == '.ogg':
        return data.startswith(b'OggS')
    return kind == '.glb' and data[:8] == b'glTF\x02\x00\x00\x00' and int.from_bytes(data[8:12], 'little') == size


def idle(project):
    for file in pathlib.Path('/run/ohmygame-control').glob('*.json'):
        state = json.loads(file.read_text())
        if state.get('projectId') == project:
            active = subprocess.run(['systemctl', 'is-active', state['unit']], capture_output=True).stdout.strip()
            if active in (b'active', b'activating'):
                raise ValueError('Stop the project operation before transferring files')

def volume(project, size=VOLUME_BYTES):
    raise lifecycle.LifecycleError('PROTOCOL_REQUIRED', 'Namespace-bound lifecycle v2 is required')

def workspace(project):
    mount = volume(project)
    target = mount / 'workspace'
    if target.is_symlink() or not target.is_dir():
        raise ValueError('Isolated workspace is unavailable')
    return target

def owner(project):
    raise lifecycle.LifecycleError('PROTOCOL_REQUIRED', 'A claimed lifecycle identity is required')

def validate_package(value):
    data = base64.b64decode(value['data'], validate=True)
    if len(data) > 4 * 1024 * 1024 or hashlib.sha512(data).hexdigest() != value['sha512']:
        raise ValueError('Package integrity failed')
    decoder = zlib.decompressobj(31)
    unpacked = decoder.decompress(data, 32 * 1024 * 1024 + 1)
    if len(unpacked) > 32 * 1024 * 1024 or not decoder.eof or decoder.unused_data:
        raise ValueError('Package expansion exceeded its limit')
    manifest = None
    with tarfile.open(fileobj=io.BytesIO(unpacked), mode='r:') as archive:
        for index, member in enumerate(archive):
            parts = pathlib.PurePosixPath(member.name).parts
            if index >= 3000 or not parts or parts[0] != 'package' or '..' in parts or member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe package archive')
            if member.name == 'package/package.json':
                if member.size > 65536:
                    raise ValueError('Package manifest exceeded its limit')
                manifest = json.load(archive.extractfile(member))
    if not manifest or manifest.get('name') != value['name'] or manifest.get('version') != value['version']:
        raise ValueError('Package identity failed')
    if any(manifest.get('scripts', {}).get(key) for key in ('preinstall', 'install', 'postinstall')):
        raise ValueError('Package installation scripts are unsupported')
    return data

def preserve_modules(previous, incoming):
    """Keep only installed package roots still present in the bounded incoming source tree."""
    retained = []
    for base, dirs, names in os.walk(incoming, followlinks=False):
        if 'package.json' not in names:
            continue
        relative = pathlib.Path(base).relative_to(incoming)
        if relative != pathlib.Path('.'):
            safe_path(str(relative))
        source_root = previous / relative
        modules = source_root / 'node_modules'
        if not modules.exists() and not modules.is_symlink():
            continue
        if source_root.resolve(strict=True) != source_root or modules.is_symlink() or not modules.is_dir():
            raise ValueError('Installed package roots must not be linked')
        target = pathlib.Path(base) / 'node_modules'
        if target.exists() or target.is_symlink() or len(retained) >= 8:
            raise ValueError('Installed package root budget exceeded')
        retained.append((modules, target))
    # Validate every destination before moving anything out of the previous workspace.
    for source, target in retained:
        source.rename(target)

def export(project, relative=''):
    project = identifier(project)
    idle(project)
    root = workspace(project)
    return export_tree(root, relative)

@contextmanager
def artifact_reader(root, path):
    """Resolve each component against its pinned directory; never follow links into other storage."""
    parts = safe_path(path).parts
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(fd, 'rb') as stream:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise ValueError('Invalid artifact file')
            yield stream, before
            after = os.fstat(fd)
            named = os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
            if ((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                    != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                    or (named.st_dev, named.st_ino) != (after.st_dev, after.st_ino)):
                raise ValueError('Artifact changed while reading')
    finally:
        os.close(directory)


def transfer_media(stream, size, output=None):
    digest = hashlib.sha256()
    remaining = size
    while remaining:
        block = stream.read(min(512 * 1024, remaining))
        if not block:
            raise ValueError('Artifact media ended early')
        digest.update(block)
        if output is not None:
            output.write(block)
        remaining -= len(block)
    if stream.read(1):
        raise ValueError('Artifact media grew during transfer')
    return digest.hexdigest()


def export_tree(root, relative='', runtime_media=None, output_stream=None, media_limit=None, profile_id=None):
    package = root / safe_path(relative) if relative else root
    if not package.is_dir() or package.resolve(strict=True) != package:
        raise ValueError('Invalid artifact package root')
    files, media, generated = [], [], []
    total = media_size = generated_size = 0
    media_limit = MEDIA_TOTAL if media_limit is None else media_limit
    approved = {(item['sha256'], item['size']) for item in (runtime_media or {}).values()}
    for name in ('dist', 'build', 'out'):
        output = package / name
        if output.is_symlink():
            raise ValueError('Artifact links are forbidden')
        if not output.exists():
            continue
        if not output.is_dir():
            raise ValueError('Invalid artifact output directory')
        for base, dirs, names in os.walk(output, followlinks=False):
            for entry in dirs + names:
                if (pathlib.Path(base) / entry).is_symlink():
                    raise ValueError('Artifact links are forbidden')
            for entry in names:
                file = pathlib.Path(base) / entry
                path = str(file.relative_to(package))
                if len(files) + len(media) + len(generated) >= MAX_FILES:
                    raise ValueError('Invalid artifact file count')
                with artifact_reader(root, str(file.relative_to(root))) as (stream, info):
                    size = info.st_size
                    if ((approved or output_stream is not None) and 0 < size <= media_file_limit(path, profile_id)
                            and not info.st_mode & 0o111 and file.suffix.lower() in MEDIA_EXTENSIONS
                            and media_header(path, stream.peek(256)[:256], size, profile_id)):
                        digest = transfer_media(stream, size)
                        copied = (digest, size) in approved
                        if size > MEDIA_FILE and not copied:
                            raise ValueError('Large artifact media is not a verified registered copy; isolated data is retained')
                        if copied or output_stream is not None:
                            media_size += size
                            if media_size > media_limit:
                                raise ValueError('Artifact media exceeded the runtime asset budget')
                            if not copied:
                                generated_size += size
                                if generated_size > MEDIA_TOTAL:
                                    raise ValueError('Generated artifact payload exceeds its single 64 MiB return window')
                            (media if copied else generated).append({'path': path, 'size': size, 'sha256': digest})
                            continue
                        stream.seek(0)
                    if size > 2 * 1024 * 1024:
                        raise ValueError('Invalid artifact file size, format or permissions')
                    total += size
                    if total > MAX_BYTES:
                        raise ValueError('Artifacts exceeded the transfer budget')
                    data = stream.read(size + 1)
                    if len(data) != size:
                        raise ValueError('Artifact changed while reading')
                    files.append({'path': path, 'data': base64.b64encode(data).decode(), 'sha256': hashlib.sha256(data).hexdigest()})
    manifest = {'files': files, **({'media': media} if media else {})}
    if output_stream is None:
        return manifest

    # The host verifies each payload and the successful end of the response before it publishes any output.
    if generated:
        manifest['generatedMedia'] = generated
    header = json.dumps(manifest, separators=(',', ':')).encode() + b'\n'
    if len(header) > 16 * 1024 * 1024:
        raise ValueError('Artifact manifest exceeded the transfer budget')
    output_stream.write(header)
    for item in generated:
        path = str((package / item['path']).relative_to(root))
        with artifact_reader(root, path) as (stream, info):
            if (info.st_mode & 0o111 or info.st_size != item['size']
                    or not media_header(item['path'], stream.peek(16)[:16], info.st_size)
                    or transfer_media(stream, info.st_size, output_stream) != item['sha256']):
                raise ValueError('Build media changed after inspection')
    output_stream.flush()


def source(project):
    project = identifier(project)
    idle(project)
    root = workspace(project)
    return {'files': source_tree(root)}


def volume_write(action, *args, **kwargs):
    """Classify only a known project-volume write, never input pipes or capacity guesses."""
    try:
        return action(*args, **kwargs)
    except OSError as cause:
        mapped = lifecycle.capacity_error(cause, volume=True)
        if mapped is not None:
            raise mapped from cause
        raise


def source_entries(root, errors=None):
    """Stream at most 4,000 entries, including excluded names, without following links."""
    pending = [root]
    entries = 0
    while pending:
        directory = pending.pop()
        try:
            if directory.is_symlink() or directory.resolve() != directory:
                raise OSError('Source directory became linked')
            with os.scandir(directory) as scan:
                for item in scan:
                    entries += 1
                    if entries > 4000:
                        if errors is None:
                            raise ValueError('Source inspection entry limit exceeded; isolated data is retained')
                        errors.append('entry-limit')
                        return
                    target = pathlib.Path(item.path)
                    relative = str(target.relative_to(root))
                    excluded = item.name in GENERATED or excluded_source_path(relative)
                    yield target, excluded
                    if not excluded and item.is_dir(follow_symlinks=False):
                        try:
                            safe_path(relative)
                        except ValueError:
                            continue
                        pending.append(target)
        except OSError:
            if errors is None:
                raise ValueError('A source directory could not be read; isolated data is retained') from None
            errors.append('unreadable')


def source_tree(root, baseline=None, raster_returns=False, retained_rasters=None, media_limit=None, profile_id=None):
    files = []
    total = media_size = raw_size = 0
    media_limit = MEDIA_TOTAL if media_limit is None else media_limit
    baseline = baseline or {}
    approved_media = {(item['size'], item['sha256']) for item in baseline.values() if 'size' in item}
    approved_sizes = {size for size, _ in approved_media}
    walk_errors = []
    for path, excluded in source_entries(root, walk_errors):
        if excluded:
            continue
        relative = str(path.relative_to(root))
        safe_path(relative)
        if path.is_symlink():
            raise ValueError('Invalid source tree or link: ' + relative + '; isolated data is retained')
        if path.is_dir():
            continue
        stat = path.lstat()
        relative = str(path.relative_to(root))
        if not path.is_file() or stat.st_nlink != 1 or len(files) + len(retained_rasters or []) >= MAX_FILES:
            raise ValueError('Invalid source file: ' + relative + '; isolated data is retained')
        original = baseline.get(relative)
        registered_media = original is not None and 'size' in original
        copied_media = False
        digest = None
        eligible = runtime_media_path(relative)
        review_raster = retained_rasters is not None and eligible and pathlib.PurePosixPath(relative).suffix.lower() in STATIC_RASTER_EXTENSIONS
        if registered_media or original is None and eligible and 0 < stat.st_size <= media_file_limit(relative, profile_id) or review_raster:
            if registered_media and (stat.st_mode & 0o111 or not 0 < stat.st_size <= media_file_limit(relative, profile_id) or not eligible):
                raise ValueError('Invalid runtime asset in source capture: ' + relative + ' (' + str(stat.st_size)
                    + ' bytes); isolated data is retained for recovery review')
            with artifact_reader(root, relative) as (stream, info):
                if any(getattr(stat, field) != getattr(info, field)
                        for field in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_mode')):
                    raise ValueError('Source changed before capture: ' + relative + '; isolated data is retained')
                header_matches = media_header(relative, stream.peek(256)[:256], info.st_size, profile_id)
                if registered_media or info.st_size in approved_sizes or review_raster:
                    if review_raster and info.st_size > MEDIA_FILE:
                        raise ValueError('Retained raster exceeds its bounded review size; isolated data is retained')
                    digest = transfer_media(stream, info.st_size)
                    copied_media = (registered_media or original is None) and (info.st_size, digest) in approved_media
                unchanged_ordinary = (original is not None and not registered_media and digest == original['sha256']
                    and bool(stat.st_mode & 0o111) == bool(original.get('executable')))
                if not header_matches and not (review_raster and unchanged_ordinary):
                    raise ValueError('Runtime media header does not match its extension: ' + relative
                        + ' (' + str(info.st_size) + ' bytes); isolated data is retained for recovery review')
        if stat.st_size > MEDIA_FILE and not copied_media:
            raise ValueError('Large runtime media is not a verified registered copy: ' + relative + '; isolated data is retained')
        if review_raster and not copied_media and (original is None or digest != original['sha256']
                or bool(stat.st_mode & 0o111) != bool(original.get('executable'))):
            if stat.st_mode & 0o111 or digest is None or not 0 < stat.st_size <= MEDIA_FILE:
                raise ValueError('Retained raster must be a bounded non-executable file; isolated data is retained')
            media_size += stat.st_size
            raw_size += stat.st_size
            if media_size > media_limit or raw_size > MEDIA_TOTAL:
                raise ValueError('Retained raster and verified media exceed their shared review budget')
            retained_rasters.append({'path': relative, 'size': stat.st_size, 'sha256': digest, 'executable': False})
            continue
        if retained_rasters is not None and registered_media and not copied_media:
            raise ValueError('Unverified runtime media change requires separate review; isolated data is retained')
        raster_candidate = (raster_returns and registered_media and not copied_media and digest != original['sha256']
            and pathlib.PurePosixPath(relative).suffix.lower() in STATIC_RASTER_EXTENSIONS
            and 0 < stat.st_size <= RASTER_RETURN_BYTES and not stat.st_mode & 0o111)
        if (registered_media or copied_media) and not raster_candidate:
            media_size += stat.st_size
            if media_size > media_limit or digest is None or stat.st_mode & 0o111:
                raise ValueError('Invalid runtime asset in source capture: ' + relative + ' (' + str(stat.st_size)
                    + ' bytes); isolated data is retained for recovery review')
            files.append({'path': relative, 'size': stat.st_size, 'sha256': digest})
            continue
        if stat.st_size > 2 * 1024 * 1024:
            raise ValueError('Source file exceeds the 2 MiB return limit: ' + relative + ' (' + str(stat.st_size)
                + ' bytes); only unchanged approved runtime media can be returned as copies; isolated data is retained for recovery review')
        total += stat.st_size
        if total > MAX_BYTES or len(files) + len(retained_rasters or []) >= MAX_FILES:
            raise ValueError('Source return exceeded its budget')
        with artifact_reader(root, relative) as (stream, info):
            if any(getattr(stat, field) != getattr(info, field)
                    for field in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_mode')):
                raise ValueError('Source changed before capture: ' + relative + '; isolated data is retained')
            data = stream.read(2 * 1024 * 1024 + 1)
            if len(data) != info.st_size:
                raise ValueError('Source changed during capture: ' + relative + '; isolated data is retained')
        digest = hashlib.sha256(data).hexdigest()
        if (eligible and (original is None or digest != original['sha256']
                or bool(stat.st_mode & 0o111) != bool(original.get('executable')))
                and not media_header(relative, data[:16], len(data))):
            raise ValueError('Runtime media header does not match its extension: ' + relative
                + ' (' + str(len(data)) + ' bytes); isolated data is retained for recovery review')
        files.append({'path': relative, 'data': base64.b64encode(data).decode(), 'sha256': digest, 'executable': bool(stat.st_mode & 0o111),
            **({'rasterBaseSha256': original['sha256']} if raster_candidate else {})})
    if walk_errors:
        raise ValueError('Source inspection entry limit exceeded; isolated data is retained' if 'entry-limit' in walk_errors else 'A source directory could not be read; isolated data is retained for recovery review')
    return files


def retained_source_tree(root, baseline, media_limit=None, profile_id=None):
    """Candidate bytes are separate from verified copies; only the host may validate or publish them."""
    rasters = []
    files = source_tree(root, baseline, raster_returns=True, retained_rasters=rasters, media_limit=media_limit, profile_id=profile_id)
    return {'files': files, 'retainedRasters': rasters}


def stream_raster_source(root, manifest, output, field):
    header = json.dumps(manifest, separators=(',', ':')).encode() + b'\n'
    if len(header) > 16 * 1024 * 1024:
        raise ValueError('Retained review manifest exceeded its transfer budget')
    output.write(header)
    for item in manifest[field]:
        with artifact_reader(root, item['path']) as (stream, info):
            if (info.st_mode & 0o111 or info.st_size != item['size']
                    or not media_header(item['path'], stream.peek(16)[:16], info.st_size)
                    or transfer_media(stream, info.st_size, output) != item['sha256']):
                raise ValueError('Retained raster changed during review; no result was acknowledged')
    output.flush()


def stream_retained_source(root, manifest, output):
    stream_raster_source(root, manifest, output, 'retainedRasters')


def stream_captured_source(root, manifest, output):
    stream_raster_source(root, manifest, output, 'returnedRasters')


def inspect_source_tree(root, baseline, raster_returns=False, media_limit=None, profile_id=None):
    """Bounded diagnostics only: never return payloads or make an invalid capture look saved."""
    media_limit = MEDIA_TOTAL if media_limit is None else media_limit
    raw_total = 0
    streamed = raster_returns == 2
    result = {'complete': True, 'changes': [], 'excluded': 0, 'blockers': 0,
        'rasterInspectionVersion': 2 if streamed else 1, 'rasterReturnVersion': 2 if streamed else int(bool(raster_returns))}
    seen = set()
    approved = {(item['size'], item['sha256']) for item in baseline.values() if 'size' in item}
    entries = files = ordinary_reads = media_reads = ordinary_total = media_total = 0

    def add(relative, kind, size=None, reason=None, blocked=False):
        if len(result['changes']) >= MAX_FILES - 1:
            result['complete'] = False
            result['blockers'] += 1
            result['changes'].append({'path': 'workspace', 'kind': 'blocked',
                'reason': 'Inspection change limit reached; remaining isolated data requires review'})
            return False
        result['changes'].append({'path': relative, 'kind': kind,
            **({'size': size} if size is not None else {}), **({'reason': reason} if reason else {})})
        result['blockers'] += int(blocked or kind in ('blocked', 'deleted'))
        return True

    walk_errors = []
    for target, excluded in source_entries(root, walk_errors):
        entries += 1
        if entries > 4000:
            result['complete'] = False
            add('workspace', 'blocked', reason='Inspection entry limit reached; isolated data is retained for review')
            return result
        relative = str(target.relative_to(root))
        if excluded:
            result['excluded'] += 1
            continue
        try:
            safe_path(relative)
        except ValueError:
            if not add('workspace', 'blocked', reason='An invalid source path was retained; separate inspection is required'):
                return result
            continue
        seen.add(relative)
        try:
            info = target.lstat()
            if stat.S_ISDIR(info.st_mode):
                if relative in baseline and not add(relative, 'blocked', reason='A baseline source file became a directory; retain and review'):
                    return result
                continue
            files += 1
            if files > MAX_FILES:
                result['complete'] = False
                add('workspace', 'blocked', reason='Inspection file limit reached; isolated data is retained for review')
                return result
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                if not add(relative, 'blocked', reason='Linked or non-regular source is retained; it cannot be returned safely'):
                    return result
                continue
            original = baseline.get(relative)
            registered = original is not None and 'size' in original
            eligible = runtime_media_path(relative)
            static_raster = raster_returns and pathlib.PurePosixPath(relative).suffix.lower() in STATIC_RASTER_EXTENSIONS
            streamed_raster = streamed and static_raster and eligible
            media = registered or original is None and eligible and not info.st_mode & 0o111 or streamed_raster
            limit = media_file_limit(relative, profile_id) if media else 2 * 1024 * 1024
            if info.st_size > limit:
                if not add(relative, 'blocked', info.st_size,
                    'File exceeds the safe source inspection/return limit; preserve the isolated version for review'):
                    return result
                continue
            deferred_raster_read = (media and static_raster and 0 < info.st_size <= (MEDIA_FILE if streamed_raster else RASTER_RETURN_BYTES)
                and not info.st_mode & 0o111)
            if deferred_raster_read:
                bounded = ordinary_reads + media_reads + info.st_size <= MAX_BYTES + media_limit
            elif media:
                media_reads += info.st_size
                bounded = media_reads <= media_limit
            else:
                ordinary_reads += info.st_size
                bounded = ordinary_reads <= MAX_BYTES
            bounded = bounded and ordinary_reads + media_reads <= MAX_BYTES + media_limit
            if not bounded:
                result['complete'] = False
                if not add(relative, 'blocked', info.st_size,
                    'Inspection read limit reached; remaining isolated data requires review'):
                    return result
                continue
            with artifact_reader(root, relative) as (stream, current):
                if any(getattr(info, field) != getattr(current, field)
                        for field in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_mode')):
                    raise ValueError('Source changed before inspection')
                valid_header = media_header(relative, stream.peek(256)[:256], current.st_size, profile_id)
                digest = transfer_media(stream, current.st_size)
            unchanged = (original is not None and digest == original['sha256']
                and bool(info.st_mode & 0o111) == bool(original.get('executable')))
            copied = (registered or original is None) and eligible and not info.st_mode & 0o111 and (info.st_size, digest) in approved
            registered_candidate = (not streamed and registered and static_raster and (info.st_size, digest) not in approved
                and digest != original['sha256'] and 0 < info.st_size <= RASTER_RETURN_BYTES and not info.st_mode & 0o111)
            streamed_candidate = (streamed_raster and not unchanged
                and not ((registered or original is None) and (info.st_size, digest) in approved))
            if deferred_raster_read:
                if streamed_raster and (streamed_candidate or registered or copied):
                    media_reads += info.st_size
                    bounded = media_reads <= media_limit
                elif registered_candidate or not registered and not copied:
                    ordinary_reads += info.st_size
                    bounded = ordinary_reads <= MAX_BYTES
                else:
                    media_reads += info.st_size
                    bounded = media_reads <= media_limit
                if not bounded:
                    result['complete'] = False
                    if not add(relative, 'blocked', info.st_size,
                            'Inspection read limit reached; remaining isolated data requires review'):
                        return result
                    continue
            if not registered and unchanged:
                if raster_returns:
                    ordinary_total += info.st_size
                    if ordinary_total > MAX_BYTES and not add(relative, 'blocked', info.st_size,
                            'Ordinary source return limit exceeded; retain isolated changes for review'):
                        return result
                continue
            if (registered or eligible or static_raster) and not valid_header:
                if not add(relative, 'blocked', info.st_size,
                    'Media header does not match its extension; retain and review the isolated version'):
                    return result
                continue
            if info.st_size > MEDIA_FILE and not ((registered and unchanged or copied) and info.st_size <= media_file_limit(relative, profile_id)):
                if not add(relative, 'blocked', info.st_size, 'Large runtime media is not a verified registered copy; retain and review'):
                    return result
                continue
            if streamed_candidate:
                media_total += info.st_size
                raw_total += info.st_size
                if info.st_mode & 0o111 or not 0 < info.st_size <= MEDIA_FILE or media_total > media_limit or raw_total > MEDIA_TOTAL:
                    reason = 'Streamed raster candidate exceeds its mode or shared media limit; retain and review'
                else:
                    if not add(relative, 'added' if original is None else 'modified', info.st_size,
                            'Streamed raster candidate; complete host image review and approval are still required'):
                        return result
                    continue
            elif registered_candidate:
                ordinary_total += info.st_size
                if ordinary_total <= MAX_BYTES:
                    if not add(relative, 'modified', info.st_size, 'Raster candidate; host baseline and complete image validation are still required'):
                        return result
                    continue
                reason = 'Ordinary source return limit exceeded; retain isolated changes for review'
            elif registered or copied:
                media_total += info.st_size
                if info.st_mode & 0o111 or not 0 < info.st_size <= media_file_limit(relative, profile_id) or media_total > media_limit:
                    reason = 'Runtime media mode or size limit prevents return; retain and review'
                elif registered and not unchanged and (info.st_size, digest) not in approved:
                    reason = 'Existing runtime media was modified; preserve both versions for explicit review'
                else:
                    if unchanged:
                        continue
                    if not add(relative, 'modified' if registered else 'added', info.st_size):
                        return result
                    continue
            elif static_raster:
                ordinary_total += info.st_size
                if info.st_mode & 0o111 or not 0 < info.st_size <= (2 * 1024 * 1024 if streamed else RASTER_RETURN_BYTES):
                    reason = ('Raster candidate exceeds its ordinary source mode or size limit; retain and review' if streamed
                        else 'Raster candidate must be non-executable and at most 512 KiB; retain and review the isolated version')
                elif ordinary_total > MAX_BYTES:
                    reason = 'Ordinary source return limit exceeded; retain isolated changes for review'
                else:
                    if not add(relative, 'added' if original is None else 'modified', info.st_size,
                            'Raster candidate; host baseline and complete image validation are still required'):
                        return result
                    continue
            elif info.st_size > 2 * 1024 * 1024:
                reason = 'New large media has no verified original; preserve it for review, do not retry execution'
            else:
                ordinary_total += info.st_size
                if ordinary_total <= MAX_BYTES:
                    if not add(relative, 'added' if original is None else 'modified', info.st_size):
                        return result
                    continue
                reason = 'Ordinary source return limit exceeded; retain isolated changes for review'
            if not add(relative, 'blocked', info.st_size, reason):
                return result
        except (OSError, ValueError):
            if not add(relative, 'blocked', reason='Source changed or could not be read safely; isolated data is retained for review'):
                return result
    if walk_errors:
        result['complete'] = False
        if not add('workspace', 'blocked', reason='Inspection entry limit reached; isolated data is retained' if 'entry-limit' in walk_errors else 'A source directory could not be inspected; isolated data is retained'):
            return result
    for relative in baseline:
        if relative not in seen and not excluded_source_path(relative):
            if not add(relative, 'deleted', reason='Source deletion requires explicit review; no changes were discarded'):
                return result
    return result


def _plain_json(file, maximum=1024 * 1024):
    value = file.lstat()
    if (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_uid != os.getuid()
            or value.st_mode & 0o077 or value.st_size > maximum):
        raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Private lifecycle metadata is unavailable')
    descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'r') as stream:
        return json.load(stream)


def _relative(root, relative, create=False):
    parts = safe_path(relative).parts
    parent = root
    for part in parts[:-1]:
        parent = parent / part
        if not os.path.lexists(parent) and create:
            parent.mkdir(mode=0o700)
        if not parent.is_dir() or parent.is_symlink() or parent.resolve() != parent:
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Source parent is linked or unavailable')
    return parent / parts[-1]


def _source_identity(file, expected):
    value = file.lstat()
    if (not stat.S_ISREG(value.st_mode) or value.st_nlink not in (1, 2)
            or lifecycle.file_hash(file, (1, 2)) != expected['sha256']
            or bool(value.st_mode & 0o111) != expected['executable']):
        raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'Source changed during publication; every version was retained')


def _remove_empty(root):
    for base, directories, names in os.walk(root, topdown=False, followlinks=False):
        if names:
            raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'Unexpected transaction contents were retained')
        for name in directories:
            target = pathlib.Path(base) / name
            if target.is_symlink():
                raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'Transaction link was retained')
            target.rmdir()
    root.rmdir()


class Backend:
    def identity_readiness(self):
        file = ROOT.parent / 'identity-range-v2.json'
        if not os.path.lexists(file):
            raise lifecycle.LifecycleError('IDENTITY_PROVISIONING_REQUIRED', 'The reserved identity range requires a separate audited installation')
        value = _plain_json(file)
        if (value.get('version') != 2 or value.get('range') != list(lifecycle.IDENTITIES)
                or value.get('approved') is not True
                or value.get('auditedChecks') != ['owned-files', 'numeric-acls', 'ipc', 'accounts']
                or not isinstance(value.get('auditedFreeUids'), list)
                or not isinstance(value.get('claimedUids'), list)
                or not re.fullmatch('[a-f0-9]{64}', value.get('auditSha256', ''))):
            raise lifecycle.LifecycleError('IDENTITY_PROVISIONING_REQUIRED', 'The identity audit ledger is incomplete')
        all_uids = value['auditedFreeUids'] + value['claimedUids']
        if any(not isinstance(uid, int) or not lifecycle.IDENTITIES[0] <= uid <= lifecycle.IDENTITIES[1] for uid in all_uids):
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Invalid audited identity range')
        if (any(len(set(value[key])) != len(value[key]) for key in ('auditedFreeUids', 'claimedUids'))
                or set(all_uids) != set(range(lifecycle.IDENTITIES[0], lifecycle.IDENTITIES[1] + 1))):
            raise lifecycle.LifecycleError('IDENTITY_PROVISIONING_REQUIRED', 'Every reserved identity must be audited or permanently retained')
        return value

    def allocate_identity(self, used):
        ledger = self.identity_readiness()
        for uid in sorted(set(ledger['auditedFreeUids']) - set(ledger['claimedUids']) - used):
            name = 'omgjob' + str(uid)
            # Observing a collision consumes the reservation too; a later userdel must never make it reusable.
            ledger['claimedUids'].append(uid)
            lifecycle.atomic_json(ROOT.parent / 'identity-range-v2.json', ledger)
            try:
                pwd.getpwuid(uid)
                continue
            except KeyError:
                pass
            try:
                pwd.getpwnam(name)
                continue
            except KeyError:
                pass
            # Never reissue the number, including when account creation fails or a project is deleted.
            command(['useradd', '--system', '--uid', str(uid), '--user-group', '--no-create-home',
                     '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', name])
            account = pwd.getpwnam(name)
            if account.pw_uid != uid:
                raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Allocated identity changed')
            return {'uid': uid, 'gid': account.pw_gid, 'name': name}
        raise lifecycle.LifecycleError('CAPACITY', 'The audited stable identity budget is exhausted; no number was reused')

    def available_bytes(self, parent):
        value = os.statvfs(parent)
        return value.f_bavail * value.f_frsize

    def validate_files(self, files):
        return self.validate_profile_files(files)

    def validate_profile_files(self, files, profile_id=None):
        if not isinstance(files, list) or len(files) > MAX_FILES:
            raise ValueError('Transfer count exceeded its limit')
        seen = set()
        total = media_bytes = 0
        for item in files:
            relative = str(safe_path(item['path']))
            if relative in seen or any(part in ('node_modules', 'dist', 'build', 'out') for part in pathlib.PurePosixPath(relative).parts):
                raise ValueError('Duplicate or generated source destination')
            seen.add(relative)
            if 'size' in item:
                size = item['size']
                if (set(item) != {'path', 'size', 'sha256'} or not (getattr(self, 'media_input', None) or profile_id)
                        or not runtime_media_path(relative)
                        or type(size) is not int or not 0 < size <= media_file_limit(relative, profile_id)
                        or not isinstance(item['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', item['sha256'])):
                    raise ValueError('Invalid runtime media declaration')
                media_bytes += size
                if media_bytes > (runtime_profile(profile_id)['mediaBytes'] if profile_id else MEDIA_TOTAL):
                    raise ValueError('Runtime media exceeds the project asset budget')
                continue
            data = base64.b64decode(item['data'], validate=True)
            total += len(data)
            if len(data) > 2 * 1024 * 1024 or total > MAX_BYTES or hashlib.sha256(data).hexdigest() != item['sha256']:
                raise ValueError('Project transfer exceeded its limits')
            if 'executable' in item and not isinstance(item['executable'], bool):
                raise ValueError('Invalid source execution mode')
        return files

    def validate_packages(self, packages):
        if not isinstance(packages, list) or len(packages) > 32:
            raise ValueError('Package count exceeded its limit')
        total = sum(len(validate_package(item)) for item in packages)
        if total > MAX_BYTES:
            raise ValueError('Package transfer exceeded its limit')
        return packages

    def create(self, folder, size, identity):
        folder.mkdir(mode=0o700)
        image = folder / 'disk.img'
        with image.open('xb') as stream:
            stream.truncate(size)
            stream.flush()
            os.fsync(stream.fileno())
        image.chmod(0o600)
        command(['mkfs.ext4', '-q', '-m', '0', '-N', '8192', str(image)])
        (folder / 'root').mkdir(mode=0o755)
        lifecycle.atomic_json(folder / 'owner.json', identity)
        lifecycle.sync_directory(folder)

    def _image(self, folder):
        image = folder / 'disk.img'
        value = image.lstat()
        if (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_size != VOLUME_BYTES
                or value.st_uid != os.getuid() or value.st_mode & 0o077 or image.resolve() != image):
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'The registered image cannot be recreated or resized')
        mount = folder / 'root'
        if not mount.is_dir() or mount.is_symlink():
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Registered mountpoint is unavailable')
        return image, mount

    def _mounted_image(self, folder):
        image, mount = self._image(folder)
        return self._mount_identity(image, mount)

    def _mount_identity(self, image, mount):
        result = subprocess.run(['findmnt', '-rn', '--mountpoint', str(mount), '--output', 'SOURCE,FSTYPE,OPTIONS'],
                                check=False, capture_output=True, timeout=5)
        fields = result.stdout.decode().strip().split()
        if result.returncode or len(fields) != 3 or fields[1] != 'ext4' or not re.fullmatch('/dev/loop[0-9]+', fields[0]):
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Registered mount identity is unavailable')
        loop = pathlib.Path('/sys/block') / pathlib.Path(fields[0]).name / 'loop'
        if (loop.joinpath('backing_file').read_text().strip() != str(image)
                or int(loop.joinpath('offset').read_text()) != 0 or int(loop.joinpath('sizelimit').read_text()) != 0
                or mount.stat().st_dev != os.stat(fields[0]).st_rdev):
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Mounted storage differs from its registered image')
        options = set(fields[2].split(','))
        if 'ro' in options and int(loop.parent.joinpath('ro').read_text()) != 1:
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Read-only review requires a read-only loop device')
        return options

    def profile_paths(self, folder, record):
        if (record.get('sourceProfileId') not in RUNTIME_PROFILES or type(record.get('volumeProfileVersion')) is not int
                or record['volumeProfileVersion'] != runtime_profile(record['sourceProfileId'])['version']):
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Unknown profile image identity')
        volume_id = lifecycle.operation(record.get('volumeId'))
        if _plain_json(folder / 'owner.json') != record['identity']:
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Profile image owner changed')
        for parent in (folder, folder / 'images', folder / 'mounts'):
            info = parent.lstat()
            if not stat.S_ISDIR(info.st_mode) or parent.resolve() != parent or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Profile image directory is not private')
        image, mount = folder / 'images' / (volume_id + '.img'), folder / 'mounts' / volume_id
        info = image.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_size != RUNTIME_PROFILE['volumeBytes'] or image.resolve() != image
                or not mount.is_dir() or mount.is_symlink()):
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'The exact registered profile image changed')
        return image, mount

    def create_profile(self, folder, record):
        folder.mkdir(mode=0o700)
        for name in ('images', 'mounts'): (folder / name).mkdir(mode=0o700)
        lifecycle.atomic_json(folder / 'owner.json', record['identity'])
        image = folder / 'images' / (lifecycle.operation(record['volumeId']) + '.img')
        with image.open('xb') as stream:
            stream.truncate(RUNTIME_PROFILE['volumeBytes']); stream.flush(); os.fsync(stream.fileno())
        image.chmod(0o600)
        command(['mkfs.ext4', '-q', '-m', '0', '-N', str(RUNTIME_PROFILE['inodeCount']), str(image)])
        (folder / 'mounts' / record['volumeId']).mkdir(mode=0o755)
        lifecycle.sync_directory(image.parent); lifecycle.sync_directory(folder)
        mount = self.mount_profile(folder, record)
        (mount / 'workspace').mkdir(mode=0o700)
        os.chown(mount / 'workspace', record['identity']['uid'], record['identity']['gid'])

    def mount_profile(self, folder, record):
        image, mount = self.profile_paths(folder, record)
        if os.path.ismount(mount) and 'ro' in self._mount_identity(image, mount): self.unmount_profile(folder, record)
        if not os.path.ismount(mount):
            if any(mount.iterdir()): raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Profile mountpoint is not empty')
            command(['mount', '-o', 'loop,nodev,nosuid', str(image), str(mount)])
        self._mount_identity(image, mount)
        return mount

    def unmount_profile(self, folder, record):
        image, mount = self.profile_paths(folder, record)
        identity = None
        if os.path.ismount(mount):
            self._mount_identity(image, mount)
            identity = self._detach_identity(image)
            command(['umount', str(mount)])
        self._assert_loop_detached(image, mount, identity)
        if any(mount.iterdir()): raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Profile mountpoint remains populated')

    def _detach_identity(self, image):
        info = image.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or image.resolve() != image):
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'The owned image identity changed during unmount')
        return tuple(getattr(info, name) for name in ('st_dev', 'st_ino', 'st_size', 'st_mode', 'st_uid', 'st_gid', 'st_nlink'))

    def _assert_loop_detached(self, image, mount, owned_identity=None):
        # Only our successful umount may wait for Linux's asynchronous loop autoclear.
        # An attachment found at entry without that proof remains an immediate refusal.
        deadline = time.monotonic() + 3 if owned_identity is not None else None
        while True:
            if owned_identity is not None:
                if self._detach_identity(image) != owned_identity:
                    raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'The owned image was replaced during loop detach')
                if os.path.ismount(mount):
                    raise lifecycle.LifecycleError('ACTIVE_OPERATION', 'The owned mountpoint is still mounted after unmount')
            attached = False
            for backing in pathlib.Path('/sys/block').glob('loop*/loop/backing_file'):
                try:
                    if backing.read_text().strip() == str(image): attached = True
                except FileNotFoundError:
                    # Autoclear can remove a sysfs node between enumeration and reading.
                    continue
            if not attached:
                if owned_identity is not None and self._detach_identity(image) != owned_identity:
                    raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'The owned image changed before detach confirmation')
                return
            if deadline is None or time.monotonic() >= deadline:
                raise lifecycle.LifecycleError('ACTIVE_OPERATION', 'The project loop device has not detached; its state remains unconfirmed')
            time.sleep(0.02)

    @contextmanager
    def review_profile_workspace(self, folder, record):
        if not _REVIEW_LOCKED: raise lifecycle.LifecycleError('PROTOCOL_REQUIRED', 'Explicit profile review lease is required')
        image, mount = self.profile_paths(folder, record)
        cleanup = False
        try:
            if os.path.ismount(mount):
                cleanup = 'ro' in self._mount_identity(image, mount)
            else:
                if any(mount.iterdir()): raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Profile mountpoint is not empty')
                checked = subprocess.run(['e2fsck', '-fn', str(image)], check=False, capture_output=True, timeout=30)
                if checked.returncode: raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'Profile filesystem requires separate review')
                command(['mount', '-t', 'ext4', '-o', 'loop,ro,noload,nodev,nosuid,noexec', str(image), str(mount)])
                cleanup = True
            if cleanup and not {'ro', 'nodev', 'nosuid', 'noexec'} <= self._mount_identity(image, mount):
                raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Profile review mount options changed')
            yield mount / 'workspace'
        finally:
            if cleanup and os.path.ismount(mount): self.unmount_profile(folder, record)

    def profile_snapshot(self, workspace, baseline, profile_id=PROFILE_ID):
        return retained_source_tree(workspace, baseline, runtime_profile(profile_id)['mediaBytes'], profile_id)

    def inspect_profile_source(self, workspace, baseline, profile_id=PROFILE_ID):
        if workspace.is_symlink() or not workspace.is_dir() or workspace.resolve() != workspace:
            raise lifecycle.LifecycleError('INSPECTION_UNAVAILABLE', 'The existing profile workspace is unavailable; no mount was performed')
        return inspect_source_tree(workspace, baseline, raster_returns=2, media_limit=runtime_profile(profile_id)['mediaBytes'], profile_id=profile_id)

    @contextmanager
    def review_workspace(self, folder):
        """No disk writes, journal replay, activation, volume copy, eviction or task execution."""
        if not _REVIEW_LOCKED:
            raise lifecycle.LifecycleError('PROTOCOL_REQUIRED', 'Explicit exclusively locked review is required before opening retained storage')
        image, mount = self._image(folder)
        cleanup = False
        try:
            if os.path.ismount(mount):
                options = self._mounted_image(folder)
                cleanup = 'ro' in options
                if cleanup and not {'ro', 'nodev', 'nosuid', 'noexec'} <= options:
                    raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'An unfinished review mount has unsafe options')
            else:
                if any(mount.iterdir()):
                    raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Unmounted source directory is not empty; every version was retained')
                for backing in pathlib.Path('/sys/block').glob('loop*/loop/backing_file'):
                    if backing.read_text().strip() == str(image):
                        raise lifecycle.LifecycleError('ACTIVE_OPERATION', 'The retained image already has an unverified loop attachment')
                # ro alone can replay ext4's journal. Refuse an unclean image and use noload as well.
                checked = subprocess.run(['e2fsck', '-fn', str(image)], check=False, capture_output=True, timeout=20)
                if checked.returncode:
                    raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'The retained filesystem needs separate repair; review did not replay its journal or change any file')
                cleanup = True
                command(['mount', '-t', 'ext4', '-o', 'loop,ro,noload,nodev,nosuid,noexec', str(image), str(mount)])
                if not {'ro', 'nodev', 'nosuid', 'noexec'} <= self._mounted_image(folder):
                    raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Source review did not obtain a read-only mount')
            workspace = mount / 'workspace'
            if workspace.is_symlink() or not workspace.is_dir() or workspace.resolve() != workspace:
                raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'Retained source is missing; no workspace was created')
            yield workspace
        finally:
            if cleanup and os.path.ismount(mount):
                if 'ro' not in self._mounted_image(folder):
                    raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Review mount changed; it was retained for inspection')
                self.unmount(folder)

    def mount(self, folder):
        image, mount = self._image(folder)
        if os.path.ismount(mount) and 'ro' in self._mounted_image(folder):
            # A killed reviewer may leave its verified read-only view mounted. Only ordinary
            # admitted execution/recovery can request the normal writable mount afterward.
            self.unmount(folder)
        if not os.path.ismount(mount):
            if any(mount.iterdir()):
                raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Unmounted source directory is not empty')
            command(['mount', '-o', 'loop,nodev,nosuid', str(image), str(mount)])
        self._mounted_image(folder)
        return mount

    def assert_idle(self, record, folder):
        identity = record['identity']
        try:
            account = pwd.getpwnam(identity['name'])
            group = grp.getgrnam(identity['name'])
        except KeyError:
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'The stable project identity is unavailable')
        if (account.pw_uid, account.pw_gid, group.gr_gid) != (identity['uid'], identity['gid'], identity['gid']):
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'The stable project identity changed')
        if (folder / 'owner.json').exists() and _plain_json(folder / 'owner.json') != record['identity']:
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Volume ownership metadata changed')
        for file in pathlib.Path('/run/ohmygame-control').glob('*.json'):
            state = _plain_json(file, 65536)
            if state.get('projectId') == record['projectId']:
                active = subprocess.run(['systemctl', 'is-active', state['unit']], capture_output=True, check=False, timeout=10)
                if active.stdout.strip() in (b'active', b'activating', b'deactivating'):
                    raise lifecycle.LifecycleError('ACTIVE_OPERATION', 'The isolated service has not stopped')
        prefix = str(folder) + '/'
        for process in pathlib.Path('/proc').iterdir():
            if not process.name.isdigit():
                continue
            try:
                if process.stat().st_uid == record['identity']['uid']:
                    raise lifecycle.LifecycleError('ACTIVE_OPERATION', 'A project process is still alive')
                try:
                    targets = [os.readlink(process / 'cwd')]
                except FileNotFoundError:
                    continue
                for file in (process / 'fd').iterdir():
                    try:
                        targets.append(os.readlink(file))
                    except FileNotFoundError:
                        pass
                if any(target == str(folder) or target.startswith(prefix) for target in targets):
                    raise lifecycle.LifecycleError('ACTIVE_OPERATION', 'A process still holds the project volume')
            except (FileNotFoundError, ProcessLookupError):
                continue

    def unmount(self, folder):
        mount = folder / 'root'
        image = folder / 'disk.img'
        identity = None
        if os.path.ismount(mount):
            self._mounted_image(folder)
            identity = self._detach_identity(image)
            command(['umount', str(mount)])
        self._assert_loop_detached(image, mount, identity)
        if mount.exists() and (mount.is_symlink() or any(mount.iterdir())):
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Unmounted mountpoint is not empty')

    def snapshot(self, workspace, baseline=None):
        if workspace.is_symlink() or not workspace.is_dir():
            raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'Project source is unavailable')
        return source_tree(workspace, baseline)

    def snapshot_rasters(self, workspace, baseline):
        return source_tree(workspace, baseline, raster_returns=True)

    def review_snapshot(self, workspace, baseline):
        if workspace.is_symlink() or not workspace.is_dir() or workspace.resolve() != workspace:
            raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'Retained source workspace is unavailable')
        return retained_source_tree(workspace, baseline)

    def stream_review(self, workspace, manifest, output):
        stream_retained_source(workspace, manifest, output)

    def stream_capture(self, workspace, manifest, output):
        stream_captured_source(workspace, manifest, output)

    def inspect_source(self, workspace, baseline):
        if workspace.is_symlink() or not workspace.is_dir() or workspace.resolve() != workspace:
            raise lifecycle.LifecycleError('INSPECTION_UNAVAILABLE', 'The existing source workspace is unavailable; no volume was mounted')
        return inspect_source_tree(workspace, baseline)

    def inspect_source_rasters(self, workspace, baseline):
        return inspect_source_tree(workspace, baseline, raster_returns=True)

    def inspect_source_media(self, workspace, baseline):
        if workspace.is_symlink() or not workspace.is_dir() or workspace.resolve() != workspace:
            raise lifecycle.LifecycleError('INSPECTION_UNAVAILABLE', 'The existing source workspace is unavailable; no volume was mounted')
        return inspect_source_tree(workspace, baseline, raster_returns=2)

    def sync(self, mount, files, packages, identity, baseline, op_id):
        workspace = mount / 'workspace'
        if not workspace.exists():
            volume_write(workspace.mkdir, mode=0o700)
        if workspace.is_symlink() or not workspace.is_dir() or workspace.resolve() != workspace:
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Workspace must be a real directory')
        volume_write(os.chown, workspace, identity['uid'], identity['gid'], follow_symlinks=False)
        transaction = mount / ('sync-' + lifecycle.operation(op_id))
        volume_write(transaction.mkdir, mode=0o700)
        volume_write((transaction / 'before').mkdir, mode=0o700)
        volume_write((transaction / 'after').mkdir, mode=0o700)
        incoming = lifecycle.source_map(files)
        manifest = {'version': 1, 'operationId': op_id, 'baseline': baseline,
                    'incoming': incoming, 'phase': 'staged'}
        volume_write(lifecycle.atomic_json, transaction / 'manifest.json', manifest)
        changed = [item for item in files if baseline.get(item['path']) != incoming[item['path']]]
        needed = [item for item in changed if 'size' in item]
        if getattr(self, 'media_input', None):
            self.media_request([item['path'] for item in needed])
        for item in changed:
            target = volume_write(_relative, transaction / 'after', item['path'], True)
            # Staging only publishes complete verified files; torn uploads do not become recovery originals.
            scratch = transaction / 'upload'
            with volume_write(scratch.open, 'xb') as stream:
                if 'size' in item:
                    digest = hashlib.sha256()
                    remaining = item['size']
                    header = b''
                    while remaining:
                        block = self.media_input.read(min(512 * 1024, remaining))
                        if not block:
                            raise ValueError('Runtime media upload ended early')
                        if len(header) < 12:
                            header += block[:12 - len(header)]
                        remaining -= len(block)
                        digest.update(block)
                        volume_write(stream.write, block)
                    if not media_header(item['path'], header, item['size']) or digest.hexdigest() != item['sha256']:
                        raise ValueError('Runtime media changed during transfer')
                else:
                    volume_write(stream.write, base64.b64decode(item['data'], validate=True))
                volume_write(stream.flush)
                volume_write(os.fsync, stream.fileno())
                volume_write(os.fchmod, stream.fileno(), 0o755 if item.get('executable') else 0o644)
                volume_write(os.chown, scratch, identity['uid'], identity['gid'], follow_symlinks=False)
            volume_write(scratch.rename, target)
        self._publish_sync(mount, files, packages, identity, baseline, op_id, transaction, manifest)

    def _publish_sync(self, mount, files, packages, identity, baseline, op_id, transaction, manifest):
        workspace = mount / 'workspace'
        incoming = manifest['incoming']
        manifest['phase'] = 'publishing'
        volume_write(lifecycle.atomic_json, transaction / 'manifest.json', manifest)
        try:
            for relative in sorted(set(baseline) | set(incoming)):
                if baseline.get(relative) == incoming.get(relative):
                    continue
                target = volume_write(_relative, workspace, relative, True)
                if relative in baseline:
                    _source_identity(target, baseline[relative])
                    backup = volume_write(_relative, transaction / 'before', relative, True)
                    volume_write(target.rename, backup)
                    volume_write(lifecycle.sync_directory, target.parent)
                    volume_write(lifecycle.sync_directory, backup.parent)
                if relative in incoming:
                    staged = _relative(transaction / 'after', relative)
                    volume_write(os.link, staged, target)
                    volume_write(lifecycle.sync_directory, target.parent)
                    volume_write(staged.unlink)
            manifest['phase'] = 'committed'
            volume_write(lifecycle.atomic_json, transaction / 'manifest.json', manifest)
            package_dir = mount / 'packages'
            volume_write(package_dir.mkdir, mode=0o755, exist_ok=True)
            if package_dir.is_symlink():
                raise ValueError('Package cache must not be linked')
            for item in packages:
                data = validate_package(item)
                target = package_dir / (item['sha512'] + '.tgz')
                if target.exists():
                    if lifecycle.file_hash(target) != hashlib.sha256(data).hexdigest():
                        raise ValueError('Existing package cache changed')
                else:
                    with volume_write(target.open, 'xb') as stream:
                        volume_write(stream.write, data)
                        volume_write(stream.flush)
                        volume_write(os.fsync, stream.fileno())
                    volume_write(target.chmod, 0o444)
            cache = mount / 'cache'
            volume_write(cache.mkdir, mode=0o700, exist_ok=True)
            if cache.is_symlink() or not cache.is_dir():
                raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Cache must be a real directory')
            volume_write(os.chown, cache, identity['uid'], identity['gid'], follow_symlinks=False)
            # Only newly admitted source parents need ownership; generated subtrees remain byte-for-byte intact.
            for item in files:
                parent = _relative(workspace, item['path']).parent
                while parent != workspace.parent:
                    volume_write(os.chown, parent, identity['uid'], identity['gid'])
                    if parent == workspace:
                        break
                    parent = parent.parent
        except Exception:
            # Recovery is explicit after a failed publication; the caller retains its pending transaction record.
            raise

    def profile_free_space(self, mount):
        info = os.statvfs(mount)
        return {'bytes': info.f_bavail * info.f_frsize, 'inodes': info.f_favail, 'allocationUnit': info.f_frsize}

    def capacity_root_space(self, parent):
        info = os.statvfs(parent)
        return {'bytes': info.f_bavail * info.f_frsize, 'inodes': info.f_favail}

    def assert_capacity_lease(self):
        assert_storage_lease()

    def assert_capacity_image_unmounted(self, image):
        for file in pathlib.Path('/sys/block').glob('loop*/loop/backing_file'):
            if file.read_text().strip() == str(image):
                raise lifecycle.LifecycleError('CAPACITY_COMMIT_UNVERIFIED', 'The retained original has an unexpected live loop attachment')

    def inspect_capacity_image(self, folder, image, size):
        from guest_volume_migration import Ext4MigrationBackend
        return Ext4MigrationBackend(folder, assert_storage_lease).inspect(image, size)

    def migrate_capacity_image(self, folder, source, target, source_bytes, source_sha, lease):
        from guest_volume_migration import Ext4MigrationBackend
        lease()
        for name in ('images', 'mounts'):
            directory = folder / name
            if not directory.exists(): directory.mkdir(mode=0o700)
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode) or directory.resolve() != directory or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Native migration directories must be private and unlinked')
        receipt = Ext4MigrationBackend(folder, lease).copy_resize_verify(source, target, source_bytes,
            RUNTIME_PROFILE['volumeBytes'], source_sha, RUNTIME_PROFILE['inodeCount'])
        mount = folder / 'mounts' / target.stem
        mount.mkdir(mode=0o755)
        lifecycle.sync_directory(mount.parent); lifecycle.sync_directory(folder)
        return receipt

    def begin_windowed_sync(self, mount, files, packages, identity, baseline, op_id, manifest_id, profile_id=PROFILE_ID):
        incoming = lifecycle.source_map(files)
        changed = [item for item in files if baseline.get(item['path']) != incoming[item['path']]]
        media = [item for item in changed if 'size' in item]
        windows, group, size = [], [], 0
        for item in media:
            if group and size + item['size'] > MEDIA_TOTAL:
                windows.append({'windowIndex': len(windows), 'windowId': uuid.uuid4().hex, 'paths': group, 'bytes': size, 'phase': 'pending'})
                group, size = [], 0
            group.append(item['path']); size += item['size']
        if group: windows.append({'windowIndex': len(windows), 'windowId': uuid.uuid4().hex, 'paths': group, 'bytes': size, 'phase': 'pending'})
        package_meta = []
        expanded = package_entries = package_bytes = 0
        for item in packages:
            data = validate_package(item); package_bytes += len(data)
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
                members = archive.getmembers(); expanded += sum(member.size for member in members if member.isfile()); package_entries += len(members)
            package_meta.append({key: item[key] for key in ('name', 'version', 'sha512')})
        free = self.profile_free_space(mount)
        if type(free.get('bytes')) is not int or type(free.get('inodes')) is not int or type(free.get('allocationUnit')) is not int:
            raise lifecycle.LifecycleError('GUEST_CAPACITY_UNKNOWN', 'Fresh project free space and inodes are required')
        # Existing dependencies/cache are already charged by statvfs. Include real validated tar expansion and staging copies.
        staging = sum(item['size'] if 'size' in item else len(base64.b64decode(item['data'])) for item in changed)
        required = staging + 3 * package_bytes + expanded + (package_entries + 2 * len(changed) + 32) * free['allocationUnit']
        required_inodes = package_entries + 2 * len(changed) + len(packages) + 32
        if free['bytes'] < required or free['inodes'] < required_inodes:
            raise lifecycle.LifecycleError('GUEST_PREPARATION_CAPACITY', 'Current free bytes/inodes do not cover verified dependency expansion and source staging; arbitrary build output is not guaranteed')
        transaction = mount / ('sync-' + lifecycle.operation(op_id))
        volume_write(transaction.mkdir, mode=0o700)
        for name in ('before', 'after', 'packages'): volume_write((transaction / name).mkdir, mode=0o700)
        manifest = {'version': 2, 'sourceProfileId': runtime_profile(profile_id)['id'], 'sourceManifestId': manifest_id, 'operationId': op_id,
            'baseline': baseline, 'incoming': incoming, 'phase': 'receiving', 'windows': windows, 'packages': package_meta}
        volume_write(lifecycle.atomic_json, transaction / 'manifest.json', manifest)
        for item in changed:
            if 'size' in item: continue
            target = volume_write(_relative, transaction / 'after', item['path'], True)
            with volume_write(target.open, 'xb') as stream:
                volume_write(stream.write, base64.b64decode(item['data'], validate=True)); volume_write(stream.flush); volume_write(os.fsync, stream.fileno())
                volume_write(os.fchmod, stream.fileno(), 0o755 if item.get('executable') else 0o644)
                volume_write(os.chown, target, identity['uid'], identity['gid'])
        for item in packages:
            scratch = transaction / 'upload-package'
            with volume_write(scratch.open, 'xb') as stream:
                volume_write(stream.write, validate_package(item)); volume_write(stream.flush); volume_write(os.fsync, stream.fileno())
            volume_write(scratch.rename, transaction / 'packages' / (item['sha512'] + '.tgz'))
        return [{key: item[key] for key in ('windowIndex', 'windowId', 'paths', 'bytes')} for item in windows]

    def append_windowed_sync(self, mount, op_id, manifest_id, index, window_id, stream, need_media, identity):
        transaction, manifest = self._transaction(mount, op_id)
        if manifest.get('version') != 2 or manifest['sourceManifestId'] != manifest_id or type(index) is not int or not 0 <= index < len(manifest['windows']):
            raise lifecycle.LifecycleError('INVALID_BINDING', 'Window belongs to a different complete preparation')
        window = manifest['windows'][index]
        if window['windowId'] != window_id: raise lifecycle.LifecycleError('INVALID_BINDING', 'Preparation window identity changed')
        if window['phase'] == 'completed':
            need_media([])
            if stream.read(1): raise lifecycle.LifecycleError('WINDOW_REPLAY_MISMATCH', 'Completed window replay must contain no payload')
            return
        if window['phase'] != 'pending': raise lifecycle.LifecycleError('WINDOW_UNCERTAIN', 'An unconfirmed window cannot be automatically rewritten', True)
        if any(item['phase'] != 'completed' for item in manifest['windows'][:index]): raise lifecycle.LifecycleError('INVALID_BINDING', 'Earlier preparation windows are not complete')
        window['phase'] = 'started'; volume_write(lifecycle.atomic_json, transaction / 'manifest.json', manifest)
        need_media(window['paths'])
        for path in window['paths']:
            item = manifest['incoming'][path]
            scratch = transaction / 'upload'; target = volume_write(_relative, transaction / 'after', path, True)
            digest, header, remaining = hashlib.sha256(), b'', item['size']
            with volume_write(scratch.open, 'xb') as output:
                while remaining:
                    block = stream.read(min(512 * 1024, remaining))
                    if not block: raise ValueError('Preparation window ended early')
                    if len(header) < 256: header += block[:256 - len(header)]
                    remaining -= len(block); digest.update(block); volume_write(output.write, block)
                if digest.hexdigest() != item['sha256'] or not media_header(path, header, item['size'], manifest['sourceProfileId']): raise ValueError('Preparation window content changed')
                volume_write(output.flush); volume_write(os.fsync, output.fileno()); volume_write(os.chown, scratch, identity['uid'], identity['gid'])
            volume_write(scratch.rename, target)
        if stream.read(1): raise ValueError('Preparation window contained trailing bytes')
        window['phase'] = 'completed'; volume_write(lifecycle.atomic_json, transaction / 'manifest.json', manifest)

    def commit_windowed_sync(self, mount, op_id, manifest_id, identity):
        transaction, manifest = self._transaction(mount, op_id)
        if manifest.get('version') != 2 or manifest['sourceManifestId'] != manifest_id or manifest['phase'] != 'receiving' or any(item['phase'] != 'completed' for item in manifest['windows']):
            raise lifecycle.LifecycleError('WINDOW_UNCERTAIN', 'Every exact window must complete before source publication', True)
        if lifecycle.source_map(source_tree(mount / 'workspace', manifest['baseline'], media_limit=runtime_profile(manifest['sourceProfileId'])['mediaBytes'], profile_id=manifest['sourceProfileId'])) != manifest['baseline']:
            raise lifecycle.LifecycleError('GENERATION_CHANGED', 'The original source changed before window commit', True)
        for path, value in manifest['incoming'].items():
            if manifest['baseline'].get(path) != value: _source_identity(_relative(transaction / 'after', path), value)
        packages = []
        for item in manifest['packages']:
            with artifact_reader(transaction / 'packages', item['sha512'] + '.tgz') as (stream, info):
                if info.st_size > 4 * 1024 * 1024: raise ValueError('Staged package changed')
                data = stream.read(info.st_size + 1)
            package = {**item, 'data': base64.b64encode(data).decode()}; validate_package(package); packages.append(package)
        files = [{'path': path, **item} for path, item in manifest['incoming'].items()]
        self._publish_sync(mount, files, packages, identity, manifest['baseline'], op_id, transaction, manifest)
        return files

    def _transaction(self, mount, op_id):
        directory = mount / ('sync-' + lifecycle.operation(op_id))
        if directory.is_symlink() or not directory.is_dir():
            raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'Source transaction is missing')
        manifest = _plain_json(directory / 'manifest.json', 4 * 1024 * 1024)
        if manifest.get('version') != 2 and (directory / 'manifest.json').stat().st_size > 1024 * 1024:
            raise ValueError('Legacy transaction metadata exceeds its unchanged limit')
        if manifest.get('operationId') != op_id or manifest.get('phase') not in ('staged', 'receiving', 'publishing', 'committed') or manifest.get('version') == 2 and manifest.get('sourceProfileId') not in RUNTIME_PROFILES:
            raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'Source transaction requires review')
        return directory, manifest

    def _transaction_files(self, directory, manifest):
        actual = {p.name for p in directory.iterdir()}
        result = []
        if manifest['phase'] in ('staged', 'receiving') and 'upload' in actual:
            scratch = directory / 'upload'
            value = scratch.lstat()
            if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_size > max(MEDIA_FILE, max((min(item.get('size', 0), media_file_limit(path, manifest.get('sourceProfileId'))) for path, item in manifest.get('incoming', {}).items()), default=0)):
                raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'Unexpected staged transfer retained')
            result.append(scratch)
            actual.remove('upload')
        if manifest.get('version') == 2:
            if 'upload-package' in actual:
                scratch = directory / 'upload-package'; value = scratch.lstat()
                if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_size > 4 * 1024 * 1024: raise ValueError('Unknown package staging data')
                result.append(scratch); actual.remove('upload-package')
            package_root = directory / 'packages'
            if package_root.is_symlink() or not package_root.is_dir(): raise ValueError('Invalid staged package root')
            declared = {item['sha512'] + '.tgz': item for item in manifest['packages']}
            for file in package_root.iterdir():
                if file.name not in declared: raise ValueError('Unknown staged package')
                with artifact_reader(package_root, file.name) as (stream, info):
                    if info.st_size > 4 * 1024 * 1024: raise ValueError('Staged package exceeds its bound')
                    data = stream.read(info.st_size + 1)
                validate_package({**declared[file.name], 'data': base64.b64encode(data).decode()}); result.append(file)
            actual.remove('packages')
        if actual != {'before', 'after', 'manifest.json'}:
            raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'Unknown transaction data was retained')
        for side, expected in [('before', manifest['baseline']), ('after', manifest['incoming'])]:
            root = directory / side
            if root.is_symlink() or not root.is_dir():
                raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'Unsafe transaction directory')
            for base, dirs, names in os.walk(root, followlinks=False):
                for name in dirs:
                    if (pathlib.Path(base) / name).is_symlink():
                        raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'Unknown transaction link retained')
                for name in names:
                    file = pathlib.Path(base) / name
                    relative = str(file.relative_to(root))
                    safe_path(relative)
                    if relative not in expected:
                        raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'Unknown transaction file retained')
                    _source_identity(file, expected[relative])
                    result.append(file)
        return result

    def _discard_transaction(self, directory, manifest):
        files = self._transaction_files(directory, manifest)
        for file in files:
            file.unlink()
        _remove_empty(directory / 'before')
        _remove_empty(directory / 'after')
        if manifest.get('version') == 2: _remove_empty(directory / 'packages')
        (directory / 'manifest.json').unlink()
        directory.rmdir()
        lifecycle.sync_directory(directory.parent)

    def finalize_sync(self, mount, op_id):
        directory, manifest = self._transaction(mount, op_id)
        snapshot = source_tree(mount / 'workspace', manifest['incoming'], media_limit=runtime_profile(manifest['sourceProfileId'])['mediaBytes'], profile_id=manifest['sourceProfileId']) if manifest.get('version') == 2 else lifecycle.verified_snapshot(self, mount / 'workspace', manifest['incoming'])
        if manifest['phase'] != 'committed' or lifecycle.source_map(snapshot) != manifest['incoming']:
            raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'Committed source transaction changed')
        self._discard_transaction(directory, manifest)

    def recover_sync(self, mount, op_id):
        # A process may stop after the derived transaction copies are removed but before
        # the registry clears syncPending. The Store must verify its durable baseline.
        if not os.path.lexists(mount / ('sync-' + lifecycle.operation(op_id))):
            return {'missing': True}
        directory, manifest = self._transaction(mount, op_id)
        self._transaction_files(directory, manifest)
        if manifest['phase'] == 'committed':
            self.finalize_sync(mount, op_id)
            return {'committed': True}
        workspace = mount / 'workspace'
        actions = []
        for relative in sorted(set(manifest['baseline']) | set(manifest['incoming']), reverse=True):
            old = manifest['baseline'].get(relative)
            new = manifest['incoming'].get(relative)
            if old == new:
                continue
            target = _relative(workspace, relative, True)
            backup = _relative(directory / 'before', relative, True)
            if os.path.lexists(backup):
                _source_identity(backup, old)
                if os.path.lexists(target):
                    same_original = target.lstat().st_ino == backup.lstat().st_ino
                    _source_identity(target, old if same_original else new)
                actions.append((target, backup, old, new))
            elif old:
                _source_identity(target, old)
            elif os.path.lexists(target):
                _source_identity(target, new)
                actions.append((target, None, old, new))
        # Every remaining version is known before the first rollback mutation.
        for target, backup, old, new in actions:
            if backup:
                if os.path.lexists(target):
                    if target.lstat().st_ino == backup.lstat().st_ino:
                        backup.unlink()
                        continue
                    target.unlink()
                os.link(backup, target)
                lifecycle.sync_directory(target.parent)
                backup.unlink()
            else:
                target.unlink()
        snapshot = source_tree(workspace, manifest['baseline'], media_limit=runtime_profile(manifest['sourceProfileId'])['mediaBytes'], profile_id=manifest['sourceProfileId']) if manifest.get('version') == 2 else lifecycle.verified_snapshot(self, workspace, manifest['baseline'])
        if lifecycle.source_map(snapshot) != manifest['baseline']:
            raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'Rollback source requires review')
        self._discard_transaction(directory, manifest)
        return {'committed': False}

    def deletion_plan(self, folder):
        allowed = {'disk.img', 'owner.json', 'root'}
        actual = {p.name for p in folder.iterdir()}
        if not actual <= allowed:
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Unexpected volume contents require review')
        result = []
        for name in sorted(actual):
            file = folder / name
            value = file.lstat()
            if name == 'root':
                if not stat.S_ISDIR(value.st_mode) or any(file.iterdir()):
                    raise lifecycle.LifecycleError('ACTIVE_OPERATION', 'Volume mountpoint is not empty')
                result.append({'name': name, 'inode': value.st_ino, 'device': value.st_dev, 'type': 'directory'})
            else:
                if value.st_uid != os.getuid() or value.st_mode & 0o077 or (name == 'disk.img' and value.st_size > VOLUME_BYTES):
                    raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Unrecognised partial volume file retained')
                digest = lifecycle.file_hash(file)
                result.append({'name': name, 'inode': value.st_ino, 'device': value.st_dev,
                               'size': value.st_size, 'mtimeNs': value.st_mtime_ns, 'type': 'file', 'sha256': digest})
        return result

    def profile_deletion_plan(self, folder, record):
        image, _ = self.profile_paths(folder, record)
        declared = {image.relative_to(folder).as_posix(): RUNTIME_PROFILE['volumeBytes']}
        for item in record.get('retainedVolumes', []):
            if item['volumeId'] != 'legacy' or item['profileId'] is not None:
                raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Unknown retained volume was not deleted')
            declared['disk.img'] = VOLUME_BYTES
        result = []
        for base, directories, names in os.walk(folder, followlinks=False):
            for name in directories + names:
                path = pathlib.Path(base) / name
                relative = path.relative_to(folder).as_posix(); info = path.lstat()
                directory = stat.S_ISDIR(info.st_mode)
                allowed_dir = relative in {'root', 'images', 'mounts'} or relative == 'mounts/' + record['volumeId']
                if directory:
                    if not allowed_dir or path.is_symlink() or info.st_uid != os.getuid():
                        raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Unrecognized profile directory was retained')
                    result.append({'name': relative, 'inode': info.st_ino, 'device': info.st_dev, 'type': 'directory'})
                else:
                    if (relative != 'owner.json' and relative not in declared or not stat.S_ISREG(info.st_mode)
                            or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077
                            or relative in declared and info.st_size != declared[relative]):
                        raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Unrecognized profile data was retained')
                    result.append({'name': relative, 'inode': info.st_ino, 'device': info.st_dev, 'size': info.st_size,
                        'mtimeNs': info.st_mtime_ns, 'type': 'file', 'sha256': lifecycle.file_hash(path)})
        if len(result) > 24: raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Profile deletion plan exceeded its fixed scope')
        return result

    def delete_profile_exact(self, folder, entries):
        expected = {item['name']: item for item in entries}
        actual = {path.relative_to(folder).as_posix() for path in folder.rglob('*')}
        if actual != set(expected): raise lifecycle.LifecycleError('STORAGE_CHANGED', 'Profile deletion contents changed')
        for name, item in expected.items():
            path = folder / name; info = path.lstat()
            if (info.st_dev, info.st_ino) != (item['device'], item['inode']):
                raise lifecycle.LifecycleError('STORAGE_CHANGED', 'Profile deletion identity changed')
            if item['type'] == 'file' and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or info.st_size != item['size'] or info.st_mtime_ns != item['mtimeNs'] or lifecycle.file_hash(path) != item['sha256']):
                raise lifecycle.LifecycleError('STORAGE_CHANGED', 'Profile deletion file changed')
        for item in entries:
            if item['type'] == 'file': (folder / item['name']).unlink()
        for name in sorted((item['name'] for item in entries if item['type'] == 'directory'), key=lambda name: name.count('/'), reverse=True):
            (folder / name).rmdir()
        folder.rmdir(); lifecycle.sync_directory(folder.parent)

    def delete_exact(self, folder, entries):
        expected = {entry['name']: entry for entry in entries}
        if set(p.name for p in folder.iterdir()) - set(expected):
            raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'New volume data was retained')
        for name, item in expected.items():
            file = folder / name
            if not os.path.lexists(file):
                continue
            value = file.lstat()
            if value.st_ino != item['inode'] or value.st_dev != item['device']:
                raise lifecycle.LifecycleError('STORAGE_CHANGED', 'Deletion target changed')
            if item['type'] == 'file' and (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1
                    or value.st_size != item['size'] or value.st_mtime_ns != item['mtimeNs']
                    or lifecycle.file_hash(file) != item['sha256']):
                raise lifecycle.LifecycleError('STORAGE_CHANGED', 'Deletion file changed')
        for item in [item for item in entries if item['type'] == 'file']:
            file = folder / item['name']
            if file.exists():
                value = file.lstat()
                descriptor = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    current = os.stat(item['name'], dir_fd=descriptor, follow_symlinks=False)
                    if (current.st_ino, current.st_dev, current.st_mtime_ns) != (item['inode'], item['device'], item['mtimeNs']):
                        raise lifecycle.LifecycleError('STORAGE_CHANGED', 'Final deletion identity changed')
                    os.unlink(item['name'], dir_fd=descriptor)
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        if os.path.lexists(folder / 'root'):
            (folder / 'root').rmdir()
        folder.rmdir()
        lifecycle.sync_directory(folder.parent)


def _store():
    return lifecycle.Store(ROOT, Backend())


def health():
    return {**_store().health(), 'runtimeMediaVersion': 1, 'buildMediaVersion': 1, 'sourceInspectionVersion': 1, 'rasterReturnVersion': 1, 'rasterInspectionVersion': 2, 'captureVersion': 2, 'sourceManifestVersion': 1, 'manifestCaptureVersion': 3, 'legacyReviewVersion': 1, 'retainedReviewVersion': 2, 'capacityProfileVersion': 3, 'profileManifestVersion': 2, 'profileCaptureVersion': 4, 'profileUploadVersion': 1, 'volumeMigrationVersion': 1, 'capacityProfiles': [dict(profile) for profile in RUNTIME_PROFILES.values()]}

def overview():
    try:
        return _store().overview()
    except lifecycle.LifecycleError:
        raise
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Storage overview requires inspection') from None


def prepare(spec, media_input=None, media_request=None):
    store = _store()
    store.backend.media_input = media_input
    store.backend.media_request = media_request
    return store.prepare(spec)


def prepare_begin(spec):
    return _store().prepare_begin(spec)


def prepare_append(spec, stream, need_media):
    return _store().prepare_append(spec, stream, need_media)


def prepare_commit(spec):
    return _store().prepare_commit(spec)


def plan_capacity(spec):
    return _store().plan_capacity(spec)


def inspect_capacity_plan(spec):
    return _store().inspect_capacity_plan(spec)


def register_capacity_authorization(spec):
    return _store().register_capacity_authorization(spec)


def migrate_capacity(spec):
    return _store().migrate_capacity(spec)


def claim(spec):
    return _store().claim(spec)


def validate_binding(spec, phases=('running',)):
    return _store().validate_binding(spec, phases)


def finish(spec, succeeded):
    return _store().finish(spec, succeeded)


def capture(spec):
    return _store().capture(spec)


def capture_media(spec, output):
    return _store().capture_media(spec, output)


def media_capture_request(spec):
    return lifecycle.media_capture_request(spec)


def acknowledge(spec):
    return _store().acknowledge(spec)


def release(spec):
    return _store().release(spec)


def lookup(spec):
    return _store().lookup(spec)


def cancel(spec):
    return _store().cancel(spec)


def recover(spec):
    return _store().recover(spec)


def retire(spec):
    return _store().retire(spec)


def inventory(namespace):
    return _store().inventory(namespace)

def inspect_source(spec):
    return _store().inspect_source(spec)

def review_source(spec):
    return _store().review_source(spec)


def review_source_media(spec, output):
    return _store().review_source_media(spec, output)


def retained_review_request(spec):
    return lifecycle.retained_review_request(spec)


def export_bound(spec, directory='', output_stream=None):
    context = _store().validate_binding(spec, ('finished',))
    media = context['runtimeMedia'] if output_stream is not None or spec.get('runtimeMediaVersion') == 1 else None
    return export_tree(pathlib.Path(context['workspace']), directory, media, output_stream, runtime_profile(context['sourceProfileId'])['mediaBytes'] if context.get('sourceProfileId') in RUNTIME_PROFILES else None, context.get('sourceProfileId'))
