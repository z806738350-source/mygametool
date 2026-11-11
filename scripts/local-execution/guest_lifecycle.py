"""Root-owned lifecycle metadata. Callers hold the shared storage lock for every method."""
import base64
import errno
import hashlib
import json
import math
import os
import pathlib
import re
import stat
import time
import uuid
from guest_runtime_capacity import RUNTIME_PROFILE, RUNTIME_PROFILES, record_volume_bytes, runtime_profile, runtime_media_file_limit
from guest_capacity_migration import CapacityMigration, exact_json, pending_plan, validate_metadata as validate_capacity_metadata

VOLUME_BYTES = 256 * 1024 * 1024
RESIDENT_LIMIT = 8
TOTAL_BYTES = 4 * 1024 * 1024 * 1024
RESERVE_BYTES = 1024 * 1024 * 1024
IDENTITIES = (5000, 5095)
ACTIVE = {'prepared', 'running', 'finished', 'cancel-requested'}
EXECUTING = {'prepared', 'running', 'cancel-requested'}


class LifecycleError(ValueError):
    def __init__(self, code, message, changed=False):
        super().__init__(message)
        self.code = code
        self.changed = changed


def fail(code, message, changed=False):
    raise LifecycleError(code, message, changed)


def capacity_error(cause, volume=False):
    if cause.errno not in (errno.ENOSPC, errno.EDQUOT):
        return None
    code = ('GUEST_VOLUME_FULL' if cause.errno == errno.ENOSPC else 'GUEST_QUOTA_EXCEEDED') if volume else (
        'GUEST_STORAGE_FULL' if cause.errno == errno.ENOSPC else 'GUEST_STORAGE_QUOTA_EXCEEDED')
    return LifecycleError(code, ('Project volume capacity was exhausted' if volume else 'Guest control storage capacity was exhausted')
        + '; preparation may have changed files or metadata. Retain the operation and inspect its recorded state; recovery is not confirmed.', True)


def identifier(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        fail('INVALID_REQUEST', 'Invalid project identity')
    return value


def operation(value):
    if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{32}', value):
        fail('INVALID_REQUEST', 'Invalid operation identity')
    return value


def project_key(namespace, project):
    if namespace not in ('manual', 'test'):
        fail('INVALID_REQUEST', 'Invalid storage namespace')
    return namespace + '-' + identifier(project)


def source_digest(files):
    values = sorted(({'path': f['path'], 'sha256': f['sha256'],
                      'executable': bool(f.get('executable'))} for f in files), key=lambda f: f['path'])
    return hashlib.sha256(json.dumps(values, separators=(',', ':'), sort_keys=True).encode()).hexdigest()


def source_map(files):
    return {f['path']: {'sha256': f['sha256'], 'executable': bool(f.get('executable')),
                        **({'size': f['size']} if 'size' in f and 'data' not in f else {})} for f in files}


def source_manifest(files, profile_id=None):
    """Typed metadata is a budget description, never permission to copy or publish a file."""
    if not isinstance(files, list) or len(files) > 2000:
        fail('INVALID_REQUEST', 'Invalid source manifest file count')
    seen = set()
    source_bytes = media_bytes = 0
    rows = []
    for item in files:
        if not isinstance(item, dict) or set(item) != {'path', 'kind', 'size', 'sha256', 'executable'}:
            fail('INVALID_REQUEST', 'Invalid typed source metadata')
        path, kind, size, digest, executable = (item[key] for key in ('path', 'kind', 'size', 'sha256', 'executable'))
        if (not isinstance(path, str) or not path or len(path) > 1000 or path in seen
                or '\\' in path or any(ord(character) < 32 or 0xd800 <= ord(character) <= 0xdfff for character in path)
                or any(not part or part.startswith('.') or part in ('node_modules', 'dist', 'build', 'out') for part in path.split('/'))
                or kind not in ('source', 'media') or type(size) is not int or type(executable) is not bool
                or not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest)):
            fail('INVALID_REQUEST', 'Invalid typed source metadata')
        seen.add(path)
        if kind == 'source':
            if not 0 <= size <= 2 * 1024 * 1024:
                fail('INVALID_REQUEST', 'Source manifest exceeds the ordinary file limit')
            source_bytes += size
        else:
            name = pathlib.PurePosixPath(path)
            eligible = (name.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mp3', '.wav', '.ogg', '.glb', '.mov', '.m4a', '.avif'}
                and (bool(set(name.parts[:-1]) & {'public', 'src'}) or name.parts[:2] in (('assets', 'imported'), ('assets', 'generated'), ('assets', 'files'))))
            if not eligible or not 0 < size <= runtime_media_file_limit(path, profile_id) or executable:
                fail('INVALID_REQUEST', 'Source manifest exceeds the runtime media file limit')
            media_bytes += size
        rows.append([path, kind, size, digest, executable])
    limits = runtime_profile(profile_id) if profile_id is not None else None
    if source_bytes > 8 * 1024 * 1024 or media_bytes > (limits['mediaBytes'] if limits else 64 * 1024 * 1024):
        fail('INVALID_REQUEST', 'Source manifest exceeds the current-64 profile')
    rows.sort(key=lambda row: row[0])
    canonical = json.dumps([dict(limits), rows] if limits else rows, ensure_ascii=True, separators=(',', ':')).encode('ascii')
    manifest_id = hashlib.sha256((b'ohmygame-source-manifest-v2\n' if limits else b'ohmygame-source-manifest-v1\n') + canonical).hexdigest()
    if limits:
        return {'version': 2, 'profile': profile_id, 'limits': dict(limits), 'permissionSemantics': 'executable-only',
            'manifestId': manifest_id, 'files': [dict(zip(('path', 'kind', 'size', 'sha256', 'executable'), row)) for row in rows]}
    return {'version': 1, 'profile': 'current-64', 'permissionSemantics': 'executable-only', 'manifestId': manifest_id,
            'files': [dict(zip(('path', 'kind', 'size', 'sha256', 'executable'), row)) for row in rows]}


def parse_source_manifest(value):
    middle = isinstance(value, dict) and type(value.get('version')) is int and value['version'] == 2
    if (not isinstance(value, dict) or set(value) != ({'version', 'profile', 'permissionSemantics', 'manifestId', 'files', 'limits'} if middle else {'version', 'profile', 'permissionSemantics', 'manifestId', 'files'})
            or type(value['version']) is not int or value['version'] != (2 if middle else 1) or (value['profile'] not in RUNTIME_PROFILES if middle else value['profile'] != 'current-64')
            or middle and not exact_json(value['limits'], dict(runtime_profile(value['profile'])))
            or value['permissionSemantics'] != 'executable-only'):
        fail('INVALID_REQUEST', 'Unknown source manifest contract')
    parsed = source_manifest(value['files'], value['profile'] if middle else None)
    if value['manifestId'] != parsed['manifestId']:
        fail('INVALID_REQUEST', 'Source manifest identity does not match its complete metadata')
    return parsed


def snapshot_source_manifest(files, profile_id=None):
    entries = []
    for item in files:
        media = 'size' in item and 'data' not in item
        entries.append({'path': item['path'], 'kind': 'media' if media else 'source',
            'size': item['size'] if media else len(base64.b64decode(item['data'], validate=True)),
            'sha256': item['sha256'], 'executable': bool(item.get('executable'))})
    return source_manifest(entries, profile_id)


def source_delta(before, after):
    before, after = parse_source_manifest(before), parse_source_manifest(after)
    if before['version'] != after['version'] or before['profile'] != after['profile']:
        fail('INVALID_REQUEST', 'Source delta cannot cross a generation profile contract')
    previous = {item['path']: item for item in before['files']}
    current = {item['path']: item for item in after['files']}
    added = set(current) - set(previous)
    removed = set(previous) - set(current)
    modified = {path for path in set(previous) & set(current) if previous[path] != current[path]}
    changed_before = [previous[path] for path in removed | modified]
    changed_after = [current[path] for path in added | modified]
    total = lambda entries, kind: sum(item['size'] for item in entries if item['kind'] == kind)
    before_source, before_media = total(changed_before, 'source'), total(changed_before, 'media')
    after_source, after_media = total(changed_after, 'source'), total(changed_after, 'media')
    return {'version': 1, 'beforeManifestId': before['manifestId'], 'afterManifestId': after['manifestId'],
        'addedFiles': len(added), 'modifiedFiles': len(modified), 'removedFiles': len(removed),
        'unchangedFiles': len(set(previous) & set(current)) - len(modified),
        'beforeSourceBytes': before_source, 'beforeMediaBytes': before_media,
        'afterSourceBytes': after_source, 'afterMediaBytes': after_media,
        'beforeBytes': before_source + before_media, 'afterBytes': after_source + after_media}


def record_source_manifest(record):
    if (type(record.get('sourceManifestVersion')) is not int or record['sourceManifestVersion'] not in (1, 2)
            or record['sourceManifestVersion'] == 2 and record.get('sourceProfileId') not in RUNTIME_PROFILES):
        fail('UNSAFE_STORAGE', 'Unknown source manifest generation')
    sizes = record.get('sourceManifestSizes')
    baseline = record['baseline']
    if not isinstance(sizes, list) or len(sizes) != len(baseline):
        fail('UNSAFE_STORAGE', 'Source manifest sizes no longer match the full baseline')
    entries = []
    for index, (path, item) in enumerate(sorted(baseline.items())):
        if type(sizes[index]) is not int or 'size' in item and sizes[index] != item['size']:
            fail('UNSAFE_STORAGE', 'Source manifest sizes no longer match the full baseline')
        entries.append({'path': path, 'kind': 'media' if 'size' in item else 'source', 'size': sizes[index],
            'sha256': item['sha256'], 'executable': bool(item.get('executable'))})
    manifest = source_manifest(entries, record.get('sourceProfileId') if record['sourceManifestVersion'] == 2 else None)
    if record.get('sourceManifestId') != manifest['manifestId']:
        fail('UNSAFE_STORAGE', 'Source manifest baseline identity changed')
    return manifest


def retain_source_manifest(record, manifest):
    manifest = parse_source_manifest(manifest)
    record.update(sourceManifestVersion=manifest['version'], sourceManifestId=manifest['manifestId'],
        sourceManifestSizes=[item['size'] for item in manifest['files']])
    if manifest['version'] == 2: record['sourceProfileId'] = manifest['profile']


def manifest_request(spec, required=False, result=False):
    middle = spec.get('sourceManifestVersion') == 2 and type(spec.get('sourceManifestVersion')) is int
    keys = {'sourceManifestVersion', 'sourceBaseManifestId', 'sourceResultManifestId', 'sourceProfileId'}
    present = keys & set(spec)
    if not present and not required:
        return False
    expected = keys - (set() if result else {'sourceResultManifestId'}) - (set() if middle else {'sourceProfileId'})
    if (present != expected or type(spec.get('sourceManifestVersion')) is not int or spec['sourceManifestVersion'] not in (1, 2)
            or middle and spec.get('sourceProfileId') not in RUNTIME_PROFILES
            or any(not isinstance(spec.get(key), str) or not re.fullmatch('[a-f0-9]{64}', spec[key]) for key in expected - {'sourceManifestVersion', 'sourceProfileId'})):
        fail('INVALID_BINDING', 'The source manifest version and exact baseline identity are required')
    return True


