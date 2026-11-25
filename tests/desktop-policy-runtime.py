"""Verify the portable model on each target without depending on PyTorch."""
import hashlib
import json
from pathlib import Path
import sys
import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import desktop_opponent as desktop

directory = ROOT / "vendor/maia-model"
reference = json.loads((directory / "desktop-policy-reference.json").read_text())
with (directory / "maia3-5m.onnx").open("rb") as model:
    assert hashlib.file_digest(model, "sha256").hexdigest() == reference["model_sha256"], "Unverified model artifact"
config = json.loads((directory / "desktop-config.json").read_text())
desktop.vocabulary = {move: i for i, move in enumerate(config["moves"])}
options = ort.SessionOptions()
options.intra_op_num_threads = 2
options.inter_op_num_threads = 1
session = ort.InferenceSession(str(directory / "maia3-5m.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
maximum = 0
for case in reference["positions"]:
    request = case["request"]
    board, tokens = desktop.position(request, config)
    assert hashlib.sha256(tokens.tobytes()).hexdigest() == case["tokens_sha256"], "History token mismatch"
    candidates = desktop.policy(session, request, config)
    expected = np.asarray(case["policy"])
    assert len(candidates) == min(12, len(list(board.legal_moves)))
    for candidate in candidates:
        move = candidate["uci"]
        if not board.turn:
            move = move[0] + str(9-int(move[1])) + move[2] + str(9-int(move[3])) + move[4:]
        difference = abs(candidate["probability"] - expected[desktop.vocabulary[move]])
        maximum = max(maximum, difference)
        assert difference < .00002, (request, candidate, difference)
assert len(reference["positions"]) >= 99
print(f"PASS: portable ONNX checksum and {len(reference['positions'])} reference positions; max probability error {maximum:.8f}")
