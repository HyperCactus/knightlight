#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
uv venv --python 3.11 --allow-existing vendor/speech-env
uv pip install --python vendor/speech-env/bin/python piper-tts==1.8.0 kokoro-onnx==0.4.9 soundfile==0.13.1
hf download onnx-community/Kokoro-82M-v1.0-ONNX \
  onnx/model_quantized.onnx voices/af_heart.bin voices/am_michael.bin voices/bf_emma.bin README.md \
  --revision 1939ad2a8e416c0acfeecc08a694d14ef25f2231 --local-dir vendor/kokoro
hf download hexgrad/Kokoro-82M LICENSE README.md VOICES.md --local-dir vendor/kokoro/original
hf download rhasspy/piper-voices en/en_US/lessac/medium/en_US-lessac-medium.onnx \
  en/en_US/lessac/medium/en_US-lessac-medium.onnx.json en/en_US/lessac/medium/MODEL_CARD --local-dir vendor/voices
vendor/speech-env/bin/python - <<'PY'
from pathlib import Path
import numpy as np
root = Path('vendor/kokoro')
voices = {p.stem: np.fromfile(p, dtype=np.float32).reshape(-1,1,256) for p in (root/'voices').glob('*.bin')}
np.savez(root/'voices.npz', **voices)
PY
