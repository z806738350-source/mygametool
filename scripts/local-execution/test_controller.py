"""Mock control-plane contracts only: no VM, systemd, mounts, task processes or network."""
import base64
import errno
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock
from contextlib import ExitStack, nullcontext

folder = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location('guest_storage', folder / 'guest_storage.py')
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)
spec = importlib.util.spec_from_file_location('guest_controller', folder / 'guest-controller.py')
controller = importlib.util.module_from_spec(spec)
with mock.patch.dict(sys.modules, {'guest_storage': storage}):
    spec.loader.exec_module(controller)

IDENTIFIER = 'a' * 32
PROJECT = '5e849fb8-9236-4f0e-a58a-76cb223b8a74'
BINDING = {'namespace': 'manual', 'projectId': PROJECT, 'operationId': IDENTIFIER, 'generation': 1, 'leaseToken': 'b' * 32}

class GuardianContracts(unittest.TestCase):
    def invoke(self, request, group='', launch=False, claim_error=None, finish_error=None, journal_error=None, active='inactive'):
        commands, writes = [], []
        self.order, self.events, self.cleanup_error = [], [], None
        request = {**BINDING, **request}
        def command(args, check=True):
            commands.append(args)
            if args[0] == 'systemd-run' and not launch:
                raise RuntimeError('test boundary: no service was launched')
            return types.SimpleNamespace(returncode=0, stdout=b'')
        with tempfile.TemporaryDirectory(prefix='ohmygame-guardian-contract-') as directory:
            root = pathlib.Path(directory).resolve()
            workspace = root / 'workspace'
            state = root / 'control'
            workspace.mkdir()
            state.mkdir()
            launch_request = state / (IDENTIFIER + '.request')
            launch_request.write_text(json.dumps(request))
            launch_request.chmod(0o600)
            self.finish = mock.Mock(side_effect=finish_error or (lambda *args: self.order.append('finished')))
            self.claim = mock.Mock(side_effect=claim_error, return_value={'workspace': str(workspace), 'identity': {'name': 'omgjob5000', 'uid': 5000, 'gid': 5000}})
            journal = mock.Mock(stdout=io.BytesIO())
            journal.terminate.side_effect = journal_error
            selector = mock.Mock()
            selector.select.return_value = []
            def emit(kind, **values):
                self.events.append((kind, values))
                self.order.append(kind)
            original_write = pathlib.Path.write_text
            def write(p, text, *args, **kwargs):
                writes.append((str(p), text))
                return len(text) if str(p).startswith('/sys/fs/cgroup/') else original_write(p, text, *args, **kwargs)
            with mock.patch.object(controller, 'STATE', state), \
                 mock.patch.object(controller, 'run', side_effect=command), \
                 mock.patch.object(controller, 'properties', return_value={'ControlGroup': group, 'ActiveState': active, 'MainPID': '0', 'Result': 'success', 'ExecMainStatus': '0'}), \
                 mock.patch.object(controller, 'emit', side_effect=emit), \
                 mock.patch.object(controller.os, 'set_blocking'), \
                 mock.patch.object(controller.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode()))), \
                 mock.patch.object(storage, 'locked', side_effect=nullcontext, create=True), \
                 mock.patch.object(storage, 'claim', self.claim, create=True), \
                 mock.patch.object(storage, 'validate_binding', create=True), \
                 mock.patch.object(storage, 'lookup', return_value=BINDING, create=True), \
                 mock.patch.object(storage, 'finish', self.finish, create=True), \
                 mock.patch.object(controller.subprocess, 'Popen', return_value=journal), \
                 mock.patch.object(controller.selectors, 'DefaultSelector', return_value=selector), \
                 mock.patch.object(controller.io_select, 'select', return_value=([], [], [])), \
                 mock.patch.object(pathlib.Path, 'mkdir'), \
                 mock.patch.object(pathlib.Path, 'write_text', autospec=True, side_effect=write):
                try:
                    self.assertEqual(controller.guardian(IDENTIFIER), 0 if launch else 1)
                except RuntimeError as error:
                    self.cleanup_error = str(error)
                    if not finish_error and not journal_error and active == 'inactive' and group in ('', '/system.slice/' + controller.unit_name(IDENTIFIER)):
                        raise
                if not launch:
                    self.assertIn('error', [kind for kind, _ in self.events])
        return commands, writes

    def test_operation_identity_cannot_select_arbitrary_units(self):
        self.assertEqual(controller.unit_name(IDENTIFIER), 'ohmygame-job-' + IDENTIFIER + '.service')
        for value in ['../other', 'a' * 31, 'A' * 32, IDENTIFIER + '; stop other']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                controller.unit_name(value)

    def test_every_mode_has_the_same_containment_properties(self):
        for mode in ['install', 'build', 'preview', 'shell']:
            with self.subTest(mode=mode):
                request = {'projectId': PROJECT, 'cwd': '', 'mode': mode, 'args': ['echo fixture', '10'] if mode == 'shell' else ['run', 'dev'], 'port': 18080}
                commands, _ = self.invoke(request)
                task = next(args for args in commands if args[0] == 'systemd-run')
                for value in ['PrivateNetwork=yes', 'PrivateIPC=yes', 'KeyringMode=private', 'ProtectSystem=strict', 'ProtectHome=yes', 'NoNewPrivileges=yes', 'KillMode=control-group', 'SendSIGKILL=yes', 'MemoryMax=1G', 'MemorySwapMax=0', 'TasksMax=128', 'CPUQuota=50%', 'ReadWritePaths=/workspace /cache', 'ProtectControlGroups=yes', 'RestrictNamespaces=yes', 'BindsTo=ohmygame-control-' + IDENTIFIER + '.service']:
                    self.assertIn('--property=' + value, task)
                environment = next(value for value in task if value.startswith('--property=Environment='))
                self.assertIn('HOME=/tmp ', environment)
                self.assertNotIn('SSH_AUTH_SOCK', environment)
                self.assertNotIn('API_KEY', environment)
                self.assertIn('--property=RuntimeMaxSec=' + ('10s' if mode == 'shell' else '900s' if mode == 'preview' else '120s'), task)
                if mode == 'install':
                    self.assertEqual(task[-3:], ['--', '/usr/bin/python3', '/opt/ohmygame/npm-install.py'])
                if mode == 'shell':
                    self.assertEqual(task[-6:], ['--', '/bin/bash', '--noprofile', '--norc', '-c', 'echo fixture'])

    def test_invalid_cwd_modes_ports_and_shell_limits_never_launch(self):
        base = {'projectId': PROJECT, 'cwd': '', 'mode': 'preview', 'args': ['run', 'dev'], 'port': 18080}
        for change in [{'cwd': '../outside'}, {'mode': 'arbitrary'}, {'port': 80}, {'args': ['exec', 'unknown']}, {'mode': 'shell', 'args': ['echo fixture', '121']}, {'mode': 'shell', 'args': ['bad\x00command', '10']}]:
            with self.subTest(change=change):
                commands, _ = self.invoke({**base, **change})
                self.assertFalse(any(args[0] == 'systemd-run' for args in commands))

    def test_shell_source_reaches_bash_verbatim_without_manager_expansion(self):
        for source in ["node <<'JS'\nconsole.log(`combo=${state.combo.toFixed(1)}`)\nJS\n", 'printf "%s" "$HOME $$ ${value}"', "printf '%s' 'quotes \\\" and $literal'\nexit 9"]:
            with self.subTest(source=source):
                commands, _ = self.invoke({'projectId': PROJECT, 'cwd': '', 'mode': 'shell', 'args': [source, '10']})
                task = next(args for args in commands if args[0] == 'systemd-run')
                self.assertIn('--expand-environment=no', task)
                self.assertEqual(task[-6:], ['--', '/bin/bash', '--noprofile', '--norc', '-c', source])

    def test_failure_kills_only_the_exact_job_cgroup_and_stops_its_unit(self):
        unit = controller.unit_name(IDENTIFIER)
        request = {'projectId': PROJECT, 'cwd': '', 'mode': 'build'}
        for group, expected in [('/system.slice/' + unit, True), ('/system.slice/other.service', False)]:
            with self.subTest(group=group):
                commands, writes = self.invoke(request, group)
                kill = [value for value in writes if value[0].endswith('/cgroup.kill')]
                self.assertEqual(bool(kill), expected)
                if expected:
                    self.assertEqual(kill, [('/sys/fs/cgroup' + group + '/cgroup.kill', '1')])
                if expected:
                    self.assertIn(['systemctl', 'stop', unit], commands)
                    self.assertIn(['systemctl', 'reset-failed', unit], commands)
                else:
                    self.assertIsNotNone(self.cleanup_error)
                    self.finish.assert_not_called()
                    self.assertFalse(commands)

    def test_wrong_or_stale_binding_never_stops_an_existing_unit(self):
        for change in [{'namespace': 'other'}, {'operationId': 'c' * 32}, {'generation': 0}, {'generation': True}, {'leaseToken': 'bad'}, {'projectId': PROJECT.upper()}]:
            with self.subTest(change=change):
                commands, _ = self.invoke({**change, 'mode': 'build'})
                self.claim.assert_not_called()
                self.finish.assert_not_called()
                self.assertFalse(commands)

    def test_duplicate_claim_failure_cannot_stop_the_claimed_owner(self):
        commands, _ = self.invoke({'mode': 'build'}, claim_error=ValueError('Already running'))
        self.assertFalse(commands)
        self.finish.assert_not_called()

    def test_exit_is_emitted_only_after_shutdown_and_durable_finish(self):
        commands, _ = self.invoke({'mode': 'build'}, launch=True)
        self.assertIn(['systemctl', 'stop', controller.unit_name(IDENTIFIER)], commands)
        self.assertLess(self.order.index('finished'), self.order.index('exit'))
        self.finish.assert_called_once_with(BINDING, True)

    def test_active_or_unknown_shutdown_preserves_lease_and_has_no_success_exit(self):
        commands, _ = self.invoke({'mode': 'build'}, active='active')
        self.assertIsNotNone(self.cleanup_error)
        self.finish.assert_not_called()
        self.assertNotIn('exit', self.order)

    def test_failed_finish_never_emits_a_success_terminal(self):
        self.invoke({'mode': 'build'}, launch=True, finish_error=RuntimeError('Unable to persist finish'))
        self.assertIsNotNone(self.cleanup_error)
        self.assertNotIn('exit', self.order)

    def test_logging_failure_cannot_skip_task_shutdown_and_finish(self):
        commands, _ = self.invoke({'mode': 'build'}, launch=True, journal_error=RuntimeError('Log process failed'))
        self.assertIn(['systemctl', 'stop', controller.unit_name(IDENTIFIER)], commands)
        self.finish.assert_called_once_with(BINDING, True)
        self.assertIsNotNone(self.cleanup_error)
        self.assertNotIn('exit', self.order)


