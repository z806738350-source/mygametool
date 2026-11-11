"""Pure archive validation tests: no VM, mounts, processes or network."""
import base64
import errno
import hashlib
import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest
import os
import types
import zlib
from contextlib import contextmanager
from unittest import mock

spec = importlib.util.spec_from_file_location('guest_storage', pathlib.Path(__file__).with_name('guest_storage.py'))
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)

def package(name='fixture', scripts=None, member=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        data = json.dumps({'name': name, 'version': '1.0.0', 'scripts': scripts or {}}).encode()
        manifest = tarfile.TarInfo('package/package.json')
        manifest.size = len(data)
        archive.addfile(manifest, io.BytesIO(data))
        if member:
            archive.addfile(member)
    data = output.getvalue()
    return {'name': 'fixture', 'version': '1.0.0', 'sha512': hashlib.sha512(data).hexdigest(), 'data': base64.b64encode(data).decode()}

def media_bytes(extension, size):
    headers = {'.png': b'\x89PNG\r\n\x1a\n', '.jpg': b'\xff\xd8\xff', '.jpeg': b'\xff\xd8\xff',
        '.webp': b'RIFF....WEBP', '.gif': b'GIF89a', '.avif': b'....ftypavif', '.mp4': b'\x00\x00\x00\x10ftypisom\x00\x00\x00\x00',
        '.mov': b'....moov....', '.webm': b'\x1a\x45\xdf\xa3', '.m4a': b'....ftypM4A ', '.mp3': b'ID3',
        '.wav': b'RIFF....WAVE', '.ogg': b'OggS', '.glb': b'glTF\x02\x00\x00\x00'}
    if extension is None:
        return set(headers)
    data = headers[extension] + bytes(size - len(headers[extension]))
    return data[:8] + size.to_bytes(4, 'little') + data[12:] if extension == '.glb' else data


class PartialVolumeWriter:
    """A real temporary scratch file receives a prefix before the synthetic kernel failure."""
    def __init__(self, stream, fault):
        self.stream, self.fault = stream, fault
    def __enter__(self): return self
    def __exit__(self, *args): return self.stream.__exit__(*args)
    def __getattr__(self, name): return getattr(self.stream, name)
    def write(self, data):
        self.stream.write(data[:3]); self.stream.flush()
        raise OSError(self.fault, 'Synthetic bounded project-volume write failure')


def actual_sync_fixture(root):
    """Real storage/sync walker, with only VM, identity, capacity and process effects replaced."""
    from test_lifecycle import FakeBackend
    class SyncBackend(FakeBackend):
        validate_files = storage.Backend.validate_files
        validate_profile_files = storage.Backend.validate_profile_files
        snapshot = storage.Backend.snapshot
        snapshot_rasters = storage.Backend.snapshot_rasters
        review_snapshot = storage.Backend.review_snapshot
        sync = storage.Backend.sync
        _publish_sync = storage.Backend._publish_sync
    backend = SyncBackend()
    make = lambda: storage.lifecycle.Store(root, backend, volume_bytes=4096, total_bytes=65536, reserve_bytes=0)
    incoming = lambda data: {'path': 'main.js', 'data': base64.b64encode(data).decode(), 'sha256': hashlib.sha256(data).hexdigest(), 'executable': False}
    initial = {'namespace': 'manual', 'projectId': '5e849fb8-9236-4f0e-a58a-76cb223b8a74', 'operationId': '1' * 32,
        'mode': 'build', 'files': [incoming(b'baseline')], 'packages': [], 'rasterReturnVersion': 2, 'sourceManifestVersion': 1}
    initial['sourceManifest'] = storage.lifecycle.snapshot_source_manifest(initial['files'])
    binding = make().prepare(initial); make().claim({**binding, 'mode': 'build'}); make().finish(binding, True); make().release(binding)
    request = {**initial, 'operationId': '2' * 32, 'files': [incoming(b'new source bytes')]}
    request['sourceManifest'] = storage.lifecycle.snapshot_source_manifest(request['files'])
    return make, backend, binding, request

class ArchiveValidation(unittest.TestCase):
    def test_preserves_nested_modules_only_for_package_roots_in_current_sources(self):
        with tempfile.TemporaryDirectory(prefix='ohmygame-nested-storage-') as directory:
            root = pathlib.Path(directory).resolve()
            previous, incoming = root / 'previous', root / 'incoming'
            for target in [previous / 'games/demo/node_modules', previous / 'deleted/node_modules', incoming / 'games/demo']:
                target.mkdir(parents=True)
            (previous / 'games/demo/node_modules/fixture.js').write_text('retained dependency')
            (incoming / 'games/demo/package.json').write_text('{}')
            storage.preserve_modules(previous, incoming)
            self.assertEqual((incoming / 'games/demo/node_modules/fixture.js').read_text(), 'retained dependency')
            self.assertFalse((previous / 'games/demo/node_modules').exists())
            self.assertFalse((incoming / 'deleted/node_modules').exists())
            self.assertFalse((incoming / 'package.json').exists())

    def test_rejects_linked_package_roots_and_over_budget_before_moving_modules(self):
        with tempfile.TemporaryDirectory(prefix='ohmygame-nested-storage-') as directory:
            root = pathlib.Path(directory).resolve()
            previous, incoming = root / 'previous', root / 'incoming'
            (root / 'outside/node_modules').mkdir(parents=True)
            previous.mkdir()
            (previous / 'game').symlink_to(root / 'outside', target_is_directory=True)
            (incoming / 'game').mkdir(parents=True)
            (incoming / 'game/package.json').write_text('{}')
            with self.assertRaises(ValueError):
                storage.preserve_modules(previous, incoming)
            (previous / 'game').unlink()
            for index in range(9):
                (previous / str(index) / 'node_modules').mkdir(parents=True)
                (incoming / str(index)).mkdir(parents=True)
                (incoming / str(index) / 'package.json').write_text('{}')
            with self.assertRaises(ValueError):
                storage.preserve_modules(previous, incoming)
            self.assertTrue((previous / '0/node_modules').is_dir())

    def test_exports_selected_nested_output_and_excludes_generated_trees_from_shell_source(self):
        with tempfile.TemporaryDirectory(prefix='ohmygame-nested-storage-') as directory:
            root = pathlib.Path(directory).resolve()
            for target in ['games/demo/dist', 'games/demo/node_modules', 'games/demo/build', 'games/demo/out']:
                (root / target).mkdir(parents=True)
                (root / target / 'fixture.js').write_text('generated')
            (root / 'games/demo/dist/index.html').write_text('nested game')
            (root / 'games/demo/package.json').write_text('{}')
            (root / 'readme.txt').write_text('project source')
            with mock.patch.object(storage, 'idle'), mock.patch.object(storage, 'workspace', return_value=root):
                output = storage.export('5e849fb8-9236-4f0e-a58a-76cb223b8a74', 'games/demo')
                self.assertIn('dist/index.html', [value['path'] for value in output['files']])
                self.assertFalse(any(value['path'].startswith('games/') for value in output['files']))
                source = storage.source('5e849fb8-9236-4f0e-a58a-76cb223b8a74')
                self.assertEqual(sorted(value['path'] for value in source['files']), ['games/demo/package.json', 'readme.txt'])
                with self.assertRaises(ValueError):
                    storage.export('5e849fb8-9236-4f0e-a58a-76cb223b8a74', '../outside')
                (root / 'alias').symlink_to(root / 'games/demo', target_is_directory=True)
                with self.assertRaises(ValueError):
                    storage.export('5e849fb8-9236-4f0e-a58a-76cb223b8a74', 'alias')

    def test_valid_archive(self):
        self.assertTrue(storage.validate_package(package()))

    def test_install_scripts_and_identity(self):
        for value in [package(name='wrong'), package(scripts={'install': 'unsafe'}), package(scripts={'postinstall': 'unsafe'})]:
            with self.subTest(value=value['sha512']), self.assertRaises(ValueError):
                storage.validate_package(value)

    def test_links_and_parent_paths(self):
        for kind, name in [(tarfile.SYMTYPE, 'package/link'), (tarfile.LNKTYPE, 'package/link'), (tarfile.REGTYPE, 'package/../escape')]:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.linkname = '/etc/passwd'
            with self.subTest(kind=kind, name=name), self.assertRaises(ValueError):
                storage.validate_package(package(member=member))


class LoopDetachContracts(unittest.TestCase):
    """Kernel observations and umount are mocked; images are owned temporary ordinary files."""
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='ohmygame-loop-detach-contract-');self.addCleanup(self.temp.cleanup)
        self.folder=pathlib.Path(self.temp.name).resolve();self.image=self.folder/'disk.img';self.image.write_bytes(b'original synthetic image');self.image.chmod(0o600)
        self.mount=self.folder/'root';self.mount.mkdir();self.backend=storage.Backend();self.mounted=True
    def invoke(self,surface):
        return self.backend.unmount(self.folder) if surface=='legacy' else self.backend.unmount_profile(self.folder,{})
    @contextmanager
    def observations(self,entry,command_error=None):
        def command(args):
            self.assertEqual(args,['umount',str(self.mount)])
            if command_error:raise command_error
            self.mounted=False
        with mock.patch.object(storage.os.path,'ismount',side_effect=lambda _:self.mounted),mock.patch.object(self.backend,'_mounted_image',return_value={'rw','nodev','nosuid'}),mock.patch.object(self.backend,'_mount_identity',return_value={'rw','nodev','nosuid'}),mock.patch.object(self.backend,'profile_paths',return_value=(self.image,self.mount)),mock.patch.object(storage,'command',side_effect=command) as commands,mock.patch.object(pathlib.Path,'glob',return_value=[entry]) as scan,mock.patch.object(storage.time,'sleep') as sleep:
            yield commands,scan,sleep
    def test_successful_owned_umount_waits_for_transient_autoclear_on_both_surfaces(self):
        for surface in ('legacy','profile'):
            with self.subTest(surface=surface):
                self.mounted=True;entry=mock.Mock();entry.read_text.side_effect=[str(self.image),'']
                before=self.image.read_bytes(),self.image.stat().st_ino
                with self.observations(entry) as (commands,scan,sleep):self.invoke(surface)
                self.assertEqual(commands.call_count,1);self.assertEqual(scan.call_count,2);sleep.assert_called_once_with(0.02)
                self.assertEqual((self.image.read_bytes(),self.image.stat().st_ino),before)
    def test_existing_unmounted_attachment_is_refused_immediately_without_wait_or_mutation(self):
        for surface in ('legacy','profile'):
            with self.subTest(surface=surface):
                self.mounted=False;entry=mock.Mock();entry.read_text.return_value=str(self.image)
                with self.observations(entry) as (commands,scan,sleep):
                    with self.assertRaises(storage.lifecycle.LifecycleError) as raised:self.invoke(surface)
                self.assertEqual(raised.exception.code,'ACTIVE_OPERATION');commands.assert_not_called();sleep.assert_not_called();self.assertEqual(scan.call_count,1)
    def test_detach_timeout_keeps_unknown_and_never_repeats_or_forces_umount(self):
        for surface in ('legacy','profile'):
            with self.subTest(surface=surface):
                self.mounted=True;entry=mock.Mock();entry.read_text.return_value=str(self.image)
                with self.observations(entry) as (commands,scan,sleep),mock.patch.object(storage.time,'monotonic',side_effect=[0,0.02,3.01]):
                    with self.assertRaises(storage.lifecycle.LifecycleError) as raised:self.invoke(surface)
                self.assertEqual(raised.exception.code,'ACTIVE_OPERATION');self.assertEqual(commands.call_count,1);self.assertEqual(scan.call_count,2);sleep.assert_called_once_with(0.02)
                self.assertEqual(self.image.read_bytes(),b'original synthetic image')
    def test_failed_umount_never_enters_detach_wait_or_retries(self):
        for surface in ('legacy','profile'):
            with self.subTest(surface=surface):
                self.mounted=True;entry=mock.Mock()
                with self.observations(entry,RuntimeError('synthetic umount failure')) as (commands,scan,sleep):
                    with self.assertRaisesRegex(RuntimeError,'synthetic'):self.invoke(surface)
                self.assertEqual(commands.call_count,1);scan.assert_not_called();sleep.assert_not_called();self.assertTrue(self.mounted)
    def test_disappearing_sysfs_node_is_detached_but_other_read_errors_remain_errors(self):
        for surface in ('legacy','profile'):
            for fault in (FileNotFoundError('autocleared'),PermissionError('unknown observation')):
                with self.subTest(surface=surface,fault=type(fault).__name__):
                    self.mounted=True;entry=mock.Mock();entry.read_text.side_effect=fault
                    with self.observations(entry) as (commands,scan,sleep):
                        if isinstance(fault,PermissionError):
                            with self.assertRaises(PermissionError):self.invoke(surface)
                        else:self.invoke(surface)
                    self.assertEqual(commands.call_count,1);sleep.assert_not_called()
    def test_image_replacement_during_wait_is_rejected_without_touching_either_image(self):
        for surface in ('legacy','profile'):
            with self.subTest(surface=surface):
                self.mounted=True;entry=mock.Mock();entry.read_text.return_value=str(self.image);original=self.folder/('original-'+surface+'.img')
                def replace(_):
                    self.image.rename(original);self.image.write_bytes(b'replacement synthetic image');self.image.chmod(0o600)
                with self.observations(entry) as (commands,scan,sleep):
                    sleep.side_effect=replace
                    with self.assertRaises(storage.lifecycle.LifecycleError) as raised:self.invoke(surface)
                self.assertEqual(raised.exception.code,'UNSAFE_STORAGE');self.assertEqual(commands.call_count,1);self.assertEqual(scan.call_count,1)
                self.assertEqual(original.read_bytes(),b'original synthetic image');self.assertEqual(self.image.read_bytes(),b'replacement synthetic image')
                self.image.unlink();original.rename(self.image)


class DormantSourceReview(unittest.TestCase):
    """Root-only mount commands are mocked; never mounts or runs a project."""
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='ohmygame-dormant-review-')
        self.addCleanup(self.temporary.cleanup)
        self.folder = pathlib.Path(self.temporary.name).resolve()
        self.image = self.folder / 'disk.img'
        with self.image.open('xb') as stream:
            stream.truncate(storage.VOLUME_BYTES)
        self.image.chmod(0o600)
        self.mount = self.folder / 'root'; self.mount.mkdir()
        self.backend = storage.Backend()
        self.mounted = False
        self.commands = []
        self.options = {'ro', 'nodev', 'nosuid', 'noexec'}
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(storage, '_REVIEW_LOCKED', True).start()
        mock.patch.object(storage.os.path, 'ismount', side_effect=lambda _p: self.mounted).start()
        mock.patch.object(self.backend, '_mounted_image', side_effect=lambda _p: self.options).start()
        mock.patch.object(storage.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)).start()
        mock.patch.object(storage, 'command', side_effect=self.command).start()
        mock.patch.object(self.backend, 'unmount', side_effect=self.unmount).start()

    def command(self, args):
        self.commands.append(args)
        if args[0] == 'mount':
            self.mounted = True
            (self.mount / 'workspace').mkdir(exist_ok=True)

    def unmount(self, _folder):
        self.mounted = False
        workspace = self.mount / 'workspace'
        if workspace.is_symlink(): workspace.unlink()
        elif workspace.exists(): workspace.rmdir()

    def test_unmounted_review_uses_no_replay_read_only_mount_and_always_releases_it(self):
        before = self.image.stat()
        with self.backend.review_workspace(self.folder) as workspace:
            self.assertEqual(workspace, self.mount / 'workspace')
            self.assertTrue(self.mounted)
        self.assertFalse(self.mounted)
        self.assertEqual(self.commands, [['mount', '-t', 'ext4', '-o', 'loop,ro,noload,nodev,nosuid,noexec', str(self.image), str(self.mount)]])
        storage.subprocess.run.assert_called_once_with(['e2fsck', '-fn', str(self.image)], check=False, capture_output=True, timeout=20)
        after = self.image.stat()
        self.assertEqual((before.st_ino, before.st_mtime_ns, before.st_size), (after.st_ino, after.st_mtime_ns, after.st_size))

    def test_existing_writable_mount_is_only_read_and_not_unmounted(self):
        self.mounted = True; self.options = {'rw'}; (self.mount / 'workspace').mkdir()
        with self.backend.review_workspace(self.folder): pass
        self.assertTrue(self.mounted)
        self.assertEqual(self.commands, [])
        storage.subprocess.run.assert_not_called()

    def test_reopened_read_only_mount_is_cleaned_after_failure_or_abandoned_reviewer(self):
        self.mounted = True; (self.mount / 'workspace').mkdir()
        with self.assertRaisesRegex(ValueError, 'snapshot failed'):
            with self.backend.review_workspace(self.folder): raise ValueError('snapshot failed')
        self.assertFalse(self.mounted)
        storage.subprocess.run.assert_not_called()
        with self.backend.review_workspace(self.folder): pass
        self.assertFalse(self.mounted)

    def test_unclean_filesystem_is_not_mounted_repaired_or_acknowledged(self):
        storage.subprocess.run.return_value.returncode = 4
        with self.assertRaisesRegex(storage.lifecycle.LifecycleError, 'separate repair'):
            with self.backend.review_workspace(self.folder): pass
        self.assertEqual(self.commands, [])
        self.assertFalse(self.mounted)

    def test_unknown_unmounted_contents_and_failed_mount_leave_originals_intact(self):
        original = self.mount / 'unknown.txt'; original.write_text('preserve')
        with self.assertRaisesRegex(storage.lifecycle.LifecycleError, 'not empty'):
            with self.backend.review_workspace(self.folder): pass
        self.assertEqual(original.read_text(), 'preserve'); original.unlink()
        with mock.patch.object(storage, 'command', side_effect=OSError(28, 'No space left')):
            with self.assertRaises(OSError):
                with self.backend.review_workspace(self.folder): pass
        self.assertTrue(self.image.is_file())
        self.assertFalse(self.mounted)

    def test_review_lock_refuses_contention_links_and_missing_lock_without_initialization(self):
        lock = self.folder / 'lock'; lock.touch(mode=0o600)
        with mock.patch.object(storage, 'LOCK', lock):
            with storage.read_locked():
                with self.assertRaises(storage.lifecycle.LifecycleError):
                    with storage.review_locked(): pass
            with storage.review_locked():
                with self.assertRaises(storage.lifecycle.LifecycleError):
                    with storage.read_locked(): pass
            lock.unlink()
            with self.assertRaises(storage.lifecycle.LifecycleError):
                with storage.review_locked(): pass
            self.assertFalse(lock.exists())
            lock.symlink_to(self.image)
            with self.assertRaises(storage.lifecycle.LifecycleError):
                with storage.review_locked(): pass

    def test_only_explicit_retained_review_initializes_a_private_empty_cold_lock(self):
        lock = self.folder / 'cold.lock'
        with mock.patch.object(storage, 'LOCK', lock), mock.patch.object(storage, '_REVIEW_LOCKED', False):
            with self.assertRaises(storage.lifecycle.LifecycleError):
                with storage.read_locked(): pass
            self.assertFalse(lock.exists())
            with storage.review_locked(initialize=True):
                self.assertTrue(storage._REVIEW_LOCKED)
                self.assertEqual(lock.read_bytes(), b'')
                self.assertEqual(lock.stat().st_mode & 0o777, 0o600)
                with self.assertRaises(storage.lifecycle.LifecycleError):
                    with storage.review_locked(initialize=True): pass
            self.assertFalse(storage._REVIEW_LOCKED)
            with storage.read_locked(): pass
            lock.unlink(); lock.symlink_to(self.image)
            with self.assertRaises(storage.lifecycle.LifecycleError):
                with storage.review_locked(initialize=True): pass
        unsafe = self.folder / 'unsafe'; unsafe.mkdir(); unsafe.chmod(0o777)
        with mock.patch.object(storage, 'LOCK', unsafe / 'lock'), self.assertRaises(storage.lifecycle.LifecycleError):
            with storage.review_locked(initialize=True): pass
        self.assertFalse((unsafe / 'lock').exists())

    def test_old_shared_lock_controller_cannot_open_or_mount_a_review(self):
        with mock.patch.object(storage, '_REVIEW_LOCKED', False):
            with self.assertRaisesRegex(storage.lifecycle.LifecycleError, 'exclusively locked'):
                with self.backend.review_workspace(self.folder): pass
        self.assertEqual(self.commands, [])

    def test_missing_workspace_and_unmount_failure_are_retained_and_can_be_reinspected(self):
        with mock.patch.object(storage, 'command', side_effect=lambda _args: setattr(self, 'mounted', True)):
            with self.assertRaisesRegex(storage.lifecycle.LifecycleError, 'source is missing'):
                with self.backend.review_workspace(self.folder): pass
        self.assertFalse(self.mounted)
        with mock.patch.object(self.backend, 'unmount', side_effect=OSError('injected busy unmount')):
            with self.assertRaises(OSError):
                with self.backend.review_workspace(self.folder): pass
        self.assertTrue(self.mounted)
        with self.backend.review_workspace(self.folder): pass
        self.assertFalse(self.mounted)


