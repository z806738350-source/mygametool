#!/usr/bin/python3
"""VM-only control plane. Project programs never run as this user."""
import base64
import json
import os
import pathlib
import re
import select as io_select
import selectors
import socket
import signal
import subprocess
import sys
import threading
import time
import uuid
import guest_storage as storage
import fcntl
import stat
from contextlib import contextmanager

STATE = pathlib.Path('/run/ohmygame-control')
NODE = '/opt/node-v22.23.4-linux-arm64/bin'
SELF = '/opt/ohmygame/guest-controller.py'
MAX_LINE = 131072
MAX_CONTROL_OPERATIONS = 8192
MAX_CONTROL_BYTES = 32 * 1024 * 1024

def run(args, check=True):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=12)
    if check and result.returncode:
        raise RuntimeError('Isolated service control failed')
    return result

def properties(unit):
    result = run(['systemctl', 'show', unit, '--property=MainPID,ActiveState,Result,ExecMainStatus,ControlGroup'], False)
    return dict(line.split('=', 1) for line in result.stdout.decode().splitlines() if '=' in line)

def emit(kind, **values):
    data = memoryview((json.dumps({'kind': kind, **values}) + '\n').encode())
    deadline = time.monotonic() + 1
    while data:
        try:
            data = data[os.write(1, data):]
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise RuntimeError('Isolated control consumer stopped reading')
            io_select.select([], [1], [], .05)

def unit_name(identifier):
    if not isinstance(identifier, str) or not re.fullmatch('[a-f0-9]{32}', identifier):
        raise ValueError('Invalid isolated operation')
    return 'ohmygame-job-' + identifier + '.service'

def scope(spec, identifier=None, complete=False):
    if not isinstance(spec, dict) or spec.get('namespace') not in ('manual', 'test'):
        raise ValueError('Invalid isolated namespace')
    project = spec.get('projectId')
    if not isinstance(project, str) or str(uuid.UUID(project)) != project:
        raise ValueError('Invalid isolated project')
    operation = spec.get('operationId')
    unit_name(operation)
    if identifier is not None and operation != identifier:
        raise ValueError('Isolated operation identity mismatch')
    result = {'namespace': spec['namespace'], 'projectId': project, 'operationId': operation}
    if complete:
        generation = spec.get('generation')
        token = spec.get('leaseToken')
        if isinstance(generation, bool) or not isinstance(generation, int) or generation < 1 or not isinstance(token, str) or not re.fullmatch('[a-f0-9]{32}', token):
            raise ValueError('Invalid isolated lease binding')
        result.update(generation=generation, leaseToken=token)
    return result

def private_record(file):
    descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > MAX_LINE:
            raise ValueError('Invalid isolated control record')
        value = json.loads(stream.read(MAX_LINE + 1))
    if not isinstance(value, dict):
        raise ValueError('Invalid isolated control record')
    return value

def write_record(file, value):
    data = json.dumps(value, ensure_ascii=False)
    if len(data.encode()) > MAX_LINE:
        raise ValueError('Isolated control record exceeded its limit')
    control_budget(file.name.split('.')[0], len(data.encode()))
    descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    descriptor = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def control_budget(identifier, extra=0):
    identities, size = set(), extra
    for file in STATE.iterdir():
        match = re.fullmatch(r'([a-f0-9]{32})\.(?:lock|cancelled|request|json)', file.name)
        info = file.lstat()
        if not match or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ValueError('Isolated control metadata requires review')
        identities.add(match[1])
        size += info.st_size
    identities.add(identifier)
    if len(identities) > MAX_CONTROL_OPERATIONS or size > MAX_CONTROL_BYTES:
        raise ValueError('Isolated control history budget is full; existing data was retained')

