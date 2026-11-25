"""Check desktop ONNX policy against original PyTorch, including exact token history."""
import json
import hashlib
from pathlib import Path
import random
import sys
import time
import chess
import numpy as np
import onnxruntime as ort
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import desktop_opponent as desktop
from maia3.uci import parse_args, Maia3UCIEngine

torch.set_num_threads(2)
config = json.loads((ROOT / "vendor/maia-model/desktop-config.json").read_text())
desktop.vocabulary = {move: i for i, move in enumerate(config["moves"])}
cfg = parse_args(["--model", "maia3-5m", "--checkpoint-path", str(ROOT / "vendor/maia-model/maia3-5m.pt"), "--device", "cpu", "--no-use-amp", "--use-uci-history"])
engine = Maia3UCIEngine(cfg)
engine.ensure_model_loaded()
options = ort.SessionOptions()
options.intra_op_num_threads = 2
options.inter_op_num_threads = 1
session = ort.InferenceSession(str(ROOT / "vendor/maia-model/maia3-5m.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
rng = random.Random(5731)
positions = []
for game in range(8):
    board = chess.Board()
    moves = []
    for ply in range(60):
        if board.is_game_over(): break
        if ply % 5 == game % 5:
            positions.append({"fen": board.fen(), "moves": moves.copy(), "rating": rng.choice([400, 800, 1200, 1800, 2400]), "player_rating": rng.choice([600, 1400, 2000])})
        move = rng.choice(list(board.legal_moves))
        board.push(move)
        moves.append(move.uci())
for fen in ["8/P7/6k1/8/8/8/6Kp/8 w - - 0 1", "8/P7/6k1/8/8/8/6Kp/8 b - - 0 1", "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1"]:
    positions.append({"fen": fen, "moves": [], "rating": 1500})
reference = []
maximum = 0
started = time.monotonic()
for request in positions:
    board = chess.Board()
    for move in request["moves"]: board.push_uci(move)
    if board.fen() == chess.Board(request["fen"]).fen():
        engine.cmd_position("position startpos moves " + " ".join(request["moves"]))
    else:
        engine.cmd_position("position fen " + request["fen"])
    board, tokens = desktop.position(request, config)
    np.testing.assert_array_equal(tokens, engine._tokens_from_history(engine.history).unsqueeze(0).numpy())
    with torch.no_grad():
        logits = engine.model(torch.from_numpy(tokens), torch.tensor([request["rating"]]), torch.tensor([request.get("player_rating", request["rating"])]))[0][0]
    # Compare probabilities for every legal move, including promotions/Black mirroring.
    from maia3.dataset import get_legal_moves_mask
    mask = get_legal_moves_mask(board, engine.all_moves_dict)
    expected = torch.softmax(logits.masked_fill(~mask, float('-inf')), dim=-1).numpy()
    reference.append({"request": request, "tokens_sha256": hashlib.sha256(tokens.tobytes()).hexdigest(), "policy": expected.tolist()})
    actual = session.run(["policy"], {"tokens":tokens, "self_elo":np.array([request["rating"]],dtype=np.int64), "opponent_elo":np.array([request.get("player_rating",request["rating"])],dtype=np.int64)})[0][0]
    actual[~mask.numpy()] = -np.inf
    probabilities = np.exp(actual - actual.max())
    probabilities /= probabilities.sum()
    difference = float(np.max(np.abs(expected - probabilities)))
    maximum = max(maximum, difference)
    assert difference < 0.00002, (request, difference)
    candidates = desktop.policy(session, request, config)
    for candidate in candidates:
        assert chess.Move.from_uci(candidate["uci"]) in board.legal_moves
    assert candidates[0]["uci"] == engine._move_from_index(int(np.argmax(expected))).uci()
print(f"PASS: {len(positions)} positions, exact history tokens, all legal probabilities match within {maximum:.8f}; {time.monotonic()-started:.1f}s")

with (ROOT / "vendor/maia-model/maia3-5m.onnx").open("rb") as model:
    checksum = hashlib.file_digest(model, "sha256").hexdigest()
(ROOT / "vendor/maia-model/desktop-policy-reference.json").write_text(json.dumps({"model_sha256": checksum, "positions": reference}))
