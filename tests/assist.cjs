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

async function checkMap(page, name, ours) {
  await page.waitForFunction(
    (name) =>
      document.querySelector(`#${name}-board`).dataset.assistStatus === "ready",
    name,
  );
  const actual = await page.evaluate(
    (name) => ({
      fen: boards[name].fen,
      map: Object.fromEntries(
        [...document.querySelectorAll(`#${name}-board > .square`)].map((sq) => [
          sq.dataset.square,
          sq.dataset.assist || "",
        ]),
      ),
    }),
    name,
  );
  const { threats } = await post("board", { fen: actual.fen });
  const own = new Set(threats[ours]),
    enemy = new Set(threats[ours === "white" ? "black" : "white"]);
  for (const [square, kind] of Object.entries(actual.map))
    assert.equal(
      kind,
      own.has(square)
        ? enemy.has(square)
          ? "both"
          : "you"
        : enemy.has(square)
          ? "opponent"
          : "",
      `${name} control on ${square}`,
    );
  return actual.map;
}
async function wrong(page, revision) {
  await page.locator('#puzzle-board [data-square="e5"]').click();
  await page.locator('#puzzle-board [data-square="d3"]').click();
  await page.waitForFunction(
    (revision) => !boards.puzzle.busy && activeDrill.revision === revision,
    revision,
  );
}
(async () => {
  try {
    launch();
    await until(async () => (await get("data")).ready);
    const launchOptions = {
      headless: true,
      args: ["--mute-audio"],
      ...(process.env.CHESS_TEST_BROWSER
        ? { executablePath: process.env.CHESS_TEST_BROWSER }
        : {}),
    };
    assert(launchOptions.args.includes("--mute-audio"));
    browser = await chromium.launch(launchOptions);
    for (const viewport of [
      { width: 1440, height: 1100 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => {
        if (!localStorage.getItem("chess-preferences"))
          localStorage.setItem(
            "chess-preferences",
            JSON.stringify({ voice: false, predict: false, coach: false }),
          );
      });
      await page.goto(base);
      await page.waitForFunction(
        () => data?.ready && practiceData && !boards.puzzle.busy,
      );
      await page.locator('[data-page="play"]').click();
      assert.equal(await page.evaluate(() => preferences.assist), false);
      // Position the toggle clear of the fixed mobile navigation, then use a
      // physical click so Playwright's automatic scrolling cannot mask a shift.
      await page
        .locator("#play-assist")
        .evaluate((el) =>
          el.scrollIntoView({ block: "center", behavior: "instant" }),
        );
      const box = await page.locator("#play-board").boundingBox();
      const toggleBox = await page.locator("#play-assist").boundingBox();
      await page.mouse.click(
        toggleBox.x + toggleBox.width / 2,
        toggleBox.y + toggleBox.height / 2,
      );
      await checkMap(page, "play", "white");
      assert.deepEqual(
        await page.locator("#play-board").boundingBox(),
        box,
        "Assist must not move the board",
      );
      await page.locator('#play-board [data-square="e2"]').click();
      await page.locator("#play-assist").click();
      assert.equal(await page.evaluate(() => boards.play.selected), "e2");
      assert.equal(await page.locator("#play-board [data-assist]").count(), 0);
      await page.evaluate(() => {
        boards.play.busy = true;
        renderBoard("play");
      });
      await page.locator("#play-assist").click();
      assert(await page.evaluate(() => boards.play.busy));
      assert.equal(await page.evaluate(() => boards.play.selected), "e2");
      await page.evaluate(() => {
        boards.play.busy = false;
        renderBoard("play");
      });
      const mapping = await checkMap(page, "play", "white");
      await page.locator("#play-flip").click();
      assert.deepEqual(
        await checkMap(page, "play", "white"),
        mapping,
        "Flipping must not swap the teams",
      );
      await page.locator('[data-page="puzzles"]').click();
      await page.evaluate(async () => {
        dailyMode = false;
        await startPosition("lichess-fork", 0, true);
      });
      await page.locator("#puzzle-assist").click(); // Turn the manual preference off.
      for (let n = 1; n <= 3; n++) {
        await wrong(page, n);
        assert.equal(
          await page.evaluate(() => assistEnabled("puzzle")),
          n === 3,
        );
      }
      assert.equal(
        await page.evaluate(() => preferences.assist),
        false,
        "Automatic help must not change the saved preference",
      );
      await checkMap(page, "puzzle", "white");
      await page.locator("#puzzle-assist").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `/tmp/chess-assist-${viewport.width}.png`,
        fullPage: true,
      });
      await page.locator("#puzzle-assist").click();
      assert.match(
        await page.locator("#puzzle-message").textContent(),
        /assist is off/i,
      );
      await wrong(page, 4);
      assert.equal(
        await page.evaluate(() => assistEnabled("puzzle")),
        false,
        "A fourth miss must respect the user's Off choice",
      );
      await page.locator('#puzzle-board [data-square="e5"]').click();
      await page.locator('#puzzle-board [data-square="f7"]').click();
      await page.waitForFunction(
        () => !boards.puzzle.busy && activeDrill.turns === 1,
      );
      assert.equal(await page.evaluate(() => puzzleWrongStreak), 0);
      await page.evaluate(async () => {
        await startPosition("lichess-fork", 0, true);
      });
      for (let n = 1; n <= 3; n++) await wrong(page, n);
      assert(await page.evaluate(() => puzzleAutoAssist));
      await page.evaluate(async () => {
        await startPosition("lichess-black-mates", 0, true);
      });
      assert.equal(
        await page.evaluate(() => assistEnabled("puzzle")),
        false,
        "A new puzzle starts with the user's preference",
      );
      assert.equal(await page.evaluate(() => puzzleWrongStreak), 0);
      await page.locator("#puzzle-assist").click();
      const blackMap = await checkMap(page, "puzzle", "black");
      await page.locator("#puzzle-flip").click();
      assert.deepEqual(await checkMap(page, "puzzle", "black"), blackMap);
      // Hold an unfamiliar diagram's map, then return to the cached board.
      // Its late response must never paint the wrong position or cancel a lesson.
      const target =
        "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
      let release;
      await page.route("**/api/board", async (route) => {
        if (route.request().postDataJSON().fen === target)
          await new Promise((resolve) => {
            release = resolve;
          });
        await route.continue();
      });
      await page.evaluate((target) => {
        window.assistLessonRecord = {
          evidence: [
            {
              title: "Current position",
              theme: "Piece activity",
              text: "Look at the controlled squares.",
              fen: boards.puzzle.fen,
              squares: [],
              arrows: [],
            },
            {
              title: "Pawn control",
              theme: "Piece activity",
              text: "Compare the pawn diagonals.",
              fen: target,
              squares: [],
              arrows: [],
            },
          ],
        };
        startVisualLesson("puzzle", assistLessonRecord, false);
        visualLesson.paused = true;
        lessonStep(1);
      }, target);
      await until(() => Boolean(release));
      await page.evaluate(() => {
        lessonStep(0);
      });
      release();
      await page.waitForTimeout(350);
      await checkMap(page, "puzzle", "black");
      await page.evaluate(() => {
        lessonStep(1);
      });
      await checkMap(page, "puzzle", "black");
      await page.evaluate(() => {
        lessonStep(0);
      });
      await page.locator("#puzzle-assist").click();
      assert(
        await page.evaluate(() => visualLesson?.record === assistLessonRecord),
      );
      await page.locator("#puzzle-assist").click();
      assert(
        await page.evaluate(() => visualLesson?.record === assistLessonRecord),
      );
      await page.locator("#puzzle-lesson-player .lesson-return").click();
      await checkMap(page, "puzzle", "black");
      await page.unroute("**/api/board");
      await page.locator('[data-page="settings"]').click();
      assert(await page.locator("#pref-assist").isChecked());
      await page.locator("#pref-assist").uncheck();
      assert.equal(await page.evaluate(() => assistEnabled("puzzle")), false);
      await page.locator("#pref-assist").check();
      // Review maps follow the recorded player's colour too.
      await page.locator('[data-page="games"]').click();
      await page.waitForFunction(() => currentReview?.moves.length);
      await page.evaluate(() => {
        data.games[gameIndex].black = data.player;
        data.games[gameIndex].white = "Other";
        renderAssist("game");
      });
      await checkMap(page, "game", "black");
      await page.reload();
      await page.waitForFunction(
        () => data?.ready && practiceData && !boards.puzzle.busy,
      );
      assert(await page.evaluate(() => preferences.assist));
      await page.locator('[data-page="play"]').click();
      await checkMap(page, "play", "white");
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      assert.deepEqual(errors, []);
      await page.close();
      console.log(
        `PASS ${viewport.width}px: exact team maps, overlap, flips, manual toggle/selection/busy/lesson safety, 3-miss activation, reset, opt-out, settings, persistence and stale-response safety`,
      );
    }
  } finally {
    await browser?.close();
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
