#!/usr/bin/env python3
"""Exercise the candidate worker sandbox on a disposable GitHub-hosted runner only.

This uses a harmless Python probe, not FFmpeg or the worker. No resource exhaustion.
The candidate's identity, paths and command are replaced with disposable equivalents.
Absent InaccessiblePaths are tolerated; existing paths keep the same restriction.
"""
import configparser
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import uuid


def run(*args, check=True):
    return subprocess.run(args, check=check, text=True, capture_output=True, timeout=20)


def require(value, message):
    if not value:
        raise RuntimeError(message)


def probe():
    marker = Path('/tmp/migecast-isolation-marker')
    previous_marker = marker.exists()
    marker.write_text('disposable probe')
    try:
        Path(__file__).with_name('must-remain-read-only').write_text('probe')
        read_only = False
    except OSError as error:
        import errno
        read_only = error.errno == errno.EROFS
    mount = next(line.split() for line in Path('/proc/self/mountinfo').read_text().splitlines()
                 if line.split()[4] == '/tmp')
    stat = os.statvfs('/tmp')
    child = os.fork()
    if child == 0:
        while True:
            time.sleep(1)
    print('MIGE_PROBE ' + json.dumps({
        'pid': os.getpid(), 'child': child, 'old_marker': previous_marker,
        'read_only': read_only, 'tmp_bytes': stat.f_blocks * stat.f_frsize,
        'tmp_type': mount[mount.index('-') + 1], 'tmp_options': mount[5].split(','),
    }), flush=True)
    while True:
        time.sleep(1)


