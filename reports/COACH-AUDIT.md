# Coaching audit

## Latest dialogue and context investigation

Played six disposable scenarios, including Maia-3 opponents at 800 and 1400, then replayed the same games against the revised coaching backend. Two scenarios are complete short mating games; the four generated playthroughs are bounded at 48 half-moves.

### Findings and changes

- **90 sound moves were explained using a different move.** The revised review explains the played move first for losses of at most 80 centipawns. The same 203-half-move sample now has **zero** such mismatches. Alternatives remain available for comparison.
- Review automatically narrated ordinary opening moves even though live Coach mode already suppressed them. Both review stepping and playback now leave those moves quiet; mistakes, blunders and requested explanations remain accessible.
- “Can be recaptured” often omitted the result of the exchange. Dialogue now identifies a gain, an even exchange or a material cost. King safety and pinned-piece legality checks remain intact.
- Quiet move commentary often described only relocation or central control. It now recognizes an escape from attack, an opened bishop diagonal, a useful rook file, passed-pawn progress and king support for a pawn. Direct attacks on pieces take priority over generic file control.
- The coach now checks the short engine line for a later material payoff, queen simplification, castling or a newly created passed pawn. It animates the intervening moves and gives one short outcome sentence instead of narrating a list of moves. For example: “In this line, the follow-up wins the rook.”
- Nearby repetitions of the same forward-looking plan do not trigger automatic review commentary again. Manually requested explanations remain available.

### Verification

- 6 scenarios; 203 reviewed half-moves; 16 targeted positions.
- 85 capture arrows and 264 continuation moves independently checked with python-chess.
- 52 forward-looking summaries and 67 contextual-purpose facts across the game and targeted-position evidence. Counts include alternatives, not just automatically spoken facts.
- 17 exposed-queen recommendations retain their explanatory continuation.
- 37 Rust tests; Clippy with warnings denied; release build.
- Muted browser suites: review, experience and learning. These cover opening silence, played-move relevance, every animated step in a payoff, synchronized highlights, automatic return, playback, resignation, training and settings.

| Game | Half-moves | Result | Policy |
| --- | ---: | --- | --- |
| 1 | 4 | 0-1 | Stockfish/fixture |
| 2 | 7 | 1-0 | Stockfish/fixture |
| 3 | 48 | * | Maia-3 |
| 4 | 48 | * | Maia-3 |
| 5 | 48 | * | Stockfish/fixture |
| 6 | 48 | * | Stockfish/fixture |

`*` denotes an unfinished bounded playthrough. All generated games, rewards and voice caches use disposable libraries. Chromium runs with `--mute-audio`; no host audio settings or real game history are changed.

## Retained recommendation safeguards

Capture threats use legal moves rather than geometric attackers. Queen trades show the recapture and return capture. Exposed queens and large local exchange costs trigger depth-14 verification; cached recommendations in those cases are refreshed. Forced mating sacrifices retain their engine continuation. UCI bound scores are excluded and the principal variation must agree with the final engine move.

Forward-looking descriptions replay the engine line, verify cached positions and check material at the displayed endpoint. A profitable immediate recapture prevents that endpoint from being described as a settled gain. These are deterministic teaching rules over a finite-depth engine line; they do not supply a complete strategic explanation for every position.

Run `npm run test:coach-audit` to regenerate `reports/coach-audit.json`, including the complete game dialogue for inspection. `CHESS_AUDIT_REPLAY=/path/to/earlier-report.json` reuses its game moves for a like-for-like comparison. `CHESS_AUDIT_REPORT=/path/to/report.json` selects a separate output file.