class ControlCommands(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='ohmygame-control-command-')
        self.addCleanup(self.directory.cleanup)
        self.state = pathlib.Path(self.directory.name).resolve()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(controller, 'STATE', self.state))
        self.stack.enter_context(mock.patch.object(storage, 'locked', side_effect=nullcontext, create=True))
        self.stack.enter_context(mock.patch.object(pathlib.Path, 'touch'))
        self.stack.enter_context(mock.patch.object(pathlib.Path, 'mkdir'))
        self.stack.enter_context(mock.patch.object(controller, 'ensure_npm_config'))
        self.command = self.stack.enter_context(mock.patch.object(controller, 'run', side_effect=AssertionError('No system command is allowed in this fixture')))
        self.stack.enter_context(mock.patch.object(controller, 'properties', return_value={'ActiveState': 'inactive', 'MainPID': '0'}))

    def call(self, name, spec, args=()):
        output = io.StringIO()
        with mock.patch.object(controller.sys, 'argv', ['controller', name, *args]), \
             mock.patch.object(controller.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(json.dumps(spec).encode()))), \
             mock.patch.object(controller.sys, 'stdout', output):
            controller.main()
        return json.loads(output.getvalue())

    def test_prepare_is_locked_and_requires_the_reserved_operation_identity(self):
        with mock.patch.object(storage, 'prepare', return_value={'prepared': True}, create=True) as prepare:
            spec = {**BINDING, 'mode': 'build', 'files': [], 'packages': []}
            self.assertEqual(self.call('prepare', spec), {'prepared': True})
            prepare.assert_called_once_with(spec)
            self.assertTrue((self.state / (IDENTIFIER + '.lock')).exists())
            self.command.assert_not_called()

    def test_prepare_media_dispatch_reads_json_header_and_preserves_binary_tail(self):
        spec = {**BINDING, 'mode': 'build', 'files': [], 'packages': []}
        media = bytes(range(256))
        output = io.StringIO()
        def prepare(value, stream, request):
            self.assertEqual(value, spec)
            request(['public/movie.mp4'])
            self.assertEqual(stream.read(), media)
            return {'prepared': True}
        with mock.patch.object(controller.sys, 'argv', ['controller.py', 'prepare-media']), \
             mock.patch.object(controller.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(json.dumps(spec).encode() + b'\n' + media))), \
             mock.patch.object(controller.sys, 'stdout', output), mock.patch.object(controller.signal, 'alarm'), \
             mock.patch.object(storage, 'prepare', side_effect=prepare):
            controller.main()
        self.assertEqual([json.loads(line) for line in output.getvalue().splitlines()],
                         [{'needMedia': ['public/movie.mp4']}, {'prepared': True}])

    def test_profile_windows_forward_the_exact_binding_and_preserve_binary_eof(self):
        binding={**BINDING,'captureVersion':4,'sourceManifestVersion':2,'sourceProfileId':storage.PROFILE_ID,'sourceBaseManifestId':'c'*64,'rasterReturnVersion':2,'uploadVersion':1}
        spec={**binding,'windowIndex':0,'windowId':'d'*32};media=bytes(range(256));output=io.StringIO()
        def append(value,stream,request):
            self.assertEqual(value,spec);request(['public/a.png']);self.assertEqual(stream.read(),media)
            return {'appended':True,'windowIndex':0,'windowId':'d'*32}
        with mock.patch.object(controller.sys,'argv',['controller','prepare-append']),mock.patch.object(controller.sys,'stdin',types.SimpleNamespace(buffer=io.BytesIO(json.dumps(spec).encode()+b'\n'+media))),mock.patch.object(controller.sys,'stdout',output),mock.patch.object(controller.signal,'alarm') as alarm,mock.patch.object(storage,'prepare_append',side_effect=append) as action:
            controller.main();action.assert_called_once();self.assertEqual(alarm.call_args_list,[mock.call(120),mock.call(0)])
        self.assertEqual([json.loads(row) for row in output.getvalue().splitlines()],[{'needMedia':['public/a.png']},{'appended':True,'windowIndex':0,'windowId':'d'*32}])
        for operation,request in [('prepare-begin',{**BINDING,'mode':'build','files':[],'packages':[],'sourceManifestVersion':2,'sourceProfileId':storage.PROFILE_ID,'sourceManifest':storage.lifecycle.source_manifest([],storage.PROFILE_ID),'rasterReturnVersion':2}),('prepare-commit',binding)]:
            with self.subTest(operation=operation),mock.patch.object(storage,operation.replace('-','_'),return_value={'ok':True}) as action,mock.patch.object(controller.signal,'alarm'):
                self.assertEqual(self.call(operation,request),{'ok':True});action.assert_called_once_with(request)
        self.command.assert_not_called()
    def test_native_capacity_controls_hold_one_explicit_exclusive_lease_without_project_commands(self):
        spec={'namespace':'manual','projectId':PROJECT,'planId':'b9bde78a-538d-4e6e-9b9b-2149ff0e54c6'}
        for operation in ('plan-capacity','inspect-capacity-plan','register-capacity-authorization','migrate-capacity'):
            with self.subTest(operation=operation),mock.patch.object(storage,'review_locked',side_effect=lambda **_:nullcontext()) as lock,mock.patch.object(storage,operation.replace('-','_'),return_value={'ok':True}) as action:
                self.assertEqual(self.call(operation,spec),{'ok':True});lock.assert_called_once_with(initialize=True);action.assert_called_once_with(spec)
        self.command.assert_not_called()
    def test_profile_capture4_projects_source_profile_and_disallows_window_authority(self):
        spec={**BINDING,'captureVersion':4,'sourceManifestVersion':2,'sourceProfileId':storage.PROFILE_ID,'sourceBaseManifestId':'c'*64}
        for extra in ({'windowId':'d'*32},{'rasterReturnVersion':2},{'sourceResultManifestId':'e'*64},{'sourceManifestVersion':1},{'captureVersion':3}):
            with self.subTest(extra=extra),mock.patch.object(storage,'capture_media') as action:
                with self.assertRaises(ValueError):self.call('capture-media',{**spec,**extra})
                action.assert_not_called()
        output=io.BytesIO()
        with mock.patch.object(controller.sys,'argv',['controller','capture-media']),mock.patch.object(controller.sys,'stdin',types.SimpleNamespace(buffer=io.BytesIO(json.dumps(spec).encode()))),mock.patch.object(controller.sys,'stdout',types.SimpleNamespace(buffer=output)),mock.patch.object(controller.signal,'alarm'),mock.patch.object(storage,'capture_media',side_effect=lambda value,out:out.write(b'{}\n')) as action:
            controller.main();action.assert_called_once_with(spec,output)

    def test_cancel_before_prepare_blocks_late_preparation_without_creating_storage(self):
        partial = {key: BINDING[key] for key in ('namespace', 'projectId', 'operationId')}
        with mock.patch.object(storage, 'cancel', return_value={'cancelled': True, 'operation': None}, create=True), \
             mock.patch.object(storage, 'prepare', create=True) as prepare:
            self.assertEqual(self.call('cancel', partial, [IDENTIFIER]), {'stopped': True, 'operation': None})
            with self.assertRaisesRegex(RuntimeError, 'cancelled before preparation'):
                self.call('prepare', {**partial, 'mode': 'build', 'files': [], 'packages': []})
            prepare.assert_not_called()
            self.command.assert_not_called()

    def test_cancelled_preparation_cannot_poison_another_namespace(self):
        partial = {key: BINDING[key] for key in ('namespace', 'projectId', 'operationId')}
        with mock.patch.object(storage, 'cancel', side_effect=ValueError('Namespace mismatch'), create=True):
            with self.assertRaisesRegex(ValueError, 'Namespace mismatch'):
                self.call('cancel', {**partial, 'namespace': 'test'}, [IDENTIFIER])
            self.assertFalse((self.state / (IDENTIFIER + '.cancelled')).exists())
            self.command.assert_not_called()

    def test_cancel_existing_binding_finishes_failed_and_releases_only_after_exact_stop(self):
        order = []
        launch = self.state / (IDENTIFIER + '.request')
        launch.write_text(json.dumps(BINDING))
        launch.chmod(0o600)
        with mock.patch.object(storage, 'cancel', return_value={'cancelled': True, 'operation': BINDING}, create=True), \
             mock.patch.object(controller, 'stopped', side_effect=lambda *a, **k: order.append('stopped')), \
             mock.patch.object(storage, 'finish', side_effect=lambda *a: order.append(('finish', a)), create=True), \
             mock.patch.object(storage, 'release', side_effect=lambda *a: order.append(('release', a)), create=True):
            self.assertEqual(self.call('cancel', BINDING, [IDENTIFIER]), {'stopped': True, 'operation': BINDING})
        self.assertEqual(order, ['stopped', ('finish', (BINDING, False)), ('release', (BINDING,))])

    def test_launch_validates_prepared_binding_before_creating_the_control_service(self):
        header = json.dumps({**BINDING, 'mode': 'build'}).encode() + b'\n' + b'{"op":"heartbeat"}\n'
        pending = iter(bytes([byte]) for byte in header)
        with mock.patch.object(controller.os, 'read', side_effect=lambda fd, count: next(pending, b'')), \
             mock.patch.object(storage, 'validate_binding', create=True) as validate, \
             mock.patch.object(controller.os, 'execv') as execute:
            controller.launch(IDENTIFIER)
            validate.assert_called_once_with(BINDING, phases=('prepared',))
            self.assertEqual(next(pending), b'{')
            self.assertEqual(controller.private_record(self.state / (IDENTIFIER + '.request'))['mode'], 'build')
            self.assertEqual(execute.call_args.args[0], '/usr/bin/systemd-run')

    def test_unprepared_launch_never_spawns_or_writes_a_request(self):
        header = iter(bytes([byte]) for byte in json.dumps({**BINDING, 'mode': 'build'}).encode() + b'\n')
        with mock.patch.object(controller.os, 'read', side_effect=lambda fd, count: next(header, b'')), \
             mock.patch.object(storage, 'validate_binding', side_effect=ValueError('Stale operation'), create=True), \
             mock.patch.object(controller.os, 'execv') as execute:
            with self.assertRaisesRegex(ValueError, 'Stale operation'):
                controller.launch(IDENTIFIER)
            execute.assert_not_called()
            self.assertFalse((self.state / (IDENTIFIER + '.request')).exists())

    def test_existing_foreign_task_cannot_be_stopped_by_a_prepared_but_unlaunched_lease(self):
        with mock.patch.object(storage, 'cancel', return_value={'cancelled': True, 'operation': BINDING}, create=True), \
             mock.patch.object(controller, 'properties', return_value={'ActiveState': 'active', 'MainPID': '123'}), \
             mock.patch.object(controller, 'stopped') as stopped:
            with self.assertRaisesRegex(RuntimeError, 'unowned isolated unit'):
                self.call('cancel', BINDING, [IDENTIFIER])
            stopped.assert_not_called()

    def test_unknown_cancellation_refuses_to_stop_an_unowned_unit(self):
        with mock.patch.object(storage, 'cancel', return_value={'cancelled': True, 'operation': None}, create=True), \
             mock.patch.object(controller, 'properties', return_value={'ActiveState': 'active', 'MainPID': '123'}), \
             mock.patch.object(controller, 'stopped') as stopped:
            with self.assertRaisesRegex(RuntimeError, 'unowned isolated unit'):
                self.call('cancel', BINDING, [IDENTIFIER])
            stopped.assert_not_called()
            self.command.assert_not_called()

    def test_capture_ack_release_and_export_forward_only_the_bound_lease(self):
        cases = [('capture', 'capture', BINDING), ('acknowledge', 'acknowledge', {**BINDING, 'snapshotId': 'c' * 64}), ('release', 'release', BINDING)]
        for command, method, spec in cases:
            with self.subTest(command=command), mock.patch.object(storage, method, return_value={'ok': True}, create=True) as action:
                self.assertEqual(self.call(command, spec), {'ok': True})
                action.assert_called_once_with(spec)
        with mock.patch.object(storage, 'export_bound', return_value={'files': []}, create=True) as export:
            self.assertEqual(self.call('export', {**BINDING, 'directory': 'games/demo'}), {'files': []})
            export.assert_called_once_with(BINDING, 'games/demo')
        self.command.assert_not_called()

    def test_export_media_dispatch_preserves_bound_binary_output_and_deadline(self):
        output = io.BytesIO()
        binary = bytes(range(256))
        def export(binding, directory, stream):
            self.assertEqual(binding, BINDING)
            self.assertEqual(directory, 'games/demo')
            stream.write(b'{"files":[]}\n' + binary)
        spec = {**BINDING, 'directory': 'games/demo'}
        with mock.patch.object(controller.sys, 'argv', ['controller', 'export-media']), \
             mock.patch.object(controller.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(json.dumps(spec).encode()))), \
             mock.patch.object(controller.sys, 'stdout', types.SimpleNamespace(buffer=output)), \
             mock.patch.object(controller.signal, 'alarm') as alarm, mock.patch.object(storage, 'export_bound', side_effect=export):
            controller.main()
        self.assertEqual(output.getvalue(), b'{"files":[]}\n' + binary)
        self.assertEqual(alarm.call_args_list, [mock.call(120), mock.call(0)])

    def test_health_reports_v2_readiness_without_creating_control_or_npm_files(self):
        with mock.patch.object(storage, '_store', return_value=types.SimpleNamespace(health=lambda: {'protocolVersion': 2, 'ready': False, 'migrationRequired': True})), \
             mock.patch.object(controller, 'state_ready') as initialize, \
             mock.patch.object(controller, 'ensure_npm_config') as npm, \
             mock.patch.object(pathlib.Path, 'read_text', return_value='cpu memory'):
            value = self.call('health', {})
            self.assertEqual(value['backend'], 'lima-vz-cgroup-v2')
            self.assertEqual(value['protocolVersion'], 2)
            self.assertFalse(value['ready'])
            self.assertTrue(value['migrationRequired'])
            self.assertEqual(value['retainedReviewVersion'], 2)
            self.assertEqual(value['captureVersion'], 2)
            self.assertEqual(value['rasterInspectionVersion'], 2)
            self.assertEqual(value['rasterReturnVersion'], 1)
            self.assertEqual(value['sourceManifestVersion'], 1)
            self.assertEqual(value['manifestCaptureVersion'], 3)
            self.assertEqual(value['capacityProfileVersion'], 3)
            self.assertEqual(value['capacityProfiles'], [dict(profile) for profile in storage.RUNTIME_PROFILES.values()])
            self.assertEqual([row['version'] for row in value['capacityProfiles']], [2, 3])
            self.assertEqual(value['profileManifestVersion'], 2)
            self.assertEqual(value['profileCaptureVersion'], 4)
            self.assertEqual(value['profileUploadVersion'], 1)
            self.assertEqual(value['volumeMigrationVersion'], 1)
            initialize.assert_not_called()
            npm.assert_not_called()

    def test_overview_dispatch_is_global_shared_locked_and_never_initializes(self):
        value = {'protocolVersion': 2, 'scope': 'global', 'ready': True, 'projects': []}
        with mock.patch.object(storage, 'overview', return_value=value) as overview, \
             mock.patch.object(storage, 'read_locked', side_effect=nullcontext) as lock, \
             mock.patch.object(storage, 'locked', side_effect=AssertionError('Overview requested a write lock')), \
             mock.patch.object(controller, 'state_ready') as initialize, \
             mock.patch.object(controller, 'ensure_npm_config') as npm:
            self.assertEqual(self.call('overview', {}), value)
            overview.assert_called_once_with()
            lock.assert_called_once_with()
            initialize.assert_not_called()
            npm.assert_not_called()
            with self.assertRaisesRegex(ValueError, 'global'):
                self.call('overview', {'namespace': 'manual'})
            self.assertEqual(overview.call_count, 1)
        self.command.assert_not_called()

    def test_explicit_legacy_review_uses_exclusive_review_lock_without_initializing_or_running_tasks(self):
        spec = {'namespace': 'manual', 'projectId': PROJECT, 'generation': 22}
        value = {**spec, 'snapshotId': 'c' * 64, 'files': [], 'baselineFiles': []}
        with mock.patch.object(storage, 'review_source', return_value=value) as review, \
             mock.patch.object(storage, 'review_locked', side_effect=nullcontext) as lock, \
             mock.patch.object(storage, 'read_locked', side_effect=AssertionError('Review requested only a shared lock')), \
             mock.patch.object(storage, 'locked', side_effect=AssertionError('Review requested a write lock')), \
             mock.patch.object(controller, 'state_ready') as initialize, \
             mock.patch.object(controller, 'ensure_npm_config') as npm:
            self.assertEqual(self.call('review-source', spec), value)
            review.assert_called_once_with(spec); lock.assert_called_once_with()
            initialize.assert_not_called(); npm.assert_not_called()
        self.command.assert_not_called()

    def test_retained_review_uses_only_explicit_cold_lock_and_preserves_binary_framing(self):
        spec = {'namespace': 'manual', 'projectId': PROJECT, 'generation': 37, 'reviewVersion': 2}
        output = io.BytesIO(); body = b'{"reviewVersion":2,"retainedRasters":[]}\n' + bytes(range(256))
        def review(value, stream):
            self.assertEqual(value, spec); stream.write(body)
        with mock.patch.object(controller.sys, 'argv', ['controller', 'review-source-media']), \
             mock.patch.object(controller.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(json.dumps(spec).encode()))), \
             mock.patch.object(controller.sys, 'stdout', types.SimpleNamespace(buffer=output)), \
             mock.patch.object(storage, 'review_source_media', side_effect=review) as read, \
             mock.patch.object(storage, 'review_locked', side_effect=lambda **_kw: nullcontext()) as lock, \
             mock.patch.object(controller, 'state_ready') as initialize, \
             mock.patch.object(controller, 'ensure_npm_config') as npm, mock.patch.object(controller.signal, 'alarm') as alarm:
            controller.main()
            self.assertEqual(output.getvalue(), body)
            read.assert_called_once(); lock.assert_called_once_with(initialize=True)
            initialize.assert_not_called(); npm.assert_not_called()
            self.assertEqual(alarm.call_args_list, [mock.call(120), mock.call(0)])
        self.command.assert_not_called()

    def test_invalid_retained_review_never_initializes_a_lock_or_reads_storage(self):
        base = {'namespace': 'manual', 'projectId': PROJECT, 'generation': 37, 'reviewVersion': 2}
        for change in ({'reviewVersion': True}, {'reviewVersion': 1}, {'reviewVersion': '2'}, {'generation': True}, {'path': '/etc/passwd'}, {'operationId': IDENTIFIER},
                       {'namespace': 'other'}, {'projectId': '../other'}):
            with self.subTest(change=change), mock.patch.object(storage, 'review_locked') as lock, \
                    mock.patch.object(storage, 'review_source_media') as read:
                with self.assertRaises(ValueError): self.call('review-source-media', {**base, **change})
                lock.assert_not_called(); read.assert_not_called()

    def test_source_deletion_withdrawal_controls_use_exact_requests_and_the_expected_locks(self):
        binding = {'namespace': 'manual', 'projectId': PROJECT, 'generation': 37, 'originalOperationId': IDENTIFIER,
                   'withdrawalId': 'b' * 32, 'reviewId': 'c' * 64, 'rawSnapshotId': 'd' * 64,
                   'rawManifestId': 'e' * 64, 'baseManifestId': 'f' * 64}
        for operation, request, phase in (
            ('inspect-source-deletion-withdrawal', binding, 'restoring'),
            ('restore-source-deletions', {**binding, 'files': [{'path': 'src/source.mjs', 'data': 'a' * 132000}]}, 'restored'),
            ('confirm-source-deletion-withdrawal', binding, 'confirmed'),
        ):
            read_only = operation.startswith('inspect')
            with self.subTest(operation=operation), \
                 mock.patch.object(storage, operation.replace('-', '_'), return_value={**binding, 'phase': phase}) as action, \
                 mock.patch.object(storage, 'review_locked', side_effect=lambda **_kwargs: nullcontext()) as reader, \
                 mock.patch.object(storage, 'locked', side_effect=nullcontext) as writer, \
                 mock.patch.object(controller, 'state_ready') as initialize:
                self.assertEqual(self.call(operation, request), {**binding, 'phase': phase})
                action.assert_called_once_with(request)
                if read_only:
                    reader.assert_called_once_with(initialize=True)
                    writer.assert_not_called()
                else:
                    writer.assert_called_once_with()
                    reader.assert_not_called()
                self.assertEqual(initialize.call_count, int(not read_only))
        self.command.assert_not_called()

    def test_retained_capture_and_ack_forward_the_explicit_version_without_authority_payloads(self):
        binding = {**BINDING, 'reviewVersion': 2}
        for operation, request in [('capture', binding), ('acknowledge', {**binding, 'snapshotId': 'c' * 64})]:
            with self.subTest(operation=operation), mock.patch.object(storage, operation, return_value={'ok': True}) as action:
                self.assertEqual(self.call(operation, {**request, 'files': [{'path': '/forged', 'size': 1}]}), {'ok': True})
                action.assert_called_once_with(request)

    def test_streamed_capture_requires_exact_binding_and_preserves_binary_framing(self):
        spec = {**BINDING, 'captureVersion': 2}
        output = io.BytesIO(); body = b'{"captureVersion":2,"returnedRasters":[]}\n' + bytes(range(256))
        def capture(value, stream):
            self.assertEqual(value, spec); stream.write(body)
        with mock.patch.object(controller.sys, 'argv', ['controller', 'capture-media']), \
             mock.patch.object(controller.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(json.dumps(spec).encode()))), \
             mock.patch.object(controller.sys, 'stdout', types.SimpleNamespace(buffer=output)), \
             mock.patch.object(storage, 'capture_media', side_effect=capture) as action, \
             mock.patch.object(storage, 'locked', side_effect=nullcontext) as lock, \
             mock.patch.object(controller, 'ensure_npm_config') as npm, mock.patch.object(controller.signal, 'alarm') as alarm:
            controller.main()
            self.assertEqual(output.getvalue(), body)
            action.assert_called_once(); lock.assert_called_once_with()
            npm.assert_not_called()
            self.assertEqual(alarm.call_args_list, [mock.call(120), mock.call(0)])
        self.command.assert_not_called()

    def test_streamed_capture_rejects_authority_payloads_before_storage_and_forwards_ack_version(self):
        spec = {**BINDING, 'captureVersion': 2}
        for change in ({'captureVersion': True}, {'captureVersion': 1}, {'captureVersion': '2'}, {'generation': True},
                       {'leaseToken': 'bad'}, {'reviewVersion': 2}, {'files': []}, {'returnedRasters': []}, {'path': '/etc/passwd'}):
            with self.subTest(change=change), mock.patch.object(storage, 'locked') as lock, mock.patch.object(storage, 'capture_media') as action:
                with self.assertRaises(ValueError): self.call('capture-media', {**spec, **change})
                action.assert_not_called(); lock.assert_not_called()
        with mock.patch.object(storage, 'acknowledge', return_value={'acknowledged': True}) as action:
            expected = {**spec, 'snapshotId': 'c' * 64}
            self.assertEqual(self.call('acknowledge', {**expected, 'files': [{'path': '/forged'}]}), {'acknowledged': True})
            action.assert_called_once_with(expected)
        with mock.patch.object(storage, 'capture', return_value={'unused': True}) as action:
            self.assertEqual(self.call('capture', spec), {'unused': True})
            action.assert_called_once_with(spec)  # Storage must see the version to reject the wrong endpoint.

    def test_typed_capture3_and_review_keep_exact_source_identity_and_reject_capture2_downgrade(self):
        typed = {'sourceManifestVersion': 1, 'sourceBaseManifestId': 'a' * 64}
        spec = {**BINDING, 'captureVersion': 3, **typed}
        output = io.BytesIO(); body = b'{"captureVersion":3,"sourceManifestVersion":1}\n' + bytes(range(256))
        with mock.patch.object(controller.sys, 'argv', ['controller', 'capture-media']), \
             mock.patch.object(controller.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(json.dumps(spec).encode()))), \
             mock.patch.object(controller.sys, 'stdout', types.SimpleNamespace(buffer=output)), mock.patch.object(controller.signal, 'alarm'), \
             mock.patch.object(storage, 'capture_media', side_effect=lambda request, stream: stream.write(body)) as action:
            controller.main(); self.assertEqual(output.getvalue(), body); action.assert_called_once_with(spec, output)
        for invalid in ({**spec, 'captureVersion': 2}, {key: value for key, value in spec.items() if key != 'sourceBaseManifestId'}, {**spec, 'sourceManifestVersion': True}):
            with self.subTest(invalid=invalid), mock.patch.object(storage, 'capture_media') as action:
                with self.assertRaises(ValueError): self.call('capture-media', invalid)
                action.assert_not_called()
        for operation, request in [('capture', {**spec, 'reviewVersion': 2}), ('acknowledge', {**spec, 'reviewVersion': 2, 'snapshotId': 'b' * 64, 'sourceResultManifestId': 'c' * 64})]:
            with self.subTest(operation=operation), mock.patch.object(storage, operation, return_value={'ok': True}) as action:
                self.assertEqual(self.call(operation, {**request, 'files': ['/forged']}), {'ok': True}); action.assert_called_once_with(request)

    def test_prepare_media_counts_the_actual_header_before_metadata_or_storage_processing(self):
        self.assertEqual(storage.MAX_REQUEST, 24 * 1024 * 1024)
        spec = {**BINDING, 'mode': 'build', 'files': [], 'packages': [], 'rasterReturnVersion': 2,
            'sourceManifestVersion': 1, 'sourceManifest': storage.lifecycle.source_manifest([])}
        header = json.dumps(spec).encode() + b'\n'
        with mock.patch.object(controller.sys, 'argv', ['controller', 'prepare-media']), \
             mock.patch.object(controller.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(header))), \
             mock.patch.object(storage, 'MAX_REQUEST', len(header) - 2), mock.patch.object(controller.signal, 'alarm'), \
             mock.patch.object(storage, 'prepare') as prepare:
            with self.assertRaisesRegex(ValueError, 'header'): controller.main()
            prepare.assert_not_called()

    def test_control_record_budget_refuses_new_operations_without_discarding_old_records(self):
        existing = self.state / (IDENTIFIER + '.lock')
        existing.write_bytes(b'')
        with mock.patch.object(controller, 'MAX_CONTROL_OPERATIONS', 1):
            controller.control_budget(IDENTIFIER)
            with self.assertRaisesRegex(ValueError, 'history budget is full'):
                with controller.operation_lock('c' * 32):
                    self.fail('No new operation may be admitted')
        self.assertTrue(existing.exists())
        self.assertFalse((self.state / ('c' * 32 + '.lock')).exists())

    def test_record_byte_budget_is_checked_before_any_partial_file_is_created(self):
        file = self.state / (IDENTIFIER + '.request')
        with mock.patch.object(controller, 'MAX_CONTROL_BYTES', 1):
            with self.assertRaisesRegex(ValueError, 'history budget is full'):
                controller.write_record(file, BINDING)
        self.assertFalse(file.exists())

    def test_private_records_reject_links_and_publicly_readable_content(self):
        file = self.state / (IDENTIFIER + '.request')
        file.write_text(json.dumps(BINDING))
        file.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'Invalid isolated control record'):
            controller.private_record(file)
        link = self.state / ('c' * 32 + '.request')
        link.symlink_to(file)
        with self.assertRaises(OSError):
            controller.private_record(link)

    def test_unicode_launch_record_preserves_the_bounded_header(self):
        file = self.state / (IDENTIFIER + '.request')
        spec = {**BINDING, 'mode': 'shell', 'args': ['字' * 10000, '10']}
        controller.write_record(file, spec)
        self.assertEqual(controller.private_record(file), spec)
        self.assertLess(file.stat().st_size, controller.MAX_LINE)

    def test_stale_snapshot_error_is_structured_without_rewriting_the_code(self):
        error = ValueError('Workspace needs recovery')
        error.code, error.changed = 'RECOVERY_REQUIRED', False
        output = io.StringIO()
        with mock.patch.object(controller, 'main', side_effect=error), mock.patch.object(controller.sys, 'stdout', output):
            self.assertEqual(controller.entrypoint(), 1)
        self.assertEqual(json.loads(output.getvalue()), {'error': {'code': 'RECOVERY_REQUIRED', 'message': 'Workspace needs recovery', 'changed': False}})

