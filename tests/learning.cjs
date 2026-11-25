const { chromium, devices } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  { spawn } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "chess-learning-"));
for (const folder of ["static", "scripts", "vendor"])
  fs.symlinkSync(path.join(root, folder), path.join(dir, folder));
fs.mkdirSync(path.join(dir, "data"));
fs.symlinkSync(
  path.join(root, "data/openings"),
  path.join(dir, "data/openings"),
);
fs.writeFileSync(
  path.join(dir, "fixture.pgn"),
  '[Event "Learning fixture"]\n[White "Tester"]\n[WhiteElo "1000"]\n[Black "Other"]\n[Date "2026.11.06"]\n[Result "0-1"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. a3 Nxh5 0-1\n',
);
const pack = [
  {
    id: "white-mates",
    fen: "7k/5K2/6Q1/8/8/8/8/8 w - - 0 1",
    moves: ["g6g7"],
    rating: 900,
    theme: "Checkmate patterns",
    game_url: "https://lichess.org",
  },
  {
    id: "black-mates",
    fen: "8/8/8/8/8/6q1/5k2/7K b - - 0 1",
    moves: ["g3g2"],
    rating: 900,
    theme: "Checkmate patterns",
    game_url: "https://lichess.org",
  },
  {
    id: "fork",
    fen: "3r3k/6pp/8/4N3/8/8/P7/6K1 w - - 0 12",
    moves: ["e5f7", "h8g8", "f7d8"],
    rating: 1100,
    theme: "Forks & double attacks",
    game_url: "https://lichess.org",
  },
  {
    id: "queen-sacrifice",
    fen: "5r1k/6pp/4Q2N/8/8/8/8/6K1 w - - 0 1",
    moves: ["e6g8", "f8g8", "h6f7"],
    rating: 1200,
    theme: "King safety",
    game_url: "https://lichess.org",
  },
];
fs.writeFileSync(
  path.join(dir, "data/public-puzzles.json"),
  JSON.stringify(pack),
);
const port = require("./support.cjs").allocatePort(),
  base = `http://127.0.0.1:${port}`;
let logs = "",
  server,
  browser;