class SourcePublication(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='ohmygame-source-transaction-')
        self.mount = pathlib.Path(self.temporary.name).resolve()
        self.workspace = self.mount / 'workspace'
        self.workspace.mkdir(mode=0o700)
        self.backend = storage.Backend()
        self.identity = {'uid': os.getuid(), 'gid': os.getgid(), 'name': 'fixture'}
        self.operation = 'a' * 32
        self.chown = mock.patch.object(storage.os, 'chown')
        self.chown.start()
        self.addCleanup(self.chown.stop)
        self.addCleanup(self.temporary.cleanup)

    def write(self, path, data):
        target = self.workspace / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return target

    def incoming(self, path, data, executable=False):
        return {'path': path, 'sha256': hashlib.sha256(data).hexdigest(),
                'data': base64.b64encode(data).decode(), 'executable': executable}

    def baseline(self):
        return storage.lifecycle.source_map(storage.source_tree(self.workspace))

    def test_registered_mount_identity_refuses_nonloop_sources_and_foreign_images(self):
        folder = self.mount / 'volume'; folder.mkdir()
        (folder / 'root').mkdir()
        with (folder / 'disk.img').open('xb') as stream: stream.truncate(storage.VOLUME_BYTES)
        (folder / 'disk.img').chmod(0o600)
        for output in (b'/dev/sda ext4 rw\n', b'/dev/loop999 ext4 rw\n'):
            with self.subTest(output=output), mock.patch.object(storage.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0, stdout=output)), \
                    mock.patch.object(pathlib.Path, 'read_text', return_value='/different/registered/image'):
                with self.assertRaises(storage.lifecycle.LifecycleError):
                    self.backend._mounted_image(folder)

    def test_every_runtime_media_format_supports_imported_small_and_large_copies(self):
        self.assertEqual(media_bytes(None, 0), storage.MEDIA_EXTENSIONS)
        for extension in sorted(storage.MEDIA_EXTENSIONS):
            for size in (32, 3 * 1024 * 1024):
                with self.subTest(extension=extension, size=size), tempfile.TemporaryDirectory(dir=self.mount) as directory:
                    root = pathlib.Path(directory)
                    original, copied = 'assets/files/folder/key' + extension, 'src/media/token' + extension
                    data = media_bytes(extension, size)
                    for relative in (original, copied):
                        target = root / relative
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(data)
                    baseline = {original: {'size': size, 'sha256': hashlib.sha256(data).hexdigest()}}
                    for raster_returns in (False, True):
                        captured = storage.source_tree(root, baseline, raster_returns=raster_returns)
                        self.assertEqual({file['path'] for file in captured}, {original, copied})
                        self.assertTrue(all('size' in file and 'data' not in file for file in captured))
                        inspection = storage.inspect_source_tree(root, baseline, raster_returns=raster_returns)
                        self.assertEqual(inspection, {'complete': True, 'changes': [{'path': copied, 'kind': 'added', 'size': size}],
                            'excluded': 0, 'blockers': 0, 'rasterInspectionVersion': 1, 'rasterReturnVersion': int(raster_returns)})

    def test_ordinary_baseline_paths_are_never_reclassified_by_another_media_file(self):
        data = media_bytes('.png', 32)
        self.write('public/a.png', data)
        executable = self.write('src/run.mp3', b'x' * len(data))
        executable.chmod(0o755)
        self.write('public/ordinary.png', data)
        baseline = {'public/a.png': {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()},
            'src/run.mp3': {'sha256': hashlib.sha256(executable.read_bytes()).hexdigest(), 'executable': True},
            'public/ordinary.png': {'sha256': hashlib.sha256(data).hexdigest(), 'executable': False}}
        files = {file['path']: file for file in storage.source_tree(self.workspace, baseline)}
        self.assertIn('data', files['src/run.mp3'])
        self.assertIn('data', files['public/ordinary.png'])
        self.assertEqual(storage.inspect_source_tree(self.workspace, baseline)['changes'], [])

    def test_shared_signature_and_path_cases_match_the_host(self):
        cases = json.loads(pathlib.Path(__file__).resolve().parents[2].joinpath('test/fixtures/isolated-media.json').read_text())
        for case in cases:
            extension, header = case['extension'], bytes.fromhex(case['header'])
            data = header + bytes(64 - len(header))
            relative = 'assets/files/Folder/KEY' + extension.upper()
            with self.subTest(extension=extension):
                self.assertTrue(storage.runtime_media_path(relative))
                self.assertEqual(str(storage.safe_path(relative)), relative)
                self.assertFalse(storage.runtime_media_path('arbitrary/clip' + extension))
                self.assertTrue(storage.media_header(relative, data, len(data)))
                self.assertFalse(storage.media_header(relative, b'A' * 64, 64))
                with self.assertRaises(ValueError):
                    storage.safe_path('public/credentials.json' + extension)
        self.assertEqual(str(storage.safe_path('public/角色-😀.png')), 'public/角色-😀.png')
        for name in ['public/\ud800.png', 'public/' + '😀' * 500 + '.png']:
            with self.subTest(name=repr(name)), self.assertRaises(ValueError):
                storage.safe_path(name)

    def test_inspection_permits_only_replacements_with_another_verified_baseline_asset(self):
        old, new = media_bytes('.wav', 64), media_bytes('.wav', 64) + b'new'
        self.write('assets/files/new.wav', new)
        self.write('public/current.wav', old)
        baseline = {name: {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
            for name, data in [('assets/files/new.wav', new), ('public/current.wav', old)]}
        self.write('public/current.wav', new)
        inspection = storage.inspect_source_tree(self.workspace, baseline)
        self.assertEqual(inspection['blockers'], 0)
        self.assertEqual(inspection['changes'], [{'path': 'public/current.wav', 'kind': 'modified', 'size': len(new)}])
        self.assertEqual(storage.lifecycle.source_map(storage.source_tree(self.workspace, baseline))['public/current.wav']['sha256'], hashlib.sha256(new).hexdigest())
        self.write('public/current.wav', new + b'unknown')
        self.assertEqual(storage.inspect_source_tree(self.workspace, baseline)['blockers'], 1)

    def test_new_raster_policy_proposes_small_registered_derivatives_but_preserves_legacy_review(self):
        for extension in ('.png', '.jpg', '.jpeg', '.webp'):
            name = 'public/forest' + extension
            old = media_bytes(extension, 3 * 1024 * 1024)
            new = media_bytes(extension, 1024)
            self.write(name, new)
            baseline = {name: {'size': len(old), 'sha256': hashlib.sha256(old).hexdigest()}}
            legacy = next(f for f in storage.source_tree(self.workspace, baseline) if f['path'] == name)
            self.assertNotIn('data', legacy)
            self.assertGreater(storage.inspect_source_tree(self.workspace, baseline)['blockers'], 0)
            proposed = next(f for f in storage.source_tree(self.workspace, baseline, raster_returns=True) if f['path'] == name)
            self.assertEqual(base64.b64decode(proposed['data']), new)
            self.assertEqual(proposed['rasterBaseSha256'], baseline[name]['sha256'])
            inspection = storage.inspect_source_tree(self.workspace, baseline, raster_returns=True)
            self.assertEqual(inspection['blockers'], 0)
            self.assertIn('complete image validation are still required', inspection['changes'][0]['reason'])
            self.workspace.joinpath(name).unlink()
            self.assertGreater(storage.inspect_source_tree(self.workspace, baseline, raster_returns=True)['blockers'], 0)

    def test_raster_policy_does_not_admit_large_executable_unknown_or_other_media_edits(self):
        for extension, size, executable in [('.png', 512 * 1024 + 1, False), ('.png', 1024, True), ('.wav', 1024, False), ('.glb', 1024, False)]:
            name = 'public/retained' + extension
            old = media_bytes(extension, 64)
            target = self.write(name, media_bytes(extension, size))
            target.chmod(0o700 if executable else 0o600)
            baseline = {name: {'size': len(old), 'sha256': hashlib.sha256(old).hexdigest()}}
            inspection = storage.inspect_source_tree(self.workspace, baseline, raster_returns=True)
            self.assertGreater(inspection['blockers'], 0)
            if executable:
                with self.assertRaises(ValueError): storage.source_tree(self.workspace, baseline, raster_returns=True)
            else:
                result = next(f for f in storage.source_tree(self.workspace, baseline, raster_returns=True) if f['path'] == name)
                self.assertNotIn('rasterBaseSha256', result)
            target.unlink()

    def test_new_and_ordinary_modified_rasters_obey_candidate_bound_in_both_path_classes(self):
        for extension in ('.png', '.jpg', '.jpeg', '.webp'):
            for prefix in ('public/', 'art/'):
                for modified in (False, True):
                    for size in (storage.RASTER_RETURN_BYTES, storage.RASTER_RETURN_BYTES + 1, 2 * 1024 * 1024):
                        with self.subTest(extension=extension, prefix=prefix, modified=modified, size=size):
                            name = prefix + 'candidate' + extension.upper()
                            old = media_bytes(extension, 64)
                            baseline = {name: {'sha256': hashlib.sha256(old).hexdigest(), 'executable': False}} if modified else {}
                            data = media_bytes(extension, size)
                            target = self.write(name, data)
                            target.chmod(0o600)
                            legacy = storage.inspect_source_tree(self.workspace, baseline)
                            self.assertEqual(legacy['blockers'], 0)
                            self.assertEqual(legacy['rasterReturnVersion'], 0)
                            self.assertNotIn('reason', legacy['changes'][0])
                            inspection = storage.inspect_source_tree(self.workspace, baseline, raster_returns=True)
                            self.assertTrue(inspection['complete'])
                            self.assertEqual(inspection['rasterInspectionVersion'], 1)
                            self.assertEqual(inspection['rasterReturnVersion'], 1)
                            self.assertEqual(inspection['blockers'], int(size > storage.RASTER_RETURN_BYTES))
                            change = inspection['changes'][0]
                            self.assertEqual(change['kind'], 'blocked' if inspection['blockers'] else 'modified' if modified else 'added')
                            self.assertIn('512 KiB' if inspection['blockers'] else 'complete image validation are still required', change['reason'])
                            # Capture remains a bounded raw-review protocol, not a validation receipt.
                            captured = next(file for file in storage.source_tree(self.workspace, baseline, raster_returns=True) if file['path'] == name)
                            self.assertEqual(base64.b64decode(captured['data']), data)
                            self.assertEqual(target.read_bytes(), data)
                            target.unlink()

    def test_raster_inspection_rejects_execute_changes_and_invalid_headers_without_touching_bytes(self):
        for prefix in ('public/', 'art/'):
            for modified in (False, True):
                for data, mode in ((media_bytes('.png', 1024), 0o700), (b'invalid raster', 0o600), (b'', 0o600)):
                    with self.subTest(prefix=prefix, modified=modified, mode=mode, size=len(data)):
                        name = prefix + 'candidate.png'
                        old = data if mode & 0o111 else media_bytes('.png', 64)
                        baseline = {name: {'sha256': hashlib.sha256(old).hexdigest(), 'executable': False}} if modified else {}
                        target = self.write(name, data); target.chmod(mode)
                        inspection = storage.inspect_source_tree(self.workspace, baseline, raster_returns=True)
                        self.assertEqual(inspection['blockers'], 1)
                        self.assertEqual(target.read_bytes(), data)
                        target.unlink()

    def test_unchanged_transparent_png_and_existing_read_modes_are_not_rewritten(self):
        def chunk(kind, data):
            return len(data).to_bytes(4, 'big') + kind + data + zlib.crc32(kind + data).to_bytes(4, 'big')
        transparent = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', b'\0\0\0\1\0\0\0\1\x08\x06\0\0\0') \
            + chunk(b'IDAT', zlib.compress(bytes(5))) + chunk(b'IEND', b'')
        name = 'public/transparent.png'
        for registered in (False, True):
            for mode in (0o400, 0o600, 0o644):
                with self.subTest(registered=registered, mode=mode):
                    target = self.write(name, transparent); target.chmod(mode)
                    baseline = {name: {'sha256': hashlib.sha256(transparent).hexdigest(), **({'size': len(transparent)} if registered else {'executable': False})}}
                    before = target.stat()
                    inspection = storage.inspect_source_tree(self.workspace, baseline, raster_returns=True)
                    self.assertEqual(inspection['changes'], [])
                    self.assertEqual(inspection['blockers'], 0)
                    storage.source_tree(self.workspace, baseline, raster_returns=True)
                    self.assertEqual(target.read_bytes(), transparent)
                    self.assertEqual(target.stat().st_mode, before.st_mode)
                    target.unlink()

    def test_raster_candidates_share_source_budget_with_unchanged_ordinary_files(self):
        for unchanged in (False, True):
            with self.subTest(unchanged=unchanged), tempfile.TemporaryDirectory(dir=self.mount) as directory:
                root = pathlib.Path(directory)
                (root / 'public').mkdir()
                original = root / 'main.js' if unchanged else root / 'public/first.png'
                original.write_bytes(b'x' * 1024 if unchanged else media_bytes('.png', 1024))
                baseline = {original.relative_to(root).as_posix(): {'sha256': hashlib.sha256(original.read_bytes()).hexdigest(), 'executable': False}} if unchanged else {}
                (root / 'public/second.png').write_bytes(media_bytes('.png', 1024))
                with mock.patch.object(storage, 'MAX_BYTES', 2048):
                    self.assertEqual(storage.inspect_source_tree(root, baseline, raster_returns=True)['blockers'], 0)
                with mock.patch.object(storage, 'MAX_BYTES', 2047):
                    self.assertGreater(storage.inspect_source_tree(root, baseline, raster_returns=True)['blockers'], 0)
                    with self.assertRaises(ValueError): storage.source_tree(root, baseline, raster_returns=True)

    def test_verified_media_copies_still_obey_the_media_total(self):
        data = media_bytes('.png', 1024)
        self.write('assets/files/original.png', data)
        self.write('public/copy.png', data)
        baseline = {'assets/files/original.png': {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}}
        with mock.patch.object(storage, 'MEDIA_TOTAL', 2048):
            self.assertEqual(storage.inspect_source_tree(self.workspace, baseline, raster_returns=True)['blockers'], 0)
        with mock.patch.object(storage, 'MEDIA_TOTAL', 2047):
            self.assertGreater(storage.inspect_source_tree(self.workspace, baseline, raster_returns=True)['blockers'], 0)
            with self.assertRaises(ValueError): storage.source_tree(self.workspace, baseline, raster_returns=True)

    def test_registered_raster_candidate_uses_source_budget_instead_of_media_budget(self):
        old, changed, retained = media_bytes('.png', 1024), media_bytes('.png', 1536), media_bytes('.wav', 1024)
        self.write('public/candidate.png', changed)
        self.write('public/retained.wav', retained)
        baseline = {name: {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
            for name, data in [('public/candidate.png', old), ('public/retained.wav', retained)]}
        with mock.patch.object(storage, 'MEDIA_TOTAL', 2048), mock.patch.object(storage, 'MAX_BYTES', 1536):
            captured = {file['path']: file for file in storage.source_tree(self.workspace, baseline, raster_returns=True)}
            self.assertEqual(base64.b64decode(captured['public/candidate.png']['data']), changed)
            self.assertEqual(captured['public/candidate.png']['rasterBaseSha256'], baseline['public/candidate.png']['sha256'])
            inspection = storage.inspect_source_tree(self.workspace, baseline, raster_returns=True)
            self.assertTrue(inspection['complete'])
            self.assertEqual(inspection['blockers'], 0)
            self.assertIn('complete image validation are still required', inspection['changes'][0]['reason'])
        with mock.patch.object(storage, 'MEDIA_TOTAL', 2048), mock.patch.object(storage, 'MAX_BYTES', 1535):
            inspection = storage.inspect_source_tree(self.workspace, baseline, raster_returns=True)
            self.assertFalse(inspection['complete'])
            self.assertGreater(inspection['blockers'], 0)
            with self.assertRaises(ValueError): storage.source_tree(self.workspace, baseline, raster_returns=True)

    def test_small_and_large_verified_registered_replacements_stay_copy_descriptors(self):
        for size in (1024, 3 * 1024 * 1024):
            with self.subTest(size=size):
                old, verified = media_bytes('.png', 64), media_bytes('.png', size)
                self.write('public/current.png', verified)
                self.write('assets/files/verified.png', verified)
                digest = hashlib.sha256(verified).hexdigest()
                baseline = {'public/current.png': {'size': len(old), 'sha256': hashlib.sha256(old).hexdigest()},
                    'assets/files/verified.png': {'size': size, 'sha256': digest}}
                with mock.patch.object(storage, 'MEDIA_TOTAL', size * 2), mock.patch.object(storage, 'MAX_BYTES', 0):
                    captured = {file['path']: file for file in storage.source_tree(self.workspace, baseline, raster_returns=True)}
                    self.assertEqual(captured['public/current.png'], {'path': 'public/current.png', 'size': size, 'sha256': digest})
                    inspection = storage.inspect_source_tree(self.workspace, baseline, raster_returns=True)
                    self.assertTrue(inspection['complete'])
                    self.assertEqual(inspection['blockers'], 0)
                    self.assertEqual(inspection['changes'], [{'path': 'public/current.png', 'kind': 'modified', 'size': size}])

    def test_dual_category_raster_reads_remain_bounded_after_category_overflow(self):
        for registered in (False, True):
            with self.subTest(registered=registered), tempfile.TemporaryDirectory(dir=self.mount) as directory:
                root = pathlib.Path(directory); (root / 'public').mkdir()
                data = media_bytes('.png', 512)
                baseline = {}
                for index in range(12):
                    name = 'public/image' + str(index) + '.png'
                    (root / name).write_bytes(data)
                    if registered: baseline[name] = {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                reader, reads = storage.artifact_reader, []
                @contextmanager
                def observed(root, relative):
                    with reader(root, relative) as value:
                        reads.append(value[1].st_size)
                        yield value
                with mock.patch.object(storage, 'MEDIA_TOTAL', 1024), mock.patch.object(storage, 'MAX_BYTES', 1024), \
                        mock.patch.object(storage, 'artifact_reader', side_effect=observed):
                    inspection = storage.inspect_source_tree(root, baseline, raster_returns=True)
                self.assertFalse(inspection['complete'])
                self.assertGreater(inspection['blockers'], 0)
                self.assertLessEqual(sum(reads), 2048)
                self.assertLessEqual(len(reads), 4)

    def test_retained_review_separates_raw_rasters_from_source_and_verified_copy_authority(self):
        verified = media_bytes('.png', 1024)
        self.write('assets/files/verified.png', verified)
        self.write('public/copy.png', verified)
        raw = media_bytes('.webp', 3 * 1024 * 1024)
        self.write('public/new.webp', raw)
        self.write('main.js', b'retained source')
        baseline = {'assets/files/verified.png': {'size': len(verified), 'sha256': hashlib.sha256(verified).hexdigest()}}
        snapshot = storage.retained_source_tree(self.workspace, baseline)
        self.assertEqual(snapshot['retainedRasters'], [{'path': 'public/new.webp', 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'executable': False}])
        self.assertTrue(all('data' not in item for item in snapshot['files'] if item['path'].endswith('.png')))
        output = io.BytesIO(); storage.stream_retained_source(self.workspace, snapshot, output)
        header, payload = output.getvalue().split(b'\n', 1)
        self.assertEqual(json.loads(header), snapshot)
        self.assertEqual(payload, raw)
        self.assertEqual((self.workspace / 'public/new.webp').read_bytes(), raw)

    def test_retained_review_keeps_size_count_source_and_shared_media_bounds(self):
        raw = media_bytes('.png', 1024)
        self.write('public/raw.png', raw)
        self.write('assets/files/existing.png', raw)
        baseline = {'assets/files/existing.png': {'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}}
        # Make the added image distinct from the verified original.
        self.write('public/raw.png', raw[:-1] + b'!')
        with mock.patch.object(storage, 'MEDIA_TOTAL', 2048):
            self.assertEqual(len(storage.retained_source_tree(self.workspace, baseline)['retainedRasters']), 1)
        for limits in ({'MEDIA_FILE': 1023}, {'MEDIA_TOTAL': 2047}, {'MAX_FILES': 1}):
            with self.subTest(limits=limits), mock.patch.multiple(storage, **limits), self.assertRaises(ValueError):
                storage.retained_source_tree(self.workspace, {} if 'MEDIA_FILE' in limits else baseline)
        self.write('main.js', b'x' * 65)
        with mock.patch.object(storage, 'MAX_BYTES', 64), self.assertRaises(ValueError):
            storage.retained_source_tree(self.workspace, baseline)

    def test_retained_review_never_promotes_nonruntime_executable_linked_or_unknown_media(self):
        for name, data, mode in [('art/large.png', media_bytes('.png', 2 * 1024 * 1024 + 1), 0o600),
                                 ('public/large.wav', media_bytes('.wav', 2 * 1024 * 1024 + 1), 0o600),
                                 ('public/run.png', media_bytes('.png', 32), 0o700)]:
            with self.subTest(name=name):
                target = self.write(name, data); target.chmod(mode)
                with self.assertRaises(ValueError): storage.retained_source_tree(self.workspace, {})
                self.assertEqual(target.read_bytes(), data); target.unlink()
        target = self.write('public/original.png', media_bytes('.png', 32))
        for linked in ('symbolic', 'hard'):
            alias = self.workspace / 'public/alias.png'
            if linked == 'symbolic': alias.symlink_to(target)
            else: os.link(target, alias)
            with self.assertRaises(ValueError): storage.retained_source_tree(self.workspace, {})
            alias.unlink()
        baseline = {'public/original.png': {'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'executable': False}}
        self.assertIn('data', storage.retained_source_tree(self.workspace, baseline)['files'][0])

    def test_retained_stream_rechecks_raw_bytes_and_bounds_header_before_writing(self):
        target = self.write('public/raw.png', media_bytes('.png', 1024))
        snapshot = storage.retained_source_tree(self.workspace, {})
        changed = target.read_bytes()[:-1] + b'!'; target.write_bytes(changed)
        output = io.BytesIO()
        with self.assertRaisesRegex(ValueError, 'changed'):
            storage.stream_retained_source(self.workspace, snapshot, output)
        self.assertEqual(target.read_bytes(), changed)
        oversized = {**snapshot, 'padding': 'x' * (16 * 1024 * 1024)}
        output = io.BytesIO()
        with self.assertRaisesRegex(ValueError, 'manifest'):
            storage.stream_retained_source(self.workspace, oversized, output)
        self.assertEqual(output.getvalue(), b'')

    def test_streamed_inspection_classifies_runtime_rasters_as_candidates_under_shared_media_limits(self):
        for extension in sorted(storage.STATIC_RASTER_EXTENSIONS):
            for baseline_kind in ('new', 'ordinary', 'media'):
                with self.subTest(extension=extension, baseline=baseline_kind), tempfile.TemporaryDirectory(dir=self.mount) as directory:
                    root = pathlib.Path(directory); (root / 'public').mkdir()
                    relative = 'public/sprites' + extension; data = media_bytes(extension, 3 * 1024 * 1024)
                    (root / relative).write_bytes(data)
                    baseline = {} if baseline_kind == 'new' else {relative: {'sha256': 'f' * 64, 'executable': False,
                        **({'size': 16} if baseline_kind == 'media' else {})}}
                    old = storage.inspect_source_tree(root, baseline, raster_returns=True)
                    self.assertGreater(old['blockers'], 0)
                    inspection = storage.inspect_source_tree(root, baseline, raster_returns=2)
                    self.assertEqual(inspection['rasterInspectionVersion'], 2); self.assertEqual(inspection['rasterReturnVersion'], 2)
                    self.assertTrue(inspection['complete']); self.assertEqual(inspection['blockers'], 0)
                    self.assertEqual(inspection['changes'][0]['kind'], 'added' if baseline_kind == 'new' else 'modified')
                    self.assertIn('candidate', inspection['changes'][0]['reason'])
                    self.assertIn('approval', inspection['changes'][0]['reason'])
                    self.assertNotIn('data', json.dumps(inspection))
                    manifest = storage.retained_source_tree(root, baseline)
                    self.assertEqual(manifest['files'], [])
                    self.assertEqual(manifest['retainedRasters'], [{'path': relative, 'size': len(data),
                        'sha256': hashlib.sha256(data).hexdigest(), 'executable': False}])

    def test_streamed_inspection_and_capture_share_copy_mode_ordinary_and_read_budgets(self):
        data = media_bytes('.png', 1024)
        self.write('public/raw.png', data)
        original = self.write('assets/files/original.png', data[:-1] + b'!')
        baseline = {'assets/files/original.png': {'size': len(data), 'sha256': hashlib.sha256(original.read_bytes()).hexdigest()}}
        self.write('public/copy.png', original.read_bytes())
        with mock.patch.object(storage, 'MEDIA_TOTAL', 3072):
            self.assertEqual(storage.inspect_source_tree(self.workspace, baseline, raster_returns=2)['blockers'], 0)
            self.assertEqual(len(storage.retained_source_tree(self.workspace, baseline)['retainedRasters']), 1)
        with mock.patch.object(storage, 'MEDIA_TOTAL', 3071):
            self.assertGreater(storage.inspect_source_tree(self.workspace, baseline, raster_returns=2)['blockers'], 0)
            with self.assertRaises(ValueError): storage.retained_source_tree(self.workspace, baseline)
        (self.workspace / 'public/raw.png').chmod(0o700)
        self.assertGreater(storage.inspect_source_tree(self.workspace, baseline, raster_returns=2)['blockers'], 0)
        with self.assertRaises(ValueError): storage.retained_source_tree(self.workspace, baseline)
        (self.workspace / 'public/raw.png').chmod(0o600)
        self.write('art/nonruntime.png', media_bytes('.png', 2 * 1024 * 1024))
        self.assertEqual(storage.inspect_source_tree(self.workspace, baseline, raster_returns=2)['blockers'], 0)
        self.assertTrue(any(item['path'] == 'art/nonruntime.png' and 'data' in item for item in storage.retained_source_tree(self.workspace, baseline)['files']))
        self.write('art/nonruntime.png', media_bytes('.png', 2 * 1024 * 1024 + 1))
        self.assertGreater(storage.inspect_source_tree(self.workspace, baseline, raster_returns=2)['blockers'], 0)
        with self.assertRaises(ValueError): storage.retained_source_tree(self.workspace, baseline)

    def test_streamed_capture_is_bound_to_original_operation_until_explicit_ack_and_next_prepare(self):
        from test_lifecycle import FakeBackend, complete_bytes
        class CaptureBackend(FakeBackend):
            snapshot = storage.Backend.snapshot
            snapshot_rasters = storage.Backend.snapshot_rasters
            review_snapshot = storage.Backend.review_snapshot
            stream_review = storage.Backend.stream_review
            stream_capture = storage.Backend.stream_capture
            inspect_source_media = storage.Backend.inspect_source_media
        backend = CaptureBackend(); root = self.mount / 'streamed-volumes'
        make = lambda: storage.lifecycle.Store(root, backend, volume_bytes=4096, total_bytes=65536, reserve_bytes=0)
        request = {'namespace': 'manual', 'projectId': '5e849fb8-9236-4f0e-a58a-76cb223b8a74', 'operationId': '1' * 32,
            'mode': 'shell', 'files': [self.incoming('main.js', b'baseline')], 'packages': [], 'rasterReturnVersion': 2}
        binding = make().prepare(request)
        self.assertEqual(binding['rasterReturnVersion'], 2); self.assertEqual(binding['captureVersion'], 2)
        make().claim({**binding, 'mode': 'shell'})
        folder = root / ('manual-' + request['projectId']); workspace = folder / 'root/workspace'; (workspace / 'public').mkdir()
        raw = media_bytes('.png', 3 * 1024 * 1024); target = workspace / 'public/sprites.png'; target.write_bytes(raw)
        finished = make().finish(binding, True)
        self.assertTrue(finished['dirty']); self.assertIsNotNone(finished['sourceDigest'])
        self.assertEqual(make().inspect_source({key: binding[key] for key in ('namespace', 'projectId', 'generation')})['rasterInspectionVersion'], 2)
        source_before = complete_bytes(folder)
        spec = {key: binding[key] for key in ('namespace', 'projectId', 'operationId', 'generation', 'leaseToken', 'captureVersion')}
        output = io.BytesIO(); captured = make().capture_media(spec, output)
        header, payload = output.getvalue().split(b'\n', 1)
        self.assertEqual(json.loads(header), captured); self.assertEqual(payload, raw)
        self.assertEqual(set(captured), {'captureVersion', 'namespace', 'projectId', 'operationId', 'generation', 'snapshotId',
            'rasterReturnVersion', 'files', 'baselineFiles', 'returnedRasters'})
        self.assertEqual(captured['snapshotId'], finished['sourceDigest'])
        self.assertEqual(captured['returnedRasters'], [{'path': 'public/sprites.png', 'size': len(raw),
            'sha256': hashlib.sha256(raw).hexdigest(), 'executable': False}])
        record_key = 'manual-' + request['projectId']
        self.assertNotIn('public/sprites.png', make()._read()['records'][record_key]['baseline'])
        self.assertTrue(make()._read()['records'][record_key]['dirty'])
        saved = make().file.read_bytes(); output = io.BytesIO()
        self.assertEqual(make().capture_media(spec, output), captured); self.assertEqual(payload, raw)
        self.assertEqual(make().file.read_bytes(), saved)
        for change in ({'generation': binding['generation'] + 1}, {'namespace': 'test'}, {'leaseToken': 'f' * 32}, {'operationId': 'f' * 32}):
            with self.subTest(change=change), self.assertRaises(storage.lifecycle.LifecycleError): make().capture_media({**spec, **change})
        target.write_bytes(raw[:-1] + b'!')
        with self.assertRaises(storage.lifecycle.LifecycleError): make().capture_media(spec)
        with self.assertRaises(storage.lifecycle.LifecycleError): make().acknowledge({**binding, 'snapshotId': captured['snapshotId']})
        self.assertEqual(make().file.read_bytes(), saved); target.write_bytes(raw)
        self.assertEqual(complete_bytes(folder), source_before)
        # Only the trusted host calls ACK after full validation, durable retention and approval.
        for version in (None, 1, True):
            ack = {**{key: value for key, value in binding.items() if key != 'captureVersion'}, 'snapshotId': captured['snapshotId']}
            if version is not None: ack['captureVersion'] = version
            with self.subTest(version=version), self.assertRaises(storage.lifecycle.LifecycleError): make().acknowledge(ack)
        make().acknowledge({**binding, 'snapshotId': captured['snapshotId']}); saved = make().file.read_bytes()
        make().acknowledge({**binding, 'snapshotId': captured['snapshotId']})
        self.assertEqual(make().file.read_bytes(), saved)
        self.assertEqual(make()._read()['records'][record_key]['baseline']['public/sprites.png'],
            {'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'executable': False})
        self.assertEqual(complete_bytes(folder), source_before); make().release(binding)
        confirmed = make().review_source_media({**{key: binding[key] for key in ('namespace', 'projectId', 'generation')}, 'reviewVersion': 2})
        self.assertEqual(confirmed['snapshotId'], captured['snapshotId']); self.assertEqual(confirmed['retainedRasters'], [])
        self.assertIn({'operationId': binding['operationId'], 'mode': 'shell', 'phase': 'released', 'snapshotId': captured['snapshotId'], 'acknowledged': True}, confirmed['originOperations'])
        reservation = make().recover({'namespace': 'manual', 'projectId': binding['projectId'], 'generation': binding['generation'], 'operationId': '3' * 32})
        self.assertEqual(reservation['captureVersion'], 2); self.assertEqual(reservation['rasterReturnVersion'], 2)
        (workspace / 'dist').mkdir(); (workspace / 'dist/index.html').write_bytes(b'fixture build output')
        before_export = complete_bytes(folder); registry_before_export = make().file.read_bytes()
        output = io.BytesIO()
        with mock.patch.object(storage, '_store', return_value=make()):
            storage.export_bound(reservation, output_stream=output)
        export_header, export_body = output.getvalue().split(b'\n', 1)
        self.assertEqual(base64.b64decode(json.loads(export_header)['files'][0]['data']), b'fixture build output')
        self.assertEqual(export_body, b''); self.assertEqual(complete_bytes(folder), before_export)
        self.assertEqual(make().file.read_bytes(), registry_before_export); make().release(reservation)
        working = media_bytes('.png', 128)
        next_binding = make().prepare({**request, 'operationId': '2' * 32, 'files': [self.incoming('main.js', b'baseline'), self.incoming('public/sprites.png', working)]})
        self.assertEqual(next_binding['generation'], binding['generation'] + 1); self.assertEqual(next_binding['rasterReturnVersion'], 2)
        self.assertEqual(target.read_bytes(), working)

    def test_streamed_inspection_reads_stay_bounded_when_many_candidates_exceed_the_media_total(self):
        data = media_bytes('.png', 512)
        for index in range(12): self.write('public/raw' + str(index) + '.png', data)
        reader, reads = storage.artifact_reader, []
        @contextmanager
        def observed(root, relative):
            with reader(root, relative) as value:
                reads.append(value[1].st_size)
                yield value
        with mock.patch.object(storage, 'MEDIA_TOTAL', 1024), mock.patch.object(storage, 'MAX_BYTES', 1024), \
                mock.patch.object(storage, 'artifact_reader', side_effect=observed):
            inspection = storage.inspect_source_tree(self.workspace, {}, raster_returns=2)
            self.assertFalse(inspection['complete']); self.assertGreater(inspection['blockers'], 0)
            self.assertLessEqual(sum(reads), 2048)
            with self.assertRaises(ValueError): storage.retained_source_tree(self.workspace, {})

    def test_streamed_and_retained_capture_reject_an_ordinary_raster_mode_only_change(self):
        data = media_bytes('.png', 1024); target = self.write('public/ordinary.png', data)
        baseline = {'public/ordinary.png': {'sha256': hashlib.sha256(data).hexdigest(), 'executable': False}}
        target.chmod(0o700)
        before = target.read_bytes()
        self.assertGreater(storage.inspect_source_tree(self.workspace, baseline, raster_returns=2)['blockers'], 0)
        with self.assertRaisesRegex(ValueError, 'non-executable'): storage.retained_source_tree(self.workspace, baseline)
        self.assertEqual(target.read_bytes(), before); self.assertTrue(target.stat().st_mode & 0o111)
        # A previously ordinary executable is retained unchanged under the old compatibility rule.
        baseline['public/ordinary.png']['executable'] = True
        snapshot = storage.retained_source_tree(self.workspace, baseline)
        self.assertEqual(snapshot['retainedRasters'], []); self.assertTrue(snapshot['files'][0]['executable'])

    def test_streamed_capture_rechecks_binary_and_retained_review_recovers_the_same_raw_snapshot(self):
        raw = media_bytes('.webp', 1024); target = self.write('public/raw.webp', raw)
        snapshot = storage.retained_source_tree(self.workspace, {})
        manifest = {'captureVersion': 2, 'returnedRasters': snapshot['retainedRasters'], 'files': snapshot['files']}
        output = io.BytesIO(); storage.stream_captured_source(self.workspace, manifest, output)
        self.assertEqual(output.getvalue().split(b'\n', 1)[1], raw)
        target.write_bytes(raw[:-1] + b'!')
        with self.assertRaises(ValueError): storage.stream_captured_source(self.workspace, manifest, io.BytesIO())
        for policy in (2,):
            self.retained_review_ack_case(policy)

    def test_retained_review_ack_registers_raw_baseline_then_normal_prepare_syncs_working_source(self):
        for policy in (0, 1):
            with self.subTest(policy=policy):
                self.retained_review_ack_case(policy)

    def test_typed_capture3_reviewed_recovery_and_lost_ack_preserve_full_raw_and_manifest_identity(self):
        self.retained_review_ack_case(2, typed=True)

    def test_real_sync_write_failures_keep_typed_pending_state_and_classify_only_known_volume_writes(self):
        for fault, expected in ((errno.ENOSPC, 'GUEST_VOLUME_FULL'), (errno.EDQUOT, 'GUEST_QUOTA_EXCEEDED'), (errno.EIO, 'GUEST_IO_UNKNOWN')):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory(dir=self.mount) as directory:
                make, backend, binding, request = actual_sync_fixture(pathlib.Path(directory) / 'volumes')
                folder = make().root / ('manual-' + binding['projectId']); target = folder / 'root/workspace/main.js'
                before = make()._read()['records']['manual-' + binding['projectId']]
                actual_open = pathlib.Path.open
                def failing_open(file, *args, **kwargs):
                    stream = actual_open(file, *args, **kwargs)
                    return PartialVolumeWriter(stream, fault) if file.name == 'upload' and args and args[0] == 'xb' else stream
                with mock.patch.object(pathlib.Path, 'open', failing_open), self.assertRaises(Exception) as failure:
                    make().prepare(request)
                self.assertEqual(failure.exception.code, expected); self.assertTrue(failure.exception.changed)
                record = make()._read()['records']['manual-' + binding['projectId']]
                self.assertTrue(record['dirty']); self.assertEqual(record['syncPending'], request['operationId'])
                self.assertEqual(record['sourceManifestId'], before['sourceManifestId']); self.assertEqual(record['sourceManifestSizes'], [8])
                self.assertEqual(record['syncTargetManifestId'], request['sourceManifest']['manifestId']); self.assertEqual(record['syncTargetManifestSizes'], [16])
                self.assertEqual(target.read_bytes(), b'baseline')
                self.assertEqual((folder / ('root/sync-' + request['operationId']) / 'upload').read_bytes(), b'new')
                with self.assertRaises(storage.lifecycle.LifecycleError): make().prepare(request)

    def test_input_pipe_capacity_errno_remains_unknown_instead_of_claiming_the_project_volume_is_full(self):
        make, backend, binding, request = actual_sync_fixture(self.mount / 'input-fault-volumes')
        raw = media_bytes('.png', 1024)
        request['files'].append({'path': 'public/input.png', 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
        request['sourceManifest'] = storage.lifecycle.snapshot_source_manifest(request['files'])
        backend.media_input = mock.Mock(); backend.media_input.read.side_effect = OSError(errno.ENOSPC, 'Synthetic input pipe fault')
        backend.media_request = mock.Mock()
        with self.assertRaises(OSError) as failure: make().prepare(request)
        self.assertEqual(failure.exception.code, 'GUEST_IO_UNKNOWN'); self.assertTrue(failure.exception.changed)
        backend.media_request.assert_called_once_with(['public/input.png']); backend.media_input.read.assert_called_once()
        record = make()._read()['records']['manual-' + binding['projectId']]
        self.assertTrue(record['dirty']); self.assertEqual(record['syncPending'], request['operationId'])
        self.assertEqual(record['sourceManifestSizes'], [8]); self.assertEqual(record['syncTargetManifestSizes'], [16, 1024])

    def retained_review_ack_case(self, policy, typed=False):
        from test_lifecycle import FakeBackend, complete_bytes
        class ReviewBackend(FakeBackend):
            snapshot = storage.Backend.snapshot
            snapshot_rasters = storage.Backend.snapshot_rasters
            review_snapshot = storage.Backend.review_snapshot
            stream_review = storage.Backend.stream_review
            stream_capture = storage.Backend.stream_capture
        backend = ReviewBackend()
        root = self.mount / ('volumes' + str(policy))
        make = lambda: storage.lifecycle.Store(root, backend, volume_bytes=4096, total_bytes=65536, reserve_bytes=0)
        request = {'namespace': 'manual', 'projectId': '5e849fb8-9236-4f0e-a58a-76cb223b8a74', 'operationId': '1' * 32,
                   'mode': 'shell', 'files': [self.incoming('main.js', b'baseline')], 'packages': [], 'rasterReturnVersion': policy}
        if typed:
            request.update(sourceManifestVersion=1, sourceManifest=storage.lifecycle.snapshot_source_manifest(request['files']))
        binding = make().prepare(request); make().claim({**binding, 'mode': 'shell'})
        folder = root / ('manual-' + request['projectId']); workspace = folder / 'root/workspace'
        (workspace / 'public').mkdir(); raw = media_bytes('.png', 3 * 1024 * 1024)
        target = workspace / 'public/raw.png'; target.write_bytes(raw)
        make().finish(binding, False)
        original_capture = None
        if typed:
            scope = {key: binding[key] for key in ('namespace', 'projectId', 'operationId', 'generation', 'leaseToken', 'captureVersion', 'sourceManifestVersion', 'sourceBaseManifestId')}
            self.assertEqual(scope['captureVersion'], 3)
            output = io.BytesIO(); original_capture = make().capture_media(scope, output)
            header, payload = output.getvalue().split(b'\n', 1)
            self.assertEqual(json.loads(header), original_capture); self.assertEqual(payload, raw)
            self.assertEqual(original_capture['sourceBaselineManifest'], request['sourceManifest'])
            self.assertEqual(original_capture['sourceDelta']['addedFiles'], 1)
            self.assertEqual(original_capture['sourceDelta']['afterMediaBytes'], len(raw))
            self.assertEqual(original_capture['sourceDelta']['unchangedFiles'], 1)
            self.assertNotIn('public/raw.png', make()._read()['records']['manual-' + request['projectId']]['baseline'])
        make().release(binding)
        before_source, before_registry = complete_bytes(folder), make().file.read_bytes()
        spec = {'namespace': 'manual', 'projectId': request['projectId'], 'generation': binding['generation'], 'reviewVersion': 2}
        if typed: spec.update(sourceManifestVersion=1, sourceBaseManifestId=binding['sourceBaseManifestId'])
        output = io.BytesIO(); review = make().review_source_media(spec, output)
        header, payload = output.getvalue().split(b'\n', 1)
        self.assertEqual(json.loads(header), review); self.assertEqual(payload, raw)
        self.assertEqual(review['rasterReturnVersion'], policy)
        if typed:
            self.assertEqual(review['snapshotId'], original_capture['snapshotId'])
            self.assertEqual(review['sourceManifest'], original_capture['sourceManifest'])
            self.assertEqual(review['originOperations'], [{'operationId': binding['operationId'], 'mode': 'shell', 'phase': 'released',
                'snapshotId': review['snapshotId'], 'acknowledged': False, 'sourceManifestVersion': 1,
                'sourceBaseManifestId': binding['sourceBaseManifestId'], 'sourceResultManifestId': review['sourceResultManifestId']}])
        else: self.assertEqual(review['originOperations'], [])  # A failed old capture is never invented as successful.
        self.assertEqual(make().file.read_bytes(), before_registry)
        recovery_request = {**spec, 'operationId': '2' * 32, 'reviewSnapshotId': review['snapshotId'],
            **({'sourceResultManifestId': review['sourceResultManifestId']} if typed else {})}
        if typed:
            with self.assertRaises(storage.lifecycle.LifecycleError): make().recover({**recovery_request, 'sourceResultManifestId': 'f' * 64})
            self.assertEqual(make().file.read_bytes(), before_registry)
        recovery = make().recover(recovery_request)
        self.assertEqual(recovery['reviewVersion'], 2)
        self.assertEqual(recovery['rasterReturnVersion'], policy)
        unversioned = {key: value for key, value in recovery.items() if key != 'reviewVersion'}
        with self.assertRaises(storage.lifecycle.LifecycleError): make().capture(unversioned)
        captured = make().capture(recovery)
        self.assertEqual(captured['snapshotId'], review['snapshotId'])
        self.assertEqual(captured['rasterReturnVersion'], policy)
        self.assertEqual(captured['retainedRasters'], review['retainedRasters'])
        if typed:
            self.assertEqual(recovery['captureVersion'], 3)
            self.assertEqual(captured['sourceManifest'], review['sourceManifest'])
            self.assertEqual(captured['sourceDelta'], review['sourceDelta'])
        ack = {**recovery, 'snapshotId': review['snapshotId'], **({'sourceResultManifestId': captured['sourceResultManifestId']} if typed else {})}
        with self.assertRaises(storage.lifecycle.LifecycleError): make().acknowledge({**unversioned, 'snapshotId': review['snapshotId']})
        target.write_bytes(raw + b'late')
        with self.assertRaises(storage.lifecycle.LifecycleError): make().acknowledge(ack)
        self.assertTrue(make()._read()['records']['manual-' + request['projectId']]['dirty'])
        target.write_bytes(raw)
        make().acknowledge(ack)
        saved = make().file.read_bytes()
        make().acknowledge(ack)
        self.assertEqual(make().file.read_bytes(), saved)
        if typed:
            with self.assertRaises(storage.lifecycle.LifecycleError): make().capture(recovery)
        record = make()._read()['records']['manual-' + request['projectId']]
        self.assertFalse(record['dirty'])
        self.assertEqual(record['rasterReturnVersion'], policy)
        self.assertEqual(record['baseline']['public/raw.png'], {'sha256': hashlib.sha256(raw).hexdigest(), 'size': len(raw), 'executable': False})
        self.assertEqual(complete_bytes(folder), before_source)
        make().release(recovery)
        # Treat ACK/release replies as lost: a fresh reader must verify the exact
        # saved operation without issuing another recovery or modifying storage.
        before_verify = make().file.read_bytes()
        if typed:
            current = make().inventory('manual')['projects'][0]
            spec.update(sourceBaseManifestId=current['sourceBaseManifestId'])
        output = io.BytesIO(); confirmed = make().review_source_media(spec, output)
        header, payload = output.getvalue().split(b'\n', 1)
        self.assertEqual(json.loads(header), confirmed); self.assertEqual(payload, b'')
        self.assertEqual(confirmed['snapshotId'], review['snapshotId'])
        self.assertEqual(confirmed['retainedRasters'], [])
        self.assertIn({'path': 'public/raw.png', 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}, confirmed['files'])
        exact = [operation for operation in confirmed['originOperations'] if operation['operationId'] == recovery['operationId']]
        self.assertEqual(exact, [{'operationId': recovery['operationId'], 'mode': 'recovery', 'phase': 'released',
            'snapshotId': review['snapshotId'], 'acknowledged': True,
            **({'sourceManifestVersion': 1, 'sourceBaseManifestId': recovery['sourceBaseManifestId'], 'sourceResultManifestId': review['sourceResultManifestId']} if typed else {})}])
        if typed:
            self.assertEqual(confirmed['sourceBaselineManifest'], review['sourceManifest']); self.assertEqual(confirmed['sourceManifest'], review['sourceManifest'])
            self.assertEqual(confirmed['sourceDelta']['beforeBytes'], 0); self.assertEqual(confirmed['sourceDelta']['afterBytes'], 0)
        self.assertEqual(make().file.read_bytes(), before_verify)
        self.assertEqual(complete_bytes(folder), before_source)
        with self.assertRaises(storage.lifecycle.LifecycleError):
            make().recover({**spec, 'operationId': '3' * 32, 'reviewSnapshotId': review['snapshotId']})
        working = media_bytes('.png', 128)
        incoming = [self.incoming('main.js', b'baseline'), self.incoming('public/raw.png', working)]
        next_binding = make().prepare({**request, 'operationId': '3' * 32, 'files': incoming,
            **({'sourceManifest': storage.lifecycle.snapshot_source_manifest(incoming)} if typed else {})})
        self.assertEqual(next_binding['generation'], binding['generation'] + 1)
        self.assertEqual(next_binding['rasterReturnVersion'], policy)
        self.assertEqual(target.read_bytes(), working)

    def test_hidden_and_private_paths_stay_retained_and_are_excluded_without_traversal(self):
        self.write('main.js', b'unchanged')
        baseline = self.baseline()
        private = self.write('.cache/do-not-enumerate.txt', b'private-cache-payload')
        self.write('.env', b'private-environment-payload')
        self.write('plugin-data/opaque.txt', b'private-plugin-payload')
        outside = self.mount / 'outside-sensitive-name.txt'
        outside.write_bytes(b'outside-private-payload')
        (self.workspace / 'keys.json.png').symlink_to(outside)
        before = {p: p.read_bytes() for p in (private, outside)}
        self.assertEqual(storage.lifecycle.source_map(storage.source_tree(self.workspace, baseline)), baseline)
        inspection = storage.inspect_source_tree(self.workspace, baseline)
        self.assertEqual(inspection, {'complete': True, 'changes': [], 'excluded': 4, 'blockers': 0,
            'rasterInspectionVersion': 1, 'rasterReturnVersion': 0})
        self.assertNotIn('private', json.dumps(inspection))
        self.assertNotIn('keys.json.png', json.dumps(inspection))
        self.assertTrue((self.workspace / 'keys.json.png').is_symlink())
        for target, data in before.items():
            self.assertEqual(target.read_bytes(), data)

    def test_credential_policy_allows_game_media_names_but_never_disguised_credentials(self):
        for extension in storage.GAME_ASSET_EXTENSIONS:
            with self.subTest(extension=extension):
                self.assertEqual(str(storage.safe_path('assets/files/key' + extension)), 'assets/files/key' + extension)
                self.assertFalse(storage.excluded_source_path('public/token' + extension))
        for relative in ['.env', '.env.png', '.ssh/a.png', 'plugin-data/key.png', 'network-settings.json',
                         'public/keys.json.png', 'public/key.yaml.mp4', 'public/a.pem.png', 'public/a.jks.mp3',
                         'public/id_rsa.png', 'public/credentials.txt', 'public/daemon-runtime.json']:
            with self.subTest(relative=relative), self.assertRaises(ValueError):
                storage.safe_path(relative)

    def test_new_or_changed_invalid_media_headers_are_retained_even_below_the_source_limit(self):
        original = self.write('public/a.png', b'legacy ordinary bytes')
        baseline = {'public/a.png': {'sha256': hashlib.sha256(original.read_bytes()).hexdigest(), 'executable': False}}
        self.assertEqual(storage.lifecycle.source_map(storage.source_tree(self.workspace, baseline)), baseline)
        original.write_bytes(b'changed invalid bytes')
        with self.assertRaisesRegex(ValueError, 'header.*public/a.png'):
            storage.source_tree(self.workspace, baseline)
        inspection = storage.inspect_source_tree(self.workspace, baseline)
        self.assertEqual(inspection['changes'][0]['kind'], 'blocked')
        self.assertEqual(inspection['blockers'], 1)
        self.assertEqual(original.read_bytes(), b'changed invalid bytes')

    def test_inspection_reports_independent_media_blockers_and_deletions_without_payloads(self):
        from test_lifecycle import complete_bytes
        self.write('main.js', b'old source')
        image = media_bytes('.png', 32)
        audio = media_bytes('.mp3', 64)
        self.write('public/a.png', image)
        moved = self.write('public/moved.mp3', audio)
        baseline = {'main.js': {'sha256': hashlib.sha256(b'old source').hexdigest()},
            'public/a.png': {'size': len(image), 'sha256': hashlib.sha256(image).hexdigest()},
            'public/moved.mp3': {'size': len(audio), 'sha256': hashlib.sha256(audio).hexdigest()}}
        self.write('main.js', b'new source')
        self.write('public/copy.png', image)
        self.write('public/a.png', image[:-1] + b'!')
        moved.rename(self.workspace / 'public/renamed.mp3')
        self.write('public/bad.mp4', b'invalid header')
        self.write('public/fresh.mp4', media_bytes('.mp4', 3 * 1024 * 1024))
        self.write('assets/files/animation.fbx', bytes(3 * 1024 * 1024))
        (self.workspace / 'public/link.png').symlink_to(self.mount / 'outside')
        before = complete_bytes(self.workspace)
        inspection = storage.inspect_source_tree(self.workspace, baseline)
        self.assertTrue(inspection['complete'])
        self.assertEqual(inspection['blockers'], 6)
        self.assertEqual({item['path']: item['kind'] for item in inspection['changes']}, {
            'main.js': 'modified', 'public/copy.png': 'added', 'public/a.png': 'blocked',
            'public/renamed.mp3': 'added', 'public/moved.mp3': 'deleted', 'public/bad.mp4': 'blocked',
            'public/fresh.mp4': 'blocked', 'assets/files/animation.fbx': 'blocked', 'public/link.png': 'blocked'})
        for item in inspection['changes']:
            self.assertLessEqual(set(item), {'path', 'kind', 'size', 'reason'})
        self.assertEqual(complete_bytes(self.workspace), before)

    def test_inspection_limits_are_incomplete_and_never_claim_a_clean_source(self):
        for index in range(3):
            self.write(str(index) + '.txt', b'same')
        baseline = self.baseline()
        with mock.patch.object(storage, 'MAX_FILES', 2):
            result = storage.inspect_source_tree(self.workspace, baseline)
        self.assertFalse(result['complete'])
        self.assertGreaterEqual(result['blockers'], 1)
        with mock.patch.object(storage, 'MAX_BYTES', 5):
            result = storage.inspect_source_tree(self.workspace, baseline)
        self.assertFalse(result['complete'])
        self.assertGreaterEqual(result['blockers'], 1)
        consumed = []
        @contextmanager
        def crowded(_directory):
            def entries():
                for index in range(100000):
                    consumed.append(index)
                    yield types.SimpleNamespace(name='dist', path=str(self.workspace / 'dist'))
            yield entries()
        with mock.patch.object(storage.os, 'scandir', side_effect=crowded):
            result = storage.inspect_source_tree(self.workspace, baseline)
        self.assertFalse(result['complete'])
        self.assertEqual(result['excluded'], 4000)
        self.assertEqual(len(consumed), 4001)
        self.assertGreaterEqual(result['blockers'], 1)

    def test_inspection_hides_invalid_names_and_rejects_a_file_changed_before_open(self):
        self.write('unsafe\\name.txt', b'not returned')
        result = storage.inspect_source_tree(self.workspace, {})
        self.assertEqual(result['changes'][0]['path'], 'workspace')
        self.assertNotIn('unsafe', json.dumps(result))
        target = self.write('main.js', b'initial')
        reader = storage.artifact_reader
        from contextlib import contextmanager
        @contextmanager
        def changed(root, relative):
            target.write_bytes(b'changed before opening with a larger size')
            with reader(root, relative) as value:
                yield value
        with mock.patch.object(storage, 'artifact_reader', side_effect=changed):
            result = storage.inspect_source_tree(self.workspace, {})
        self.assertTrue(all(item['kind'] == 'blocked' for item in result['changes']))
        self.assertEqual(target.read_bytes(), b'changed before opening with a larger size')

    def test_capture_rejects_ordinary_and_media_files_changed_before_open(self):
        for relative, data, media in [('main.js', b'original', False), ('public/a.wav', media_bytes('.wav', 64), True)]:
            with self.subTest(relative=relative), tempfile.TemporaryDirectory(dir=self.mount) as directory:
                root = pathlib.Path(directory)
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                baseline = {relative: {'sha256': hashlib.sha256(data).hexdigest(), **({'size': len(data)} if media else {})}}
                reader = storage.artifact_reader
                @contextmanager
                def changed(directory, name):
                    target.write_bytes(data + b'late edit')
                    with reader(directory, name) as value:
                        yield value
                with mock.patch.object(storage, 'artifact_reader', side_effect=changed), self.assertRaisesRegex(ValueError, 'changed before capture'):
                    storage.source_tree(root, baseline)
                self.assertEqual(target.read_bytes(), data + b'late edit')

    def test_source_capture_returns_small_and_large_approved_media_copies_as_references(self):
        size = 3 * 1024 * 1024
        model = b'glTF' + (2).to_bytes(4, 'little') + size.to_bytes(4, 'little') + bytes(size - 12)
        image = b'\x89PNG\r\n\x1a\n' + bytes(24)
        expected = {}
        baseline = {}
        for original, copied, data in [
                ('assets/generated/hunter.glb', 'public/models/hunter/hunter.glb', model),
                ('assets/imported/ground.png', 'public/art/ground.png', image)]:
            for relative in (original, copied):
                self.write(relative, data)
                expected[relative] = {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'executable': False}
            baseline[original] = expected[original]
        self.assertEqual(storage.lifecycle.source_map(storage.source_tree(self.workspace, baseline)), expected)
        self.assertEqual((self.workspace / 'public/models/hunter/hunter.glb').read_bytes(), model)
        self.assertEqual((self.workspace / 'assets/generated/hunter.glb').read_bytes(), model)

    def test_source_capture_refuses_unapproved_changed_executable_and_linked_media_copies(self):
        data = b'ID3' + bytes(2 * 1024 * 1024)
        original = self.write('assets/generated/ambient.mp3', data)
        baseline = {'assets/generated/ambient.mp3': {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}}
        for case, relative in [('changed', 'public/audio/ambient.mp3'), ('header', 'public/audio/ambient.mp4'),
                               ('location', 'downloads/ambient.mp3'), ('executable', 'public/audio/ambient.mp3'),
                               ('link', 'public/audio/ambient.mp3'), ('hardlink', 'public/audio/ambient.mp3')]:
            with self.subTest(case=case):
                target = self.workspace / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                if case == 'link':
                    target.symlink_to(original)
                elif case == 'hardlink':
                    os.link(original, target)
                else:
                    target.write_bytes(data[:-1] + b'!' if case == 'changed' else data)
                    if case == 'executable':
                        target.chmod(0o700)
                with self.assertRaisesRegex(ValueError, 'retained') as error:
                    storage.source_tree(self.workspace, baseline)
                if case != 'hardlink':
                    self.assertIn(relative, str(error.exception))
                if case in ('changed', 'header', 'location'):
                    self.assertIn(str(len(data)) + ' bytes', str(error.exception))
                target.unlink()
                self.assertEqual(original.read_bytes(), data)

    def test_source_capture_keeps_media_count_and_size_limits_for_copies(self):
        data = b'\x89PNG\r\n\x1a\n' + bytes(24)
        self.write('assets/generated/a.png', data)
        self.write('public/art/copy.png', data)
        baseline = {'assets/generated/a.png': {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}}
        for limits in ({'MEDIA_TOTAL': len(data)}, {'MEDIA_FILE': len(data) - 1}, {'MAX_FILES': 1}):
            with self.subTest(limits=limits), mock.patch.multiple(storage, **limits), self.assertRaises(ValueError):
                storage.source_tree(self.workspace, baseline)

    def test_failed_copied_media_capture_recovers_without_discarding_source(self):
        from test_lifecycle import FakeBackend

        class RealMediaBackend(FakeBackend, storage.Backend):
            validate_files = storage.Backend.validate_files
            sync = storage.Backend.sync
            snapshot = storage.Backend.snapshot
            finalize_sync = storage.Backend.finalize_sync

        backend = RealMediaBackend()
        data = b'ID3' + bytes(2 * 1024 * 1024)
        original = {'path': 'assets/generated/ambient.mp3', 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        copied = {**original, 'path': 'public/audio/ambient.mp3'}
        backend.media_input = io.BytesIO(data)
        backend.media_request = lambda paths: None
        root = self.mount / 'volumes'
        make = lambda: storage.lifecycle.Store(root, backend, volume_bytes=4096, total_bytes=65536, reserve_bytes=0)
        spec = {'namespace': 'manual', 'projectId': '5e849fb8-9236-4f0e-a58a-76cb223b8a74',
                'operationId': '1' * 32, 'mode': 'shell', 'files': [original], 'packages': []}
        store = make()
        binding = store.prepare(spec)
        store.claim({**binding, 'mode': 'shell'})
        workspace = root / ('manual-' + spec['projectId']) / 'root/workspace'
        target = workspace / copied['path']
        target.parent.mkdir(parents=True)
        target.write_bytes(data)
        with mock.patch.object(backend, 'snapshot', side_effect=ValueError('Invalid source file')):
            self.assertTrue(store.finish(binding, True)['dirty'])
        store.release(binding)
        recovery = make().recover({**spec, 'operationId': '2' * 32, 'generation': binding['generation']})
        snapshot = make().capture(recovery)
        self.assertEqual(sorted(snapshot['files'], key=lambda item: item['path']), [original, copied])
        make().acknowledge({**recovery, 'snapshotId': snapshot['snapshotId']})
        self.assertFalse(make().release(recovery)['dirty'])
        backend.media_input = io.BytesIO(b'')
        prepared = make().prepare({**spec, 'operationId': '3' * 32, 'files': snapshot['files']})
        self.assertTrue(prepared['prepared'])
        self.assertEqual(target.read_bytes(), data)
        self.assertEqual((workspace / original['path']).read_bytes(), data)

    def test_media_sync_sends_only_changed_bytes_and_exports_only_exact_copies(self):
        data = b"\x00\x00\x00\x18ftypisom" + b'x' * (3 * 1024 * 1024)
        asset = {'path': 'public/intro.mp4', 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
        source = self.incoming('main.js', b'old')
        requests = []
        self.backend.media_request = requests.append
        self.backend.media_input = io.BytesIO(data)
        files = self.backend.validate_files([source, asset])
        self.backend.sync(self.mount, files, [], self.identity, {}, self.operation)
        self.backend.finalize_sync(self.mount, self.operation)
        baseline = storage.lifecycle.source_map(files)
        self.backend.media_input = io.BytesIO(b'')
        self.backend.sync(self.mount, [self.incoming('main.js', b'new'), asset], [], self.identity, baseline, self.operation)
        self.backend.finalize_sync(self.mount, self.operation)
        self.assertEqual(requests, [['public/intro.mp4'], []])
        self.assertEqual((self.workspace / asset['path']).read_bytes(), data)
        self.write('dist/media/renamed.mp4', data)
        exported = storage.export_tree(self.workspace, runtime_media={'public/intro.mp4': asset})
        self.assertEqual(exported['media'], [{**asset, 'path': 'dist/media/renamed.mp4'}])
        self.assertEqual(exported['files'], [])
        self.write('dist/media/renamed.mp4', data[:-1] + b'!')
        with self.assertRaises(ValueError):
            storage.export_tree(self.workspace, runtime_media={'public/intro.mp4': asset})

    def test_generated_build_media_are_streamed_and_copies_reuse_the_original(self):
        movie = b"....ftypisom" + bytes(range(256)) * 12900
        original = movie[:-1] + b'!'
        self.write('app/dist/clips/movie.mp4', movie)
        self.write('app/dist/clips/original.mp4', original)
        png = b'\x89PNG\r\n\x1a\n' + bytes(range(16))
        self.write('app/dist/art.png', png)
        self.write('app/dist/index.html', b'fixture')
        copy = {'size': len(original), 'sha256': hashlib.sha256(original).hexdigest()}
        out = io.BytesIO()
        storage.export_tree(self.workspace, 'app', {'public/original.mp4': copy}, out)
        header, payload = out.getvalue().split(b'\n', 1)
        manifest = json.loads(header)
        self.assertEqual(manifest['media'], [{'path': 'dist/clips/original.mp4', **copy}])
        self.assertEqual([f['path'] for f in manifest['files']], ['dist/index.html'])
        expected = {'dist/clips/movie.mp4': movie, 'dist/art.png': png}
        self.assertEqual({f['path'] for f in manifest['generatedMedia']}, set(expected))
        for entry in manifest['generatedMedia']:
            data, payload = payload[:entry['size']], payload[entry['size']:]
            self.assertEqual(data, expected[entry['path']])
            self.assertEqual(entry['sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(payload, b'')

    def test_streaming_preserves_budgets_and_media_eligibility_before_writing(self):
        clip = self.write('dist/a.mp4', b'....ftypisom' + bytes(2 * 1024 * 1024))
        for case in ('ordinary', 'executable', 'total', 'individual'):
            with self.subTest(case=case), mock.patch.object(storage, 'MEDIA_TOTAL', 1024 if case == 'total' else storage.MEDIA_TOTAL), \
                 mock.patch.object(storage, 'MEDIA_FILE', 1024 if case == 'individual' else storage.MEDIA_FILE):
                clip.chmod(0o755 if case == 'executable' else 0o644)
                with clip.open('r+b') as stream:
                    stream.seek(4)
                    stream.write(b'code' if case == 'ordinary' else b'ftyp')
                out = io.BytesIO()
                with self.assertRaises(ValueError):
                    storage.export_tree(self.workspace, output_stream=out)
                self.assertEqual(out.getvalue(), b'')

    def test_generated_media_changed_after_manifest_cannot_succeed(self):
        data = b'....ftypisomoriginal bytes here'
        clip = self.write('dist/a.mp4', data)
        class ChangeAfterHeader(io.BytesIO):
            def write(buffer, block):
                if buffer.tell() == 0:
                    clip.write_bytes(data[:-1] + b'!')
                return super().write(block)
        with self.assertRaisesRegex(ValueError, 'changed after inspection'):
            storage.export_tree(self.workspace, output_stream=ChangeAfterHeader())

    def test_parent_link_substitution_after_manifest_cannot_read_another_directory(self):
        self.write('dist/clips/a.mp4', b'....ftypisom' + bytes(28))
        other = self.workspace.parent / 'other-output'
        other.mkdir()
        (other / 'a.mp4').write_bytes(b'....ftypisom' + b'private'.ljust(28))
        folder = self.workspace / 'dist' / 'clips'
        class SwapAfterHeader(io.BytesIO):
            def write(buffer, block):
                if buffer.tell() == 0:
                    folder.rename(folder.with_name('old'))
                    folder.symlink_to(other, target_is_directory=True)
                return super().write(block)
        out = SwapAfterHeader()
        with self.assertRaises(OSError):
            storage.export_tree(self.workspace, output_stream=out)
        self.assertNotIn(b'private', out.getvalue())

    def test_incomplete_media_upload_never_replaces_source_and_is_recoverable(self):
        old = self.write('main.js', b'original source')
        baseline = self.baseline()
        media = {'path': 'public/v.mp4', 'size': 90, 'sha256': 'c'*64}
        self.backend.media_input = io.BytesIO(b'partial transfer')
        self.backend.media_request = lambda paths: None
        with self.assertRaisesRegex(ValueError, 'ended early'):
            self.backend.sync(self.mount, [media], [], self.identity, baseline, self.operation)
        self.assertEqual(old.read_bytes(), b'original source')
        self.assertFalse((self.workspace / 'public/v.mp4').exists())
        self.assertEqual(self.backend.recover_sync(self.mount, self.operation), {'committed': False})

    def test_sync_preserves_all_nested_generated_trees_and_cache(self):
        self.write('index.js', b'old source')
        self.write('removed.txt', b'host removed this source')
        preserved = {name: self.write(name, data) for name, data in {
            'dist/unique.bin': b'\x00unique-build\xff',
            'games/demo/node_modules/pkg/edited.js': b'edited dependency',
            'games/demo/build/result.dat': b'unique nested output',
            'out/last-good.zip': b'unique artifact',
        }.items()}
        old = self.baseline()
        cache = self.mount / 'cache'
        cache.mkdir(); (cache / 'private-cache.dat').write_bytes(b'preserved cache')
        self.backend.sync(self.mount, [self.incoming('index.js', b'new source'), self.incoming('new.sh', b'echo fixture', True)], [], self.identity, old, self.operation)
        self.backend.finalize_sync(self.mount, self.operation)
        self.assertEqual((self.workspace / 'index.js').read_bytes(), b'new source')
        self.assertFalse((self.workspace / 'removed.txt').exists())
        for path in preserved.values():
            self.assertTrue(path.is_file())
        self.assertEqual((cache / 'private-cache.dat').read_bytes(), b'preserved cache')
        self.assertTrue((self.workspace / 'new.sh').stat().st_mode & 0o100)
        self.assertFalse((self.mount / ('sync-' + self.operation)).exists())

    def test_empty_first_source_assigns_the_workspace_identity(self):
        with mock.patch.object(storage.os, 'chown') as chown:
            self.backend.sync(self.mount, [], [], self.identity, {}, self.operation)
        chown.assert_any_call(self.workspace, self.identity['uid'], self.identity['gid'], follow_symlinks=False)
        self.backend.finalize_sync(self.mount, self.operation)
        self.assertEqual(storage.source_tree(self.workspace), [])

    def test_fresh_backend_rolls_back_a_crash_after_no_replace_link(self):
        old = self.write('index.js', b'old source')
        generated = self.write('dist/unique.bin', b'keep generated data')
        baseline = self.baseline()
        link = storage.os.link
        def crash_after_link(source, target):
            link(source, target)
            raise SystemExit('simulated process loss')
        with mock.patch.object(storage.os, 'link', side_effect=crash_after_link):
            with self.assertRaises(SystemExit):
                self.backend.sync(self.mount, [self.incoming('index.js', b'new source')], [], self.identity, baseline, self.operation)
        result = storage.Backend().recover_sync(self.mount, self.operation)
        self.assertFalse(result['committed'])
        self.assertEqual(old.read_bytes(), b'old source')
        self.assertEqual(generated.read_bytes(), b'keep generated data')
        self.assertFalse((self.mount / ('sync-' + self.operation)).exists())

    def test_fresh_backend_finishes_a_committed_transaction(self):
        self.write('index.js', b'old source')
        generated = self.write('dist/unique.bin', b'keep generated')
        self.backend.sync(self.mount, [self.incoming('index.js', b'new source')], [], self.identity, self.baseline(), self.operation)
        result = storage.Backend().recover_sync(self.mount, self.operation)
        self.assertTrue(result['committed'])
        self.assertEqual((self.workspace / 'index.js').read_bytes(), b'new source')
        self.assertEqual(generated.read_bytes(), b'keep generated')

    def test_crash_before_first_source_mutation_keeps_original(self):
        original = self.write('index.js', b'original')
        atomic = storage.lifecycle.atomic_json
        def crash(file, value):
            atomic(file, value)
            if value.get('phase') == 'publishing':
                raise SystemExit('simulated power loss')
        with mock.patch.object(storage.lifecycle, 'atomic_json', side_effect=crash):
            with self.assertRaises(SystemExit):
                self.backend.sync(self.mount, [self.incoming('index.js', b'new')], [], self.identity, self.baseline(), self.operation)
        storage.Backend().recover_sync(self.mount, self.operation)
        self.assertEqual(original.read_bytes(), b'original')

    def test_unknown_transaction_file_prevents_any_backup_cleanup(self):
        self.write('index.js', b'original')
        self.backend.sync(self.mount, [self.incoming('index.js', b'new')], [], self.identity, self.baseline(), self.operation)
        transaction = self.mount / ('sync-' + self.operation)
        unknown = transaction / 'after/unrecognised.txt'
        unknown.write_bytes(b'unknown data')
        with self.assertRaises(storage.lifecycle.LifecycleError):
            self.backend.finalize_sync(self.mount, self.operation)
        self.assertEqual((transaction / 'before/index.js').read_bytes(), b'original')
        self.assertEqual(unknown.read_bytes(), b'unknown data')

    def test_concurrent_unknown_source_is_not_replaced(self):
        unknown = self.write('new.js', b'keep unexpected source')
        with self.assertRaises(FileExistsError):
            self.backend.sync(self.mount, [self.incoming('new.js', b'requested')], [], self.identity, {}, self.operation)
        self.assertEqual(unknown.read_bytes(), b'keep unexpected source')

    def test_generated_destination_and_bad_hash_rejected_before_sync(self):
        with self.assertRaises(ValueError):
            self.backend.validate_files([self.incoming('games/demo/dist/result.txt', b'not source')])
        item = self.incoming('index.js', b'bytes'); item['sha256'] = '0' * 64
        with self.assertRaises(ValueError):
            self.backend.validate_files([item])

    def test_missing_or_linked_identity_ledger_never_creates_a_user(self):
        with mock.patch.object(storage, 'ROOT', self.mount / 'volumes'), mock.patch.object(storage, 'command') as command:
            with self.assertRaises(storage.lifecycle.LifecycleError):
                self.backend.allocate_identity(set())
            command.assert_not_called()
            outside = self.mount / 'outside.json'; outside.write_text('{}')
            (self.mount / 'identity-range-v2.json').symlink_to(outside)
            with self.assertRaises(storage.lifecycle.LifecycleError):
                self.backend.allocate_identity(set())
            command.assert_not_called()

    def test_identity_collision_consumes_reservation_without_reusing_number(self):
        retained = [uid for uid in range(5000, 5096) if uid != 5005]
        ledger = {'version': 2, 'range': [5000, 5095], 'approved': True,
                  'auditedChecks': ['owned-files', 'numeric-acls', 'ipc', 'accounts'],
                  'auditedFreeUids': [5005], 'claimedUids': retained, 'auditSha256': 'a' * 64}
        with mock.patch.object(storage, 'ROOT', self.mount / 'volumes'):
            storage.lifecycle.atomic_json(self.mount / 'identity-range-v2.json', ledger)
            with mock.patch.object(storage.pwd, 'getpwuid', return_value=types.SimpleNamespace(pw_uid=5005)), mock.patch.object(storage, 'command') as command:
                with self.assertRaises(storage.lifecycle.LifecycleError):
                    self.backend.allocate_identity(set())
                command.assert_not_called()
            self.assertEqual(json.loads((self.mount / 'identity-range-v2.json').read_text())['claimedUids'], retained + [5005])

    def test_partial_identity_audit_cannot_enable_account_creation(self):
        ledger = {'version': 2, 'range': [5000, 5095], 'approved': True,
                  'auditedChecks': ['owned-files', 'numeric-acls', 'ipc', 'accounts'],
                  'auditedFreeUids': [5005], 'claimedUids': [], 'auditSha256': 'a' * 64}
        with mock.patch.object(storage, 'ROOT', self.mount / 'volumes'), mock.patch.object(storage, 'command') as command:
            storage.lifecycle.atomic_json(self.mount / 'identity-range-v2.json', ledger)
            with self.assertRaises(storage.lifecycle.LifecycleError) as caught:
                self.backend.allocate_identity(set())
            self.assertEqual(caught.exception.code, 'IDENTITY_PROVISIONING_REQUIRED')
            command.assert_not_called()

    def test_fresh_store_recovers_after_successful_transaction_cleanup_before_registry_save(self):
        from test_lifecycle import FakeBackend, transfer

        class RealSyncBackend(FakeBackend, storage.Backend):
            sync = storage.Backend.sync
            snapshot = storage.Backend.snapshot
            finalize_sync = storage.Backend.finalize_sync
            recover_sync = storage.Backend.recover_sync

        for rollback, changed_source in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(rollback=rollback, changed_source=changed_source), tempfile.TemporaryDirectory(prefix='ohmygame-cleanup-crash-') as temporary:
                root = pathlib.Path(temporary).resolve() / 'volumes'
                backend = RealSyncBackend()
                clock = [1000]
                make = lambda: storage.lifecycle.Store(root, backend, volume_bytes=4096, total_bytes=65536,
                                                       reserve_bytes=0, now=lambda: clock[0])
                spec = {'namespace': 'manual', 'projectId': '5e849fb8-9236-4f0e-a58a-76cb223b8a74',
                        'operationId': '1' * 32, 'mode': 'shell', 'files': [transfer('index.js', 'old')], 'packages': []}
                first = make().prepare(spec)
                make().finish(first, True); make().release(first)
                workspace = root / ('manual-' + spec['projectId']) / 'root/workspace'
                (workspace / 'dist').mkdir()
                (workspace / 'dist/unique.bin').write_bytes(b'unique generated data')
                second = {**spec, 'operationId': '2' * 32, 'files': [transfer('index.js', 'new')]}
                if rollback:
                    atomic = storage.lifecycle.atomic_json
                    def crash_before_publication(file, value):
                        atomic(file, value)
                        if value.get('phase') == 'publishing':
                            raise SystemExit('process lost before source publication')
                    with mock.patch.object(storage.lifecycle, 'atomic_json', side_effect=crash_before_publication):
                        with self.assertRaises(SystemExit):
                            make().prepare(second)
                    recover = backend.recover_sync
                    def crash_after_rollback(mount, op_id):
                        recover(mount, op_id)
                        raise SystemExit('process lost after completed rollback')
                    clock[0] += 1001
                    generation = make().inventory('manual')['projects'][0]['generation']
                    request = {'namespace': 'manual', 'projectId': spec['projectId'], 'operationId': '3' * 32, 'generation': generation}
                    with mock.patch.object(backend, 'recover_sync', side_effect=crash_after_rollback):
                        with self.assertRaises(SystemExit):
                            make().recover(request)
                else:
                    finalize = backend.finalize_sync
                    def crash_after_finalize(mount, op_id):
                        finalize(mount, op_id)
                        raise SystemExit('process lost after completed finalization')
                    with mock.patch.object(backend, 'finalize_sync', side_effect=crash_after_finalize):
                        with self.assertRaises(SystemExit):
                            make().prepare(second)
                    clock[0] += 1001
                    generation = make().inventory('manual')['projects'][0]['generation']
                    request = {'namespace': 'manual', 'projectId': spec['projectId'], 'operationId': '3' * 32, 'generation': generation}
                if changed_source:
                    unexpected = workspace / 'unreturned.js'
                    unexpected.write_bytes(b'never discard unknown source')
                    with self.assertRaises(storage.lifecycle.LifecycleError) as caught:
                        make().recover(request)
                    self.assertEqual(caught.exception.code, 'RECOVERY_REQUIRED')
                    self.assertEqual(unexpected.read_bytes(), b'never discard unknown source')
                    self.assertEqual((workspace / 'dist/unique.bin').read_bytes(), b'unique generated data')
                    continue
                restored = make().recover(request)
                captured = make().capture(restored)
                self.assertEqual(base64.b64decode(captured['files'][0]['data']), b'old' if rollback else b'new')
                self.assertEqual((workspace / 'dist/unique.bin').read_bytes(), b'unique generated data')
                make().acknowledge({**restored, 'snapshotId': captured['snapshotId']})
                make().release(restored)

class RuntimeProfileContracts(unittest.TestCase):
    """Real source walkers/window transaction on temp files; only ext4/UID effects are replaced."""
    def setUp(self):
        from test_lifecycle import FakeBackend
        class ProfileBackend(storage.Backend):
            def __init__(self): self.fake = FakeBackend(); self.copies = 0; self.create_count = 0; self.fail_copy = False
            def available_bytes(self, parent): return self.fake.available_bytes(parent)
            def capacity_root_space(self, parent): return {'bytes': self.fake.free_bytes, 'inodes': 100000}
            def profile_free_space(self, mount): return {'bytes': 1 << 40, 'inodes': 100000, 'allocationUnit': 4096}
            def allocate_identity(self, used): return self.fake.allocate_identity(used)
            def assert_idle(self, record, folder): return self.fake.assert_idle(record, folder)
            def identity_readiness(self): pass
            def assert_capacity_lease(self): pass
            def assert_capacity_image_unmounted(self, image): pass
            def create(self, folder, size, identity): self.fake.create(folder, size, identity)
            def mount(self, folder): return self.fake.mount(folder)
            def unmount(self, folder): return self.fake.unmount(folder)
            def review_workspace(self, folder): return self.fake.review_workspace(folder)
            def mount_profile(self, folder, record): return self.profile_paths(folder, record)[1]
            def unmount_profile(self, folder, record): pass
            @contextmanager
            def review_profile_workspace(self, folder, record): yield self.profile_paths(folder, record)[1] / 'workspace'
            def inspect_capacity_image(self, folder, image, size):
                return {'imageSha256': storage.lifecycle.file_hash(image), 'geometry': {'bytes': size, 'inodes': 16384}}
            def create_profile(self, folder, record):
                self.create_count += 1; folder.mkdir(mode=0o700)
                for name in ('images', 'mounts'): (folder / name).mkdir(mode=0o700)
                storage.lifecycle.atomic_json(folder / 'owner.json', record['identity'])
                image = folder / 'images' / (record['volumeId'] + '.img')
                with image.open('xb') as stream: stream.truncate(storage.RUNTIME_PROFILE['volumeBytes'])
                image.chmod(0o600)
                mount = folder / 'mounts' / record['volumeId']; mount.mkdir(mode=0o700); (mount / 'workspace').mkdir(mode=0o700)
            def migrate_capacity_image(self, folder, source, target, source_bytes, source_sha, lease):
                import shutil
                lease(); self.copies += 1
                (folder / 'images').mkdir(mode=0o700); (folder / 'mounts').mkdir(mode=0o700)
                with target.open('xb') as stream:
                    stream.write(source.read_bytes()); stream.truncate(storage.RUNTIME_PROFILE['volumeBytes'])
                target.chmod(0o600)
                if self.fail_copy: raise OSError(errno.EIO, 'Synthetic interrupted native copy')
                mount = folder / 'mounts' / target.stem; mount.mkdir(mode=0o700)
                shutil.copytree(folder / 'root/workspace', mount / 'workspace')
                lease()
                return {'target': self.inspect_capacity_image(folder, target, storage.RUNTIME_PROFILE['volumeBytes'])}
        self.temp = tempfile.TemporaryDirectory(prefix='ohmygame-real-profile-contract-')
        self.root = pathlib.Path(self.temp.name).resolve() / 'volumes'; self.backend = ProfileBackend()
        self.project = '5e849fb8-9236-4f0e-a58a-76cb223b8a74'; self.scope = {'namespace': 'test', 'projectId': self.project}
        self.chown = mock.patch.object(storage.os, 'chown'); self.chown.start()
    def tearDown(self): self.chown.stop(); self.temp.cleanup()
    def store(self): return storage.lifecycle.Store(self.root, self.backend, reserve_bytes=0, now=lambda:getattr(self,'clock',storage.lifecycle.time.time()))
    def native_plan(self, profile_id=storage.PROFILE_ID):
        plan = self.store().plan_capacity({**self.scope, 'planId': str(__import__('uuid').uuid4()), 'capacityProfileVersion': storage.runtime_profile(profile_id)['version'], 'sourceProfileId': profile_id})
        approval = {**self.scope, 'planId': plan['planId'], 'authorizationId': __import__('uuid').uuid4().hex, 'source': plan['source'], 'target': plan['target'],
            'recoveryReservationBytes': storage.RUNTIME_PROFILE['recoveryBytes'], 'expiresAt': plan['expiresAt']}
        return plan, approval
    def native_authorize(self, profile_id=storage.PROFILE_ID):
        plan, approval = self.native_plan(profile_id)
        self.store().register_capacity_authorization(approval)
        return plan, approval
    def native_create(self, profile_id=storage.PROFILE_ID):
        plan, approval = self.native_authorize(profile_id)
        result = self.store().migrate_capacity({**self.scope, 'planId': plan['planId'], 'authorizationId': approval['authorizationId']})
        return plan, approval, result
    def begin(self, files, op='1', profile_id=storage.PROFILE_ID):
        manifest = storage.lifecycle.snapshot_source_manifest(files, profile_id)
        request = {**self.scope, 'operationId': op * 32, 'mode': 'build', 'files': files, 'packages': [], 'rasterReturnVersion': 2,
            'sourceManifestVersion': 2, 'sourceProfileId': profile_id, 'sourceManifest': manifest}
        return self.store().prepare_begin(request)
    def window_binding(self, prepared):
        return {key: prepared[key] for key in ('namespace', 'projectId', 'operationId', 'generation', 'leaseToken', 'captureVersion',
            'rasterReturnVersion', 'sourceManifestVersion', 'sourceProfileId', 'sourceBaseManifestId')}
    def test_v3_manifest_matches_typescript_and_keeps_v2_limits_immutable(self):
        profile = 'capacity-128-media64-v3'
        entries = [{'path':'public/intro.mp4','kind':'media','size':64*1024*1024,'sha256':'a'*64,'executable':False},
            {'path':'src/游戏.js','kind':'source','size':0,'sha256':'b'*64,'executable':False}]
        manifest = storage.lifecycle.source_manifest(entries, profile)
        self.assertEqual(manifest['manifestId'], 'f26394dbca9cbc4dd3d06497d8552f7527e78e8a93df930b496135ad0eff6121')
        self.assertEqual(storage.lifecycle.parse_source_manifest(manifest), manifest)
        self.assertEqual(manifest['limits']['mediaFileBytes'], 32*1024*1024)
        self.assertNotIn('largeMediaFileBytes', storage.RUNTIME_PROFILE)
        for extension in ('.MP4','.mov','.webm','.m4a','.mp3','.wav','.ogg','.glb'):
            row = {**entries[0], 'path':'public/asset'+extension}
            self.assertEqual(storage.lifecycle.source_manifest([row], profile)['files'][0]['size'], 64*1024*1024)
            with self.assertRaises(ValueError): storage.lifecycle.source_manifest([row], storage.PROFILE_ID)
        for extension in ('.png','.webp','.jpg','.avif','.gif','.bin'):
            with self.assertRaises(ValueError): storage.lifecycle.source_manifest([{**entries[0],'path':'public/asset'+extension}], profile)
        for changes in ({'largeMediaFileBytes':128*1024*1024},{'largeMediaFilePolicy':'anything'},{'version':2}):
            invalid = {**manifest, 'limits':{**manifest['limits'], **changes}}
            with self.assertRaises(ValueError): storage.lifecycle.parse_source_manifest(invalid)

    def test_v3_large_ftyp_fully_checks_major_and_compatible_image_brands(self):
        profile = 'capacity-128-media64-v3'; size = 64*1024*1024
        box = lambda major, compatible=b'': (16+len(compatible)).to_bytes(4,'big')+b'ftyp'+major+b'\0'*4+compatible
        for suffix in ('.mp4','.m4a','.mov'):
            self.assertTrue(storage.media_header('public/a'+suffix,box(b'isom',b'iso2mp41'),size,profile))
            for brand in (b'avif',b'avis',b'mif1',b'msf1',b'miaf',b'heic',b'heix',b'hevc',b'hevx',b'heim',b'heis',b'hevm',b'hevs',b'heif'):
                self.assertFalse(storage.media_header('public/a'+suffix,box(brand),size,profile))
                self.assertFalse(storage.media_header('public/a'+suffix,box(b'isom',brand),size,profile))
            for invalid in (box(b'isom',b'iso2')[:-1],b'\0'*4+b'ftypisom'+b'\0'*4,(512).to_bytes(4,'big')+b'ftypisom'+b'\0'*4):
                self.assertFalse(storage.media_header('public/a'+suffix,invalid,size,profile))
        self.assertTrue(storage.media_header('public/a.mp4',box(b'avif'),32*1024*1024,storage.PROFILE_ID))

    def test_v3_fresh_creation_and_exact_same_size_rejection_do_not_unmount_or_persist(self):
        for profile in (storage.PROFILE_ID, 'capacity-128-media64-v3'):
            with self.subTest(profile=profile):
                self.scope = {**self.scope, 'projectId':str(__import__('uuid').uuid4())}
                plan, _, result = self.native_create(profile)
                record = self.store()._read()['records'][storage.lifecycle.project_key(**{'namespace':self.scope['namespace'],'project':self.scope['projectId']})]
                self.assertEqual(record['volumeProfileVersion'], storage.runtime_profile(profile)['version'])
                self.assertEqual(result['sourceProfileId'], profile)
                self.assertTrue(self.store().inspect_capacity_plan({**self.scope,'planId':plan['planId']})['verified'])
                before = self.store().file.read_bytes()
                with mock.patch.object(self.backend, 'unmount_profile', side_effect=AssertionError('same-size planning must not unmount')):
                    for target in (storage.PROFILE_ID, 'capacity-128-media64-v3'):
                        with self.assertRaisesRegex(ValueError, 'same-size'):
                            self.store().plan_capacity({**self.scope,'planId':str(__import__('uuid').uuid4()),'capacityProfileVersion':storage.runtime_profile(target)['version'],'sourceProfileId':target})
                self.assertEqual(self.store().file.read_bytes(), before)
                overview = self.store().overview()
                self.assertTrue(any(row.get('volumeProfileVersion') == storage.runtime_profile(profile)['version'] and row.get('sourceProfileId') == profile for row in overview['projects']))

    def test_v3_cannot_rebind_old_volume_or_mismatch_profile_manifest(self):
        self.native_create()
        before = self.store().file.read_bytes()
        with self.assertRaises(ValueError): self.begin([], profile_id='capacity-128-media64-v3')
        self.assertEqual(self.store().file.read_bytes(), before)
        for version, profile in ((2,'capacity-128-media64-v3'),(3,storage.PROFILE_ID),(True,'capacity-128-media64-v3')):
            with self.assertRaises(ValueError): self.store().plan_capacity({**self.scope,'projectId':str(__import__('uuid').uuid4()),'planId':str(__import__('uuid').uuid4()),'capacityProfileVersion':version,'sourceProfileId':profile})
        self.assertEqual(self.store().file.read_bytes(), before)

        self.scope={**self.scope,'projectId':str(__import__('uuid').uuid4())};self.native_create('capacity-128-media64-v3')
        prepared=self.begin([],profile_id='capacity-128-media64-v3');original=self.store()._read();key=storage.lifecycle.project_key(self.scope['namespace'],self.scope['projectId'])
        for target,field,value in ((original['records'][key],'volumeProfileVersion',2),(original['records'][key],'sourceProfileId',storage.PROFILE_ID),
                (original['records'][key],'rasterReturnVersion',2.0),(original['operations'][prepared['operationId']],'sourceProfileId',storage.PROFILE_ID)):
            prior=target[field];target[field]=value;storage.lifecycle.atomic_json(self.store().file,original)
            with self.assertRaises(ValueError):self.store()._read()
            target[field]=prior
        storage.lifecycle.atomic_json(self.store().file,original)

    def test_v3_legacy_migration_preserves_original_and_pointer_uses_new_profile(self):
        legacy = self.store().prepare({**self.scope,'operationId':'1'*32,'mode':'build','files':[],'packages':[]})
        self.store().claim({**legacy,'mode':'build'}); self.store().finish(legacy,True); self.store().release(legacy)
        key = storage.lifecycle.project_key(self.scope['namespace'],self.scope['projectId']); old = self.root/key/'disk.img'
        original = old.read_bytes()
        plan, _, result = self.native_create('capacity-128-media64-v3')
        self.assertEqual(plan['kind'],'enlarge'); self.assertEqual(old.read_bytes(),original)
        self.assertTrue(result['originalRetained']); self.assertEqual(self.backend.copies,1)
        record = self.store()._read()['records'][key]
        self.assertEqual((record['volumeProfileVersion'],record['sourceProfileId']), (3,'capacity-128-media64-v3'))
        self.assertEqual(self.store()._volume_bytes(record),512*1024*1024)
        self.assertEqual(self.store().overview()['counts']['allocatedLogicalBytes'],768*1024*1024)

    def test_v3_two_64mib_seed_windows_capture_ack_and_build_copy_refs_are_bounded(self):
        profile = 'capacity-128-media64-v3'; self.native_create(profile)
        blob = media_bytes('.mp4',64*1024*1024)
        files = [{'path':path,'size':len(blob),'sha256':hashlib.sha256(blob).hexdigest()} for path in ('public/a.mp4','public/b.mp4')]
        prepared = self.begin(files, profile_id=profile); binding = self.window_binding(prepared)
        self.assertEqual([row['bytes'] for row in prepared['windows']],[64*1024*1024]*2)
        for window in prepared['windows']:
            spec = {**binding,'uploadVersion':1,'windowIndex':window['windowIndex'],'windowId':window['windowId']}
            needed=[];self.store().prepare_append(spec,io.BytesIO(blob),needed.append);self.assertEqual(needed,[window['paths']])
            needed=[];self.store().prepare_append(spec,io.BytesIO(),needed.append);self.assertEqual(needed,[[]])
        self.store().prepare_commit({**binding,'uploadVersion':1})
        self.store().claim({**binding,'mode':'build'});self.store().finish(binding,True)
        captured=self.store().capture_media({key:value for key,value in binding.items() if key!='rasterReturnVersion'})
        self.assertEqual(captured['sourceProfileId'],profile);self.assertEqual(captured['sourceDelta']['afterMediaBytes'],0)
        self.assertEqual(sum(row['size'] for row in captured['sourceManifest']['files']),128*1024*1024)
        self.store().acknowledge({**binding,'snapshotId':captured['snapshotId'],'sourceResultManifestId':captured['sourceResultManifestId']});self.store().release(binding)
        key=storage.lifecycle.project_key(self.scope['namespace'],self.scope['projectId']);record=self.store()._read()['records'][key];workspace=self.store()._workspace(key,record)
        import shutil
        (workspace/'dist').mkdir()
        for index,item in enumerate(files):shutil.copyfile(workspace/item['path'],workspace/'dist'/f'{index}.mp4')
        output=io.BytesIO();storage.export_tree(workspace,runtime_media=record['baseline'],output_stream=output,media_limit=128*1024*1024,profile_id=profile)
        header=json.loads(output.getvalue());self.assertEqual(sum(row['size'] for row in header['media']),128*1024*1024);self.assertNotIn('generatedMedia',header)
        again=self.begin(files,'2',profile);self.assertEqual(again['windowCount'],0)
        self.store().prepare_commit({**self.window_binding(again),'uploadVersion':1})

    def test_v3_unknown_large_media_and_modified_registered_media_never_gain_copy_permission(self):
        profile='capacity-128-media64-v3';workspace=pathlib.Path(self.temp.name).resolve()/'large-fixture';(workspace/'public').mkdir(parents=True)
        file=workspace/'public/a.mp4';blob=media_bytes('.mp4',33*1024*1024);file.write_bytes(blob)
        baseline={'public/a.mp4':{'size':len(blob),'sha256':hashlib.sha256(blob).hexdigest()}}
        self.assertEqual(len(storage.retained_source_tree(workspace,baseline,128*1024*1024,profile)['files']),1)
        with self.assertRaises(ValueError):storage.retained_source_tree(workspace,{},128*1024*1024,profile)
        with self.assertRaises(ValueError):storage.retained_source_tree(workspace,baseline,128*1024*1024,storage.PROFILE_ID)
        other=workspace/'public/b.mp4';other.write_bytes(blob[:-1]+b'B')
        baseline['public/b.mp4']={'size':len(blob),'sha256':hashlib.sha256(blob[:-1]+b'B').hexdigest()}
        __import__('shutil').copyfile(other,file)
        self.assertEqual(len(storage.retained_source_tree(workspace,baseline,128*1024*1024,profile)['files']),2)
        self.assertEqual(storage.inspect_source_tree(workspace,baseline,2,128*1024*1024,profile)['blockers'],0)
        with file.open('r+b') as stream:stream.seek(-1,2);stream.write(b'Z')
        with self.assertRaises(ValueError):storage.retained_source_tree(workspace,baseline,128*1024*1024,profile)
        inspected=storage.inspect_source_tree(workspace,baseline,2,128*1024*1024,profile)
        self.assertGreater(inspected['blockers'],0)
        (workspace/'dist').mkdir();__import__('shutil').copyfile(file,workspace/'dist/a.mp4')
        with self.assertRaises(ValueError):storage.export_tree(workspace,runtime_media=baseline,output_stream=io.BytesIO(),media_limit=128*1024*1024,profile_id=profile)

    def test_v3_64mib_truncated_window_is_unknown_and_never_reuploaded_or_run(self):
        profile='capacity-128-media64-v3';self.native_create(profile)
        declared={'path':'public/long.wav','size':64*1024*1024,'sha256':'a'*64}
        prepared=self.begin([declared],profile_id=profile);binding=self.window_binding(prepared);window=prepared['windows'][0]
        request={**binding,'uploadVersion':1,'windowIndex':window['windowIndex'],'windowId':window['windowId']}
        with self.assertRaisesRegex(ValueError,'ended early'):self.store().prepare_append(request,io.BytesIO(media_bytes('.wav',4096)),lambda _:None)
        before=self.store().file.read_bytes()
        for action in (lambda:self.store().prepare_append(request,io.BytesIO(),lambda _:None),lambda:self.store().prepare_commit({**binding,'uploadVersion':1}),lambda:self.store().claim({**binding,'mode':'build'})):
            with self.assertRaises(ValueError):action()
        self.assertEqual(self.store().file.read_bytes(),before)
        record=self.store()._read()['records'][storage.lifecycle.project_key(self.scope['namespace'],self.scope['projectId'])]
        self.assertTrue(record['dirty']);self.assertEqual(record['syncPending'],binding['operationId'])
        self.assertTrue(self.store()._read()['operations'][binding['operationId']]['uploadUncertain'])

    def test_v3_changed_verified_copies_still_share_single_64mib_return_window(self):
        profile='capacity-128-media64-v3'
        baseline={'path':'public/a.mp4','size':64*1024*1024,'sha256':'a'*64}
        record={'baseline':storage.lifecycle.source_map([baseline])}
        storage.lifecycle.retain_source_manifest(record,storage.lifecycle.snapshot_source_manifest([baseline],profile))
        # Even with identical SHA, each distinct path counts; use a 3x33 MiB in-budget cumulative set.
        baseline={**baseline,'size':33*1024*1024};record['baseline']=storage.lifecycle.source_map([baseline]);storage.lifecycle.retain_source_manifest(record,storage.lifecycle.snapshot_source_manifest([baseline],profile))
        added=[baseline,*[{**baseline,'path':f'public/copy{i}.mp4'} for i in range(2)]]
        with self.assertRaisesRegex(ValueError,'single bounded return window'):self.store()._manifest_snapshot(record,added)

    def test_v2_manifest_unicode_matches_typescript_and_forbids_descriptor_tampering(self):
        entries = [{'path': p, 'kind': k, 'size': n, 'sha256': sha * 64, 'executable': x} for p,k,n,sha,x in
            [('src/雪😀.js','source',0,'a',False),('public/é.png','media',7,'b',False),('src/\ue000.js','source',3,'c',True),('src/😀.js','source',5,'d',False)]]
        manifest = storage.lifecycle.source_manifest(entries, storage.PROFILE_ID)
        self.assertEqual(manifest['manifestId'], 'f94c63a612abf8c7aab29bd4de3e0e09a7a597c733f34f6bcd74c135806ee7c7')
        bad = json.loads(json.dumps(manifest)); bad['limits']['mediaBytes'] += 1
        with self.assertRaises(ValueError): storage.lifecycle.parse_source_manifest(bad)
    def test_native_create_is_explicit_and_durable_same_plan_and_authorization_are_exact(self):
        plan, approval, result = self.native_create()
        self.assertTrue(plan['source']['absent']); self.assertEqual(plan['source']['generation'], 0)
        self.assertIsNone(plan['source']['imageSha256']); self.assertFalse(result['originalRetained'])
        self.assertEqual(self.backend.create_count, 1)
        self.assertEqual(self.store().migrate_capacity({**self.scope, 'planId': plan['planId'], 'authorizationId': approval['authorizationId']}), result)
        inspected = self.store().inspect_capacity_plan({**self.scope, 'planId': plan['planId']})
        self.assertEqual(inspected['authorizationId'], approval['authorizationId']); self.assertEqual(inspected['phase'], 'committed')
        with self.assertRaises(ValueError): self.store().register_capacity_authorization({**approval, 'target': {**approval['target'], 'volumeId': 'b' * 32}})
        self.assertEqual(self.backend.create_count, 1)
    def test_two_bounded_windows_preserve_full_128mib_seed_capture4_ack_and_changed_wanted(self):
        self.native_create()
        blobs = {f'public/{i}.png': media_bytes('.png', 32 * 1024 * 1024)[:-1] + bytes([i]) for i in range(4)}
        files = [{'path': path, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for path,data in blobs.items()]
        prepared = self.begin(files); binding = self.window_binding(prepared)
        self.assertEqual(prepared['captureVersion'], 4); self.assertEqual(prepared['windowCount'], 2)
        self.assertEqual([window['bytes'] for window in prepared['windows']], [64 * 1024 * 1024, 64 * 1024 * 1024])
        with self.assertRaises(ValueError): self.store().claim({**binding, 'mode': 'build'})
        for window in prepared['windows']:
            spec = {**binding, 'uploadVersion': 1, 'windowIndex': window['windowIndex'], 'windowId': window['windowId']}
            requested = []; self.store().prepare_append(spec, io.BytesIO(b''.join(blobs[path] for path in window['paths'])), requested.append)
            self.assertEqual(requested, [window['paths']])
            requested = []; self.store().prepare_append(spec, io.BytesIO(), requested.append); self.assertEqual(requested, [[]])
        committed = self.store().prepare_commit({**binding, 'uploadVersion': 1}); self.assertTrue(committed['prepared'])
        self.store().claim({**binding, 'mode': 'build'}); self.store().finish(binding, True)
        captured = self.store().capture_media({key: value for key, value in binding.items() if key != 'rasterReturnVersion'})
        self.assertEqual(captured['returnedRasters'], []); self.assertEqual(captured['sourceDelta']['unchangedFiles'], 4)
        self.assertEqual(len(captured['sourceManifest']['files']), 4)
        self.store().acknowledge({**binding, 'snapshotId': captured['snapshotId'], 'sourceResultManifestId': captured['sourceResultManifestId']}); self.store().release(binding)
        # Vite-style copies may describe the complete approved 128 MiB library without returning 128 MiB payload.
        import shutil
        key=storage.lifecycle.project_key('test',self.project);record=self.store()._read()['records'][key];workspace=self.store()._workspace(key,record)
        (workspace/'dist').mkdir()
        for index,path in enumerate(blobs): shutil.copyfile(workspace/path,workspace/'dist'/f'{index}.png')
        output=io.BytesIO();storage.export_tree(workspace,runtime_media=record['baseline'],output_stream=output,media_limit=storage.RUNTIME_PROFILE['mediaBytes'])
        header=json.loads(output.getvalue());self.assertEqual(sum(row['size'] for row in header['media']),128*1024*1024);self.assertEqual(header.get('generatedMedia',[]),[])
        next_prepared = self.begin(files, '2'); self.assertEqual(next_prepared['windowCount'], 0)
        self.store().prepare_commit({**self.window_binding(next_prepared), 'uploadVersion': 1})
    def test_interrupted_window_retains_original_transaction_without_replay_or_run(self):
        self.native_create(); blob = media_bytes('.png', 4096)
        prepared = self.begin([{'path':'public/a.png','size':len(blob),'sha256':hashlib.sha256(blob).hexdigest()}]); binding=self.window_binding(prepared); window=prepared['windows'][0]
        spec={**binding,'uploadVersion':1,'windowIndex':0,'windowId':window['windowId']}
        with self.assertRaises(ValueError): self.store().prepare_append(spec, io.BytesIO(blob[:100]), lambda _:None)
        record = self.store()._read()['records'][storage.lifecycle.project_key('test',self.project)]
        self.assertTrue(record['dirty']); self.assertEqual(record['syncPending'], binding['operationId'])
        with self.assertRaises(ValueError): self.store().prepare_append(spec, io.BytesIO(blob), lambda _:self.fail('must not request another payload'))
        with self.assertRaises(ValueError): self.store().claim({**binding,'mode':'build'})
    def test_native_journal_save_failures_preserve_exact_phase_and_never_recopy_an_uncertain_image(self):
        base=self.root.parent
        for phase,after in (('started',False),('started',True),('committed',False),('committed',True)):
            with self.subTest(phase=phase,after=after):
                parent=base/(phase+str(after));parent.mkdir(mode=0o700)
                self.root=parent/'volumes';self.backend=self.backend.__class__()
                plan,approval=self.native_authorize();execute={**self.scope,'planId':plan['planId'],'authorizationId':approval['authorizationId']}
                atomic=storage.lifecycle.atomic_json
                def save(file,value):
                    state=value.get('capacityPlanStates',{}).get(plan['planId'],{})
                    if file==self.store().file and state.get('phase')==phase:
                        if after:atomic(file,value)
                        raise OSError(errno.EIO,'Synthetic native registry boundary failure')
                    return atomic(file,value)
                with mock.patch.object(storage.lifecycle,'atomic_json',save):
                    with self.assertRaises(ValueError) as raised:self.store().migrate_capacity(execute)
                self.assertTrue(raised.exception.changed)
                expected='committed' if phase=='committed' and after else ('authorized' if phase=='started' and not after else 'started')
                inspected=self.store().inspect_capacity_plan({**self.scope,'planId':plan['planId']})
                self.assertEqual(inspected['phase'],expected);self.assertEqual(inspected['verified'],expected=='committed')
                self.assertEqual(inspected['planId'],plan['planId']);self.assertEqual(inspected['authorizationId'],approval['authorizationId'])
                self.assertEqual(self.backend.create_count,int(phase=='committed'))
                self.assertEqual(len(self.backend.fake.allocations),int(phase=='committed'))
                if expected=='committed':
                    result=self.store().migrate_capacity(execute);self.assertEqual(result,inspected['result']);self.assertEqual(self.backend.create_count,1)
                else:
                    before=self.store().file.read_bytes()
                    with self.assertRaises(ValueError):self.store().plan_capacity({**self.scope,'planId':str(__import__('uuid').uuid4()),'capacityProfileVersion':2,'sourceProfileId':storage.PROFILE_ID})
                    if expected=='started':
                        with self.assertRaises(ValueError):self.store().migrate_capacity(execute)
                    self.assertEqual(self.store().file.read_bytes(),before)
    def test_identity_claim_side_effect_is_preceded_by_intent_and_unknown_orphan_keeps_all_reservations(self):
        plan,approval=self.native_authorize();allocate=self.backend.allocate_identity;calls=[];claim=self.root.parent/'synthetic-identity-claim'
        def claiming(used):
            calls.append(True)
            durable=json.loads(self.store().file.read_text())
            self.assertEqual(durable['capacityPlanStates'][plan['planId']]['phase'],'started')
            identity=allocate(used);claim.write_text(str(identity['uid']))
            raise OSError(errno.EIO,'Synthetic UID claim completed but identity allocation response was lost')
        self.backend.allocate_identity=claiming
        execute={**self.scope,'planId':plan['planId'],'authorizationId':approval['authorizationId']}
        with self.assertRaises(OSError) as raised:self.store().migrate_capacity(execute)
        self.assertTrue(raised.exception.changed);self.assertTrue(claim.exists());self.assertEqual(len(calls),1)
        data=self.store()._read();self.assertEqual(data['records'],{});self.assertEqual(self.store()._global_operations(data),1)
        self.assertEqual(len(self.store()._resident_reserved(data)),1)
        inspected=self.store().inspect_capacity_plan({**self.scope,'planId':plan['planId']});self.assertEqual(inspected['phase'],'unknown');self.assertFalse(inspected['verified'])
        before=self.store().file.read_bytes()
        for action in (lambda:self.store().migrate_capacity(execute),lambda:self.store().plan_capacity({**self.scope,'planId':str(__import__('uuid').uuid4()),'capacityProfileVersion':2,'sourceProfileId':storage.PROFILE_ID}),lambda:self.store().prepare({**self.scope,'operationId':'9'*32,'mode':'build','files':[],'packages':[]}),lambda:self.store().retire({**self.scope,'generation':1,'confirmation':'DELETE_PROJECT_VOLUME'})):
            with self.assertRaises(ValueError):action()
        self.assertEqual(len(calls),1);self.assertEqual(self.store().file.read_bytes(),before)
        overview=self.store().overview();self.assertEqual(overview['projects'],[]);self.assertFalse(overview['countsTrusted']);self.assertIsNone(overview['counts']['freeSlots'])
        self.assertEqual(overview['counts']['allocatedLogicalBytes'],512*1024*1024);self.assertEqual(overview['counts']['stagingLogicalBytes'],512*1024*1024);self.assertEqual(overview['counts']['residentReserved'],1)
        self.assertEqual(overview['capacityReservations'],[{**self.scope,'planId':plan['planId'],'targetVolumeId':plan['target']['volumeId'],'volumeBytes':512*1024*1024,'phase':'unknown','sourceAbsent':True}])
        other=self.store().plan_capacity({**self.scope,'projectId':str(__import__('uuid').uuid4()),'planId':str(__import__('uuid').uuid4()),'capacityProfileVersion':2,'sourceProfileId':storage.PROFILE_ID})
        self.assertEqual(other['budget']['logicalBeforeBytes'],512*1024*1024);self.assertEqual(other['budget']['residentBefore'],1)
    def test_initial_plan_rejects_a_legacy_allocation_before_registration_without_touching_its_volume(self):
        plan, approval = self.native_plan()
        binding = self.store().prepare({**self.scope, 'operationId': '7'*32, 'mode': 'build', 'files': [], 'packages': []})
        self.store().finish(binding, True); self.store().release(binding)
        before = self.store().file.read_bytes()
        with mock.patch.object(self.backend, 'unmount') as unmount, mock.patch.object(self.backend, 'snapshot') as snapshot, mock.patch.object(self.backend, 'create') as create, mock.patch.object(self.backend, 'create_profile') as create_profile:
            with self.assertRaises(storage.lifecycle.LifecycleError) as raised:
                self.store().register_capacity_authorization(approval)
            self.assertEqual(raised.exception.code, 'GENERATION_CHANGED')
            for action in (unmount, snapshot, create, create_profile): action.assert_not_called()
        self.assertEqual(self.store().file.read_bytes(), before)
        self.assertEqual(self.store().inspect_capacity_plan({**self.scope, 'planId': plan['planId']})['phase'], 'planned')
    def test_initial_execute_rejects_a_stale_legacy_writer_without_touching_its_volume(self):
        plan, approval = self.native_authorize()
        # Model an old writer that did not yet honor the new authorization exclusion.
        with mock.patch.object(storage.lifecycle.Store, '_capacity_owner_pending', return_value=False):
            binding = self.store().prepare({**self.scope, 'operationId': '7'*32, 'mode': 'build', 'files': [], 'packages': []})
        self.store().finish(binding, True); self.store().release(binding)
        before = self.store().file.read_bytes()
        with mock.patch.object(self.backend, 'unmount') as unmount, mock.patch.object(self.backend, 'snapshot') as snapshot, mock.patch.object(self.backend, 'create') as create, mock.patch.object(self.backend, 'create_profile') as create_profile:
            with self.assertRaises(storage.lifecycle.LifecycleError) as raised:
                self.store().migrate_capacity({**self.scope, 'planId': plan['planId'], 'authorizationId': approval['authorizationId']})
            self.assertEqual(raised.exception.code, 'GENERATION_CHANGED')
            for action in (unmount, snapshot, create, create_profile): action.assert_not_called()
        self.assertEqual(self.store().file.read_bytes(), before)
    def test_initial_authorization_excludes_prepare_and_second_approval_without_charging_an_image(self):
        plan, approval = self.native_plan(); _, competing = self.native_plan()
        self.store().register_capacity_authorization(approval)
        before = self.store().file.read_bytes()
        for action in (lambda: self.store().prepare({**self.scope, 'operationId': '8'*32, 'mode': 'build', 'files': [], 'packages': []}),
                lambda: self.store().register_capacity_authorization(competing)):
            with self.assertRaises(storage.lifecycle.LifecycleError) as raised: action()
            self.assertEqual(raised.exception.code, 'CAPACITY_MIGRATION_UNCERTAIN')
            self.assertEqual(self.store().file.read_bytes(), before)
        self.store().register_capacity_authorization(approval)
        data = self.store()._read()
        self.assertEqual(self.store()._global_operations(data), 0)
        self.assertEqual(self.store()._resident_reserved(data), [])
        self.assertEqual(self.store()._capacity_orphans(data), [])
        self.assertEqual(self.backend.fake.allocations, [])
        self.assertEqual(self.backend.create_count, 0)
        self.assertFalse(self.root.exists())
    def test_initial_authorization_expiry_allows_a_new_plan_without_replaying_or_rewriting_the_old_one(self):
        self.clock=1000;plan,approval=self.native_authorize();before=self.store().file.read_bytes();self.clock=2000
        inspected=self.store().inspect_capacity_plan({**self.scope,'planId':plan['planId']})
        self.assertEqual(inspected['phase'],'authorized');self.assertTrue(inspected['expired']);self.assertFalse(inspected['verified'])
        with self.assertRaises(ValueError):self.store().migrate_capacity({**self.scope,'planId':plan['planId'],'authorizationId':approval['authorizationId']})
        self.assertEqual(self.backend.create_count,0);self.assertFalse(self.root.exists());self.assertEqual(self.store().file.read_bytes(),before)
        next_plan, next_approval = self.native_authorize()
        self.assertNotEqual(next_plan['planId'], plan['planId'])
        self.assertEqual(self.store().inspect_capacity_plan({**self.scope, 'planId': plan['planId']}), inspected)
        with self.assertRaises(ValueError): self.store().migrate_capacity({**self.scope, 'planId': plan['planId'], 'authorizationId': approval['authorizationId']})
        self.assertEqual(self.backend.create_count, 0)
        self.assertEqual(self.store().inspect_capacity_plan({**self.scope, 'planId': next_plan['planId']})['authorizationId'], next_approval['authorizationId'])
    def test_cancelled_before_initial_execution_waits_for_approval_expiry_without_allocating(self):
        self.clock = 1000; plan, approval = self.native_plan()
        approval['expiresAt'] = self.clock + 20
        self.store().register_capacity_authorization(approval)
        before = self.store().file.read_bytes()
        # Cancellation sends no native execute; its approval must not authorize a legacy fallback.
        request = {**self.scope, 'operationId': '8'*32, 'mode': 'build', 'files': [], 'packages': []}
        with self.assertRaises(ValueError): self.store().prepare(request)
        self.assertEqual(self.store().file.read_bytes(), before)
        self.clock = 1021
        with self.assertRaises(ValueError): self.store().migrate_capacity({**self.scope, 'planId': plan['planId'], 'authorizationId': approval['authorizationId']})
        self.assertEqual(self.store().file.read_bytes(), before)
        binding = self.store().prepare(request)
        self.assertTrue(binding['prepared'])
        self.assertEqual(self.backend.create_count, 0)
        self.assertEqual(len(self.backend.fake.allocations), 1)
        self.assertEqual(self.store()._read()['capacityPlanStates'][plan['planId']]['phase'], 'authorized')
    def test_initial_execution_rechecks_space_before_identity_or_image_writes(self):
        plan, approval = self.native_authorize(); before = self.store().file.read_bytes()
        self.backend.fake.free_bytes = 100
        with self.assertRaises(storage.lifecycle.LifecycleError) as raised:
            self.store().migrate_capacity({**self.scope, 'planId': plan['planId'], 'authorizationId': approval['authorizationId']})
        self.assertEqual(raised.exception.code, 'GUEST_STORAGE_FULL')
        self.assertFalse(raised.exception.changed)
        self.assertEqual(self.store().file.read_bytes(), before)
        self.assertEqual(self.backend.fake.allocations, [])
        self.assertEqual(self.backend.create_count, 0)
        self.assertFalse(self.root.exists())
    def test_initial_lease_loss_after_creation_stays_unknown_after_expiry_without_replay(self):
        self.clock = 1000; plan, approval = self.native_authorize(); execute = {**self.scope, 'planId': plan['planId'], 'authorizationId': approval['authorizationId']}
        created = self.backend.create_profile
        def cancelled_after_write(folder, record):
            created(folder, record)
            self.backend.assert_capacity_lease = mock.Mock(side_effect=storage.lifecycle.LifecycleError('CAPACITY_LEASE_REQUIRED', 'Synthetic cancelled lease'))
        self.backend.create_profile = cancelled_after_write
        with self.assertRaises(storage.lifecycle.LifecycleError) as raised: self.store().migrate_capacity(execute)
        self.assertTrue(raised.exception.changed)
        inspected = self.store().inspect_capacity_plan({**self.scope, 'planId': plan['planId']})
        self.assertEqual(inspected['phase'], 'unknown'); self.assertFalse(inspected['verified'])
        self.clock = 2000; before = self.store().file.read_bytes()
        for action in (lambda: self.store().migrate_capacity(execute), lambda: self.native_plan(),
                lambda: self.store().prepare({**self.scope, 'operationId': '8'*32, 'mode': 'build', 'files': [], 'packages': []})):
            with self.assertRaises(ValueError): action()
            self.assertEqual(self.store().file.read_bytes(), before)
        self.assertEqual(self.backend.create_count, 1)
    def test_initial_started_intent_survives_controller_exit_and_expiry_without_replay(self):
        self.clock = 1000; plan, approval = self.native_authorize(); execute = {**self.scope, 'planId': plan['planId'], 'authorizationId': approval['authorizationId']}
        with mock.patch.object(self.backend, 'allocate_identity', side_effect=SystemExit('Synthetic controller exit')) as allocate:
            with self.assertRaises(SystemExit): self.store().migrate_capacity(execute)
            self.clock = 2000; before = self.store().file.read_bytes()
            inspected = self.store().inspect_capacity_plan({**self.scope, 'planId': plan['planId']})
            self.assertEqual(inspected['phase'], 'started'); self.assertTrue(inspected['expired']); self.assertFalse(inspected['verified'])
            for action in (lambda: self.store().migrate_capacity(execute), lambda: self.native_plan(),
                    lambda: self.store().prepare({**self.scope, 'operationId': '8'*32, 'mode': 'build', 'files': [], 'packages': []})):
                with self.assertRaises(ValueError): action()
                self.assertEqual(self.store().file.read_bytes(), before)
            allocate.assert_called_once()
        data = self.store()._read()
        self.assertEqual(self.backend.create_count, 0)
        self.assertEqual(self.store()._global_operations(data), 1)
        self.assertEqual(len(self.store()._resident_reserved(data)), 1)
    def test_expired_enlarge_authorization_keeps_its_original_exclusion(self):
        self.clock = 1000
        binding = self.store().prepare({**self.scope, 'operationId': '7'*32, 'mode': 'build', 'files': [], 'packages': []})
        self.store().finish(binding, True); self.store().release(binding)
        plan, approval = self.native_authorize()
        self.assertEqual(plan['kind'], 'enlarge')
        self.clock = 2000; before = self.store().file.read_bytes()
        with mock.patch.object(self.backend, 'unmount') as unmount, mock.patch.object(self.backend, 'snapshot') as snapshot:
            with self.assertRaises(ValueError): self.native_plan()
            with self.assertRaises(ValueError): self.store().migrate_capacity({**self.scope, 'planId': plan['planId'], 'authorizationId': approval['authorizationId']})
            unmount.assert_not_called(); snapshot.assert_not_called()
        self.assertEqual(self.store().file.read_bytes(), before)
    def test_window_cross_scope_rejections_preserve_the_original_registry_and_valid_upload(self):
        self.native_create();blob=media_bytes('.png',4096);prepared=self.begin([{'path':'public/a.png','size':len(blob),'sha256':hashlib.sha256(blob).hexdigest()}]);binding=self.window_binding(prepared);window=prepared['windows'][0]
        spec={**binding,'uploadVersion':1,'windowIndex':0,'windowId':window['windowId']};before=self.store().file.read_bytes()
        for change in ({'generation':binding['generation']+1},{'leaseToken':'c'*32},{'sourceProfileId':'capacity-128-v1'},{'windowId':'d'*32},{'rasterReturnVersion':True},{'captureVersion':4.0}):
            with self.subTest(change=change):
                with self.assertRaises(ValueError):self.store().prepare_append({**spec,**change},io.BytesIO(blob),lambda _:self.fail('rejected binding must not request bytes'))
                self.assertEqual(self.store().file.read_bytes(),before)
        self.store().prepare_append(spec,io.BytesIO(blob),lambda paths:self.assertEqual(paths,['public/a.png']))
        self.store().prepare_commit({**binding,'uploadVersion':1})
    def test_window_write_faults_classify_actual_volume_writes_and_retain_exact_pending(self):
        self.native_create();blob=media_bytes('.png',4096)
        for index,(fault,code) in enumerate(((errno.ENOSPC,'GUEST_VOLUME_FULL'),(errno.EDQUOT,'GUEST_QUOTA_EXCEEDED'),(errno.EIO,'GUEST_IO_UNKNOWN'))):
            with self.subTest(fault=fault):
                # A distinct project keeps every failed original transaction untouched.
                if index:
                    self.project=str(__import__('uuid').uuid4());self.scope={**self.scope,'projectId':self.project};self.native_create()
                prepared=self.begin([{'path':'public/a.png','size':len(blob),'sha256':hashlib.sha256(blob).hexdigest()}],str(index+1));binding=self.window_binding(prepared);window=prepared['windows'][0]
                spec={**binding,'uploadVersion':1,'windowIndex':0,'windowId':window['windowId']};original_open=pathlib.Path.open
                def opening(file,*args,**kwargs):
                    stream=original_open(file,*args,**kwargs)
                    return PartialVolumeWriter(stream,fault) if file.name=='upload' and args and args[0]=='xb' else stream
                with mock.patch.object(pathlib.Path,'open',opening):
                    with self.assertRaises(Exception) as raised:self.store().prepare_append(spec,io.BytesIO(blob),lambda _:None)
                self.assertEqual(raised.exception.code,code);self.assertTrue(raised.exception.changed)
                data=self.store()._read();record=data['records'][storage.lifecycle.project_key('test',self.project)]
                self.assertTrue(record['dirty']);self.assertEqual(record['syncPending'],binding['operationId']);self.assertEqual(record['sourceManifestSizes'],[])
                self.assertEqual(record['syncTargetManifestSizes'],[4096]);self.assertTrue(data['operations'][binding['operationId']]['uploadUncertain'])
                mount=self.store()._workspace(storage.lifecycle.project_key('test',self.project),record).parent
                self.assertEqual((mount/('sync-'+binding['operationId'])/'upload').read_bytes(),blob[:3])
                self.assertEqual(list((mount/'workspace').iterdir()),[])
                self.store().release(binding)
    def test_fresh_migration_verification_accepts_later_target_writes_but_rejects_target_inode_replacement(self):
        plan,approval,result=self.native_create();inspect={**self.scope,'planId':plan['planId']}
        self.assertTrue(self.store().inspect_capacity_plan(inspect)['verified'])
        key=storage.lifecycle.project_key('test',self.project);record=self.store()._read()['records'][key];image=self.store()._image_path(self.root/key,record)
        with image.open('r+b') as stream:stream.write(b'later valid filesystem metadata')
        self.assertTrue(self.store().inspect_capacity_plan(inspect)['verified'])
        previous=image.with_suffix('.previous');image.rename(previous)
        with image.open('xb') as stream:stream.truncate(storage.RUNTIME_PROFILE['volumeBytes'])
        image.chmod(0o600);previous.unlink()
        with self.assertRaises(ValueError):self.store().inspect_capacity_plan(inspect)
    def test_profile_retained_review_ack_and_clean_ack_loss_use_exact_recovery_origin(self):
        self.native_create(); prepared=self.begin([{'path':'main.js','data':base64.b64encode(b'x').decode(),'sha256':hashlib.sha256(b'x').hexdigest(),'executable':False}])
        binding=self.window_binding(prepared);self.store().prepare_commit({**binding,'uploadVersion':1});self.store().claim({**binding,'mode':'build'})
        record=self.store()._read()['records'][storage.lifecycle.project_key('test',self.project)]; workspace=self.store()._workspace(storage.lifecycle.project_key('test',self.project),record)
        (workspace/'public').mkdir(); blob=media_bytes('.png',700*1024); (workspace/'public/new.png').write_bytes(blob)
        self.assertTrue(self.store().finish(binding,True)['dirty'])
        captured=self.store().capture_media({k:v for k,v in binding.items() if k!='rasterReturnVersion'})
        self.assertEqual(captured['returnedRasters'][0]['size'],len(blob));self.assertFalse(any(row['path']=='public/new.png' for row in captured['files']))
        self.store().release(binding)
        review_request={**self.scope,'generation':binding['generation'],'reviewVersion':2,'sourceManifestVersion':2,'sourceProfileId':storage.PROFILE_ID,'sourceBaseManifestId':binding['sourceBaseManifestId']}
        reviewed=self.store().review_source_media(review_request)
        recovered=self.store().recover({**review_request,'operationId':'3'*32,'reviewSnapshotId':reviewed['snapshotId'],'sourceResultManifestId':reviewed['sourceResultManifestId']})
        self.assertEqual(recovered['captureVersion'],4)
        capture_request={k:v for k,v in recovered.items() if k not in ('identity','sourceDigest','rasterReturnVersion')};capture_request['reviewVersion']=2
        snapshot=self.store().capture(capture_request)
        self.store().acknowledge({**capture_request,'snapshotId':snapshot['snapshotId'],'sourceResultManifestId':snapshot['sourceResultManifestId']});self.store().release(recovered)
        after=self.store()._read();raw_registry=self.store().file.read_bytes()
        current=after['records'][storage.lifecycle.project_key('test',self.project)]
        fresh=self.store().review_source_media({**review_request,'sourceBaseManifestId':current['sourceManifestId']})
        self.assertEqual(fresh['retainedRasters'],[]);self.assertEqual(fresh['sourceDelta']['afterBytes'],0)
        exact=[row for row in fresh['originOperations'] if row['operationId']=='3'*32]
        self.assertEqual(len(exact),1);self.assertTrue(exact[0]['acknowledged']);self.assertEqual(exact[0]['phase'],'released')
        self.assertEqual(self.store().file.read_bytes(),raw_registry)
    def test_successful_enlarge_preserves_original_hash_pointer_and_new_manifest(self):
        initial={**self.scope,'operationId':'1'*32,'mode':'build','files':[{'path':'main.js','data':base64.b64encode(b'old').decode(),'sha256':hashlib.sha256(b'old').hexdigest(),'executable':False}],'packages':[]}
        binding=self.store().prepare(initial);self.store().finish(binding,True);self.store().release(binding)
        request={**self.scope,'planId':str(__import__('uuid').uuid4()),'capacityProfileVersion':2,'sourceProfileId':storage.PROFILE_ID}
        plan=self.store().plan_capacity(request);self.assertEqual(self.store().plan_capacity(request),plan)
        key=storage.lifecycle.project_key('test',self.project);old=self.root/key/'disk.img';old_hash=storage.lifecycle.file_hash(old)
        approval={**self.scope,'planId':plan['planId'],'authorizationId':'b'*32,'source':plan['source'],'target':plan['target'],'recoveryReservationBytes':storage.RUNTIME_PROFILE['recoveryBytes'],'expiresAt':plan['expiresAt']}
        self.store().register_capacity_authorization(approval);result=self.store().migrate_capacity({**self.scope,'planId':plan['planId'],'authorizationId':'b'*32})
        self.assertTrue(result['originalRetained']);self.assertEqual(storage.lifecycle.file_hash(old),old_hash)
        record=self.store()._read()['records'][key];self.assertEqual(record['sourceManifestVersion'],2);self.assertEqual(record['generation'],binding['generation']+1)
        self.assertEqual(self.store()._workspace(key,record).joinpath('main.js').read_bytes(),b'old')
        self.assertEqual(sum(size for _,size in self.store()._volume_images(key,record)),768*1024*1024)
        self.assertTrue(self.store().inspect_capacity_plan({**self.scope,'planId':plan['planId']})['verified'])
        overview=self.store().overview();self.assertEqual(overview['counts']['allocatedLogicalBytes'],768*1024*1024);self.assertEqual(overview['counts']['residentReserved'],1)
        self.assertEqual(overview['projects'][0]['volumeBytes'],512*1024*1024);self.assertEqual(overview['projects'][0]['retainedVolumeBytes'],256*1024*1024)
        with self.assertRaises(ValueError):self.store().prepare({**initial,'operationId':'4'*32})
    def test_capacity_planning_counts_old_and_target_and_known_free_inodes_without_mutation(self):
        request={**self.scope,'planId':str(__import__('uuid').uuid4()),'capacityProfileVersion':2,'sourceProfileId':storage.PROFILE_ID}
        self.backend.fake.free_bytes=100
        plan=self.store().plan_capacity(request);self.assertEqual(plan['status'],'blocked');self.assertIn('GUEST_STORAGE_FULL',plan['blockers'])
        self.assertEqual(self.backend.create_count,0);self.assertFalse(self.root.exists())
        with self.assertRaises(ValueError): self.store().register_capacity_authorization({**self.scope,'planId':plan['planId'],'authorizationId':'a'*32,'source':plan['source'],'target':plan['target'],'recoveryReservationBytes':storage.RUNTIME_PROFILE['recoveryBytes'],'expiresAt':plan['expiresAt']})
    def test_profile_migration_retains_legacy_image_and_unknown_copy_cannot_get_new_plan(self):
        initial={**self.scope,'operationId':'1'*32,'mode':'build','files':[{'path':'main.js','data':base64.b64encode(b'old').decode(),'sha256':hashlib.sha256(b'old').hexdigest(),'executable':False}],'packages':[]}
        binding=self.store().prepare(initial); self.store().finish(binding,True); self.store().release(binding)
        plan=self.store().plan_capacity({**self.scope,'planId':str(__import__('uuid').uuid4()),'capacityProfileVersion':2,'sourceProfileId':storage.PROFILE_ID})
        old_image=self.root/storage.lifecycle.project_key('test',self.project)/'disk.img'; old_hash=storage.lifecycle.file_hash(old_image)
        approval={**self.scope,'planId':plan['planId'],'authorizationId':'b'*32,'source':plan['source'],'target':plan['target'],'recoveryReservationBytes':storage.RUNTIME_PROFILE['recoveryBytes'],'expiresAt':plan['expiresAt']}
        self.store().register_capacity_authorization(approval); self.backend.fail_copy=True
        execute={**self.scope,'planId':plan['planId'],'authorizationId':approval['authorizationId']}
        with self.assertRaises(OSError):self.store().migrate_capacity(execute)
        self.assertEqual(storage.lifecycle.file_hash(old_image),old_hash); self.assertEqual(self.backend.copies,1)
        with self.assertRaises(ValueError):self.store().migrate_capacity(execute)
        with self.assertRaises(ValueError):self.store().plan_capacity({**self.scope,'planId':str(__import__('uuid').uuid4()),'capacityProfileVersion':2,'sourceProfileId':storage.PROFILE_ID})
        inspected=self.store().inspect_capacity_plan({**self.scope,'planId':plan['planId']});self.assertEqual(inspected['phase'],'unknown');self.assertFalse(inspected['verified'])
        overview=self.store().overview();self.assertFalse(overview['countsTrusted']);self.assertEqual(overview['counts']['residentReserved'],2);self.assertEqual(overview['counts']['stagingLogicalBytes'],512*1024*1024)

if __name__ == '__main__':
    unittest.main()
