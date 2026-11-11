"""Independent arithmetic and in-memory volume faults: no VM, filesystem images, processes or network."""
import copy
import hashlib
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('guest_capacity_profiles', pathlib.Path(__file__).with_name('guest_capacity_profiles.py'))
capacity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capacity)
MiB = 1024 * 1024


def volume(number=1, profile=None, state='resident', project=None, payload=b'original source and installed dependencies'):
    return {'version': 1 if profile is None else 2, 'volumeId': format(number, '032x'), 'namespace': 'test',
        'projectId': project or '11111111-1111-4111-8111-' + format(number, '012x'), 'generation': 7,
        'state': state, 'residentReserved': state in ('resident', 'staging'), 'unmountedVerified': state in ('archived', 'retained-backup'),
        'allocatedBytes': len(payload), 'imageSha256': hashlib.sha256(payload).hexdigest(),
        'sourceSnapshotId': hashlib.sha256(b'snapshot:' + payload).hexdigest(), 'dirty': False, 'syncPending': False,
        'activeOperations': 0, **({'legacyContract': 'current-64'} if profile is None else {'profileId': profile})}


def observation():
    return {'fresh': True, 'ledgerComplete': True, 'freePhysicalBytes': 16 * 1024 * MiB, 'freePhysicalInodes': 100000,
        'reservedPhysicalBytes': 0, 'reservedPhysicalInodes': 0, 'projectFreeBytes': 256 * MiB, 'projectFreeInodes': 8192,
        'operations': 0, 'recoveryRemainingBytes': 512 * MiB}


def peaks():
    return {'additionalOperations': 1, 'controlBytes': 16 * MiB, 'controlInodes': 16, 'rootFloorInodes': 128,
        'sourceBytes': 8 * MiB, 'sourceInodes': 10, 'dependencyBytes': 64 * MiB, 'dependencyInodes': 1000,
        'cacheBytes': 16 * MiB, 'cacheInodes': 100,
        'buildBytes': 32 * MiB, 'buildInodes': 200, 'projectFloorBytes': 16 * MiB, 'projectFloorInodes': 128,
        'cumulativeMediaBytes': 64 * MiB, 'largestMediaFileBytes': 32 * MiB, 'mediaWindowBytes': 64 * MiB,
        'candidateReturnBytes': 64 * MiB, 'recoveryPeakBytes': 512 * MiB}


def migration(source, target='capacity-128-v1'):
    return {'version': 2, 'id': 'a' * 32, 'namespace': source['namespace'], 'projectId': source['projectId'],
        'generation': source['generation'], 'fromVolumeId': source['volumeId'], 'toVolumeId': 'b' * 32,
        'fromProfileId': source.get('profileId'), 'toProfileId': target, 'sourceImageSha256': source['imageSha256'],
        'sourceSnapshotId': source['sourceSnapshotId'], 'phase': 'planned', 'targetImageSha256': None,
        'oldVolumeRetained': True, 'runtimeEnabled': False, 'simulationOnly': True}


