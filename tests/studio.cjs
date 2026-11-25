const { chromium, devices } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "chess-studio-"));
for (const folder of ["static", "scripts", "vendor"])
  fs.symlinkSync(path.join(root, folder), path.join(dir, folder));
fs.mkdirSync(path.join(dir, "data"));
fs.symlinkSync(
  path.join(root, "data/openings"),
  path.join(dir, "data/openings"),
);
fs.writeFileSync(
  path.join(dir, "fixture.pgn"),
  `[Event "Training test"]
[White "Tester"]
[Black "OpponentOne"]
[Result "1-0"]
[Date "2026.11.06"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0

[Event "Training test"]
[White "Tester"]
[Black "OpponentTwo"]
[Result "0-1"]
[Date "2026.11.06"]

1. f3 e5 2. g4 Qh4# 0-1
`,
);
const port = require("./support.cjs").allocatePort(),
  base = "http://127.0.0.1:" + port;
const server = spawn(path.join(root, "target/release/chess-study"), [], {
  cwd: dir,
  env: { ...process.env, PORT: String(port) },
});
let serverLogs = "";
server.stderr.on("data", (b) => (serverLogs += b));
server.stdout.on("data", (b) => (serverLogs += b));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if (await fn()) return;
    } catch {}
    await wait(150);
  }
  throw Error("Timed out. " + serverLogs);
}
async function post(route, body) {
  const r = await fetch(base + "/api/" + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
(async () => {
  let browser;
  try {
    await until(async () => {
      const r = await fetch(base + "/api/data");
      return (await r.json()).ready;
    });
    const data = await (await fetch(base + "/api/data")).json();
    assert.equal(data.games.length, 2);
    assert.equal(data.error, null);
    const review = await (await fetch(base + "/api/reviews/1")).json();
    assert.equal(review.moves.length, 4);
    assert.equal(review.moves[2].grade, "blunder");
    assert.match(review.moves[2].explanation, /mate/);
    for (const m of review.moves) {
      const board = await post("board", { fen: m.before });
      assert(board.legal.includes(m.best));
      assert(board.legal.includes(m.uci));
    }
    const opening = await post("opening", {
      moves: ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"],
    });
    assert.match(opening.opening.name, /Ruy Lopez/);
    assert(opening.entries > 3000);
    const profile = await (await fetch(base + "/api/profile")).json();
    assert(profile.samples > 0);
    assert(profile.voice_available);
    console.log(
      "PASS complete game reviews, mate explanation, legal alternatives, opening reference, trained profile",
    );
    const invalid = await fetch(base + "/api/coach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen: "bad fen" }),
    });
    assert.equal(invalid.status, 400);
    const foreign = await fetch(base + "/api/profile", {
      headers: { Origin: "https://example.com" },
    });
    assert.equal(foreign.status, 403);
    const rebound = await new Promise((resolve, reject) => {
      const r = require("node:http").get(
        base + "/api/profile",
        { headers: { Host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      r.on("error", reject);
    });
    assert.equal(rebound, 403);
    const missing = await fetch(base + "/api/reviews/999");
    assert.equal(missing.status, 404);
    const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const styles = new Set(),
      choices = new Set();
    for (let i = 0; i < 8; i++) {
      const b = await post("bot", {
        fen: start,
        skill: 3,
        style: "varied",
        moves: [],
      });
      assert.equal(b.level, 3);
      styles.add(b.style);
      choices.add(b.move);
    }
    assert(styles.size > 1);
    assert(choices.size > 1);
    console.log("PASS varied legal bot choices and manual strength");
    const text =
      "Your queen is active, but your king needs care. Before moving, look for checks, captures, and threats.";
    const t = Date.now(),
      speech = await post("speech", { text });
    const wav = Buffer.from(
      await (await fetch(base + speech.url)).arrayBuffer(),
    );
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert(wav.length > 10000);
    const first = Date.now() - t,
      again = Date.now();
    const cached = await post("speech", { text });
    assert.equal(cached.url, speech.url);
    console.log(
      `PASS local neural speech: ${wav.length} bytes; cold ${first}ms; cache ${Date.now() - again}ms`,
    );
    browser = await chromium.launch({
      args: ["--mute-audio"],
      headless: true,
      ...(process.env.CHESS_TEST_BROWSER
        ? { executablePath: process.env.CHESS_TEST_BROWSER }
        : {}),
    });
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(() => data?.ready);
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page.locator('[data-page="games"]').click();
    await page.locator("#review-select").selectOption("1");
    await page.waitForFunction(
      () => currentReviewGame === 1 && currentReview?.moves.length === 4,
    );
    await page.locator("#review-blunder").click();
    await page.waitForFunction(() => !reviewPlayback.seeking);
    assert.match(await page.locator("#review-grade").textContent(), /BLUNDER/);
    assert.equal(
      await page.locator("#game-board .move-badge.blunder").count(),
      1,
    );
    assert.match(
      await page.locator("#review-explanation").textContent(),
      /mate/,
    );
    await page.locator("#review-best").click();
    assert.equal(await page.locator("#game-board .board-arrow").count(), 1);
    await page.locator(".pv-move").first().click();
    await page.locator("#variation-close").click();
    await page.locator("#review-reply").click();
    assert.equal(await page.locator("#game-board .board-arrow").count(), 1);
    await page.locator("#variation-close").click();
    assert.equal(await page.locator("#eval-chart svg").count(), 1);
    console.log(
      "PASS review navigation, blunder badge, evaluation graph and playable alternative lines",
    );
    await page.screenshot({
      path: "/tmp/chess-review-dark.png",
      fullPage: true,
    });
    await page.locator('[data-page="play"]').click();
    await page.locator("#match-settings summary").click();
    await page.locator("#difficulty").selectOption("manual");
    await page.locator("#bot-rating").fill("1600");
    await page.locator("#bot-rating").dispatchEvent("input");
    await page.locator("#play-style").selectOption("attacking");
    const when = Date.now();
    await page.locator('#play-board [data-square="e2"]').click();
    await page.locator('#play-board [data-square="e4"]').click();
    await page.waitForFunction(
      () =>
        !botBusy &&
        !boards.play.busy &&
        playedMoves.length === 2 &&
        lastCoach !== null,
    );
    assert(Date.now() - when >= 900);
    assert.match(
      await page.locator("#bot-level").textContent(),
      /MANUAL.*1,600/,
    );
    assert.match(
      await page.locator("#bot-style-label").textContent(),
      /Attacking/,
    );
    assert.equal(await page.evaluate(() => audioContext.state), "running");
    assert(
      (await page.locator("#coach-explanation").textContent()).length > 70,
    );
    await page.locator("#coach-best").click();
    assert.equal(await page.locator("#play-board .board-arrow").count(), 1);
    assert.equal(await page.locator("#new-game").isDisabled(), true);
    await page.locator("#coach-resume").click();
    await page.locator("#coach-speak").click();
    await page.waitForFunction(
      () => speechAudio && speechAudio.readyState >= 2 && !speechAudio.paused,
      {},
      { timeout: 20000 },
    );
    assert.equal(await page.evaluate(() => visualLesson?.name), "play");
    assert(await page.locator("#play-board.narrating .fact-square").count());
    await page
      .locator("#play-lesson-player")
      .getByText("Pause voice", { exact: true })
      .click();
    assert(await page.evaluate(() => speechAudio.paused));
    await page
      .locator("#play-lesson-player")
      .getByText("Resume voice", { exact: true })
      .click();
    assert.equal(await page.evaluate(() => speechAudio.paused), false);
    await page.evaluate(() => stopSpeech());
    console.log(
      "PASS thinking delay, move audio, coach analysis, preview and local speech playback",
    );
    await page.locator("#review-current").click();
    await page.waitForFunction(
      () => currentReviewGame === 2 && currentReview?.moves.length === 2,
    );
    assert.match(
      await page.locator("#review-title").textContent(),
      /Study bot/,
    );
    const saved = (await (await fetch(base + "/api/data")).json()).games.filter(
      (game) => game.source === "practice",
    );
    assert.equal(saved.length, 1);
    assert.equal(saved[0].moves.length, 2);
    const durable = JSON.parse(
      fs.readFileSync(
        path.join(
          dir,
          "data/sessions",
          Buffer.from(saved[0].session_id).toString("hex") + ".json",
        ),
      ),
    );
    assert.equal(durable.index, 2);
    assert.deepEqual(durable.game.moves, saved[0].moves);
    await page.locator('[data-page="play"]').click();
    await page.locator("#review-current").click();
    await page.waitForFunction(() => currentReviewGame === 2);
    assert.equal(
      (await (await fetch(base + "/api/data")).json()).games.filter(
        (game) => game.source === "practice",
      ).length,
      1,
    );
    console.log("PASS saved practice game review and idempotent saves");
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const phone = await context.newPage();
    await phone.goto(base);
    await phone.waitForFunction(() => data?.ready);
    await phone.locator('[data-page="games"]').tap();
    await phone.waitForFunction(() => currentReview?.moves.length > 0);
    await phone.locator("#next-move").tap();
    assert.equal(
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await phone.screenshot({
      path: "/tmp/chess-review-mobile.png",
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log("PASS mobile review layout and no browser errors");
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