class ControllerStoreContracts(unittest.TestCase):
    """Exercise the real registry protocol; only VM/systemd effects are replaced."""
    def setUp(self):
        from test_lifecycle import FakeBackend, lifecycle, transfer
        self.transfer = transfer
        self.directory = tempfile.TemporaryDirectory(prefix='ohmygame-controller-store-')
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name).resolve()
        self.state = self.root / 'control'
        self.state.mkdir(mode=0o700)
        self.backend = FakeBackend()
        self.store = lifecycle.Store(self.root / 'volumes', self.backend, volume_bytes=65536,
                                     total_bytes=16 * 65536, reserve_bytes=0)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(controller, 'STATE', self.state))
        self.stack.enter_context(mock.patch.object(storage, '_store', return_value=self.store, create=True))
        self.stack.enter_context(mock.patch.object(storage, 'locked', side_effect=nullcontext))
        self.stack.enter_context(mock.patch.object(controller, 'ensure_npm_config'))
        self.stack.enter_context(mock.patch.object(controller.os, 'set_blocking'))
        original_mkdir = pathlib.Path.mkdir
        def mkdir(path, *args, **kwargs):
            if str(path) not in ('/workspace', '/cache', '/packages'):
                return original_mkdir(path, *args, **kwargs)
        self.stack.enter_context(mock.patch.object(pathlib.Path, 'mkdir', autospec=True, side_effect=mkdir))
        self.launch_change = None
        self.commands = []
        def run(args, check=True):
            self.commands.append(args)
            if args[0] == 'systemd-run':
                if self.launch_change:
                    workspace = pathlib.Path(self.store.validate_binding(self.binding)['workspace'])
                    (workspace / 'index.html').write_text(self.launch_change)
            elif args[:2] not in (['systemctl', 'stop'], ['systemctl', 'reset-failed']):
                raise AssertionError('Unexpected external command in fixture')
            return types.SimpleNamespace(returncode=0, stdout=b'')
        self.stack.enter_context(mock.patch.object(controller, 'run', side_effect=run))
        self.properties = self.stack.enter_context(mock.patch.object(controller, 'properties', return_value={
            'ActiveState': 'inactive', 'MainPID': '0', 'Result': 'success', 'ExecMainStatus': '0', 'ControlGroup': ''}))
        journal = mock.Mock(stdout=io.BytesIO())
        self.stack.enter_context(mock.patch.object(controller.subprocess, 'Popen', return_value=journal))
        selector = mock.Mock()
        selector.select.return_value = []
        self.stack.enter_context(mock.patch.object(controller.selectors, 'DefaultSelector', return_value=selector))
        self.stack.enter_context(mock.patch.object(controller.io_select, 'select', return_value=([], [], [])))

    def call(self, command, spec, args=()):
        output = io.StringIO()
        with mock.patch.object(controller.sys, 'argv', ['controller', command, *args]), \
             mock.patch.object(controller.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(json.dumps(spec).encode()))), \
             mock.patch.object(controller.sys, 'stdout', output):
            controller.main()
        return json.loads(output.getvalue())

    def prepare(self):
        result = self.call('prepare', {'namespace': 'manual', 'projectId': PROJECT,
                                      'operationId': IDENTIFIER, 'mode': 'build',
                                      'files': [self.transfer('index.html', 'host baseline')], 'packages': []})
        self.binding = controller.scope(result, complete=True)
        return self.binding

    def execute(self):
        spec = {**self.binding, 'mode': 'build', 'cwd': ''}
        header = iter(bytes([byte]) for byte in json.dumps(spec).encode() + b'\n')
        with mock.patch.object(controller.os, 'read', side_effect=lambda fd, count: next(header, b'')), \
             mock.patch.object(controller.os, 'execv') as execute:
            controller.launch(IDENTIFIER)
            execute.assert_called_once()
        events = []
        with mock.patch.object(controller, 'emit', side_effect=lambda kind, **values: events.append((kind, values))), \
             mock.patch.object(controller.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO())):
            code = controller.guardian(IDENTIFIER)
        return code, events

    def test_real_prepare_claim_finish_capture_ack_release_roundtrip(self):
        binding = self.prepare()
        code, events = self.execute()
        self.assertEqual(code, 0)
        self.assertEqual(events[-1], ('exit', {'id': IDENTIFIER, 'code': 0}))
        source = self.call('capture', binding)
        self.assertEqual(source['files'][0]['path'], 'index.html')
        self.assertEqual(self.call('acknowledge', {**binding, 'snapshotId': source['snapshotId']}), {'acknowledged': True})
        self.assertEqual(self.call('release', binding), {'released': True, 'dirty': False})
        self.assertFalse((self.state / (IDENTIFIER + '.request')).exists())
        self.assertFalse((self.state / (IDENTIFIER + '.json')).exists())

    def test_failed_command_and_cancel_leave_unique_source_recoverable(self):
        binding = self.prepare()
        self.launch_change = 'unique failed-command edit'
        self.properties.return_value.update(Result='exit-code', ExecMainStatus='1')
        code, events = self.execute()
        self.assertEqual(code, 1)
        self.assertEqual(events[-1], ('exit', {'id': IDENTIFIER, 'code': 1}))
        self.assertTrue(self.call('cancel', binding, [IDENTIFIER])['stopped'])
        inventory = self.store.inventory('manual')
        self.assertTrue(inventory['projects'][0]['dirty'])
        with self.assertRaises(ValueError) as error:
            self.call('prepare', {'namespace': 'manual', 'projectId': PROJECT,
                                  'operationId': 'c' * 32, 'mode': 'build',
                                  'files': [self.transfer('index.html', 'host baseline')], 'packages': []})
        self.assertEqual(error.exception.code, 'RECOVERY_REQUIRED')
        recovery = self.call('recover', {'namespace': 'manual', 'projectId': PROJECT,
                                         'generation': binding['generation'], 'operationId': 'd' * 32})
        source = self.call('capture', recovery)
        self.assertEqual(base64.b64decode(source['files'][0]['data']).decode(), self.launch_change)
        self.call('release', recovery)

    def test_real_registry_rejects_cross_namespace_cancellation_before_marker_or_unit_changes(self):
        binding = self.prepare()
        with self.assertRaises(ValueError) as error:
            self.call('cancel', {**binding, 'namespace': 'test'}, [IDENTIFIER])
        self.assertEqual(error.exception.code, 'INVALID_BINDING')
        self.assertFalse((self.state / (IDENTIFIER + '.cancelled')).exists())
        self.assertFalse(self.commands)
        self.assertIsNotNone(self.store.lookup(binding))

    def test_real_overview_uses_existing_read_only_lock_and_leaves_registry_and_control_unchanged(self):
        self.prepare()
        lock = self.root / 'storage.lock'
        lock.touch(mode=0o600)
        def state():
            return {str(p.relative_to(self.root)): (p.stat().st_ino, p.stat().st_mode, p.stat().st_mtime_ns,
                    p.stat().st_ctime_ns, p.read_bytes() if p.is_file() else None)
                    for p in [self.root, *self.root.rglob('*')]}
        before = state()
        original_open = storage.os.open
        with mock.patch.object(storage, 'LOCK', lock), \
             mock.patch.object(storage.os, 'open', wraps=original_open) as opened, \
             mock.patch.object(storage.fcntl, 'flock', wraps=storage.fcntl.flock) as flock, \
             mock.patch.object(controller, 'state_ready', side_effect=AssertionError('Overview initialized state')), \
             mock.patch.object(controller, 'ensure_npm_config', side_effect=AssertionError('Overview initialized npm')), \
             mock.patch.object(self.store, '_save', side_effect=AssertionError('Overview wrote the registry')):
            value = self.call('overview', {})
        flags = next(call.args[1] for call in opened.call_args_list if call.args[0] == lock)
        self.assertEqual(flags & (storage.os.O_WRONLY | storage.os.O_RDWR | storage.os.O_CREAT | storage.os.O_TRUNC), 0)
        self.assertTrue(flags & storage.os.O_NOFOLLOW)
        self.assertEqual([call.args[1] for call in flock.call_args_list], [storage.fcntl.LOCK_SH | storage.fcntl.LOCK_NB])
        self.assertEqual(value['counts']['residentReserved'], 1)
        self.assertEqual(value['projects'][0]['tasks'][0]['phase'], 'prepared')
        self.assertEqual(before, state())