class CandidateCapacityProfiles(unittest.TestCase):
    def test_fixed_descriptors_are_frozen_and_never_make_even_current_sized_profiles_runtime_available(self):
        expected = [('capacity-64-v1', 256, 64, 8192), ('capacity-128-v1', 512, 128, 16384), ('capacity-256-v1', 1024, 256, 32768)]
        for name, image, media, inodes in expected:
            with self.subTest(profile=name):
                value = capacity.profile(name)
                self.assertEqual((value['volumeBytes'], value['mediaBytes'], value['inodeCount']), (image * MiB, media * MiB, inodes))
                self.assertEqual((value['mediaFileBytes'], value['mediaWindowBytes'], value['recoveryBytes']), (32 * MiB, 64 * MiB, 512 * MiB))
                self.assertEqual((value['globalVolumeBytes'], value['residentVolumes'], value['globalOperations'], value['reserveBytes']), (4096 * MiB, 8, 2, 1024 * MiB))
                self.assertFalse(value['runtimeEnabled']); self.assertTrue(value['simulationOnly'])
                with self.assertRaises(TypeError): value['runtimeEnabled'] = True
        self.assertTrue(capacity.LEGACY_CURRENT['informationalOnly']); self.assertFalse(capacity.LEGACY_CURRENT['automaticUpgrade'])
        for invalid in (None, '', 'current-64', 'capacity-512-v1', True):
            with self.subTest(invalid=invalid), self.assertRaises(capacity.ProfileError): capacity.profile(invalid)

    def test_legacy_load_does_not_mutate_upgrade_or_invent_a_profile_and_unknown_schemas_are_rejected(self):
        legacy = volume(); before = copy.deepcopy(legacy)
        parsed = capacity.parse_volume(legacy)
        self.assertEqual(parsed, before); self.assertEqual(legacy, before); self.assertNotIn('profileId', parsed)
        for change in ({'version': True}, {'version': 3}, {'legacyContract': 'unknown'}, {'profileId': 'capacity-128-v1'}, {'allocatedBytes': False}, {'unmountedVerified': 1}):
            with self.subTest(change=change), self.assertRaises((capacity.ProfileError, ValueError)):
                capacity.parse_volume({**legacy, **change})
        self.assertEqual(legacy, before)

    def test_weighted_global_budget_counts_old_staging_and_all_retained_backups(self):
        values = [volume(index, state='archived') for index in range(1, 9)]
        values += [volume(index, 'capacity-128-v1', state='retained-backup') for index in range(9, 13)]
        ledger = capacity.weighted_ledger(values)
        self.assertEqual(ledger['logicalBytes'], 4096 * MiB); self.assertEqual(ledger['retainedBackupBytes'], 2048 * MiB)
        self.assertEqual(capacity.assess_capacity('capacity-128-v1', values, observation(), peaks())['checks']['globalLogicalBytes']['status'], 'fits')
        values.append(volume(13, 'capacity-128-v1', state='staging'))
        result = capacity.assess_capacity('capacity-128-v1', values, observation(), peaks())
        self.assertEqual(result['checks']['globalLogicalBytes'], {'status': 'blocked', 'required': 4608 * MiB, 'available': 4096 * MiB})
        self.assertFalse(result['runtimeEnabled'])

    def test_resident_images_and_operations_are_independent_and_migration_does_not_merge_two_slots(self):
        values = [volume(index) for index in range(1, 9)]
        values.append(volume(20, 'capacity-128-v1', state='staging', project=values[0]['projectId']))
        result = capacity.assess_capacity('capacity-128-v1', values, observation(), peaks())
        self.assertEqual(result['ledger']['residentVolumes'], 9); self.assertEqual(result['checks']['residentVolumes']['status'], 'blocked')
        ops = capacity.assess_capacity('capacity-128-v1', [volume()], {**observation(), 'operations': 2}, peaks())
        self.assertEqual(ops['checks']['globalOperations'], {'status': 'blocked', 'required': 3, 'available': 2})
        inconsistent = capacity.assess_capacity('capacity-128-v1', [{**volume(), 'activeOperations': 1}], observation(), peaks())
        self.assertEqual(inconsistent['checks']['globalOperations']['status'], 'unknown')
        with self.assertRaises(capacity.ProfileError): capacity.weighted_ledger([volume(), volume()])

    def test_unknown_or_stale_free_space_allocations_ledger_and_peaks_do_not_become_zero(self):
        variants = [('freePhysicalBytes', None, 'backingPhysicalBytes'), ('freePhysicalInodes', None, 'backingInodes'),
            ('projectFreeBytes', None, 'projectAdditionalBytes'), ('projectFreeInodes', None, 'projectAdditionalInodes'),
            ('reservedPhysicalBytes', None, 'backingPhysicalBytes'), ('recoveryRemainingBytes', None, 'recoveryRemainingBytes')]
        for key, value, check in variants:
            result = capacity.assess_capacity('capacity-128-v1', [volume()], {**observation(), key: value}, peaks())
            self.assertEqual(result['checks'][check]['status'], 'unknown'); self.assertEqual(result['status'], 'unknown')
        for key in ('dependencyBytes', 'dependencyInodes', 'cacheBytes', 'cacheInodes', 'buildBytes', 'buildInodes'):
            result = capacity.assess_capacity('capacity-128-v1', [volume()], observation(), {**peaks(), key: None})
            self.assertEqual(result['checks'][key]['status'], 'unknown'); self.assertEqual(result['status'], 'unknown')
        unknown_image = {**volume(), 'allocatedBytes': None}
        self.assertIsNone(capacity.weighted_ledger([unknown_image])['growthBytes'])
        self.assertEqual(capacity.assess_capacity('capacity-128-v1', [unknown_image], observation(), peaks())['checks']['backingPhysicalBytes']['status'], 'unknown')
        for changed in ({'fresh': False}, {'ledgerComplete': False}):
            result = capacity.assess_capacity('capacity-128-v1', [volume()], {**observation(), **changed}, peaks())
            self.assertEqual(result['checks']['globalLogicalBytes']['status'], 'unknown')
        corrupt = {**volume(), 'version': 2, 'profileId': 'unknown'}; corrupt.pop('legacyContract')
        report = capacity.assess_capacity('capacity-128-v1', [corrupt], observation(), peaks())
        self.assertIsNone(report['ledger']); self.assertIsNone(report['checks']['globalLogicalBytes']['required'])

    def test_backing_reserve_and_project_dependency_build_peaks_and_inodes_are_separate(self):
        image = volume(); ledger = capacity.weighted_ledger([image])
        result = capacity.assess_capacity('capacity-128-v1', [image], observation(), peaks())
        self.assertEqual(result['checks']['backingPhysicalBytes']['required'], ledger['growthBytes'] + 1024 * MiB + 16 * MiB)
        self.assertEqual(result['checks']['projectAdditionalBytes']['required'], 136 * MiB)
        self.assertEqual(result['checks']['projectAdditionalInodes']['required'], 1438)
        for change, check in (({'freePhysicalBytes': 1024 * MiB}, 'backingPhysicalBytes'), ({'projectFreeBytes': 135 * MiB}, 'projectAdditionalBytes'), ({'projectFreeInodes': 1437}, 'projectAdditionalInodes'), ({'freePhysicalInodes': 1}, 'backingInodes')):
            report = capacity.assess_capacity('capacity-128-v1', [image], {**observation(), **change}, peaks())
            self.assertEqual(report['checks'][check]['status'], 'blocked')

    def test_cumulative_media_does_not_raise_single_file_window_candidate_or_recovery_limits(self):
        wanted = {**peaks(), 'cumulativeMediaBytes': 128 * MiB}
        current = capacity.assess_capacity('capacity-64-v1', [], observation(), wanted)
        larger = capacity.assess_capacity('capacity-128-v1', [], observation(), wanted)
        self.assertEqual(current['checks']['cumulativeMediaBytes']['status'], 'blocked'); self.assertEqual(larger['status'], 'fits')
        for name, amount in (('largestMediaFileBytes', 33), ('mediaWindowBytes', 65), ('candidateReturnBytes', 65), ('recoveryPeakBytes', 513)):
            result = capacity.assess_capacity('capacity-256-v1', [], observation(), {**wanted, name: amount * MiB})
            self.assertEqual(result['checks'][name]['status'], 'blocked')
        result = capacity.assess_capacity('capacity-256-v1', [], {**observation(), 'recoveryRemainingBytes': MiB}, peaks())
        self.assertEqual(result['checks']['recoveryRemainingBytes']['status'], 'blocked')


