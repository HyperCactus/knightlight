# Development

Knightlight uses Rust for the backend, plain JavaScript/CSS for the interface, and a Tauri desktop shell. Small ONNX workers run the local speech and opponent models.

Start with the [desktop build instructions](DESKTOP.md#build-from-source) to prepare dependencies, models, and Stockfish. For the secondary browser edition, see [the web guide](WEB.md).

## Verification

```bash
npm ci
npx playwright install chromium
cargo test
cargo build --release
npm run test:app-install # isolated launcher/install checks and muted desktop/mobile icon checks
npm run test:preferences # muted relaunch, storage clearing, migration and save-failure checks
npm run test:speech-latency # silent synthesis and muted first-playback timings
npm run test:opponent-startup # cached cold-start replies, live handoff and result-driven difficulty
npm run test:browser  # disposable server, library/cache copy, private test progress
npm run test:studio   # isolated reviews, bot, speech, audio, and mobile checks
npm run test:learning # isolated continuation, schedules, Elo, diagrams, and recovery checks
npm run test:history  # date weighting, PGN interchange, autosaving, restart and mobile checks
npm run test:experience # voices, auto narration, settings, XP, mobile and interruption checks
npm run test:review-pacing # backend move-complexity pacing, recaptures, bounds and old-cache refresh
npm run test:review # playback clock, move animations, seeks, resignation and late-reply regression checks
npm run test:game-flow # interruption recovery, board stability, result summaries and mobile return controls
npm run test:coach-controls # fixed transcript space and first-click actions during speech, desktop/mobile
npm run test:puzzle-flow # default daily prediction, automatic replies, feedback, narration and recovery
npm run test:assist # team control maps, 3-miss help, manual overrides, persistence and diagram safety
npm run test:perspective # opposite-side review, legal replies, narration, cancellation and unchanged history
npm run test:regressions # audit regressions: persistence, async transitions, narration and teaching
npm run test:performance # full-bank queue timings and incremental saves with a 1,000-game archive
npm run test:puzzle-bank # 100,000-board uniqueness, sampled answer quality and persistent fresh queues
npm run test:puzzle-variety # muted browser: skips, reload, theme focus and deliberate review
cargo clippy --all-targets -- -D warnings
```

Use `CHESS_TEST_BROWSER=/path/to/chromium` to use an existing browser. The studio suite verifies reviews, legal alternatives, mate explanations, public opening matches, model training, manual/varied bot behavior, neural speech and its cache, the thinking delay, audio, coach previews, saved-game review, and mobile layout. The board suite covers click/drag/touch, continuation training, hints, take-back, and promotion. The learning suite checks alternative mates for both colors, rejected moves, idempotency, schedule/rating persistence across restart, the Elo formula, repetition, human-model behavior, diagrams, review-to-practice navigation, the rating slider, refresh recovery, and mobile overflow. The history suite checks date-based weighting independent of import order, invalid/duplicate PGNs, header-preserving exports, browser file controls, bot autosaving, distinct sessions, rating persistence, and mobile controls. The experience suite synthesizes every installed voice, checks cache/validation, default automatic synchronized narration, live speed, mute and interruption, settings persistence, reward/goal deduplication, restart persistence, and all five mobile pages. Automated browser tests launch with `--mute-audio`: they verify playback state without playing through your speakers. The review suite checks ordered timed playback, pause/resume, castling and reverse animation, scrubber/key-move seeks, resignation during thinking/diagrams, and starting another game. All browser suites use disposable state and leave your real practice history untouched.


## Documentation images

Run `CHESS_TEST_BROWSER=/path/to/chromium node scripts/capture-screenshots.cjs` after building the release backend. The script captures the real interface with a disposable historical example game. It verifies Chromium is muted before opening the app and never reads your personal history. Images are written to `docs/screenshots/`.

Installer artwork is authored in `scripts/generate-installer-art.py`; regenerate it with system Python, librsvg, PyGObject, pycairo, and Pillow. Generated PNG/BMP files are committed, so building installers does not need these graphics dependencies.