class OverviewReadLockContracts(unittest.TestCase):
    def test_a_real_writer_lock_refuses_overview_without_waiting_for_the_writer(self):
        with tempfile.TemporaryDirectory(prefix='ohmygame-read-lock-contention-') as name:
            lock = pathlib.Path(name).resolve() / 'storage.lock'
            lock.touch(mode=0o600)
            results = []
            def inspect():
                try:
                    with storage.read_locked():
                        results.append('unexpectedly acquired')
                except storage.lifecycle.LifecycleError as error:
                    results.append(error.code)
            with mock.patch.object(storage, 'LOCK', lock), lock.open('rb') as writer:
                storage.fcntl.flock(writer, storage.fcntl.LOCK_EX)
                worker = threading.Thread(target=inspect)
                try:
                    worker.start()
                    worker.join(timeout=5)
                    self.assertFalse(worker.is_alive(), 'Overview waited for the exclusive writer lock')
                    self.assertEqual(results, ['OVERVIEW_UNAVAILABLE'])
                finally:
                    storage.fcntl.flock(writer, storage.fcntl.LOCK_UN)
                    worker.join(timeout=5)
                with storage.read_locked():
                    pass

    def test_missing_unsafe_and_replaced_locks_are_refused_without_creating_any_state(self):
        with tempfile.TemporaryDirectory(prefix='ohmygame-read-only-lock-') as name:
            root = pathlib.Path(name).resolve()
            lock = root / 'storage.lock'
            with mock.patch.object(storage, 'LOCK', lock):
                with self.assertRaises(storage.lifecycle.LifecycleError):
                    with storage.read_locked():
                        self.fail('Missing lock was accepted')
                self.assertFalse(lock.exists())
                for kind in ('public-write', 'symlink', 'hardlink', 'directory', 'fifo', 'foreign-owner', 'replaced'):
                    target = root / 'target'
                    target.write_text('lock fixture')
                    target.chmod(0o600)
                    if kind == 'symlink':
                        lock.symlink_to(target)
                    elif kind == 'hardlink':
                        storage.os.link(target, lock)
                    elif kind == 'directory':
                        lock.mkdir(mode=0o700)
                    elif kind == 'fifo':
                        storage.os.mkfifo(lock, 0o600)
                    else:
                        lock.write_text('lock fixture')
                        lock.chmod(0o666 if kind == 'public-write' else 0o600)
                    with self.subTest(kind=kind), ExitStack() as stack:
                        if kind == 'foreign-owner':
                            stack.enter_context(mock.patch.object(storage.os, 'getuid', return_value=-1))
                        elif kind == 'replaced':
                            def replaced(*args):
                                lock.unlink()
                                lock.write_text('replacement')
                                lock.chmod(0o600)
                            stack.enter_context(mock.patch.object(storage.fcntl, 'flock', side_effect=replaced))
                        with self.assertRaises(storage.lifecycle.LifecycleError):
                            with storage.read_locked():
                                self.fail('Unsafe lock was accepted')
                    lock.rmdir() if lock.is_dir() else lock.unlink()
                    target.unlink()
            self.assertEqual(list(root.iterdir()), [])

    def test_overview_read_errors_never_expose_private_paths(self):
        with mock.patch.object(storage, '_store') as store:
            store.return_value.overview.side_effect = FileNotFoundError('/private/guest/internal-metadata')
            with self.assertRaises(storage.lifecycle.LifecycleError) as error:
                storage.overview()
            self.assertNotIn('/private', str(error.exception))
            self.assertFalse(error.exception.changed)