class SimulatedProfileMigrations(unittest.TestCase):
    def setup_ledger(self, source=None):
        source = source or volume(); data = b'original source and installed dependencies'
        return source, capacity.SimulatedVolumeLedger([source], {source['volumeId']: data}), data

    def test_full_verified_migration_keeps_old_bytes_and_charges_backup_then_stops_replay(self):
        source, ledger, data = self.setup_ledger(); plan = migration(source)
        before = copy.deepcopy(source); result = ledger.begin(plan, observation(), peaks(), True)
        self.assertFalse(result['runtimeEnabled']); self.assertEqual(capacity.weighted_ledger(list(ledger.volumes.values()))['logicalBytes'], 768 * MiB)
        self.assertEqual(capacity.weighted_ledger(list(ledger.volumes.values()))['residentVolumes'], 2)
        with self.assertRaises(capacity.ProfileError): ledger.copy(plan['id'])
        ledger.confirm_unmounted(plan['id'], source['imageSha256']); ledger.copy(plan['id']); ledger.verify(plan['id'])
        self.assertEqual(ledger.inspect(plan['id']), 'verified-ready'); ledger.commit(plan['id'])
        self.assertEqual(ledger.reconcile(plan['id']), 'committed-verified')
        self.assertEqual(ledger.payloads[source['volumeId']], data); self.assertEqual(ledger.payloads[plan['toVolumeId']], data)
        self.assertEqual(source, before); self.assertEqual(ledger.volumes[source['volumeId']]['version'], 1)
        self.assertNotIn('profileId', ledger.volumes[source['volumeId']])
        self.assertEqual(ledger.volumes[source['volumeId']]['state'], 'retained-backup')
        self.assertTrue(ledger.volumes[source['volumeId']]['unmountedVerified'])
        charged = capacity.weighted_ledger(list(ledger.volumes.values()))
        self.assertEqual(charged['logicalBytes'], 768 * MiB); self.assertEqual(charged['residentVolumes'], 1); self.assertEqual(charged['retainedBackupBytes'], 256 * MiB)
        self.assertEqual(ledger.volumes[plan['toVolumeId']]['generation'], source['generation'] + 1)
        effects = copy.deepcopy(ledger.effects)
        for _ in range(3): self.assertEqual(ledger.reconcile(plan['id']), 'committed-verified')
        with self.assertRaises(capacity.ProfileError): ledger.copy(plan['id'])
        with self.assertRaises(capacity.ProfileError): ledger.commit(plan['id'])
        self.assertEqual(ledger.effects, effects)

    def test_dirty_sync_active_uncertain_or_insufficient_capacity_leaves_source_and_ledger_untouched(self):
        for change, settled in (({'dirty': True}, True), ({'syncPending': True}, True), ({'activeOperations': 1}, True), ({}, None), ({}, False)):
            source = {**volume(), **change}; source, ledger, _ = self.setup_ledger(source)
            before = copy.deepcopy((ledger.volumes, ledger.payloads, ledger.active, ledger.effects))
            with self.assertRaises(capacity.ProfileError): ledger.begin(migration(source), observation(), peaks(), settled)
            self.assertEqual((ledger.volumes, ledger.payloads, ledger.active, ledger.effects), before)
        for changed in ({'fresh': False}, {'projectFreeInodes': 1}, {'freePhysicalBytes': MiB}):
            source, ledger, _ = self.setup_ledger(); before = copy.deepcopy(ledger.volumes)
            with self.assertRaises(capacity.ProfileError): ledger.begin(migration(source), {**observation(), **changed}, peaks(), True)
            self.assertEqual(ledger.volumes, before); self.assertEqual(ledger.migrations, {})

    def test_partial_copy_resize_failure_or_changed_original_stays_blocked_without_replaying_copy(self):
        for fault in ('partial', 'resize', 'changed-original'):
            source, ledger, data = self.setup_ledger(); plan = migration(source)
            ledger.begin(plan, observation(), peaks(), True); ledger.confirm_unmounted(plan['id'], source['imageSha256'])
            if fault == 'changed-original': ledger.payloads[source['volumeId']] += b'changed'
            with self.assertRaises(capacity.ProfileError): ledger.copy(plan['id'], fail_after=3 if fault == 'partial' else None, resize_fails=fault == 'resize')
            effects = copy.deepcopy(ledger.effects)
            for _ in range(3): self.assertEqual(ledger.reconcile(plan['id']), 'blocked')
            self.assertEqual(ledger.effects, effects); self.assertEqual(ledger.active[(source['namespace'], source['projectId'])], source['volumeId'])
            if fault != 'changed-original': self.assertEqual(ledger.payloads[source['volumeId']], data)
            self.assertEqual(capacity.weighted_ledger(list(ledger.volumes.values()))['logicalBytes'], 768 * MiB)

    def test_commit_reply_loss_only_reconciles_verified_pointer_metadata_and_never_replays_io(self):
        source, ledger, data = self.setup_ledger(); plan = migration(source)
        ledger.begin(plan, observation(), peaks(), True); ledger.confirm_unmounted(plan['id'], source['imageSha256'])
        ledger.copy(plan['id']); ledger.verify(plan['id']); ledger.commit(plan['id'], lose_final_record=True)
        self.assertEqual(ledger.migrations[plan['id']]['phase'], 'verified'); effects = copy.deepcopy(ledger.effects)
        self.assertEqual(ledger.reconcile(plan['id']), 'committed-verified'); self.assertEqual(ledger.migrations[plan['id']]['phase'], 'committed')
        self.assertEqual(ledger.effects, effects); self.assertEqual(ledger.payloads[source['volumeId']], data)
        ledger.volumes[source['volumeId']]['unmountedVerified'] = False
        self.assertEqual(ledger.inspect(plan['id']), 'blocked')

    def test_precommit_loss_keeps_one_old_registry_and_corrupt_verified_targets_cannot_publish(self):
        source, ledger, data = self.setup_ledger(); plan = migration(source)
        ledger.begin(plan, observation(), peaks(), True); ledger.confirm_unmounted(plan['id'], source['imageSha256'])
        ledger.copy(plan['id']); ledger.verify(plan['id'])
        before = copy.deepcopy((ledger.volumes, ledger.active, ledger.migrations, ledger.effects))
        with self.assertRaises(capacity.ProfileError): ledger.commit(plan['id'], fail_before_pointer=True)
        self.assertEqual((ledger.volumes, ledger.active, ledger.migrations, ledger.effects), before)
        self.assertEqual(ledger.reconcile(plan['id']), 'verified-ready')
        self.assertEqual(ledger.effects['copy'], 1); self.assertEqual(ledger.effects['simulatedResize'], 1)
        ledger.payloads[plan['toVolumeId']] += b'corrupted'
        with self.assertRaises(capacity.ProfileError): ledger.commit(plan['id'])
        self.assertEqual(ledger.active[(source['namespace'], source['projectId'])], source['volumeId'])
        self.assertEqual(ledger.payloads[source['volumeId']], data); self.assertEqual(ledger.effects['pointerCommit'], 0)

    def test_wrong_generation_profile_snapshot_or_unknown_schema_never_grants_migration_authority(self):
        source, ledger, _ = self.setup_ledger(); plan = migration(source)
        for change in ({'version': 1}, {'runtimeEnabled': True}, {'oldVolumeRetained': False}, {'toProfileId': 'capacity-64-v1'}, {'path': '/arbitrary'}, {'generation': source['generation'] + 1}, {'sourceSnapshotId': 'f' * 64}, {'fromProfileId': 'capacity-64-v1'}):
            with self.subTest(change=change), self.assertRaises((capacity.ProfileError, ValueError)): ledger.begin({**plan, **change}, observation(), peaks(), True)
        self.assertEqual(ledger.migrations, {}); self.assertEqual(len(ledger.volumes), 1)

    def test_pending_migrations_still_occupy_global_operation_reservations(self):
        data = b'original source and installed dependencies'; values = [volume(index) for index in (1, 2, 3)]
        ledger = capacity.SimulatedVolumeLedger(values, {item['volumeId']: data for item in values})
        first = migration(values[0]); ledger.begin(first, observation(), peaks(), True)
        second = {**migration(values[1]), 'id': 'c' * 32, 'toVolumeId': 'd' * 32}
        before = copy.deepcopy(ledger.volumes)
        with self.assertRaises(capacity.ProfileError): ledger.begin(second, observation(), peaks(), True)
        self.assertEqual(ledger.volumes, before)
        ledger.begin(second, {**observation(), 'operations': 1}, peaks(), True)
        third = {**migration(values[2]), 'id': 'e' * 32, 'toVolumeId': 'f' * 32}
        with self.assertRaises(capacity.ProfileError): ledger.begin(third, {**observation(), 'operations': 2}, peaks(), True)
        self.assertNotIn(third['id'], ledger.migrations)


if __name__ == '__main__':
    unittest.main()
