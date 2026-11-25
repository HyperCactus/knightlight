#!/usr/bin/env python3
"""Generate public opening policies with the installed, unchanged Maia model.

Only standard opening positions are sent to the worker. No user games are read.
"""
import json
import pathlib
import subprocess
import time
import chess

ROOT = pathlib.Path(__file__).resolve().parents[1]
ratings = [400, 800, 1200, 1600, 2000, 2400]
positions = {chess.STARTING_FEN: []}
start = chess.Board()
for move in start.legal_moves:
    board = start.copy()
    board.push(move)
    positions[board.fen(en_passant='legal')] = [move.uci()]
# Popular second-turn positions buy more startup time when a game opens fast.
for line in [
    'e2e4 e7e5 g1f3', 'e2e4 c7c5 g1f3', 'e2e4 e7e6 d2d4',
    'e2e4 c7c6 d2d4', 'd2d4 d7d5 c2c4', 'd2d4 g8f6 c2c4',
    'c2c4 e7e5 b1c3', 'g1f3 d7d5 d2d4', 'e2e4 e7e5 f1c4',
    'd2d4 d7d5 g1f3', 'e2e4 e7e5 b1c3', 'e2e4 e7e5 d1h5',
]:
    board = chess.Board()
    moves = line.split()
    for uci in moves:
        board.push_uci(uci)
    positions[board.fen(en_passant='legal')] = moves

worker = subprocess.Popen([str(ROOT / 'vendor/maia-env/bin/python'), '-u', str(ROOT / 'scripts/opponent.py')], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
rows = []
started = time.perf_counter()
try:
    for fen, moves in positions.items():
        for rating in ratings:
            payload = {'fen': fen, 'moves': moves, 'rating': rating, 'player_rating': max(400, rating - 100)}
            worker.stdin.write(json.dumps(payload) + '\n')
            worker.stdin.flush()
            while True:
                line = worker.stdout.readline()
                if not line:
                    raise RuntimeError('Maia worker exited before policy generation completed')
                try:
                    policy = json.loads(line)
                    break
                except json.JSONDecodeError:
                    continue
            if 'error' in policy:
                raise RuntimeError(policy['error'])
            board = chess.Board(fen)
            candidates = [c for c in policy['candidates'] if chess.Move.from_uci(c['uci']) in board.legal_moves and c['probability'] > 0]
            if not candidates:
                raise RuntimeError('No legal opening candidates')
            rows.append({'fen': fen, 'rating': rating, 'candidates': candidates})
    out = {'version': 1, 'model': 'maia3-5m', 'positions': rows}
    destination = ROOT / 'data/bot-openings.json'
    destination.write_text(json.dumps(out, separators=(',', ':')) + '\n')
    print(json.dumps({'positions': len(positions), 'policies': len(rows), 'seconds': round(time.perf_counter() - started, 2), 'bytes': destination.stat().st_size}))
finally:
    worker.terminate()
    worker.wait(timeout=10)
