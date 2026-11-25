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
// Use physical clicks at the original coordinates: a layout shift between
// pointerdown and pointerup must not silently swallow the user's action.
async function boxes(page, selectors) {
  return Promise.all(selectors.map((s) => page.locator(s).boundingBox()));
}
async function pressAt(page, selector) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.up();
}
async function explain(page, name, automatic = false) {
  await page.evaluate(
    ({ name, automatic }) => {
      const text = "The bishop becomes more active along this diagonal. ";
      startVisualLesson(
        name,
        {
          evidence: [
            {
              title: "Piece activity",
              text,
              fen: boards[name].fen,
              squares: ["e4", "d5"],
              arrows: [],
            },
            {
              title: "A longer explanation",
              text: text.repeat(24),
              fen: boards[name].fen,
              squares: ["e4"],
              arrows: [],
            },
          ],
        },
        false,
        automatic,
      );
      visualLesson.paused = true;
    },
    { name, automatic },
  );
  await page.waitForTimeout(450);
}
(async () => {
  try {
    await until(async () => (await get("data")).ready);
    const launch = {
      headless: true,
      args: ["--mute-audio"],
      ...(process.env.CHESS_TEST_BROWSER
        ? { executablePath: process.env.CHESS_TEST_BROWSER }
        : {}),
    };
    assert(launch.args.includes("--mute-audio"));
    browser = await chromium.launch(launch);
    const errors = [];
    for (const viewport of [
      { width: 1440, height: 1100 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() =>
        localStorage.setItem(
          "chess-preferences",
          JSON.stringify({ voice: false, predict: false, coach: false }),
        ),
      );
      await page.goto(base);
      await page.waitForFunction(
        () => data?.ready && activeDrill && !boards.puzzle.busy,
        {},
        { timeout: 60000 },
      );
      await page.locator('[data-page="puzzles"]').click();
      await page.evaluate(() => {
        // Actual playback state with an in-memory silent WAV, inside muted Chromium.
        const rate = 8000,
          samples = rate * 20;
        const bytes = new Uint8Array(44 + samples * 2),
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
        view.setUint32(24, rate, true);
        view.setUint32(28, rate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        tag(36, "data");
        view.setUint32(40, samples * 2, true);
        const url = URL.createObjectURL(
          new Blob([bytes], { type: "audio/wav" }),
        );
        voiceClip = async () => ({ url });
      });
      // Keep the control in view before opening the explanation on narrow screens.
      await page.locator("#next-puzzle").scrollIntoViewIfNeeded();
      const controls = ["#next-puzzle", "#hint", "#solution", "#puzzle-board"];
      for (const automatic of [false, true]) {
        const before = await boxes(page, controls);
        const id = await page.evaluate(() => currentPuzzle.id);
        await explain(page, "puzzle", automatic);
        assert.deepEqual(
          await boxes(page, controls),
          before,
          "Opening coach shifted training controls",
        );
        await page
          .locator(
            '#puzzle-lesson-player button[aria-label="Next explanation step"]',
          )
          .click();
        assert.deepEqual(
          await boxes(page, controls),
          before,
          "Long transcript shifted controls",
        );
        await page.evaluate(() => {
          visualLesson.spoken = true;
          visualLesson.paused = false;
          lessonStep(1);
        });
        await page.waitForFunction(() => speechAudio && !speechAudio.paused);
        assert.deepEqual(
          await boxes(page, controls),
          before,
          "Playing voice shifted controls",
        );
        if (!automatic)
          await page.screenshot({
            path: `/tmp/chess-coach-speaking-${viewport.width}.png`,
            fullPage: true,
          });
        await pressAt(page, "#next-puzzle");
        await page.waitForFunction(
          (id) =>
            !visualLesson &&
            currentPuzzle.id !== id &&
            !boards.puzzle.busy &&
            !drillLoading,
          id,
          { timeout: 60000 },
        );
        assert.equal(await page.evaluate(() => speechAudio), null);
      }
      await page.locator('[data-page="play"]').click();
      await page.evaluate(() => movePiece("play", "e2", "e4"));
      await page.waitForFunction(
        () => lastCoach && !botBusy && !boards.play.busy,
        {},
        { timeout: 60000 },
      );
      await page.locator("#coach-hint").scrollIntoViewIfNeeded();
      const playControls = [
        "#coach-hint",
        "#coach-best",
        "#take-back",
        "#play-board",
      ];
      const before = await boxes(page, playControls);
      const live = await page.evaluate(() => boards.play.fen);
      await explain(page, "play");
      assert(
        await page.locator("#coach-hint").isEnabled(),
        "A lesson must not disable live actions",
      );
      assert.deepEqual(
        await boxes(page, playControls),
        before,
        "Opening coach shifted game controls",
      );
      await pressAt(page, "#coach-hint");
      await page.waitForFunction(
        () =>
          !visualLesson &&
          boards.play.arrow &&
          !document.querySelector("#coach-hint").disabled,
        {},
        { timeout: 60000 },
      );
      assert.equal(await page.evaluate(() => boards.play.fen), live);
      assert.deepEqual(
        await boxes(page, playControls),
        before,
        "Closing coach shifted game controls",
      );
      // Enter fires click without pointerdown. It must restore the live board too.
      await explain(page, "play");
      await page.locator("#take-back").focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => !visualLesson && playedMoves.length === 0 && !boards.play.busy,
      );
      assert(await page.evaluate(() => canInteract("play")));
      // The first board click also exits a manually opened lesson and selects a piece.
      await explain(page, "play");
      await page.locator('#play-board [data-square="e2"]').click();
      assert.equal(await page.evaluate(() => visualLesson), null);
      assert.equal(await page.evaluate(() => boards.play.selected), "e2");
      // A late speech response cannot reopen a dismissed explanation.
      await page.evaluate(() => {
        window.savedVoiceClip = voiceClip;
        voiceClip = () =>
          new Promise((resolve) => {
            window.releaseVoice = resolve;
          });
      });
      await explain(page, "play");
      await page.evaluate(() => {
        visualLesson.spoken = true;
        visualLesson.paused = false;
        lessonStep(0);
      });
      await page.waitForFunction(() => Boolean(window.releaseVoice));
      await pressAt(page, '[data-page="puzzles"]');
      await page.evaluate(() => {
        releaseVoice({ url: "/unused.wav" });
        voiceClip = savedVoiceClip;
      });
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => visualLesson), null);
      assert.equal(await page.evaluate(() => speechAudio), null);
      assert(
        await page
          .locator("#puzzles")
          .evaluate((el) => el.classList.contains("active")),
      );
      await page.locator('[data-page="games"]').click();
      await page.waitForFunction(() => currentReview?.moves.length);
      await page.locator("#next-move").click();
      await page.waitForFunction(
        () => replayPly === 1 && !reviewPlayback.seeking,
      );
      await page.locator("#review-best").scrollIntoViewIfNeeded();
      const reviewControls = ["#review-best", "#review-blunder", "#game-board"];
      const reviewBefore = await boxes(page, reviewControls);
      await explain(page, "game");
      assert.deepEqual(
        await boxes(page, reviewControls),
        reviewBefore,
        "Opening coach shifted review controls",
      );
      await pressAt(page, "#review-best");
      await page.waitForFunction(
        () =>
          !visualLesson &&
          (boards.game.arrow ||
            document.querySelector("#variation").hidden === false),
      );
      await page.screenshot({
        path: `/tmp/chess-coach-controls-${viewport.width}.png`,
        fullPage: true,
      });
      await page.close();
      console.log(
        `PASS ${viewport.width}px: stable coach area, single-click puzzle/game/review controls, board selection, keyboard action and late speech cancellation`,
      );
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
