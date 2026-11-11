"""Independent candidate profiles and in-memory migration simulation. No runtime I/O or activation."""
import copy
import hashlib
import re
import uuid
from types import MappingProxyType

MiB = 1024 * 1024
MAX_INTEGER = (1 << 53) - 1
PROFILE_IDS = ('capacity-64-v1', 'capacity-128-v1', 'capacity-256-v1')


class ProfileError(ValueError):
    pass


def _integer(value, optional=False):
    if value is None and optional:
        return None
    if type(value) is not int or not 0 <= value <= MAX_INTEGER:
        raise ProfileError('Capacity values must be known non-negative safe integers or explicit unknowns')
    return value


def _profile(name, volume, media, inodes):
    return MappingProxyType({'version': 1, 'id': name, 'volumeBytes': volume * MiB, 'mediaBytes': media * MiB,
        'inodeCount': inodes, 'sourceFileBytes': 2 * MiB, 'sourceBytes': 8 * MiB, 'mediaFileBytes': 32 * MiB,
        'mediaWindowBytes': 64 * MiB, 'fileCount': 2000, 'entryCount': 4000, 'requestHeaderBytes': 24 * MiB,
        'responseHeaderBytes': 16 * MiB, 'recoveryBytes': 512 * MiB, 'globalVolumeBytes': 4096 * MiB,
        'residentVolumes': 8, 'globalOperations': 2, 'reserveBytes': 1024 * MiB,
        'runtimeEnabled': False, 'simulationOnly': True})


PROFILES = MappingProxyType(dict(zip(PROFILE_IDS, (
    _profile(PROFILE_IDS[0], 256, 64, 8192), _profile(PROFILE_IDS[1], 512, 128, 16384),
    _profile(PROFILE_IDS[2], 1024, 256, 32768)))))
LEGACY_CURRENT = MappingProxyType({'contract': 'current-64', 'volumeBytes': 256 * MiB, 'mediaBytes': 64 * MiB,
    'inodeCount': 8192, 'informationalOnly': True, 'automaticUpgrade': False})


def profile(profile_id):
    if not isinstance(profile_id, str) or profile_id not in PROFILES:
        raise ProfileError('Unknown candidate capacity profile')
    return PROFILES[profile_id]


def _hash(value):
    if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{64}', value):
        raise ProfileError('A complete immutable image or snapshot identity is required')
    return value


def _id(value):
    if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{32}', value):
        raise ProfileError('A fixed simulation operation or volume identity is required')
    return value


def _project(value):
    try:
        valid = isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        valid = False
    if not valid:
        raise ProfileError('A canonical project identity is required')
    return value


VOLUME_KEYS = {'version', 'volumeId', 'namespace', 'projectId', 'generation', 'state', 'residentReserved',
    'allocatedBytes', 'imageSha256', 'sourceSnapshotId', 'unmountedVerified', 'dirty', 'syncPending', 'activeOperations'}


def parse_volume(value):
    """Legacy observations are validated and copied, never rewritten into a candidate record."""
    if not isinstance(value, dict):
        raise ProfileError('Invalid volume ledger')
    legacy = type(value.get('version')) is int and value['version'] == 1
    if set(value) != VOLUME_KEYS | ({'legacyContract'} if legacy else {'profileId'}):
        raise ProfileError('Unknown volume ledger schema')
    if legacy:
        if value['legacyContract'] != LEGACY_CURRENT['contract']:
            raise ProfileError('Unknown legacy contract; its capacity is not zero')
    elif type(value['version']) is not int or value['version'] != 2:
        raise ProfileError('Unknown versioned volume format')
    else:
        profile(value['profileId'])
    _id(value['volumeId']); _project(value['projectId']); _hash(value['imageSha256']); _hash(value['sourceSnapshotId'])
    if (value['namespace'] not in ('manual', 'test') or type(value['generation']) is not int or value['generation'] < 1
            or value['state'] not in ('resident', 'archived', 'staging', 'retained-backup')
            or any(type(value[key]) is not bool for key in ('residentReserved', 'unmountedVerified', 'dirty', 'syncPending'))
            or value['state'] in ('resident', 'staging') and not value['residentReserved']
            or value['state'] in ('archived', 'retained-backup') and (value['residentReserved'] or not value['unmountedVerified'])):
        raise ProfileError('Invalid volume ownership or reservation state')
    _integer(value['allocatedBytes'], optional=True); _integer(value['activeOperations'])
    if value['state'] != 'resident' and value['activeOperations']:
        raise ProfileError('An unmounted or staging image cannot claim active project operations')
    return copy.deepcopy(value)