function launch() {
  server = spawn(path.join(root, "target/release/chess-study"), [], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), CHESS_PLAYER: "Tester" },
  });
  server.stdout.on("data", (b) => (logs += b));
  server.stderr.on("data", (b) => (logs += b));
}
async function stop() {
  if (!server) return;
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));
  server = null;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) {
  let start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if (await fn()) return;
    } catch {}
    await wait(100);
  }
  throw Error("Timed out: " + logs);
}
async function get(route) {
  const r = await fetch(base + "/api/" + route);
  assert.equal(r.status, 200);
  return r.json();
}
async function post(route, body, status = 200) {
  const r = await fetch(base + "/api/" + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(r.status, status, await r.clone().text());
  return r.json();
}
const move = (d, u, key = crypto.randomUUID()) =>
  post(`drills/${d.session}/moves`, {
    uci: u,
    revision: d.revision,
    request_id: key,
  });
(async () => {
  try {
    launch();
    await until(async () => (await get("data")).ready);
    const data = await get("data");
    assert.equal(data.puzzles.filter((p) => p.source === "lichess").length, 4);
    let d = await post("drills", { id: "lichess-white-mates" });
    assert.equal(d.objective, "Find checkmate");
    let r = await move(d, "g6g5");
    assert.equal(r.accepted, false);
    assert.equal(r.revision, 1);
    assert.equal(r.board.fen, d.board.fen);
    const alt = ["g6g8", "g6g7", "g6h6", "g6h5"].find((u) => u !== d.best);
    r = await move({ ...d, revision: r.revision }, alt);
    assert(r.accepted && r.complete);
    assert.equal(r.clean, false);
    let summary = await get("practice");
    assert.equal(summary.cards["lichess-white-mates"].outcome, "retry");
    assert.equal(summary.clean, 0);
    console.log(
      "PASS legal wrong move is rejected; an alternate immediate mate is accepted without granting first-try mastery",
    );
    d = await post("drills", { id: "lichess-black-mates" });
    const requestId = crypto.randomUUID();
    r = await move(
      d,
      ["g3g1", "g3g2", "g3h3", "g3h4"].find((u) => u !== d.best),
      requestId,
    );
    assert(r.accepted && r.complete && r.clean);
    const same = await move(d, "g3g2", requestId);
    assert.deepEqual(same, r);
    summary = await get("practice");
    assert.equal(summary.cards["lichess-black-mates"].clean, 1);
    assert.equal(summary.cards["lichess-black-mates"].attempts, 1);
    await post(
      `drills/${d.session}/moves`,
      { uci: "g3g2", revision: 0, request_id: crypto.randomUUID() },
      409,
    );
    const recall = await post(`drills/${d.session}/reflection`, {
      answer: "Only the material count before the move",
    });
    assert.equal(recall.correct, false);
    summary = await get("practice");
    assert.equal(summary.cards["lichess-black-mates"].recall_wrong, 1);
    assert.equal(summary.cards["lichess-black-mates"].box_level, 0);
    await post(`drills/${d.session}/reflection`, { answer: recall.answer });
    assert.equal(
      (await get("practice")).cards["lichess-black-mates"].recall_correct,
      0,
    );
    console.log(
      "PASS reflection feedback, next-day rescheduling, and prevention of repeated recall scoring",
    );
    console.log(
      "PASS black-side alternative mate, idempotent completion and stale-revision protection",
    );
    d = await post("drills", { id: "lichess-white-mates" });
    await post(`drills/${d.session}/help`, { kind: "reveal" });
    await post(`drills/${d.session}/help`, { kind: "reveal" });
    summary = await get("practice");
    assert.equal(summary.cards["lichess-white-mates"].attempts, 2);
    assert.equal(summary.cards["lichess-white-mates"].outcome, "revealed");
    await move(d, d.best);
    summary = await get("practice");
    assert.equal(summary.cards["lichess-white-mates"].attempts, 2);
    console.log(
      "PASS reveals schedule another review and never count as unaided success or double-record completion",
    );
    d = await post("drills", { id: "lichess-fork" });
    let turnCount = 0;
    while (!d.complete && turnCount < 3) {
      r = await move(d, d.best);
      assert(r.accepted);
      if (!r.complete) assert(r.reply_step?.uci);
      d = { ...d, ...r };
      turnCount++;
    }
    assert(d.complete);
    assert(turnCount >= 2);
    assert(d.turns <= 3);
    console.log(
      "PASS multi-turn continuation with legal opponent replies and bounded completion",
    );
    const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    let board = { fen: start },
      history = [];
    for (const u of [
      "g1f3",
      "g8f6",
      "f3g1",
      "f6g8",
      "g1f3",
      "g8f6",
      "f3g1",
      "f6g8",
    ]) {
      board = await post("move", {
        fen: board.fen,
        from: u.slice(0, 2),
        to: u.slice(2, 4),
        history,
      });
      history.push(u);
    }
    assert.match(board.outcome, /threefold/);
    await post("bot", { fen: start, rating: 5000 }, 400);
    await post("bot", { fen: start, moves: ["e2e4"], rating: 1200 }, 400);
    const bots = [];
    for (let i = 0; i < 3; i++)
      bots.push(
        await post("bot", {
          fen: start,
          rating: 1600,
          session_id: "stable-style",
          style: "varied",
        }),
      );
    assert.equal(new Set(bots.map((b) => b.style)).size, 1);
    assert(bots.every((b) => b.rating === 1600 && b.source.includes("Maia-3")));
    assert(bots.every((b) => b.inference_ms < 1500));
    console.log(
      "PASS threefold repetition, rating bounds, consistent history and stable human-model style",
    );
    const game = {
      white: "Tester",
      black: "Bot",
      result: "1-0",
      date: "2026.11.06",
      event: "Test",
      moves: ["e2e4", "e7e5"],
      session_id: "rating-fixture",
      opponent_rating: 1200,
      played_at: "2026-11-06T00:00:00Z",
    };
    const initial = await get("profile");
    assert.equal(initial.rating_origin, "Date-weighted game history");
    assert.equal(initial.initial_rating, 1000);
    await post("games", game);
    await post("games", game);
    let profile = await get("profile");
    assert.equal(profile.rated_games, 1);
    const eloSample =
      initial.practice_rating +
      Math.round(
        40 * (1 - 1 / (1 + 10 ** ((1200 - initial.practice_rating) / 400))),
      );
    const expected = Math.round((initial.practice_rating + eloSample) / 2);
    assert.equal(profile.rating_samples, 2);
    assert.equal(profile.practice_rating, expected);
    assert(profile.adaptive_rating > expected + 100);
    const savedCard = JSON.stringify((await get("practice")).cards);
    await stop();
    launch();
    await until(async () => (await get("data")).ready);
    assert.equal(JSON.stringify((await get("practice")).cards), savedCard);
    assert.equal((await get("profile")).practice_rating, expected);
    console.log(
      "PASS Elo result sample, weighted history score, deduplication and persistence across restart",
    );
    browser = await chromium.launch({
      args: ["--mute-audio"],
      headless: true,
      ...(process.env.CHESS_TEST_BROWSER
        ? { executablePath: process.env.CHESS_TEST_BROWSER }
        : {}),
    });
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1050 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(
      () => data?.ready && activeDrill && !boards.puzzle.busy,
    );
    await page.waitForFunction(
      () =>
        profileData &&
        document.querySelector("#practice-rating").textContent !== "1,000",
    );
    await page.locator('[data-page="games"]').click();
    await page.waitForFunction(() => currentReview?.moves.length);
    await page.locator("#review-blunder").click();
    await page.waitForFunction(() => !reviewPlayback.seeking);
    assert(await page.locator(".story-card").count());
    const originalReview = await page.evaluate(() => boards.game.fen);
    await page.locator("#review-lesson").click();
    assert(await page.evaluate(() => visualLesson?.name === "game"));
    assert(await page.locator("#game-board .fact-square").count());
    await page
      .locator('#game-lesson-player button[aria-label="Next explanation step"]')
      .click();
    assert.equal(await page.evaluate(() => visualLesson.index), 1);
    assert(await page.locator("#game-board.narrating").count());
    await page
      .locator("#game-lesson-player")
      .getByText("Back to review", { exact: true })
      .click();
    assert.equal(await page.evaluate(() => boards.game.fen), originalReview);
    await page.locator("#review-evidence button").first().click();
    assert(await page.locator("#game-board .fact-square").count());
    await page.locator("#review-restore").click();
    await page.locator("#practice-moment").click();
    await page.waitForFunction(() => activeDrill && !boards.puzzle.busy);
    assert.equal(
      await page.locator("#puzzles").getAttribute("class"),
      "page active",
    );
    await page.evaluate(async () => {
      await startPosition("lichess-white-mates", 0, true);
    });
    await page.locator("#hint").click();
    await page.waitForFunction(() => !boards.puzzle.busy);
    assert.equal(await page.locator("#puzzle-board .hinted").count(), 1);
    await page.locator("#hint").click();
    await page.waitForFunction(() => !boards.puzzle.busy);
    assert.equal(await page.locator("#puzzle-board .board-arrow").count(), 1);
    const practiceFen = await page.evaluate(() => boards.puzzle.fen);
    const hintWasDisabled = await page.locator("#hint").isDisabled();
    await page.locator("#puzzle-evidence button").first().click();
    assert(await page.locator("#puzzle-board .evidence-overlay path").count());
    assert.equal(await page.evaluate(() => canInteract("puzzle")), false);
    await page.waitForFunction(
      () => speechAudio && !speechAudio.paused,
      {},
      { timeout: 30000 },
    );
    await page.evaluate(() => speechAudio.dispatchEvent(new Event("ended")));
    await page.waitForFunction(() => visualLesson === null);
    assert.equal(await page.evaluate(() => boards.puzzle.fen), practiceFen);
    assert.equal(await page.evaluate(() => puzzlePreview), null);
    assert(await page.evaluate(() => canInteract("puzzle")));
    assert.equal(await page.locator("#hint").isDisabled(), hintWasDisabled);
    assert.equal(await page.locator("#puzzle-return").isVisible(), false);
    console.log(
      "PASS training explanation returns to the playable board and restores controls without a Return click",
    );
    await page.locator("#training-daily").click();
    await page.waitForFunction(
      () => dailyMode && activeDrill && !boards.puzzle.busy,
    );
    const queueLength = await page.evaluate(() => trainingQueue.length);
    assert(queueLength > 0 && queueLength <= 10);
    await page.evaluate(() => {
      movePiece(
        "puzzle",
        currentPuzzle.best.slice(0, 2),
        currentPuzzle.best.slice(2, 4),
      );
    });
    await page.locator("#prediction-card").waitFor({ state: "visible" });
    assert(await page.locator(".prediction-options button").count());
    await page.locator(".prediction-options button").first().hover();
    assert(await page.locator("#puzzle-board .board-arrow").count());
    await page.locator(".prediction-options button").first().click();
    await page.waitForFunction(() => !boards.puzzle.busy);
    console.log(
      "PASS visual lesson stepping/restoration and active prediction before the defensive reply",
    );
    await page.screenshot({
      path: "/tmp/chess-learning-training.png",
      fullPage: true,
    });
    await page.locator('[data-page="play"]').click();
    await page.locator("#match-settings summary").click();
    await page.locator("#difficulty").selectOption("manual");
    await page.locator("#bot-rating").fill("1750");
    await page.locator("#bot-rating").dispatchEvent("input");
    assert.match(
      await page.locator("#bot-rating-value").textContent(),
      /1,750/,
    );
    await page.locator('#play-board [data-square="e2"]').click();
    await page.locator('#play-board [data-square="e4"]').click();
    await page.waitForFunction(
      () => !botBusy && !boards.play.busy && playedMoves.length === 2,
    );
    assert.equal(await page.evaluate(() => gameOpponentRating), 1750);
    const savedFen = await page.evaluate(() =>
      visualLesson?.name === "play" ? visualLesson.saved.fen : boards.play.fen,
    );
    await page.reload();
    await page.waitForFunction(() => playedMoves.length === 2 && data?.ready);
    assert.equal(await page.evaluate(() => boards.play.fen), savedFen);
    await page.locator('[data-page="play"]').click();
    await page.evaluate(() => ($("#game-options").open = true));
    await page.locator("#resign-game").click();
    await page.waitForFunction(() => gameFinished);
    await until(async () => (await get("profile")).rated_games === 2);
    await page.locator("#result-back-board").click();
    await page.locator('[data-page="overview"]').click();
    await page.screenshot({
      path: "/tmp/chess-learning-overview.png",
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS review-to-practice flow, evidence diagrams, daily sessions, rating slider, refresh recovery and resignation",
    );
    const mobile = await browser.newContext({ ...devices["iPhone 13"] });
    const phone = await mobile.newPage();
    await phone.goto(base);
    await phone.waitForFunction(
      () => data?.ready && practiceData && !boards.puzzle.busy,
    );
    await phone.locator('[data-page="puzzles"]').tap();
    assert(
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await phone.screenshot({
      path: "/tmp/chess-learning-mobile.png",
      fullPage: true,
    });
    await phone.locator('[data-page="play"]').tap();
    await phone.locator("#match-settings summary").click();
    await phone.locator("#difficulty").selectOption("manual");
    assert(await phone.locator("#bot-rating").isEnabled());
    assert(
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    console.log(
      "PASS mobile learning and rating controls without horizontal overflow",
    );
  } finally {
    await browser?.close();
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
