# Offline puzzle bank

`puzzle-bank.json` contains **100,000 distinct positions** selected from the [Lichess puzzle database](https://database.lichess.org/#puzzles), downloaded on 8 November 2026. The source is released under CC0. Original IDs, solution moves, themes, puzzle ratings and game URLs are retained.

| Main theme | Positions |
| --- | ---: |
| Checkmate patterns | 18,089 |
| Endgame technique | 22,183 |
| Forks & double attacks | 25,000 |
| King safety | 10,432 |
| Material & captures | 11,850 |
| Pins | 12,446 |

Import filters: puzzle ratings 600–2,500, popularity at least 85, at least 100 recorded plays and rating deviation at most 100. One-move puzzles and mates in one are excluded from this large bank. Lines have two to five player moves and finish in mate, a material gain, or a tagged defensive sequence. Each solution is legally replayed with python-chess during import and again by Rust on loading. The first export move (the opponent’s move) is applied before presenting the position. Duplicate boards ignore move counters.

The running app checks three engine candidates at depth 15, escalating ambiguous or risky positions to depth 18. A puzzle needs one or two standout continuations and cannot start in a heavily lost or forced-mate-against position. Published answers that conflict with fresh analysis receive depth-19 verification and are retired if unresolved. Actual answers are evaluated at depth 16, with deeper checks when needed; matching an old stored answer never bypasses validation. Equivalent sound answers and immediate checkmates remain accepted. Forced-move cleanup and routine continuation positions end the exercise rather than demanding three arbitrary moves.

Fresh mode remembers every opened board, including skips, across restarts. Position identity prevents another source ID or move number from making the same board look new. Fresh requests reject previously opened positions, including races between tabs. Studied positions remain available through the explicit **Review learned positions** action.

Recommendations favor themes with high error rates and centipawn losses in the player’s game history, mix themes to avoid repetitive sessions, and use a rating band around the practice rating. This is an estimated challenge band; puzzle and game ratings come from different pools. Only a small recommendation window is sent to the browser. The full bank stays offline on the Rust server.

`public-puzzles.json` retains the original small fallback pack for standalone test environments and installations without the large bank. Production loads `puzzle-bank.json` first.

Rebuild with:

```bash
vendor/maia-env/bin/python scripts/fetch_puzzles.py --limit 100000 --output data/puzzle-bank.json
```

Verify selection, answers and persistence in a disposable library with `npm run test:puzzle-bank`. No account, network access or cloud service is needed during training. Finite-depth analysis remains approximate; the import and live checks provide complementary validation.