def _volume_profile(volume):
    return LEGACY_CURRENT if volume['version'] == 1 else profile(volume['profileId'])


def weighted_ledger(values):
    if not isinstance(values, list):
        raise ProfileError('A complete volume ledger is required')
    volumes = [parse_volume(value) for value in values]
    seen, active = set(), set()
    residents = 0
    logical = 0
    growth = 0
    for volume in volumes:
        if volume['volumeId'] in seen:
            raise ProfileError('A physical image was counted twice')
        seen.add(volume['volumeId'])
        owner = (volume['namespace'], volume['projectId'])
        if volume['state'] in ('resident', 'archived'):
            if owner in active:
                raise ProfileError('A project has conflicting active image pointers')
            active.add(owner)
        if volume['residentReserved']:
            residents += 1
        size = _volume_profile(volume)['volumeBytes']
        logical += size
        if volume['allocatedBytes'] is None:
            growth = None
        elif growth is not None:
            growth += max(0, size - volume['allocatedBytes'])
    return {'logicalBytes': logical, 'growthBytes': growth, 'residentVolumes': residents,
        'imageCount': len(volumes), 'activeOperations': sum(v['activeOperations'] for v in volumes),
        'retainedBackupBytes': sum(_volume_profile(v)['volumeBytes'] for v in volumes if v['state'] == 'retained-backup')}


def _check(required, available, fresh=True):
    required, available = _integer(required, True), _integer(available, True)
    if not fresh or required is None or available is None:
        return {'status': 'unknown', 'required': required, 'available': available}
    return {'status': 'fits' if required <= available else 'blocked', 'required': required, 'available': available}


def _sum_known(values):
    parsed = [_integer(value, True) for value in values]
    return None if any(value is None for value in parsed) else sum(parsed)


def assess_capacity(profile_id, volumes, observation, peaks):
    """Arithmetic only. Peaks are disjoint additional staging/dependency/cache/build allocations, not free space.

    The ledger includes every existing and proposed image. An observation never grants runtime admission.
    """
    limits = profile(profile_id)
    if not isinstance(observation, dict) or not isinstance(peaks, dict):
        raise ProfileError('Explicit capacity observations and separate additional peaks are required')
    fresh = observation.get('fresh') is True
    checks = {}
    try:
        ledger = weighted_ledger(volumes)
    except (ProfileError, ValueError, KeyError, TypeError):
        ledger = None
    complete = observation.get('ledgerComplete') is True and fresh
    checks['globalLogicalBytes'] = _check(ledger['logicalBytes'] if ledger else None, limits['globalVolumeBytes'], complete)
    checks['residentVolumes'] = _check(ledger['residentVolumes'] if ledger else None, limits['residentVolumes'], complete)
    operations = _sum_known([observation.get('operations'), peaks.get('additionalOperations')])
    if ledger and observation.get('operations') is not None and _integer(observation['operations']) < ledger['activeOperations']:
        operations = None
    checks['globalOperations'] = _check(operations, limits['globalOperations'], fresh)
    # Image growth already covers dependencies/build bytes inside every image. Do not count those twice on the root FS.
    backing = _sum_known([ledger['growthBytes'] if ledger else None, limits['reserveBytes'],
        observation.get('reservedPhysicalBytes'), peaks.get('controlBytes')])
    checks['backingPhysicalBytes'] = _check(backing, observation.get('freePhysicalBytes'), complete)
    checks['backingInodes'] = _check(_sum_known([observation.get('reservedPhysicalInodes'), peaks.get('controlInodes'), peaks.get('rootFloorInodes')]), observation.get('freePhysicalInodes'), fresh)
    project_bytes = _sum_known([peaks.get(key) for key in ('sourceBytes', 'dependencyBytes', 'cacheBytes', 'buildBytes', 'projectFloorBytes')])
    project_inodes = _sum_known([peaks.get(key) for key in ('sourceInodes', 'dependencyInodes', 'cacheInodes', 'buildInodes', 'projectFloorInodes')])
    checks['projectAdditionalBytes'] = _check(project_bytes, observation.get('projectFreeBytes'), fresh)
    checks['projectAdditionalInodes'] = _check(project_inodes, observation.get('projectFreeInodes'), fresh)
    for name, limit in (('cumulativeMediaBytes', 'mediaBytes'), ('largestMediaFileBytes', 'mediaFileBytes'),
                        ('mediaWindowBytes', 'mediaWindowBytes'), ('candidateReturnBytes', 'mediaWindowBytes'), ('recoveryPeakBytes', 'recoveryBytes')):
        checks[name] = _check(peaks.get(name), limits[limit])
    checks['recoveryRemainingBytes'] = _check(peaks.get('recoveryPeakBytes'), observation.get('recoveryRemainingBytes'), fresh)
    for name in ('sourceBytes', 'dependencyBytes', 'cacheBytes', 'buildBytes', 'sourceInodes', 'dependencyInodes', 'cacheInodes', 'buildInodes'):
        value = _integer(peaks.get(name), True)
        checks[name] = {'status': 'unknown' if value is None else 'known', 'required': value, 'available': None}
    statuses = [item['status'] for item in checks.values()]
    status = 'blocked' if 'blocked' in statuses else 'unknown' if 'unknown' in statuses else 'fits'
    return {'version': 1, 'profileId': profile_id, 'status': status, 'runtimeEnabled': False, 'simulationOnly': True,
        'guarantee': 'advisory-arithmetic-not-an-os-reservation', 'ledger': ledger, 'checks': checks}


