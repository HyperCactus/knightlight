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
  path.join(root, "data/puzzle-bank.json"),
  path.join(dir, "data/puzzle-bank.json"),
);
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
      args: ["--mute-audio"],
      ...(process.env.CHESS_TEST_BROWSER
        ? { executablePath: process.env.CHESS_TEST_BROWSER }
        : {}),
    });
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1100 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() =>
      localStorage.setItem(
        "chess-preferences",
        JSON.stringify({ voice: false, predict: false }),
      ),
    );
    await page.goto(base);
    await page.waitForFunction(
      () => data?.ready && activeDrill && !boards.puzzle.busy && practiceData,
      {},
      { timeout: 60000 },
    );
    await page.locator('[data-page="puzzles"]').click();
    let collection;
    for (let n = 0; n < 300; n++) {
      collection = await get("practice");
      if (collection.pool_ready) break;
      await page.waitForTimeout(50);
    }
    assert(collection.pool_ready, "Offline collection did not finish loading");
    assert(collection.pool_size >= 100000);
    const seen = new Set();
    for (let n = 0; n < 10; n++) {
      const board = await page.evaluate(() =>
        boards.puzzle.fen.split(" ").slice(0, 4).join(" "),
      );
      assert(!seen.has(board), "A skipped board repeated");
      seen.add(board);
      const id = await page.evaluate(() => currentPuzzle.id);
      await page.locator("#next-puzzle").click();
      await page.waitForFunction(
        (id) => activeDrill && currentPuzzle.id !== id && !boards.puzzle.busy,
        id,
        { timeout: 60000 },
      );
    }
    await page.reload();
    await page.waitForFunction(
      () => data?.ready && activeDrill && !boards.puzzle.busy,
      {},
      { timeout: 60000 },
    );
    assert(
      !seen.has(
        await page.evaluate(() =>
          boards.puzzle.fen.split(" ").slice(0, 4).join(" "),
        ),
      ),
    );
    await page.locator('[data-page="puzzles"]').click();
    await page.locator("#training-focus").selectOption("Pins");
    await page.waitForFunction(
      () =>
        activeDrill && currentPuzzle.theme === "Pins" && !boards.puzzle.busy,
      {},
      { timeout: 60000 },
    );
    const solved = await page.evaluate(() => currentPuzzle.id);
    for (let n = 0; n < 5; n++) {
      if (await page.evaluate(() => puzzleSolved)) break;
      await page.evaluate(async () => {
        const u = currentPuzzle.best;
        await movePiece("puzzle", u.slice(0, 2), u.slice(2, 4));
      });
    }
    assert(await page.evaluate(() => puzzleSolved));
    await page.locator("#training-review").click();
    await page.waitForFunction(
      (id) =>
        trainingReview &&
        activeDrill &&
        currentPuzzle.id === id &&
        !boards.puzzle.busy,
      solved,
      { timeout: 60000 },
    );
    await page.locator("#training-review").click();
    await page.waitForFunction(
      (id) =>
        !trainingReview &&
        activeDrill &&
        currentPuzzle.id !== id &&
        !boards.puzzle.busy,
      solved,
      { timeout: 60000 },
    );
    assert.equal(
      await page.locator("#training-review").textContent(),
      "Review learned positions",
    );
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: "/tmp/chess-fresh-puzzles.png",
      fullPage: true,
    });
    console.log(
      "PASS 100,000-puzzle bank, ten unique skips, fresh reload, targeted focus, complete tactical line and explicit learned-position review",
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
