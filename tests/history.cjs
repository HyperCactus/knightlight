const { chromium, devices } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chess-history-"));
for (const folder of ["static", "scripts", "vendor"])
  fs.symlinkSync(path.join(root, folder), path.join(dir, folder));
fs.mkdirSync(path.join(dir, "data"));
fs.symlinkSync(
  path.join(root, "data/openings"),
  path.join(dir, "data/openings"),
);
function pgn(date, rating, event = "History fixture") {
  return `[Event "${event}"]\n[White "Tester"]\n[Black "Other"]\n[WhiteElo "${rating}"]\n[BlackElo "1300"]\n[Date "${date}"]\n[Result "0-1"]\n[Annotator "Preserved tag"]\n\n1. f3 {comment} e5 (1... d5) 2. g4 Qh4# 0-1\n\n`;
}
fs.writeFileSync(
  path.join(dir, "fixture.pgn"),
  pgn("2026.11.06", 1600) + pgn("2026.10.23", 1000),
);
const port = require("./support.cjs").allocatePort(),
  base = `http://127.0.0.1:${port}`;
let server,
  browser,
  logs = "";
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
  const stopped = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await stopped;
  server = null;
}
async function until(fn, timeout = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timed out. " + logs);
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
// Independent direct-weight calculation, rather than reproducing the running-sum algorithm.
function expected(games) {
  const rows = games
    .filter((g) => g.result !== "*" && g.white === "Tester")
    .map((g) => ({
      day: Date.parse(
        g.played_at
          ? new Date(Date.parse(g.played_at) + 10 * 3600000)
              .toISOString()
              .slice(0, 10)
          : g.date.replaceAll(".", "-"),
      ),
      sample: g.rating_sample ?? g.white_elo,
    }))
    .filter((g) => Number.isFinite(g.day) && g.sample != null);
  const latest = Math.max(...rows.map((g) => g.day));
  const weights = rows.map((g) => 2 ** (-(latest - g.day) / (14 * 86400000)));
  return Math.round(
    rows.reduce((sum, g, i) => sum + g.sample * weights[i], 0) /
      weights.reduce((a, b) => a + b, 0),
  );
}
(async () => {
  try {
    launch();
    await until(async () => (await get("data")).ready);
    assert.equal((await get("profile")).practice_rating, 1400);
    assert.equal((await get("profile")).rating_half_life_days, 14);
    // Import dates deliberately out of order. An undated game is kept but cannot affect recency.
    const imported = await post("imports", {
      pgn:
        pgn("2026.11.20", 2200) +
        pgn("2026.10.09", 400) +
        pgn("????.??.??", 3000),
    });
    assert.equal(imported.imported, 3);
    assert.equal((await get("profile")).rating_samples, 4);
    assert.equal(
      (await get("profile")).practice_rating,
      expected((await get("data")).games),
    );
    const duplicate = await post("imports", { pgn: pgn("2026.11.20", 2200) });
    assert.equal(duplicate.duplicates, 1);
    assert.equal(duplicate.imported, 0);
    const normalizedDuplicate = pgn("2026-11-20", 1800, "Different export metadata")
      .replace('[White "Tester"]', '[White "tester"]')
      .replace('[Black "Other"]', '[Black "OTHER"]');
    const repeatedBatch = await post("imports", { pgn: normalizedDuplicate + pgn("2026.11.20", 2200) });
    assert.equal(repeatedBatch.imported, 0);
    assert.equal(repeatedBatch.duplicates, 2);
    assert.equal((await get("data")).games.length, 5);
    await post(
      "imports",
      { pgn: '[White "Tester"]\n[Black "Other"]\n\n1. e4 e5 2. Ke3 *' },
      400,
    );
    assert.equal((await get("data")).games.length, 5);
    const mixed = await post("imports", {
      pgn:
        pgn("2026.11.20", 2200) +
        '[White "Tester"]\n[Black "Other"]\n\n1. e4 e5 2. Ke3 *',
    });
    assert.equal(mixed.duplicates, 1);
    assert.equal(mixed.rejected.length, 1);
    console.log(
      "PASS date-weighted score, shuffled imports, undated exclusion, duplicate handling and whole-game rejection",
    );
    const downloaded = await fetch(base + "/api/games/pgn");
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get("content-disposition"), /attachment/);
    const all = await downloaded.text();
    assert.match(all, /\[Annotator "Preserved tag"\]/);
    assert.match(all, /2\. g4 Qh4# 0-1/);
    assert.equal((await post("imports", { pgn: all })).duplicates, 5);
    assert.equal((await fetch(base + "/api/games/999/pgn")).status, 404);
    console.log(
      "PASS portable SAN exports with original headers, legal round-trip and duplicate detection",
    );
    browser = await chromium.launch({
      args: ["--mute-audio", "--enable-automation"],
      headless: true,
      ...(process.env.CHESS_TEST_BROWSER
        ? { executablePath: process.env.CHESS_TEST_BROWSER }
        : {}),
    });
    const command = await (await browser.newBrowserCDPSession()).send("Browser.getBrowserCommandLine");
    assert(command.arguments.includes("--mute-audio"));
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1050 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(
      () => data?.ready && activeDrill && !boards.puzzle.busy,
    );
    await page.locator('[data-page="games"]').click();
    assert.deepEqual(await page.locator("#review-select option").evaluateAll(options => options.map(o => Number(o.value))), [2, 0, 1, 3, 4]);
    const sourceOrder = await page.evaluate(() => data.games.map(g => g.date));
    assert.deepEqual(sourceOrder, ["2026.11.06", "2026.10.23", "2026.11.20", "2026.10.09", "????.??.??"], "Sorting must preserve game IDs");
    const mixedOrder = await page.evaluate(() => reviewLibraryEntries([
      { date: "2026.11.21", played_at: "2026-11-21T00:30:00+10:00" },
      { date: "2026.11.21", tags: { UTCDate: "2026.11.20", UTCTime: "16:00:00" } },
      { date: "2026-11-21", tags: { Time: "03:00:00" } },
      { date: "????.??.??" },
      { date: "2026-11-22" },
      { date: "2026.11.??" },
      { date: "2026.02.30" },
    ]).map(entry => entry.index));
    assert.deepEqual(mixedOrder, [4, 2, 1, 0, 6, 5, 3]);
    await page.locator('#review-select').selectOption('2');
    await page.waitForFunction(() => currentReviewGame === 2 && currentReview?.moves.length === 4);
    assert.equal(await page.locator("#review-select").inputValue(), "2");
    await until(async () => await page.locator('#game-list .current-game').getAttribute('data-game-index') === '2');
    assert.match(await page.locator("#export-game").getAttribute("href"), /\/2\/pgn$/);
    console.log("PASS newest-first library, same-day timestamps, unknown dates last, stable IDs and correct selection/export");
    await page.locator("#pgn-files").setInputFiles({
      name: "new-game.pgn",
      mimeType: "application/x-chess-pgn",
      buffer: Buffer.from(pgn("2026.11.21", 2000, "Browser import")),
    });
    await page.waitForFunction(() =>
      document
        .querySelector("#library-status")
        .textContent.includes("1 imported"),
    );
    await page.waitForFunction(
      () =>
        currentReview?.moves.length &&
        data.games[gameIndex].event === "Browser import",
    );
    assert.match(
      await page.locator("#review-subtitle").textContent(),
      /Browser import/,
    );
    assert.equal(await page.locator("#review-select option").count(), 6);
    assert.equal(await page.locator("#review-select option").first().getAttribute("value"), "5");
    assert.match(await page.locator('#review-select option[value="5"]').textContent(), /Imported/);
    const downloadEvent = page.waitForEvent("download");
    await page.locator("#export-game").click();
    const file = await downloadEvent;
    assert.match(file.suggestedFilename(), /\.pgn$/);
    assert.match(fs.readFileSync(await file.path(), "utf8"), /Browser import/);
    await page.screenshot({
      path: "/tmp/chess-history-library.png",
      fullPage: true,
    });
    await page.locator('[data-page="play"]').click();
    const beforeRating = (await get("profile")).practice_rating;
    await page.locator('#play-board [data-square="e2"]').click();
    await page.locator('#play-board [data-square="e4"]').click();
    await page.waitForFunction(
      () => !botBusy && !boards.play.busy && playedMoves.length === 2,
    );
    await until(async () =>
      (await get("data")).games.some(
        (g) => g.source === "practice" && g.moves.length === 2,
      ),
    );
    await page.waitForFunction(() =>
      document
        .querySelector("#history-save-status")
        .textContent.includes("in progress"),
    );
    const running = (await get("data")).games.find(
      (g) => g.source === "practice",
    );
    assert.equal(running.result, "*");
    assert(running.played_at);
    assert.equal((await get("profile")).practice_rating, beforeRating);
    await page.locator('[data-page="games"]').click();
    await page
      .locator("#review-select")
      .selectOption(String((await get("data")).games.length - 1));
    await page.waitForFunction(
      () =>
        currentReview?.moves.length === 2 &&
        data.games[gameIndex].source === "practice",
    );
    await page.locator('[data-page="play"]').click();
    await page.evaluate(() => ($("#game-options").open = true));
    await page.locator("#resign-game").click();
    await until(async () =>
      (await get("data")).games.some(
        (g) => g.session_id === running.session_id && g.result === "0-1",
      ),
    );
    const complete = (await get("data")).games.find(
      (g) => g.session_id === running.session_id,
    );
    assert(complete.rating_sample);
    assert.equal(complete.moves.length, 2);
    assert.equal(
      (await get("profile")).practice_rating,
      expected((await get("data")).games),
    );
    console.log(
      "PASS browser import and selected export; bot moves automatically create reviewable history, resignation updates the score",
    );
    // Separate actual sessions with identical moves/results must not collapse at restart.
    for (const id of ["identical-one", "identical-two"]) {
      await post("games", {
        white: "Tester",
        black: "Bot",
        result: "1/2-1/2",
        date: "2026.11.07",
        event: "Test",
        moves: ["e2e4", "e7e5"],
        session_id: id,
        opponent_rating: 1400,
        played_at: "2026-11-07T00:00:00Z",
        analyze: false,
      });
    }
    const finalData = await get("data"),
      finalProfile = await get("profile");
    assert.equal(finalData.games.length, 9);
    const botExport = await (await fetch(base + "/api/games/pgn")).text();
    assert.match(botExport, /ChessStudyRating/);
    assert.match(botExport, /ChessStudySession/);
    assert.equal((await post("imports", { pgn: botExport })).duplicates, 9);
    await stop();
    launch();
    await until(async () => (await get("data")).ready);
    assert.equal((await get("data")).games.length, 9);
    assert.equal(
      (await get("profile")).practice_rating,
      finalProfile.practice_rating,
    );
    assert.equal(
      (await get("profile")).rating_samples,
      finalProfile.rating_samples,
    );
    assert.equal(finalProfile.practice_rating, expected(finalData.games));
    assert.deepEqual(errors, []);
    console.log(
      "PASS imports, distinct bot sessions and weighted score persist across restart without double counting",
    );
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const phone = await context.newPage();
    await phone.goto(base);
    await phone.waitForFunction(() => data?.ready);
    await phone.locator('[data-page="games"]').tap();
    assert(await phone.locator("#import-pgn").isVisible());
    assert(await phone.locator("#export-library").isVisible());
    assert(
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await phone.screenshot({
      path: "/tmp/chess-history-mobile.png",
      fullPage: true,
    });
    console.log("PASS mobile import/export controls without overflow");
    // A multi-game file is intentionally oldest first. Open its newest game and
    // show every imported entry immediately, not the first record in the file.
    if (await page.locator('#game-over-dialog').evaluate(dialog => dialog.open))
      await page.locator('#result-back-board').click();
    await page.locator('[data-page="games"]').click();
    await page.locator("#pgn-files").setInputFiles({
      name: "two-more.pgn", mimeType: "application/x-chess-pgn",
      buffer: Buffer.from(pgn("2026.11.19", 1500, "Older batch game") + pgn("2026.11.22", 1700, "Newest batch game")),
    });
    await page.waitForFunction(() => document.querySelector("#library-status").textContent.includes("2 imported") && data.games[gameIndex].event === "Newest batch game");
    assert.equal(await page.locator("#review-select option").count(), 11);
    assert.equal(await page.locator("#review-select option").first().getAttribute("value"), "10");
    assert.equal(await page.locator("#review-select").inputValue(), "10");
    assert.equal(await page.locator('#review-select option[value="9"]').count(), 1);
    console.log("PASS batch import appears immediately with newest imported game selected");
  } finally {
    await browser?.close();
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