def inactive_units(identifier, control=True):
    units = (unit_name(identifier), 'ohmygame-control-' + identifier + '.service') if control else (unit_name(identifier),)
    for unit in units:
        state = properties(unit)
        if state.get('ActiveState') not in ('inactive', 'failed') or state.get('MainPID', '0') != '0':
            raise RuntimeError('An unowned isolated unit exists; operation was not applied')
        group = state.get('ControlGroup', '')
        if group:
            if group != '/system.slice/' + unit:
                raise RuntimeError('An unowned isolated cgroup exists; operation was not applied')
            try:
                events = pathlib.Path('/sys/fs/cgroup' + group + '/cgroup.events').read_text()
                if dict(line.split() for line in events.splitlines()).get('populated') != '0':
                    raise RuntimeError('An unowned isolated descendant exists; operation was not applied')
            except FileNotFoundError:
                pass

@contextmanager
def operation_lock(identifier):
    unit_name(identifier)
    with storage.locked():
        control_budget(identifier)
        descriptor = os.open(STATE / (identifier + '.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o022:
            os.close(descriptor)
            raise ValueError('Invalid isolated operation lock')
    with os.fdopen(descriptor, 'r+') as file:
        fcntl.flock(file, fcntl.LOCK_EX)
        yield

def cancelled(binding):
    file = STATE / (binding['operationId'] + '.cancelled')
    if not file.exists():
        return False
    value = private_record(file)
    if value != {name: binding[name] for name in ('namespace', 'projectId', 'operationId')}:
        raise ValueError('Isolated cancellation identity mismatch')
    return True

def stopped(identifier, control=False):
    unit = unit_name(identifier)
    before = properties(unit)
    group = before.get('ControlGroup', '')
    if group == '/system.slice/' + unit:
        try:
            pathlib.Path('/sys/fs/cgroup' + group + '/cgroup.kill').write_text('1')
        except FileNotFoundError:
            pass
    units = [unit, 'ohmygame-control-' + identifier + '.service'] if control else [unit]
    run(['systemctl', 'stop', *units], False)
    for name in units:
        after = properties(name)
        if after.get('ActiveState') not in ('inactive', 'failed') or after.get('MainPID', '0') != '0':
            raise RuntimeError('Isolated task shutdown could not be confirmed; workspace retained')
    if group and group != '/system.slice/' + unit:
        raise RuntimeError('Isolated task cgroup could not be confirmed; workspace retained')
    if group:
        try:
            events = pathlib.Path('/sys/fs/cgroup' + group + '/cgroup.events').read_text()
            if dict(line.split() for line in events.splitlines()).get('populated') != '0':
                raise RuntimeError('Isolated descendants are still active; workspace retained')
        except FileNotFoundError:
            pass
    run(['systemctl', 'reset-failed', *units], False)

def guardian(identifier):
    os.set_blocking(1, False)
    unit = unit_name(identifier)
    control = 'ohmygame-control-' + identifier + '.service'
    manifest = STATE / (identifier + '.json')
    journal = None
    binding = None
    claimed = succeeded = launch_attempted = False
    exit_code = None
    try:
        spec = private_record(STATE / (identifier + '.request'))
        binding = scope(spec, identifier, complete=True)
        project_id = binding['projectId']
        relative = spec.get('cwd', '')
        if not isinstance(relative, str) or len(relative) > 1000 or any(p in ('..', '') for p in relative.split('/')) and relative:
            raise ValueError('Invalid isolated working directory')
        mode = spec['mode']
        port = spec.get('port')
        if mode == 'install':
            args = ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund']
        elif mode == 'build':
            args = ['run', 'build']
        elif mode == 'shell':
            args = spec['args']
            if not isinstance(args, list) or len(args) != 2 or not isinstance(args[0], str) or len(args[0]) > 32000 or '\x00' in args[0]:
                raise ValueError('Invalid isolated shell request')
            timeout = int(args[1])
            if not 1 <= timeout <= 120:
                raise ValueError('Invalid isolated shell timeout')
        elif mode == 'preview':
            args = spec['args']
            if not isinstance(port, int) or not 1024 <= port <= 65535:
                raise ValueError('Invalid isolated preview port')
            if not isinstance(args, list) or not 2 <= len(args) <= 40 or args[0] != 'run' or not re.fullmatch(r'[a-zA-Z0-9_:\-]+', args[1]):
                raise ValueError('Only a configured npm preview script is supported')
            if any(not isinstance(a, str) or len(a) > 2000 or '\x00' in a for a in args):
                raise ValueError('Invalid isolated preview arguments')
        else:
            raise ValueError('Unsupported isolated operation')
        with operation_lock(identifier):
            if cancelled(binding):
                raise RuntimeError('Isolated operation was cancelled')
            with storage.locked():
                context = storage.claim({**binding, 'mode': mode})
            claimed = True
            workspace = pathlib.Path(context['workspace'])
            identity = context['identity']
            uid = identity.get('uid')
            if isinstance(uid, bool) or not isinstance(uid, int) or uid < 5000 or identity.get('name') != 'omgjob' + str(uid) or not isinstance(identity.get('gid'), int) or identity['gid'] < 0:
                raise ValueError('Invalid isolated project identity')
            if workspace.resolve(strict=True) != workspace:
                raise ValueError('Isolated workspace must not be linked')
            cwd = (workspace / relative).resolve(strict=True)
            if not cwd.is_relative_to(workspace):
                raise ValueError('Working directory left the isolated workspace')
        cache = workspace.parent / 'cache'
        pathlib.Path('/workspace').mkdir(exist_ok=True)
        pathlib.Path('/cache').mkdir(exist_ok=True)
        pathlib.Path('/packages').mkdir(exist_ok=True)
        limits = {
            'User': identity['name'], 'Group': identity['name'], 'WorkingDirectory': '/workspace/' + relative,
            'BindPaths': str(workspace) + ':/workspace ' + str(cache) + ':/cache',
            'BindReadOnlyPaths': str(workspace.parent / 'packages') + ':/packages',
            'ReadWritePaths': '/workspace /cache', 'PrivateNetwork': 'yes',
            'PrivateIPC': 'yes', 'KeyringMode': 'private',
            'TemporaryFileSystem': '/tmp:rw,size=32M,mode=1777 /var/tmp:rw,size=32M,mode=1777',
            'ProtectSystem': 'strict', 'ProtectHome': 'yes', 'PrivateDevices': 'yes',
            'ProtectControlGroups': 'yes', 'ProtectKernelTunables': 'yes', 'ProtectKernelModules': 'yes',
            'ProtectKernelLogs': 'yes', 'ProtectProc': 'invisible', 'ProcSubset': 'pid',
            'NoNewPrivileges': 'yes', 'CapabilityBoundingSet': '', 'RestrictNamespaces': 'yes',
            'RestrictAddressFamilies': 'AF_UNIX AF_INET AF_INET6',
            'InaccessiblePaths': '-/mnt/omg-projects -/var/cache/ohmygame -/run/dbus -/run/systemd/private -/run/lima -/mnt/lima-cidata -/etc/ssh',
            'TasksMax': '128', 'MemoryMax': '1G', 'MemorySwapMax': '0', 'CPUQuota': '50%',
            'RuntimeMaxSec': str(timeout) + 's' if mode == 'shell' else ('900s' if mode == 'preview' else '120s'), 'TimeoutStopSec': '2s',
            'KillMode': 'control-group', 'SendSIGKILL': 'yes', 'LimitCORE': '0', 'LimitFSIZE': '64M',
            'BindsTo': control, 'After': control,
            'Environment': 'HOME=/tmp PATH=' + NODE + ':/usr/bin:/bin NPM_CONFIG_CACHE=/cache NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG=/opt/ohmygame/npm-global.empty NPM_CONFIG_UPDATE_NOTIFIER=false HOST=127.0.0.1 BROWSER=none' + (' PORT=' + str(port) if port else ''),
        }
        # Pass shell source verbatim; systemd must not expand JS ${...}, $VAR or $$ before bash.
        command = ['systemd-run', '--quiet', '--expand-environment=no', '--service-type=exec', '--unit=' + unit]
        command += ['--property=' + k + '=' + v for k, v in limits.items()]
        if mode == 'install':
            command += ['--', '/usr/bin/python3', '/opt/ohmygame/npm-install.py']
        elif mode == 'shell':
            command += ['--', '/bin/bash', '--noprofile', '--norc', '-c', args[0]]
        else:
            command += ['--', NODE + '/node', NODE + '/../lib/node_modules/npm/bin/npm-cli.js', *args]
        with operation_lock(identifier):
            if cancelled(binding):
                raise RuntimeError('Isolated operation was cancelled')
            with storage.locked():
                storage.validate_binding(binding, phases=('running',))
                inactive_units(identifier, control=False)
                write_record(manifest, {'port': port, 'unit': unit, **binding})
                launch_attempted = True
                run(command)
        journal = subprocess.Popen(['journalctl', '--no-pager', '--follow', '--output=cat', '--unit=' + unit, '--since=-5s'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        select = selectors.DefaultSelector()
        select.register(sys.stdin.buffer, selectors.EVENT_READ, 'input')
        select.register(journal.stdout, selectors.EVENT_READ, 'log')
        last_heartbeat = time.monotonic()
        started = last_heartbeat
        input_buffer = b''
        ready = mode != 'preview'
        total_output = 0
        emit('started', id=identifier)
        while True:
            for key, _ in select.select(.2):
                if key.data == 'input':
                    chunk = os.read(sys.stdin.fileno(), 8192)
                    if not chunk:
                        raise RuntimeError('Isolated controller connection closed')
                    input_buffer += chunk
                    if len(input_buffer) > MAX_LINE:
                        raise ValueError('Invalid isolated control message')
                    while b'\n' in input_buffer:
                        heartbeat, input_buffer = input_buffer.split(b'\n', 1)
                        if json.loads(heartbeat).get('op') != 'heartbeat':
                            raise ValueError('Invalid isolated control message')
                        last_heartbeat = time.monotonic()
                else:
                    data = os.read(journal.stdout.fileno(), 8192)
                    if data:
                        total_output += len(data)
                        if total_output > 512 * 1024:
                            raise RuntimeError('Isolated output exceeded its limit')
                        emit('stdout', data=base64.b64encode(data).decode())
            state = properties(unit)
            if state.get('ActiveState') not in ('active', 'activating'):
                drain_until = time.monotonic() + .25
                while time.monotonic() < drain_until:
                    if io_select.select([journal.stdout], [], [], .05)[0]:
                        data = os.read(journal.stdout.fileno(), 8192)
                        total_output += len(data)
                        if total_output > 512 * 1024:
                            raise RuntimeError('Isolated output exceeded its limit')
                        if data:
                            emit('stdout', data=base64.b64encode(data).decode())
                code = int(state.get('ExecMainStatus', '1'))
                if state.get('Result') != 'success':
                    code = code or 1
                succeeded = code == 0
                exit_code = code
                return code
            if time.monotonic() - last_heartbeat > 12:
                raise RuntimeError('Isolated controller lease expired')
            if not ready:
                pid = state.get('MainPID', '0')
                check = run(['nsenter', '--target', pid, '--net', '--', '/usr/bin/python3', SELF, 'probe', str(port)], False)
                if check.returncode == 0:
                    ready = True
                    emit('ready', id=identifier)
                elif time.monotonic() - started > 30:
                    raise RuntimeError('Isolated preview did not become ready')
    except Exception as error:
        emit('error', message=str(error)[:1000], code=getattr(error, 'code', 'EXECUTION_FAILED'), changed=getattr(error, 'changed', False))
        return 1
    finally:
        if claimed:
            try:
                if launch_attempted:
                    stopped(identifier)
                else:
                    inactive_units(identifier, control=False)
                with storage.locked():
                    existing = storage.lookup(scope(binding))
                    if existing is not None:
                        storage.finish(binding, succeeded)
                    elif not cancelled(binding):
                        raise RuntimeError('Isolated lease disappeared during cleanup; workspace retained')
                manifest.unlink(missing_ok=True)
            finally:
                if journal:
                    journal.terminate()
                    try:
                        journal.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        journal.kill()
                        journal.wait(timeout=3)
            if exit_code is not None:
                emit('exit', id=identifier, code=exit_code)

def proxy(identifier, port):
    unit = unit_name(identifier)
    manifest = private_record(STATE / (identifier + '.json'))
    if manifest['port'] != port or manifest['unit'] != unit:
        raise ValueError('Invalid isolated preview target')
    binding = scope(manifest, identifier, complete=True)
    with storage.locked():
        storage.validate_binding(binding, phases=('running',))
    state = properties(unit)
    if state.get('ActiveState') != 'active' or int(state.get('MainPID', '0')) <= 0:
        raise ValueError('Isolated preview is not active')
    os.execv('/usr/bin/nsenter', ['nsenter', '--target', state['MainPID'], '--net', '--', '/usr/bin/python3', SELF, 'relay', str(port)])

def relay(port):
    connection = socket.create_connection(('127.0.0.1', port), timeout=5)
    connection.settimeout(60)
    def send():
        try:
            while True:
                data = os.read(0, 65536)
                if not data:
                    connection.shutdown(socket.SHUT_WR)
                    return
                connection.sendall(data)
        except OSError:
            connection.close()
    threading.Thread(target=send, daemon=True).start()
    try:
        while True:
            data = connection.recv(65536)
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    finally:
        connection.close()

def request(limit=MAX_LINE):
    data = sys.stdin.buffer.read(limit + 1)
    if len(data) > limit:
        raise ValueError('Isolated control request exceeded its limit')
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError('Invalid isolated control request')
    return value

def state_ready():
    STATE.mkdir(mode=0o700, exist_ok=True)
    info = STATE.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Invalid private isolated control directory')

def ensure_npm_config():
    file = '/opt/ohmygame/npm-global.empty'
    try:
        descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_size or info.st_mode & 0o022:
            raise ValueError('Isolated npm configuration must be a trusted empty file')
    finally:
        os.close(descriptor)

def cancel(identifier, spec):
    binding = scope(spec, identifier)
    with operation_lock(identifier):
        with storage.locked():
            result = storage.cancel(binding)
        operation = result.get('operation')
        request_file = STATE / (identifier + '.request')
        manifest = STATE / (identifier + '.json')
        owns_control = False
        if operation:
            if request_file.exists():
                if scope(private_record(request_file), identifier, complete=True) != scope(operation, identifier, complete=True):
                    raise ValueError('Isolated launch request identity mismatch')
                owns_control = True
            if manifest.exists():
                record = private_record(manifest)
                if record.get('unit') != unit_name(identifier) or scope(record, identifier, complete=True) != scope(operation, identifier, complete=True):
                    raise ValueError('Isolated task manifest identity mismatch')
            else:
                inactive_units(identifier, control=False)
            if not owns_control:
                inactive_units(identifier)
        file = STATE / (identifier + '.cancelled')
        if not file.exists():
            with storage.locked():
                write_record(file, binding)
        elif not cancelled(binding):
            raise ValueError('Invalid cancellation record')
        if operation:
            if owns_control:
                stopped(identifier, control=True)
            with storage.locked():
                storage.finish(operation, False)
                storage.release(operation)
            request_file.unlink(missing_ok=True)
            manifest.unlink(missing_ok=True)
        else:
            inactive_units(identifier)
    return {'stopped': True, 'operation': operation}

def launch(identifier):
    unit_name(identifier)
    # Read only the header; buffered reads could consume the first heartbeat before exec.
    data = bytearray()
    while len(data) <= MAX_LINE:
        byte = os.read(0, 1)
        if not byte or byte == b'\n':
            break
        data.extend(byte)
    if len(data) > MAX_LINE:
        raise ValueError('Isolated request is too large')
    spec = json.loads(data)
    binding = scope(spec, identifier, complete=True)
    with operation_lock(identifier):
        if cancelled(binding):
            raise RuntimeError('Isolated operation was cancelled')
        with storage.locked():
            storage.validate_binding(binding, phases=('prepared',))
            inactive_units(identifier)
            write_record(STATE / (identifier + '.request'), spec)
    os.execv('/usr/bin/systemd-run', ['systemd-run', '--quiet', '--pipe', '--wait', '--service-type=exec', '--unit=ohmygame-control-' + identifier + '.service', '--property=RuntimeMaxSec=920s', '--property=MemoryMax=128M', '--property=TasksMax=24', '--', '/usr/bin/python3', SELF, 'guardian', identifier])

def main():
    operation = sys.argv[1]
    if operation not in ('run', 'guardian', 'proxy', 'relay', 'probe', 'health', 'overview', 'inspect-source', 'review-source', 'review-source-media', 'prepare', 'prepare-media', 'prepare-begin', 'prepare-append', 'prepare-commit', 'plan-capacity', 'inspect-capacity-plan', 'register-capacity-authorization', 'migrate-capacity', 'export', 'export-media', 'capture', 'capture-media', 'acknowledge', 'release', 'recover', 'retire', 'inventory', 'cancel'):
        raise SystemExit('Unsupported isolated control operation')
    if operation not in ('health', 'inventory', 'overview', 'inspect-source', 'review-source', 'review-source-media'):
        state_ready()
    if operation in ('run', 'guardian', 'prepare', 'prepare-media', 'prepare-begin'):
        ensure_npm_config()
    if operation == 'run':
        if len(sys.argv) != 3:
            raise ValueError('A prepared isolated operation is required')
        identifier = sys.argv[2]
        launch(identifier)
    elif operation == 'guardian':
        raise SystemExit(guardian(sys.argv[2]))
    elif operation == 'proxy':
        proxy(sys.argv[2], int(sys.argv[3]))
    elif operation == 'relay':
        relay(int(sys.argv[2]))
    elif operation == 'probe':
        with socket.create_connection(('127.0.0.1', int(sys.argv[2])), timeout=.3):
            pass
    elif operation == 'health':
        print(json.dumps({'backend': 'lima-vz-cgroup-v2', 'node': pathlib.Path(NODE + '/node').exists(), 'cgroup': pathlib.Path('/sys/fs/cgroup/cgroup.controllers').read_text().strip(), **storage.health()}))
    elif operation == 'overview':
        if request() != {}:
            raise ValueError('The storage overview is global and takes no parameters')
        with storage.read_locked():
            print(json.dumps(storage.overview()))
    elif operation == 'inspect-source':
        spec = request()
        with storage.read_locked():
            print(json.dumps(storage.inspect_source(spec)))
    elif operation == 'review-source':
        spec = request()
        with storage.review_locked():
            print(json.dumps(storage.review_source(spec)))
    elif operation == 'review-source-media':
        spec = storage.retained_review_request(request())
        signal.alarm(120)
        try:
            with storage.review_locked(initialize=True):
                storage.review_source_media(spec, sys.stdout.buffer)
        finally:
            signal.alarm(0)
    elif operation in ('plan-capacity', 'inspect-capacity-plan', 'register-capacity-authorization', 'migrate-capacity'):
        spec = request()
        # Planning and registration only inspect; only exact durable native authorization may copy/create.
        # One live exclusive lock covers preparation, helper callbacks and the registry pointer commit.
        with storage.review_locked(initialize=True):
            print(json.dumps(getattr(storage, operation.replace('-', '_'))(spec)))
    elif operation in ('prepare-begin', 'prepare-append', 'prepare-commit'):
        signal.alarm(120)
        try:
            if operation == 'prepare-append':
                header = sys.stdin.buffer.readline(MAX_LINE + 2)
                if len(header) > MAX_LINE + 1 or not header.endswith(b'\n'): raise ValueError('Invalid profile window header')
                spec = json.loads(header)
            else: spec = request(storage.MAX_REQUEST if operation == 'prepare-begin' else MAX_LINE)
            binding = scope(spec, complete=operation != 'prepare-begin')
            with operation_lock(binding['operationId']):
                if cancelled(binding): raise RuntimeError('Profile preparation was cancelled')
                with storage.locked():
                    if operation == 'prepare-append':
                        value = storage.prepare_append(spec, sys.stdin.buffer, lambda paths: print(json.dumps({'needMedia': paths}), flush=True))
                    else: value = getattr(storage, operation.replace('-', '_'))(spec)
                    print(json.dumps(value))
        finally: signal.alarm(0)
    elif operation in ('prepare', 'prepare-media'):
        streaming = operation == 'prepare-media'
        if streaming:
            # Bound both the header and the time a stalled host can hold the storage lock.
            signal.alarm(120)
            header = sys.stdin.buffer.readline(storage.MAX_REQUEST + 2)
            if len(header) > storage.MAX_REQUEST + 1 or not header.endswith(b'\n'):
                raise ValueError('Invalid runtime media transfer header')
            spec = json.loads(header)
            if not isinstance(spec, dict):
                raise ValueError('Invalid runtime media transfer header')
        else:
            spec = request(storage.MAX_REQUEST)
        binding = scope(spec)
        with operation_lock(binding['operationId']):
            if cancelled(binding):
                raise RuntimeError('Isolated operation was cancelled before preparation')
            with storage.locked():
                prepared = storage.prepare(spec, sys.stdin.buffer,
                    lambda paths: print(json.dumps({'needMedia': paths}), flush=True)) if streaming else storage.prepare(spec)
                print(json.dumps(prepared))
    elif operation == 'export-media':
        spec = request()
        binding = scope(spec, complete=True)
        signal.alarm(120)
        try:
            with storage.locked():
                storage.export_bound(binding, spec.get('directory', ''), sys.stdout.buffer)
        finally:
            signal.alarm(0)
    elif operation == 'export':
        spec = request()
        binding = scope(spec, complete=True)
        with storage.locked():
            print(json.dumps(storage.export_bound({**binding, **({'runtimeMediaVersion': 1} if spec.get('runtimeMediaVersion') == 1 else {})}, spec.get('directory', ''))))
    elif operation == 'capture-media':
        spec = storage.media_capture_request(request())
        signal.alarm(120)
        try:
            with storage.locked():
                storage.capture_media(spec, sys.stdout.buffer)
        finally:
            signal.alarm(0)
    elif operation == 'capture':
        spec = request()
        binding = scope(spec, complete=True)
        if 'reviewVersion' in spec:
            binding['reviewVersion'] = spec['reviewVersion']
        if 'captureVersion' in spec:
            binding['captureVersion'] = spec['captureVersion']
        for key in ('sourceManifestVersion', 'sourceProfileId', 'sourceBaseManifestId', 'sourceResultManifestId'):
            if key in spec:
                binding[key] = spec[key]
        with storage.locked():
            print(json.dumps(storage.capture(binding)))
    elif operation == 'release':
        binding = scope(request(), complete=True)
        identifier = binding['operationId']
        with operation_lock(identifier):
            file = STATE / (identifier + '.request')
            if file.exists() and scope(private_record(file), identifier, complete=True) != binding:
                raise ValueError('Isolated release identity mismatch')
            inactive_units(identifier)
            with storage.locked():
                result = storage.release(binding)
            file.unlink(missing_ok=True)
        print(json.dumps(result))
    elif operation in ('acknowledge', 'recover', 'retire'):
        spec = request()
        if operation == 'acknowledge':
            binding = scope(spec, complete=True)
            spec = {**binding, 'snapshotId': spec.get('snapshotId'),
                **({'reviewVersion': spec['reviewVersion']} if 'reviewVersion' in spec else {}),
                **({'captureVersion': spec['captureVersion']} if 'captureVersion' in spec else {}),
                **{key: spec[key] for key in ('sourceManifestVersion', 'sourceProfileId', 'sourceBaseManifestId', 'sourceResultManifestId') if key in spec}}
        with storage.locked():
            print(json.dumps(getattr(storage, operation)(spec)))
    elif operation == 'inventory':
        spec = request()
        with storage.locked():
            print(json.dumps(storage.inventory(spec.get('namespace'))))
    elif operation == 'cancel':
        print(json.dumps(cancel(sys.argv[2], request())))
    else:
        raise SystemExit('Unsupported isolated control operation')

def entrypoint():
    try:
        main()
        return 0
    except Exception as error:
        print(json.dumps({'error': {'code': getattr(error, 'code', 'CONTROL_FAILED'), 'message': str(error)[:1000], 'changed': getattr(error, 'changed', False)}}))
        return 1

if __name__ == '__main__':
    raise SystemExit(entrypoint())
