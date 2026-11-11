"""Host-safe boundary tests. Real ext4 validation is a separate owned VM fixture."""
import hashlib
import os
import pathlib
import tempfile
import types
import unittest
import uuid
from unittest import mock
import guest_volume_migration as migration


GEOMETRY = '''Filesystem UUID: 11111111-2222-4333-8444-555555555555
Filesystem features: has_journal extent 64bit metadata_csum
Filesystem state: clean
Inode count: 8192
Block count: 65536
Free blocks: 60000
Free inodes: 8100
Block size: 4096
'''


class FakeBackend(migration.Ext4MigrationBackend):
    """Only the copy/path/lease mechanics are real here; ext4 responses are synthetic."""
    def inspect(self, image, expected_bytes, expected_sha256=None):
        image = self._path(image)
        data = image.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if expected_sha256 is not None and digest != expected_sha256:
            migration.refuse('Fixture hash differs')
        return {'imageSha256': digest, 'geometry': {'uuid': 'same', 'blocks': expected_bytes,
                'inodes': 8}, 'treeHash': 'same-tree', 'ownershipHash': 'same-owner'}

    def _geometry(self, image):
        return {}

    def _run(self, key, args, **options):
        if key != 'resize':
            raise AssertionError('Unexpected real tool request')
        return ''


class GeometryTests(unittest.TestCase):
    def test_complete_geometry_uses_real_block_counts(self):
        result = migration.parse_geometry(GEOMETRY)
        self.assertEqual(result['bytes'], 256 * migration.MiB)
        self.assertEqual(result['inodes'], 8192)
        self.assertEqual(result['freeBytes'], 60000 * 4096)

    def test_missing_duplicate_dirty_and_invalid_geometry_fail_closed(self):
        for value in [GEOMETRY.replace('Free inodes: 8100\n', ''), GEOMETRY + 'Block size: 4096\n',
                      GEOMETRY.replace('state: clean', 'state: not clean'),
                      GEOMETRY.replace('size: 4096', 'size: 8192'), GEOMETRY.replace('blocks: 60000', 'blocks: 70000')]:
            with self.subTest(value=value), self.assertRaises(migration.Ext4MigrationError):
                migration.parse_geometry(value)


class PrimitiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ohmygame-ext4-unit-')
        self.root = pathlib.Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        (self.root / 'images').mkdir(mode=0o700)
        self.source = self.root / 'disk.img'
        self.source.write_bytes(b'data')
        self.source.chmod(0o600)
        self.target = self.root / 'images' / (str(uuid.uuid4()) + '.img')
        self.sha = hashlib.sha256(b'data').hexdigest()
        self.sizes = mock.patch.object(migration, 'ALLOWED_SIZES', (4, 8))
        self.sizes.start()
        self.backend = FakeBackend(self.root, lambda: None)

    def tearDown(self):
        self.sizes.stop()
        self.temp.cleanup()

    def test_copy_retains_original_and_never_claims_a_registry_switch(self):
        result = self.backend.copy_resize_verify(self.source, self.target, 4, 8, self.sha, 8)
        self.assertEqual(self.source.read_bytes(), b'data')
        self.assertEqual(self.target.read_bytes(), b'data\0\0\0\0')
        self.assertTrue(result['originalRetained'])
        self.assertFalse(result['registryChanged'])
        self.assertEqual(result['interruptedCopyContinuation'], 'unsupported')

    def test_existing_target_is_not_replayed_or_overwritten(self):
        self.target.write_bytes(b'keep')
        with self.assertRaises(migration.Ext4MigrationError):
            self.backend.copy_resize_verify(self.source, self.target, 4, 8, self.sha)
        self.assertEqual(self.target.read_bytes(), b'keep')

    def test_existing_loop_attachment_is_immediately_refused_at_entry(self):
        backing = mock.Mock()
        backing.read_text.return_value = str(self.source)
        with mock.patch.object(pathlib.Path, 'glob', return_value=[backing]), mock.patch.object(migration.time, 'sleep') as pause:
            with self.assertRaises(migration.Ext4MigrationError) as failure:
                self.backend._unattached(self.source)
        self.assertEqual(failure.exception.code, 'EXT4_IMAGE_BUSY')
        pause.assert_not_called()

    def test_owned_successful_unmount_waits_for_confirmed_lazy_detach(self):
        backing = mock.Mock()
        backing.read_text.side_effect = [str(self.source), FileNotFoundError()]
        with mock.patch.object(pathlib.Path, 'glob', return_value=[backing]), mock.patch.object(migration.time, 'sleep') as pause:
            self.backend._unattached(self.source, after_unmount=True)
        pause.assert_called_once_with(0.02)
        self.assertEqual(backing.read_text.call_count, 2)

    def test_owned_unmount_timeout_preserves_busy_state(self):
        backing = mock.Mock()
        backing.read_text.return_value = str(self.source)
        with mock.patch.object(pathlib.Path, 'glob', return_value=[backing]), \
                mock.patch.object(migration.time, 'monotonic', side_effect=[0, 1, 3]), \
                mock.patch.object(migration.time, 'sleep') as pause:
            with self.assertRaises(migration.Ext4MigrationError) as failure:
                self.backend._unattached(self.source, after_unmount=True)
        self.assertEqual(failure.exception.code, 'EXT4_IMAGE_BUSY')
        pause.assert_called_once_with(0.02)
        self.assertEqual(self.source.read_bytes(), b'data')
        self.assertFalse(self.target.exists())

    def test_loop_metadata_read_failure_does_not_claim_detachment(self):
        backing = mock.Mock()
        backing.read_text.side_effect = PermissionError('Synthetic sysfs observation denied')
        with mock.patch.object(pathlib.Path, 'glob', return_value=[backing]), self.assertRaises(PermissionError):
            self.backend._unattached(self.source, after_unmount=True)

    def test_exact_operation_style_image_id_without_general_path_relaxation(self):
        target = self.root / 'images' / ('a' * 32 + '.img')
        self.backend.copy_resize_verify(self.source, target, 4, 8, self.sha)
        self.assertEqual(target.read_bytes(), b'data\0\0\0\0')
        for name in ['a' * 31, 'a' * 33, 'A' * 32, 'a' * 31 + '_']:
            with self.subTest(name=name), self.assertRaises(migration.Ext4MigrationError):
                self.backend._path(self.root / 'images' / (name + '.img'), target=True)

    def test_path_shapes_links_and_public_directories_are_refused(self):
        for target in [self.root / 'disk.img', self.root / 'outside.img', self.root / 'images' / 'not-a-uuid.img']:
            with self.subTest(target=target), self.assertRaises(migration.Ext4MigrationError):
                self.backend._path(target, target=True)
        self.source.unlink()
        self.source.symlink_to(self.root / 'images')
        with self.assertRaises(OSError):
            self.backend._identity(self.source, 4)
        self.root.chmod(0o755)
        with self.assertRaises(migration.Ext4MigrationError):
            migration.Ext4MigrationBackend(self.root, lambda: None)

    def test_lease_failure_before_write_creates_no_target(self):
        def stop():
            raise RuntimeError('Synthetic lease lost')
        backend = FakeBackend(self.root, stop)
        with self.assertRaises(RuntimeError):
            backend.copy_resize_verify(self.source, self.target, 4, 8, self.sha)
        self.assertFalse(self.target.exists())

    def test_interruption_retains_completed_prefix_without_auto_rollback(self):
        calls = 0
        def cancel():
            nonlocal calls
            calls += 1
            if calls == 3:
                raise RuntimeError('Synthetic interruption after copy')
        backend = FakeBackend(self.root, lambda: None, cancel)
        with self.assertRaises(RuntimeError):
            backend.copy_resize_verify(self.source, self.target, 4, 8, self.sha)
        self.assertEqual(self.source.read_bytes(), b'data')
        self.assertEqual(self.target.read_bytes(), b'data')
        with self.assertRaises(migration.Ext4MigrationError):
            backend.copy_resize_verify(self.source, self.target, 4, 8, self.sha)

    def test_space_and_target_inode_failures_do_not_erase_originals(self):
        with mock.patch.object(migration.os, 'statvfs', return_value=types.SimpleNamespace(f_bavail=0, f_frsize=4096, f_favail=100)):
            with self.assertRaises(migration.Ext4MigrationError):
                self.backend.copy_resize_verify(self.source, self.target, 4, 8, self.sha)
        self.assertFalse(self.target.exists())
        with self.assertRaises(migration.Ext4MigrationError):
            self.backend.copy_resize_verify(self.source, self.target, 4, 8, self.sha, 16)
        self.assertTrue(self.target.exists())
        self.assertEqual(self.source.read_bytes(), b'data')

    def test_tree_hash_preserves_links_without_reading_their_target(self):
        # macOS's bundled Python omits Linux xattr APIs; real Linux validation
        # exercises them. The host-only test isolates no-follow/link semantics.
        patch = mock.patch.object(migration.os, 'listxattr', return_value=[], create=True)
        patch.start()
        self.addCleanup(patch.stop)
        tree = self.root / 'tree'
        tree.mkdir()
        (tree / 'ordinary').write_bytes(b'content')
        os.link(tree / 'ordinary', tree / 'alias')
        outside = self.root / 'outside'
        outside.write_bytes(b'first')
        (tree / 'symbolic').symlink_to('../outside')
        first = self.backend._tree(tree)
        outside.write_bytes(b'changed external bytes')
        second = self.backend._tree(tree)
        self.assertEqual(first['treeHash'], second['treeHash'])
        self.assertEqual(first['treeEntries'], 4)
        os.unlink(tree / 'alias')
        (tree / 'alias').write_bytes(b'content')
        third = self.backend._tree(tree)
        self.assertNotEqual(first['treeHash'], third['treeHash'])


if __name__ == '__main__':
    unittest.main()
