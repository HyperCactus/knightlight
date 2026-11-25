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
    const browserCommand = await (await browser.newBrowserCDPSession()).send("Browser.getBrowserCommandLine");
    assert(browserCommand.arguments.includes("--mute-audio"));
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1100 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() =>
      localStorage.setItem(
        "chess-preferences",
        JSON.stringify({ voice: false, speed: 1.15, reviewPause: 2800 }),
      ),
    );
    await page.goto(base);
    await page.waitForFunction(
      () => data?.ready && activeDrill && !boards.puzzle.busy,
    );
    await page.locator('[data-page="games"]').click();
    await page.waitForFunction(() => currentReview?.moves.length === 16);
    assert.equal(await page.locator("#quick-speed,.lesson-speed").count(), 0);
    assert.equal(await page.evaluate(() => preferences.reviewPause), 1400);
    assert.equal(await page.evaluate(() => preferences.speed), 1.15);
    const pacing = await page.evaluate(() => ({
      first: currentReview.moves[0].review_pace,
      limits: currentReview.moves.every(
        (m) => m.review_pace.multiplier >= 0.5 && m.review_pace.multiplier <= 2,
      ),
      fallback: reviewReadingPause({}),
      low: reviewReadingPause({ review_pace: { multiplier: -1 } }),
      high: reviewReadingPause({ review_pace: { multiplier: 99 } }),
    }));
    assert.equal(pacing.first.multiplier, 0.5);
    assert(pacing.limits);
    assert.equal(pacing.fallback, 1400);
    assert.equal(pacing.low, 700);
    assert.equal(pacing.high, 2800);
    console.log(
      "PASS backend reading factors, base pace fallback, and 0.5–2× playback bounds",
    );
    const spoken = await page.evaluate(() =>
      currentReview.moves
        .map((m) => [m.explanation, ...lessonPlan(m).map((s) => s.text)])
        .flat(),
    );
    assert(
      !spoken.some(
        (s) =>
          s.includes("positional choice") ||
          s.includes("Compare the resulting piece activity") ||
          s.includes("The move gives your opponent an opportunity"),
      ),
    );
    assert(spoken.some((s) => /central squares|develops/.test(s)));
    console.log(
      "PASS cached review uses concrete quiet-move explanations without the retired filler or speech-speed clutter",
    );
    const coachingPolicy = await page.evaluate(() => {
      const quiet = currentReview.moves[0];
      const sound = currentReview.moves.find(
        (m) => m.loss <= 80 && m.best !== m.uci,
      );
      return {
        quiet: shouldNarrateReview(quiet),
        mistake: shouldNarrateReview({ ...quiet, grade: "mistake", loss: 200 }),
        playedFirst: sound.evidence[0].uci === sound.uci,
        alternatives: lessonPlan(sound).filter(
          (s) => s.context === "alternative",
        ).length,
      };
    });
    assert.deepEqual(coachingPolicy, {
      quiet: false,
      mistake: true,
      playedFirst: true,
      alternatives: 0,
    });
    await page.evaluate(() => {
      changePreference("voice", true);
      scheduleReviewVoice(currentReview.moves[0]);
    });
    await page.waitForTimeout(850);
    assert.equal(await page.evaluate(() => visualLesson), null);
    await page.evaluate(() => changePreference("voice", false));
    console.log(
      "PASS routine openings stay quiet, mistakes still trigger coaching, and good moves explain the played idea",
    );
    await page.locator("#next-move").click();
    await page.waitForFunction(() => replayPly === 1 && reviewPlayback.seeking);
    assert(
      await page.evaluate(
        () =>
          document
            .querySelector('#game-board [data-square="e4"] .piece')
            .getAnimations().length > 0,
      ),
    );
    await page.waitForFunction(() => !reviewPlayback.seeking);
    await page.evaluate(() => seekReview(8, { explain: false }));
    await page.locator("#next-move").click();
    await page.waitForFunction(() => replayPly === 9 && reviewPlayback.seeking);
    assert.equal(
      await page.evaluate(() => reviewPlayback.animations.length),
      2,
    );
    await page.waitForFunction(() => !reviewPlayback.seeking);
    assert.deepEqual(
      await page.evaluate(() => [
        placement(boards.game.fen).g1,
        placement(boards.game.fen).f1,
      ]),
      ["K", "R"],
    );
    await page.locator("#prev-move").click();
    await page.waitForFunction(() => !reviewPlayback.seeking);
    assert.deepEqual(
      await page.evaluate(() => [
        placement(boards.game.fen).e1,
        placement(boards.game.fen).h1,
      ]),
      ["K", "R"],
    );
    await page.locator("#review-position").fill("13");
    await page.locator("#review-position").dispatchEvent("change");
    await page.waitForFunction(
      () => replayPly === 13 && !reviewPlayback.seeking,
    );
    assert.equal(
      await page.evaluate(() => boards.game.fen),
      await page.evaluate(() => currentReview.moves[12].after),
    );
    console.log(
      "PASS animated single steps, castling king/rook motion, reverse steps and position scrubber",
    );
    await page.locator("#review-select").selectOption("1");
    await page.waitForFunction(
      () => currentReviewGame === 1 && currentReview?.moves.length === 4,
    );
    const explanation = await page.evaluate(() => {
      const move = currentReview.moves.find(
        (m) => m.player && m.grade === "blunder",
      );
      const reply = move.evidence.find((f) => f.context === "opponent_reply");
      const alternative = move.evidence.find(
        (f) => f.context === "alternative",
      );
      const plan = lessonPlan({
        ...move,
        evidence: [
          reply,
          { ...reply, text: reply.text + " A second observation." },
          alternative,
        ],
      });
      window.contextMove = move;
      return {
        texts: plan
          .filter((s) => s.context !== "continuation")
          .map((s) => s.text),
        contexts: plan
          .slice(1)
          .filter((s) => s.context !== "continuation")
          .map((s) => s.context),
      };
    });
    assert.deepEqual(explanation.contexts, ["opponent_reply", "alternative"]);
    assert.match(explanation.texts[0], /^You played/);
    assert.match(explanation.texts[1], /^Now your opponent can /);
    assert.match(explanation.texts[2], /^A better option would have been to /);
    await page.evaluate(() => startVisualLesson("game", contextMove, false));
    await page.evaluate(() => lessonStep(1));
    assert.match(
      await page.locator("#game-lesson-player .lesson-subtitle").textContent(),
      /^Now your opponent can /,
    );
    assert.match(
      await page.locator("#game-diagram-caption").textContent(),
      /Possible reply/,
    );
    assert.equal(
      await page.evaluate(() => boards.game.fen),
      await page.evaluate(() => visualLesson.steps[1].fen),
    );
    await page.evaluate(() =>
      lessonStep(
        visualLesson.steps.findIndex((s) => s.context === "alternative"),
      ),
    );
    assert.match(
      await page.locator("#game-lesson-player .lesson-subtitle").textContent(),
      /^A better option would have been to /,
    );
    assert.match(
      await page.locator("#game-diagram-caption").textContent(),
      /Alternative move/,
    );
    assert.equal(
      await page.evaluate(() => boards.game.fen),
      await page.evaluate(
        () => visualLesson.steps.find((s) => s.context === "alternative").fen,
      ),
    );
    await page.evaluate(() => stopSpeech());
    console.log(
      "PASS dialogue distinguishes played moves, possible replies and better alternatives, with matching diagrams and room for both lines",
    );
    // Check what the learner actually sees and reads for the reported failure modes.
    const tactical = await page.evaluate(async () => {
      const cases = [
        [
          "trade",
          "r1bqkb1r/ppp3pp/4p3/3P4/4QP1P/8/PP4P1/R1B1K1NR b KQkq - 0 13",
        ],
        ["king", "8/8/4k3/3p4/8/8/6B1/3Q2K1 w - - 0 1"],
        ["sacrifice", "5r1k/6pp/4Q2N/8/8/8/8/6K1 w - - 0 1"],
      ];
      const results = [];
      for (const [name, fen] of cases) {
        const record = await api("coach", { fen });
        const critical = record.evidence.find((f) => f.spoken_text);
        if (!critical || hybridWords(critical) !== critical.spoken_text)
          throw Error("Tactical meaning was lost in narration");
        startVisualLesson("game", record, false);
        const frames = [];
        for (let index = 1; index < visualLesson.steps.length; index++) {
          await lessonStep(index);
          const step = visualLesson.steps[index];
          if (boards.game.fen !== step.fen)
            throw Error("Caption/position mismatch");
          for (const sq of step.squares || [])
            if (
              !document.querySelector(
                `#game-board [data-square="${sq}"].fact-square`,
              )
            )
              throw Error("Missing cue " + sq);
          frames.push({
            text: step.text,
            fen: step.fen,
            context: step.context,
          });
        }
        results.push({
          name,
          frames,
          support: critical.arrows.some((a) => a.kind === "support"),
        });
        stopSpeech();
      }
      return results;
    });
    assert(
      tactical
        .find((r) => r.name === "trade")
        .frames.some((f) => f.text.includes("Both queens have been exchanged")),
    );
    assert(
      tactical
        .find((r) => r.name === "king")
        .frames.some((f) => f.text.includes("cannot capture")),
    );
    assert(tactical.find((r) => r.name === "king").support);
    assert(
      tactical
        .find((r) => r.name === "sacrifice")
        .frames.some((f) => /delivers checkmate/.test(f.text)),
    );
    console.log(
      "PASS queen-trade recaptures, protected king captures and forcing sacrifices retain accurate dialogue and synchronized visual continuations",
    );
    const outlook = await page.evaluate(async () => {
      const record = await api("coach", {
        fen: "3r3k/6pp/8/4N3/8/8/P7/6K1 w - - 0 12",
      });
      const plan = lessonPlan(record),
        index = plan.findIndex((s) => s.context === "outlook");
      if (index < 0) throw Error("Missing delayed fork payoff");
      startVisualLesson("game", record, false);
      const moves = [],
        original = animateBoardMove;
      animateBoardMove = (...args) => {
        moves.push(args[3]);
        return original(...args);
      };
      try {
        await lessonStep(index);
      } finally {
        animateBoardMove = original;
      }
      return {
        text: visualLesson.steps[index].text,
        moves,
        expected: plan[index].sequence.map((s) => s.uci),
        matched: boards.game.fen === plan[index].fen,
        missing: plan[index].squares.filter(
          (sq) =>
            !document.querySelector(
              `#game-board [data-square="${sq}"].fact-square`,
            ),
        ),
      };
    });
    assert.match(outlook.text, /wins the rook/);
    assert.deepEqual(outlook.moves, outlook.expected);
    assert(outlook.matched);
    assert.deepEqual(outlook.missing, []);
    await page.screenshot({ path: "/tmp/chess-plan-payoff.png" });
    await page.evaluate(() => stopSpeech());
    console.log(
      "PASS multi-move payoff animates each move, then gives one concise explanation on the matching board",
    );
    await page.locator("#next-key").click();
    await page.waitForFunction(() => !reviewPlayback.seeking);
    assert(
      await page.evaluate(() => currentReview.moves[replayPly - 1].loss >= 80),
    );
    await page.locator("#first-move").click();
    await page.waitForFunction(() => !reviewPlayback.seeking);
    await page.locator(".move-item").nth(2).click();
    assert.match(
      await page.locator("#review-playback-status").textContent(),
      /Before/,
    );
    await page.waitForFunction(() => !reviewPlayback.seeking);
    assert(await page.evaluate(() => replayPly > 0));
    await page.locator("#first-move").click();
    await page.waitForFunction(() => !reviewPlayback.seeking);
    await page.evaluate(() => {
      changePreference("reviewPause", 800);
      window.trace = [];
      const draw = renderReview;
      renderReview = (options) => {
        draw(options);
        trace.push({
          ply: replayPly,
          at: performance.now(),
          pause: reviewReadingPause(currentReview.moves[replayPly - 1]),
        });
      };
    });
    await page.locator("#review-play").click();
    await page.waitForFunction(() => replayPly === 1);
    await page.locator("#review-play").click();
    const paused = await page.evaluate(() => replayPly);
    await page.waitForTimeout(1000);
    assert.equal(await page.evaluate(() => replayPly), paused);
    assert.equal(
      await page.locator("#review-play").getAttribute("aria-label"),
      "Play review",
    );
    await page.locator("#review-play").click();
    await page.waitForFunction(
      () => replayPly === 4 && !reviewPlayback.running,
      {},
      { timeout: 20000 },
    );
    const trace = await page.evaluate(() => trace);
    assert.deepEqual(
      trace.map((x) => x.ply),
      [1, 2, 3, 4],
    );
    for (let i = 1; i < trace.length; i++)
      assert(trace[i].at - trace[i - 1].at >= trace[i - 1].pause + 440);
    for (let i = 2; i < trace.length; i++)
      assert(
        trace[i].at - trace[i - 1].at < trace[i - 1].pause + 1400,
        "Playback should use each move's reading pause plus animation/transition time",
      );
    assert(
      trace[2].pause > trace[1].pause,
      "The mating blunder needs more time than development",
    );
    console.log(
      "PASS backend-paced half-moves, pause/resume preserving reading time, and completion stopping playback",
    );
    await page.locator("#guided-review").click();
    await page.waitForFunction(() => reviewPlayback.running && replayPly <= 1);
    await page.locator("#review-play").click();
    assert.equal(await page.evaluate(() => reviewPlayback.playing), false);
    await page.locator('[data-page="settings"]').click();
    assert.equal(await page.evaluate(() => reviewPlayback.running), false);
    assert.equal(await page.locator("#pref-speed").count(), 1);
    assert.equal(await page.locator("#pref-review-pace").count(), 1);
    console.log(
      "PASS guided review begins at the start; navigating away cancels its clock and keeps speed settings on the settings page",
    );
    let releaseBot,
      botCalls = 0;
    const held = new Promise((r) => (releaseBot = r));
    await page.route("**/api/bot", async (route) => {
      if (++botCalls === 1) await held;
      await route.fulfill({
        json: {
          move: "e7e5",
          rating: 1050,
          style: "balanced",
          source: "Test policy",
          inference_ms: 1,
          book: false,
        },
      });
    });
    await page.locator('[data-page="play"]').click();
    await page.locator('#play-board [data-square="e2"]').click();
    await page.locator('#play-board [data-square="e4"]').click();
    await page.waitForFunction(() => botBusy && playedMoves.length === 1);
    await page.evaluate(() => ($("#game-options").open = true));
    await page.locator("#resign-game").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => gameFinished && !botBusy);
    assert(await page.locator("#game-result").isVisible());
    assert(await page.locator("#new-game").isEnabled());
    await until(async () =>
      (await get("data")).games.some(
        (g) => g.source === "practice" && g.result === "0-1",
      ),
    );
    await page.locator("#play-again").click();
    await page.waitForFunction(
      () =>
        playedMoves.length === 0 &&
        boards.play.fen === startFen &&
        !newGameBusy,
    );
    releaseBot();
    await page.waitForTimeout(500);
    assert.equal(
      await page.evaluate(() => boards.play.fen),
      await page.evaluate(() => startFen),
    );
    console.log(
      "PASS resign while the bot is thinking, visible completion actions, Play again, and ignoring a late reply from the previous game",
    );
    await page.locator('#play-board [data-square="d2"]').click();
    await page.locator('#play-board [data-square="d4"]').click();
    await page.waitForFunction(
      () =>
        playedMoves.length === 2 && !botBusy && !boards.play.busy && lastCoach,
    );
    const live = await page.evaluate(() => boards.play.fen);
    await page.evaluate(() =>
      startVisualLesson("play", lastCoach, false, true),
    );
    assert.notEqual(await page.evaluate(() => boards.play.fen), live);
    await page.evaluate(() => ($("#game-options").open = true));
    await page.locator("#resign-game").focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => visualLesson), null);
    assert.equal(await page.evaluate(() => boards.play.fen), live);
    await until(
      async () =>
        (await get("data")).games.filter(
          (g) => g.source === "practice" && g.result === "0-1",
        ).length === 2,
    );
    await page.locator("#play-again").click();
    await page.waitForFunction(
      () => !gameFinished && playedMoves.length === 0 && !newGameBusy,
    );
    assert.equal(
      await page.evaluate(() => boards.play.fen),
      await page.evaluate(() => startFen),
    );
    assert.equal((await get("profile")).rated_games, 2);
    assert.deepEqual(errors, []);
    console.log(
      "PASS keyboard resign during a coach diagram preserves the real position/result, saves once, and allows a fresh game",
    );
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const phone = await context.newPage();
    await phone.addInitScript(() => localStorage.setItem("chess-voice", "off"));
    await phone.goto(base);
    await phone.waitForFunction(() => data?.ready);
    await phone.locator('[data-page="games"]').tap();
    await phone.waitForFunction(() => currentReview?.moves.length);
    assert(await phone.locator("#review-play").isVisible());
    assert(
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await phone.screenshot({
      path: "/tmp/chess-review-transport-mobile.png",
      fullPage: true,
    });
    console.log(
      "PASS mobile review controls remain labeled and fit without overflow",
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