def retained_review_request(spec):
    if (not isinstance(spec, dict) or set(spec) - {'sourceManifestVersion', 'sourceBaseManifestId', 'sourceProfileId'} != {'namespace', 'projectId', 'generation', 'reviewVersion'}
            or type(spec['generation']) is not int or spec['generation'] < 1
            or type(spec['reviewVersion']) is not int or spec['reviewVersion'] != 2):
        fail('INVALID_REQUEST', 'Retained review requires the exact generation and review version 2')
    project_key(spec['namespace'], spec['projectId'])
    manifest_request(spec)
    return spec


def media_capture_request(spec):
    if (not isinstance(spec, dict) or set(spec) - {'sourceManifestVersion', 'sourceBaseManifestId', 'sourceProfileId'} != {'namespace', 'projectId', 'operationId', 'generation', 'leaseToken', 'captureVersion'}
            or type(spec['generation']) is not int or spec['generation'] < 1
            or type(spec['captureVersion']) is not int or spec['captureVersion'] not in (2, 3, 4)
            or not isinstance(spec['leaseToken'], str) or not re.fullmatch('[a-f0-9]{32}', spec['leaseToken'])):
        fail('INVALID_REQUEST', 'Streamed capture requires its exact negotiated operation binding')
    project_key(spec['namespace'], spec['projectId'])
    operation(spec['operationId'])
    typed = manifest_request(spec, required=spec['captureVersion'] in (3, 4))
    if typed != (spec['captureVersion'] in (3, 4)) or typed and spec['sourceManifestVersion'] != spec['captureVersion'] - 2:
        fail('INVALID_REQUEST', 'Typed source capture requires capture version 3')
    return spec


def verified_snapshot(backend, workspace, baseline, raster_returns=False):
    if raster_returns == 2:
        snapshot = backend.review_snapshot(workspace, baseline)
        return snapshot['files'] + snapshot['retainedRasters']
    if raster_returns:
        return backend.snapshot_rasters(workspace, baseline)
    if any('size' in item for item in baseline.values()):
        return backend.snapshot(workspace, baseline)
    return backend.snapshot(workspace)


def operation_rasters(record, op):
    return record.get('rasterReturnVersion', 0) or int(bool(op.get('reviewSnapshotId')))


def file_hash(file, allowed_links=(1,)):
    before = file.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink not in allowed_links:
        fail('UNSAFE_STORAGE', 'Storage files must be ordinary and unlinked')
    digest = hashlib.sha256()
    descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        if (os.fstat(stream.fileno()).st_dev, os.fstat(stream.fileno()).st_ino) != (before.st_dev, before.st_ino):
            fail('STORAGE_CHANGED', 'Storage file changed before reading')
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
        after = os.fstat(stream.fileno())
    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        fail('STORAGE_CHANGED', 'Storage file changed while reading')
    return digest.hexdigest()


