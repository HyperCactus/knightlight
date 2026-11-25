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
// Keep fresh examples available across both viewport runs; explicit fork
// replays must not consume every remaining board in this small test library.
for (const [n, square] of ["a2", "a3", "a4", "a5", "b3", "b2"].entries()) {
  const ranks = ["7k", "5K2", "6Q1", "8", "8", "8", "8", "8"];
  const rank = 8 - Number(square[1]);
  const file = square.charCodeAt(0) - 97;
  ranks[rank] =
    (file ? String(file) : "") + "P" + (7 - file ? String(7 - file) : "");
  pack.push({
    id: `fresh-mate-${n}`,
    fen: ranks.join("/") + " w - - 0 1",
    moves: ["g6g7"],
    rating: 900,
    theme: "Checkmate patterns",
    game_url: "https://lichess.org",
  });
}
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

let activePage;
(async () => {
  try {
    launch();
    await until(async () => (await get("data")).ready);
    const options = {
      headless: true,
      args: ["--mute-audio"],
      ...(process.env.CHESS_TEST_BROWSER
        ? { executablePath: process.env.CHESS_TEST_BROWSER }
        : {}),
    };
    assert(options.args.includes("--mute-audio"));
    browser = await chromium.launch(options);
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      activePage = page;
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(base);
      await page.waitForFunction(
        () => data?.ready && activeDrill && !boards.puzzle.busy,
      );
      assert.equal(await page.evaluate(() => preferences.predict), true);
      await page.locator('[data-page="puzzles"]').click();
      await page.evaluate(async () => {
        dailyMode = true;
        await startPosition("lichess-fork", 0, true);
      });
      await page
        .locator("#puzzle-board")
        .locator("..")
        .scrollIntoViewIfNeeded();
      const start = await page.evaluate(() => boards.puzzle.fen);
      const response = page.waitForResponse((r) =>
        /\/api\/drills\/[^/]+\/moves$/.test(r.url()),
      );
      await page.locator('#puzzle-board [data-square="e5"]').click();
      await page.locator('#puzzle-board [data-square="f7"]').click();
      const result = await (await response).json();
      assert(result.accepted && result.reply_step);
      await page.waitForFunction(() => Boolean(pendingPrediction));
      const state = await page.evaluate(() => {
        const box = (id) => {
          const el = document.querySelector(id),
            r = el.getBoundingClientRect();
          return {
            top: r.top,
            bottom: r.bottom,
            visible: r.top >= 0 && r.bottom <= innerHeight,
          };
        };
        return {
          busy: boards.puzzle.busy,
          start: boards.puzzle.fen,
          message: document.querySelector("#puzzle-message").textContent,
          turn: document.querySelector("#puzzle-turn").textContent,
          prediction: box("#prediction-card"),
          feedback: box("#puzzle-board-feedback"),
          replyAction: box("#puzzle-flip"),
        };
      });
      assert(
        state.feedback.visible,
        "Move feedback must be visible at the board",
      );
      assert(
        state.replyAction.visible,
        "Show reply must be visible without scrolling",
      );
      if (viewport.width > 1000)
        assert(
          state.prediction.visible,
          "Desktop prediction must fit the fixed coach slot",
        );
      await page.screenshot({
        path: `/tmp/chess-puzzle-stall-${viewport.width}.png`,
        fullPage: true,
      });
      assert.notEqual(state.start, start);
      assert.match(
        state.turn,
        /predict|reply/i,
        "The board must explain why the opponent is waiting",
      );
      assert(
        (await page.locator("#puzzle-flip").getAttribute("data-action")) ===
          "reply",
        "A reply action must be available beside the board",
      );
      const replyBox = await page.locator("#puzzle-flip").boundingBox();
      await page.mouse.click(
        replyBox.x + replyBox.width / 2,
        replyBox.y + replyBox.height / 2,
      );
      await page.waitForFunction(
        () => !boards.puzzle.busy && !pendingPrediction,
      );
      assert.equal(
        await page.evaluate(() => boards.puzzle.fen),
        result.board.fen,
      );
      assert(await page.evaluate(() => canInteract("puzzle")));
      // Skip also works on the first click while the prediction is waiting.
      await page.evaluate(async () => {
        await startPosition("lichess-fork", 0, true);
        dailyMode = true;
        trainingReview = true; // This case deliberately replays the same fixtures.
        trainingQueue = [currentPuzzle.id, "lichess-queen-sacrifice"];
        sessionCursor = 0;
      });
      await page.locator('#puzzle-board [data-square="e5"]').click();
      await page.locator('#puzzle-board [data-square="f7"]').click();
      await page.waitForFunction(() => Boolean(pendingPrediction));
      await page.route("**/api/drills", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1800));
        await route.continue();
      });
      await page.locator("#next-puzzle").click();
      await page.waitForFunction(() => drillLoading && !pendingPrediction);
      await page.waitForTimeout(1450);
      assert(
        await page.evaluate(() => boards.puzzle.busy),
        "A skipped prediction must not unlock the new request",
      );
      await page.waitForFunction(
        () =>
          !boards.puzzle.busy &&
          !drillLoading &&
          activeDrill &&
          currentPuzzle.id !== "lichess-fork",
      );
      await page.unroute("**/api/drills");
      // Standard practice replies automatically; no hidden prediction can block it.
      await page.evaluate(async () => {
        dailyMode = false;
        trainingReview = false;
        await startPosition("lichess-fork", 0, true);
      });
      await page
        .locator("#puzzle-board")
        .locator("..")
        .scrollIntoViewIfNeeded();
      await page.locator('#puzzle-board [data-square="e5"]').click();
      await page.locator('#puzzle-board [data-square="f7"]').click();
      await page.waitForFunction(
        () => !boards.puzzle.busy && activeDrill.turns === 1,
      );
      assert.equal(
        await page.evaluate(() => boards.puzzle.fen),
        result.board.fen,
      );
      assert.equal(await page.evaluate(() => pendingPrediction), null);
      // Finish the actual continuation and check default automatic explanation.
      await page.locator('#puzzle-board [data-square="f7"]').click();
      await page.locator('#puzzle-board [data-square="d8"]').click();
      await page.waitForFunction(() => puzzleSolved && !boards.puzzle.busy);
      await page.waitForFunction(
        () => visualLesson?.name === "puzzle" && visualLesson.automatic,
        {},
        { timeout: 30000 },
      );
      await page.locator("#next-puzzle").click();
      await page.waitForFunction(
        () =>
          !visualLesson && !boards.puzzle.busy && !puzzleSolved && activeDrill,
      );
      // A delayed replacement of a rejected puzzle must not overwrite a newer board.
      await page.route("**/api/drills", async (route) => {
        if (route.request().postDataJSON().id === "lichess-queen-sacrifice")
          await route.fulfill({
            status: 422,
            json: { error: { message: "Choose a clearer position" } },
          });
        else await route.continue();
      });
      await page.evaluate(() => {
        window.savedRefreshPractice = refreshPractice;
        refreshPractice = () =>
          new Promise((resolve) => {
            window.releaseReplacement = resolve;
          });
        window.replacingPuzzle = startPosition(
          "lichess-queen-sacrifice",
          0,
          true,
        );
      });
      await page.waitForFunction(() => Boolean(window.releaseReplacement));
      await page.evaluate(async () => {
        await startPosition("lichess-fork", 0, true);
      });
      const freshSession = await page.evaluate(() => activeDrill.session);
      await page.evaluate(async () => {
        releaseReplacement();
        await replacingPuzzle;
        refreshPractice = savedRefreshPractice;
      });
      assert.equal(await page.evaluate(() => currentPuzzle.id), "lichess-fork");
      assert.equal(
        await page.evaluate(() => activeDrill.session),
        freshSession,
      );
      await page.unroute("**/api/drills");
      // Rejected moves and service errors must not fail silently below the board.
      await page.evaluate(async () => {
        await startPosition("lichess-fork", 0, true);
      });
      await page
        .locator("#puzzle-board")
        .locator("..")
        .scrollIntoViewIfNeeded();
      await page.locator('#puzzle-board [data-square="e5"]').click();
      await page.locator('#puzzle-board [data-square="d3"]').click();
      await page.waitForFunction(
        () => !boards.puzzle.busy && activeDrill.revision === 1,
      );
      assert.equal(await page.evaluate(() => boards.puzzle.fen), start);
      assert.match(
        await page.locator("#puzzle-board-feedback").textContent(),
        /try again/i,
      );
      assert(await page.evaluate(() => canInteract("puzzle")));
      await page.route("**/api/drills/*/moves", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        await route.fulfill({
          status: 503,
          json: {
            error: { message: "Engine is temporarily unavailable. Try again." },
          },
        });
      });
      await page.locator('#puzzle-board [data-square="e5"]').click();
      await page.locator('#puzzle-board [data-square="f7"]').click();
      await page.waitForFunction(
        () =>
          boards.puzzle.busy &&
          document.querySelector("#puzzle-board").getAttribute("aria-busy") ===
            "true",
      );
      assert.match(
        await page.locator("#puzzle-turn").textContent(),
        /checking/i,
      );
      await page.waitForFunction(() => !boards.puzzle.busy);
      assert.match(
        await page.locator("#puzzle-board-feedback").textContent(),
        /temporarily unavailable/i,
      );
      assert(await page.evaluate(() => canInteract("puzzle")));
      console.log(
        `PASS ${viewport.width}px: visible daily reply action, automatic standard replies, completion narration, next puzzle, rejected moves and request recovery`,
      );
      await page.close();
      assert.deepEqual(errors, []);
    }
  } catch (error) {
    if (activePage && !activePage.isClosed()) {
      console.error(
        await activePage.evaluate(() => ({
          fen: boards.puzzle.fen,
          legal: boards.puzzle.legal,
          busy: boards.puzzle.busy,
          selected: boards.puzzle.selected,
          drill: activeDrill,
          loading: drillLoading,
          puzzle: currentPuzzle?.id,
          version: puzzleVersion,
          dailyMode,
          quiz: Boolean(pendingPrediction),
          lesson: visualLesson?.name,
          message: document.querySelector("#puzzle-message").textContent,
        })),
      );
      await activePage.screenshot({
        path: "/tmp/chess-puzzle-flow-failure.png",
        fullPage: true,
      });
    }
    throw error;
  } finally {
    await browser?.close();
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
