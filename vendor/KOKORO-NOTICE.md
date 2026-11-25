# Kokoro local speech

- Original model: https://huggingface.co/hexgrad/Kokoro-82M (Apache-2.0). Original LICENSE, README and VOICES.md are retained under `kokoro/original/`.
- ONNX model and voice arrays: https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX at revision `1939ad2a8e416c0acfeecc08a694d14ef25f2231` (Apache-2.0). The conversion README is retained in `kokoro/README.md`.
- Installed: `onnx/model_quantized.onnx`, `voices/af_heart.bin`, `voices/am_michael.bin`, `voices/bf_emma.bin`. `voices.npz` contains those unchanged float32 arrays, repackaged for kokoro-onnx.
- Inference: https://github.com/thewh1teagle/kokoro-onnx, version 0.4.9 (MIT). Package metadata/licenses are retained in the installed `vendor/speech-env` environment. The bundled eSpeak NG phonemization dependencies retain their own licenses.
- The app adapts the community export’s float `speed` tensor and waveform shape to this package API in `scripts/speech.py`. No tensor weights were modified.

Use `scripts/setup-voice.sh` to recreate this setup. Inference uses local files and performs no runtime download. The speech worker also retains the previous Piper/ Lessac option.