MIGRATION_KEYS = {'version', 'id', 'namespace', 'projectId', 'generation', 'fromVolumeId', 'toVolumeId',
    'fromProfileId', 'toProfileId', 'sourceImageSha256', 'sourceSnapshotId', 'phase', 'targetImageSha256',
    'oldVolumeRetained', 'runtimeEnabled', 'simulationOnly'}


def parse_migration(value):
    if (not isinstance(value, dict) or set(value) != MIGRATION_KEYS or type(value['version']) is not int or value['version'] != 2
            or value['runtimeEnabled'] is not False or value['simulationOnly'] is not True or value['oldVolumeRetained'] is not True):
        raise ProfileError('Only the exact simulation migration schema is supported')
    for key in ('id', 'fromVolumeId', 'toVolumeId'): _id(value[key])
    _project(value['projectId']); _hash(value['sourceImageSha256']); _hash(value['sourceSnapshotId'])
    if (value['namespace'] not in ('manual', 'test') or type(value['generation']) is not int or value['generation'] < 1
            or value['fromVolumeId'] == value['toVolumeId'] or value['phase'] not in ('planned', 'copying', 'verified', 'committed', 'blocked')):
        raise ProfileError('Invalid simulation migration identity or phase')
    before = LEGACY_CURRENT if value['fromProfileId'] is None else profile(value['fromProfileId'])
    after = profile(value['toProfileId'])
    if after['volumeBytes'] <= before['volumeBytes']:
        raise ProfileError('Simulation migration must preserve the original and grow to a fixed candidate profile')
    if value['targetImageSha256'] is not None: _hash(value['targetImageSha256'])
    if value['phase'] in ('verified', 'committed') and value['targetImageSha256'] is None:
        raise ProfileError('A completed copy must have a verified image identity')
    return copy.deepcopy(value)


