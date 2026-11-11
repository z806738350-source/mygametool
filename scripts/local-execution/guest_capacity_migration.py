"""Native-only, durable profile approval and exact-image migration. No project commands."""
import copy
import json
import math
import os
import re
import stat
import uuid
from types import SimpleNamespace
from guest_runtime_capacity import RUNTIME_PROFILE, RUNTIME_PROFILES, runtime_profile


def exact_json(left, right):
    return json.dumps(left, sort_keys=True, ensure_ascii=True, separators=(',', ':')) == json.dumps(right, sort_keys=True, ensure_ascii=True, separators=(',', ':'))


def pending_plan(data, identifier, now):
    state = data['capacityPlanStates'][identifier]
    if state['phase'] == 'authorized':
        plan = data['capacityPlans'][identifier]
        approval = data['capacityAuthorizations'][state['authorizationId']]
        return not plan['source']['absent'] or min(plan['expiresAt'], approval['expiresAt']) >= now
    return state['phase'] in ('started', 'unknown')


def stable_image_identity(file, size):
    info = file.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid()
            or info.st_mode & 0o177 or info.st_size != size or file.resolve() != file):
        raise ValueError('The registered capacity image identity changed')
    # A later legitimate filesystem write changes times/hash; stable inode and ownership remain exact.
    return {name: str(getattr(info, name)) for name in ('st_dev', 'st_ino', 'st_size', 'st_uid', 'st_gid', 'st_mode')}


