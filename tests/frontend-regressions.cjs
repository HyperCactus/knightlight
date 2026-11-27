// Deterministic request races exercise the actual application functions, then
// real muted Chromium verifies narration ownership and media-error recovery.
const fs = require("node:fs"),
  vm = require("node:vm"),
  assert = require("node:assert/strict");
const path = require("node:path"),
  os = require("node:os"),
  { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
function source(file, start, end) {
  const text = fs.readFileSync(path.join(root, "static", file), "utf8"),
    first = text.indexOf(start);
  assert(first >= 0, start);
  const last = text.indexOf(end, first + start.length);
  assert(last > first, end);
  return text.slice(first, last);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function context() {
  const nodes = new Map();
  const $ = (selector) => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        textContent: "",
        className: "",
        disabled: false,
        hidden: false,
        value: "all",
        classList: { contains: () => true },
        replaceChildren() {},
      });
    return nodes.get(selector);
  };
  const c = vm.createContext({
    console,
    Promise,
    Date,
    Math,
    Error,
    JSON,
    Map,
    Set,
    setTimeout: () => 123,
    clearTimeout() {},
    $,
    data: {
      games: [
        { white: "Zero", black: "A", source: "import", moves: [] },
        { white: "One", black: "B", source: "import", moves: [] },
      ],
      player: "Zero",
      puzzles: [],
    },
    gameIndex: 0,
    reviewRequest: 0,
    reviewTimer: null,
    currentReview: null,
    currentReviewGame: -1,
    replayPly: 0,
    boards: {
      game: { fen: "start" },
      play: { fen: "old position", turn: "white", busy: false },
    },
    startFen: "start",
    syncLibrary() {},
    renderReview() {},
    setBoard: async () => {},
    opponentChallenge: null,
    stopSpeech() {},
    closeGameResult() {},
    renderBoard() {},
    toast() {},
    message() {},
    updateOpening() {},
    updateRatingControl() {},
    evalBar() {},
    persistBoard() {},
    newGameBusy: false,
    playTransition: null,
    botBusy: false,
    gameFinished: false,
    visualLesson: null,
    coachPreview: null,
    playedMoves: ["e2e4", "e7e5"],
    coachRequestId: 0,
    sessionId: "old",
    gameOpponentRating: 1000,
    practiceStartedAt: null,
    undoFen: "start",
    undoMoves: 0,
    profileData: null,
    lastCoach: null,
    completedGame: null,
    crypto: { randomUUID: () => "new" },
    localStorage: { removeItem() {} },
  });
  c.applyBoard = (name, position) => Object.assign(c.boards[name], position);
  return c;
}
async function races() {
  const replay = source(
    "studio.js",
    "async function replay()",
    "function renderReview(",
  );
  {
    const c = context(),
      oldBody = deferred(),
      parsing = deferred();
    c.fetch = async (url) =>
      url.endsWith("/0")
        ? {
            status: 200,
            ok: true,
            json: () => {
              parsing.resolve();
              return oldBody.promise;
            },
          }
        : {
            status: 200,
            ok: true,
            json: async () => ({ label: "One", moves: [1, 2] }),
          };
    vm.runInContext(replay, c);
    const first = vm.runInContext("replay()", c);
    await parsing.promise;
    c.gameIndex = 1;
    await vm.runInContext("replay()", c);
    oldBody.resolve({ label: "Zero", moves: [1] });
    await first;
    assert.equal(c.currentReview.label, "One");
    assert.equal(c.currentReviewGame, 1);
  }
  {
    const c = context(),
      request = deferred(),
      fetching = deferred();
    let timers = 0;
    c.fetch = async (url) =>
      url.endsWith("/0")
        ? { status: 202 }
        : {
            status: 200,
            ok: true,
            json: async () => ({ label: "One", moves: [1, 2] }),
          };
    c.setBoard = async (name, fen, valid) => {
      fetching.resolve();
      await request.promise;
      if (valid()) c.boards[name].fen = fen;
    };
    c.renderReview = () => {
      c.boards.game.fen = "new game";
    };
    c.setTimeout = () => ++timers;
    vm.runInContext(replay, c);
    const first = vm.runInContext("replay()", c);
    await fetching.promise;
    c.gameIndex = 1;
    await vm.runInContext("replay()", c);
    request.resolve();
    await first;
    assert.equal(c.boards.game.fen, "new game");
    assert.equal(timers, 0);
  }
  console.log(
    "PASS stale review JSON and analyzing-board responses cannot overwrite the selected game",
  );
  {
    const c = context(),
      fresh = deferred(),
      review = deferred(),
      urls = [];
    Object.assign(c, {
      trainingReview: false,
      practiceRequests: new Map(),
      practiceFetchedAt: 0,
      practiceFetchedKey: "",
      puzzleMetadata: new Map(),
      currentPuzzle: null,
      practiceData: null,
      renderPractice() {},
      syncPracticePoolRefresh() {},
    });
    c.fetch = async (url) => {
      urls.push(url);
      await (url.includes("mode=review") ? review.promise : fresh.promise);
      return {
        ok: true,
        json: async () => ({
          mode: url.includes("mode=review") ? "review" : "fresh",
          candidates: [],
        }),
      };
    };
    vm.runInContext(
      source("learning.js", "function practiceQuery()", "let drillTranscript"),
      c,
    );
    vm.runInContext(
      source(
        "learning.js",
        "async function refreshPractice(",
        "function renderPractice()",
      ),
      c,
    );
    const first = vm.runInContext("refreshPractice(true)", c);
    c.trainingReview = true;
    const second = vm.runInContext("refreshPractice(true)", c);
    fresh.resolve();
    await Promise.resolve();
    review.resolve();
    await Promise.all([first, second]);
    assert.equal(urls.length, 2);
    assert.equal(c.practiceData.mode, "review");
  }
  console.log(
    "PASS practice requests follow the selected mode and discard obsolete candidate sets",
  );
  {
    const c = context(),
      oldResponse = deferred(),
      invitations = [];
    Object.assign(c, {
      preferences: { reviewChallenges: true },
      perspectivePlans: new Map(),
      updatePerspectiveAvailability(items) {
        invitations.push(items);
      },
    });
    let requests = 0;
    c.fetch = () =>
      ++requests === 1
        ? oldResponse.promise
        : Promise.resolve({
            ok: true,
            json: async () => ({ items: [{ ply: 1, kind: "defend" }] }),
          });
    vm.runInContext(
      source(
        "perspective.js",
        "function preparePerspectives(",
        "function updatePerspectiveAvailability(",
      ),
      c,
    );
    const first = vm.runInContext("preparePerspectives(0)", c);
    c.data.games[0].moves = ["e2e4"];
    const second = vm.runInContext("preparePerspectives(0)", c);
    await second;
    oldResponse.resolve({
      ok: true,
      json: async () => ({ items: [{ ply: 99 }] }),
    });
    assert.equal((await first).length, 0);
    assert.equal(invitations.length, 1);
    assert.equal(invitations[0][0].ply, 1);
    assert.equal(c.perspectivePlans.get(0), second);
  }
  console.log(
    "PASS perspective plans follow game revisions and late responses preserve the new plan",
  );
  const transitions = source(
    "studio.js",
    "function beginPlayTransition()",
    '$("#play-again").onclick',
  );
  {
    const c = context(),
      board = deferred(),
      waiting = deferred();
    c.savePractice = async () => 0;
    c.api = async () => {
      waiting.resolve();
      return board.promise;
    };
    vm.runInContext(transitions, c);
    vm.runInContext(
      source(
        "app.js",
        "function canInteract(",
        "async function choosePromotion(",
      ),
      c,
    );
    const operation = vm.runInContext("newPractice()", c);
    await waiting.promise;
    assert.equal(c.newGameBusy, true);
    assert.equal(vm.runInContext('canInteract("play")', c), false);
    assert.equal(c.sessionId, "old");
    assert.equal(c.playedMoves.length, 2);
    board.reject(Error("connection lost"));
    await operation;
    assert.equal(c.boards.play.fen, "old position");
    assert.equal(c.sessionId, "old");
    assert.equal(c.playedMoves.length, 2);
    assert.equal(c.boards.play.busy, false);
    assert.equal(c.playTransition, null);
    assert.equal(c.$("#new-game").disabled, false);
  }
  {
    const c = context(),
      board = deferred(),
      waiting = deferred();
    c.api = async () => {
      waiting.resolve();
      return board.promise;
    };
    c.savePractice = async () => 0;
    vm.runInContext(transitions, c);
    vm.runInContext(
      source(
        "app.js",
        '$("#take-back").onclick = async',
        "async function legacyReplay()",
      ),
      c,
    );
    const operation = c.$("#take-back").onclick();
    await waiting.promise;
    assert.equal(c.boards.play.busy, true);
    await vm.runInContext("newPractice()", c);
    assert.equal(c.sessionId, "old");
    board.reject(Error("connection lost"));
    await operation;
    assert.equal(c.playedMoves.length, 2);
    assert.equal(c.boards.play.fen, "old position");
    assert.equal(c.boards.play.busy, false);
  }
  {
    const c = context();
    c.savePractice = async () => 0;
    c.api = async () => ({ fen: "start", turn: "white", legal: ["e2e4"] });
    vm.runInContext(transitions, c);
    await vm.runInContext("newPractice()", c);
    assert.equal(c.sessionId, "new");
    assert.equal(c.playedMoves.length, 0);
    assert.equal(c.boards.play.fen, "start");
    assert.equal(c.boards.play.busy, false);
    assert.equal(c.$("#new-game").disabled, false);
  }
  console.log(
    "PASS new-game and takeback transitions lock move input and preserve the current game on failure",
  );
  {
    const c = context();
    let downloads = 0;
    Object.assign(c, {
      historySaveQueue: Promise.resolve(),
      pollTimer: null,
      pollInFlight: false,
      update(d) {
        c.data = d;
      },
      poll() {},
      fetch() {
        downloads++;
        throw Error("Unexpected full library download");
      },
    });
    c.api = async () => ({
      index: 0,
      saved: true,
      game: {
        moves: ["e2e4", "e7e5"],
        result: "*",
        white: "Zero",
        black: "Bot",
      },
      ready: true,
      progress: 2,
      total: 2,
    });
    vm.runInContext(
      source(
        "studio.js",
        "async function savePractice(",
        "function autoSavePractice()",
      ),
      c,
    );
    await vm.runInContext("savePractice(false)", c);
    assert.equal(downloads, 0);
    assert.equal(c.data.games[0].black, "Bot");
  }
  console.log(
    "PASS autosave applies the canonical saved game without downloading the complete library",
  );
  {
    const c = context(), oldBody = deferred();
    c.libraryDataVersion = 0;
    c.pollInFlight = false;
    c.pollTimer = null;
    c.fetch = async () => ({ ok: true, json: () => oldBody.promise });
    c.update = d => { c.data = d; c.libraryDataVersion++; };
    vm.runInContext(source("app.js", "async function poll()", '$("#bot-level").textContent'), c);
    const pending = vm.runInContext("poll()", c);
    await Promise.resolve();
    const latest = { games: [{ event: "New imported game" }], ready: true };
    c.update(latest);
    oldBody.resolve({ games: [], ready: true });
    await pending;
    assert.equal(c.data, latest, "Late polling response must not hide imported games");
    assert.equal(c.pollInFlight, false);
    assert.equal(c.pollTimer, 123, "Schedule a fresh request after ignoring the stale response");
  }
  console.log("PASS old library polling responses cannot remove newly imported games");
}
async function browserChecks() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "chess-frontend-regressions-"),
  );
  for (const folder of ["static", "scripts", "vendor"])
    fs.symlinkSync(path.join(root, folder), path.join(dir, folder));
  fs.mkdirSync(path.join(dir, "data"));
  fs.symlinkSync(
    path.join(root, "data/openings"),
    path.join(dir, "data/openings"),
  );
  fs.writeFileSync(
    path.join(dir, "fixture.pgn"),
    '[White "Tester"]\n[Black "Other"]\n[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1\n',
  );
  fs.writeFileSync(
    path.join(dir, "data/public-puzzles.json"),
    JSON.stringify([
      {
        id: "mate",
        fen: "7k/5K2/6Q1/8/8/8/8/8 w - - 0 1",
        moves: ["g6g7"],
        rating: 900,
        theme: "Checkmate patterns",
        game_url: "https://lichess.org",
      },
    ]),
  );
  const port = require("./support.cjs").allocatePort(),
    base = `http://127.0.0.1:${port}`;
  const server = spawn(path.join(root, "target/release/chess-study"), [], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), CHESS_PLAYER: "Tester" },
  });
  let logs = "",
    browser;
  server.stdout.on("data", (b) => (logs += b));
  server.stderr.on("data", (b) => (logs += b));
  try {
    for (let i = 0; ; i++) {
      try {
        if ((await (await fetch(base + "/api/data")).json()).ready) break;
      } catch {}
      if (i > 400) throw Error(logs);
      await new Promise((r) => setTimeout(r, 100));
    }
    browser = await chromium.launch({
      headless: true,
      args: ["--mute-audio", "--enable-automation"],
      ...(process.env.CHESS_TEST_BROWSER
        ? { executablePath: process.env.CHESS_TEST_BROWSER }
        : {}),
    });
    const command = await (
      await browser.newBrowserCDPSession()
    ).send("Browser.getBrowserCommandLine");
    assert(command.arguments.includes("--mute-audio"));
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1100 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(
      () => data?.ready && activeDrill && !drillLoading && !boards.puzzle.busy,
    );
    await page.locator('[data-page="games"]').click();
    await page.waitForFunction(() => currentReview?.moves.length === 4);
    await page.evaluate(() => {
      voiceEnabled = false;
      preferences.voice = false;
      preferences.reviewChallenges = false;
      replayPly = 3;
      renderReview({ narrate: false });
      readCurrentReview(false);
    });
    await page.evaluate(async () => {
      await startPosition("mate", 0, true);
    });
    assert.equal(await page.evaluate(() => visualLesson?.name), "game");
    console.log(
      "PASS background puzzle preparation preserves the foreground review lesson",
    );
    const retained = await page.evaluate(() => {
      stopSpeech();
      replayPly = 1;
      renderReview({ narrate: false });
      window.auditMove = document.querySelector("#move-list button");
      window.auditChart = document.querySelector("#eval-chart svg");
      auditMove.focus();
      replayPly = 2;
      renderReview({ narrate: false });
      return {
        move: auditMove === document.querySelector("#move-list button"),
        chart: auditChart === document.querySelector("#eval-chart svg"),
        focus: document.activeElement === auditMove,
      };
    });
    assert.deepEqual(retained, { move: true, chart: true, focus: true });
    console.log(
      "PASS review stepping retains move/chart DOM and keyboard focus",
    );
    await page.route("**/api/speech", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ url: "/missing-voice.wav" }),
      }),
    );
    await page.route("**/missing-voice.wav", (route) =>
      route.fulfill({ status: 404, body: "unavailable" }),
    );
    await page.evaluate(() => {
      stopSpeech();
      voiceClips.clear();
      voiceEnabled = true;
      preferences.voice = true;
      preferences.autoDiagrams = true;
      preferences.reviewPause = 800;
      userActivatedAudio = true;
      void startReviewPlayback({ fromStart: true });
    });
    await page.waitForFunction(
      () => !reviewPlayback.running && replayPly === 4,
      {},
      { timeout: 20000 },
    );
    assert.equal(await page.evaluate(() => speechAudio), null);
    assert.deepEqual(errors, []);
    console.log(
      "PASS failed voice media releases narration and automatic review reaches the final move",
    );
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
(async () => {
  await races();
  await browserChecks();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
