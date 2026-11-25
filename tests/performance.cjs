// Structural performance regressions plus timings; no machine-specific latency thresholds.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { allocatePort } = require("./support.cjs");
const root = path.resolve(__dirname, "..");
const report = {};
const hash = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) =>
  [...values]
    .sort((a, b) => a - b)
    .slice(Math.floor(values.length / 2) - 1, Math.floor(values.length / 2) + 1)
    .reduce((a, b) => a + b, 0) / 2;
async function fixture(options, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chess-performance-"));
  fs.mkdirSync(path.join(dir, "data"));
  for (const folder of ["static", "scripts", "vendor"])
    fs.symlinkSync(path.join(root, folder), path.join(dir, folder));
  fs.symlinkSync(
    path.join(root, "data/openings"),
    path.join(dir, "data/openings"),
  );
  if (options.bank)
    fs.symlinkSync(
      path.join(root, "data/puzzle-bank.json"),
      path.join(dir, "data/puzzle-bank.json"),
    );
  if (options.games)
    fs.writeFileSync(
      path.join(dir, "data/sessions.json"),
      JSON.stringify(options.games),
    );
  const base = `http://127.0.0.1:${allocatePort()}`;
  let logs = "";
  const server = spawn(path.join(root, "target/release/chess-study"), [], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: base.split(":").pop(),
      CHESS_PLAYER: "Performance",
    },
  });
  server.stdout.on("data", (b) => (logs += b));
  server.stderr.on("data", (b) => (logs += b));
  const request = async (route, body) => {
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
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  try {
    let ready = false;
    for (let n = 0; n < 1200; n++) {
      try {
        if ((await request("data")).ready) {
          ready = true;
          break;
        }
      } catch {}
      if (server.exitCode !== null) throw Error(logs);
      await sleep(100);
    }
    assert(ready, "Performance fixture startup timed out: " + logs);
    await run({ dir, request });
  } finally {
    if (server.exitCode === null) {
      const stopped = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      await stopped;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
(async () => {
  await fixture({ bank: true }, async ({ request }) => {
    const times = [];
    for (let n = 0; n < 8; n++) {
      const start = performance.now();
      const data = await request("practice?mode=fresh&focus=all");
      times.push(+(performance.now() - start).toFixed(2));
      assert(data.pool_size >= 100000);
      assert(data.candidates.length <= 80);
    }
    report.queue = {
      pool: 100000,
      milliseconds: times,
      median_ms: +median(times).toFixed(2),
    };
    console.log(
      "PASS bounded full-bank queue; " + JSON.stringify(report.queue),
    );
  });
  const cycle = ["g1f3", "g8f6", "f3g1", "f6g8"];
  const games = Array.from({ length: 1000 }, (_, i) => ({
    white: "Performance",
    black: "Other",
    result: "*",
    date: "2026.11.08",
    event: "Practice game",
    moves: cycle,
    source: "practice",
    session_id: "archive-" + i,
    white_elo: 1000,
    opponent_rating: 1000,
    played_at: "2026-11-08T00:00:00Z",
  }));
  await fixture({ games }, async ({ dir, request }) => {
    const archive = path.join(dir, "data/sessions.json"),
      before = hash(archive),
      bytes = fs.statSync(archive).size,
      times = [];
    assert.equal((await request("data")).games.length, 1000);
    let largestResponse = 0;
    for (let n = 2; n <= 9; n++) {
      const payload = {
        ...games[500],
        moves: Array.from({ length: n }, () => cycle).flat(),
        analyze: false,
      };
      const start = performance.now(),
        r = await request("games", payload);
      times.push(+(performance.now() - start).toFixed(2));
      assert(
        r.game,
        "Autosave must return the canonical game without a full-library refresh",
      );
      assert.deepEqual(r.game.moves, payload.moves);
      largestResponse = Math.max(
        largestResponse,
        Buffer.byteLength(JSON.stringify(r)),
      );
      assert.equal(
        hash(archive),
        before,
        "A half-move rewrote the legacy archive",
      );
    }
    assert(largestResponse < 16000, "Autosave returned an entire library");
    report.autosave = {
      archive_games: 1000,
      legacy_archive_bytes: bytes,
      archive_unchanged: true,
      milliseconds: times,
      median_ms: +median(times).toFixed(2),
      largest_response_bytes: largestResponse,
    };
    console.log(
      "PASS autosaves leave the 1,000-game archive unchanged and return one game; " +
        JSON.stringify(report.autosave),
    );
  });
  const output =
    process.env.CHESS_BENCHMARK_REPORT ||
    path.join(os.tmpdir(), "chess-performance-results.json");
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log("Performance results: " + output);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
