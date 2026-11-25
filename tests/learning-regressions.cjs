// API-only regressions. Isolated progress/library; no browser or audio playback.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const dir = fs.mkdtempSync(
  path.join(os.tmpdir(), "chess-learning-regressions-"),
);
fs.mkdirSync(path.join(dir, "data"));
for (const name of ["vendor", "scripts", "static"])
  fs.symlinkSync(path.join(root, name), path.join(dir, name));
const bank = JSON.parse(
  fs.readFileSync(path.join(root, "data/puzzle-bank.json")),
).slice(0, 1000);
for (const puzzle of bank) {
  puzzle.rating = 1100;
  puzzle.theme = "Pins";
}
fs.writeFileSync(path.join(dir, "data/puzzle-bank.json"), JSON.stringify(bank));
fs.writeFileSync(
  path.join(dir, "fixture.pgn"),
  '[White "Tester"]\n[Black "Other"]\n[Date "2026.11.07"]\n[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1\n',
);
const day = Math.floor((Date.now() / 1000 + 36000) / 86400);
const practice = {
  cards: Object.fromEntries(
    bank.map((p) => [
      "lichess-" + p.id,
      { due: day + 30, attempts: 1, last: day },
    ]),
  ),
};
fs.writeFileSync(
  path.join(dir, "data/practice.json"),
  JSON.stringify(practice),
);
let server,
  base,
  logs = "";
async function api(route, body) {
  const response = await fetch(
    base + "/api/" + route,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const value = await response.json();
  assert(response.ok, `${route}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
async function stop() {
  if (!server) return;
  const child = server;
  server = null;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}
async function start(player) {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  base = "http://127.0.0.1:" + port;
  server = spawn(path.join(root, "target/release/chess-study"), [], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), CHESS_PLAYER: player },
  });
  server.stdout.on("data", (b) => (logs += b));
  server.stderr.on("data", (b) => (logs += b));
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    try {
      if ((await api("data")).ready) return;
    } catch {}
    if (server.exitCode !== null) throw Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw Error("Server readiness timeout: " + logs);
}
(async () => {
  try {
    await start("Tester");
    const review = await api("reviews/0");
    assert.deepEqual(
      review.moves.map((m) => m.player),
      [true, false, true, false],
    );
    const initial = await api("practice?mode=review");
    assert.equal(initial.queue.length, 0);
    assert.equal(initial.due, 0);
    // This root move only blocks a check. Its pinned knight cannot take either target.
    const pinned = await api("coach", {
      fen: "7k/8/7b/8/8/1r1p1q2/8/1NK5 w - - 0 1",
      uci: "b1d2",
      learn: false,
    });
    assert(!pinned.evidence.some((f) => f.theme === "Forks & double attacks"));
    assert.match(pinned.explanation, /blocks.*check/);
    // Shipped Lichess 00O9Z: a queen sacrifice forces mate in four.
    const mating = await api("coach", {
      fen: "5Q1R/5p1p/1b3qp1/p6k/P2P4/8/1P2rPPP/5RK1 b - - 8 32",
      uci: "f6f2",
      learn: false,
    });
    assert.equal(mating.best_mate, 4);
    assert.match(mating.explanation, /force checkmate/);
    assert(!mating.explanation.includes("gives up material"));
    const finalStep = mating.evidence[0].follow_up.at(-1);
    assert.match(finalStep.text, /checkmate/);
    const endpoint = await api("board", { fen: finalStep.fen });
    assert(endpoint.check && endpoint.outcome);
    const originalPGN = await (await fetch(base + "/api/games/pgn")).text();
    await stop();
    // An overdue card outside the current rating band must remain retrievable.
    bank[999].rating = 2400;
    const dueId = "lichess-" + bank[999].id;
    practice.cards[dueId].due = day - 2;
    fs.writeFileSync(
      path.join(dir, "data/puzzle-bank.json"),
      JSON.stringify(bank),
    );
    fs.writeFileSync(
      path.join(dir, "data/practice.json"),
      JSON.stringify(practice),
    );
    await start("Other");
    const other = await api("reviews/0");
    assert.deepEqual(
      other.moves.map((m) => m.player),
      [false, true, false, true],
    );
    assert.equal(other.blunders, 0);
    assert.equal(other.accuracy, 100);
    assert.equal(
      (await api("profile")).samples,
      2,
      "Model must contain only current player observations",
    );
    const due = await api("practice?mode=review");
    assert.equal(due.due, 1);
    assert.deepEqual(due.queue, [dueId]);
    assert.deepEqual(
      due.candidates.map((p) => p.id),
      [dueId],
    );
    assert.equal(
      await (await fetch(base + "/api/games/pgn")).text(),
      originalPGN,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, "data/practice.json"))).xp,
      undefined,
      "Review must not award XP",
    );
    console.log(
      "PASS: king-safe tactical lessons, mate-in-four payoff, cached player/model migration, overdue retrievals, unchanged history/progress.",
    );
    console.log("Disposable evidence: " + dir);
  } finally {
    await stop();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
