# SPDX-License-Identifier: AGPL-3.0-or-later
# Maia-3 integration; see NOTICE and licenses/AGPL-3.0.txt.
"""Maia-3 policy inference without shipping PyTorch. Same tokens, history and legal mask."""
from collections import deque
import json
import os
from pathlib import Path
import sys
import time
import chess
import numpy as np
import onnxruntime as ort


def tokenize(board):
    if board.turn == chess.BLACK:
        board = board.mirror()
    tokens = np.zeros((64, 12), dtype=np.float32)
    for square, piece in board.piece_map().items():
        tokens[square, piece.piece_type - 1 + (0 if piece.color else 6)] = 1
    return tokens


def position(request, config):
    board = chess.Board()
    history = deque([tokenize(board)], maxlen=config["history"])
    for uci in request.get("moves", []):
        board.push_uci(uci)
        history.append(tokenize(board))
    expected = chess.Board(request["fen"])
    if board.fen() != expected.fen():
        board = expected
        history = deque([tokenize(board)], maxlen=config["history"])
    padding = [history[0]] * (config["history"] - len(history))
    clock = np.zeros((64, 4 if config["include_time_info"] else 1), dtype=np.float32)
    return board, np.concatenate(padding + list(history) + [clock], axis=1)[None, ...]


def policy(session, request, config):
    board, tokens = position(request, config)
    if board.is_game_over():
        return []
    inputs = {"tokens": tokens, "self_elo": np.array([request["rating"]], dtype=np.int64),
              "opponent_elo": np.array([request.get("player_rating", request["rating"])], dtype=np.int64)}
    logits = session.run(["policy"], inputs)[0][0]
    # Black's policy is mirrored vertically in exactly the upstream vocabulary.
    def index(move):
        if board.turn == chess.BLACK:
            move = chess.Move(chess.square_mirror(move.from_square), chess.square_mirror(move.to_square), promotion=move.promotion)
        return vocabulary[move.uci()]
    legal = list(board.legal_moves)
    scores = np.asarray([logits[index(move)] for move in legal], dtype=np.float32)
    probabilities = np.exp(scores - scores.max())
    probabilities /= probabilities.sum()
    ordered = np.argsort(-probabilities, kind="stable")[:12]
    return [{"uci": legal[i].uci(), "probability": float(probabilities[i])} for i in ordered]


if __name__ == "__main__":
    directory = Path(os.environ["KNIGHTLIGHT_RESOURCES"]) / "vendor/maia-model"
    config = json.loads((directory / "desktop-config.json").read_text())
    vocabulary = {move: i for i, move in enumerate(config["moves"])}
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(directory / "maia3-5m.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
    for line in sys.stdin:
        try:
            request = json.loads(line)
            start = time.perf_counter()
            candidates = policy(session, request, config)
            print(json.dumps({"candidates": candidates, "inference_ms": round((time.perf_counter() - start) * 1000)}), flush=True)
        except Exception as exc:
            print(json.dumps({"error": str(exc)}), flush=True)
