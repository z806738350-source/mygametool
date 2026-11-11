"""Lifecycle contracts using ordinary temporary files only: never a VM or privileged backend."""
import base64
import contextlib
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import stat
import tempfile
import unittest
import uuid
from unittest import mock


spec = importlib.util.spec_from_file_location(
    'guest_lifecycle_contract_test', pathlib.Path(__file__).with_name('guest_lifecycle.py'))
lifecycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifecycle)

STAGING_BYTES = 16 * 1024 * 1024
GENERATED = {'node_modules', 'dist', 'build', 'out'}


def transfer(name, contents, executable=False):
    if isinstance(contents, str):
        contents = contents.encode()
    return {'path': name, 'data': base64.b64encode(contents).decode(),
            'sha256': hashlib.sha256(contents).hexdigest(), 'executable': executable}


def complete_bytes(folder):
    """Compare image, source, dependencies, generated output and cache without interpreting them."""
    result = {}
    for file in sorted(folder.rglob('*')):
        info = file.lstat()
        relative = str(file.relative_to(folder))
        if stat.S_ISLNK(info.st_mode):
            result[relative] = ('link', os.readlink(file))
        elif stat.S_ISREG(info.st_mode):
            result[relative] = ('file', file.read_bytes(), stat.S_IMODE(info.st_mode))
        elif stat.S_ISDIR(info.st_mode):
            result[relative] = ('directory', stat.S_IMODE(info.st_mode))
    return result


class FakeBackend:
    """All root-only effects are replaced, including disk capacity and identity allocation."""
    def __init__(self):
        self.free_bytes = 1 << 40
        self.busy = set()
        self.allocations = []
        self.created = []
        self.mounted = []
        self.unmounted = []
        self.recovered_syncs = []
        self.finalized_syncs = []
        self.deleted = []
        self.reviewed = []

    def validate_files(self, files):
        if not isinstance(files, list):
            raise lifecycle.LifecycleError('INVALID_REQUEST', 'File list required')
        seen = set()
        for value in files:
            parts = pathlib.PurePosixPath(value['path']).parts
            if (not parts or value['path'].startswith('/') or '..' in parts
                    or any(part.startswith('.') for part in parts) or value['path'] in seen):
                raise lifecycle.LifecycleError('INVALID_REQUEST', 'Unsafe fixture source path')
            seen.add(value['path'])
            contents = base64.b64decode(value['data'], validate=True)
            if hashlib.sha256(contents).hexdigest() != value['sha256']:
                raise lifecycle.LifecycleError('INVALID_REQUEST', 'Invalid fixture source digest')
        return [dict(value) for value in files]

    def validate_packages(self, packages):
        if packages != []:
            raise AssertionError('These lifecycle tests never install packages')
        return []

    def available_bytes(self, _parent):
        return self.free_bytes

    def allocate_identity(self, used):
        self.allocations.append(set(used))
        for uid in range(5000, 5096):
            if uid not in used:
                return {'uid': uid, 'gid': uid, 'name': 'omgjob' + str(uid)}
        raise lifecycle.LifecycleError('CAPACITY', 'No unused fixture identities')

    def create(self, folder, size, identity):
        folder.mkdir(mode=0o700)
        image = folder / 'disk.img'
        marker = (folder.name + ':' + str(identity['uid'])).encode()
        with image.open('xb') as stream:
            stream.write(marker)
            stream.truncate(size)
            stream.seek(size - 16)
            stream.write(hashlib.sha256(marker).digest()[:16])
        image.chmod(0o600)
        (folder / 'root').mkdir(mode=0o700)
        owner = folder / 'owner.json'
        owner.write_text(json.dumps(identity))
        owner.chmod(0o600)
        self.created.append(folder.name)

    def mount(self, folder):
        self.mounted.append(folder.name)
        if not (folder / 'disk.img').is_file():
            raise lifecycle.LifecycleError('RECOVERY_REQUIRED', 'Fixture disk is missing')
        return folder / 'root'

    def unmount(self, folder):
        self.unmounted.append(folder.name)

    @contextlib.contextmanager
    def review_workspace(self, folder):
        self.reviewed.append(folder.name)
        yield folder / 'root/workspace'

    def assert_idle(self, record, _folder):
        if lifecycle.project_key(record['namespace'], record['projectId']) in self.busy:
            raise lifecycle.LifecycleError('ACTIVE_OPERATION', 'Fixture task is still active')

    def snapshot(self, workspace):
        files = []
        if not workspace.exists():
            return files

        for base, directories, names in os.walk(workspace, followlinks=False):
            directories[:] = [name for name in sorted(directories)
                              if name not in GENERATED and not name.startswith('.')]
            for name in directories + sorted(names):
                candidate = pathlib.Path(base) / name
                value = candidate.lstat()
                if stat.S_ISLNK(value.st_mode) or (stat.S_ISREG(value.st_mode) and value.st_nlink != 1):
                    raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Linked fixture source')
            for name in sorted(names):
                if name.startswith('.'):
                    continue
                candidate = pathlib.Path(base) / name
                info = candidate.lstat()
                if not stat.S_ISREG(info.st_mode):
                    raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Non-file fixture source')
                files.append(transfer(str(candidate.relative_to(workspace)), candidate.read_bytes(),
                                      bool(info.st_mode & 0o111)))
        return sorted(files, key=lambda value: value['path'])

    def snapshot_rasters(self, workspace, _baseline):
        return self.snapshot(workspace)

    def review_snapshot(self, workspace, _baseline):
        return {'files': self.snapshot(workspace), 'retainedRasters': []}

    def stream_review(self, _workspace, snapshot, output):
        output.write(json.dumps(snapshot).encode() + b'\n')

    def stream_capture(self, _workspace, snapshot, output):
        output.write(json.dumps(snapshot).encode() + b'\n')

    def inspect_source(self, workspace, _baseline):
        return {'complete': True, 'changes': [], 'excluded': 0, 'blockers': 0}

    def inspect_source_rasters(self, workspace, baseline):
        return self.inspect_source(workspace, baseline)

    def inspect_source_media(self, workspace, baseline):
        return self.inspect_source(workspace, baseline)

    def sync(self, mount, files, packages, _identity, baseline, _operation_id):
        if packages:
            raise AssertionError('Package installation is outside these tests')
        workspace = mount / 'workspace'
        workspace.mkdir(mode=0o700, exist_ok=True)
        wanted = {value['path'] for value in files}
        for name in baseline:
            if name not in wanted:
                (workspace / name).unlink()
        for value in files:
            target = workspace / value['path']
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(value['data']))
            target.chmod(0o755 if value.get('executable') else 0o644)

    def finalize_sync(self, mount, operation_id):
        self.finalized_syncs.append((mount, operation_id))

    def recover_sync(self, mount, operation_id):
        self.recovered_syncs.append((mount, operation_id))

    def deletion_plan(self, folder):
        entries = []
        for file in [folder, *folder.rglob('*')]:
            info = file.lstat()
            if stat.S_ISLNK(info.st_mode) or (stat.S_ISREG(info.st_mode) and info.st_nlink != 1):
                raise lifecycle.LifecycleError('UNSAFE_STORAGE', 'Linked deletion fixture')
            entries.append({'path': str(file.relative_to(folder)), 'directory': stat.S_ISDIR(info.st_mode),
                            'dev': info.st_dev, 'ino': info.st_ino})
        return entries

    def delete_exact(self, folder, entries):
        for entry in entries:
            info = (folder / entry['path']).lstat()
            if (info.st_dev, info.st_ino) != (entry['dev'], entry['ino']):
                raise lifecycle.LifecycleError('STORAGE_CHANGED', 'Fixture deletion entry changed')
        for entry in sorted(entries, key=lambda value: len(pathlib.Path(value['path']).parts), reverse=True):
            file = folder / entry['path']
            file.rmdir() if entry['directory'] else file.unlink()
        self.deleted.append(folder.name)


class SimulatedCrash(RuntimeError):
    pass


class SourceManifestContracts(unittest.TestCase):
    def test_ascii_codepoint_canonical_ids_and_real_changed_byte_summary_match_typescript(self):
        entries = [
            {'path': 'src/雪😀.js', 'kind': 'source', 'size': 0, 'sha256': 'a' * 64, 'executable': False},
            {'path': 'public/é.png', 'kind': 'media', 'size': 7, 'sha256': 'b' * 64, 'executable': False},
            {'path': 'src/\uE000.js', 'kind': 'source', 'size': 3, 'sha256': 'c' * 64, 'executable': True},
            {'path': 'src/😀.js', 'kind': 'source', 'size': 5, 'sha256': 'd' * 64, 'executable': False}]
        before = lifecycle.source_manifest(entries)
        self.assertEqual(before['manifestId'], 'd853f7b0eebe50837f1f8cc6a1ae6269f6e8000b481edfba8d7447f5607ac404')
        self.assertEqual([item['path'] for item in before['files']], ['public/é.png', 'src/雪😀.js', 'src/\uE000.js', 'src/😀.js'])
        changed = [entries[0], {**entries[1], 'size': 1, 'sha256': 'e' * 64}, {**entries[2], 'executable': False}, {**entries[3], 'path': 'src/copy.js'}]
        after = lifecycle.source_manifest(changed)
        self.assertEqual(after['manifestId'], 'd02fa4bc695f72e1a1cfdd7ac409370f7dd4b4365680cc6794ae11c5281b15bd')
        self.assertEqual(lifecycle.source_delta(before, after), {'version': 1,
            'beforeManifestId': before['manifestId'], 'afterManifestId': after['manifestId'],
            'addedFiles': 1, 'modifiedFiles': 2, 'removedFiles': 1, 'unchangedFiles': 1,
            'beforeSourceBytes': 8, 'beforeMediaBytes': 7, 'afterSourceBytes': 8, 'afterMediaBytes': 1,
            'beforeBytes': 15, 'afterBytes': 9})
        self.assertEqual(lifecycle.source_manifest(list(reversed(entries))), before)
        zero = lifecycle.source_delta(before, before)
        self.assertEqual(zero['unchangedFiles'], 4); self.assertEqual(zero['beforeBytes'], 0); self.assertEqual(zero['afterBytes'], 0)

    def test_manifest_rejects_unknown_profiles_metadata_modes_paths_ids_and_actual_category_limits(self):
        item = {'path': 'main.js', 'kind': 'source', 'size': 0, 'sha256': 'a' * 64, 'executable': False}
        valid = lifecycle.source_manifest([item])
        for change in ({'version': True}, {'profile': 'candidate-128'}, {'permissionSemantics': 'posix-mode'}, {'manifestId': 'f' * 64}, {'approved': True}):
            with self.subTest(change=change), self.assertRaises(lifecycle.LifecycleError): lifecycle.parse_source_manifest({**valid, **change})
        for change in ({'path': '../outside'}, {'path': 'dist/index.js'}, {'kind': 'media'}, {'kind': 'copy'}, {'size': True}, {'size': -1}, {'size': 2 * 1024 * 1024 + 1}, {'executable': 1}, {'mode': 0o755}):
            with self.subTest(change=change), self.assertRaises(lifecycle.LifecycleError): lifecycle.source_manifest([{**item, **change}])
        with self.assertRaises(lifecycle.LifecycleError): lifecycle.source_manifest([item, item])
        with self.assertRaises(lifecycle.LifecycleError): lifecycle.source_manifest([{**item, 'path': str(index), 'size': 2 * 1024 * 1024} for index in range(5)])
        media = {**item, 'path': 'public/texture.png', 'kind': 'media', 'size': 32 * 1024 * 1024}
        self.assertEqual(lifecycle.source_manifest([media])['files'], [media])
        for changes in ([{**media, 'size': media['size'] + 1}], [{**media, 'executable': True}], [{**media, 'path': 'public/' + str(index) + '.png'} for index in range(3)]):
            with self.subTest(entries=len(changes)), self.assertRaises(lifecycle.LifecycleError): lifecycle.source_manifest(changes)


