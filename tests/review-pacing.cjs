// Verify server-selected reading effort, including upgrades of old review caches.
// No browser, speech, real progress or real game history is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { allocatePort } = require("./support.cjs");
const root = path.resolve(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chess-review-pacing-"));
fs.mkdirSync(path.join(dir, "data"));
for (const name of ["static", "scripts", "vendor"])
  fs.symlinkSync(path.join(root, name), path.join(dir, name));
fs.writeFileSync(
  path.join(dir, "fixture.pgn"),
  `[White "Tester"]
[Black "Other"]
[Result "*"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 *

[White "Tester"]
[Black "Other"]
[Result "0-1"]

1. f3 e5 2. g4 Qh4# 0-1
`,
);
let server,
  base,
  logs = "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function get(route) {
  const response = await fetch(base + "/api/" + route);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function start() {
  const port = allocatePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(path.join(root, "target/release/chess-study"), [], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), CHESS_PLAYER: "Tester" },
  });
  server.stdout.on("data", (b) => (logs += b));
  server.stderr.on("data", (b) => (logs += b));
  for (let n = 0; n < 400; n++) {
    if (server.exitCode !== null) throw Error(logs);
    try {
      if ((await get("data")).ready) return;
    } catch {}
    await sleep(100);
  }
  throw Error("Review preparation timed out: " + logs);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const stopped = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGTERM");
  await stopped;
  server = null;
}
function bounds(reviews) {
  for (const r of reviews)
    for (const m of r.moves) {
      assert(Number.isFinite(m.review_pace.multiplier));
      assert(m.review_pace.multiplier >= 0.5 && m.review_pace.multiplier <= 2);
      assert(m.review_pace.complexity >= 0 && m.review_pace.complexity <= 100);
      assert(m.review_pace.signals.length > 0);
    }
}
(async () => {
  try {
    await start();
    const originalPGN = await (await fetch(base + "/api/games/pgn")).text();
    const initial = [await get("reviews/0"), await get("reviews/1")];
    bounds(initial);
    assert.equal(initial[0].moves[0].review_pace.multiplier, 0.5);
    const recapture = initial[0].moves.find((m) => m.san === "Nxd4");
    assert.equal(recapture.review_pace.multiplier, 0.5);
    assert(recapture.review_pace.signals.includes("Straightforward recapture"));
    assert.equal(initial[1].moves[2].review_pace.multiplier, 2);
    assert(
      initial[1].moves[2].review_pace.signals.includes("A forcing mating idea"),
    );
    const expected = initial.map((r) => r.moves.map((m) => m.review_pace));
    await stop();
    for (const file of fs.readdirSync(path.join(dir, "data/reviews"))) {
      if (!file.endsWith(".json")) continue;
      const location = path.join(dir, "data/reviews", file),
        cache = JSON.parse(fs.readFileSync(location));
      cache.moves.forEach((m, i) => {
        if (i % 2) delete m.review_pace;
        else
          m.review_pace = {
            multiplier: 999,
            complexity: 255,
            signals: ["Obsolete scoring"],
          };
      });
      fs.writeFileSync(location, JSON.stringify(cache));
    }
    await start();
    const loaded = [await get("reviews/0"), await get("reviews/1")];
    bounds(loaded);
    assert.deepEqual(
      loaded.map((r) => r.moves.map((m) => m.review_pace)),
      expected,
    );
    assert.equal(
      await (await fetch(base + "/api/games/pgn")).text(),
      originalPGN,
    );
    console.log(
      "PASS routine opening/recapture at 0.5×, mating blunder at 2×, per-move reasons, cache recomputation and unchanged saved games",
    );
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