class CapacityFailureFrames(unittest.TestCase):
    """Actual Store and scratch files; control, VM, identity and process effects stay mocked."""
    def test_prepare_frames_distinguish_preflight_volume_quota_unknown_and_control_storage_failures(self):
        from test_storage import actual_sync_fixture, PartialVolumeWriter
        variants = [('preflight', None, 'INVALID_REQUEST', False), ('volume-first', errno.ENOSPC, 'GUEST_VOLUME_FULL', True),
            ('volume-partial', errno.ENOSPC, 'GUEST_VOLUME_FULL', True), ('volume-partial', errno.EDQUOT, 'GUEST_QUOTA_EXCEEDED', True),
            ('volume-partial', errno.EIO, 'GUEST_IO_UNKNOWN', True),
            ('storage-after-partial', errno.ENOSPC, 'GUEST_STORAGE_FULL', True),
            ('storage-after-partial', errno.EDQUOT, 'GUEST_STORAGE_QUOTA_EXCEEDED', True),
            ('storage-after-partial', errno.EIO, 'GUEST_STORAGE_UNKNOWN', True)]
        for stage, fault, code, changed in variants:
            with self.subTest(stage=stage, fault=fault), tempfile.TemporaryDirectory(prefix='ohmygame-capacity-frame-') as directory, ExitStack() as stack:
                root = pathlib.Path(directory).resolve()
                stack.enter_context(mock.patch.object(os, 'chown'))
                make, backend, binding, request = actual_sync_fixture(root / 'volumes')
                folder = make().root / ('manual-' + binding['projectId']); key = 'manual-' + binding['projectId']
                previous = make().file.read_bytes(); previous_record = make()._read()['records'][key]
                actual_open, actual_mkdir, actual_atomic = pathlib.Path.open, pathlib.Path.mkdir, storage.lifecycle.atomic_json
                def opening(file, *args, **kwargs):
                    stream = actual_open(file, *args, **kwargs)
                    if stage in ('volume-partial', 'storage-after-partial') and file.name == 'upload' and args and args[0] == 'xb':
                        return PartialVolumeWriter(stream, errno.EDQUOT if stage == 'storage-after-partial' else fault)
                    return stream
                def mkdir(file, *args, **kwargs):
                    if stage == 'volume-first' and file == folder / ('root/sync-' + request['operationId']):
                        raise OSError(fault, 'Synthetic project-volume metadata allocation failure')
                    return actual_mkdir(file, *args, **kwargs)
                def atomic(file, value):
                    if stage == 'storage-after-partial' and file == make().file and value['records'][key]['dirty']:
                        raise OSError(fault, 'Synthetic control registry write failure')
                    return actual_atomic(file, value)
                if stage == 'preflight': request['sourceManifest'] = {**request['sourceManifest'], 'manifestId': 'f' * 64}
                stack.enter_context(mock.patch.object(pathlib.Path, 'open', opening))
                stack.enter_context(mock.patch.object(pathlib.Path, 'mkdir', mkdir))
                stack.enter_context(mock.patch.object(storage.lifecycle, 'atomic_json', atomic))
                stack.enter_context(mock.patch.object(controller, 'state_ready'))
                stack.enter_context(mock.patch.object(controller, 'ensure_npm_config'))
                stack.enter_context(mock.patch.object(controller, 'operation_lock', side_effect=lambda _id: nullcontext()))
                stack.enter_context(mock.patch.object(controller, 'cancelled', return_value=False))
                stack.enter_context(mock.patch.object(storage, 'locked', side_effect=nullcontext))
                stack.enter_context(mock.patch.object(storage, 'prepare', side_effect=lambda spec: make().prepare(spec)))
                stack.enter_context(mock.patch.object(controller.sys, 'argv', ['controller', 'prepare']))
                stack.enter_context(mock.patch.object(controller.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode()))))
                output = io.StringIO(); stack.enter_context(mock.patch.object(controller.sys, 'stdout', output))
                self.assertEqual(controller.entrypoint(), 1)
                frame = json.loads(output.getvalue())
                self.assertEqual(frame['error']['code'], code); self.assertEqual(frame['error']['changed'], changed)
                self.assertNotIn('recoverable', frame); self.assertNotIn(str(root), frame['error']['message'])
                self.assertEqual((folder / 'root/workspace/main.js').read_bytes(), b'baseline')
                if stage == 'preflight': self.assertEqual(make().file.read_bytes(), previous)
                else:
                    record = make()._read()['records'][key]
                    self.assertEqual(record['syncPending'], request['operationId'])
                    self.assertEqual(record['sourceManifestId'], previous_record['sourceManifestId'])
                    self.assertEqual(record['sourceManifestSizes'], [8]); self.assertEqual(record['syncTargetManifestSizes'], [16])
                    self.assertEqual(record['dirty'], stage != 'storage-after-partial')
                    if stage in ('volume-partial', 'storage-after-partial'):
                        self.assertEqual((folder / ('root/sync-' + request['operationId']) / 'upload').read_bytes(), b'new')


if __name__ == '__main__':
    unittest.main()
