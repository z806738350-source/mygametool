"""Exact versioned runtime contracts. Installation/health negotiation is required by the host."""
from types import MappingProxyType
from pathlib import PurePosixPath

MiB = 1024 * 1024
PROFILE_ID = 'capacity-128-v2'
RUNTIME_PROFILE = MappingProxyType({'version': 2, 'id': PROFILE_ID, 'volumeBytes': 512 * MiB,
    'mediaBytes': 128 * MiB, 'inodeCount': 16384, 'sourceFileBytes': 2 * MiB, 'sourceBytes': 8 * MiB,
    'mediaFileBytes': 32 * MiB, 'mediaWindowBytes': 64 * MiB, 'fileCount': 2000, 'entryCount': 4000,
    'requestHeaderBytes': 24 * MiB, 'responseHeaderBytes': 16 * MiB, 'recoveryBytes': 1024 * MiB,
    'globalVolumeBytes': 4096 * MiB, 'residentVolumes': 8, 'globalOperations': 2, 'reserveBytes': 1024 * MiB,
    'runtimeEnabled': True, 'simulationOnly': False})
MEDIA64_PROFILE_ID = 'capacity-128-media64-v3'
MEDIA64_PROFILE = MappingProxyType({**dict(RUNTIME_PROFILE), 'version': 3, 'id': MEDIA64_PROFILE_ID,
    'largeMediaFileBytes': 64 * MiB, 'largeMediaFilePolicy': 'video-audio-glb-v1'})
RUNTIME_PROFILES = MappingProxyType({PROFILE_ID: RUNTIME_PROFILE, MEDIA64_PROFILE_ID: MEDIA64_PROFILE})
LARGE_MEDIA_EXTENSIONS = frozenset({'.mp4', '.mov', '.webm', '.m4a', '.mp3', '.wav', '.ogg', '.glb'})


def runtime_profile(value):
    if value not in RUNTIME_PROFILES:
        raise ValueError('Unsupported runtime capacity profile')
    return RUNTIME_PROFILES[value]


def runtime_large_media_supported(relative):
    return PurePosixPath(relative).suffix.lower() in LARGE_MEDIA_EXTENSIONS


def runtime_media_file_limit(relative, profile_id=None):
    profile = runtime_profile(profile_id) if profile_id is not None else None
    if profile_id == MEDIA64_PROFILE_ID and runtime_large_media_supported(relative):
        return profile['largeMediaFileBytes']
    return RUNTIME_PROFILE['mediaFileBytes']


def record_volume_bytes(record, legacy_bytes):
    if 'volumeProfileVersion' not in record and 'volumeId' not in record and 'sourceProfileId' not in record:
        return legacy_bytes
    profile = runtime_profile(record.get('sourceProfileId'))
    if type(record.get('volumeProfileVersion')) is not int or record['volumeProfileVersion'] != profile['version']:
        raise ValueError('Unknown project volume contract')
    return profile['volumeBytes']
