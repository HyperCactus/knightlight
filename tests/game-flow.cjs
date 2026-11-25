const { chromium, devices } = require("playwright"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  { spawn } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "chess-review-"));
for (const folder of ["static", "scripts", "vendor"])
  fs.symlinkSync(path.join(root, folder), path.join(dir, folder));
fs.mkdirSync(path.join(dir, "data"));
fs.symlinkSync(
  path.join(root, "data/openings"),
  path.join(dir, "data/openings"),
);
fs.writeFileSync(
  path.join(dir, "fixture.pgn"),
  `[White "Tester"]
[Black "Other"]
[WhiteElo "1000"]
[Date "2026.11.07"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O *

[White "Tester"]
[Black "Other"]
[Date "2026.11.07"]
[WhiteElo "1000"]
[Result "0-1"]

1. f3 e5 2. g4 Qh4# 0-1
`,
);
const port = require("./support.cjs").allocatePort(),
  base = `http://127.0.0.1:${port}`;
let logs = "",
  browser;
const server = spawn(path.join(root, "target/release/chess-study"), [], {
  cwd: dir,
  env: { ...process.env, PORT: String(port), CHESS_PLAYER: "Tester" },
});
server.stdout.on("data", (b) => (logs += b));
server.stderr.on("data", (b) => (logs += b));
async function get(route) {
  return (await fetch(base + "/api/" + route)).json();
}
async function until(fn, timeout = 30000) {
  let start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 80));
  }
  throw Error("Timed out. " + logs);
}
(async () => {
  try {
    await until(async () => (await get("data")).ready);
    browser = await chromium.launch({
      headless: true,
      args: ["--mute-audio", "--enable-automation"],
      ...(process.env.CHESS_TEST_BROWSER
        ? { executablePath: process.env.CHESS_TEST_BROWSER }
        : {}),
    });
    const command = await (await browser.newBrowserCDPSession()).send("Browser.getBrowserCommandLine");
    assert(command.arguments.includes("--mute-audio"));
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() =>
      localStorage.setItem(
        "chess-preferences",
        JSON.stringify({ voice: false, coach: false }),
      ),
    );
    await page.goto(base);
    await page.waitForFunction(
      () => data?.ready && activeDrill && !boards.puzzle.busy,
    );
    await page.locator('[data-page="settings"]').click();
    const originalSession = await page.evaluate(() => sessionId);
    await page.locator('.brand img').click();
    assert(await page.locator('#overview').evaluate(e => e.classList.contains('active')));
    assert.equal(await page.locator('[data-page="overview"]').getAttribute('aria-current'), 'page');
    await page.locator('[data-page="settings"]').click();
    await page.locator('.brand').focus();
    await page.keyboard.press('Enter');
    assert(await page.locator('#overview').evaluate(e => e.classList.contains('active')));
    assert.equal(await page.evaluate(() => sessionId), originalSession);
    console.log('PASS logo click and keyboard activation return to Overview without resetting the game');
    await page.route("**/api/bot", async (route) => {
      const { fen } = route.request().postDataJSON();
      const response = await fetch(base + "/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fen }),
      });
      const board = await response.json();
      await route.fulfill({
        json: {
          move: board.legal[0],
          rating: 1050,
          style: "balanced",
          source: "Test policy",
          book: false,
        },
      });
    });
    await page.locator('[data-page="play"]').click();
    await page.evaluate(() => movePiece("play", "e2", "e4"));
    await page.waitForFunction(
      () => lastCoach && !boards.play.busy && !botBusy,
    );
    // Opening, interrupting, and reopening a lesson must preserve real legal moves.
    for (const mode of ["immediate", "next-step", "preview", "late-voice"]) {
      const original = await page.evaluate(() => ({
        fen: boards.play.fen,
        legal: [...boards.play.legal],
      }));
      const box = await page.locator("#play-board").boundingBox();
      if (mode === "preview")
        await page.evaluate(() => $("#coach-best").onclick());
      await page.evaluate(() => startVisualLesson("play", lastCoach, false));
      if (mode === "next-step")
        await page.evaluate(() => {
          lessonStep(1);
        });
      if (mode === "late-voice")
        await page.evaluate(() => {
          window.originalVoiceClip = voiceClip;
          voiceClip = () =>
            new Promise((resolve) => (window.releaseVoice = resolve));
          visualLesson.spoken = true;
          lessonStep(0);
        });
      await page.waitForTimeout(500);
      const during = await page.locator("#play-board").boundingBox();
      assert.deepEqual(during, box, "Explanation moved the board: " + mode);
      await page.locator("#play-lesson-player .lesson-return").click();
      if (mode === "late-voice")
        await page.evaluate(() => {
          releaseVoice({ url: "/unused.wav" });
          voiceClip = originalVoiceClip;
        });
      await page.waitForTimeout(450);
      const state = await page.evaluate(() => ({
        fen: boards.play.fen,
        legal: boards.play.legal,
        interactive: canInteract("play"),
        busy: boards.play.busy,
        preview: coachPreview,
        lesson: visualLesson,
        speech: Boolean(speechAudio),
      }));
      assert.equal(state.fen, original.fen);
      assert.deepEqual(state.legal, original.legal);
      assert(state.interactive);
      assert(!state.busy);
      assert.equal(state.preview, null);
      assert.equal(state.lesson, null);
      assert(!state.speech);
      assert.deepEqual(await page.locator("#play-board").boundingBox(), box);
    }
    // A snapshot must neither resurrect an old lock nor clear a new in-flight request.
    await page.evaluate(() => {
      boards.play.busy = true;
      window.savedPosition = boardSnapshot("play");
      boards.play.busy = false;
      Object.assign(boards.play, savedPosition);
      if (!canInteract("play"))
        throw Error("Snapshot restored a stale busy flag");
      startVisualLesson("play", lastCoach, false);
      boards.play.busy = true;
      returnToBoard("play");
      if (!boards.play.busy) throw Error("Return cleared a live request lock");
      boards.play.busy = false;
    });
    assert(
      await page.evaluate(() => {
        const previous = voiceEnabled;
        voiceEnabled = true;
        autoNarrate("play", lastCoach);
        voiceEnabled = previous;
        return visualLesson === null;
      }),
      "Dismissed coaching must not reopen from a queued narration",
    );
    const beforeMoves = await page.evaluate(() => playedMoves.length);
    await page.evaluate(async () => {
      const u = boards.play.legal[0];
      await movePiece("play", u.slice(0, 2), u.slice(2, 4));
    });
    await page.waitForFunction(
      (count) =>
        playedMoves.length === count + 2 && !botBusy && !boards.play.busy,
      beforeMoves,
    );
    console.log(
      "PASS interrupted lessons restore a movable board, preserve live request locks, ignore late speech and keep exact board bounds",
    );
    // Training is equally interruptible and never snapshots an in-flight hint request.
    await page.locator('[data-page="puzzles"]').click();
    const puzzleBox = await page.locator("#puzzle-board").boundingBox();
    await page.evaluate(() =>
      startVisualLesson("puzzle", { evidence: activeDrill.evidence }, false),
    );
    await page.waitForTimeout(450);
    assert.deepEqual(
      await page.locator("#puzzle-board").boundingBox(),
      puzzleBox,
    );
    await page.locator("#puzzle-lesson-player .lesson-return").click();
    assert(await page.evaluate(() => canInteract("puzzle")));
    const square = await page.evaluate(() =>
      boards.puzzle.legal[0].slice(0, 2),
    );
    await page.locator(`#puzzle-board [data-square="${square}"]`).click();
    assert.equal(await page.evaluate(() => boards.puzzle.selected), square);
    console.log(
      "PASS training cancellation restores piece selection without shifting the board",
    );
    await page.locator('[data-page="play"]').click();
    const games = [
      {
        verdict: "win",
        outcome: "White wins by checkmate",
        moves: ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"],
      },
      {
        verdict: "loss",
        outcome: "Black wins by checkmate",
        moves: ["f2f3", "e7e5", "g2g4", "d8h4"],
      },
      {
        verdict: "draw",
        outcome: "Draw by threefold repetition",
        moves: ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"],
      },
    ];
    for (const game of games) {
      await page.evaluate(async (game) => {
        await newPractice();
        let fen = startFen;
        for (const u of game.moves) {
          const b = await api("move", {
            fen,
            from: u.slice(0, 2),
            to: u.slice(2, 4),
          });
          fen = b.fen;
        }
        await setBoard("play", fen);
        playedMoves = game.moves;
        gameOpponentRating = 1050;
        finish({ outcome: game.outcome });
      }, game);
      assert(await page.locator("#game-over-dialog").isVisible());
      assert.equal(
        await page.locator("#game-result").getAttribute("data-verdict"),
        game.verdict,
      );
      await page.waitForFunction(
        () => completedGame?.summary,
        {},
        { timeout: 30000 },
      );
      const summary = await page.evaluate(() => completedGame.summary);
      assert.equal(summary.verdict, game.verdict);
      assert.equal(summary.moves, Math.ceil(game.moves.length / 2));
      if (game.verdict !== "draw") assert.match(summary.story, /checkmate/);
      else assert(!summary.story.includes("checkmate"));
      assert.equal(await page.locator(".result-stats strong").count(), 3);
      await page.screenshot({ path: `/tmp/chess-finish-${game.verdict}.png` });
      if (game.verdict === "loss") {
        const key = summary.key_ply;
        await page.locator("#review-finished").click();
        await page.waitForFunction(
          (key) =>
            currentReview &&
            replayPly === key &&
            $("#games").classList.contains("active"),
          key,
        );
        await page.locator('[data-page="play"]').click();
      } else await page.locator("#result-back-board").click();
      assert(await page.locator('.play-toolbar > #new-game.primary').isVisible());
      assert(await page.locator('#new-game').isEnabled());
      assert.equal(await page.locator('#game-options').evaluate(e => e.open), false);
      assert.equal(await page.locator('#take-back').evaluate(e => e.closest('#game-options') !== null), true);
    }
    console.log(
      "PASS wins, losses and draws have distinct completion screens, factual analyzed summaries, stats and a working key-moment review action",
    );
    await page.locator('.play-toolbar > #new-game').click();
    await page.waitForFunction(() => !newGameBusy && !gameFinished && playedMoves.length === 0);
    assert(await page.locator('.play-toolbar > #take-back').isVisible());
    assert.equal(await page.locator('#new-game').evaluate(e => e.closest('#game-options') !== null), true);
    assert(await page.evaluate(() => canInteract("play")));
    assert.equal(await page.evaluate(() => $("#game-over-dialog").open), false);
    const phone = await browser.newPage({ ...devices["iPhone 13"] });
    await phone.addInitScript(() =>
      localStorage.setItem(
        "chess-preferences",
        JSON.stringify({ voice: false }),
      ),
    );
    await phone.goto(base);
    await phone.waitForFunction(
      () => data?.ready && activeDrill && !boards.puzzle.busy,
    );
    await phone.locator('[data-page="play"]').click();
    await phone.evaluate(async () => {
      window.demo = await api("coach", { fen: startFen, uci: "e2e4" });
    });
    await phone.locator("#play-board").scrollIntoViewIfNeeded();
    const phoneBox = await phone.locator("#play-board").boundingBox();
    await phone.evaluate(() => startVisualLesson("play", demo, false));
    await phone.waitForTimeout(500);
    assert.deepEqual(
      await phone.locator("#play-board").boundingBox(),
      phoneBox,
    );
    assert.equal(
      await phone.locator("#play-flip").textContent(),
      "Back to game",
    );
    await phone.screenshot({ path: "/tmp/chess-mobile-return-before.png" });
    assert(
      await phone.evaluate(
        () =>
          $("#play-flip").getBoundingClientRect().bottom <=
          $("aside>nav").getBoundingClientRect().top,
      ),
      "Return control must stay fully above mobile navigation",
    );
    await phone.locator("#play-flip").click();
    assert.equal(await phone.locator("#play-flip").textContent(), "↻ Flip");
    assert.deepEqual(
      await phone.locator("#play-board").boundingBox(),
      phoneBox,
    );
    assert(
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await phone.evaluate(() => finish({ outcome: "Draw by agreement" }));
    assert(await phone.locator('#play-again.primary').isVisible());
    await phone.locator('#result-back-board').tap();
    assert(await phone.locator('.play-toolbar > #new-game.primary').isVisible());
    await phone.locator('#new-game').tap();
    await phone.waitForFunction(() => !newGameBusy && !gameFinished);
    await phone.locator('[data-page="settings"]').tap();
    await phone.locator('.brand').tap();
    assert(await phone.locator('#overview').evaluate(e => e.classList.contains('active')));
    assert.deepEqual(errors, []);
    console.log('PASS desktop/mobile completed games expose New game outside the menu and restore live controls after one click');
    console.log(
      "PASS mobile explanation entry and exit preserve the board position and fit the viewport",
    );
  } finally {
    await browser?.close();
    const exited = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
