# Audit fixes and optimization

Implemented after the application audit of 8 November 2026. This document records the specific fixes and their regression coverage; it does not claim that the application has no remaining defects.

| Audited issue | Change | Regression evidence |
|---|---|---|
| Unreadable history silently replaced | Checked JSON reads fail clearly and preserve the original. Atomic typed writes retain a previous `.bak` record. Applies to game, import, learner and practice state. | `test:backend-regressions`: malformed files cannot start a writable empty library; damage after startup cannot replace a saved record or its good backup. |
| Background puzzles cancel foreground narration | Puzzle preparation cancels only its own visible lesson. | `test:frontend-regressions`, `test:studio`: foreground coach survives puzzle preparation and speaks normally. |
| Failed voice media freezes review | Failed media clears its ownership, removes the review wait and offers the visual explanation. | `test:frontend-regressions`: invalid voice URL still allows review to reach its final move. |
| Old responses overwrite a selected review | Request identity is checked after JSON parsing and before board commits, including the analyzing-state response. | Deferred-response regressions cover both paths. |
| New-game/undo race | One board transition lock covers save/load; board, session and history commit after successful preparation. Failure preserves the original game. | Transition success/failure and input-lock regressions. |
| False pinned-piece fork lessons | Actionable tactical targets check the attacking side's king safety. Blocking check gets a defensive explanation; geometric Assist control remains separate. | Rust and API tests use the pinned blocking knight position. |
| Mate-in-four sacrifice described as material loss | Explicit engine mate metadata survives display truncation; a bounded sequence can show the mating endpoint. Old cached reviews migrate. | Shipped puzzle `00O9Z` explains the forced mate and ends on checkmate. |
| Overdue card starvation | Due eligibility is applied before selection limits; overdue cards remain retrievable after rating changes. Counts share selection eligibility. | 1,000-card fixture selects the sole overdue card outside the current rating band. |
| Wrong training mode/focus response | In-flight practice requests are keyed by query; obsolete responses cannot commit visible candidates. | Deferred Fresh/Review switch regression. |
| Player-specific cache contamination | Cached ownership and totals are rederived. Model observations are rebuilt when the configured learning player changes, retaining practice progress and recorded results. | Cached Fool's Mate reviewed from both players; model migration test. |
| Export cannot restore above 500 games | Import/startup limits now support 128 MB and 100,000 games, with a larger JSON envelope and matching browser validation. | 501-game backup over 8 MB restores and deduplicates. |
| Maia launch bypasses fallback | Constructor and inference errors enter the same Stockfish fallback path. | Permission-denied worker fixture still returns a legal bot move. |
| Full-archive autosaves | Individual durable session records replace whole-archive writes. Blocking persistence runs outside the async request worker and library lock. Canonical save replies update one frontend entry. | Legacy archive bytes remain unchanged; concurrent saves, retries, restart overlay and result/rating deduplication are tested. |
| Full-bank sorting and lock duration | Bounded per-theme heaps and allocation-free hash noise replace full-bank sorting; planning uses a snapshot on a blocking worker. | `test:performance`, full-bank audit and diversity tests. |
| Repeated review DOM reconstruction | Move list, graph and story content are built once per review revision; active move and graph cursor update in place. | Retained DOM-node identity and keyboard-focus regression. |

Additional integration protections preserve numeric review indices across interleaved imports/bot games using an identity-order manifest, invalidate opponent-perspective caches when games change, reject plans generated for an obsolete game revision, and allocate browser-test ports through the OS.

## Persistence compatibility

Existing `data/sessions.json` archives stay unchanged and readable. Newer records under `data/sessions/` override matching legacy sessions. `data/library-order.json` records game identity order when games are added, rather than on every half-move. No eager migration deletes the legacy archive. Back up the whole data directory when moving installations; PGN export preserves playable games and headers, but learner/reward state lives in separate JSON files.

## Verification

The final integrated run passed **63 Rust tests**, formatting, Clippy with warnings denied, the release build, and **15 integration/browser suites**. The final perspective revision guard was followed by successful frontend-regression and desktop/mobile perspective reruns. Browser checks used disposable history/progress and Chromium `--mute-audio`; real voice preferences remain unchanged.

The six-game coaching audit validated 203 reviewed moves and 16 targeted positions, including 190 continuation moves. The independent puzzle-bank audit confirmed 100,000 unique boards, opened 25 distinct puzzles, validated 44 accepted player moves, and verified skipped/completed positions remain remembered across restart.

On this machine, matching eight-request full-bank benchmarks changed from **105.46 ms to 80.02 ms median** (about **24% lower**); an earlier post-change run measured 68.38 ms. Variation reflects local load and these are measurements, not guarantees. The final 1,000-game autosave fixture measured **3.92 ms median** with a largest response of **627 bytes**, leaving the complete legacy archive byte-for-byte unchanged. A separate metadata-heavy fixture wrote one 18,592-byte session record while leaving its 9,246,347-byte archive unchanged.

Machine-readable results: [audit-fixes-verification.json](audit-fixes-verification.json).

```bash
source "$HOME/.cargo/env"
cargo test
cargo clippy --all-targets -- -D warnings
cargo build --release
npm run test:regressions
npm run test:performance
```

The full run also included `test:browser`, `test:studio`, `test:learning`, `test:history`, `test:experience`, `test:review`, `test:game-flow`, `test:coach-controls`, `test:puzzle-flow`, `test:assist`, `test:perspective`, and `test:puzzle-variety`.