def main():
    require(sys.platform == 'linux' and os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and os.environ.get('RUNNER_OS') == 'Linux',
            'Refusing execution outside a disposable GitHub-hosted Linux Actions runner')
    require(Path('/run/systemd/system').is_dir() and Path('/sys/fs/cgroup/cgroup.controllers').is_file(),
            'systemd and cgroup v2 are required')
    unit_config = configparser.ConfigParser(interpolation=None, strict=False)
    unit_config.optionxform = str
    unit_config.read(Path(__file__).resolve().parents[1] / 'deploy/systemd/migecast-worker.service')
    service = dict(unit_config['Service'])
    # Every other Service directive is copied, so new hardening is exercised by default.
    replaced = {'Type', 'User', 'Group', 'WorkingDirectory', 'EnvironmentFile', 'Environment',
                'ExecStartPre', 'ExecStart', 'StandardOutput', 'StandardError'}
    props = {key: value for key, value in service.items() if key not in replaced}
    props['InaccessiblePaths'] = ' '.join('-' + path.lstrip('-') for path in props['InaccessiblePaths'].split())
    unit = 'migecast-isolation-' + uuid.uuid4().hex + '.service'
    directory = Path(run('sudo', '-n', 'mktemp', '-d', '/opt/migecast-isolation.XXXXXXXX').stdout.strip())
    require(directory.parent == Path('/opt') and directory.name.startswith('migecast-isolation.'), 'Invalid temp directory')

    def show(key):
        return run('sudo', '-n', 'systemctl', 'show', unit, '--property=' + key, '--value').stdout.strip()

    def reports(count):
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            journal = run('sudo', '-n', 'journalctl', '--unit=' + unit, '--no-pager', '--output=cat', '--lines=50').stdout
            entries = [json.loads(line.removeprefix('MIGE_PROBE ')) for line in journal.splitlines()
                       if line.startswith('MIGE_PROBE ')]
            if len(entries) >= count:
                return entries
            time.sleep(.25)
        raise RuntimeError('Timed out waiting for sandbox probe; service state=' + show('ActiveState'))

    def bytes_value(value):
        return int(value[:-1]) * {'K': 1024, 'M': 1024**2, 'G': 1024**3}[value[-1]] if value[-1].isalpha() else int(value)

    def assert_probe(report):
        require(report['read_only'], 'Application directory is not a read-only mount')
        require(not report['old_marker'], 'Private /tmp marker survived a fresh service start')
        options = props['TemporaryFileSystem'].split(':', 1)[1].split(',')
        size = next(option.split('=', 1)[1] for option in options if option.startswith('size='))
        require(report['tmp_type'] == 'tmpfs' and report['tmp_bytes'] == bytes_value(size), 'Wrong private tmpfs type/size')
        require({'noexec', 'nosuid', 'nodev'} <= set(report['tmp_options']), 'Missing tmpfs mount protections')

    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        # Ownership ensures EROFS, not ordinary DAC permissions, explains the denied write.
        run('sudo', '-n', 'chown', f'{os.getuid()}:{os.getgid()}', str(directory))
        shutil.copyfile(__file__, directory / 'probe.py')
        args = ['sudo', '-n', 'systemd-run', '--unit=' + unit, '--service-type=simple',
                '--property=User=' + str(os.getuid()), '--property=Group=' + str(os.getgid()),
                '--property=WorkingDirectory=' + str(directory), '--property=StandardOutput=journal']
        args += ['--property=' + key + '=' + value for key, value in props.items()]
        args += ['/usr/bin/python3', str(directory / 'probe.py'), '--probe']
        run(*args)
        first = reports(1)[0]
        assert_probe(first)
        group = Path('/sys/fs/cgroup') / show('ControlGroup').lstrip('/')
        quota, period = (int(value) for value in (group / 'cpu.max').read_text().split())
        require(abs(quota / period - float(props['CPUQuota'].rstrip('%')) / 100) < .001, 'CPU cgroup quota mismatch')
        for key, filename in [('MemoryHigh', 'memory.high'), ('MemoryMax', 'memory.max'),
                              ('MemorySwapMax', 'memory.swap.max'), ('TasksMax', 'pids.max')]:
            require(int((group / filename).read_text().strip()) == bytes_value(props[key]), key + ' cgroup mismatch')
        run('sudo', '-n', 'systemctl', 'kill', '--kill-who=main', '--signal=SIGKILL', unit)
        second = reports(2)[1]
        assert_probe(second)
        require(first['pid'] != second['pid'] and int(show('NRestarts')) >= 1, 'Service did not restart after crash')
        child_deadline = time.monotonic() + 5
        while Path('/proc/' + str(first['child'])).exists() and time.monotonic() < child_deadline:
            time.sleep(.1)
        require(not Path('/proc/' + str(first['child'])).exists(), 'Child survived main-process crash')
        run('sudo', '-n', 'systemctl', 'stop', unit)
        deadline = time.monotonic() + 5
        while group.exists() and time.monotonic() < deadline:
            time.sleep(.1)
        require(not group.exists(), 'Service cgroup survived stop')
        require(not Path('/proc/' + str(second['child'])).exists(), 'Child survived service stop')
        print('PASS: candidate cgroup CPU/memory/swap/pids values, private bounded tmpfs, read-only app path, crash restart and child/cgroup cleanup')
        print('Scope: harmless probe on GitHub-hosted Linux; not worker/FFmpeg load or production-host acceptance')
    finally:
        run('sudo', '-n', 'systemctl', 'stop', unit, check=False)
        run('sudo', '-n', 'systemctl', 'reset-failed', unit, check=False)
        # Only probe-owned files are removed, then the exact empty directory.
        # /opt itself requires root even though the probe directory belongs to us.
        for name in ('probe.py', 'must-remain-read-only'):
            (directory / name).unlink(missing_ok=True)
        run('sudo', '-n', 'rmdir', '--', str(directory))


if __name__ == '__main__':
    if sys.argv[1:] == ['--probe']:
        probe()
    else:
        try:
            main()
        except Exception as error:
            # Do not print subprocess output, environment, or journal contents.
            print('FAIL: ' + str(error), file=sys.stderr)
            sys.exit(1)
