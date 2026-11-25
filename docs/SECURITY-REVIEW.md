# Local application security review

Scope: the Rust HTTP endpoints, saved-game and learning files, engine/speech child processes, and the browser's handling of imported text. Reviewed against the local, single-user trust model.

No blocking issue remains in the reviewed paths. The application is not intended to be exposed to a LAN or public internet.

## Evidence

- `local_only` in `src/main.rs` checks Host/Origin and the listener binds to `127.0.0.1`. Studio tests verify foreign Host/Origin rejection.
- FENs and moves are checked by shakmaty before analysis. Live coach, bot, and drill work share a two-permit semaphore. Stockfish output has a 30-second timeout and processes are cleaned up on drop.
- Bot histories are capped at 600 plies, replayed legally, and checked against the supplied position. Rating inputs are bounded to 400–2400. Practice-game paths are fixed and game upserts/result IDs prevent duplicate saves and Elo updates.
- PGN uploads are limited to 128 MB decoded text (256 MB JSON envelope), 100,000 games per file, 600 plies per game, and bounded header counts/values. `pgn-reader` and shakmaty validate whole main lines; invalid games are reported rather than saved as truncated games. Uploads use fixed storage paths and atomic rename. Exports escape header quotes/backslashes/newlines and use fixed attachment filenames; imported names never become paths. Browser tests cover invalid lines, duplicate imports, export round trips, and file controls.
- `src/practice.rs` creates drills only from known library positions. In-memory sessions are bounded to 128, each exercise to three player turns, and response history to 40 entries. Moves require the current revision; request IDs make retries safe. Wrong moves do not advance the board. Hints/reveals cannot earn unaided mastery. File writes use fixed paths and atomic rename.
- `src/opponent.rs` runs a fixed Python script in a fixed environment and communicates by JSON stdin/stdout. A 40-second deadline bounds requests. Model loading uses local weights with Hugging Face offline mode; upstream tensor loading uses `weights_only`. Rust checks returned candidates for legality before selection. The worker has two CPU inference threads.
- Speech voice IDs are allowlisted in Rust and the worker; model paths are fixed. Kokoro uses the pinned community quantized ONNX export, local float32 voice arrays, and a two-thread CPU session. No voice name is used as an arbitrary file path. Preferences are type/range/enum-validated on load and are rendered with DOM text APIs. XP and daily-goal state come from server-recorded completions with per-position/day deduplication; request replay cannot inflate them.
- Speech input is capped and overlapping synthesis requests are rejected. The worker uses content-hashed filenames, a bounded cache, and two CPU threads. Speech text and chess moves never enter a shell command.
- Review playback uses legal cached positions and fixed move metadata. Play/pause and seeking are local UI state. Diagram metadata is generated from validated positions, and explanation text remains text-only. Resignation stores the terminal outcome separately from preview state; a session/request guard rejects stale bot replies after finishing or starting another game.
- Names, labels, explanations, and evidence text use `textContent`. Chart SVG contains numeric coordinates. Evidence-arrow endpoints are checked against square syntax before drawing; imported text is not inserted as HTML.
- Static routes expose `static/` and generated audio only. PGNs, private progress, models, and Python environments are not served. Public puzzle imports are validated by legal replay; the running app performs no download.

## Trust boundaries and limits

Any process running as the same operating-system user can call the local service or modify its data files. There are no separate app accounts, audit identities, or per-user authorization. Model weights and practice-game results are personal training data rather than a tamper-proof competition record. Local request flooding could still consume resources; the loopback deployment and same-origin controls are part of the supported configuration.

Google Fonts is the only runtime UI resource requested from another service. Speech text and chess positions are processed locally. Downloaded Stockfish, Piper, Maia-3, voice/model weights, opening data, public puzzles, and piece artwork are retained with source/license references in the README.
