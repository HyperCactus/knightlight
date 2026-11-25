# Speech latency investigation

Measured on this machine (Ryzen 5 3600, RTX 2060 SUPER, Linux), using the **existing quantized Kokoro ONNX model and af_heart embedding**. No model conversion, replacement or voice change. The model and embedding file fingerprints are recorded in [speech-model-fingerprint.json](speech-model-fingerprint.json). Measurements synthesize files and inspect playback state in Chromium launched with `--mute-audio`; nothing is played through host speakers.

## Before and after

The old worker took **2,642 ms** from a fresh worker request to a ready `Your move.` clip (imports, lazy model load and first inference included). A previously unseen 19-word, two-sentence sample took **2,611 ms** even after the model had loaded. It also waited for all audio before playback, and plain narration added a fixed 180 ms delay. Visual lessons waited for board setup before even requesting speech.

Latest isolated end-to-end measurements are in [speech-latency.json](speech-latency.json). The recorded run measured:

| Path | Time |
| --- | ---: |
| New short sentence, request to Chromium `playing` | 941 ms |
| Prepared contextual sentence, request to `playing` | 46 ms |
| Warmed common phrase, request to `playing` | 48 ms |
| Existing cache hit while unrelated inference is running | 1 ms API response |
| New full two-sentence sample, four CPU threads | 1,897 ms synthesis API response |
| Just that sample's first sentence | 892 ms synthesis API response |
| Application startup through warm-up in disposable workspace | 1,421 ms |

Repeated isolated checks measured about 622–941 ms for the new short sentence and 7–48 ms for prepared/common text. These are samples, not guarantees or identical inputs for every row. The browser figures measure the `playing` event, not physical speaker output. Fresh custom explanations still require inference and may take longer under engine/system load. Model warm-up runs at startup, so opening the app and immediately requesting novel speech can still overlap that initial work. Prepared and repeated text can start almost immediately once its diagram is ready.

Raw old-worker measurements: [speech-baseline.json](speech-baseline.json). CPU/GPU experiment: [speech-inference-comparison.json](speech-inference-comparison.json).

## Methods tested

Using the same three texts and two passes per worker, warm inference for the longer two-sentence sample was approximately:

- One CPU thread: 4,592 ms.
- Existing two-thread worker: 2,611 ms (uncached worker result).
- Four CPU threads: 1,742–1,956 ms.
- Six CPU threads: 1,942–2,052 ms.
- CUDA provider with CPU fallback, two CPU threads: 7,050–7,338 ms, with an additional cold first-inference cost. The session actually reported `CUDAExecutionProvider`; this was not a mislabeled CPU fallback.

CUDA was tested with onnxruntime-gpu 1.23.2, CUDA runtime 12.8, cuBLAS 12.8 and cuDNN 9.10 in a separate package directory. The production speech environment remains CPU-only. The current quantized graph did not benefit from GPU execution, so the slower provider was **not enabled**. [ONNX Runtime's CUDA documentation](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html) documents runtime compatibility and explicit library preloading. Provider availability alone does not prove a speedup; the real graph was timed.

To repeat CPU comparisons, use:

```bash
vendor/speech-env/bin/python scripts/benchmark-speech.py --threads 4
```

For the optional isolated GPU experiment, install the same pinned runtime packages into a temporary target directory using the speech interpreter, prepend that directory to `PYTHONPATH`, then add `--gpu`. The benchmark rejects a silently missing CUDA provider. No GPU package is injected into the actual app worker.

## Implemented

- Four CPU inference threads, one inter-op thread. Model, embeddings, synthesis speed and notation expansion stay the same.
- Background startup preheat in the saved selected voice, including neural inference and the common `Your move.` clip. The same on-disk cache survives launches.
- Rust computes the existing Python-compatible SHA-256 cache key. Cached WAVs bypass the worker lock, so an immediate response does not wait behind another explanation. Both paths normalize whitespace. Clips are still written atomically.
- Retain up to 512 clips, trimming to 448 when necessary, rather than 256/224. Cache hits refresh recency. Typical actual lesson sentences accumulate naturally; the app does not manufacture filler speech to hide a delay.
- Start on a complete first sentence or natural clause and synthesize the rest during playback. The same audio element carries the selected volume/speed across clips, and only the final clip completes the visual step.
- Begin the current lesson's synthesis while its diagram is prepared. Prefetch likely next lessons during review reading pauses and bot/puzzle animations, and the next step while the current step speaks.
- Speculative synthesis yields when the worker is busy and retries briefly only while its context remains valid. Demand requests are not rejected just because startup warm-up is in progress.
- Remove the 180 ms plain-speech delay. Preserve autoplay policy handling, mute, pause/resume, cancellation and matching board cues. Sentence boundaries do not advance the review prematurely.

`npm run test:speech-latency` checks real synthesis, warmed/cache paths, serving a cache hit while synthesis is busy, speculative yielding, actual first-playing time, sentence ordering, boundary pause/resume and final-only completion in a disposable workspace. Existing experience/review/frontend regression suites cover local voices, settings, coaching interruption and synchronized diagrams.
