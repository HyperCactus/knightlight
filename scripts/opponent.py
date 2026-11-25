# SPDX-License-Identifier: AGPL-3.0-or-later
# Maia-3 integration; see NOTICE and licenses/AGPL-3.0.txt.
"""Persistent local Maia-3 inference. Chess Study samples its human move policy."""
import json
import os
import pathlib
import sys
import time
import secrets
import torch
import chess

torch.set_num_threads(2)
torch.set_num_interop_threads(1)
from maia3.uci import Maia3UCIEngine, parse_args

cfg = parse_args(["--model", "maia3-5m", "--checkpoint-path", str(pathlib.Path(os.environ.get("KNIGHTLIGHT_RESOURCES", ".")) / "vendor/maia-model/maia3-5m.pt"),
                  "--device", "cpu", "--no-use-amp", "--use-uci-history", "--multipv", "12"])
torch.manual_seed(secrets.randbits(32))
engine = Maia3UCIEngine(cfg)
engine.ensure_model_loaded()
for line in sys.stdin:
    try:
        request = json.loads(line)
        started = time.perf_counter()
        board = chess.Board()
        for move in request.get("moves", []):
            board.push_uci(move)
        expected = chess.Board(request["fen"])
        if board.fen() == expected.fen():
            engine.cmd_position("position startpos moves " + " ".join(request.get("moves", [])))
        else:
            engine.cmd_position("position fen " + expected.fen())
        engine.self_elo = int(request["rating"])
        engine.oppo_elo = int(request.get("player_rating", request["rating"]))
        _, candidates = engine.score_moves()
        print(json.dumps({"candidates": [{"uci": c["move"].uci(), "probability": c["policy"]}
                                         for c in candidates],
                          "inference_ms": round((time.perf_counter() - started) * 1000)}), flush=True)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), flush=True)
