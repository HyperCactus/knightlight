# Puzzle quality and variety investigation

## Findings

The former selector turned any personal error of at least 150 centipawns into a puzzle, including errors from positions that were already lost. Five of nine previously attempted positions inspected at depth 15 were heavily lost or forced losses. The drill also always accepted its cached best move and continued for three player turns even after the useful tactic had ended.

Skipped positions were absent from the practice history. Fresh selection could therefore return the same skipped board. The old public pool contained only 144 positions and the loader had a 500-entry limit.

A separate explanation issue affected a valid queen exchange from the user's history: Qxd8, Bxd8, Bxh8. The explanation showed the balanced queen trade and stopped before the rook gain. Strategy explanations now join the exchange to its later material payoff.

## Changes

- 100,000 distinct offline Lichess positions, preserving original solutions and source IDs; source lines are legally replayed during import and loading.
- Three candidate engine searches at depth 15, rising to 18 for ambiguity or risk. Candidates need a clear one- or two-move choice and a playable starting position. Conflicting published solutions get depth-19 checking before retirement.
- Every actual answer is checked, including the cached best move. A changed engine result updates the hint rather than preserving a bad required move. Equivalent strong moves and immediate mates remain valid.
- Drills end after the useful sequence, with at most five player turns. Forced cleanup and positions with many equally good moves are not presented as another critical puzzle step.
- Position-based persistent exposure tracking records skips as well as completions. Fresh requests reject repeated boards, including concurrent requests. Optional learned-position review permits deliberate repetition.
- Recommendations combine personal opportunities with a larger pool weighted toward the user's historical weaknesses, within a challenge rating band and with theme diversity. Only a small candidate window is sent to the browser.

## Verification

- 100,000 unique board identities in the bank.
- 25 independently checked live puzzles, including deliberate skips; 44 accepted moves replayed with python-chess and compared with a separate depth-17 engine search.
- Fresh queues exclude those boards after server restart. Repeating an explicit fresh request returns a conflict.
- Browser coverage includes ten successive unique skips, a fresh reload, focused Pins practice, solving a tactical line, and switching into and out of deliberate review.
- Rust regressions cover lost/ambiguous positions, one or two clear candidates, duplicate identities, persistence, weakness targeting, a sound mating queen sacrifice, a bad source queen sacrifice, and the queen trade that wins a rook afterward.

All audits run in disposable libraries. Automated browsers use `--mute-audio`; real history and audio preferences are preserved. These checks establish practical quality and consistency, not exhaustive proof of all 100,000 solutions under finite-depth analysis.

Run `npm run test:puzzle-bank`, `CHESS_TEST_BROWSER=/path/to/chrome npm run test:puzzle-variety`, and `cargo test` to reproduce the checks. Source and import filters are documented in `data/PUBLIC-PUZZLES.md`.
