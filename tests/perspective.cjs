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

fs.appendFileSync(
  path.join(dir, "fixture.pgn"),
  '\n[Event "Black perspective"]\n[White "Other"]\n[Black "Tester"]\n[Date "2026.11.06"]\n[Result "*"]\n\n1. e3 e5 2. Nc3 Qh4 3. Nf3 Bc5 4. a3 a6 5. Nxh4 *\n',
);
(async () => {
  try {
    launch();
    await until(async () => (await get("data")).ready, 60000);
    const beforePgn = await (await fetch(base + "/api/games/pgn")).text();
    const beforePractice = await get("practice");
    const plans = [];
    for (let id = 0; id < 2; id++) {
      const prepared = await get(`reviews/${id}/perspectives`);
      assert.equal(prepared.next_cursor, null);
      assert.equal(
        prepared.items.length,
        1,
        "One useful switch in each short game",
      );
      const item = prepared.items[0];
      assert.equal(item.kind, "punish");
      assert(!("best" in item));
      assert.equal(
        (await fetch(base + "/api/reviews/999/perspectives")).status,
        404,
      );
      await post(`reviews/${id}/perspectives/999/moves`, { reveal: true }, 404);
      await post(`reviews/${id}/perspectives/${item.ply}/moves`, {}, 400);
      const solution = await post(
        `reviews/${id}/perspectives/${item.ply}/moves`,
        { reveal: true },
      );
      assert(solution.accepted);
      const root = await post("board", { fen: item.fen });
      let wrongMove;
      for (const u of root.legal
        .filter((u) => u !== solution.feedback.uci)
        .slice(0, 5)) {
        const reply = await post(
          `reviews/${id}/perspectives/${item.ply}/moves`,
          { uci: u },
        );
        if (!reply.accepted) {
          wrongMove = u;
          break;
        }
      }
      assert(wrongMove);
      await post(
        `reviews/${id}/perspectives/${item.ply}/moves`,
        { uci: "e2e9" },
        400,
      );
      plans.push({ item, best: solution.feedback.uci, wrong: wrongMove });
    }
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
      { width: 1440, height: 1100 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() =>
        localStorage.setItem(
          "chess-preferences",
          JSON.stringify({ voice: false, predict: false, reviewPause: 800 }),
        ),
      );
      await page.goto(base);
      await page.waitForFunction(
        () => data?.ready && activeDrill && !boards.puzzle.busy,
      );
      await page.locator('[data-page="games"]').click();
      await page.waitForFunction(() => currentReview?.moves.length);
      await page.evaluate(() => {
        const original = beginPerspective;
        beginPerspective = (...args) => {
          const rect = document
            .querySelector("#game-board")
            .getBoundingClientRect();
          window.perspectiveStartBox = {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            scrollY,
          };
          return original(...args);
        };
      });
      for (let id = 0; id < 2; id++) {
        const { item, best, wrong } = plans[id];
        await page.evaluate(async (id) => {
          gameIndex = id;
          replayPly = 0;
          await replay();
        }, id);
        await page.waitForFunction((id) => currentReviewGame === id, id);
        const history = await page.evaluate(
          (id) => [...data.games[id].moves],
          id,
        );
        const flip = await page.evaluate(() => boards.game.flip);
        await page.evaluate(async (ply) => {
          await seekReview(ply - 1, { context: false, explain: false });
        }, item.ply);
        await page
          .locator("#review-play")
          .evaluate((el) =>
            el.scrollIntoView({ block: "center", behavior: "instant" }),
          );
        const box = await page.locator("#game-board").boundingBox();
        const playBox = await page.locator("#review-play").boundingBox();
        await page.mouse.click(
          playBox.x + playBox.width / 2,
          playBox.y + playBox.height / 2,
        );
        await page.waitForFunction(
          () => opponentChallenge?.phase === "solving",
          {},
          { timeout: 30000 },
        );
        assert.equal(await page.evaluate(() => boards.game.flip), !flip);
        assert.equal(await page.evaluate(() => boards.game.fen), item.fen);
        assert(await page.evaluate(() => canInteract("game")));
        const during = await page.locator("#game-board").boundingBox();
        const startBox = await page.evaluate(() => perspectiveStartBox);
        assert.equal(during.width, startBox.width);
        assert.equal(during.height, startBox.height);
        assert(
          Math.abs(during.x - startBox.x) < 1 &&
            Math.abs(during.y - startBox.y) < 1,
          "Switching perspective moved the board: " +
            JSON.stringify({
              beforeClick: box,
              startBox,
              during,
              scroll: await page.evaluate(() => scrollY),
            }),
        );
        assert.match(
          await page.locator("#game-message").textContent(),
          /opponent’s side/,
        );
        await page.screenshot({
          path: `/tmp/chess-perspective-${viewport.width}-${id}.png`,
          fullPage: true,
        });
        // A rejected attempt restores the cached root even if board metadata
        // temporarily goes offline. No second network round trip is necessary.
        await page.route("**/api/board", (route) => route.abort());
        for (const u of [wrong, best]) {
          await page
            .locator(`#game-board [data-square="${u.slice(0, 2)}"]`)
            .click();
          await page
            .locator(`#game-board [data-square="${u.slice(2, 4)}"]`)
            .click();
          await page.waitForFunction(() => !boards.game.busy);
          if (u === wrong) {
            assert.equal(
              await page.evaluate(() => opponentChallenge.phase),
              "solving",
            );
            assert.equal(await page.evaluate(() => boards.game.fen), item.fen);
            await page.unroute("**/api/board");
          }
        }
        assert.equal(
          await page.evaluate(() => opponentChallenge.phase),
          "complete",
        );
        assert(
          await page.evaluate(
            () => opponentChallenge.feedback.evidence.length > 0,
          ),
        );
        await page.locator("#perspective-continue").click();
        assert.equal(await page.evaluate(() => opponentChallenge), null);
        assert.equal(await page.evaluate(() => boards.game.flip), flip);
        await page.evaluate(() => stopReviewPlayback());
        assert.deepEqual(
          await page.evaluate((id) => data.games[id].moves, id),
          history,
        );
        // Rewinding the same game does not repeat an automatic challenge.
        await page.evaluate(async (ply) => {
          await seekReview(ply - 1, { context: false, explain: false });
        }, item.ply);
        await page.locator("#review-play").click();
        await page.waitForFunction((ply) => replayPly > ply, item.ply);
        assert.equal(await page.evaluate(() => opponentChallenge), null);
        await page.evaluate(() => stopReviewPlayback());
        // The explicit invitation remains available, and a next-move action
        // cancels an in-flight answer without restoring the old challenge later.
        await page.evaluate(async (ply) => {
          await seekReview(ply, { context: false, explain: false });
        }, item.ply);
        await page.locator("#review-perspective").click();
        await page.waitForFunction(
          () => opponentChallenge?.phase === "solving",
        );
        let release;
        await page.route(
          "**/api/reviews/*/perspectives/*/moves",
          async (route) => {
            await new Promise((resolve) => {
              release = resolve;
            });
            await route.continue();
          },
        );
        await page.locator("#perspective-reveal").click();
        await until(() => Boolean(release));
        await page.locator("#next-move").click();
        await page.waitForFunction(() => !reviewPlayback.seeking);
        const stable = await page.evaluate(() => boards.game.fen);
        release();
        await page.waitForTimeout(900);
        assert.equal(await page.evaluate(() => boards.game.fen), stable);
        assert.equal(await page.evaluate(() => opponentChallenge), null);
        assert.equal(await page.evaluate(() => boards.game.flip), flip);
        assert.equal(await page.evaluate(() => boards.game.busy), false);
        await page.unroute("**/api/reviews/*/perspectives/*/moves");
        if (id === 0) {
          // Narration must play while the review clock is held for our answer.
          await page.evaluate(async (ply) => {
            await seekReview(ply, { context: false, explain: false });
          }, item.ply);
          await page.evaluate(() => {
            const samples = 8000 * 20,
              bytes = new Uint8Array(44 + samples * 2),
              view = new DataView(bytes.buffer);
            const tag = (offset, text) =>
              [...text].forEach((c, i) =>
                view.setUint8(offset + i, c.charCodeAt(0)),
              );
            tag(0, "RIFF");
            view.setUint32(4, bytes.length - 8, true);
            tag(8, "WAVE");
            tag(12, "fmt ");
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true);
            view.setUint16(22, 1, true);
            view.setUint32(24, 8000, true);
            view.setUint32(28, 16000, true);
            view.setUint16(32, 2, true);
            view.setUint16(34, 16, true);
            tag(36, "data");
            view.setUint32(40, samples * 2, true);
            const url = URL.createObjectURL(
              new Blob([bytes], { type: "audio/wav" }),
            );
            window.savedPerspectiveVoice = voiceClip;
            voiceClip = async () => ({ url });
            changePreference("voice", true);
          });
          await page.locator("#review-perspective").click();
          await page.waitForFunction(
            () =>
              opponentChallenge?.phase === "solving" &&
              speechAudio &&
              !speechAudio.paused,
          );
          await page.locator("#perspective-reveal").click();
          await page.waitForFunction(
            () =>
              opponentChallenge?.phase === "complete" &&
              visualLesson?.name === "game" &&
              speechAudio &&
              !speechAudio.paused,
          );
          await page.locator("#game-lesson-player .lesson-return").click();
          assert.equal(await page.evaluate(() => opponentChallenge), null);
          assert.equal(await page.evaluate(() => boards.game.flip), flip);
          assert.equal(await page.evaluate(() => speechAudio), null);
          assert.equal(await page.evaluate(() => visualLesson), null);
          await page.evaluate(() => {
            changePreference("voice", false);
            voiceClip = savedPerspectiveVoice;
          });
          // Exiting to a different game must restore the new game's orientation.
          await page.locator("#review-perspective").click();
          await page.waitForFunction(
            () => opponentChallenge?.phase === "solving",
          );
          await page.locator("#review-select").selectOption("1");
          await page.waitForFunction(
            () => currentReviewGame === 1 && !opponentChallenge,
          );
          assert.equal(await page.evaluate(() => boards.game.flip), true);
          assert.equal(await page.evaluate(() => canInteract("game")), false);
        }
      }
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      assert.deepEqual(errors, []);
      await page.close();
      console.log(
        `PASS ${viewport.width}px: rare automatic switches for both colours, legal attempts, feedback, original history/orientation, no repeats and late-response cancellation`,
      );
    }
    assert.equal(
      await (await fetch(base + "/api/games/pgn")).text(),
      beforePgn,
    );
    assert.equal((await get("practice")).xp, beforePractice.xp);
  } finally {
    await browser?.close();
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