def plan_id(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('Invalid immutable capacity plan identity')
    return value


def validate_metadata(data, fail):
    plans, states, authorizations = (data.get(key, {}) for key in ('capacityPlans', 'capacityPlanStates', 'capacityAuthorizations'))
    if any(not isinstance(value, dict) or len(value) > 128 for value in (plans, states, authorizations)):
        fail('UNSAFE_STORAGE', 'Capacity approval history requires separate inspection')
    if set(plans) != set(states):
        fail('UNSAFE_STORAGE', 'Capacity plan state lost its immutable plan')
    pending_projects = set()
    for identifier, plan in plans.items():
        plan_id(identifier)
        if (not isinstance(plan, dict) or set(plan) != {'version', 'planId', 'namespace', 'projectId', 'sourceProfileId', 'kind', 'status', 'expiresAt', 'source', 'target', 'budget', 'blockers'}
                or plan.get('planId') != identifier or type(plan.get('version')) is not int or plan['version'] != 1
                or plan.get('status') not in ('ready', 'blocked') or plan.get('kind') not in ('create', 'enlarge')
                or plan.get('namespace') not in ('manual', 'test') or plan.get('sourceProfileId') not in RUNTIME_PROFILES
                or not isinstance(plan.get('source'), dict) or not isinstance(plan.get('target'), dict)
                or plan['target'].get('sourceProfileId') != plan['sourceProfileId'] or not exact_json(plan['target'].get('limits'), dict(runtime_profile(plan['sourceProfileId'])))
                or not re.fullmatch('[a-f0-9]{32}', str(plan['target'].get('volumeId')))
                or not re.fullmatch('[a-f0-9]{64}', str(plan['target'].get('targetBaseManifestId')))
                or type(plan.get('expiresAt')) not in (int, float) or not math.isfinite(plan['expiresAt'])
                or not isinstance(plan.get('budget'), dict) or not isinstance(plan.get('blockers'), list)):
            fail('UNSAFE_STORAGE', 'Unknown immutable capacity plan contract')
        source = plan['source']
        if (set(source) != {'absent', 'generation', 'imageId', 'imageSha256', 'sourceSnapshotId', 'sourceManifestVersion', 'sourceBaseManifestId', 'volumeBytes'}
                or type(source['absent']) is not bool or type(source['generation']) is not int or type(source['volumeBytes']) is not int
                or set(plan['target']) != {'sourceProfileId', 'volumeId', 'limits', 'targetBaseManifestId'}):
            fail('UNSAFE_STORAGE', 'Unknown capacity source or target identity')
        if source['absent']:
            if (plan['kind'] != 'create' or source['generation'] != 0 or source['volumeBytes'] != 0
                    or any(source[name] is not None for name in ('imageId', 'imageSha256', 'sourceSnapshotId', 'sourceManifestVersion', 'sourceBaseManifestId'))):
                fail('UNSAFE_STORAGE', 'An absent source cannot claim an image or an authenticated baseline')
        elif (plan['kind'] != 'enlarge' or source['generation'] < 1 or source['volumeBytes'] != 256 * 1024 * 1024
                or source['imageId'] != 'legacy' or not re.fullmatch('[a-f0-9]{64}', str(source['imageSha256']))
                or not re.fullmatch('[a-f0-9]{64}', str(source['sourceSnapshotId']))
                or source['sourceManifestVersion'] is not None and (type(source['sourceManifestVersion']) is not int or source['sourceManifestVersion'] != 1)
                or source['sourceManifestVersion'] is None and source['sourceBaseManifestId'] is not None
                or source['sourceManifestVersion'] == 1 and not re.fullmatch('[a-f0-9]{64}', str(source['sourceBaseManifestId']))):
            fail('UNSAFE_STORAGE', 'The original legacy image identity is incomplete')
        state = states[identifier]
        if not isinstance(state, dict) or state.get('phase') not in ('planned', 'authorized', 'started', 'unknown', 'committed'):
            fail('UNSAFE_STORAGE', 'Capacity migration completion is unconfirmed')
        expected_state = {'phase'} if state['phase'] == 'planned' else {'phase', 'authorizationId'}
        if state['phase'] == 'committed': expected_state |= {'result', 'targetIdentity'}
        if set(state) != expected_state:
            fail('UNSAFE_STORAGE', 'Unknown durable capacity execution state')
        if state['phase'] != 'planned' and (state['authorizationId'] not in authorizations
                or authorizations[state['authorizationId']].get('planId') != identifier):
            fail('UNSAFE_STORAGE', 'Capacity execution lost its exact native approval')
        if state['phase'] in ('started', 'unknown'):
            project = (plan['namespace'], plan['projectId'])
            if project in pending_projects:
                fail('UNSAFE_STORAGE', 'Conflicting capacity execution intents require inspection')
            pending_projects.add(project)
            key = plan['namespace'] + '-' + plan['projectId']
            record = data['records'].get(key)
            if record is None:
                if not source['absent']:
                    fail('UNSAFE_STORAGE', 'A nonempty source lost its original volume record')
            elif record.get('capacityMigration', {}).get('planId') != identifier:
                fail('UNSAFE_STORAGE', 'A capacity execution intent lost its exact project record')
        if state['phase'] == 'committed':
            identity = state['targetIdentity']
            if (not isinstance(identity, dict) or set(identity) != {'st_dev', 'st_ino', 'st_size', 'st_uid', 'st_gid', 'st_mode'}
                    or any(not isinstance(value, str) or not re.fullmatch('[0-9]+', value) for value in identity.values())
                    or not isinstance(state['result'], dict) or state['result'].get('planId') != identifier
                    or state['result'].get('authorizationId') != state['authorizationId']
                    or state['result'].get('volumeId') != plan['target']['volumeId']):
                fail('UNSAFE_STORAGE', 'Committed capacity receipt lost its stable physical identity')
    for identifier, authorization in authorizations.items():
        if (not re.fullmatch('[a-f0-9]{32}', identifier) or not isinstance(authorization, dict)
                or authorization.get('authorizationId') != identifier or authorization.get('planId') not in plans
                or authorization.get('recoveryReservationBytes') != RUNTIME_PROFILE['recoveryBytes']):
            fail('UNSAFE_STORAGE', 'Native capacity authorization requires inspection')
        plan = plans[authorization['planId']]
        if any(not exact_json(authorization.get(key), plan[key]) for key in ('namespace', 'projectId', 'source', 'target')):
            fail('UNSAFE_STORAGE', 'Native capacity authorization differs from its immutable plan')
        if type(authorization.get('expiresAt')) not in (int, float) or not 0 < authorization['expiresAt'] <= plan['expiresAt']:
            fail('UNSAFE_STORAGE', 'Native capacity authorization has an invalid deadline')


class CapacityMigration:
    def __init__(self, store, lifecycle_api):
        self.store = store
        self.l = SimpleNamespace(**lifecycle_api)

    def _scope(self, spec, keys):
        if not isinstance(spec, dict) or set(spec) != set(keys) | {'namespace', 'projectId'}:
            self.l.fail('INVALID_REQUEST', 'The capacity operation requires its exact native control fields')
        return self.l.project_key(spec['namespace'], spec['projectId'])

    def _maps(self, data):
        return tuple(data.setdefault(key, {}) for key in ('capacityPlans', 'capacityPlanStates', 'capacityAuthorizations'))

    def _existing(self, data, spec):
        key = self._scope(spec, {'planId'})
        plans, states, _ = self._maps(data)
        identifier = plan_id(spec['planId'])
        plan = plans.get(identifier)
        if not plan or (plan['namespace'], plan['projectId']) != (spec['namespace'], spec['projectId']):
            self.l.fail('INVALID_BINDING', 'Capacity plan belongs to a different project or is unavailable')
        return key, plan, states[identifier]

    def _source(self, data, key, record, profile_id):
        s = self.store
        if record is None:
            if os.path.lexists(s.root / key) or os.path.lexists(s.cold / key):
                self.l.fail('RECOVERY_REQUIRED', 'Unknown project storage cannot be treated as an absent source')
            return {'absent': True, 'generation': 0, 'imageId': None, 'imageSha256': None,
                'sourceSnapshotId': None, 'sourceManifestVersion': None, 'sourceBaseManifestId': None, 'volumeBytes': 0}, self.l.source_manifest([], profile_id)
        if (record['state'] not in ('resident', 'archived') or record['dirty'] or record.get('syncPending')
                or record.get('transition') or s._busy(data, key) or record.get('capacityMigration')):
            self.l.fail('RECOVERY_REQUIRED', 'Only a clean idle project without an unfinished operation can prepare a capacity change')
        if record.get('volumeProfileVersion') in (2, 3):
            self.l.fail('INVALID_REQUEST', 'This project already has a 512 MiB profile volume; same-size profile replacement is unsupported and the original volume is unchanged')
        s._idle(key, record)
        folder = s._folder(key, record)
        # The explicit plan operation may flush/unmount, but cannot execute project code.
        s._unmount(folder, record)
        with s._review_workspace(folder, record) as workspace:
            files = s._source_snapshot(record, workspace)
            if self.l.source_map(files) != record['baseline']:
                self.l.fail('RECOVERY_REQUIRED', 'The source changed before migration planning; its baseline was not rewritten')
            target = self.l.snapshot_source_manifest(files, profile_id)
        s._unmount(folder, record)
        inspection = s.backend.inspect_capacity_image(folder, s._image_path(folder, record), s._volume_bytes(record))
        return {'absent': False, 'generation': record['generation'], 'imageId': record.get('volumeId', 'legacy'),
            'imageSha256': inspection['imageSha256'], 'sourceSnapshotId': self.l.source_digest(files),
            'sourceManifestVersion': record.get('sourceManifestVersion'), 'sourceBaseManifestId': record.get('sourceManifestId'),
            'volumeBytes': s._volume_bytes(record)}, target

    def _budget(self, data):
        s = self.store
        images = [item for key, record in data['records'].items() if record['state'] != 'deleted' for item in s._volume_images(key, record)]
        orphan_bytes = len(s._capacity_orphans(data)) * RUNTIME_PROFILE['volumeBytes']
        logical = sum(size for _, size in images) + orphan_bytes
        growth = RUNTIME_PROFILE['volumeBytes'] + orphan_bytes
        for path, size in images:
            info = path.lstat()
            growth += max(0, size - info.st_blocks * 512)
        free = s.backend.capacity_root_space(s.root.parent)
        residents = len(s._resident_reserved(data))
        budget = {'logicalBeforeBytes': logical, 'logicalAfterBytes': logical + RUNTIME_PROFILE['volumeBytes'],
            'residentBefore': residents, 'residentDuring': residents + 1, 'availableBytes': free.get('bytes'),
            'availableInodes': free.get('inodes'), 'requiredGrowthBytes': growth, 'reserveBytes': s.reserve_bytes}
        blockers = []
        if budget['logicalAfterBytes'] > s.total_bytes: blockers.append('GLOBAL_LOGICAL_CAPACITY')
        if budget['residentDuring'] > s.resident_limit: blockers.append('RESIDENT_CAPACITY')
        if s._global_operations(data) >= 2: blockers.append('GLOBAL_OPERATION_CAPACITY')
        if type(free.get('bytes')) is not int or type(free.get('inodes')) is not int:
            blockers.append('GUEST_CAPACITY_UNKNOWN')
        else:
            if free['bytes'] < growth + s.reserve_bytes + 16 * 1024 * 1024: blockers.append('GUEST_STORAGE_FULL')
            if free['inodes'] < 8: blockers.append('GUEST_INODE_CAPACITY')
        return budget, blockers

    def plan(self, spec):
        s = self.store
        key = self._scope(spec, {'capacityProfileVersion', 'sourceProfileId', 'planId'})
        if (spec['sourceProfileId'] not in RUNTIME_PROFILES or type(spec['capacityProfileVersion']) is not int
                or spec['capacityProfileVersion'] != runtime_profile(spec['sourceProfileId'])['version']):
            self.l.fail('INVALID_REQUEST', 'Unknown runtime capacity profile')
        data = s._read(); plans, states, _ = self._maps(data)
        identifier = plan_id(spec['planId'])
        if identifier in plans:
            original = plans[identifier]
            if (original['namespace'], original['projectId'], original['sourceProfileId']) != (spec['namespace'], spec['projectId'], spec['sourceProfileId']):
                self.l.fail('INVALID_BINDING', 'Immutable capacity plan identity belongs to another request')
            return copy.deepcopy(original)
        if len(plans) >= 128: self.l.fail('METADATA_CAPACITY', 'Capacity history requires maintenance')
        for existing_id, existing_plan in plans.items():
            if (existing_plan['namespace'], existing_plan['projectId']) == (spec['namespace'], spec['projectId']) and pending_plan(data, existing_id, s.now()):
                self.l.fail('CAPACITY_MIGRATION_UNCERTAIN', 'The existing capacity plan must be verified; a new copy identity was not created')
        record = data['records'].get(key)
        if record and record['state'] == 'deleted':
            self.l.fail('GENERATION_CHANGED', 'A deleted project identity cannot be silently allocated again')
        source, target_manifest = self._source(data, key, record, spec['sourceProfileId'])
        budget, blockers = self._budget(data)
        plan = {'version': 1, 'planId': identifier, 'namespace': spec['namespace'], 'projectId': spec['projectId'],
            'sourceProfileId': spec['sourceProfileId'], 'kind': 'create' if source['absent'] else 'enlarge',
            'status': 'blocked' if blockers else 'ready', 'expiresAt': s.now() + 600, 'source': source,
            'target': {'sourceProfileId': spec['sourceProfileId'], 'volumeId': uuid.uuid4().hex, 'limits': dict(runtime_profile(spec['sourceProfileId'])),
                'targetBaseManifestId': target_manifest['manifestId']}, 'budget': budget, 'blockers': blockers}
        plans[plan['planId']] = plan; states[plan['planId']] = {'phase': 'planned'}; s._save(data)
        return copy.deepcopy(plan)

    def inspect(self, spec):
        s = self.store
        data = s._read(); key, plan, state = self._existing(data, spec)
        verified = False
        if state['phase'] == 'committed':
            record = data['records'].get(key)
            result = state.get('result', {})
            if (not record or record.get('volumeId') != plan['target']['volumeId'] or record.get('volumeProfileVersion') != runtime_profile(plan['sourceProfileId'])['version']
                    or record.get('sourceProfileId') != plan['sourceProfileId'] or record.get('sourceManifestVersion') != 2
                    or record['generation'] < result.get('generation', 1 << 60) or record.get('capacityMigration')
                    or result.get('sourceBaseManifestId') != plan['target']['targetBaseManifestId']):
                self.l.fail('CAPACITY_COMMIT_UNVERIFIED', 'The current registry does not prove the approved target image')
            folder = s._folder(key, record)
            if stable_image_identity(s._image_path(folder, record), RUNTIME_PROFILE['volumeBytes']) != state.get('targetIdentity'):
                self.l.fail('CAPACITY_COMMIT_UNVERIFIED', 'The approved target file identity changed')
            if not plan['source']['absent']:
                original = folder / 'disk.img'
                stable_image_identity(original, plan['source']['volumeBytes'])
                s.backend.assert_capacity_image_unmounted(original)
                if self.l.file_hash(original) != plan['source']['imageSha256']:
                    self.l.fail('CAPACITY_COMMIT_UNVERIFIED', 'The retained original image no longer matches its immutable plan')
            verified = True
        return {**copy.deepcopy(plan), 'phase': state['phase'],
            'expired': plan['expiresAt'] < self.store.now(), 'verified': verified,
            **({'authorizationId': state['authorizationId']} if state.get('authorizationId') else {}),
            **({'result': copy.deepcopy(state['result'])} if state.get('result') else {})}

    def register(self, spec):
        s = self.store
        self._scope(spec, {'planId', 'authorizationId', 'source', 'target', 'recoveryReservationBytes', 'expiresAt'})
        data = s._read(); key, plan, state = self._existing(data, {key: spec[key] for key in ('namespace', 'projectId', 'planId')})
        identifier = self.l.operation(spec['authorizationId'])
        _, _, authorizations = self._maps(data)
        if (plan['status'] != 'ready' or plan['expiresAt'] < s.now() or not exact_json(spec['source'], plan['source']) or not exact_json(spec['target'], plan['target'])
                or type(spec['recoveryReservationBytes']) is not int or spec['recoveryReservationBytes'] != RUNTIME_PROFILE['recoveryBytes']
                or type(spec['expiresAt']) not in (int, float) or not s.now() < spec['expiresAt'] <= plan['expiresAt']):
            self.l.fail('CAPACITY_AUTHORIZATION_REQUIRED', 'Native approval must match the existing immutable plan and its recovery reservation')
        if identifier in authorizations:
            if not exact_json(authorizations[identifier], spec): self.l.fail('INVALID_BINDING', 'The native authorization identity was reused for a different plan')
            return {'registered': True, 'planId': plan['planId'], 'authorizationId': identifier}
        if state['phase'] != 'planned' or len(authorizations) >= 128:
            self.l.fail('CAPACITY_MIGRATION_UNCERTAIN', 'Capacity approval cannot replace an existing execution identity')
        if plan['kind'] == 'create' and key in data['records']:
            self.l.fail('GENERATION_CHANGED', 'The project was allocated after initial capacity planning; its volume was not inspected or changed')
        if any(existing_id != plan['planId'] and (existing['namespace'], existing['projectId']) == (spec['namespace'], spec['projectId'])
                and pending_plan(data, existing_id, s.now()) for existing_id, existing in data.get('capacityPlans', {}).items()):
            self.l.fail('CAPACITY_MIGRATION_UNCERTAIN', 'Another capacity approval still owns this project')
        source, target_manifest = self._source(data, key, data['records'].get(key), plan['sourceProfileId'])
        if source != plan['source'] or target_manifest['manifestId'] != plan['target']['targetBaseManifestId']:
            self.l.fail('GENERATION_CHANGED', 'The immutable source changed before native approval registration')
        authorizations[identifier] = copy.deepcopy(spec); state.update(phase='authorized', authorizationId=identifier); s._save(data)
        return {'registered': True, 'planId': plan['planId'], 'authorizationId': identifier}

    def execute(self, spec):
        s = self.store
        key = self._scope(spec, {'planId', 'authorizationId'})
        data = s._read(); _, plan, state = self._existing(data, {key: spec[key] for key in ('namespace', 'projectId', 'planId')})
        identifier = self.l.operation(spec['authorizationId']); _, _, authorizations = self._maps(data)
        approval = authorizations.get(identifier)
        if not approval or approval['planId'] != plan['planId'] or state.get('authorizationId') != identifier:
            self.l.fail('CAPACITY_AUTHORIZATION_REQUIRED', 'The original native capacity approval is required')
        if state['phase'] == 'committed': return copy.deepcopy(state['result'])
        if state['phase'] != 'authorized':
            self.l.fail('CAPACITY_MIGRATION_UNCERTAIN', 'An unconfirmed copy is verify-only; execution was not replayed')
        if min(approval['expiresAt'], plan['expiresAt']) < s.now():
            self.l.fail('CAPACITY_AUTHORIZATION_REQUIRED', 'The original native approval expired')
        if plan['kind'] == 'create' and key in data['records']:
            self.l.fail('GENERATION_CHANGED', 'The project was allocated after initial capacity approval; its volume was not inspected or changed')
        source, target_manifest = self._source(data, key, data['records'].get(key), plan['sourceProfileId'])
        if source != plan['source'] or target_manifest['manifestId'] != plan['target']['targetBaseManifestId']:
            self.l.fail('GENERATION_CHANGED', 'Source identity changed after approval; no copy was started')
        fresh_budget, blockers = self._budget(data)
        if blockers: self.l.fail(blockers[0], 'Fresh capacity no longer fits the approved plan; no copy was started')
        if fresh_budget['requiredGrowthBytes'] > plan['budget']['requiredGrowthBytes']:
            self.l.fail('CAPACITY_RESERVATION_CHANGED', 'Fresh image growth exceeds the immutable approved physical reservation; no copy was started')
        record = data['records'].get(key)
        if record is None and len(data['records']) >= 96:
            self.l.fail('METADATA_CAPACITY', 'Stable identity registry is full')
        pending = {'planId': plan['planId'], 'authorizationId': identifier,
            'targetVolumeId': plan['target']['volumeId'], 'phase': 'started'}
        if record is not None:
            record['capacityMigration'] = pending
        # This intent precedes even identity-range claiming/useradd. A no-record started
        # plan still reserves its complete target and cannot be retried after uncertainty.
        state['phase'] = 'started'; s._save(data)

        def lease():
            s.backend.assert_capacity_lease()
            if state['phase'] != 'started' or record is None or record['capacityMigration']['planId'] != plan['planId'] or approval['expiresAt'] < s.now():
                self.l.fail('CAPACITY_LEASE_REQUIRED', 'The original live capacity approval no longer owns the operation', True)

        try:
            if record is None:
                s.backend.assert_capacity_lease()
                identity = s.backend.allocate_identity({r['identity']['uid'] for r in data['records'].values()})
                record = {'namespace': spec['namespace'], 'projectId': spec['projectId'], 'generation': 1, 'state': 'creating',
                    'dirty': False, 'baseline': {}, 'identity': identity, 'lastUsed': s.now(), 'rasterReturnVersion': 2,
                    'volumeProfileVersion': runtime_profile(plan['sourceProfileId'])['version'], 'volumeId': plan['target']['volumeId'], 'capacityMigration': pending}
                self.l.retain_source_manifest(record, target_manifest); data['records'][key] = record
                s._save(data)
            folder = s._folder(key, record)
            lease()
            if source['absent']:
                s._directory(s.root, True); s.backend.create_profile(folder, record)
                s._unmount(folder, record)
                receipt = s.backend.inspect_capacity_image(folder, s._image_path(folder, record), RUNTIME_PROFILE['volumeBytes'])
            else:
                receipt = s.backend.migrate_capacity_image(folder, s._image_path(folder, record),
                    folder / 'images' / (plan['target']['volumeId'] + '.img'), source['volumeBytes'], source['imageSha256'], lease)
            lease()
            # Publish the exact pointer and its complete compact baseline in one registry replacement.
            # A failed metadata commit is not permission to roll back or rewrite either image.
            committed_data = copy.deepcopy(data)
            committed_record = committed_data['records'][key]
            committed_state = committed_data['capacityPlanStates'][plan['planId']]
            if not source['absent']:
                committed_record.setdefault('retainedVolumes', []).append({'volumeId': source['imageId'],
                    'profileId': None, 'imageSha256': source['imageSha256'], 'unmountedVerified': True})
                committed_record['generation'] += 1
            committed_record.update(volumeProfileVersion=runtime_profile(plan['sourceProfileId'])['version'], volumeId=plan['target']['volumeId'], rasterReturnVersion=2,
                sourceProfileId=plan['sourceProfileId'], dirty=False)
            self.l.retain_source_manifest(committed_record, target_manifest)
            committed_record['state'] = 'resident' if source['absent'] else committed_record['state']
            committed_record['sourceDigest'] = self.l.source_digest([{'path': item['path'], 'sha256': item['sha256'], 'executable': item['executable']} for item in target_manifest['files']])
            if committed_record['state'] == 'archived': committed_record['imageSha256'] = receipt['target']['imageSha256']
            result = {'migrated': True, 'planId': plan['planId'], 'authorizationId': identifier, 'kind': plan['kind'],
                'namespace': spec['namespace'], 'projectId': spec['projectId'], 'generation': committed_record['generation'],
                'volumeId': committed_record['volumeId'], 'volumeBytes': RUNTIME_PROFILE['volumeBytes'], 'sourceProfileId': plan['sourceProfileId'],
                'sourceManifestVersion': 2, 'sourceBaseManifestId': target_manifest['manifestId'], 'originalRetained': not source['absent']}
            committed_record.pop('capacityMigration'); committed_state.update(phase='committed', result=result,
                targetIdentity=stable_image_identity(s._image_path(folder, committed_record), RUNTIME_PROFILE['volumeBytes']))
            state['phase'] = 'commit-pending'
            s._save(committed_data)
            return result
        except Exception as cause:
            # Even if an image is complete, no unknown operation is replayed or its pointer guessed.
            if state['phase'] != 'commit-pending':
                state['phase'] = 'unknown'
                if record is not None:
                    record['capacityMigration']['phase'] = 'unknown'; record['dirty'] = True
                s._save(data)
            cause.changed = True
            raise
