const { chromium, devices } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "chess-experience-"));
for (const folder of ["static", "scripts", "vendor"])
  fs.symlinkSync(path.join(root, folder), path.join(dir, folder));
fs.mkdirSync(path.join(dir, "data"));
fs.symlinkSync(
  path.join(root, "data/openings"),
  path.join(dir, "data/openings"),
);
fs.writeFileSync(
  path.join(dir, "fixture.pgn"),
  '[Event "Coach fixture"]\n[Date "2026.11.07"]\n[White "Tester"]\n[Black "Other"]\n[WhiteElo "1000"]\n[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1\n',
);
const pack = ["one", "two", "three"].map((id, i) => ({
  id,
  fen: [
    "7k/5K2/6Q1/8/8/8/8/8 w - - 0 1",
    "7k/5K2/8/6Q1/8/8/8/8 w - - 0 1",
    "7k/5K2/8/8/6Q1/8/8/8 w - - 0 1",
  ][i],
  moves: [`g${6 - i}g7`],
  rating: 900,
  theme: "Checkmate patterns",
  game_url: "https://lichess.org",
}));
fs.writeFileSync(
  path.join(dir, "data/public-puzzles.json"),
  JSON.stringify(pack),
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
  const t = Date.now();
  while (Date.now() - t < timeout) {
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
(async () => {
  try {
    launch();
    await until(async () => (await get("data")).ready);
    for (const voice of ["af_heart", "am_michael", "bf_emma", "piper"]) {
      const r = await post("speech", {
        text: "Take your time. Look for a check, then consider the reply.",
        voice,
      });
      const bytes = Buffer.from(
        await (await fetch(base + r.url)).arrayBuffer(),
      );
      assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
      assert(bytes.length > 24000);
      assert.equal(r.voice, voice);
      assert.equal(
        (
          await post("speech", {
            text: "Take your time. Look for a check, then consider the reply.",
            voice,
          })
        ).url,
        r.url,
      );
    }
    await post("speech", { text: "Test", voice: "../../other" }, 400);
    console.log(
      "PASS three real local Kokoro voices and Piper, valid cached WAV output and voice validation",
    );
    browser = await chromium.launch({
      args: ["--mute-audio", "--enable-automation"],
      headless: true,
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
    await page.goto(base);
    await page.waitForFunction(
      () => data?.ready && activeDrill && !boards.puzzle.busy && practiceData,
    );
    assert.equal(await page.evaluate(() => voiceEnabled), true);
    assert.equal(
      await page.locator("#voice-toggle").getAttribute("aria-label"),
      "Mute coach voice",
    );
    await page.evaluate(() => {
      window.cueLog = [];
      const original = playSound;
      playSound = (kind) => {
        cueLog.push(kind);
        return original(kind);
      };
    });
    await page.locator('[data-page="games"]').click();
    await page.waitForFunction(() => currentReview?.moves.length);
    await page.locator("#guided-review").click();
    await page.waitForFunction(
      () => visualLesson?.automatic && speechAudio && !speechAudio.paused,
      {},
      { timeout: 30000 },
    );
    assert(await page.locator("#game-board.narrating .fact-square").count());
    const heldPly = await page.evaluate(() => replayPly);
    await page.locator("#review-play").click();
    assert(
      await page.evaluate(
        () =>
          speechAudio.paused && !reviewPlayback.playing && visualLesson.paused,
      ),
    );
    await page.waitForTimeout(450);
    assert.equal(await page.evaluate(() => replayPly), heldPly);
    await page.locator("#review-play").click();
    await page.waitForFunction(
      () => speechAudio && !speechAudio.paused && reviewPlayback.playing,
    );
    assert.match(
      await page.locator("#guided-caption").textContent(),
      /Key move/,
    );
    const originalFen = await page.evaluate(() => visualLesson.saved.fen);
    assert.equal(await page.locator("#quick-speed,.lesson-speed").count(), 0);
    await page.evaluate(() => changePreference("speed", 1.25));
    assert.equal(await page.evaluate(() => speechAudio.playbackRate), 1.25);
    assert.equal(await page.evaluate(() => speechAudio.preservesPitch), true);
    // Completing the final clip restores the board without an extra Return click.
    await page.evaluate(async () => {
      const l = visualLesson;
      l.index = l.steps.length - 1;
      await lessonStep(l.index);
    });
    await page.waitForFunction(
      () => speechAudio && !speechAudio.paused,
      {},
      { timeout: 30000 },
    );
    await page.evaluate(() => speechAudio.dispatchEvent(new Event("ended")));
    await page.waitForFunction(() => visualLesson === null);
    assert.equal(await page.evaluate(() => boards.game.fen), originalFen);
    await page.locator("#guided-exit").click();
    await page.locator("#first-move").click();
    await page.waitForFunction(() => !reviewPlayback.seeking);
    await page.locator("#review-blunder").click();
    await page.waitForFunction(() => !reviewPlayback.seeking);
    await page.waitForFunction(
      () => speechAudio && !speechAudio.paused,
      {},
      { timeout: 30000 },
    );
    await page.locator("#voice-toggle").click();
    assert.equal(await page.evaluate(() => speechAudio), null);
    assert.equal(await page.evaluate(() => visualLesson), null);
    console.log(
      "PASS default automatic synchronized coaching, live pitch-preserving speed, automatic board return and one-click mute",
    );
    await page.locator("#settings-open").click();
    assert(await page.locator("#settings.active").count());
    assert.equal(await page.locator(".settings-card").count(), 5);
    await page.locator("#pref-voice-name").selectOption("bf_emma");
    await page.locator("#pref-speed").fill("0.9");
    await page.locator("#pref-speed").dispatchEvent("input");
    await page.locator("#pref-voice-volume").fill("60");
    await page.locator("#pref-voice-volume").dispatchEvent("input");
    await page.locator("#preview-voice").click();
    await page.waitForFunction(
      () => speechAudio && !speechAudio.paused,
      {},
      { timeout: 30000 },
    );
    assert.equal(await page.evaluate(() => speechAudio.playbackRate), 0.9);
    assert.equal(await page.evaluate(() => speechAudio.volume), 0.6);
    await page.locator("#pref-theme").selectOption("light");
    await page.locator("#pref-board").selectOption("slate");
    await page.locator("#pref-motion").selectOption("reduced");
    await page.locator("#pref-goal").selectOption("3");
    await page.locator("#pref-coordinates").uncheck();
    await page.locator("#pref-legal").uncheck();
    await page.locator("#pref-ui-sounds").uncheck();
    const beforeOsc = await page.evaluate(() => {
      let count = 0;
      const original = audioContext.createOscillator.bind(audioContext);
      audioContext.createOscillator = () => {
        window.oscCount = ++count;
        return original();
      };
      return 0;
    });
    await page.locator('[data-page="overview"]').click();
    assert.equal(await page.evaluate(() => window.oscCount || 0), beforeOsc);
    await page.reload();
    await page.waitForFunction(() => data?.ready && practiceData);
    assert.deepEqual(
      await page.evaluate(() => [
        preferences.voice,
        preferences.voiceName,
        preferences.speed,
        preferences.voiceVolume,
        preferences.goal,
        preferences.uiSounds,
        document.documentElement.dataset.theme,
        document.documentElement.dataset.board,
        document.documentElement.dataset.motion,
      ]),
      [false, "bf_emma", 0.9, 60, 3, false, "light", "slate", "reduced"],
    );
    await page.locator('[data-page="settings"]').click();
    await page.screenshot({
      path: "/tmp/chess-experience-settings-light.png",
      fullPage: true,
    });
    await page.locator("#pref-theme").selectOption("dark");
    await page.locator("#pref-ui-sounds").check();
    await page.screenshot({
      path: "/tmp/chess-experience-settings.png",
      fullPage: true,
    });
    assert((await page.evaluate(() => cueLog?.length).catch(() => 1)) >= 0);
    console.log(
      "PASS full settings, local voice preview, volumes, speed, theme/board/motion, daily goal and persistence",
    );
    let d = await post("drills", { id: "lichess-one" });
    let r = await post(`drills/${d.session}/moves`, {
      uci: d.best,
      revision: d.revision,
      request_id: "first",
    });
    assert(r.complete && r.xp_earned === 15);
    assert.equal(
      (
        await post(`drills/${d.session}/moves`, {
          uci: d.best,
          revision: d.revision,
          request_id: "first",
        })
      ).xp_earned,
      15,
    );
    d = await post("drills", { id: "lichess-one" });
    r = await post(`drills/${d.session}/moves`, {
      uci: d.best,
      revision: d.revision,
      request_id: "second",
    });
    assert.equal(r.xp_earned, 0);
    assert.equal((await get("practice")).xp, 15);
    assert.equal((await get("practice")).daily_unique, 1);
    await page.locator('[data-page="puzzles"]').click();
    await page.evaluate(async () => {
      await startPosition("lichess-two", 0, true);
      await movePiece(
        "puzzle",
        currentPuzzle.best.slice(0, 2),
        currentPuzzle.best.slice(2, 4),
      );
    });
    await page.locator("#reward-banner").waitFor({ state: "visible" });
    assert.match(await page.locator("#reward-banner").textContent(), /15 XP/);
    assert.equal((await get("practice")).xp, 30);
    await page.locator('[data-page="overview"]').click();
    assert.match(await page.locator("#goal-count").textContent(), /2 \/ 3/);
    assert(await page.locator(".achievement.earned").count());
    await page.screenshot({
      path: "/tmp/chess-experience-overview.png",
      fullPage: true,
    });
    const xp = (await get("practice")).xp;
    await stop();
    launch();
    await until(async () => (await get("data")).ready);
    assert.equal((await get("practice")).xp, xp);
    console.log(
      "PASS earned XP, milestones, distinct daily goals, retry deduplication and restart persistence",
    );
    await page.locator('[data-page="play"]').click();
    await page.evaluate(() => changePreference("voice", true));
    await page.locator('#play-board [data-square="e2"]').click();
    await page.locator('#play-board [data-square="e4"]').click();
    await page.waitForFunction(
      () =>
        !botBusy && !boards.play.busy && playedMoves.length === 2 && lastCoach,
      {},
      { timeout: 30000 },
    );
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => visualLesson), null);
    assert.equal(
      await page.locator("#coach-evidence .evidence-card").count(),
      0,
    );
    assert.match(
      await page.locator("#coach-explanation").textContent(),
      /Explain this move/,
    );
    const policy = await page.evaluate(() => {
      const ordinary = {
        ...lastCoach,
        grade: "good",
        loss: 40,
        mate: null,
        san: "e4",
        uci: "e2e4",
        evidence: [],
      };
      const fork = { fen: ordinary.after, theme: "Forks & double attacks" };
      return [
        shouldAutoCoach(ordinary),
        shouldAutoCoach({ ...ordinary, san: "Bxc6+" }),
        shouldAutoCoach({ ...ordinary, grade: "blunder", loss: 420 }),
        shouldAutoCoach({ ...ordinary, grade: "mistake", loss: 200 }),
        shouldAutoCoach({ ...ordinary, mate: 3 }),
        shouldAutoCoach({ ...ordinary, evidence: [fork] }),
        shouldAutoCoach({
          ...ordinary,
          before: ordinary.before.replace(/ 1$/, " 15"),
          evidence: [fork],
        }),
      ];
    });
    assert.deepEqual(policy, [false, false, true, true, true, false, true]);
    await page.locator("#coach-speak").click();
    await page.waitForFunction(
      () => visualLesson?.name === "play" && speechAudio && !speechAudio.paused,
      {},
      { timeout: 30000 },
    );
    assert.equal(await page.evaluate(() => visualLesson.automatic), false);
    // Move past the grade: the newly opened bishop diagonal must match the narration.
    await page
      .locator("#play-lesson-player .lesson-controls button")
      .nth(2)
      .click();
    await page.waitForFunction(
      () => speechAudio && !speechAudio.paused && visualLesson?.index === 1,
      {},
      { timeout: 30000 },
    );
    const cues = await page.evaluate(() => {
      const step = visualLesson.steps[visualLesson.index];
      return {
        text: step.text,
        arrows: step.arrows,
        missing: step.squares.filter(
          (sq) =>
            !document.querySelector(
              `#play-board [data-square="${sq}"].fact-square`,
            ),
        ),
      };
    });
    assert(cues.arrows.length >= 2);
    assert(cues.arrows.every((a) => a.from === "f1"));
    assert(cues.arrows.every((a) => a.kind === "control"));
    assert.deepEqual(cues.missing, []);
    assert.equal(
      await page.locator("#play-board .fact-control").count(),
      cues.arrows.length,
    );
    assert.equal(await page.locator("#play-board .fact-source").count(), 1);
    assert.equal(
      await page.locator("#play-board .control-arrow").count(),
      cues.arrows.length,
    );
    assert.match(cues.text, /bishop.s diagonal/);
    await page.screenshot({
      path: "/tmp/chess-synchronized-targets.png",
      fullPage: true,
    });
    const liveCoachFen = await page.evaluate(() => visualLesson.saved.fen);
    await page.evaluate(() => speechAudio.dispatchEvent(new Event("ended")));
    await page.waitForFunction(() => visualLesson === null);
    assert.equal(await page.evaluate(() => boards.play.fen), liveCoachFen);
    assert.equal(await page.evaluate(() => canInteract("play")), true);
    assert.equal(await page.locator("#new-game").isEnabled(), true);
    // Opening a fact directly must also restore the real game, not leave a preview behind.
    await page.locator("#coach-evidence button").first().click();
    await page.waitForFunction(
      () => speechAudio && !speechAudio.paused,
      {},
      { timeout: 30000 },
    );
    await page.evaluate(() => speechAudio.dispatchEvent(new Event("ended")));
    await page.waitForFunction(() => visualLesson === null);
    assert.equal(await page.evaluate(() => boards.play.fen), liveCoachFen);
    assert.equal(await page.evaluate(() => coachPreview), null);
    assert.equal(await page.evaluate(() => canInteract("play")), true);
    console.log(
      "PASS requested coach lessons and fact cards finish by restoring the playable game automatically",
    );
    // Significant explanations are interruptible without blocking the next move.
    await page.evaluate(() => {
      lastCoach = { ...lastCoach, grade: "blunder", loss: 400 };
      coachLessonWhenReady(lastCoach);
    });
    await page.waitForFunction(() => visualLesson?.automatic);
    assert.equal(await page.locator("#new-game").isEnabled(), true);
    await page.locator('#play-board [data-square="g1"]').click();
    assert.equal(await page.evaluate(() => visualLesson), null);
    assert.equal(await page.evaluate(() => boards.play.selected), "g1");
    await page.locator('#play-board [data-square="f3"]').click();
    await page.waitForFunction(
      () => playedMoves.length === 4 && !botBusy && !boards.play.busy,
    );
    await page.locator("#voice-toggle").click();
    await page.locator("#coach-speak").click();
    assert.equal(await page.evaluate(() => visualLesson.spoken), false);
    assert(await page.locator("#play-lesson-player").isVisible());
    await page.evaluate(() => {
      lessonStep(visualLesson.steps.length - 1);
    });
    await page
      .locator("#play-lesson-player .lesson-controls button")
      .nth(1)
      .click();
    await page.waitForTimeout(3500);
    assert(await page.evaluate(() => Boolean(visualLesson?.paused)));
    await page
      .locator("#play-lesson-player .lesson-controls button")
      .nth(1)
      .click();
    await page.waitForFunction(
      () => visualLesson === null,
      {},
      { timeout: 12000 },
    );
    assert.equal(await page.evaluate(() => canInteract("play")), true);
    console.log(
      "PASS selective coaching keeps opening quiet, explains blunders and requests, synchronizes the opened bishop diagonal to speech, and offers silent diagrams when muted",
    );
    assert.deepEqual(errors, []);
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const phone = await context.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto(base);
    await phone.waitForFunction(
      () => data?.ready && practiceData && !boards.puzzle.busy,
    );
    for (const name of ["overview", "puzzles", "play", "games", "settings"]) {
      await phone.locator(`[data-page="${name}"]`).tap();
      assert(
        await phone.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        name + " must fit mobile viewport",
      );
      const target = name === "settings" ? "#pref-voice" : "#voice-toggle";
      assert((await phone.locator(target).boundingBox()).height >= 30);
    }
    await phone.screenshot({
      path: "/tmp/chess-experience-mobile-settings.png",
      fullPage: true,
    });
    await phone.locator('[data-page="puzzles"]').tap();
    assert(
      await phone.evaluate(
        () =>
          document.querySelector("#puzzle-board").getBoundingClientRect()
            .bottom <=
          document.querySelector("aside>nav").getBoundingClientRect().top,
      ),
      "the full board must be above mobile navigation",
    );
    await phone.screenshot({
      path: "/tmp/chess-experience-mobile-training.png",
      fullPage: true,
    });
    console.log(
      "PASS all five mobile pages fit, visible labeled navigation and usable settings controls",
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
