"""Isolated backend protocol, durable profile, stable port, and clean parent shutdown."""
import argparse
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', type=Path, default=ROOT / 'src-tauri/target/release' / ('knightlight-desktop.exe' if os.name == 'nt' else 'knightlight-desktop'))
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='knightlight-child-') as directory:
    profile = Path(directory) / 'profile'
    ports = []
    for iteration in range(2):
        env = {**os.environ, 'KNIGHTLIGHT_PROFILE': str(profile), 'KNIGHTLIGHT_RESOURCES': str(ROOT / 'src-tauri/resources')}
        with (Path(directory) / 'stderr.log').open('w+') as stderr:
            child = subprocess.Popen([str(args.binary.resolve()), '--knightlight-backend'], env=env,
                                     cwd=directory, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True)
            try:
                lines = queue.Queue()
                def read(stream=child.stdout, messages=lines):
                    for line in stream: messages.put(line)
                threading.Thread(target=read, daemon=True).start()
                first = lines.get(timeout=30).strip()
                assert first.startswith('KNIGHTLIGHT_BACKEND_PORT='), first
                port = int(first.split('=')[1])
                ports.append(port)
                base = f'http://127.0.0.1:{port}'
                for attempt in range(100):
                    try:
                        with urllib.request.urlopen(base + '/api/data', timeout=2) as response: data = json.load(response)
                        break
                    except (OSError, TimeoutError):
                        assert child.poll() is None
                        time.sleep(.1)
                else: raise AssertionError('Backend never became ready')
                assert data['games'] == [], 'Disposable profile only'
                if iteration == 0:
                    payload = json.dumps({'updated_at': 2000, 'values': {'theme': 'light', 'voice': True}}).encode()
                    request = urllib.request.Request(base + '/api/preferences', data=payload, method='PUT',
                                                     headers={'Content-Type': 'application/json', 'Origin': base})
                    with urllib.request.urlopen(request, timeout=5) as response: assert response.status == 200
                else:
                    with urllib.request.urlopen(base + '/api/preferences', timeout=5) as response: prefs = json.load(response)
                    assert prefs['values']['theme'] == 'light'
                if iteration == 0: child.stdin.write('quit\n'); child.stdin.flush()
                else: child.stdin.close()  # Parent crash/EOF follows the same safe shutdown path.
                assert child.wait(timeout=10) == 0
                with socket.socket() as probe:
                    assert probe.connect_ex(('127.0.0.1', port)) != 0, 'Backend leaked after parent shutdown'
            finally:
                if child.poll() is None: child.kill(); child.wait()
    assert ports[0] == ports[1], ports
print('PASS backend handshake, stable origin, profile persistence, explicit quit and parent-EOF shutdown; no GUI/audio')
