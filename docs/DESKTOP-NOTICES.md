# Offline desktop components

Knightlight bundles Stockfish, Kokoro/ONNX Runtime, Piper, Maia-3, and a shared frozen Python runtime as separate local processes. It sends no game or voice text to a cloud service.

- **Stockfish 16**: GPL-3.0. Official source: https://github.com/official-stockfish/Stockfish/tree/sf_16 . Clean desktop builds compile this source and place `stockfish-source.tar.gz` beside installers. When supplying a different `STOCKFISH`, distribute its matching complete source and license too.
- **Maia-3**: AGPL-3.0. Upstream code, license, and the worker adapters are in `notices/worker-source.tar.gz`. https://github.com/CSSLab/maia3 (revision `1e13597c42d4858b7cfd7cfdae01e297263364b2`). The model card accompanies the weights.
- **Kokoro**: retain the upstream Apache-2.0 license, model cards, and `vendor/KOKORO-NOTICE.md`; these accompany the unchanged quantized ONNX model and selected voices.
- **Piper**: GPL-3.0-or-later; package metadata and corresponding source accompany public releases. The optional Lessac weights are excluded from public release installers because their model card refers to restricted dataset terms. Local builds retain an existing copy and its `MODEL_CARD`. https://github.com/OHF-Voice/piper1-gpl
- **ONNX Runtime**, **NumPy**, **Python**, and other worker dependencies: frozen worker folders retain the packages' collected data/license metadata. Build environments can list exact dependencies with `python -m pip freeze`; use their upstream licenses when redistributing.
- **Lichess puzzles**: CC0. https://database.lichess.org/#puzzles . Opening names: https://github.com/lichess-org/chess-openings (CC0).

Before publishing a release, retain these notices, supply matching Stockfish sources alongside it, and review the licenses of all bundled dependencies. Personal history, cached audio, and settings are excluded by the packaging allowlist.

Original Knightlight source is Apache 2.0; the combined Rust binary links GPL-3.0-or-later libraries and is redistributed under GPL-3.0-or-later. See the root NOTICE and installed notices. `copyleft-component-sources-<platform>.tar.gz` in each release contains matching shakmaty, pgn-reader, python-chess, Piper, phonemizer and both pinned eSpeak source trees (including the loader build scripts). Maia code and adapters are also included inside the installed worker-source archive. Other permissive package license metadata is installed alongside the runtime.

Linux AppImages also retain native library notices under `usr/share/doc/`. The release asset `linux-toolkit-sources.tar.gz` supplies the matching Ubuntu source descriptors, original archives and distribution patches for those bundled GTK/WebKit, GStreamer and other shared libraries. `SOURCE-INDEX.json` identifies binary library owners and exact source versions.