class LifecycleContracts(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        for target in ('subprocess.run', 'subprocess.Popen', 'os.system', 'os.statvfs',
                       'shutil.disk_usage', 'os.chown'):
            self.stack.enter_context(mock.patch(target, side_effect=AssertionError(
                'A lifecycle unit test attempted a real privileged/process/capacity operation')))
        self.directory = pathlib.Path(self.stack.enter_context(tempfile.TemporaryDirectory(
            prefix='ohmygame-lifecycle-contract-'))).resolve()
        self.backend = FakeBackend()
        self.clock = 1000.0
        self.options = {'volume_bytes': 4096, 'total_bytes': 16 * 4096,
                        'reserve_bytes': 4096, 'resident_limit': 8, 'now': lambda: self.clock}
        self.root = self.directory / 'volumes'
        self.store = lifecycle.Store(self.root, self.backend, **self.options)
        self.counter = 0

    def reopen(self):
        self.store = lifecycle.Store(self.root, self.backend, **self.options)
        return self.store

    def request(self, project=None, namespace='manual', files=None, mode='build'):
        self.counter += 1
        return {'namespace': namespace, 'projectId': project or str(uuid.uuid4()),
                'operationId': format(self.counter, '032x'), 'mode': mode,
                'files': [transfer('main.js', 'source ' + str(self.counter))] if files is None else files,
                'packages': []}

    def typed_request(self, project=None, files=None):
        request = {**self.request(project, files=files), 'rasterReturnVersion': 2, 'sourceManifestVersion': 1}
        return {**request, 'sourceManifest': lifecycle.snapshot_source_manifest(request['files'])}

    def typed_scope(self, binding):
        return {key: binding[key] for key in ('namespace', 'projectId', 'operationId', 'generation', 'leaseToken', 'captureVersion', 'sourceManifestVersion', 'sourceBaseManifestId')}

    def reject(self, code, function, *args, **kwargs):
        with self.assertRaises(lifecycle.LifecycleError) as error:
            function(*args, **kwargs)
        self.assertEqual(error.exception.code, code)
        return error.exception

    def clean_project(self, project=None, namespace='manual', files=None):
        request = self.request(project, namespace, files)
        binding = self.store.prepare(request)
        self.store.claim({**binding, 'mode': request['mode']})
        self.assertFalse(self.store.finish(binding, True)['dirty'])
        self.store.release(binding)
        self.clock += 1
        return binding

    def folder(self, binding, archived=False):
        parent = self.store.cold if archived else self.store.root
        return parent / lifecycle.project_key(binding['namespace'], binding['projectId'])

    def record(self, project, namespace='manual'):
        return next(value for value in self.store.inventory(namespace)['projects'] if value['projectId'] == project)

    def registry(self):
        return json.loads(self.store.file.read_text())

    def retire(self, binding, **options):
        return self.store.retire({**binding, 'confirmation': 'DELETE_PROJECT_VOLUME', **options})

    def fill(self, count=8):
        return [self.clean_project() for _ in range(count)]

    def test_raster_policy_is_bound_to_new_preparation_and_not_migrated_on_reopen(self):
        old = self.clean_project(files=[transfer('main.js', 'old')])
        key = lifecycle.project_key('manual', old['projectId'])
        registry = self.registry()
        registry['records'][key].pop('rasterReturnVersion', None)
        self.store._save(registry)
        self.reopen()
        self.assertNotIn('rasterReturnVersion', self.registry()['records'][key])
        captured = []
        with mock.patch.object(self.backend, 'snapshot_rasters', wraps=self.backend.snapshot_rasters) as snapshots:
            request = {**self.request(old['projectId']), 'rasterReturnVersion': 1}
            new = self.store.prepare(request)
            self.assertEqual(new['rasterReturnVersion'], 1)
            snapshots.assert_not_called()  # The old baseline is checked under its old policy first.
            self.store.claim({**new, 'mode': request['mode']})
            self.store.finish(new, True)
            captured = self.store.capture(new)
            self.assertEqual(captured['rasterReturnVersion'], 1)
            self.assertGreater(snapshots.call_count, 0)
            self.store.acknowledge({**new, 'snapshotId': captured['snapshotId']})
            self.store.acknowledge({**new, 'snapshotId': captured['snapshotId']})
        self.reopen()
        self.assertEqual(self.registry()['records'][key]['rasterReturnVersion'], 1)

    def test_unknown_raster_policy_is_rejected_without_registry_or_identity_mutation(self):
        for policy in (True, '1', -1, 3, None):
            before = self.store._read()
            self.reject('INVALID_REQUEST', self.store.prepare, {**self.request(), 'rasterReturnVersion': policy})
            self.assertEqual(self.store._read(), before)
            self.assertEqual(self.backend.allocations, [])

    def test_manifest_seed_is_exact_and_only_new_clean_preparation_can_negotiate_it(self):
        request = self.typed_request(files=[transfer('main.js', 'baseline')])
        altered = lifecycle.source_manifest([{**request['sourceManifest']['files'][0], 'size': 1}])
        for change in ({'sourceManifestVersion': True}, {'sourceManifestVersion': 2}, {'sourceManifest': altered}, {'rasterReturnVersion': 1}):
            with self.subTest(change=change), self.assertRaises(lifecycle.LifecycleError): self.store.prepare({**request, **change})
        self.assertEqual(self.backend.allocations, []); self.assertEqual(self.store._read()['records'], {})
        for policy in (0, 1, 2):
            old = {**self.request(), 'rasterReturnVersion': policy}
            binding = self.store.prepare(old); self.store.claim({**binding, 'mode': old['mode']})
            (self.folder(binding) / 'root/workspace/main.js').write_text('retained old generation')
            self.store.finish(binding, True); self.store.release(binding)
            before = self.store.file.read_bytes()
            self.reject('RECOVERY_REQUIRED', self.store.prepare, self.typed_request(binding['projectId']))
            self.assertEqual(self.store.file.read_bytes(), before)
            self.assertNotIn('sourceManifestVersion', self.registry()['records'][lifecycle.project_key('manual', binding['projectId'])])

    def test_manifest_capture_ack_and_fresh_read_are_bound_without_saving_duplicate_path_lists(self):
        request = self.typed_request(files=[transfer('src/雪😀.js', 'before'), transfer('empty.txt', '')])
        binding = self.store.prepare(request); key = lifecycle.project_key('manual', binding['projectId'])
        self.assertEqual(binding['sourceBaseManifestId'], request['sourceManifest']['manifestId'])
        record = self.registry()['records'][key]
        self.assertEqual(record['sourceManifestSizes'], [0, 6]); self.assertNotIn('size', record['baseline']['src/雪😀.js'])
        self.assertNotIn('sourceManifest', record); self.assertNotIn('sourceManifest', self.registry()['operations'][binding['operationId']])
        self.store.claim({**binding, 'mode': request['mode']}); (self.folder(binding) / 'root/workspace/src/雪😀.js').write_text('after')
        finished = self.store.finish(binding, True); self.assertTrue(finished['dirty'])
        scope = self.typed_scope(binding)
        for change in ({'sourceManifestVersion': True}, {'sourceBaseManifestId': 'f' * 64}):
            with self.subTest(change=change), self.assertRaises(lifecycle.LifecycleError): self.store.capture_media({**scope, **change})
        missing = {key: value for key, value in scope.items() if key not in ('sourceManifestVersion', 'sourceBaseManifestId')}
        self.reject('INVALID_BINDING', self.store.capture_media, missing)
        captured = self.store.capture_media(scope)
        self.assertEqual(captured['sourceBaselineManifest'], request['sourceManifest'])
        self.assertEqual(captured['snapshotId'], finished['sourceDigest'])
        self.assertEqual(captured['sourceDelta']['modifiedFiles'], 1); self.assertEqual(captured['sourceDelta']['unchangedFiles'], 1)
        self.assertEqual(captured['sourceDelta']['beforeSourceBytes'], 6); self.assertEqual(captured['sourceDelta']['afterSourceBytes'], 5)
        ack = {**binding, 'snapshotId': captured['snapshotId'], 'sourceResultManifestId': captured['sourceResultManifestId']}
        before_ack = self.store.file.read_bytes()
        for bad in ({key: value for key, value in ack.items() if key != 'sourceResultManifestId'}, {**ack, 'sourceResultManifestId': 'f' * 64}):
            with self.assertRaises(lifecycle.LifecycleError): self.store.acknowledge(bad)
            self.assertEqual(self.store.file.read_bytes(), before_ack)
        self.store.acknowledge(ack); saved = self.store.file.read_bytes(); self.store.acknowledge(ack)
        self.assertEqual(self.store.file.read_bytes(), saved)
        for bad in ({**ack, 'sourceBaseManifestId': 'f' * 64}, {**ack, 'sourceResultManifestId': 'f' * 64}, {key: value for key, value in ack.items() if key != 'sourceManifestVersion'}):
            with self.assertRaises(lifecycle.LifecycleError): self.store.acknowledge(bad)
            self.assertEqual(self.store.file.read_bytes(), saved)
        record = self.registry()['records'][key]
        self.assertEqual(record['sourceManifestId'], captured['sourceResultManifestId']); self.assertEqual(record['sourceManifestSizes'], [0, 5])
        self.reject('INVALID_BINDING', self.store.capture_media, scope); self.store.release(binding); self.reopen()
        current = self.store.inventory('manual')['projects'][0]
        review = {key: current[key] for key in ('namespace', 'projectId', 'generation', 'sourceManifestVersion', 'sourceBaseManifestId')}
        review['reviewVersion'] = 2
        self.reject('INVALID_BINDING', self.store.review_source_media, {**review, 'sourceBaseManifestId': binding['sourceBaseManifestId']})
        before_read = self.store.file.read_bytes(); fresh = self.store.review_source_media(review)
        self.assertEqual(fresh['sourceBaselineManifest'], captured['sourceManifest']); self.assertEqual(fresh['sourceManifest'], captured['sourceManifest'])
        self.assertEqual(fresh['sourceDelta']['beforeBytes'], 0); self.assertEqual(fresh['sourceDelta']['afterBytes'], 0)
        self.assertEqual(self.store.file.read_bytes(), before_read)
        origin = next(item for item in fresh['originOperations'] if item['operationId'] == binding['operationId'])
        self.assertEqual(origin['sourceBaseManifestId'], binding['sourceBaseManifestId']); self.assertEqual(origin['sourceResultManifestId'], captured['sourceResultManifestId'])
        self.assertTrue(origin['acknowledged'])
        self.reject('INVALID_REQUEST', self.store.prepare, {**self.request(binding['projectId']), 'rasterReturnVersion': 2})

    def test_manifest_partial_prepare_retains_old_and_target_compact_metadata_until_explicit_recovery(self):
        first_request = self.typed_request(files=[transfer('main.js', 'baseline')])
        first = self.store.prepare(first_request); self.store.claim({**first, 'mode': first_request['mode']}); self.store.finish(first, True); self.store.release(first)
        for partial in (False, True):
            with self.subTest(partial=partial):
                request = self.typed_request(first['projectId'], files=[transfer('main.js', 'incoming source')])
                def full_guest(*_args):
                    if partial: (self.folder(first) / 'root/workspace/main.js').write_text('partial')
                    raise OSError(28, 'No space left in synthetic guest fixture')
                with mock.patch.object(self.backend, 'sync', side_effect=full_guest), self.assertRaises(OSError): self.store.prepare(request)
                record = self.registry()['records'][lifecycle.project_key('manual', first['projectId'])]
                self.assertTrue(record['dirty']); self.assertEqual(record['syncPending'], request['operationId'])
                self.assertEqual(record['sourceManifestId'], first_request['sourceManifest']['manifestId'])
                self.assertEqual(record['sourceManifestSizes'], [8])
                self.assertEqual(record['syncTargetManifestId'], request['sourceManifest']['manifestId']); self.assertEqual(record['syncTargetManifestSizes'], [15])
                self.reopen(); self.reject('RECOVERY_REQUIRED', self.store.prepare, self.typed_request(first['projectId']))
                # Model the existing transaction rollback without touching any real volume.
                (self.folder(first) / 'root/workspace/main.js').write_text('baseline')
                recovery = self.store.recover({**self.request(first['projectId']), 'generation': record['generation'],
                    'sourceManifestVersion': 1, 'sourceBaseManifestId': record['sourceManifestId']})
                self.assertEqual(recovery['sourceBaseManifestId'], first_request['sourceManifest']['manifestId'])
                resolved = self.registry()['records'][lifecycle.project_key('manual', first['projectId'])]
                self.assertFalse(resolved['dirty']); self.assertNotIn('syncTargetManifestSizes', resolved)
                self.store.release(recovery)

    def test_manifest_process_loss_commits_only_the_exact_target_metadata_during_transaction_recovery(self):
        request = self.typed_request(files=[transfer('main.js', 'baseline')])
        binding = self.store.prepare(request); self.store.claim({**binding, 'mode': request['mode']}); self.store.finish(binding, True); self.store.release(binding)
        key = lifecycle.project_key('manual', binding['projectId'])
        for stage in ('before-commit', 'before-finalize'):
            with self.subTest(stage=stage):
                previous_id = self.registry()['records'][key]['sourceManifestId']
                request = self.typed_request(binding['projectId'], files=[transfer('main.js', 'incoming ' + stage)])
                actual_sync = self.backend.sync
                def stop_after_sync(*args):
                    actual_sync(*args)
                    raise SystemExit('synthetic loss after complete staging/publication')
                patch = mock.patch.object(self.backend, 'sync', side_effect=stop_after_sync) if stage == 'before-commit' else mock.patch.object(self.backend, 'finalize_sync', side_effect=SystemExit('synthetic loss before finalize'))
                with patch, self.assertRaises(SystemExit): self.store.prepare(request)
                record = self.registry()['records'][key]
                self.assertEqual(record['syncPending'], request['operationId'])
                self.assertEqual(record['sourceManifestId'], previous_id if stage == 'before-commit' else request['sourceManifest']['manifestId'])
                self.assertEqual(record['syncTargetManifestId'], request['sourceManifest']['manifestId'])
                self.assertEqual(record['syncTargetManifestSizes'], [len(('incoming ' + stage).encode())])
                self.assertEqual(self.record(binding['projectId'])['state'], 'busy')
                before_source = complete_bytes(self.folder(binding)); self.clock += 121; self.reopen()
                self.assertEqual(self.record(binding['projectId'])['state'], 'recovery-pending')
                with mock.patch.object(self.backend, 'recover_sync', return_value={'committed': True}):
                    recovery = self.store.recover({**self.request(binding['projectId']), 'generation': record['generation'],
                        'sourceManifestVersion': 1, 'sourceBaseManifestId': record['sourceManifestId']})
                resolved = self.registry()['records'][key]
                self.assertFalse(resolved['dirty']); self.assertEqual(resolved['sourceManifestId'], request['sourceManifest']['manifestId'])
                self.assertEqual(resolved['sourceManifestSizes'], record['syncTargetManifestSizes'])
                self.assertNotIn('syncPending', resolved); self.assertNotIn('syncTargetManifestId', resolved)
                self.assertEqual(recovery['captureVersion'], 3); self.assertEqual(recovery['sourceBaseManifestId'], request['sourceManifest']['manifestId'])
                self.assertEqual(complete_bytes(self.folder(binding)), before_source)
                self.store.release(recovery)

    def test_compact_manifest_corruption_fails_closed_without_rewriting_source_or_registry(self):
        request = self.typed_request(files=[transfer('main.js', 'source')]); binding = self.store.prepare(request)
        original = self.registry(); key = lifecycle.project_key('manual', binding['projectId'])
        for change in ({'sourceManifestVersion': True}, {'sourceManifestId': 'f' * 64}, {'sourceManifestSizes': [True]}, {'sourceManifestSizes': [7]}, {'sourceManifestSizes': []}):
            with self.subTest(change=change):
                altered = json.loads(json.dumps(original)); altered['records'][key].update(change); self.store._save(altered)
                before = self.store.file.read_bytes(); source = complete_bytes(self.folder(binding))
                with self.assertRaises(lifecycle.LifecycleError): self.store._read()
                self.assertEqual(self.store.file.read_bytes(), before); self.assertEqual(complete_bytes(self.folder(binding)), source)
        self.store._save(original)

    def test_streamed_policy_is_explicit_only_for_the_new_clean_generation(self):
        old = self.clean_project(files=[transfer('main.js', 'baseline')])
        old_registry = self.registry()['operations'][old['operationId']]
        request = {**self.request(old['projectId'], files=[transfer('main.js', 'baseline')]), 'rasterReturnVersion': 2}
        with mock.patch.object(self.backend, 'review_snapshot', wraps=self.backend.review_snapshot) as snapshots:
            new = self.store.prepare(request)
            snapshots.assert_not_called()  # Old policy 0 is checked before negotiating the new generation.
        self.assertEqual(new['generation'], old['generation'] + 1)
        self.assertEqual(new['rasterReturnVersion'], 2); self.assertEqual(new['captureVersion'], 2)
        self.assertEqual(self.registry()['operations'][old['operationId']], old_registry)
        self.assertEqual(self.registry()['operations'][new['operationId']]['captureVersion'], 2)
        self.reopen()
        self.assertEqual(self.store.lookup(new)['captureVersion'], 2)
        self.reject('INVALID_BINDING', self.store.capture_media, {**{key: new[key] for key in ('namespace', 'projectId', 'operationId', 'generation', 'leaseToken')}, 'captureVersion': 2})
        self.store.claim({**new, 'mode': request['mode']}); self.store.finish(new, True)
        self.reject('INVALID_BINDING', self.store.capture, new)
        spec = {key: new[key] for key in ('namespace', 'projectId', 'operationId', 'generation', 'leaseToken', 'captureVersion')}
        captured = self.store.capture_media(spec)
        self.assertEqual(captured['returnedRasters'], [])
        self.assertEqual(captured['files'], request['files'])
        self.reject('GENERATION_CHANGED', self.store.acknowledge, {**old, 'snapshotId': captured['snapshotId'], 'captureVersion': 2})
        self.reject('INVALID_BINDING', self.store.acknowledge, {**{key: value for key, value in new.items() if key != 'captureVersion'}, 'snapshotId': captured['snapshotId']})
        self.store.acknowledge({**new, 'snapshotId': captured['snapshotId']})
        self.store.release(new)
        next_binding = self.store.prepare({**self.request(new['projectId']), 'rasterReturnVersion': 1})
        self.assertEqual(next_binding['rasterReturnVersion'], 1); self.assertNotIn('captureVersion', next_binding)
        self.assertEqual(self.registry()['operations'][new['operationId']]['captureVersion'], 2)

    def test_streamed_capture_cannot_upgrade_dirty_old_operations_or_accept_forged_versions(self):
        for policy in (0, 1):
            with self.subTest(policy=policy):
                request = {**self.request(), 'rasterReturnVersion': policy}
                binding = self.store.prepare(request); self.store.claim({**binding, 'mode': request['mode']})
                (self.folder(binding) / 'root/workspace/main.js').write_text('retained')
                self.store.finish(binding, True)
                before = self.store.file.read_bytes()
                spec = {**{key: binding[key] for key in ('namespace', 'projectId', 'operationId', 'generation', 'leaseToken')}, 'captureVersion': 2}
                self.reject('INVALID_BINDING', self.store.capture_media, spec)
                self.assertEqual(self.store.file.read_bytes(), before)
                self.store.release(binding)
                self.reject('RECOVERY_REQUIRED', self.store.prepare, {**self.request(binding['projectId']), 'rasterReturnVersion': 2})
                self.assertEqual(self.registry()['records'][lifecycle.project_key('manual', binding['projectId'])]['rasterReturnVersion'], policy)

    def test_streamed_request_validation_and_original_snapshot_never_drift(self):
        request = {**self.request(), 'rasterReturnVersion': 2}
        binding = self.store.prepare(request); self.store.claim({**binding, 'mode': request['mode']})
        target = self.folder(binding) / 'root/workspace/main.js'; target.write_text('captured source')
        self.store.finish(binding, True)
        spec = {key: binding[key] for key in ('namespace', 'projectId', 'operationId', 'generation', 'leaseToken', 'captureVersion')}
        for change in ({'captureVersion': True}, {'captureVersion': 1}, {'captureVersion': '2'}, {'generation': True},
                       {'leaseToken': 'x'}, {'reviewVersion': 2}, {'files': []}, {'path': '/etc/passwd'}):
            with self.subTest(change=change):
                self.reject('INVALID_REQUEST', self.store.capture_media, {**spec, **change})
        before_source = complete_bytes(self.folder(binding))
        captured = self.store.capture_media(spec); frozen = self.store.file.read_bytes()
        self.assertTrue(self.record(binding['projectId'])['dirty'])
        self.assertEqual(self.store.capture_media(spec), captured)
        self.assertEqual(self.store.file.read_bytes(), frozen)
        self.assertEqual(complete_bytes(self.folder(binding)), before_source)
        target.write_text('late source change')
        self.reject('GENERATION_CHANGED', self.store.capture_media, spec)
        self.reject('GENERATION_CHANGED', self.store.acknowledge, {**binding, 'snapshotId': captured['snapshotId']})
        self.assertEqual(self.store.file.read_bytes(), frozen)
        self.assertEqual(self.registry()['operations'][binding['operationId']]['snapshotId'], captured['snapshotId'])
        self.assertTrue(self.record(binding['projectId'])['dirty'])
        self.store.release(binding)
        before = self.store.file.read_bytes()
        with mock.patch.object(self.backend, 'mount', wraps=self.backend.mount) as mount:
            self.reject('INVALID_REQUEST', self.store.recover, {**self.request(binding['projectId']), 'generation': binding['generation']})
            mount.assert_not_called()
        self.assertEqual(self.store.file.read_bytes(), before)

    def test_review_is_read_only_and_only_the_exact_reviewed_recovery_gets_candidate_capture(self):
        request = self.request(files=[transfer('main.js', 'baseline')])
        binding = self.store.prepare(request)
        self.store.claim({**binding, 'mode': request['mode']})
        workspace = self.folder(binding) / 'root/workspace'
        (workspace / 'main.js').write_text('retained change')
        self.store.finish(binding, False); self.store.release(binding)
        before = self.store.file.read_bytes()
        review = self.store.review_source({'namespace': 'manual', 'projectId': binding['projectId'], 'generation': binding['generation']})
        self.assertEqual(self.store.file.read_bytes(), before)
        spec = {**self.request(binding['projectId']), 'generation': binding['generation'], 'reviewSnapshotId': 'f' * 64}
        self.reject('GENERATION_CHANGED', self.store.recover, spec)
        self.assertFalse(any(o.get('reviewSnapshotId') for o in self.registry()['operations'].values()))
        recovery = self.store.recover({**spec, 'operationId': self.request()['operationId'], 'reviewSnapshotId': review['snapshotId']})
        self.assertEqual(recovery['rasterReturnVersion'], 1)
        self.assertEqual(recovery['reviewSnapshotId'], review['snapshotId'])
        self.assertEqual(self.registry()['records'][lifecycle.project_key('manual', binding['projectId'])]['rasterReturnVersion'], 0)
        self.reopen()
        capture = self.store.capture(recovery)
        self.assertEqual(capture['snapshotId'], review['snapshotId'])
        (workspace / 'main.js').write_text('late guest change')
        self.reject('GENERATION_CHANGED', self.store.acknowledge, {**recovery, 'snapshotId': review['snapshotId']})
        (workspace / 'main.js').write_text('retained change')
        self.store.acknowledge({**recovery, 'snapshotId': review['snapshotId']})
        self.store.acknowledge({**recovery, 'snapshotId': review['snapshotId']})
        self.store.release(recovery)
        self.assertFalse(self.record(binding['projectId'])['dirty'])
        new = self.store.prepare({**self.request(binding['projectId'], files=review['files']), 'rasterReturnVersion': 1})
        self.assertEqual(new['rasterReturnVersion'], 1)
        self.assertNotIn('reviewSnapshotId', new)

    def test_reviewed_capture_refuses_changed_guest_and_invalid_or_cross_generation_scope(self):
        request = self.request()
        binding = self.store.prepare(request); self.store.claim({**binding, 'mode': request['mode']})
        workspace = self.folder(binding) / 'root/workspace'; (workspace / 'main.js').write_text('guest')
        self.store.finish(binding, False); self.store.release(binding)
        review = self.store.review_source({'namespace': 'manual', 'projectId': binding['projectId'], 'generation': binding['generation']})
        self.reject('GENERATION_CHANGED', self.store.review_source, {'namespace': 'manual', 'projectId': binding['projectId'], 'generation': binding['generation'] + 1})
        for bad in (True, 1, 'bad', 'A' * 64):
            self.reject('INVALID_REQUEST', self.store.recover, {**self.request(binding['projectId']), 'generation': binding['generation'], 'reviewSnapshotId': bad})
        recovered = self.store.recover({**self.request(binding['projectId']), 'generation': binding['generation'], 'reviewSnapshotId': review['snapshotId']})
        (workspace / 'main.js').write_text('different')
        self.reject('GENERATION_CHANGED', self.store.capture, recovered)
        self.assertTrue(self.record(binding['projectId'])['dirty'])

    def test_dormant_legacy_review_never_activates_evicts_or_rewrites_metadata_even_without_free_capacity(self):
        request = self.request()
        binding = self.store.prepare(request); self.store.claim({**binding, 'mode': request['mode']})
        (self.folder(binding) / 'root/workspace/main.js').write_text('retained candidate')
        self.store.finish(binding, False); self.store.release(binding)
        key = lifecycle.project_key('manual', binding['projectId'])
        for archived in (False, True):
            with self.subTest(archived=archived):
                if archived:
                    data = self.registry(); self.store._transition(data, key, data['records'][key], 'archived')
                self.reopen()
                before = self.store.file.read_bytes()
                mounts = list(self.backend.mounted)
                self.backend.free_bytes = 0
                review = self.store.review_source({'namespace': 'manual', 'projectId': binding['projectId'], 'generation': binding['generation']})
                self.assertEqual(review['files'][0]['data'], transfer('main.js', 'retained candidate')['data'])
                self.assertEqual(self.store.file.read_bytes(), before)
                self.assertEqual(self.backend.mounted, mounts)
                self.assertEqual(self.backend.reviewed[-1], key)
        self.backend.free_bytes = 1 << 40

    def test_legacy_review_refuses_active_or_unfinished_states_before_opening_storage(self):
        request = self.request(); binding = self.store.prepare(request)
        spec = {'namespace': 'manual', 'projectId': binding['projectId'], 'generation': binding['generation']}
        before = self.store.file.read_bytes()
        self.reject('ACTIVE_OPERATION', self.store.review_source, spec)
        self.assertEqual(self.store.file.read_bytes(), before)
        self.assertEqual(self.backend.reviewed, [])

    def test_modern_retained_review_is_exact_read_only_and_does_not_guess_failed_origin(self):
        request = {**self.request(), 'rasterReturnVersion': 1}
        binding = self.store.prepare(request); self.store.claim({**binding, 'mode': request['mode']})
        spec = {'namespace': 'manual', 'projectId': binding['projectId'], 'generation': binding['generation'], 'reviewVersion': 2}
        self.reject('ACTIVE_OPERATION', self.store.review_source_media, spec)
        workspace = self.folder(binding) / 'root/workspace'; (workspace / 'main.js').write_text('retained modern change')
        self.store.finish(binding, False); self.store.release(binding)
        before, source = self.store.file.read_bytes(), complete_bytes(self.folder(binding))
        snapshot = self.store.review_source_media(spec)
        self.assertEqual(snapshot['reviewVersion'], 2); self.assertEqual(snapshot['rasterReturnVersion'], 1)
        self.assertEqual(snapshot['originOperations'], [])
        self.assertEqual(snapshot['snapshotId'], lifecycle.source_digest(snapshot['files'] + snapshot['retainedRasters']))
        self.assertEqual(self.store.file.read_bytes(), before)
        self.assertEqual(complete_bytes(self.folder(binding)), source)
        for change in ({'reviewVersion': True}, {'reviewVersion': 1}, {'reviewVersion': 3}, {'generation': True}, {'path': 'main.js'}):
            self.reject('INVALID_REQUEST', self.store.review_source_media, {**spec, **change})
        self.reject('GENERATION_CHANGED', self.store.review_source_media, {**spec, 'generation': spec['generation'] + 1})
        self.assertEqual(self.store.file.read_bytes(), before)

    def test_retained_review_reads_archived_modern_source_without_activation_or_capacity(self):
        request = {**self.request(), 'rasterReturnVersion': 1}
        binding = self.store.prepare(request); self.store.claim({**binding, 'mode': request['mode']})
        (self.folder(binding) / 'root/workspace/main.js').write_text('retained')
        self.store.finish(binding, False); self.store.release(binding)
        key = lifecycle.project_key('manual', binding['projectId'])
        data = self.registry(); self.store._transition(data, key, data['records'][key], 'archived')
        self.reopen(); self.backend.free_bytes = 0
        before, mounts = self.store.file.read_bytes(), list(self.backend.mounted)
        spec = {'namespace': 'manual', 'projectId': binding['projectId'], 'generation': binding['generation'], 'reviewVersion': 2}
        self.assertEqual(self.store.review_source_media(spec)['files'][0]['data'], transfer('main.js', 'retained')['data'])
        self.assertEqual(self.store.file.read_bytes(), before); self.assertEqual(self.backend.mounted, mounts)
        self.assertEqual(self.backend.reviewed[-1], key)
        with mock.patch.object(self.backend, 'review_snapshot', side_effect=ValueError('injected raw review failure')):
            with self.assertRaisesRegex(ValueError, 'injected'): self.store.review_source_media(spec)
        self.assertEqual(self.store.file.read_bytes(), before)

    def test_retained_recovery_versions_and_snapshot_cannot_upgrade_normal_capture_or_ack(self):
        request = {**self.request(), 'rasterReturnVersion': 1}
        binding = self.store.prepare(request); self.store.claim({**binding, 'mode': request['mode']})
        workspace = self.folder(binding) / 'root/workspace'; (workspace / 'main.js').write_text('retained')
        self.store.finish(binding, False); self.store.release(binding)
        spec = {'namespace': 'manual', 'projectId': binding['projectId'], 'generation': binding['generation'], 'reviewVersion': 2}
        review = self.store.review_source_media(spec)
        request = {**self.request(binding['projectId']), **spec, 'reviewSnapshotId': review['snapshotId']}
        self.reject('GENERATION_CHANGED', self.store.recover, {**request, 'reviewSnapshotId': 'f' * 64})
        for version in (True, 0, 1, 3, '2'):
            self.reject('INVALID_REQUEST', self.store.recover, {**request, 'reviewVersion': version})
        recovered = self.store.recover(request)
        self.reject('INVALID_BINDING', self.store.capture, {**recovered, 'reviewVersion': True})
        self.reject('INVALID_BINDING', self.store.acknowledge, {**recovered, 'snapshotId': review['snapshotId']})
        captured = self.store.capture(recovered)
        self.assertEqual(captured['snapshotId'], review['snapshotId'])
        (workspace / 'main.js').write_text('changed after review')
        self.reject('GENERATION_CHANGED', self.store.capture, recovered)
        self.reject('GENERATION_CHANGED', self.store.acknowledge, {**recovered, 'snapshotId': review['snapshotId']})
        self.assertTrue(self.record(binding['projectId'])['dirty'])
        (workspace / 'main.js').write_text('retained')
        self.store.acknowledge({**recovered, 'snapshotId': review['snapshotId']})
        self.assertFalse(self.record(binding['projectId'])['dirty'])
        data = self.registry(); data['operations'][recovered['operationId']]['reviewVersion'] = 3
        lifecycle.atomic_json(self.store.file, data)
        self.reject('UNSAFE_STORAGE', self.store.overview)

    def test_retained_origin_metadata_is_bounded_exact_and_omits_lease_tokens(self):
        other = self.clean_project(namespace='test')
        request = {**self.request(mode='shell'), 'rasterReturnVersion': 1}
        binding = self.store.prepare(request); self.store.claim({**binding, 'mode': 'shell'})
        (self.folder(binding) / 'root/workspace/main.js').write_text('retained')
        self.store.finish(binding, False); self.store.release(binding)
        spec = {'namespace': 'manual', 'projectId': binding['projectId'], 'generation': binding['generation'], 'reviewVersion': 2}
        snapshot_id = self.store.review_source_media(spec)['snapshotId']
        data = self.registry(); key = lifecycle.project_key('manual', binding['projectId'])
        for index in range(40):
            data['operations'][format(index + 100, '032x')] = {'key': key, 'generation': binding['generation'], 'mode': 'shell',
                'phase': 'released', 'snapshotId': snapshot_id, 'acknowledged': snapshot_id if index % 2 else None, 'token': 'f' * 32}
        data['operations'][other['operationId']]['snapshotId'] = snapshot_id
        for index, change in enumerate(({'generation': binding['generation'] + 1}, {'mode': 'preview'}, {'phase': 'cancelled'}, {'snapshotId': 'f' * 64})):
            data['operations'][format(index + 1000, '032x')] = {**data['operations'][format(100, '032x')], **change}
        recovery_id = format(9, '032x')
        data['operations'][recovery_id] = {**data['operations'][format(100, '032x')], 'mode': 'recovery', 'reviewVersion': 2,
            'reviewSnapshotId': snapshot_id, 'acknowledged': snapshot_id}
        data['records'][key]['operationId'] = recovery_id
        lifecycle.atomic_json(self.store.file, data); before = self.store.file.read_bytes()
        origins = self.store.review_source_media(spec)['originOperations']
        self.assertEqual(len(origins), 32)
        self.assertTrue(all(set(origin) == {'operationId', 'mode', 'phase', 'snapshotId', 'acknowledged'} for origin in origins))
        self.assertTrue(all(origin['snapshotId'] == snapshot_id and origin['mode'] in ('shell', 'recovery') for origin in origins))
        self.assertEqual([origin for origin in origins if origin['operationId'] == recovery_id], [
            {'operationId': recovery_id, 'mode': 'recovery', 'phase': 'released', 'snapshotId': snapshot_id, 'acknowledged': True}])
        self.assertTrue(all(type(origin['acknowledged']) is bool for origin in origins))
        self.assertNotIn(other['operationId'], [origin['operationId'] for origin in origins])
        self.assertEqual(self.store.file.read_bytes(), before)

    def test_default_limits_are_four_gib_total_eight_residents_and_one_gib_reserve(self):
        limits = lifecycle.Store(self.directory / 'defaults', self.backend).health()['limits']
        self.assertEqual(limits['volumeBytes'], 256 * 1024 * 1024)
        self.assertEqual(limits['residentVolumes'], 8)
        self.assertEqual(limits['totalLogicalBytes'], 4 * 1024 ** 3)
        self.assertEqual(limits['reserveBytes'], 1024 ** 3)
        self.assertEqual(limits['globalOperations'], 2)
        self.assertEqual(limits['identityRange'], [5000, 5095])

    def test_ninth_useful_project_sleeps_and_restores_every_original_byte(self):
        first = self.clean_project(files=[transfer('main.js', b'\x00source\xff', True)])
        folder = self.folder(first)
        for name, contents in {'root/workspace/node_modules/dependency/index.js': b'dependency',
                               'root/workspace/dist/game.bin': b'\x00\xffgenerated',
                               'root/workspace/build/complete.dat': bytes(range(256)),
                               'root/cache/npm/content.bin': b'cache payload'}.items():
            target = folder / name
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            target.write_bytes(contents)
        original = complete_bytes(folder)
        self.fill(7)
        ninth = self.clean_project()
        self.assertFalse(folder.exists())
        self.assertEqual(complete_bytes(self.folder(first, True)), original)
        self.assertEqual(len(list(self.root.iterdir())), 8)
        self.assertEqual(len(list(self.store.cold.iterdir())), 1)
        self.assertEqual(len(self.store.inventory('manual')['projects']), 9)
        restore = self.store.prepare(self.request(first['projectId'], files=[transfer('main.js', b'\x00source\xff', True)]))
        self.assertEqual(complete_bytes(self.folder(first)), original)
        self.assertEqual(self.registry()['records'][lifecycle.project_key('manual', first['projectId'])]['identity']['uid'], 5000)
        self.assertEqual(len(list(self.root.iterdir())), 8)
        self.assertTrue(self.folder(ninth).exists())
        self.store.finish(restore, True)
        self.store.release(restore)

    def test_dirty_sleeping_source_requires_recovery_and_an_exact_host_acknowledgement(self):
        request = self.request(files=[transfer('main.js', 'host baseline')])
        binding = self.store.prepare(request)
        self.store.claim({**binding, 'mode': 'build'})
        workspace = self.folder(binding) / 'root/workspace'
        (workspace / 'main.js').write_text('guest change not returned')
        self.assertTrue(self.store.finish(binding, False)['dirty'])
        self.store.release(binding)
        self.clock += 1
        original = complete_bytes(self.folder(binding))
        self.fill(8)
        self.assertEqual(complete_bytes(self.folder(binding, True)), original)
        self.reject('RECOVERY_REQUIRED', self.store.prepare, self.request(binding['projectId'], files=request['files']))
        recovery = self.store.recover({**self.request(binding['projectId']), 'generation': binding['generation']})
        captured = self.store.capture(recovery)
        self.assertEqual(base64.b64decode(captured['files'][0]['data']), b'guest change not returned')
        self.assertEqual(captured['baselineFiles'], [{'path': 'main.js', 'sha256': request['files'][0]['sha256'], 'executable': False}])
        self.store.acknowledge({**recovery, 'snapshotId': captured['snapshotId']})
        self.store.release(recovery)
        self.assertFalse(self.record(binding['projectId'])['dirty'])
        next_binding = self.store.prepare(self.request(binding['projectId'], files=captured['files']))
        self.assertEqual((self.folder(next_binding) / 'root/workspace/main.js').read_text(), 'guest change not returned')

    def test_failed_cancelled_and_host_conflicted_operations_keep_unreturned_changes(self):
        for outcome in ('failed', 'cancelled', 'host-conflict'):
            with self.subTest(outcome=outcome):
                request = self.request(files=[transfer('main.js', 'original')])
                binding = self.store.prepare(request)
                self.store.claim({**binding, 'mode': 'build'})
                (self.folder(binding) / 'root/workspace/main.js').write_text(outcome + ' unreturned')
                if outcome == 'cancelled':
                    self.store.cancel(binding)
                self.assertTrue(self.store.finish(binding, outcome == 'host-conflict')['dirty'])
                if outcome == 'host-conflict':
                    self.store.capture(binding)
                self.store.release(binding)
                before = complete_bytes(self.folder(binding))
                self.reject('RECOVERY_REQUIRED', self.store.prepare, self.request(binding['projectId'], files=request['files']))
                self.assertEqual(complete_bytes(self.folder(binding)), before)
                self.assertTrue(self.record(binding['projectId'])['dirty'])

    def test_untouched_failed_work_does_not_invent_dirty_source(self):
        binding = self.store.prepare(self.request())
        self.store.claim({**binding, 'mode': 'build'})
        self.assertFalse(self.store.finish(binding, False)['dirty'])
        self.assertFalse(self.store.release(binding)['dirty'])

    def test_failed_capture_retains_the_specific_recovery_reason_and_source(self):
        binding = self.store.prepare(self.request())
        self.store.claim({**binding, 'mode': 'build'})
        before = complete_bytes(self.folder(binding))
        detail = 'Source file exceeds the 2 MiB return limit: public/audio/new.mp3 (3145740 bytes); isolated data is retained'
        with mock.patch.object(self.backend, 'snapshot', side_effect=ValueError(detail)):
            result = self.store.finish(binding, True)
        self.assertTrue(result['dirty'])
        self.assertIsNone(result['sourceDigest'])
        self.assertIn(detail, self.record(binding['projectId'])['recoveryReason'])
        self.assertEqual(complete_bytes(self.folder(binding)), before)
        self.store.release(binding)
        self.reject('RECOVERY_REQUIRED', self.store.prepare, self.request(binding['projectId']))

    def test_ack_is_idempotent_but_rejects_wrong_operation_generation_token_and_namespace(self):
        binding = self.store.prepare(self.request())
        self.store.claim({**binding, 'mode': 'build'})
        (self.folder(binding) / 'root/workspace/main.js').write_text('returned source')
        self.store.finish(binding, True)
        capture = self.store.capture(binding)
        acknowledgement = {**binding, 'snapshotId': capture['snapshotId']}
        for change in ({'operationId': 'f' * 32}, {'generation': binding['generation'] + 1},
                       {'leaseToken': 'e' * 32}, {'namespace': 'test'}):
            with self.subTest(change=change):
                self.reject('INVALID_BINDING', self.store.acknowledge, {**acknowledgement, **change})
        self.reject('INVALID_BINDING', self.store.acknowledge, {**acknowledgement, 'snapshotId': 'd' * 64})
        self.assertTrue(self.store.acknowledge(acknowledgement)['acknowledged'])
        self.assertTrue(self.store.acknowledge(acknowledgement)['acknowledged'])
        self.store.release(binding)
        self.assertTrue(self.store.acknowledge(acknowledgement)['acknowledged'])
        self.assertFalse(self.record(binding['projectId'])['dirty'])

    def test_source_changed_after_capture_cannot_be_marked_acknowledged(self):
        binding = self.store.prepare(self.request())
        self.store.claim({**binding, 'mode': 'build'})
        source = self.folder(binding) / 'root/workspace/main.js'
        source.write_text('first guest change')
        self.store.finish(binding, True)
        capture = self.store.capture(binding)
        source.write_text('newer guest change')
        self.reject('GENERATION_CHANGED', self.store.acknowledge,
                    {**binding, 'snapshotId': capture['snapshotId']})
        self.assertTrue(self.record(binding['projectId'])['dirty'])
        self.assertEqual(source.read_text(), 'newer guest change')

    def test_two_global_execution_leases_cover_both_namespaces(self):
        first = self.store.prepare(self.request(namespace='manual'))
        second = self.store.prepare(self.request(namespace='test'))
        self.reject('ACTIVE_OPERATION', self.store.prepare, self.request())
        self.store.claim({**first, 'mode': 'build'})
        self.store.claim({**second, 'mode': 'build'})
        self.reject('ACTIVE_OPERATION', self.store.prepare, self.request())
        self.store.finish(first, True)
        self.reject('ACTIVE_OPERATION', self.store.prepare, self.request(first['projectId']))
        third = self.store.prepare(self.request())
        self.assertTrue(third['prepared'])
        self.reject('ACTIVE_OPERATION', self.store.prepare, self.request())
        self.store.release(first)
        self.store.release(third)
        self.store.finish(second, True)
        self.store.release(second)

    def test_claim_is_single_use_and_rejects_the_wrong_mode(self):
        binding = self.store.prepare(self.request(mode='shell'))
        self.reject('INVALID_BINDING', self.store.claim, {**binding, 'mode': 'build'})
        self.store.claim({**binding, 'mode': 'shell'})
        self.reject('INVALID_BINDING', self.store.claim, {**binding, 'mode': 'shell'})

    def test_pre_admission_cancellation_prevents_late_reuse_of_the_operation_id(self):
        request = self.request()
        self.assertIsNone(self.store.cancel(request)['operation'])
        self.reject('INVALID_BINDING', self.store.prepare, request)
        self.assertEqual(self.backend.created, [])

    def test_expired_unacknowledged_operations_release_capacity_but_preserve_recovery(self):
        binding = self.store.prepare(self.request())
        before = complete_bytes(self.folder(binding))
        self.clock += 121
        self.clean_project()
        self.assertEqual(complete_bytes(self.folder(binding)), before)
        self.assertTrue(self.record(binding['projectId'])['dirty'])
        self.reject('RECOVERY_REQUIRED', self.store.prepare, self.request(binding['projectId']))

    def test_an_expired_operation_cannot_be_released_while_the_backend_is_still_busy(self):
        binding = self.store.prepare(self.request())
        self.backend.busy.add(lifecycle.project_key('manual', binding['projectId']))
        self.clock += 121
        self.reject('ACTIVE_OPERATION', self.store.prepare, self.request())
        self.assertEqual(self.registry()['operations'][binding['operationId']]['phase'], 'prepared')

    def test_all_busy_resident_images_are_preserved_instead_of_evicting_a_useful_ninth(self):
        bindings = self.fill()
        before = {value['projectId']: complete_bytes(self.folder(value)) for value in bindings}
        self.backend.busy.update(lifecycle.project_key('manual', value['projectId']) for value in bindings)
        self.reject('ACTIVE_OPERATION', self.store.prepare, self.request())
        self.assertEqual(len(self.backend.created), 8)
        for value in bindings:
            self.assertEqual(complete_bytes(self.folder(value)), before[value['projectId']])

    def test_total_reservation_counts_sleeping_and_resident_volumes(self):
        self.fill(16)
        before = complete_bytes(self.root), complete_bytes(self.store.cold)
        self.reject('CAPACITY', self.store.prepare, self.request())
        self.assertEqual((complete_bytes(self.root), complete_bytes(self.store.cold)), before)
        self.assertEqual(len(self.backend.created), 16)

    def test_first_volume_keeps_one_gib_plus_staging_and_prospective_growth(self):
        self.options.pop('reserve_bytes')
        self.reopen()
        needed = lifecycle.RESERVE_BYTES + STAGING_BYTES + self.options['volume_bytes']
        self.backend.free_bytes = needed - 1
        self.reject('CAPACITY', self.store.prepare, self.request())
        self.assertEqual(self.backend.created, [])
        self.backend.free_bytes = needed
        self.assertTrue(self.store.prepare(self.request())['prepared'])

    def test_existing_sparse_image_growth_is_reserved_before_creating_another(self):
        self.options.update(volume_bytes=64 * 1024, total_bytes=16 * 64 * 1024)
        self.reopen()
        first = self.clean_project()
        image = self.folder(first) / 'disk.img'
        allocated = image.stat().st_blocks * 512
        growth = max(0, self.options['volume_bytes'] - allocated)
        needed = self.options['reserve_bytes'] + STAGING_BYTES + growth + self.options['volume_bytes']
        self.backend.free_bytes = needed - 1
        self.reject('CAPACITY', self.store.prepare, self.request())
        self.assertEqual(len(self.backend.created), 1)
        self.backend.free_bytes = needed
        self.assertTrue(self.store.prepare(self.request())['prepared'])

    def test_low_space_is_rejected_before_sleeping_or_deleting_any_resident(self):
        bindings = self.fill()
        before = complete_bytes(self.root)
        self.backend.free_bytes = 0
        self.reject('CAPACITY', self.store.prepare, self.request())
        self.assertEqual(complete_bytes(self.root), before)
        self.assertEqual(self.backend.unmounted, [])
        self.assertTrue(all(self.folder(value).exists() for value in bindings))

    def test_manual_and_test_namespace_have_distinct_folders_and_stable_identities(self):
        project = str(uuid.uuid4())
        manual = self.clean_project(project, 'manual')
        test = self.clean_project(project, 'test')
        records = self.registry()['records']
        self.assertEqual(records[lifecycle.project_key('manual', project)]['identity']['uid'], 5000)
        self.assertEqual(records[lifecycle.project_key('test', project)]['identity']['uid'], 5001)
        self.assertNotEqual(self.folder(manual), self.folder(test))
        preserved = complete_bytes(self.folder(test))
        self.retire(manual)
        self.assertFalse(self.folder(manual).exists())
        self.assertEqual(complete_bytes(self.folder(test)), preserved)
        self.assertEqual(self.store.inventory('manual')['projects'], [])

    def test_deleted_identity_is_not_silently_reused_and_the_range_stops_at_5095(self):
        self.options.update(total_bytes=4096)
        self.reopen()
        identities = []
        for index in range(96):
            binding = self.clean_project(str(uuid.UUID(int=index + 1)))
            record = self.registry()['records'][lifecycle.project_key('manual', binding['projectId'])]
            identities.append(record['identity']['uid'])
            self.retire(binding)
        self.assertEqual(identities, list(range(5000, 5096)))
        self.assertEqual(self.backend.allocations[-1], set(range(5000, 5095)))
        self.reject('CAPACITY', self.store.prepare, self.request(str(uuid.UUID(int=200))))
        self.assertEqual(len(self.backend.created), 96)

    def test_retire_requires_confirmation_generation_and_explicit_dirty_discard(self):
        peer = self.clean_project(namespace='test')
        peer_bytes = complete_bytes(self.folder(peer))
        binding = self.store.prepare(self.request())
        self.store.claim({**binding, 'mode': 'build'})
        (self.folder(binding) / 'root/workspace/main.js').write_text('unreturned')
        self.store.finish(binding, False)
        self.store.release(binding)
        before = complete_bytes(self.folder(binding))
        counts = self.store.overview()['counts']
        self.reject('INVALID_REQUEST', self.store.retire, binding)
        self.reject('GENERATION_CHANGED', self.retire, {**binding, 'generation': binding['generation'] + 1})
        self.reject('RECOVERY_REQUIRED', self.retire, binding)
        self.assertEqual(complete_bytes(self.folder(binding)), before)
        self.assertEqual(self.store.overview()['counts'], counts)
        self.assertEqual(complete_bytes(self.folder(peer)), peer_bytes)
        self.assertEqual(self.backend.deleted, [])
        self.assertTrue(self.retire(binding, discardUnsynced=True)['deleted'])
        self.assertFalse(self.folder(binding).exists())
        self.assertTrue(self.retire(binding)['absent'])
        self.assertEqual(len(self.backend.deleted), 1)
        self.assertEqual(complete_bytes(self.folder(peer)), peer_bytes)

    def test_active_volume_cannot_be_retired_even_with_discard_confirmation(self):
        peer = self.clean_project(namespace='test')
        peer_bytes = complete_bytes(self.folder(peer))
        binding = self.store.prepare(self.request())
        before = complete_bytes(self.folder(binding))
        counts = self.store.overview()['counts']
        self.reject('ACTIVE_OPERATION', self.retire, binding, discardUnsynced=True)
        self.store.finish(binding, True)
        self.store.release(binding)
        self.backend.busy.add(lifecycle.project_key('manual', binding['projectId']))
        self.reject('ACTIVE_OPERATION', self.retire, binding, discardUnsynced=True)
        self.assertEqual(complete_bytes(self.folder(binding)), before)
        self.assertEqual(complete_bytes(self.folder(peer)), peer_bytes)
        self.assertEqual(self.store.overview()['counts'], counts)
        self.assertEqual(self.backend.deleted, [])

    def test_retiring_another_project_preserves_an_unexpired_running_project_and_its_operation(self):
        clean = self.clean_project(namespace='test')
        active = self.store.prepare(self.request(namespace='manual'))
        self.store.claim({**active, 'mode': 'build'})
        (self.folder(active) / 'root/workspace/main.js').write_bytes(b'live unique unreturned source')
        active_key = lifecycle.project_key('manual', active['projectId'])
        before = self.registry()
        record = before['records'][active_key]
        operation = before['operations'][active['operationId']]
        self.assertGreater(operation['expiresAt'], self.clock)
        preserved = complete_bytes(self.folder(active))
        counts = self.store.overview()['counts']
        self.assertTrue(self.retire(clean)['deleted'])
        self.assertFalse(self.folder(clean).exists())
        after = self.registry()
        self.assertEqual(after['records'][active_key], record)
        self.assertEqual(after['operations'][active['operationId']], operation)
        self.assertEqual(complete_bytes(self.folder(active)), preserved)
        self.assertEqual(self.backend.deleted, [self.folder(clean).name])
        value = self.store.overview()
        self.assertTrue(value['countsTrusted'])
        self.assertEqual(value['counts'], {**counts, 'allocatedProjects': counts['allocatedProjects'] - 1,
                                          'allocatedLogicalBytes': counts['allocatedLogicalBytes'] - self.store.volume_bytes,
                                          'residentReserved': counts['residentReserved'] - 1,
                                          'resident': counts['resident'] - 1, 'freeSlots': counts['freeSlots'] + 1})
        self.assertEqual(value['projects'][0]['tasks'][0]['phase'], 'running')
        self.assertTrue(value['projects'][0]['dirty'])

    def test_archived_project_is_deleted_without_mounting_or_deleting_another_project(self):
        first = self.clean_project()
        self.fill(8)
        key = lifecycle.project_key('manual', first['projectId'])
        preserved = {k: complete_bytes(self.store._folder(k, r)) for k, r in self.registry()['records'].items() if k != key}
        identity = self.registry()['records'][key]['identity']
        before = self.store.overview()['counts']
        self.assertEqual((before['residentReserved'], before['freeSlots'], before['sleeping']), (8, 0, 1))
        mounted = list(self.backend.mounted)
        self.assertTrue(self.retire(first)['deleted'])
        self.assertFalse(self.folder(first, True).exists())
        self.assertEqual(self.backend.mounted, mounted)
        value = self.store.overview()
        self.assertTrue(value['countsTrusted'])
        self.assertEqual(value['counts'], {**before, 'allocatedProjects': before['allocatedProjects'] - 1,
                                          'allocatedLogicalBytes': before['allocatedLogicalBytes'] - self.store.volume_bytes,
                                          'sleeping': before['sleeping'] - 1})
        self.assertEqual({k: complete_bytes(self.store._folder(k, r)) for k, r in self.registry()['records'].items()
                          if k != key}, preserved)
        self.assertEqual(self.registry()['records'][key]['identity'], identity)
        self.assertEqual(self.registry()['records'][key]['state'], 'deleted')

    def test_resident_retirement_and_absence_close_quota_without_reusing_the_identity(self):
        peers = [self.clean_project(), self.clean_project(namespace='test')]
        preserved = {lifecycle.project_key(p['namespace'], p['projectId']): complete_bytes(self.folder(p)) for p in peers}
        binding = self.clean_project()
        key = lifecycle.project_key('manual', binding['projectId'])
        identity = self.registry()['records'][key]['identity']
        before = self.store.overview()['counts']
        self.assertTrue(self.retire(binding)['deleted'])
        self.assertFalse(self.folder(binding).exists())
        value = self.store.overview()
        self.assertTrue(value['countsTrusted'])
        self.assertEqual(value['counts'], {**before, 'allocatedProjects': before['allocatedProjects'] - 1,
                                          'allocatedLogicalBytes': before['allocatedLogicalBytes'] - self.store.volume_bytes,
                                          'residentReserved': before['residentReserved'] - 1,
                                          'resident': before['resident'] - 1, 'freeSlots': before['freeSlots'] + 1})
        after = value['counts']
        registry = self.store.file.read_bytes()
        allocations = list(self.backend.allocations)
        for spec in (binding, binding, {'namespace': 'test', 'projectId': str(uuid.uuid4()), 'generation': 1}):
            self.assertEqual(self.retire(spec), {'deleted': True, 'absent': True})
            self.assertEqual(self.store.overview()['counts'], after)
            self.assertEqual(self.store.file.read_bytes(), registry)
        self.assertEqual(self.backend.allocations, allocations)
        self.assertEqual(len(self.backend.deleted), 1)
        self.assertEqual(self.registry()['records'][key]['identity'], identity)
        self.assertEqual(self.registry()['records'][key]['state'], 'deleted')
        replacement = self.clean_project()
        self.assertNotEqual(self.registry()['records'][lifecycle.project_key('manual', replacement['projectId'])]['identity']['uid'],
                            identity['uid'])
        self.assertIn(identity['uid'], self.backend.allocations[-1])
        self.assertEqual({lifecycle.project_key(p['namespace'], p['projectId']): complete_bytes(self.folder(p)) for p in peers}, preserved)

    def test_retirement_of_damaged_or_unregistered_storage_preserves_every_remaining_byte(self):
        binding = self.clean_project()
        peer = self.clean_project(namespace='test')
        folder = self.folder(binding)
        before = complete_bytes(folder)
        peer_bytes = complete_bytes(self.folder(peer))
        owner = folder / 'owner.json'
        original = owner.read_bytes()
        owner.write_text('{}')
        for _ in range(2):
            self.reject('UNSAFE_STORAGE', self.retire, binding)
            self.reject('UNSAFE_STORAGE', self.store.overview)
            self.assertEqual((folder / 'disk.img').read_bytes(), before['disk.img'][1])
            self.assertEqual(owner.read_text(), '{}')
        owner.write_bytes(original)
        unknown = self.root / 'unknown-retained-data'
        unknown.mkdir(mode=0o700)
        (unknown / 'keep.bin').write_bytes(b'not a registered project; never adopt or delete')
        unknown_bytes = complete_bytes(unknown)
        for _ in range(2):
            self.reject('LEGACY_STORAGE', self.retire, binding)
            self.reject('LEGACY_STORAGE', self.store.overview)
            self.assertEqual(complete_bytes(folder), before)
            self.assertEqual(complete_bytes(unknown), unknown_bytes)
        self.assertEqual(complete_bytes(self.folder(peer)), peer_bytes)
        self.assertEqual(self.backend.deleted, [])

    def test_failed_source_publication_is_dirty_and_requires_explicit_recovery(self):
        first = self.clean_project(files=[transfer('main.js', 'old host source')])
        original = complete_bytes(self.folder(first))
        with mock.patch.object(self.backend, 'sync', side_effect=SimulatedCrash('publication failed')):
            with self.assertRaises(SimulatedCrash):
                self.store.prepare(self.request(first['projectId'], files=[transfer('main.js', 'incoming')]))
        record = self.registry()['records'][lifecycle.project_key('manual', first['projectId'])]
        self.assertTrue(record['dirty'])
        self.assertIn('syncPending', record)
        self.assertEqual(complete_bytes(self.folder(first)), original)
        self.reject('RECOVERY_REQUIRED', self.store.prepare, self.request(first['projectId']))
        recovery = self.store.recover({**self.request(first['projectId']), 'generation': record['generation']})
        self.assertEqual(self.backend.recovered_syncs[-1][1], record['syncPending'])
        capture = self.store.capture(recovery)
        self.store.acknowledge({**recovery, 'snapshotId': capture['snapshotId']})
        self.store.release(recovery)

    def test_streamed_policy_keeps_pending_sync_recovery_separate_from_raster_adoption(self):
        first = self.clean_project(files=[transfer('main.js', 'baseline')])
        request = {**self.request(first['projectId'], files=[transfer('main.js', 'incoming')]), 'rasterReturnVersion': 2}
        with mock.patch.object(self.backend, 'sync', side_effect=SimulatedCrash('publication failed')):
            with self.assertRaises(SimulatedCrash): self.store.prepare(request)
        record = self.registry()['records'][lifecycle.project_key('manual', first['projectId'])]
        original = complete_bytes(self.folder(first))
        self.assertEqual(record['rasterReturnVersion'], 2); self.assertTrue(record['dirty'])
        recovery = self.store.recover({**self.request(first['projectId']), 'generation': record['generation']})
        self.assertEqual(self.backend.recovered_syncs[-1][1], request['operationId'])
        self.assertEqual(complete_bytes(self.folder(first)), original)
        self.assertEqual(recovery['captureVersion'], 2)
        self.assertFalse(self.record(first['projectId'])['dirty'])
        self.assertNotIn('syncPending', self.registry()['records'][lifecycle.project_key('manual', first['projectId'])])
        self.reject('INVALID_BINDING', self.store.capture, recovery)
        self.store.release(recovery)
        prepared = self.store.prepare({**self.request(first['projectId']), 'rasterReturnVersion': 2})
        self.assertEqual(prepared['captureVersion'], 2)

    def test_clean_streamed_policy_reserves_export_without_upgrading_a_dirty_generation(self):
        request = {**self.request(files=[transfer('main.js', 'baseline')]), 'rasterReturnVersion': 2}
        binding = self.store.prepare(request); self.store.claim({**binding, 'mode': request['mode']})
        self.assertFalse(self.store.finish(binding, True)['dirty']); self.store.release(binding)
        source_before = complete_bytes(self.folder(binding))
        record_before = self.registry()['records'][lifecycle.project_key('manual', binding['projectId'])]
        reservation = self.store.recover({**self.request(binding['projectId']), 'generation': binding['generation']})
        self.assertEqual(reservation['rasterReturnVersion'], 2); self.assertEqual(reservation['captureVersion'], 2)
        self.assertNotIn('reviewVersion', reservation); self.assertNotIn('reviewSnapshotId', reservation)
        self.reopen()
        self.assertEqual(self.store.lookup(reservation)['captureVersion'], 2)
        context = self.store.validate_binding(reservation, phases=('finished',))
        self.assertEqual(context['workspace'], str(self.folder(binding) / 'root/workspace'))
        record = self.registry()['records'][lifecycle.project_key('manual', binding['projectId'])]
        self.assertFalse(record['dirty']); self.assertEqual(record['generation'], record_before['generation'])
        self.assertEqual(record['baseline'], record_before['baseline']); self.assertEqual(complete_bytes(self.folder(binding)), source_before)
        self.reject('INVALID_BINDING', self.store.capture, reservation)
        spec = {key: reservation[key] for key in ('namespace', 'projectId', 'operationId', 'generation', 'leaseToken', 'captureVersion')}
        captured = self.store.capture_media(spec)
        self.assertEqual(captured['returnedRasters'], []); self.assertEqual(captured['files'], request['files'])
        self.store.acknowledge({**reservation, 'snapshotId': captured['snapshotId']}); self.store.release(reservation)
        self.assertEqual(complete_bytes(self.folder(binding)), source_before)

    def test_creation_crash_keeps_the_only_image_and_refuses_to_guess_it_away(self):
        original_create = self.backend.create
        def interrupted_create(*args):
            original_create(*args)
            raise SimulatedCrash('created before registry commit')
        request = self.request()
        with mock.patch.object(self.backend, 'create', side_effect=interrupted_create):
            with self.assertRaises(SimulatedCrash):
                self.store.prepare(request)
        folder = self.root / lifecycle.project_key('manual', request['projectId'])
        original = complete_bytes(folder)
        self.reopen()
        self.reject('RECOVERY_REQUIRED', self.store.prepare, self.request(request['projectId']))
        self.assertEqual(complete_bytes(folder), original)

    def test_uncommitted_creation_reserves_one_of_eight_physical_resident_slots(self):
        create = self.backend.create
        def interrupted_create(*args):
            create(*args)
            raise SimulatedCrash('physical image created before state commit')
        with mock.patch.object(self.backend, 'create', side_effect=interrupted_create):
            for _ in range(8):
                with self.assertRaises(SimulatedCrash):
                    self.store.prepare(self.request())
        before = complete_bytes(self.root)
        self.assertEqual(len(list(self.root.iterdir())), 8)
        self.reject('ACTIVE_OPERATION', self.store.prepare, self.request())
        self.assertEqual(complete_bytes(self.root), before)
        self.assertEqual(len(self.backend.created), 8)

    def test_interrupted_creation_replaced_by_external_link_fails_closed(self):
        create = self.backend.create
        def interrupted_create(*args):
            create(*args)
            raise SimulatedCrash('physical image created before state commit')
        request = self.request()
        with mock.patch.object(self.backend, 'create', side_effect=interrupted_create):
            with self.assertRaises(SimulatedCrash):
                self.store.prepare(request)
        key = lifecycle.project_key('manual', request['projectId'])
        record = self.registry()['records'][key]
        self.assertEqual(record['state'], 'creating')
        folder = self.root / key
        external = self.directory / 'external-creating-volume'
        folder.rename(external)
        folder.symlink_to(external, target_is_directory=True)
        before = complete_bytes(external)
        self.reopen()
        self.assertFalse(self.store.health()['ready'])
        with mock.patch.object(self.backend, 'delete_exact', wraps=self.backend.delete_exact) as delete:
            self.reject('UNSAFE_STORAGE', self.retire,
                        {'namespace': 'manual', 'projectId': request['projectId'],
                         'generation': record['generation']})
            delete.assert_not_called()
        self.assertEqual(complete_bytes(external), before)
        self.assertEqual(self.backend.deleted, [])

    def test_creation_crash_before_folder_can_retire_without_reusing_identity(self):
        request = self.request()
        with mock.patch.object(self.backend, 'create', side_effect=SimulatedCrash('before physical creation')):
            with self.assertRaises(SimulatedCrash):
                self.store.prepare(request)
        key = lifecycle.project_key('manual', request['projectId'])
        record = self.registry()['records'][key]
        self.assertEqual(record['state'], 'creating')
        self.assertEqual(record['identity']['uid'], 5000)
        self.assertFalse(os.path.lexists(self.root / key))
        self.reopen()
        binding = {'namespace': 'manual', 'projectId': request['projectId'],
                   'generation': record['generation']}
        self.reject('GENERATION_CHANGED', self.retire, {**binding, 'generation': record['generation'] + 1})
        with mock.patch.object(self.backend, 'delete_exact', wraps=self.backend.delete_exact) as delete:
            result = self.retire(binding)
            self.assertTrue(result['deleted'])
            self.assertTrue(result['absent'])
            delete.assert_not_called()
        tombstone = self.registry()['records'][key]
        self.assertEqual(tombstone['state'], 'deleted')
        self.assertEqual(tombstone['identity'], record['identity'])
        self.assertEqual(self.backend.deleted, [])
        next_binding = self.clean_project()
        next_key = lifecycle.project_key('manual', next_binding['projectId'])
        self.assertEqual(self.registry()['records'][next_key]['identity']['uid'], 5001)

    def test_process_loss_during_pending_sync_cannot_be_cleaned_by_cancel_or_finish(self):
        first = self.clean_project(files=[transfer('main.js', 'acknowledged baseline')])
        request = self.request(first['projectId'], files=[transfer('main.js', 'incoming source')])
        with mock.patch.object(self.backend, 'sync', side_effect=SystemExit('simulated process loss')):
            with self.assertRaises(SystemExit):
                self.store.prepare(request)
        binding = self.store.lookup(request)
        self.assertIsNotNone(binding)
        self.reject('INVALID_BINDING', self.store.claim, {**binding, 'mode': 'build'})
        self.reject('INVALID_BINDING', self.store.validate_binding, binding, phases=('prepared',))
        self.store.cancel(binding)
        self.assertTrue(self.store.finish(binding, False)['dirty'])
        self.reject('RECOVERY_REQUIRED', self.store.capture, binding)
        self.assertTrue(self.store.release(binding)['dirty'])
        self.reject('RECOVERY_REQUIRED', self.store.prepare, self.request(first['projectId']))
        record = self.registry()['records'][lifecycle.project_key('manual', first['projectId'])]
        self.assertEqual(record['syncPending'], request['operationId'])
        self.assertEqual((self.folder(first) / 'root/workspace/main.js').read_text(), 'acknowledged baseline')

    def test_source_commit_before_finalize_crash_keeps_pending_transaction_and_published_bytes(self):
        first = self.clean_project(files=[transfer('main.js', 'old baseline')])
        request = self.request(first['projectId'], files=[transfer('main.js', 'published source')])
        with mock.patch.object(self.backend, 'finalize_sync', side_effect=SystemExit('lost before finalize')):
            with self.assertRaises(SystemExit):
                self.store.prepare(request)
        key = lifecycle.project_key('manual', first['projectId'])
        record = self.registry()['records'][key]
        self.assertEqual(record['syncPending'], request['operationId'])
        self.assertEqual(record['baseline']['main.js']['sha256'], request['files'][0]['sha256'])
        original = complete_bytes(self.folder(first))
        self.clock += 121
        self.reopen()
        recovery = self.store.recover({**self.request(first['projectId']), 'generation': record['generation']})
        self.assertEqual(self.backend.recovered_syncs[-1][1], request['operationId'])
        self.assertEqual(complete_bytes(self.folder(first)), original)
        captured = self.store.capture(recovery)
        self.assertEqual(base64.b64decode(captured['files'][0]['data']), b'published source')
        self.store.acknowledge({**recovery, 'snapshotId': captured['snapshotId']})
        self.store.release(recovery)

    def test_corrupted_sleeping_image_is_not_restored_or_replaced_with_an_empty_volume(self):
        first = self.fill(9)[0]
        folder = self.folder(first, True)
        with (folder / 'disk.img').open('r+b') as image:
            image.write(b'corrupted sleeping payload')
        original = complete_bytes(folder)
        self.reject('RECOVERY_REQUIRED', self.store.prepare, self.request(first['projectId']))
        self.assertEqual(complete_bytes(folder), original)
        self.assertEqual(len(self.backend.created), 9)

    def test_sleep_crash_before_rename_reconciles_the_intent_without_losing_bytes(self):
        bindings = self.fill()
        first = bindings[0]
        source = self.folder(first)
        original = complete_bytes(source)
        rename = pathlib.Path.rename
        def interrupted_rename(file, target):
            if file == source:
                raise SimulatedCrash('intent persisted before move')
            return rename(file, target)
        with mock.patch.object(pathlib.Path, 'rename', interrupted_rename):
            with self.assertRaises(SimulatedCrash):
                self.store.prepare(self.request())
        self.assertEqual(complete_bytes(source), original)
        self.reopen()
        self.clean_project()
        self.assertEqual(complete_bytes(self.folder(first, True)), original)
        self.assertNotIn('transition', self.registry()['records'][lifecycle.project_key('manual', first['projectId'])])

    def test_sleep_crash_after_rename_reconciles_the_published_copy_without_recreating_it(self):
        first = self.fill()[0]
        original = complete_bytes(self.folder(first))
        key = lifecycle.project_key('manual', first['projectId'])
        save = self.store._save
        def interrupted_commit(data):
            record = data['records'][key]
            if record['state'] == 'archived' and not record.get('transition'):
                raise SimulatedCrash('move published before registry commit')
            return save(data)
        with mock.patch.object(self.store, '_save', side_effect=interrupted_commit):
            with self.assertRaises(SimulatedCrash):
                self.store.prepare(self.request())
        self.assertFalse(self.folder(first).exists())
        self.assertEqual(complete_bytes(self.folder(first, True)), original)
        self.reopen()
        self.clean_project()
        self.assertEqual(complete_bytes(self.folder(first, True)), original)
        self.assertEqual(len(self.backend.created), 9)

    def test_uncertain_sleep_with_duplicate_or_modified_copies_requires_review(self):
        first = self.fill()[0]
        source = self.folder(first)
        rename = pathlib.Path.rename
        def interrupted_rename(file, target):
            if file == source:
                raise SimulatedCrash('intent only')
            return rename(file, target)
        with mock.patch.object(pathlib.Path, 'rename', interrupted_rename):
            with self.assertRaises(SimulatedCrash):
                self.store.prepare(self.request())
        self.store.cold.mkdir(mode=0o700, exist_ok=True)
        target = self.folder(first, True)
        shutil.copytree(source, target)
        duplicate = complete_bytes(target)
        self.reopen()
        self.reject('RECOVERY_REQUIRED', self.store.prepare, self.request())
        self.assertEqual(complete_bytes(target), duplicate)
        shutil.rmtree(target)
        with (source / 'disk.img').open('r+b') as image:
            image.write(b'changed after interrupted transition')
        tampered = complete_bytes(source)
        self.reject('RECOVERY_REQUIRED', self.store.prepare, self.request())
        self.assertEqual(complete_bytes(source), tampered)

    def test_completed_but_unacknowledged_deletion_is_reconciled_without_retrying_deletion(self):
        binding = self.clean_project()
        peer = self.clean_project(namespace='test')
        peer_bytes = complete_bytes(self.folder(peer))
        before = self.store.overview()['counts']
        identity = self.registry()['records'][lifecycle.project_key('manual', binding['projectId'])]['identity']
        delete = self.backend.delete_exact
        calls = []
        def delete_then_crash(folder, entries):
            calls.append(folder)
            delete(folder, entries)
            raise SimulatedCrash('result lost after deletion')
        with mock.patch.object(self.backend, 'delete_exact', side_effect=delete_then_crash):
            error = self.reject('DELETE_UNCERTAIN', self.retire, binding)
        self.assertTrue(error.changed)
        uncertain = self.store.overview()
        self.assertFalse(uncertain['countsTrusted'])
        self.assertIsNone(uncertain['counts']['freeSlots'])
        self.assertEqual(uncertain['counts']['residentReserved'], before['residentReserved'])
        self.reopen()
        self.assertTrue(self.retire(binding)['absent'])
        self.assertEqual(len(calls), 1)
        self.assertFalse(self.folder(binding).exists())
        self.assertEqual(self.store.overview()['counts'], {**before, 'allocatedProjects': before['allocatedProjects'] - 1,
                                          'allocatedLogicalBytes': before['allocatedLogicalBytes'] - self.store.volume_bytes,
                         'residentReserved': before['residentReserved'] - 1, 'resident': before['resident'] - 1,
                         'freeSlots': before['freeSlots'] + 1})
        self.assertEqual(complete_bytes(self.folder(peer)), peer_bytes)
        self.assertEqual(self.registry()['records'][lifecycle.project_key('manual', binding['projectId'])]['identity'], identity)

    def test_partial_deletion_never_automatically_retries_or_deletes_the_remaining_image(self):
        binding = self.clean_project()
        peer = self.clean_project(namespace='test')
        peer_bytes = complete_bytes(self.folder(peer))
        folder = self.folder(binding)
        extra = folder / 'disposable.bin'
        extra.write_bytes(b'fixture')
        image = (folder / 'disk.img').read_bytes()
        remaining = complete_bytes(folder)
        remaining.pop('disposable.bin')
        counts = self.store.overview()['counts']
        def partial_delete(_folder, _entries):
            extra.unlink()
            raise SimulatedCrash('partial deletion')
        with mock.patch.object(self.backend, 'delete_exact', side_effect=partial_delete) as delete:
            self.reject('DELETE_UNCERTAIN', self.retire, binding)
            value = self.store.overview()
            self.assertFalse(value['countsTrusted'])
            self.assertIsNone(value['counts']['freeSlots'])
            self.assertEqual(value['counts']['residentReserved'], counts['residentReserved'])
            self.reopen()
            for _ in range(2):
                self.reject('RECOVERY_REQUIRED', self.retire, binding)
                self.assertIsNone(self.store.overview()['counts']['freeSlots'])
                self.assertEqual(complete_bytes(folder), remaining)
        self.assertEqual(delete.call_count, 1)
        self.assertEqual((folder / 'disk.img').read_bytes(), image)
        self.assertEqual(complete_bytes(self.folder(peer)), peer_bytes)

    def test_legacy_volumes_unknown_entries_and_registry_links_fail_closed(self):
        self.root.mkdir(mode=0o700)
        legacy = self.root / str(uuid.uuid4())
        legacy.mkdir(mode=0o700)
        (legacy / 'disk.img').write_bytes(b'legacy useful image')
        self.assertFalse(self.store.health()['ready'])
        self.reject('LEGACY_STORAGE', self.store.prepare, self.request())
        self.assertEqual((legacy / 'disk.img').read_bytes(), b'legacy useful image')
        shutil.rmtree(legacy)
        binding = self.clean_project()
        registry = self.store.file
        original = registry.read_bytes()
        saved = registry.with_name('saved-registry.json')
        registry.rename(saved)
        registry.symlink_to(saved)
        self.reject('UNSAFE_STORAGE', self.store.prepare, self.request())
        self.assertEqual(saved.read_bytes(), original)
        registry.unlink()
        saved.rename(registry)
        unknown = self.root / 'unregistered-useful-files'
        unknown.mkdir(mode=0o700)
        (unknown / 'keep.txt').write_text('keep unknown files')
        self.reject('LEGACY_STORAGE', self.store.prepare, self.request())
        self.assertTrue(self.folder(binding).exists())
        self.assertEqual((unknown / 'keep.txt').read_text(), 'keep unknown files')

    def test_linked_or_non_private_storage_roots_are_not_initialized(self):
        outside = self.directory / 'outside'
        outside.mkdir(mode=0o700)
        (outside / 'keep.bin').write_bytes(b'outside')
        self.root.symlink_to(outside, target_is_directory=True)
        self.reject('UNSAFE_STORAGE', self.store.prepare, self.request())
        self.assertEqual((outside / 'keep.bin').read_bytes(), b'outside')
        self.root.unlink()
        self.root.mkdir(mode=0o700)
        self.root.chmod(0o755)
        self.reject('UNSAFE_STORAGE', self.store.prepare, self.request())

    def test_registered_volume_folder_link_cannot_publish_source_into_an_external_tree(self):
        binding = self.clean_project(files=[transfer('main.js', 'preserve baseline')])
        folder = self.folder(binding)
        outside = self.directory / 'outside-registered-volume'
        folder.rename(outside)
        folder.symlink_to(outside, target_is_directory=True)
        before = complete_bytes(outside)
        self.reject('UNSAFE_STORAGE', self.store.prepare,
                    self.request(binding['projectId'], files=[transfer('main.js', 'must not be written')]))
        self.assertEqual(complete_bytes(outside), before)

    def test_registered_resident_image_hardlink_is_not_accepted_for_another_operation(self):
        binding = self.clean_project(files=[transfer('main.js', 'preserve baseline')])
        folder = self.folder(binding)
        image = folder / 'disk.img'
        shared = self.directory / 'outside-shared-image.bin'
        os.link(image, shared)
        before = complete_bytes(folder)
        self.reject('UNSAFE_STORAGE', self.store.prepare,
                    self.request(binding['projectId'], files=[transfer('main.js', 'must not replace baseline')]))
        self.assertEqual(complete_bytes(folder), before)
        self.assertEqual(shared.read_bytes(), image.read_bytes())

    def test_pending_sleep_transition_does_not_trust_a_replaced_volume_directory_link(self):
        first = self.fill()[0]
        source = self.folder(first)
        rename = pathlib.Path.rename
        def interrupted_rename(file, target):
            if file == source:
                raise SimulatedCrash('intent recorded before rename')
            return rename(file, target)
        with mock.patch.object(pathlib.Path, 'rename', interrupted_rename):
            with self.assertRaises(SimulatedCrash):
                self.store.prepare(self.request())
        outside = self.directory / 'outside-pending-transition'
        source.rename(outside)
        source.symlink_to(outside, target_is_directory=True)
        before = complete_bytes(outside)
        self.reopen()
        self.reject('UNSAFE_STORAGE', self.store.prepare, self.request())
        self.assertEqual(complete_bytes(outside), before)
        self.assertEqual(len(self.backend.created), 8)

    def test_pending_deletion_does_not_treat_a_dangling_directory_link_as_completed(self):
        binding = self.clean_project()
        folder = self.folder(binding)
        with mock.patch.object(self.backend, 'delete_exact', side_effect=SimulatedCrash('before deletion')):
            self.reject('DELETE_UNCERTAIN', self.retire, binding)
        outside = self.directory / 'outside-pending-delete'
        folder.rename(outside)
        folder.symlink_to(self.directory / 'missing-target', target_is_directory=True)
        before = complete_bytes(outside)
        self.reopen()
        self.reject('UNSAFE_STORAGE', self.retire, binding)
        self.assertEqual(complete_bytes(outside), before)

    def test_registry_cannot_forget_a_stable_identity_and_silently_allocate_it_again(self):
        binding = self.clean_project()
        original = self.store.file.read_bytes()
        key = lifecycle.project_key('manual', binding['projectId'])
        allocated = len(self.backend.allocations)
        for value in (None, {}):
            with self.subTest(identity=value):
                data = json.loads(original)
                if value is None:
                    data['records'][key].pop('identity')
                else:
                    data['records'][key]['identity'] = value
                self.store.file.write_text(json.dumps(data))
                self.reject('UNSAFE_STORAGE', self.store.prepare, self.request())
                self.assertEqual(len(self.backend.allocations), allocated)
                self.store.file.write_bytes(original)

    def test_source_snapshot_failure_keeps_dirty_state_and_refuses_acknowledgement(self):
        binding = self.store.prepare(self.request())
        self.store.claim({**binding, 'mode': 'build'})
        outside = self.directory / 'outside-source.txt'
        outside.write_text('external fixture contents')
        (self.folder(binding) / 'root/workspace/linked.js').symlink_to(outside)
        finished = self.store.finish(binding, False)
        self.assertTrue(finished['dirty'])
        self.assertIsNone(finished['sourceDigest'])
        self.reject('UNSAFE_STORAGE', self.store.capture, binding)
        self.store.release(binding)
        self.reject('RECOVERY_REQUIRED', self.store.prepare, self.request(binding['projectId']))
        self.assertEqual(outside.read_text(), 'external fixture contents')


    def test_overview_is_one_global_registry_read_and_preserves_every_inode_and_byte(self):
        self.clean_project(namespace='manual')
        self.clean_project(namespace='test')
        def state():
            return {str(p.relative_to(self.directory)): ((s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns),
                    p.read_bytes() if p.is_file() else None)
                    for p in [self.directory, *self.directory.rglob('*')] for s in [p.lstat()]}
        before = state()
        with mock.patch.object(self.store, '_read', wraps=self.store._read) as read, \
             mock.patch.object(self.store, '_save', side_effect=AssertionError('Overview wrote metadata')), \
             mock.patch.object(self.store, '_reconcile', side_effect=AssertionError('Overview reconciled')), \
             mock.patch.object(self.store, '_idle', side_effect=AssertionError('Overview inspected task processes')), \
             mock.patch.object(self.backend, 'mount', side_effect=AssertionError('Overview mounted a volume')), \
             mock.patch.object(self.backend, 'allocate_identity', side_effect=AssertionError('Overview allocated an identity')):
            value = self.store.overview()
        read.assert_called_once_with()
        self.assertEqual(before, state())
        self.assertEqual(value['counts'], {'allocatedProjects': 2, 'residentReserved': 2, 'freeSlots': 6,
                                          'resident': 2, 'sleeping': 0, 'allocatedLogicalBytes': 2 * self.store.volume_bytes,
                                          'retainedBackupBytes': 0, 'stagingLogicalBytes': 0})
        self.assertEqual({r['namespace'] for r in value['projects']}, {'manual', 'test'})
        self.assertTrue(value['ready'] and value['countsTrusted'])
        public = json.dumps(value)
        for private in ('"token":', '"operationId":', '"uid":', '"identity":', str(self.directory)):
            self.assertNotIn(private, public)

    def test_overview_empty_guest_is_read_only_and_still_checks_identity_readiness(self):
        self.backend.identity_readiness = mock.Mock()
        value = self.store.overview()
        self.backend.identity_readiness.assert_called_once_with()
        self.assertEqual(value['counts']['freeSlots'], 8)
        self.assertFalse(any(self.directory.iterdir()))
        self.backend.identity_readiness.side_effect = lifecycle.LifecycleError('IDENTITY_PROVISIONING_REQUIRED', 'Audit required')
        self.reject('IDENTITY_PROVISIONING_REQUIRED', self.store.overview)
        self.assertFalse(any(self.directory.iterdir()))

    def test_overview_counts_dirty_sleeping_projects_and_both_namespaces(self):
        first = self.clean_project(namespace='test')
        data = self.registry()
        data['records'][lifecycle.project_key('test', first['projectId'])]['dirty'] = True
        self.store._save(data)
        self.fill(8)
        value = self.store.overview()
        self.assertEqual(value['counts'], {'allocatedProjects': 9, 'residentReserved': 8, 'freeSlots': 0,
                                          'resident': 8, 'sleeping': 1, 'allocatedLogicalBytes': 9 * self.store.volume_bytes,
                                          'retainedBackupBytes': 0, 'stagingLogicalBytes': 0})
        sleeping = next(r for r in value['projects'] if r['namespace'] == 'test')
        self.assertTrue(sleeping['dirty'])
        self.assertEqual(sleeping['residency'], 'archived')
        self.assertTrue(value['countsTrusted'])

    def test_overview_reserves_an_archived_to_resident_intent_without_reconciling(self):
        first = self.fill(9)[0]
        data = self.registry()
        key = lifecycle.project_key('manual', first['projectId'])
        # Make one resident sleep, then record the wake intent before its rename.
        resident_key, resident = next((k, r) for k, r in data['records'].items() if r['state'] == 'resident')
        self.store._transition(data, resident_key, resident, 'archived')
        record = data['records'][key]
        record['transition'] = {'from': 'archived', 'to': 'resident',
                                'sha256': lifecycle.file_hash(self.store.cold / key / 'disk.img')}
        self.store._save(data)
        before = self.store.file.read_bytes()
        for renamed in (False, True):
            if renamed:
                (self.store.cold / key).rename(self.root / key)
            value = self.store.overview()
            self.assertEqual(value['counts']['residentReserved'], 8)
            self.assertEqual(value['counts']['resident'], 7)
            self.assertEqual(value['counts']['sleeping'], 1)
            self.assertIsNone(value['counts']['freeSlots'])
            self.assertFalse(value['countsTrusted'])
            self.assertEqual(self.store.file.read_bytes(), before)

    def test_overview_creation_and_recovery_keep_reservations_but_offer_no_free_slots(self):
        binding = self.clean_project()
        key = lifecycle.project_key('manual', binding['projectId'])
        for phase in ('creating', 'recovery'):
            data = self.registry()
            data['records'][key]['state'] = phase
            self.store._save(data)
            value = self.store.overview()
            self.assertEqual(value['projects'][0]['residency'], phase)
            self.assertEqual(value['counts']['residentReserved'], 1)
            self.assertIsNone(value['counts']['freeSlots'])
            self.assertFalse(value['countsTrusted'])

    def test_overview_sleep_intent_preserves_the_resident_reservation_before_and_after_rename(self):
        first = self.fill()[0]
        data = self.registry()
        key = lifecycle.project_key('manual', first['projectId'])
        record = data['records'][key]
        record['transition'] = {'from': 'resident', 'to': 'archived',
                                'sha256': lifecycle.file_hash(self.root / key / 'disk.img')}
        self.store._save(data)
        before = self.store.file.read_bytes()
        for renamed in (False, True):
            if renamed:
                self.store._directory(self.store.cold, True)
                (self.root / key).rename(self.store.cold / key)
            value = self.store.overview()
            self.assertEqual(value['counts']['residentReserved'], 8)
            self.assertEqual(value['counts']['resident'], 7)
            self.assertEqual(value['counts']['sleeping'], 0)
            self.assertIsNone(value['counts']['freeSlots'])
            self.assertEqual(self.store.file.read_bytes(), before)
        owner = self.store.cold / key / 'owner.json'
        owner.write_text('{}')
        self.reject('UNSAFE_STORAGE', self.store.overview)

    def test_overview_deletion_intent_retains_the_allocation_even_after_the_folder_is_gone(self):
        binding = self.clean_project()
        data = self.registry()
        key = lifecycle.project_key('manual', binding['projectId'])
        folder = self.folder(binding)
        entries = self.backend.deletion_plan(folder)
        data['records'][key]['transition'] = {'from': 'resident', 'to': 'deleted', 'entries': entries}
        self.store._save(data)
        before = self.store.file.read_bytes()
        for deleted in (False, True):
            if deleted:
                self.backend.delete_exact(folder, entries)
            value = self.store.overview()
            self.assertEqual(value['counts']['allocatedProjects'], 1)
            self.assertEqual(value['counts']['residentReserved'], 1)
            self.assertEqual(value['counts']['resident'], 0)
            self.assertIsNone(value['counts']['freeSlots'])
            self.assertEqual(value['projects'][0]['transition'], {'from': 'resident', 'to': 'deleted'})
            self.assertEqual(self.store.file.read_bytes(), before)

    def test_overview_distinguishes_task_phases_without_equating_a_lease_with_running(self):
        binding = self.store.prepare(self.request())
        self.assertEqual(self.store.overview()['projects'][0]['tasks'][0]['phase'], 'prepared')
        self.store.claim({**binding, 'mode': 'build'})
        self.assertEqual(self.store.overview()['projects'][0]['tasks'][0]['phase'], 'running')
        self.store.cancel(binding)
        self.assertEqual(self.store.overview()['projects'][0]['tasks'][0]['phase'], 'cancel-requested')
        self.store.finish(binding, True)
        self.assertEqual(self.store.overview()['projects'][0]['tasks'][0]['phase'], 'finished-awaiting-ack')
        captured = self.store.capture(binding)
        self.store.acknowledge({**binding, 'snapshotId': captured['snapshotId']})
        self.assertEqual(self.store.overview()['projects'][0]['tasks'][0]['phase'], 'finished')
        self.clock += 121
        before = self.store.file.read_bytes()
        value = self.store.overview()
        self.assertEqual(value['projects'][0]['tasks'][0]['phase'], 'expired-uncertain')
        self.assertFalse(value['countsTrusted'])
        self.assertIsNone(value['counts']['freeSlots'])
        self.assertEqual(self.store.file.read_bytes(), before)

    def test_overview_unknown_paths_missing_images_and_unfinished_metadata_fail_closed(self):
        binding = self.clean_project()
        unknown = self.root / 'unknown'
        unknown.mkdir(mode=0o700)
        self.reject('LEGACY_STORAGE', self.store.overview)
        unknown.rmdir()
        image = self.folder(binding) / 'disk.img'
        saved = image.read_bytes()
        image.unlink()
        self.reject('RECOVERY_REQUIRED', self.store.overview)
        image.write_bytes(saved)
        image.chmod(0o600)
        pending = self.store.metadata / 'registry.json.pending.tmp'
        pending.write_text('unfinished')
        self.reject('UNSAFE_STORAGE', self.store.overview)
        self.assertEqual(pending.read_text(), 'unfinished')

    def test_overview_malformed_records_operations_and_limits_never_report_available_slots(self):
        binding = self.store.prepare(self.request())
        original = self.registry()
        key = lifecycle.project_key('manual', binding['projectId'])
        changes = [lambda d: d['records'][key].update(generation=True),
                   lambda d: d['records'][key].update(namespace='test'),
                   lambda d: d['records'][key].update(pinned='yes'),
                   lambda d: d['records'][key].update(syncPending='unknown'),
                   lambda d: d['operations'][binding['operationId']].update(expiresAt=float('nan')),
                   lambda d: d['operations'][binding['operationId']].update(token='untrusted'),
                   lambda d: d['operations'][binding['operationId']].update(acknowledged='untrusted'),
                   lambda d: d['operations'][binding['operationId']].update(generation=99)]
        for change in changes:
            data = json.loads(json.dumps(original)); change(data); self.store._save(data)
            with self.assertRaises(lifecycle.LifecycleError):
                self.store.overview()
        self.store._save(original)
        self.store.resident_limit = 0
        self.reject('UNSAFE_STORAGE', self.store.overview)

if __name__ == '__main__':
    unittest.main()
