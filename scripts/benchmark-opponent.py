#!/usr/bin/env python3
"""Time the installed Maia worker's cold first request and warm inference."""
import json
from pathlib import Path
import subprocess
import time

root = Path(__file__).resolve().parents[1]
started = time.perf_counter()
worker = subprocess.Popen([str(root / 'vendor/maia-env/bin/python'), '-u', str(root / 'scripts/opponent.py')], cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
request = {'fen': 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', 'moves': ['e2e4'], 'rating': 1000, 'player_rating': 900}
rows = []
try:
    for i in range(2):
        if i:
            started = time.perf_counter()
        worker.stdin.write(json.dumps(request) + '\n')
        worker.stdin.flush()
        while True:
            line = worker.stdout.readline()
            if not line:
                raise RuntimeError('Maia worker exited')
            try:
                response = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
        if 'error' in response:
            raise RuntimeError(response['error'])
        rows.append({'mode': 'cold' if i == 0 else 'warm', 'wall_ms': round((time.perf_counter() - started) * 1000), 'inference_ms': response['inference_ms']})
    (root / 'reports/opponent-inference.json').write_text(json.dumps(rows, indent=2) + '\n')
    print(json.dumps(rows))
finally:
    worker.terminate()
    worker.wait(timeout=10)