def sync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_json(file, value):
    data = json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
    if len(data) > 4 * 1024 * 1024:
        fail('METADATA_CAPACITY', 'Lifecycle history requires maintenance')
    temporary = file.with_name(file.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
        sync_directory(file.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


class Store:
    """Filesystem transitions keep the sole image; unknown or damaged state is never guessed away."""
    def __init__(self, root, backend, volume_bytes=VOLUME_BYTES, total_bytes=TOTAL_BYTES,
                 reserve_bytes=RESERVE_BYTES, resident_limit=RESIDENT_LIMIT, now=time.time):
        self.root = pathlib.Path(root)
        self.cold = self.root.with_name(self.root.name + '-cold')
        self.metadata = self.root.with_name(self.root.name + '-lifecycle')
        self.file = self.metadata / 'registry.json'
        self.backend = backend
        self.volume_bytes = volume_bytes
        self.total_bytes = total_bytes
        self.reserve_bytes = reserve_bytes
        self.resident_limit = resident_limit
        self.now = now

    def _directory(self, directory, create=False):
        if create:
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if os.path.lexists(directory):
            value = directory.lstat()
            if (not stat.S_ISDIR(value.st_mode) or directory.resolve() != directory
                    or value.st_uid != os.getuid() or value.st_mode & 0o077):
                fail('UNSAFE_STORAGE', 'Storage directory must be owned, real and private')

    def _read(self):
        for directory in (self.root, self.cold, self.metadata):
            self._directory(directory)
        if not os.path.lexists(self.file):
            if any(directory.exists() and any(directory.iterdir()) for directory in (self.root, self.cold)):
                fail('LEGACY_STORAGE', 'Existing isolated volumes require an explicit migration review')
            return {'version': 2, 'records': {}, 'operations': {}}
        value = self.file.lstat()
        if (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_uid != os.getuid()
                or value.st_mode & 0o077 or value.st_size > 4 * 1024 * 1024):
            fail('UNSAFE_STORAGE', 'Lifecycle registry is not private')
        descriptor = os.open(self.file, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'r') as stream:
            data = json.load(stream)
        if data.get('version') != 2 or not isinstance(data.get('records'), dict) or not isinstance(data.get('operations'), dict):
            fail('UNSAFE_STORAGE', 'Lifecycle registry requires review')
        if len(data['records']) > 96 or len(data['operations']) > 8192:
            fail('METADATA_CAPACITY', 'Lifecycle history requires maintenance')
        validate_capacity_metadata(data, fail)
        identities = set()
        for key, record in data['records'].items():
            if key != project_key(record.get('namespace'), record.get('projectId')):
                fail('UNSAFE_STORAGE', 'Lifecycle project identity mismatch')
            if (type(record.get('generation')) is not int or record['generation'] < 1
                    or record.get('state') not in ('resident', 'archived', 'creating', 'recovery', 'deleted')
                    or not isinstance(record.get('dirty'), bool) or not isinstance(record.get('baseline'), dict)):
                fail('UNSAFE_STORAGE', 'Lifecycle record requires review')
            if type(record.get('rasterReturnVersion', 0)) is not int or record.get('rasterReturnVersion', 0) not in (0, 1, 2):
                fail('UNSAFE_STORAGE', 'Unknown raster return policy; retained source requires review')
            if any(name in record for name in ('volumeProfileVersion', 'volumeId', 'sourceProfileId')):
                self._volume_bytes(record)
                operation(record.get('volumeId'))
                if record.get('sourceManifestVersion') != 2:
                    fail('UNSAFE_STORAGE', 'Profile volume lost its exact typed baseline')
            retained = record.get('retainedVolumes', [])
            if not isinstance(retained, list) or len(retained) > 8:
                fail('UNSAFE_STORAGE', 'Retained image history requires inspection')
            for image in retained:
                if (not isinstance(image, dict) or set(image) != {'volumeId', 'profileId', 'imageSha256', 'unmountedVerified'}
                        or image['profileId'] is not None or image['volumeId'] != 'legacy'
                        or image['unmountedVerified'] is not True or not re.fullmatch('[a-f0-9]{64}', str(image['imageSha256']))):
                    fail('UNSAFE_STORAGE', 'Unknown retained original image contract')
            pending = record.get('capacityMigration')
            if pending is not None:
                if (not isinstance(pending, dict) or set(pending) != {'planId', 'authorizationId', 'targetVolumeId', 'phase'}
                        or pending['phase'] not in ('started', 'unknown')
                        or data.get('capacityPlanStates', {}).get(pending['planId'], {}).get('phase') not in ('started', 'unknown')
                        or data.get('capacityPlans', {}).get(pending['planId'], {}).get('target', {}).get('volumeId') != pending['targetVolumeId']):
                    fail('UNSAFE_STORAGE', 'An unfinished migration lost its immutable native plan')
                operation(pending['targetVolumeId']); operation(pending['authorizationId'])
            if any(key in record for key in ('sourceManifestVersion', 'sourceManifestId', 'sourceManifestSizes')):
                if record.get('rasterReturnVersion') != 2 or record.get('sourceManifestVersion') == 2 and (record.get('volumeProfileVersion') not in (2, 3) or record.get('sourceProfileId') not in RUNTIME_PROFILES):
                    fail('UNSAFE_STORAGE', 'Typed source metadata requires its negotiated raster generation')
                record_source_manifest(record)
                if record.get('syncPending'):
                    record_source_manifest({'sourceManifestVersion': record['sourceManifestVersion'], **({'sourceProfileId': record['sourceProfileId']} if record['sourceManifestVersion'] == 2 else {}), 'baseline': record['syncTarget'],
                        'sourceManifestId': record.get('syncTargetManifestId'), 'sourceManifestSizes': record.get('syncTargetManifestSizes')})
                elif any(key in record for key in ('syncTargetManifestId', 'syncTargetManifestSizes')):
                    fail('UNSAFE_STORAGE', 'Unexpected source manifest transaction metadata')
            elif any(key in record for key in ('syncTargetManifestId', 'syncTargetManifestSizes')):
                fail('UNSAFE_STORAGE', 'Unnegotiated source manifest transaction metadata')
            owner = record.get('identity')
            if not isinstance(owner, dict):
                fail('UNSAFE_STORAGE', 'Lifecycle identity is missing')
            uid = owner.get('uid')
            if (not isinstance(uid, int) or not IDENTITIES[0] <= uid <= IDENTITIES[1] or uid in identities
                    or not isinstance(owner.get('gid'), int) or owner['gid'] < 1
                    or owner.get('name') != 'omgjob' + str(uid)):
                fail('UNSAFE_STORAGE', 'Lifecycle identity conflict')
            identities.add(uid)
        for op_id, op in data['operations'].items():
            operation(op_id)
            if op.get('key') not in data['records'] and op.get('phase') != 'cancelled':
                fail('UNSAFE_STORAGE', 'Lifecycle operation lost its project')
            if op.get('phase') not in ACTIVE | {'released', 'cancelled'}:
                fail('UNSAFE_STORAGE', 'Lifecycle operation requires review')
            if op.get('reviewSnapshotId') is not None and (op.get('mode') != 'recovery' or not isinstance(op['reviewSnapshotId'], str) or not re.fullmatch('[a-f0-9]{64}', op['reviewSnapshotId'])):
                fail('UNSAFE_STORAGE', 'Invalid reviewed recovery scope')
            if 'reviewVersion' in op and (type(op['reviewVersion']) is not int or op['reviewVersion'] != 2
                    or op.get('mode') != 'recovery' or not op.get('reviewSnapshotId')):
                fail('UNSAFE_STORAGE', 'Invalid retained review version')
            if 'captureVersion' in op:
                if (type(op['captureVersion']) is not int or op['captureVersion'] not in (2, 3, 4)
                        or op.get('mode') not in ('shell', 'build', 'install', 'preview', 'recovery')
                        or op['captureVersion'] == 2 and ('reviewVersion' in op or op.get('reviewSnapshotId'))
                        or op['captureVersion'] in (3, 4) and op.get('sourceManifestVersion') != op['captureVersion'] - 2):
                    fail('UNSAFE_STORAGE', 'Invalid streamed capture version')
            if any(key in op for key in ('sourceManifestVersion', 'sourceBaseManifestId', 'sourceResultManifestId')):
                if op.get('captureVersion') not in (3, 4):
                    fail('UNSAFE_STORAGE', 'Typed source operation lost its version 3 capture contract')
                if (op.get('generation') == data['records'][op['key']]['generation'] and data['records'][op['key']].get('sourceManifestVersion') != op.get('sourceManifestVersion')
                        or op.get('sourceManifestVersion') == 2 and (op.get('sourceProfileId') not in RUNTIME_PROFILES
                            or op.get('generation') == data['records'][op['key']]['generation'] and op.get('sourceProfileId') != data['records'][op['key']].get('sourceProfileId'))):
                    fail('UNSAFE_STORAGE', 'Typed source operation lost its generation contract')
                manifest_request(op, required=True, result='sourceResultManifestId' in op)
                if op.get('sourceDelta') is not None:
                    delta = op['sourceDelta']
                    if (not isinstance(delta, dict) or delta.get('version') != 1
                            or delta.get('beforeManifestId') != op['sourceBaseManifestId']
                            or delta.get('afterManifestId') != op.get('sourceResultManifestId')):
                        fail('UNSAFE_STORAGE', 'Invalid source manifest operation summary')
        self._known(data)
        return data

    def _save(self, data):
        try:
            self._directory(self.metadata, True)
            atomic_json(self.file, data)
        except OSError as cause:
            raise capacity_error(cause) or LifecycleError('GUEST_STORAGE_UNKNOWN',
                'Guest control metadata could not be durably recorded; retain and inspect the existing operation state.', True) from cause

    def _folder(self, key, record, state=None):
        return (self.cold if (state or record['state']) == 'archived' else self.root) / key

    def _volume_bytes(self, record):
        return record_volume_bytes(record, self.volume_bytes)

    def _workspace(self, key, record):
        folder = self._folder(key, record)
        return folder / 'mounts' / operation(record['volumeId']) / 'workspace' if record.get('volumeProfileVersion') in (2, 3) else folder / 'root/workspace'

    def _image_path(self, folder, record):
        return folder / 'images' / (operation(record['volumeId']) + '.img') if record.get('volumeProfileVersion') in (2, 3) else folder / 'disk.img'

    def _volume_images(self, key, record):
        folder = self._folder(key, record)
        images = [(self._image_path(folder, record), self._volume_bytes(record))]
        for item in record.get('retainedVolumes', []):
            path = folder / 'disk.img' if item['volumeId'] == 'legacy' else folder / 'images' / (operation(item['volumeId']) + '.img')
            images.append((path, self.volume_bytes if item['profileId'] is None else runtime_profile(item['profileId'])['volumeBytes']))
        pending = record.get('capacityMigration')
        if pending and pending['phase'] not in ('committed', 'completed') and pending['targetVolumeId'] != record.get('volumeId'):
            images.append((folder / 'images' / (operation(pending['targetVolumeId']) + '.img'), RUNTIME_PROFILE['volumeBytes']))
        if len({str(path) for path, _ in images}) != len(images): fail('UNSAFE_STORAGE', 'A registered image was counted twice')
        return images

    def _source_snapshot(self, record, workspace):
        if record.get('sourceManifestVersion') == 2:
            snapshot = self.backend.profile_snapshot(workspace, record['baseline'], record['sourceProfileId'])
            return snapshot['files'] + snapshot['retainedRasters']
        return verified_snapshot(self.backend, workspace, record['baseline'], record.get('rasterReturnVersion', 0))

    def _review_workspace(self, folder, record):
        return self.backend.review_profile_workspace(folder, record) if record.get('volumeProfileVersion') in (2, 3) else self.backend.review_workspace(folder)

    def _unmount(self, folder, record):
        return self.backend.unmount_profile(folder, record) if record.get('volumeProfileVersion') in (2, 3) else self.backend.unmount(folder)

    def _known(self, data):
        resident = set()
        archived = set()
        for key, record in data['records'].items():
            if record['state'] == 'deleted':
                continue
            if record.get('transition'):
                resident.add(key)
                archived.add(key)
            elif record['state'] == 'archived':
                archived.add(key)
            else:
                resident.add(key)
        for directory, known in ((self.root, resident), (self.cold, archived)):
            if directory.exists() and not {p.name for p in directory.iterdir()} <= known:
                fail('LEGACY_STORAGE', 'Unregistered isolated data requires review')
        for key, record in data['records'].items():
            if record['state'] != 'deleted' and (record.get('volumeProfileVersion') in (2, 3) or record.get('capacityMigration')):
                for outer in (self.root / key, self.cold / key):
                    if not outer.exists(): continue
                    self._directory(outer)
                    if not {p.name for p in outer.iterdir()} <= {'disk.img', 'owner.json', 'root', 'images', 'mounts'}:
                        fail('UNSAFE_STORAGE', 'Unregistered profile maintenance data was retained')
                    expected_images = {path.name for path, _ in self._volume_images(key, {**record,
                        'state': 'archived' if outer.parent == self.cold else 'resident'}) if path.parent.name == 'images'}
                    if (outer / 'images').exists():
                        self._directory(outer / 'images')
                        if not {path.name for path in (outer / 'images').iterdir()} <= expected_images:
                            fail('UNSAFE_STORAGE', 'An image has no immutable migration identity')
                    if (outer / 'mounts').exists():
                        self._directory(outer / 'mounts')
                        if not {path.name for path in (outer / 'mounts').iterdir()} <= {name[:-4] for name in expected_images}:
                            fail('UNSAFE_STORAGE', 'A mountpoint has no immutable image identity')
                    pending = record.get('capacityMigration')
                    if pending and record.get('volumeProfileVersion') not in (2, 3):
                        path = outer / 'images' / (pending['targetVolumeId'] + '.img')
                        if os.path.lexists(path):
                            info = path.lstat()
                            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid()
                                    or info.st_mode & 0o077 or not 0 <= info.st_size <= RUNTIME_PROFILE['volumeBytes']):
                                fail('UNSAFE_STORAGE', 'Unconfirmed migration target changed identity or bounds')
            if record.get('volumeProfileVersion') in (2, 3):
                if record['state'] == 'deleted': continue
                self._volume_bytes(record)
                operation(record.get('volumeId'))
                candidates = [p for p in (self.root / key, self.cold / key) if os.path.lexists(p)]
                if not candidates and record['state'] == 'creating': continue
                if len(candidates) != 1: fail('RECOVERY_REQUIRED', 'Profile storage is missing or duplicated')
                outer = candidates[0]; self._directory(outer)
                image = outer / 'images' / (record['volumeId'] + '.img')
                if record['state'] == 'creating':
                    if image.exists() and (image.is_symlink() or image.stat().st_size > RUNTIME_PROFILE['volumeBytes']):
                        fail('UNSAFE_STORAGE', 'Partial profile image changed')
                    continue
                self.backend.profile_paths(outer, record)
                for path, size in self._volume_images(key, {**record, 'state': 'archived' if outer.parent == self.cold else 'resident'}):
                    if not path.exists() and record.get('capacityMigration') and path.name == record['capacityMigration']['targetVolumeId'] + '.img': continue
                    info = path.lstat()
                    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077
                            or info.st_size != size): fail('UNSAFE_STORAGE', 'Retained profile image changed identity or geometry')
                continue
            if record.get('transition'):
                for directory in (self.root / key, self.cold / key):
                    if os.path.lexists(directory):
                        self._directory(directory)
                        image = directory / 'disk.img'
                        if os.path.lexists(image):
                            value = image.lstat()
                            if (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_size != self.volume_bytes
                                    or value.st_uid != os.getuid() or value.st_mode & 0o077):
                                fail('UNSAFE_STORAGE', 'Transition image changed type, size or ownership')
                continue
            if record['state'] == 'deleted':
                continue
            if record['state'] == 'creating':
                folder = self.root / key
                if os.path.lexists(self.cold / key):
                    fail('UNSAFE_STORAGE', 'An incomplete creation has an unexpected sleeping copy')
                if os.path.lexists(folder):
                    self._directory(folder)
                    image = folder / 'disk.img'
                    if os.path.lexists(image):
                        value = image.lstat()
                        if (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_size > self.volume_bytes
                                or value.st_uid != os.getuid() or value.st_mode & 0o077):
                            fail('UNSAFE_STORAGE', 'An incomplete image changed type, ownership or size')
                continue
            expected = self._folder(key, record)
            other = self._folder(key, record, 'resident' if record['state'] == 'archived' else 'archived')
            if not expected.exists() or os.path.lexists(other):
                fail('RECOVERY_REQUIRED', 'Registered storage is missing or duplicated')
            self._directory(expected)
            image = expected / 'disk.img'
            if not os.path.lexists(image):
                fail('RECOVERY_REQUIRED', 'Registered volume image is missing; it will not be recreated')
            value = image.lstat()
            if (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_size != self.volume_bytes
                    or value.st_uid != os.getuid() or value.st_mode & 0o077):
                fail('UNSAFE_STORAGE', 'Registered volume image changed type or size')
            owner_file = expected / 'owner.json'
            if not os.path.lexists(owner_file):
                fail('RECOVERY_REQUIRED', 'Registered volume ownership metadata is missing')
            owner_info = owner_file.lstat()
            if (not stat.S_ISREG(owner_info.st_mode) or owner_info.st_nlink != 1 or owner_info.st_uid != os.getuid()
                    or owner_info.st_mode & 0o077 or owner_info.st_size > 4096):
                fail('UNSAFE_STORAGE', 'Registered ownership metadata is not private')
            fd = os.open(owner_file, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'r') as stream:
                if json.load(stream) != record['identity']:
                    fail('UNSAFE_STORAGE', 'Registered ownership metadata differs from its stable identity')

    def _binding(self, data, spec, phases=None):
        key = project_key(spec.get('namespace'), spec.get('projectId'))
        op_id = operation(spec.get('operationId'))
        op = data['operations'].get(op_id)
        if (not op or op['key'] != key or op.get('generation') != spec.get('generation')
                or op.get('token') != spec.get('leaseToken') or not op.get('token')):
            fail('INVALID_BINDING', 'Operation binding is stale or belongs to another project')
        if phases is not None and op['phase'] not in phases:
            fail('INVALID_BINDING', 'Operation is not in the required phase')
        record = data['records'].get(key)
        if not record or record['state'] == 'deleted' or record['generation'] != op['generation']:
            fail('GENERATION_CHANGED', 'Isolated project generation changed')
        return key, record, op

    def _value(self, key, record, op_id, op):
        return {'namespace': record['namespace'], 'projectId': record['projectId'],
                'operationId': op_id, 'generation': op['generation'], 'leaseToken': op['token'],
                'sourceDigest': record.get('sourceDigest', source_digest([])),
                'rasterReturnVersion': record.get('rasterReturnVersion', 0) if op.get('reviewVersion') == 2 else operation_rasters(record, op),
                **({'captureVersion': op['captureVersion']} if op.get('captureVersion') in (2, 3, 4) else {}),
                **({'sourceManifestVersion': op['sourceManifestVersion'], 'sourceBaseManifestId': op['sourceBaseManifestId']} if op.get('sourceManifestVersion') in (1, 2) else {}),
                **({'sourceProfileId': op['sourceProfileId']} if op.get('sourceManifestVersion') == 2 else {}),
                **({'reviewVersion': 2} if op.get('reviewVersion') == 2 else {}),
                **({'reviewSnapshotId': op['reviewSnapshotId']} if op.get('reviewSnapshotId') else {})}

    def _manifest_binding(self, record, op, spec, result=False):
        owner = op if op is not None else record
        active = owner.get('sourceManifestVersion') in (1, 2)
        supplied = manifest_request(spec, required=active, result=result)
        expected = op['sourceBaseManifestId'] if op is not None and active else record.get('sourceManifestId')
        if supplied != active or supplied and (spec['sourceBaseManifestId'] != expected or spec['sourceManifestVersion'] != owner['sourceManifestVersion']
                or owner['sourceManifestVersion'] == 2 and spec.get('sourceProfileId') != owner.get('sourceProfileId')):
            fail('INVALID_BINDING', 'Source metadata belongs to a different generation baseline')
        if supplied and result and op is not None and spec['sourceResultManifestId'] != op.get('sourceResultManifestId'):
            fail('INVALID_BINDING', 'Source metadata differs from the captured result')
        return active

    def _manifest_snapshot(self, record, files):
        if record.get('sourceManifestVersion') not in (1, 2):
            return {}
        before = record_source_manifest(record)
        after = snapshot_source_manifest(files, record.get('sourceProfileId') if record['sourceManifestVersion'] == 2 else None)
        delta = source_delta(before, after)
        if record['sourceManifestVersion'] == 2 and delta['afterMediaBytes'] > RUNTIME_PROFILE['mediaWindowBytes']:
            fail('RETURN_WINDOW_CAPACITY', 'Changed media exceeds the single bounded return window; original guest data is retained')
        return {'sourceManifestVersion': record['sourceManifestVersion'], **({'sourceProfileId': record['sourceProfileId']} if record['sourceManifestVersion'] == 2 else {}), 'sourceBaselineManifest': before, 'sourceManifest': after,
            'sourceResultManifestId': after['manifestId'], 'sourceDelta': delta}

    def _busy(self, data, key):
        return any(op['key'] == key and op['phase'] in ACTIVE for op in data['operations'].values())

    def _global_operations(self, data):
        return sum(op['phase'] in EXECUTING for op in data['operations'].values()) + sum(
            state['phase'] in ('started', 'unknown') for state in data.get('capacityPlanStates', {}).values())

    def _capacity_orphans(self, data):
        return [plan for identifier, plan in data.get('capacityPlans', {}).items()
            if plan['source']['absent'] and project_key(plan['namespace'], plan['projectId']) not in data['records']
                and data['capacityPlanStates'][identifier]['phase'] in ('started', 'unknown')]

    def _capacity_owner_pending(self, data, key):
        return any(plan['source']['absent'] and project_key(plan['namespace'], plan['projectId']) == key
            and pending_plan(data, identifier, self.now()) for identifier, plan in data.get('capacityPlans', {}).items())

    def _reported_busy(self, data, key, record):
        operations = [op for op in data['operations'].values() if op['key'] == key and op['phase'] in ACTIVE]
        if not operations:
            return False
        if any(op.get('expiresAt', 0) >= self.now() for op in operations):
            return True
        try:
            self._idle(key, record)
            return False
        except (LifecycleError, ValueError, OSError):
            return True

    def _idle(self, key, record):
        self.backend.assert_idle(record, self._folder(key, record))

    def _capacity(self, data, new=False):
        records = [r for r in data['records'].values() if r['state'] != 'deleted']
        images = [item for key, record in data['records'].items() if record['state'] != 'deleted' for item in self._volume_images(key, record)]
        extra = self.volume_bytes if new is True else (new if type(new) is int else 0)
        orphan_bytes = len(self._capacity_orphans(data)) * RUNTIME_PROFILE['volumeBytes']
        reserved = sum(size for _, size in images) + orphan_bytes + extra
        if reserved > self.total_bytes:
            fail('CAPACITY', 'The combined resident and sleeping volume budget is full; no project was deleted')
        growth = extra + orphan_bytes
        for image, size in images:
            allocated = image.lstat().st_blocks * 512 if image.exists() else 0
            growth += max(0, size - allocated)
        if self.backend.available_bytes(self.root.parent) - growth < self.reserve_bytes + 16 * 1024 * 1024:
            fail('CAPACITY', 'Insufficient reserved guest space for volume growth and source publication')

    def _transition(self, data, key, record, destination):
        if record.get('capacityMigration'):
            fail('CAPACITY_MIGRATION_UNCERTAIN', 'Unconfirmed migration images cannot change residency')
        if self._busy(data, key):
            fail('ACTIVE_OPERATION', 'An isolated operation is still reserved')
        self._idle(key, record)
        source = self._folder(key, record)
        self._unmount(source, record)
        image = self._image_path(source, record)
        digest = file_hash(image)
        old = record['state']
        record['transition'] = {'from': old, 'to': destination, 'sha256': digest}
        self._save(data)
        self._directory(self.cold if destination == 'archived' else self.root, True)
        target = self._folder(key, record, destination)
        if target.exists() or source.stat().st_dev != target.parent.stat().st_dev:
            fail('STORAGE_CHANGED', 'Sleeping storage must remain on the same filesystem')
        source.rename(target)
        sync_directory(source.parent)
        sync_directory(target.parent)
        record['state'] = destination
        record['imageSha256'] = digest
        record.pop('transition')
        self._save(data)

    def _reconcile(self, data):
        self._known(data)
        for key, record in data['records'].items():
            transition = record.get('transition')
            if not transition:
                continue
            if transition.get('to') == 'deleted':
                if not self._folder(key, record).exists():
                    record.update(state='deleted', dirty=True)
                    record.pop('transition')
                    self._save(data)
                else:
                    fail('RECOVERY_REQUIRED', 'A partially completed deletion requires review')
                continue
            source = self._folder(key, record, transition['from'])
            target = self._folder(key, record, transition['to'])
            if source.exists() == target.exists():
                fail('RECOVERY_REQUIRED', 'Sleeping transition has missing or duplicate copies')
            existing = source if source.exists() else target
            self._directory(existing)
            self.backend.assert_idle(record, existing)
            if file_hash(self._image_path(existing, record)) != transition['sha256']:
                fail('RECOVERY_REQUIRED', 'Sleeping image changed during an interrupted transition')
            # Resolve only an already-published rename. An unstarted move is rolled back as metadata.
            record['state'] = transition['from'] if source.exists() else transition['to']
            record['imageSha256'] = transition['sha256']
            record.pop('transition')
            self._save(data)
        for op in data['operations'].values():
            if op['phase'] in ACTIVE and op.get('expiresAt', 0) < self.now():
                record = data['records'][op['key']]
                self._idle(op['key'], record)
                op['phase'] = 'released'
                record['dirty'] = True
                record['recoveryReason'] = 'The prior operation ended without a host acknowledgement'
                self._save(data)

    def _activate(self, data, key, record):
        if record.get('capacityMigration'):
            fail('CAPACITY_MIGRATION_UNCERTAIN', 'The original image migration must be verified before any new execution or recovery')
        if record['state'] in ('recovery', 'creating'):
            fail('RECOVERY_REQUIRED', 'Incomplete isolated storage requires recovery review')
        if record['state'] == 'deleted':
            fail('GENERATION_CHANGED', 'This isolated project was deleted')
        if record['state'] == 'archived':
            if file_hash(self._image_path(self._folder(key, record), record)) != record.get('imageSha256'):
                fail('RECOVERY_REQUIRED', 'Sleeping image integrity failed')
            self._make_room(data, key)
            self._transition(data, key, record, 'resident')
        return self.backend.mount_profile(self._folder(key, record), record) if record.get('volumeProfileVersion') in (2, 3) else self.backend.mount(self._folder(key, record))

    def _resident_reserved(self, data):
        result = [r for r in data['records'].values() if r['state'] not in ('archived', 'deleted') or r.get('transition', {}).get('to') == 'resident']
        result += [r for r in data['records'].values() if r.get('capacityMigration') and r['capacityMigration']['phase'] not in ('committed', 'completed') and r['capacityMigration']['targetVolumeId'] != r.get('volumeId')]
        result += self._capacity_orphans(data)
        return result

    def _make_room(self, data, exclude=None):
        reserved = self._resident_reserved(data)
        if len(reserved) < self.resident_limit:
            return
        if len(reserved) > self.resident_limit:
            fail('RECOVERY_REQUIRED', 'Incomplete resident reservations require review')
        residents = [(key, r) for key, r in data['records'].items()
                     if r['state'] == 'resident' and not r.get('transition')]
        for key, record in sorted(residents, key=lambda item: item[1].get('lastUsed', 0)):
            if key == exclude or self._busy(data, key) or record.get('pinned') or record.get('capacityMigration'):
                continue
            try:
                self._idle(key, record)
            except (LifecycleError, ValueError):
                continue
            self._transition(data, key, record, 'archived')
            return
        fail('ACTIVE_OPERATION', 'No idle resident volume can sleep; no useful project was deleted')

    def _limits(self):
        return {'residentVolumes': self.resident_limit, 'volumeBytes': self.volume_bytes,
                'totalLogicalBytes': self.total_bytes, 'reserveBytes': self.reserve_bytes,
                'globalOperations': 2, 'identityRange': list(IDENTITIES), 'operationHistory': 8192}

    def health(self):
        limits = self._limits()
        try:
            if hasattr(self.backend, 'identity_readiness'):
                self.backend.identity_readiness()
            data = self._read()
            self._known(data)
            return {'protocolVersion': 2, 'ready': True, 'limits': limits}
        except (LifecycleError, ValueError) as error:
            return {'protocolVersion': 2, 'ready': False, 'migrationRequired': True,
                    'error': str(error), 'limits': limits}

    def plan_capacity(self, spec):
        return CapacityMigration(self, globals()).plan(spec)

    def inspect_capacity_plan(self, spec):
        return CapacityMigration(self, globals()).inspect(spec)

    def register_capacity_authorization(self, spec):
        return CapacityMigration(self, globals()).register(spec)

    def migrate_capacity(self, spec):
        return CapacityMigration(self, globals()).execute(spec)

    def inventory(self, namespace):
        project_key(namespace, '00000000-0000-0000-0000-000000000000')
        data = self._read()
        self._known(data)
        return {'protocolVersion': 2, 'namespace': namespace, 'projects': [
            {'projectId': r['projectId'], 'namespace': r['namespace'], 'generation': r['generation'],
             'state': 'busy' if self._reported_busy(data, key, r) else 'recovery-pending' if r['dirty'] or r.get('syncPending') or self._busy(data, key) or r.get('transition') or r['state'] in ('recovery', 'creating') else r['state'],
             'residency': r['state'], 'dirty': r['dirty'], 'recoveryReason': r.get('recoveryReason'),
             'active': self._reported_busy(data, key, r), 'volumeBytes': self.volume_bytes,
             **({'sourceManifestVersion': r['sourceManifestVersion'], 'sourceBaseManifestId': r['sourceManifestId']} if r.get('sourceManifestVersion') in (1, 2) else {}),
             **({'sourceProfileId': r['sourceProfileId'], 'volumeProfileVersion': r['volumeProfileVersion'], 'volumeId': r['volumeId'], 'volumeBytes': RUNTIME_PROFILE['volumeBytes']} if r.get('sourceManifestVersion') == 2 else {}),
             'leaseExpiresAt': max((o.get('expiresAt', 0) for o in data['operations'].values()
                                    if o['key'] == key and o['phase'] in ACTIVE), default=0)}
            for key, r in data['records'].items() if r['namespace'] == namespace and r['state'] != 'deleted']}

    def inspect_source(self, spec):
        if (not isinstance(spec, dict) or set(spec) != {'namespace', 'projectId', 'generation'}
                or type(spec['generation']) is not int or spec['generation'] < 1):
            fail('INVALID_REQUEST', 'Source inspection requires the current project generation')
        key = project_key(spec['namespace'], spec['projectId'])
        data = self._read()
        record = data['records'].get(key)
        if not record or record['generation'] != spec['generation']:
            fail('GENERATION_CHANGED', 'Source inspection generation changed; refresh its state')
        if record['state'] != 'resident' or record.get('transition'):
            fail('INSPECTION_UNAVAILABLE', 'Source inspection requires an already resident volume; no volume was mounted')
        if record.get('syncPending'):
            fail('RECOVERY_REQUIRED', 'An interrupted source publication needs transaction recovery before inspection')
        if any(op['key'] == key and op['phase'] in EXECUTING and op.get('expiresAt', 0) >= self.now()
                for op in data['operations'].values()):
            fail('ACTIVE_OPERATION', 'An isolated operation is still reserved; source inspection did not change it')
        self._idle(key, record)
        policy = record.get('rasterReturnVersion', 0)
        inspect = self.backend.inspect_source_media if policy == 2 else (self.backend.inspect_source_rasters if policy else self.backend.inspect_source)
        result = self.backend.inspect_profile_source(self._workspace(key, record), record['baseline'], record['sourceProfileId']) if record.get('sourceManifestVersion') == 2 else inspect(self._workspace(key, record), record['baseline'])
        return {'namespace': record['namespace'], 'projectId': record['projectId'], 'generation': record['generation'], **result}

    def review_source(self, spec):
        # This endpoint returns bounded candidate bytes but never grants authority or updates the registry.
        if (not isinstance(spec, dict) or set(spec) != {'namespace', 'projectId', 'generation'}
                or type(spec['generation']) is not int or spec['generation'] < 1):
            fail('INVALID_REQUEST', 'Source review requires the current project generation')
        data = self._read()
        key = project_key(spec['namespace'], spec['projectId'])
        record = data['records'].get(key)
        if not record or record['generation'] != spec['generation']:
            fail('GENERATION_CHANGED', 'Source review generation changed; refresh its state')
        if record['state'] not in ('resident', 'archived') or record.get('transition') or record.get('syncPending'):
            fail('RECOVERY_REQUIRED', 'Unfinished storage or source transitions require separate recovery before review')
        if any(op['key'] == key and op['phase'] in EXECUTING and op.get('expiresAt', 0) >= self.now()
               for op in data['operations'].values()):
            fail('ACTIVE_OPERATION', 'An isolated operation is still reserved; source review did not change it')
        self._idle(key, record)
        if record.get('rasterReturnVersion', 0) != 0 or not record['dirty']:
            fail('INVALID_REQUEST', 'Review requires a dirty legacy generation')
        folder = self._folder(key, record)
        if record['state'] == 'archived' and file_hash(self._image_path(folder, record)) != record.get('imageSha256'):
            fail('RECOVERY_REQUIRED', 'Sleeping image integrity failed; it was not activated or changed')
        with self._review_workspace(folder, record) as workspace:
            files = verified_snapshot(self.backend, workspace, record['baseline'], True)
        return {'namespace': record['namespace'], 'projectId': record['projectId'], 'generation': record['generation'],
                'snapshotId': source_digest(files), 'files': files,
                'baselineFiles': [{'path': path, **value} for path, value in sorted(record['baseline'].items())]}

    def _retained_snapshot(self, data, key, record, workspace):
        snapshot = self.backend.profile_snapshot(workspace, record['baseline'], record['sourceProfileId']) if record.get('sourceManifestVersion') == 2 else self.backend.review_snapshot(workspace, record['baseline'])
        snapshot_id = source_digest(snapshot['files'] + snapshot['retainedRasters'])
        origins = [{'operationId': op_id, 'mode': op['mode'], 'phase': op['phase'], 'snapshotId': snapshot_id,
                    'acknowledged': op.get('acknowledged') == snapshot_id,
                    **({'sourceManifestVersion': op['sourceManifestVersion'], 'sourceBaseManifestId': op['sourceBaseManifestId'],
                        'sourceResultManifestId': op['sourceResultManifestId'], **({'sourceProfileId': op['sourceProfileId']} if op['sourceManifestVersion'] == 2 else {})} if op.get('sourceManifestVersion') in (1, 2) and op.get('sourceResultManifestId') else {})}
            for op_id, op in sorted(data['operations'].items(), key=lambda item: (item[0] == record.get('operationId'), item[0]))
            if op['key'] == key and op.get('generation') == record['generation']
                and op.get('mode') in ('shell', 'build', 'install', 'recovery') and op['phase'] in ('finished', 'released')
                and op.get('snapshotId') == snapshot_id][-32:]
        return {'reviewVersion': 2, 'namespace': record['namespace'], 'projectId': record['projectId'],
                'generation': record['generation'], 'snapshotId': snapshot_id,
                'rasterReturnVersion': record.get('rasterReturnVersion', 0), **snapshot,
                'baselineFiles': [{'path': path, **value} for path, value in sorted(record['baseline'].items())],
                'originOperations': origins, **self._manifest_snapshot(record, snapshot['files'] + snapshot['retainedRasters'])}

    def review_source_media(self, spec, output=None):
        retained_review_request(spec)
        key = project_key(spec['namespace'], spec['projectId'])
        data = self._read()
        record = data['records'].get(key)
        if not record or record['generation'] != spec['generation']:
            fail('GENERATION_CHANGED', 'Retained review generation changed')
        self._manifest_binding(record, None, spec)
        if record['state'] not in ('resident', 'archived') or record.get('transition') or record.get('syncPending'):
            fail('RECOVERY_REQUIRED', 'Unfinished storage or source transitions require separate recovery')
        if any(op['key'] == key and op['phase'] in EXECUTING and op.get('expiresAt', 0) >= self.now()
               for op in data['operations'].values()):
            fail('ACTIVE_OPERATION', 'An isolated operation is still reserved')
        self._idle(key, record)
        folder = self._folder(key, record)
        if record['state'] == 'archived' and file_hash(self._image_path(folder, record)) != record.get('imageSha256'):
            fail('RECOVERY_REQUIRED', 'Sleeping image integrity failed; every version was retained')
        with self._review_workspace(folder, record) as workspace:
            snapshot = self._retained_snapshot(data, key, record, workspace)
            if output is not None:
                self.backend.stream_review(workspace, snapshot, output)
        return snapshot

    def overview(self):
        """One shared-lock snapshot, without reconciling leases, transitions or source."""
        if hasattr(self.backend, 'identity_readiness'):
            self.backend.identity_readiness()
        data = self._read()
        if self.metadata.exists() and any(p.name != 'registry.json' for p in self.metadata.iterdir()):
            fail('UNSAFE_STORAGE', 'Unfinished lifecycle metadata requires inspection')
        projects, trusted = [], True
        active = {}
        for op_id, op in data['operations'].items():
            if op['phase'] in ACTIVE:
                active.setdefault(op['key'], []).append((op_id, op))
        now = self.now()
        capacity_reservations = [{'namespace': plan['namespace'], 'projectId': plan['projectId'],
            'planId': plan['planId'], 'targetVolumeId': plan['target']['volumeId'], 'volumeBytes': RUNTIME_PROFILE['volumeBytes'],
            'phase': data['capacityPlanStates'][plan['planId']]['phase'], 'sourceAbsent': True}
            for plan in self._capacity_orphans(data)]
        if capacity_reservations:
            trusted = False
        for key, record in sorted(data['records'].items()):
            if (type(record['generation']) is not int or type(record['identity']['uid']) is not int
                    or type(record['identity']['gid']) is not int
                    or type(record.get('pinned', False)) is not bool):
                fail('UNSAFE_STORAGE', 'Lifecycle record requires inspection')
            if record['state'] == 'deleted':
                if record.get('transition'):
                    fail('UNSAFE_STORAGE', 'Deleted storage has an unfinished transition')
                continue
            transition = record.get('transition')
            if transition is not None:
                if (not isinstance(transition, dict) or transition.get('from') != record['state']
                        or transition.get('to') not in ('resident', 'archived', 'deleted')
                        or transition['to'] == transition['from']):
                    fail('UNSAFE_STORAGE', 'Lifecycle transition requires inspection')
                if transition['to'] != 'deleted':
                    if (transition['from'] not in ('resident', 'archived')
                            or not isinstance(transition.get('sha256'), str)
                            or not re.fullmatch('[a-f0-9]{64}', transition['sha256'])):
                        fail('UNSAFE_STORAGE', 'Lifecycle transition requires inspection')
                    copies = [p for p in (self.root / key, self.cold / key) if os.path.lexists(p)]
                    if len(copies) != 1 or not self._image_path(copies[0], record).exists():
                        fail('RECOVERY_REQUIRED', 'Transition storage is missing or duplicated')
                    owner = copies[0] / 'owner.json'
                    info = owner.lstat()
                    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid()
                            or info.st_mode & 0o077 or info.st_size > 4096):
                        fail('UNSAFE_STORAGE', 'Transition ownership metadata requires inspection')
                    fd = os.open(owner, os.O_RDONLY | os.O_NOFOLLOW)
                    with os.fdopen(fd, 'r') as stream:
                        if json.load(stream) != record['identity']:
                            fail('UNSAFE_STORAGE', 'Transition ownership metadata differs from its identity')
                elif not isinstance(transition.get('entries'), list):
                    fail('UNSAFE_STORAGE', 'Deletion intent requires inspection')
                trusted = False
            if record['state'] in ('creating', 'recovery') or record.get('syncPending') or record.get('capacityMigration'):
                trusted = False
            if record.get('syncPending') is not None:
                pending = record['syncPending']
                if (not isinstance(pending, str) or not re.fullmatch('[a-f0-9]{32}', pending)
                        or data['operations'].get(pending, {}).get('key') != key
                        or record.get('operationId') != pending):
                    fail('UNSAFE_STORAGE', 'Source publication intent requires inspection')
            tasks = []
            for op_id, op in active.get(key, []):
                expires = op.get('expiresAt')
                if (type(op.get('generation')) is not int or op['generation'] != record['generation']
                        or record.get('operationId') != op_id
                        or not isinstance(op.get('token'), str) or not re.fullmatch('[a-f0-9]{32}', op['token'])
                        or op.get('mode') not in ('install', 'build', 'preview', 'shell', 'recovery')
                        or type(expires) not in (int, float) or not math.isfinite(expires) or expires < 0
                        or record['state'] != 'resident' or transition is not None or tasks):
                    fail('UNSAFE_STORAGE', 'Lifecycle task requires inspection')
                if op.get('acknowledged') is not None and (not isinstance(op['acknowledged'], str)
                        or not re.fullmatch('[a-f0-9]{64}', op['acknowledged'])
                        or op.get('snapshotId') != op['acknowledged']):
                    fail('UNSAFE_STORAGE', 'Lifecycle acknowledgement requires inspection')
                phase = op['phase']
                if expires < now:
                    phase, trusted = 'expired-uncertain', False
                elif phase == 'finished' and not op.get('acknowledged'):
                    phase = 'finished-awaiting-ack'
                tasks.append({'phase': phase, 'mode': op['mode'], 'leaseExpiresAt': expires})
            projects.append({'namespace': record['namespace'], 'projectId': record['projectId'],
                             'generation': record['generation'], 'residency': record['state'],
                             'volumeProfileVersion': record.get('volumeProfileVersion', 0),
                             'sourceProfileId': record.get('sourceProfileId'), 'volumeId': record.get('volumeId', 'legacy'),
                             'volumeBytes': self._volume_bytes(record),
                             'retainedVolumeBytes': sum(self.volume_bytes if item['profileId'] is None else runtime_profile(item['profileId'])['volumeBytes'] for item in record.get('retainedVolumes', [])),
                             'stagingVolumeBytes': RUNTIME_PROFILE['volumeBytes'] if record.get('capacityMigration') and record['capacityMigration']['targetVolumeId'] != record.get('volumeId') else 0,
                             'logicalBytes': sum(size for _, size in self._volume_images(key, record)),
                             'transition': None if transition is None else {k: transition[k] for k in ('from', 'to')},
                             'dirty': record['dirty'], 'pinned': record.get('pinned', False),
                             'syncPending': bool(record.get('syncPending')), 'tasks': tasks})
        reserved = len(self._resident_reserved(data))
        if sum(len(p['tasks']) for p in projects) != sum(o['phase'] in ACTIVE for o in data['operations'].values()):
            fail('UNSAFE_STORAGE', 'An unfinished task lost its allocated project')
        orphan_bytes = sum(item['volumeBytes'] for item in capacity_reservations)
        if reserved > self.resident_limit or sum(project['logicalBytes'] for project in projects) + orphan_bytes > self.total_bytes:
            fail('UNSAFE_STORAGE', 'Lifecycle reservations exceed the configured resource profile')
        return {'protocolVersion': 2, 'scope': 'global', 'ready': True, 'limits': self._limits(), 'capacityOverviewVersion': 1,
                'countsTrusted': trusted,
                'counts': {'allocatedProjects': len(projects), 'residentReserved': reserved,
                           'allocatedLogicalBytes': sum(project['logicalBytes'] for project in projects) + orphan_bytes,
                           'retainedBackupBytes': sum(project['retainedVolumeBytes'] for project in projects),
                           'stagingLogicalBytes': sum(project['stagingVolumeBytes'] for project in projects) + orphan_bytes,
                           'freeSlots': self.resident_limit - reserved if trusted else None,
                           'resident': sum(p['residency'] == 'resident' and p['transition'] is None for p in projects),
                           'sleeping': sum(p['residency'] == 'archived' and p['transition'] is None for p in projects)},
                'projects': projects, 'capacityReservations': capacity_reservations}

    def prepare(self, spec):
        if spec.get('sourceManifestVersion') == 2 or 'sourceProfileId' in spec:
            fail('PROTOCOL_REQUIRED', 'Runtime profile source requires its complete multi-window preparation')
        policy = spec.get('rasterReturnVersion', 0)
        if type(policy) is not int or policy not in (0, 1, 2):
            fail('INVALID_REQUEST', 'Unknown raster return policy')
        if 'sourceBaseManifestId' in spec or 'sourceResultManifestId' in spec:
            fail('INVALID_REQUEST', 'Preparation source identity must be derived from its complete seed metadata')
        key = project_key(spec.get('namespace'), spec.get('projectId'))
        op_id = operation(spec.get('operationId'))
        if spec.get('mode') not in ('install', 'build', 'preview', 'shell'):
            fail('INVALID_REQUEST', 'Invalid isolated mode')
        files = self.backend.validate_files(spec.get('files'))
        seed = None
        if 'sourceManifestVersion' in spec or 'sourceManifest' in spec:
            if type(spec.get('sourceManifestVersion')) is not int or spec['sourceManifestVersion'] != 1 or policy != 2:
                fail('INVALID_REQUEST', 'Typed source preparation requires manifest version 1 and capture version 2')
            seed = parse_source_manifest(spec.get('sourceManifest'))
            if seed != snapshot_source_manifest(files):
                fail('INVALID_REQUEST', 'Preparation metadata differs from the complete transferred source')
        packages = self.backend.validate_packages(spec.get('packages', []))
        data = self._read()
        self._reconcile(data)
        if op_id in data['operations']:
            fail('INVALID_BINDING', 'Operation identity has already been used or cancelled')
        if len(data['operations']) >= 8192 or self._global_operations(data) >= 2:
            fail('ACTIVE_OPERATION', 'The global isolated operation or history budget is full')
        if self._busy(data, key):
            fail('ACTIVE_OPERATION', 'The project already has an isolated operation')
        record = data['records'].get(key)
        if self._capacity_owner_pending(data, key):
            fail('CAPACITY_MIGRATION_UNCERTAIN', 'The original native allocation intent still owns this absent project')
        if record and record.get('volumeProfileVersion') in (2, 3):
            fail('PROTOCOL_REQUIRED', 'This profile requires its explicitly versioned complete window preparation')
        if record and (record['dirty'] or record.get('syncPending')):
            fail('RECOVERY_REQUIRED', 'Unreturned guest changes must be recovered before preparing new source')
        if record and record.get('sourceManifestVersion') == 1 and seed is None:
            fail('INVALID_REQUEST', 'This source generation requires explicit typed preparation metadata')
        self._capacity(data, record is None)
        if record is None:
            if len(data['records']) >= 96:
                fail('CAPACITY', 'The stable identity registry requires maintenance')
            self._make_room(data)
            identity = self.backend.allocate_identity({r['identity']['uid'] for r in data['records'].values() if r.get('identity')})
            record = {'namespace': spec['namespace'], 'projectId': spec['projectId'], 'generation': 1,
                      'state': 'creating', 'dirty': False, 'baseline': {}, 'identity': identity, 'lastUsed': self.now()}
            data['records'][key] = record
            self._save(data)
            folder = self.root / key
            self._directory(self.root, True)
            self.backend.create(folder, self.volume_bytes, identity)
            record['state'] = 'resident'
            self._save(data)
        mount = self._activate(data, key, record)
        current = verified_snapshot(self.backend, mount / 'workspace', record['baseline'], record.get('rasterReturnVersion', 0)) if (mount / 'workspace').exists() else []
        if source_map(current) != record['baseline']:
            record.update(dirty=True, recoveryReason='Guest source differs from its last acknowledged baseline')
            self._save(data)
            fail('RECOVERY_REQUIRED', record['recoveryReason'])
        record['generation'] += 1
        record['rasterReturnVersion'] = policy
        if seed is not None:
            retain_source_manifest(record, snapshot_source_manifest(current))
        op = {'key': key, 'generation': record['generation'], 'token': uuid.uuid4().hex,
              'phase': 'prepared', 'mode': spec['mode'], 'expiresAt': self.now() + 120,
              **({'captureVersion': 3 if seed is not None else 2} if policy == 2 else {}),
              **({'sourceManifestVersion': 1, 'sourceBaseManifestId': seed['manifestId']} if seed is not None else {})}
        data['operations'][op_id] = op
        record['operationId'] = op_id
        record['lastUsed'] = self.now()
        record['syncPending'] = op_id
        record['syncTarget'] = source_map(files)
        if seed is not None:
            record.update(syncTargetManifestId=seed['manifestId'], syncTargetManifestSizes=[item['size'] for item in seed['files']])
        self._save(data)
        try:
            self.backend.sync(mount, files, packages, record['identity'], record['baseline'], op_id)
        except Exception as cause:
            cause.changed = True
            if isinstance(cause, OSError) and not getattr(cause, 'code', None):
                cause.code = 'GUEST_IO_UNKNOWN'
            record.update(dirty=True, recoveryReason='Source publication did not finish; its transaction is retained')
            op['phase'] = 'released'
            self._save(data)
            raise
        record['baseline'] = source_map(files)
        record['sourceDigest'] = source_digest(files)
        if seed is not None:
            retain_source_manifest(record, seed)
        self._save(data)
        try:
            self.backend.finalize_sync(mount, op_id)
        except OSError as cause:
            cause.changed = True
            if not getattr(cause, 'code', None):
                cause.code = 'GUEST_IO_UNKNOWN'
            raise
        record.pop('syncPending')
        record.pop('syncTarget')
        record.pop('syncTargetManifestId', None)
        record.pop('syncTargetManifestSizes', None)
        self._save(data)
        return {'prepared': True, 'protocolVersion': 2, **self._value(key, record, op_id, op)}

    def prepare_begin(self, spec):
        if type(spec.get('sourceManifestVersion')) is not int or spec['sourceManifestVersion'] != 2 or spec.get('sourceProfileId') not in RUNTIME_PROFILES or type(spec.get('rasterReturnVersion')) is not int or spec['rasterReturnVersion'] != 2:
            fail('INVALID_REQUEST', 'Windowed preparation requires the exact runtime profile contract')
        seed = parse_source_manifest(spec.get('sourceManifest'))
        if seed['version'] != 2 or seed['profile'] != spec['sourceProfileId']: fail('INVALID_REQUEST', 'A legacy manifest cannot enter profile preparation')
        files = self.backend.validate_profile_files(spec.get('files'), spec['sourceProfileId'])
        packages = self.backend.validate_packages(spec.get('packages', []))
        if seed != snapshot_source_manifest(files, spec['sourceProfileId']): fail('INVALID_REQUEST', 'The complete profile seed differs from its payload declarations')
        key = project_key(spec.get('namespace'), spec.get('projectId')); op_id = operation(spec.get('operationId'))
        if spec.get('mode') not in ('install', 'build', 'preview', 'shell'): fail('INVALID_REQUEST', 'Unknown profile execution mode')
        data = self._read(); self._reconcile(data); record = data['records'].get(key)
        if not record or record.get('volumeProfileVersion') not in (2, 3) or record.get('sourceProfileId') != spec['sourceProfileId']:
            fail('CAPACITY_PROFILE_REQUIRED', 'Explicit native profile creation or migration is required; no legacy volume was created')
        if record['dirty'] or record.get('syncPending') or record.get('capacityMigration'):
            fail('RECOVERY_REQUIRED', 'The existing profile operation must settle before any new preparation')
        if op_id in data['operations'] or self._busy(data, key): fail('ACTIVE_OPERATION', 'The original operation still owns this project')
        if self._global_operations(data) >= 2: fail('ACTIVE_OPERATION', 'The global operation budget is full')
        self._capacity(data); mount = self._activate(data, key, record); self._idle(key, record)
        if source_map(self._source_snapshot(record, mount / 'workspace')) != record['baseline']:
            record.update(dirty=True, recoveryReason='Profile source differs from its acknowledged baseline'); self._save(data)
            fail('RECOVERY_REQUIRED', record['recoveryReason'])
        record['generation'] += 1
        op = {'key': key, 'generation': record['generation'], 'token': uuid.uuid4().hex, 'phase': 'prepared', 'mode': spec['mode'],
            'expiresAt': self.now() + 120, 'captureVersion': 4, 'sourceManifestVersion': 2, 'sourceProfileId': record['sourceProfileId'],
            'sourceBaseManifestId': seed['manifestId'], 'uploadVersion': 1, 'uploadCommitted': False}
        data['operations'][op_id] = op; record.update(operationId=op_id, syncPending=op_id, syncTarget=source_map(files),
            syncTargetManifestId=seed['manifestId'], syncTargetManifestSizes=[item['size'] for item in seed['files']], lastUsed=self.now())
        self._save(data)
        try: windows = self.backend.begin_windowed_sync(mount, files, packages, record['identity'], record['baseline'], op_id, seed['manifestId'], record['sourceProfileId'])
        except Exception as cause:
            cause.changed = True
            if isinstance(cause, OSError): cause.code = getattr(cause, 'code', 'GUEST_IO_UNKNOWN')
            record.update(dirty=True, recoveryReason='Profile preparation is retained for exact transaction recovery'); op['phase'] = 'released'; self._save(data); raise
        return {'prepared': False, 'protocolVersion': 2, 'uploadVersion': 1, 'windowCount': len(windows), 'windows': windows,
            **self._value(key, record, op_id, op)}

    def _window_binding(self, data, spec):
        allowed = {'namespace', 'projectId', 'operationId', 'generation', 'leaseToken', 'captureVersion', 'sourceManifestVersion',
            'sourceProfileId', 'sourceBaseManifestId', 'rasterReturnVersion', 'uploadVersion', 'windowIndex', 'windowId'}
        if set(spec) - allowed or type(spec.get('uploadVersion')) is not int or spec['uploadVersion'] != 1 or (type(spec.get('captureVersion')) is not int or spec['captureVersion'] != 4):
            fail('INVALID_BINDING', 'Unknown profile preparation scope')
        if 'rasterReturnVersion' in spec and (type(spec['rasterReturnVersion']) is not int or spec['rasterReturnVersion'] != 2):
            fail('INVALID_BINDING', 'Profile preparation cannot change its raster return contract')
        key, record, op = self._binding(data, spec, {'prepared'})
        self._manifest_binding(record, op, spec)
        if op.get('uploadVersion') != 1 or op.get('uploadUncertain') or op.get('cancelled') or op.get('expiresAt', 0) < self.now():
            fail('WINDOW_UNCERTAIN', 'The original upload is cancelled, expired or unconfirmed; it cannot be replayed')
        self._idle(key, record)
        return key, record, op

    def prepare_append(self, spec, stream, need_media):
        data = self._read(); key, record, op = self._window_binding(data, spec)
        if record.get('syncPending') != spec['operationId'] or op.get('uploadCommitted'):
            fail('INVALID_BINDING', 'This upload no longer owns its exact source transaction')
        if type(spec.get('windowIndex')) is not int: fail('INVALID_REQUEST', 'A fixed window index is required')
        operation(spec.get('windowId'))
        try:
            self.backend.append_windowed_sync(self._workspace(key, record).parent, spec['operationId'], op['sourceBaseManifestId'],
                spec['windowIndex'], spec['windowId'], stream, need_media, record['identity'])
        except Exception as cause:
            if getattr(cause, 'code', '') == 'INVALID_BINDING':
                raise
            cause.changed = True
            if isinstance(cause, OSError): cause.code = getattr(cause, 'code', 'GUEST_IO_UNKNOWN')
            op['uploadUncertain'] = True
            record.update(dirty=True, recoveryReason='An upload window is unconfirmed; retain its exact transaction'); self._save(data); raise
        op['expiresAt'] = self.now() + 120; self._save(data)
        return {'appended': True, 'windowIndex': spec['windowIndex'], 'windowId': spec['windowId']}

    def prepare_commit(self, spec):
        data = self._read(); key, record, op = self._window_binding(data, spec)
        if 'windowIndex' in spec or 'windowId' in spec: fail('INVALID_REQUEST', 'Commit addresses the complete preparation, not one window')
        if op.get('uploadCommitted') and not record.get('syncPending'):
            return {'prepared': True, 'protocolVersion': 2, **self._value(key, record, spec['operationId'], op)}
        if record.get('syncPending') != spec['operationId']: fail('INVALID_BINDING', 'The original transaction no longer owns this project')
        mount = self._workspace(key, record).parent
        try:
            files = self.backend.commit_windowed_sync(mount, spec['operationId'], op['sourceBaseManifestId'], record['identity'])
            target = record_source_manifest({'sourceManifestVersion': 2, 'sourceProfileId': record['sourceProfileId'], 'baseline': record['syncTarget'],
                'sourceManifestId': record['syncTargetManifestId'], 'sourceManifestSizes': record['syncTargetManifestSizes']})
            snapshot = self.backend.profile_snapshot(mount / 'workspace', record['syncTarget'], record['sourceProfileId'])
            actual = snapshot['files'] + snapshot['retainedRasters']
            if snapshot_source_manifest(actual, record['sourceProfileId']) != target: fail('GENERATION_CHANGED', 'The complete committed seed changed', True)
            record.update(baseline=source_map(files), sourceDigest=source_digest(actual)); retain_source_manifest(record, target); self._save(data)
            self.backend.finalize_sync(mount, spec['operationId'])
        except Exception as cause:
            cause.changed = True
            if isinstance(cause, OSError): cause.code = getattr(cause, 'code', 'GUEST_IO_UNKNOWN')
            record.update(dirty=True, recoveryReason='Profile commit is unconfirmed; use its original transaction'); self._save(data); raise
        for name in ('syncPending', 'syncTarget', 'syncTargetManifestId', 'syncTargetManifestSizes'): record.pop(name, None)
        record['dirty'] = False; op.update(uploadCommitted=True, expiresAt=self.now() + 120); self._save(data)
        return {'prepared': True, 'protocolVersion': 2, **self._value(key, record, spec['operationId'], op)}

    def validate_binding(self, spec, phases=('running',)):
        data = self._read()
        key, record, op = self._binding(data, spec, set(phases))
        if record['state'] != 'resident' or record.get('syncPending'):
            fail('INVALID_BINDING', 'Operation volume is not resident')
        return {'workspace': str(self._workspace(key, record)),
                **({'sourceProfileId': record['sourceProfileId']} if record.get('sourceManifestVersion') == 2 else {}),
                'identity': record['identity'], 'phase': op['phase'], 'generation': record['generation'],
                'runtimeMedia': {p: v for p, v in record['baseline'].items() if 'size' in v}}

    def claim(self, spec):
        data = self._read()
        key, record, op = self._binding(data, spec, {'prepared'})
        if record.get('syncPending') or op.get('mode') != spec.get('mode') or op.get('expiresAt', 0) < self.now() or op.get('cancelled'):
            fail('INVALID_BINDING', 'Prepared operation expired, changed mode or was cancelled')
        self._idle(key, record)
        op.update(phase='running', expiresAt=self.now() + 1000)
        record['dirty'] = True
        self._save(data)
        return self.validate_binding(spec)

    def finish(self, spec, succeeded):
        data = self._read()
        key, record, op = self._binding(data, spec, {'prepared', 'running', 'cancel-requested', 'finished'})
        self._idle(key, record)
        mount = self._workspace(key, record).parent
        recovery_reason = 'Guest changes have not been acknowledged by the host'
        try:
            files = self._source_snapshot(record, mount / 'workspace')
            record['dirty'] = bool(record.get('syncPending')) or source_map(files) != record['baseline']
            digest = source_digest(files)
        except Exception as error:
            record['dirty'] = True
            digest = None
            recovery_reason = 'Source capture failed; isolated data is retained: ' + str(error)[:1000]
        if record['dirty']:
            record['recoveryReason'] = recovery_reason
        else:
            record.pop('recoveryReason', None)
        op.update(phase='finished', succeeded=bool(succeeded), expiresAt=self.now() + 120)
        self._save(data)
        return {'finished': True, 'dirty': record['dirty'], 'sourceDigest': digest}

    def capture(self, spec):
        data = self._read()
        key, record, op = self._binding(data, spec, {'finished'})
        if record.get('syncPending'):
            fail('RECOVERY_REQUIRED', 'The interrupted source transaction must be resolved first')
        typed = self._manifest_binding(record, op, spec)
        if typed and op.get('acknowledged'):
            fail('INVALID_BINDING', 'An acknowledged typed capture requires a fresh current-baseline review')
        self._idle(key, record)
        if op.get('reviewVersion') != 2 and (op.get('captureVersion') in (2, 3, 4) or 'captureVersion' in spec or record.get('rasterReturnVersion') == 2):
            fail('INVALID_BINDING', 'This operation requires its explicitly negotiated streamed capture')
        if op.get('captureVersion') in (3, 4) and (type(spec.get('captureVersion')) is not int or spec['captureVersion'] != op['captureVersion']):
            fail('INVALID_BINDING', 'Typed reviewed capture requires its negotiated capture version')
        if op.get('captureVersion') not in (3, 4) and 'captureVersion' in spec:
            fail('INVALID_BINDING', 'Reviewed capture cannot acquire a different capture contract')
        if op.get('reviewVersion') == 2:
            if type(spec.get('reviewVersion')) is not int or spec['reviewVersion'] != 2:
                fail('INVALID_BINDING', 'Retained capture requires review version 2')
            snapshot = self._retained_snapshot(data, key, record, self._workspace(key, record))
            if snapshot['snapshotId'] != op['reviewSnapshotId']:
                fail('GENERATION_CHANGED', 'Retained source changed after its review')
            if typed and (snapshot['sourceBaselineManifest']['manifestId'] != op['sourceBaseManifestId']
                    or snapshot['sourceResultManifestId'] != op['sourceResultManifestId']):
                fail('GENERATION_CHANGED', 'Retained source metadata changed after its approved review')
            op['snapshotId'] = snapshot['snapshotId']
            self._save(data)
            return snapshot
        if 'reviewVersion' in spec:
            fail('INVALID_BINDING', 'A normal capture cannot acquire retained review authority')
        files = self._source_snapshot(record, self._workspace(key, record)) if record.get('sourceManifestVersion') == 2 else verified_snapshot(self.backend, self._workspace(key, record), record['baseline'], operation_rasters(record, op))
        snapshot_id = source_digest(files)
        if op.get('reviewSnapshotId') and snapshot_id != op['reviewSnapshotId']:
            fail('GENERATION_CHANGED', 'Reviewed source changed before capture')
        op['snapshotId'] = snapshot_id
        self._save(data)
        return {'files': files, 'snapshotId': snapshot_id, 'generation': record['generation'], 'rasterReturnVersion': 1 if operation_rasters(record, op) else 0,
                'baselineFiles': [{'path': path, **value} for path, value in sorted(record['baseline'].items())]}

    def capture_media(self, spec, output=None):
        media_capture_request(spec)
        data = self._read()
        key, record, op = self._binding(data, spec, {'finished'})
        if op.get('captureVersion') != spec['captureVersion'] or record.get('rasterReturnVersion') != 2 or record.get('syncPending') or op.get('reviewVersion'):
            fail('INVALID_BINDING', 'Streamed capture was not negotiated for this operation')
        typed = self._manifest_binding(record, op, spec)
        if typed and op.get('acknowledged'):
            fail('INVALID_BINDING', 'An acknowledged typed capture requires a fresh current-baseline review')
        self._idle(key, record)
        workspace = self._workspace(key, record)
        snapshot = self.backend.profile_snapshot(workspace, record['baseline'], record['sourceProfileId']) if record.get('sourceManifestVersion') == 2 else self.backend.review_snapshot(workspace, record['baseline'])
        snapshot_id = source_digest(snapshot['files'] + snapshot['retainedRasters'])
        if op.get('snapshotId') is not None and op['snapshotId'] != snapshot_id:
            fail('GENERATION_CHANGED', 'Guest source differs from the original operation capture')
        manifest = {'captureVersion': op['captureVersion'], 'namespace': record['namespace'], 'projectId': record['projectId'],
            'operationId': spec['operationId'], 'generation': record['generation'], 'snapshotId': snapshot_id,
            'rasterReturnVersion': 2, 'files': snapshot['files'],
            'baselineFiles': [{'path': path, **value} for path, value in sorted(record['baseline'].items())],
            'returnedRasters': snapshot['retainedRasters'],
            **self._manifest_snapshot(record, snapshot['files'] + snapshot['retainedRasters'])}
        if typed and op['sourceBaseManifestId'] != manifest['sourceBaselineManifest']['manifestId']:
            fail('INVALID_BINDING', 'Typed capture baseline differs from its original operation')
        if typed and op.get('sourceResultManifestId') not in (None, manifest['sourceResultManifestId']):
            fail('GENERATION_CHANGED', 'Typed source result differs from its original operation capture')
        if 'snapshotId' not in op:
            op['snapshotId'] = snapshot_id
            if typed:
                op['sourceResultManifestId'] = manifest['sourceResultManifestId']
            self._save(data)
        if output is not None:
            self.backend.stream_capture(workspace, manifest, output)
        return manifest

    def acknowledge(self, spec):
        data = self._read()
        key, record, op = self._binding(data, spec, {'finished', 'released'})
        typed = self._manifest_binding(record, op, spec, result=True)
        reviewed = op.get('reviewVersion') == 2
        streamed = op.get('captureVersion') in (2, 3, 4)
        if (reviewed and (type(spec.get('reviewVersion')) is not int or spec['reviewVersion'] != 2)
                or not reviewed and 'reviewVersion' in spec):
            fail('INVALID_BINDING', 'Source acknowledgement review version differs from its operation')
        if (streamed and (record.get('rasterReturnVersion') != 2 or type(spec.get('captureVersion')) is not int or spec['captureVersion'] != op['captureVersion'])
                or not streamed and 'captureVersion' in spec
                or record.get('rasterReturnVersion') == 2 and not streamed and not reviewed):
            fail('INVALID_BINDING', 'Source acknowledgement capture version differs from its operation')
        snapshot_id = spec.get('snapshotId')
        if snapshot_id and op.get('acknowledged') == snapshot_id:
            return {'acknowledged': True}
        if record.get('operationId') != spec.get('operationId'):
            fail('INVALID_BINDING', 'A newer operation owns this project')
        if not snapshot_id or op.get('snapshotId') != snapshot_id:
            fail('INVALID_BINDING', 'Source acknowledgement does not match the captured snapshot')
        self._idle(key, record)
        if reviewed:
            snapshot = self._retained_snapshot(data, key, record, self._workspace(key, record))
            if snapshot_id != op['reviewSnapshotId']:
                fail('INVALID_BINDING', 'Retained acknowledgement differs from its reviewed snapshot')
            files = snapshot['files'] + snapshot['retainedRasters']
        else:
            files = self._source_snapshot(record, self._workspace(key, record)) if record.get('sourceManifestVersion') == 2 else verified_snapshot(self.backend, self._workspace(key, record), record['baseline'], operation_rasters(record, op))
        if source_digest(files) != snapshot_id:
            fail('GENERATION_CHANGED', 'Guest source changed after capture')
        typed_manifest = snapshot_source_manifest(files, record['sourceProfileId'] if record.get('sourceManifestVersion') == 2 else None) if typed else None
        if typed and typed_manifest['manifestId'] != spec['sourceResultManifestId']:
            fail('GENERATION_CHANGED', 'Typed source metadata changed after capture')
        record.update(baseline=source_map(files), sourceDigest=snapshot_id, dirty=False)
        if typed:
            retain_source_manifest(record, typed_manifest)
        record.pop('recoveryReason', None)
        op['acknowledged'] = snapshot_id
        self._save(data)
        return {'acknowledged': True}

    def release(self, spec):
        data = self._read()
        key, record, op = self._binding(data, spec, {'prepared', 'finished', 'cancel-requested', 'released'})
        if op['phase'] != 'released':
            self._idle(key, record)
            op['phase'] = 'released'
            self._save(data)
        return {'released': True, 'dirty': record['dirty']}

    def lookup(self, spec):
        data = self._read()
        key = project_key(spec.get('namespace'), spec.get('projectId'))
        op_id = operation(spec.get('operationId'))
        op = data['operations'].get(op_id)
        if not op:
            return None
        if op['key'] != key:
            fail('INVALID_BINDING', 'Operation belongs to another project')
        if op['phase'] not in ACTIVE:
            return None
        return self._value(key, data['records'][key], op_id, op)

    def cancel(self, spec):
        data = self._read()
        key = project_key(spec.get('namespace'), spec.get('projectId'))
        op_id = operation(spec.get('operationId'))
        op = data['operations'].get(op_id)
        if op and op['key'] != key:
            fail('INVALID_BINDING', 'Operation belongs to another project')
        if not op:
            if len(data['operations']) >= 8192:
                fail('METADATA_CAPACITY', 'Cancellation history is full')
            data['operations'][op_id] = {'key': key, 'phase': 'cancelled'}
            self._save(data)
            return {'cancelled': True, 'operation': None}
        if op['phase'] not in ACTIVE:
            return {'cancelled': True, 'operation': None}
        op.update(phase='cancel-requested', cancelled=True)
        self._save(data)
        return {'cancelled': True, 'operation': self._value(key, data['records'][key], op_id, op)}

    def recover(self, spec):
        review_id = spec.get('reviewSnapshotId')
        review_version = spec.get('reviewVersion')
        if 'reviewVersion' in spec and (type(review_version) is not int or review_version != 2 or review_id is None):
            fail('INVALID_REQUEST', 'Retained recovery requires review version 2 and its snapshot')
        if review_id is not None and (not isinstance(review_id, str) or not re.fullmatch('[a-f0-9]{64}', review_id)):
            fail('INVALID_REQUEST', 'Invalid reviewed snapshot')
        key = project_key(spec.get('namespace'), spec.get('projectId'))
        op_id = operation(spec.get('operationId'))
        data = self._read()
        self._reconcile(data)
        record = data['records'].get(key)
        if not record or record['generation'] != spec.get('generation'):
            fail('GENERATION_CHANGED', 'Recovery generation changed')
        typed = self._manifest_binding(record, None, spec, result=review_version == 2)
        if self._busy(data, key) or self._global_operations(data) >= 2:
            fail('ACTIVE_OPERATION', 'An isolated operation is still active')
        if op_id in data['operations']:
            fail('INVALID_BINDING', 'Operation has already been used')
        if record.get('rasterReturnVersion') == 2 and record['dirty'] and review_version != 2 and not record.get('syncPending'):
            fail('INVALID_REQUEST', 'Streamed raster recovery requires its explicit reviewed snapshot')
        mount = self._activate(data, key, record)
        self._idle(key, record)
        if review_id is not None:
            if record.get('syncPending') or (review_version != 2 and record.get('rasterReturnVersion', 0) != 0):
                fail('INVALID_REQUEST', 'Reviewed recovery is only available for legacy source without an unfinished sync')
            if review_version == 2:
                if not record['dirty']:
                    fail('INVALID_REQUEST', 'Retained recovery requires a dirty generation')
                snapshot = self._retained_snapshot(data, key, record, mount / 'workspace')
                files = snapshot['files'] + snapshot['retainedRasters']
                if typed and snapshot['sourceResultManifestId'] != spec['sourceResultManifestId']:
                    fail('GENERATION_CHANGED', 'Retained source metadata differs from its approved result')
            else:
                files = verified_snapshot(self.backend, mount / 'workspace', record['baseline'], True)
            if source_digest(files) != review_id:
                fail('GENERATION_CHANGED', 'Guest source differs from the approved review')
        if record.get('syncPending'):
            resolution = self.backend.recover_sync(mount, record['syncPending'])
            if resolution and resolution.get('missing'):
                if source_map(self._source_snapshot(record, mount / 'workspace')) != record['baseline']:
                    fail('RECOVERY_REQUIRED', 'The missing source transaction does not match its durable baseline')
            if resolution and resolution.get('committed'):
                record['baseline'] = record['syncTarget']
                if typed:
                    retain_source_manifest(record, record_source_manifest({'sourceManifestVersion': record['sourceManifestVersion'], **({'sourceProfileId': record['sourceProfileId']} if record['sourceManifestVersion'] == 2 else {}), 'baseline': record['baseline'],
                        'sourceManifestId': record['syncTargetManifestId'], 'sourceManifestSizes': record['syncTargetManifestSizes']}))
                record['sourceDigest'] = source_digest(self._source_snapshot(record, mount / 'workspace'))
            if source_map(self._source_snapshot(record, mount / 'workspace')) == record['baseline']:
                record['dirty'] = False
                record.pop('recoveryReason', None)
            record.pop('syncPending')
            record.pop('syncTarget', None)
            record.pop('syncTargetManifestId', None)
            record.pop('syncTargetManifestSizes', None)
        op = {'key': key, 'generation': record['generation'], 'token': uuid.uuid4().hex,
              'phase': 'finished', 'mode': 'recovery', 'expiresAt': self.now() + 120,
              **({'captureVersion': 4 if record.get('sourceManifestVersion') == 2 else 3} if typed else ({'captureVersion': 2} if record.get('rasterReturnVersion') == 2 and not record['dirty'] and review_id is None else {})),
              **({'sourceManifestVersion': record['sourceManifestVersion'], **({'sourceProfileId': record['sourceProfileId']} if record['sourceManifestVersion'] == 2 else {}), 'sourceBaseManifestId': record['sourceManifestId'],
                  **({'sourceResultManifestId': spec['sourceResultManifestId']} if review_version == 2 else {})} if typed else {}),
              **({'reviewVersion': 2} if review_version == 2 else {}),
              **({'reviewSnapshotId': review_id} if review_id is not None else {})}
        data['operations'][op_id] = op
        record['operationId'] = op_id
        self._save(data)
        return self._value(key, record, op_id, op)

    def retire(self, spec):
        key = project_key(spec.get('namespace'), spec.get('projectId'))
        if spec.get('confirmation') != 'DELETE_PROJECT_VOLUME':
            fail('INVALID_REQUEST', 'Explicit project-volume deletion confirmation is required')
        data = self._read()
        self._reconcile(data)
        record = data['records'].get(key)
        if self._capacity_owner_pending(data, key):
            fail('CAPACITY_MIGRATION_UNCERTAIN', 'The original native allocation intent requires inspection before retirement')
        if not record or record['state'] == 'deleted':
            return {'deleted': True, 'absent': True}
        if record['generation'] != spec.get('generation'):
            fail('GENERATION_CHANGED', 'Deletion generation changed')
        if self._busy(data, key):
            fail('ACTIVE_OPERATION', 'Stop isolated operations before deleting the project')
        if record['dirty'] and spec.get('discardUnsynced') is not True:
            fail('RECOVERY_REQUIRED', 'Unreturned isolated changes require recovery or explicit discard')
        self._idle(key, record)
        folder = self._folder(key, record)
        if (record['state'] == 'creating' and not os.path.lexists(self.root / key)
                and not os.path.lexists(self.cold / key)):
            # No filesystem mutation ever started. Retain the stable identity tombstone.
            record.update(state='deleted', dirty=True)
            self._save(data)
            return {'deleted': True, 'absent': True, 'projectId': record['projectId'], 'generation': record['generation']}
        if record.get('capacityMigration') and record['capacityMigration']['phase'] not in ('committed', 'completed'):
            fail('RECOVERY_REQUIRED', 'Unconfirmed migration images require separate inspection')
        self._unmount(folder, record)
        entries = self.backend.profile_deletion_plan(folder, record) if record.get('volumeProfileVersion') in (2, 3) else self.backend.deletion_plan(folder)
        record['transition'] = {'from': record['state'], 'to': 'deleted', 'entries': entries}
        self._save(data)
        try:
            (self.backend.delete_profile_exact(folder, entries) if record.get('volumeProfileVersion') in (2, 3) else self.backend.delete_exact(folder, entries))
        except Exception as error:
            fail('DELETE_UNCERTAIN', 'Deletion requires inspection; do not automatically retry: ' + str(error), True)
        record.update(state='deleted', dirty=True)
        record.pop('transition')
        self._save(data)
        return {'deleted': True, 'projectId': record['projectId'], 'generation': record['generation']}
