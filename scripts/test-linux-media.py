#!/usr/bin/env python3
"""Bounded real-media soak/crash test, exclusively on disposable Linux CI.

Uses a development-only loopback fixture exception; all candidate sandbox/resource
properties are retained. This is not real-provider or production-host acceptance.
"""
import configparser
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid


def run(*args, check=True, timeout=30):
    return subprocess.run(args, check=check, text=True, capture_output=True, timeout=timeout)


def require(value, message):
    if not value:
        raise RuntimeError(message)


def main():
    require(sys.platform == 'linux' and os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and os.environ.get('RUNNER_OS') == 'Linux',
            'Refusing execution outside a disposable GitHub-hosted Linux Actions runner')
    require(len(sys.argv) == 2, 'Expected one verified release directory')
    bundle = Path(sys.argv[1]).resolve()
    require((bundle / 'worker/dist/worker/main.js').is_file(), 'Missing packaged worker')
    require(Path('/sys/fs/cgroup/cgroup.controllers').is_file(), 'cgroup v2 required')
    directory = Path(run('sudo', '-n', 'mktemp', '-d', '/opt/migecast-media.XXXXXXXX').stdout.strip())
    require(directory.parent == Path('/opt') and directory.name.startswith('migecast-media.'), 'Invalid owned directory')
    unit = 'migecast-media-' + uuid.uuid4().hex + '.service'
    server = None
    secret = uuid.uuid4().hex + uuid.uuid4().hex
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    base = f'http://127.0.0.1:{port}'

    def show(key):
        return run('sudo', '-n', 'systemctl', 'show', unit, '--property=' + key, '--value').stdout.strip()

    def request(path, method='GET', data=None):
        body = None if data is None else json.dumps(data).encode()
        req = urllib.request.Request(base + path, data=body, method=method,
                                     headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.read()

    def health_after(old_pid=None):
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            try:
                pid = int(show('MainPID'))
                if pid and pid != old_pid and json.loads(request('/health'))['ready']:
                    return pid
            except (OSError, ValueError, urllib.error.URLError):
                pass
            time.sleep(.25)
        raise RuntimeError('Worker did not become healthy')

    def tmp_roots(pid):
        return set(run('sudo', '-n', 'nsenter', '--target', str(pid), '--mount', '--',
                       'find', '/tmp', '-mindepth', '1', '-maxdepth', '1', '-name',
                       'migecast-worker-*', '-type', 'd').stdout.splitlines())

    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        run('sudo', '-n', 'chown', f'{os.getuid()}:{os.getgid()}', str(directory))
        shutil.copytree(bundle / 'worker', directory / 'worker', symlinks=True)
        # The verified bundle has self-contained dependencies; the sandbox hides home.
        node = shutil.which('node')
        require(node is not None, 'Node unavailable')
        shutil.copyfile(Path(node).resolve(), directory / 'node')
        (directory / 'node').chmod(0o755)
        fixture = directory / 'fixture.mkv'
        run('ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
            '-t', '150', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2',
            '-pix_fmt', 'yuv420p', '-g', '50', '-c:a', 'ac3', '-b:a', '128k', str(fixture), timeout=90)
        content = fixture.read_bytes()

        class Provider(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                if self.path != '/fixture.mkv':
                    self.send_error(404)
                    return
                start, end = 0, len(content) - 1
                value = self.headers.get('Range')
                if value:
                    match = re.fullmatch(r'bytes=(\d+)-(\d*)', value)
                    if not match:
                        self.send_error(416)
                        return
                    start = int(match[1])
                    end = min(int(match[2]) if match[2] else end, end)
                    if start > end:
                        self.send_error(416)
                        return
                self.send_response(206 if value else 200)
                self.send_header('Content-Type', 'video/x-matroska')
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Content-Length', str(end - start + 1))
                if value:
                    self.send_header('Content-Range', f'bytes {start}-{end}/{len(content)}')
                self.end_headers()
                try:
                    self.wfile.write(content[start:end + 1])
                except (BrokenPipeError, ConnectionResetError):
                    pass

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = f'http://127.0.0.1:{server.server_port}'
        envfile = directory / 'fixture.env'
        envfile.write_text('\n'.join([
            'NODE_ENV=development', 'TMPDIR=/tmp', 'MEDIA_WORKER_REQUIRE_TMPFS=1',
            'MEDIA_WORKER_MAX_JOBS=1', 'MEDIA_ALLOW_VIDEO_TRANSCODE=0',
            f'MEDIA_WORKER_PORT={port}', f'MEDIA_WORKER_SECRET={secret}',
            f'MEDIA_TEST_ORIGIN={origin}', 'FFMPEG_PATH=/usr/bin/ffmpeg',
            'FFPROBE_PATH=/usr/bin/ffprobe', 'PATH=/usr/bin:/bin', '']))
        envfile.chmod(0o600)
        config = configparser.ConfigParser(interpolation=None, strict=False)
        config.optionxform = str
        config.read(Path(__file__).resolve().parents[1] / 'deploy/systemd/migecast-worker.service')
        replaced = {'Type', 'User', 'Group', 'WorkingDirectory', 'EnvironmentFile', 'Environment',
                    'ExecStartPre', 'ExecStart', 'StandardOutput', 'StandardError'}
        props = {key: value for key, value in config['Service'].items() if key not in replaced}
        props['InaccessiblePaths'] = ' '.join('-' + path.lstrip('-') for path in props['InaccessiblePaths'].split())
        args = ['sudo', '-n', 'systemd-run', '--unit=' + unit, '--service-type=simple',
                '--property=User=' + str(os.getuid()), '--property=Group=' + str(os.getgid()),
                '--property=WorkingDirectory=' + str(directory / 'worker'),
                '--property=EnvironmentFile=' + str(envfile), '--property=StandardOutput=null',
                '--property=StandardError=null']
        args += ['--property=' + key + '=' + value for key, value in props.items()]
        args += [str(directory / 'node'), '--max-old-space-size=128',
                 str(directory / 'worker/dist/worker/main.js')]
        run(*args)
        first_pid = health_after()
        group = Path('/sys/fs/cgroup') / show('ControlGroup').lstrip('/')
        def bytes_value(value):
            return int(value[:-1]) * {'K': 1024, 'M': 1024**2, 'G': 1024**3}[value[-1]] if value[-1].isalpha() else int(value)

        for key, filename in [('MemoryHigh', 'memory.high'), ('MemoryMax', 'memory.max'),
                              ('MemorySwapMax', 'memory.swap.max'), ('TasksMax', 'pids.max')]:
            require(int((group / filename).read_text().strip()) == bytes_value(props[key]), key + ' cgroup mismatch')
        quota, period = (int(value) for value in (group / 'cpu.max').read_text().split())
        require(abs(quota / period - float(props['CPUQuota'].rstrip('%')) / 100) < .001, 'CPU quota mismatch')
        first_roots = tmp_roots(first_pid)
        require(len(first_roots) == 1, 'Expected one private worker root')
        job = str(uuid.uuid4())
        started = time.monotonic()
        info = json.loads(request('/jobs', 'POST', {'id': job, 'url': origin + '/fixture.mkv',
                                                 'container': 'matroska', 'live': False, 'offset': 0}))
        startup_ms = round((time.monotonic() - started) * 1000)
        require(info['profile'] == 'remux' and info['duration'] >= 149, 'Unexpected real-media plan')
        peak_memory = peak_tasks = peak_tmp = 0
        segment_names = set()
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            request('/jobs/' + job, 'PATCH')
            manifest = request('/jobs/' + job + '/index.m3u8').decode()
            segments = re.findall(r'^segment-\d{6}\.ts$', manifest, re.M)
            require(segments, 'Missing playable segments')
            segment_names.update(segments)
            require(len(request('/jobs/' + job + '/' + segments[-1])) > 188, 'Empty media segment')
            peak_memory = max(peak_memory, int((group / 'memory.current').read_text()))
            peak_tasks = max(peak_tasks, int((group / 'pids.current').read_text()))
            used = run('sudo', '-n', 'nsenter', '--target', str(first_pid), '--mount', '--',
                       'du', '-sb', '/tmp').stdout.split()[0]
            peak_tmp = max(peak_tmp, int(used))
            require(int(show('MainPID')) == first_pid and show('NRestarts') == '0', 'Worker restarted during soak')
            time.sleep(5)
        require(len(segment_names) >= 25, 'Media did not advance during soak')
        events = dict(line.split() for line in (group / 'memory.events').read_text().splitlines())
        require(int(events['oom']) == 0 and int(events['oom_kill']) == 0, 'Worker exceeded memory budget')
        cpu = dict(line.split() for line in (group / 'cpu.stat').read_text().splitlines())
        children = {int(pid) for pid in (group / 'cgroup.procs').read_text().split()} - {first_pid}
        require(children and any(Path(f'/proc/{pid}/comm').read_text().strip() == 'ffmpeg'
                                 for pid in children), 'No actual FFmpeg child inside worker cgroup')
        run('sudo', '-n', 'systemctl', 'kill', '--kill-who=main', '--signal=SIGKILL', unit)
        second_pid = health_after(first_pid)
        require(json.loads(request('/health'))['jobs'] == 0, 'Crashed jobs survived restart')
        require(first_roots.isdisjoint(tmp_roots(second_pid)), 'Old job storage survived restart')
        require(all(not Path(f'/proc/{pid}').exists() for pid in children), 'FFmpeg child survived crash')
        require(int(show('NRestarts')) >= 1, 'Crash restart not observed')
        run('sudo', '-n', 'systemctl', 'stop', unit)
        require(not Path(f'/proc/{second_pid}').exists(), 'Worker survived stop')
        print('PASS: actual H264/AC3 MKV remux, 90s cgroup soak, progressing HLS segments, crash restart and FFmpeg/private-temp cleanup')
        print(json.dumps({'startup_ms': startup_ms, 'sampled_peak_memory_bytes': peak_memory,
                          'sampled_peak_tasks': peak_tasks, 'sampled_peak_tmp_bytes': peak_tmp,
                          'distinct_segments': len(segment_names), 'cpu_stat': cpu}))
        print('Scope: generated fixture, Ubuntu CI runtimes, development loopback exception; no production capacity or provider claim')
    finally:
        run('sudo', '-n', 'systemctl', 'stop', unit, check=False)
        run('sudo', '-n', 'systemctl', 'reset-failed', unit, check=False)
        if server:
            server.shutdown()
            server.server_close()
        # Exact per-test directory only; never a shared source/release/runtime tree.
        if (directory / 'worker').exists():
            shutil.rmtree(directory / 'worker')
        for name in ('node', 'fixture.mkv', 'fixture.env'):
            (directory / name).unlink(missing_ok=True)
        run('sudo', '-n', 'rmdir', '--', str(directory))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Avoid printing subprocess output, auth headers, environment or journals.
        print('FAIL: ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