class SimulatedVolumeLedger:
    """In-memory bytes only. It neither imports Store nor knows file paths, commands, mounts or networks."""
    def __init__(self, volumes, payloads):
        weighted_ledger(volumes)
        records = {value['volumeId']: parse_volume(value) for value in volumes}
        self.payloads = {key: bytes(value) for key, value in payloads.items()}
        if set(self.payloads) != set(records) or any(hashlib.sha256(self.payloads[key]).hexdigest() != value['imageSha256'] for key, value in records.items()):
            raise ProfileError('Simulation image bytes do not match their complete ledger')
        if any(hashlib.sha256(b'snapshot:' + self.payloads[key]).hexdigest() != value['sourceSnapshotId'] for key, value in records.items()):
            raise ProfileError('Simulation source snapshots do not match their fixed images')
        self._registry = {'volumes': records, 'migrations': {},
            'active': {(v['namespace'], v['projectId']): key for key, v in records.items() if v['state'] in ('resident', 'archived')}}
        self.effects = {'copy': 0, 'simulatedResize': 0, 'pointerCommit': 0}

    @property
    def volumes(self): return self._registry['volumes']

    @property
    def migrations(self): return self._registry['migrations']

    @property
    def active(self): return self._registry['active']

    def begin(self, value, observation, peaks, recovery_settled):
        migration = parse_migration(value)
        if migration['phase'] != 'planned' or migration['id'] in self.migrations or recovery_settled is not True:
            raise ProfileError('The original recovery must be settled and the migration identity unused')
        source = self.volumes.get(migration['fromVolumeId'])
        if (not source or self.active.get((migration['namespace'], migration['projectId'])) != migration['fromVolumeId']
                or source['namespace'] != migration['namespace'] or source['projectId'] != migration['projectId']
                or source['generation'] != migration['generation'] or source['dirty'] or source['syncPending'] or source['activeOperations']
                or source['imageSha256'] != migration['sourceImageSha256'] or source['sourceSnapshotId'] != migration['sourceSnapshotId']
                or source.get('profileId') != migration['fromProfileId']
                or migration['toVolumeId'] in self.volumes
                or any(item['projectId'] == migration['projectId'] and item['namespace'] == migration['namespace'] and item['phase'] != 'committed' for item in self.migrations.values())):
            raise ProfileError('Dirty, active, changed or uncertain source volumes cannot be migrated')
        target = {**source, 'version': 2, 'volumeId': migration['toVolumeId'], 'profileId': migration['toProfileId'],
            'state': 'staging', 'residentReserved': True, 'unmountedVerified': False,
            'allocatedBytes': 0, 'imageSha256': hashlib.sha256(b'').hexdigest(), 'sourceSnapshotId': hashlib.sha256(b'snapshot:').hexdigest()}
        target.pop('legacyContract', None)
        pending = sum(item['phase'] != 'committed' for item in self.migrations.values())
        known_operations = pending + sum(item['activeOperations'] for item in self.volumes.values())
        if observation.get('operations') is None or _integer(observation['operations']) < known_operations:
            raise ProfileError('The global operation observation omits an existing job or migration reservation')
        report = assess_capacity(migration['toProfileId'], [*self.volumes.values(), target], observation, peaks)
        if report['status'] != 'fits':
            raise ProfileError('Unknown or insufficient candidate capacity; existing volumes were not changed')
        next_registry = copy.deepcopy(self._registry)
        next_registry['migrations'][migration['id']] = migration
        next_registry['volumes'][target['volumeId']] = target
        self._registry = next_registry  # Model one atomic registry publication before any derived image bytes.
        self.payloads[target['volumeId']] = b''
        return report

    def confirm_unmounted(self, migration_id, image_sha256):
        migration = self.migrations[migration_id]
        source = self.volumes[migration['fromVolumeId']]
        if (migration['phase'] != 'planned' or image_sha256 != migration['sourceImageSha256']
                or hashlib.sha256(self.payloads[source['volumeId']]).hexdigest() != image_sha256):
            raise ProfileError('The exact inactive source image must be verified before copying')
        source['unmountedVerified'] = True  # Explicit simulated evidence; the old resident reservation remains charged.

    def copy(self, migration_id, fail_after=None, resize_fails=False):
        migration = self.migrations[migration_id]
        if migration['phase'] != 'planned':
            raise ProfileError('An interrupted copy is never automatically replayed')
        source = self.payloads[migration['fromVolumeId']]
        if not self.volumes[migration['fromVolumeId']]['unmountedVerified'] or hashlib.sha256(source).hexdigest() != migration['sourceImageSha256']:
            raise ProfileError('The retained original changed')
        migration['phase'] = 'copying'; self.effects['copy'] += 1
        prefix = source if fail_after is None else source[:_integer(fail_after)]
        self.payloads[migration['toVolumeId']] = prefix
        target = self.volumes[migration['toVolumeId']]
        target.update(allocatedBytes=len(prefix), imageSha256=hashlib.sha256(prefix).hexdigest(), sourceSnapshotId=hashlib.sha256(b'snapshot:' + prefix).hexdigest())
        if fail_after is not None:
            migration['phase'] = 'blocked'; raise ProfileError('Synthetic partial copy retained without replacing the original')
        self.effects['simulatedResize'] += 1
        if resize_fails:
            migration['phase'] = 'blocked'; raise ProfileError('Synthetic filesystem growth failed; both images remain retained')

    def verify(self, migration_id):
        migration = self.migrations[migration_id]
        if migration['phase'] != 'copying': raise ProfileError('Only an existing complete copy can be verified')
        source, target = self.payloads[migration['fromVolumeId']], self.payloads[migration['toVolumeId']]
        if source != target or hashlib.sha256(source).hexdigest() != migration['sourceImageSha256']:
            migration['phase'] = 'blocked'; raise ProfileError('Migration verification failed; no pointer was changed')
        migration.update(phase='verified', targetImageSha256=hashlib.sha256(target).hexdigest())
        self.volumes[migration['toVolumeId']]['unmountedVerified'] = True

    def commit(self, migration_id, lose_final_record=False, fail_before_pointer=False):
        migration = self.migrations[migration_id]
        if self.inspect(migration_id) != 'verified-ready': raise ProfileError('Only the existing verified migration may commit')
        next_registry = copy.deepcopy(self._registry)
        source, target = next_registry['volumes'][migration['fromVolumeId']], next_registry['volumes'][migration['toVolumeId']]
        target.update(state=source['state'], generation=source['generation'] + 1, residentReserved=source['residentReserved'])
        source.update(state='retained-backup', residentReserved=False, unmountedVerified=True)
        next_registry['active'][(migration['namespace'], migration['projectId'])] = migration['toVolumeId']
        if not lose_final_record: next_registry['migrations'][migration_id]['phase'] = 'committed'
        if fail_before_pointer: raise ProfileError('Synthetic loss before atomic registry publication; both copies remain retained')
        self._registry = next_registry
        self.effects['pointerCommit'] += 1

    def inspect(self, migration_id):
        migration = parse_migration(self.migrations[migration_id])
        try:
            original = parse_volume(self.volumes[migration['fromVolumeId']])
            candidate = parse_volume(self.volumes[migration['toVolumeId']])
            source, target = self.payloads[migration['fromVolumeId']], self.payloads[migration['toVolumeId']]
        except (KeyError, ProfileError, TypeError):
            return 'blocked'
        if (hashlib.sha256(source).hexdigest() != migration['sourceImageSha256'] or original['imageSha256'] != migration['sourceImageSha256']
                or original['sourceSnapshotId'] != migration['sourceSnapshotId'] or original['generation'] != migration['generation']
                or original['namespace'] != migration['namespace'] or original['projectId'] != migration['projectId']
                or original['dirty'] or original['syncPending'] or original['activeOperations'] or not original['unmountedVerified']
                or candidate.get('profileId') != migration['toProfileId'] or candidate['namespace'] != migration['namespace']
                or candidate['projectId'] != migration['projectId'] or candidate['imageSha256'] != hashlib.sha256(target).hexdigest()
                or candidate['sourceSnapshotId'] != hashlib.sha256(b'snapshot:' + target).hexdigest()):
            return 'blocked'
        if migration['phase'] not in ('verified', 'committed') or hashlib.sha256(target).hexdigest() != migration['targetImageSha256']:
            return 'blocked'
        pointer = self.active.get((migration['namespace'], migration['projectId']))
        if (pointer == migration['toVolumeId'] and self.volumes[migration['fromVolumeId']]['state'] == 'retained-backup'
                and self.volumes[migration['fromVolumeId']]['unmountedVerified']):
            return 'committed-verified'
        return 'verified-ready' if pointer == migration['fromVolumeId'] and migration['phase'] == 'verified' else 'blocked'

    def reconcile(self, migration_id):
        result = self.inspect(migration_id)
        if result == 'committed-verified': self.migrations[migration_id]['phase'] = 'committed'
        return result
