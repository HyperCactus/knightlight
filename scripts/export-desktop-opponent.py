# SPDX-License-Identifier: AGPL-3.0-or-later
# Maia-3 integration; see NOTICE and licenses/AGPL-3.0.txt.
"""Export unchanged Maia policy weights to the same ONNX runtime used by speech."""
import json
import hashlib
from pathlib import Path
import numpy as np
import torch
from maia3.uci import parse_args, load_model
from maia3.utils import get_all_possible_moves

torch.set_num_threads(2)
torch.backends.mha.set_fastpath_enabled(False)
root = Path(__file__).resolve().parents[1]
directory = root / "vendor/maia-model"
cfg = parse_args(["--model", "maia3-5m", "--checkpoint-path", str(directory / "maia3-5m.pt"), "--device", "cpu", "--no-use-amp", "--use-uci-history"])
model = load_model(cfg)

class ExportRMSNorm(torch.nn.Module):
    def __init__(self, original):
        super().__init__()
        self.weight = original.weight
        self.eps = original.eps
        self.dimensions = tuple(range(-len(original.normalized_shape), 0))

    def forward(self, x):
        eps = self.eps if self.eps is not None else torch.finfo(x.dtype).eps
        return x * torch.rsqrt(x.square().mean(self.dimensions, keepdim=True) + eps) * self.weight

def export_norms(module):
    for name, child in module.named_children():
        if isinstance(child, torch.nn.RMSNorm):
            setattr(module, name, ExportRMSNorm(child))
        else:
            export_norms(child)

export_norms(model)
path = directory / "maia3-5m.onnx"
with (directory / "maia3-5m.pt").open("rb") as checkpoint:
    signature = hashlib.sha256(Path(__file__).read_bytes() + hashlib.file_digest(checkpoint, "sha256").digest() + torch.__version__.encode()).hexdigest()
config_path = directory / "desktop-config.json"
previous = json.loads(config_path.read_text()) if config_path.exists() else {}
if not path.exists() or previous.get("export_signature") != signature:
    # Fixed batch size one: runtime policy inference never needs the unused WDL
    # candidate batch. No quantization, retraining, or policy changes.
    tokens = torch.zeros(1, 64, cfg.history * 12 + (4 if cfg.include_time_info else 1))
    rating = torch.tensor([1200], dtype=torch.int64)
    temporary = path.with_suffix(".tmp.onnx")
    torch.onnx.export(model, (tokens, rating, rating), str(temporary),
                      input_names=["tokens", "self_elo", "opponent_elo"],
                      output_names=["policy", "value", "ponder"], opset_version=17, dynamo=False)
    temporary.replace(path)
config_path.write_text(json.dumps({"history": cfg.history, "include_time_info": cfg.include_time_info, "moves": get_all_possible_moves(), "export_signature": signature}))
print(f"Exported unchanged Maia weights: {path.stat().st_size / 1024**2:.1f} MiB")
