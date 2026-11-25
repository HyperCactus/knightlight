const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const net = require("node:net");
const root = path.resolve(__dirname, "..");
const binary =
  process.env.CHESS_TEST_BINARY ||
  path.join(root, "target/release/chess-study");
const fixtures = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function game(id, moves = ["e2e4", "e7e5"], result = "*") {
  return {
    white: "Tester",
    black: "Other",
    result,
    date: "2026.11.08",
    event: "Audit",
    moves,
    source: "practice",
    session_id: id,
    opponent_rating: 1200,
  };
}
function fixture() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "chess-backend-regression-"),
  );
  fs.mkdirSync(path.join(dir, "data"));
  for (const name of ["static", "scripts", "vendor"])
    fs.symlinkSync(path.join(root, name), path.join(dir, name));
  fixtures.push(dir);
  return dir;
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function launch(dir, extra = {}, expectFailure = false) {
  const port = await freePort();
  let logs = "";
  const child = spawn(binary, [], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(port),
      CHESS_PLAYER: "Tester",
      STOCKFISH: "/bin/false",
      ...extra,
    },
  });
  child.stdout.on("data", (b) => (logs += b));
  child.stderr.on("data", (b) => (logs += b));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const base = `http://127.0.0.1:${port}`;
  async function request(route, body, status = 200) {
    const response = await fetch(
      base + route,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    const text = await response.text();
    assert.equal(response.status, status, `${route}: ${text}`);
    return response.headers.get("content-type")?.includes("json")
      ? JSON.parse(text)
      : text;
  }
  if (expectFailure) {
    await Promise.race([
      exited,
      delay(8000).then(() => {
        child.kill();
        throw Error("Corrupt history did not stop startup");
      }),
    ]);
    assert.notEqual(child.exitCode, 0);
    return { logs };
  }
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw Error("Server exited: " + logs);
    try {
      await request("/api/data");
      break;
    } catch (error) {
      if (i === 199) throw error;
      await delay(30);
    }
  }
  return {
    request,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
    },
  };
}
async function run() {
  for (const name of [
    "sessions.json",
    "imports.json",
    "learning.json",
    "practice.json",
    "library-order.json",
  ]) {
    const dir = fixture(),
      file = path.join(dir, "data", name);
    fs.writeFileSync(file, "[");
    const result = await launch(dir, {}, true);
    assert.match(result.logs, /preserved/);
    assert.match(result.logs, new RegExp(name.replace(".", "\\.")));
    assert.equal(fs.readFileSync(file, "utf8"), "[");
  }
  console.log(
    "PASS corrupt session/import/learning/practice history blocks startup and preserves originals",
  );

  const dir = fixture();
  const tags = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => ["Detail" + i, "x".repeat(900)]),
  );
  const archive = Array.from({ length: 501 }, (_, i) => ({
    ...game("legacy-" + i),
    tags,
  }));
  const legacyPath = path.join(dir, "data/sessions.json");
  fs.writeFileSync(legacyPath, JSON.stringify(archive));
  const legacyBytes = fs.readFileSync(legacyPath);
  let app = await launch(dir);
  try {
    const result = await app.request("/api/games", {
      ...game("legacy-0", ["e2e4", "e7e5", "g1f3"]),
      analyze: false,
    });
    assert.equal(result.game.moves.length, 3);
    assert.equal(result.index, 0);
    assert.equal(typeof result.ready, "boolean");
    assert.equal(typeof result.practice_rating, "number");
    assert.deepEqual(fs.readFileSync(legacyPath), legacyBytes);
    const records = fs
      .readdirSync(path.join(dir, "data/sessions"))
      .filter((f) => f.endsWith(".json"));
    assert.equal(records.length, 1);
    // Imported headers are retained, so this record's size is proportional to ONE
    // game (including its metadata), rather than the multi-megabyte archive.
    const size = fs.statSync(path.join(dir, "data/sessions", records[0])).size;
    assert.ok(
      size < legacyBytes.length / 100,
      `record ${size}, archive ${legacyBytes.length}`,
    );
    console.log(
      `PASS half-move writes one ${size}-byte session record; ${legacyBytes.length}-byte legacy archive unchanged`,
    );
    await app.request("/api/games", {
      ...game("legacy-0", ["e2e4", "e7e5"]),
      analyze: false,
    });
    assert.equal((await app.request("/api/data")).games[0].moves.length, 3);
    await app.stop();
    app = await launch(dir);
    assert.equal((await app.request("/api/data")).games[0].moves.length, 3);
    const backup = await app.request("/api/games/pgn");
    assert.ok(Buffer.byteLength(backup) > 8 * 1024 * 1024);
    assert.equal((backup.match(/\[Event /g) || []).length, 501);
    const restoreDir = fixture(),
      restored = await launch(restoreDir);
    try {
      const imported = await restored.request("/api/imports", { pgn: backup });
      assert.equal(imported.imported, 501);
      assert.equal((await restored.request("/api/data")).games.length, 501);
      assert.equal(
        (await restored.request("/api/imports", { pgn: backup })).duplicates,
        501,
      );
    } finally {
      await restored.stop();
    }
    console.log(
      "PASS 501-game backup above 8 MB restores and deduplicates; newer records override legacy snapshots after restart",
    );

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        app.request("/api/games", { ...game("parallel-" + i), analyze: false }),
      ),
    );
    const long = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6"];
    await Promise.all([
      app.request("/api/games", {
        ...game("parallel-0", long),
        analyze: false,
      }),
      app.request("/api/games", {
        ...game("parallel-0", long.slice(0, 4)),
        analyze: false,
      }),
    ]);
    const before = await app.request("/api/data");
    assert.equal(before.games.length, 513);
    assert.equal(
      before.games.find((g) => g.session_id === "parallel-0").moves.length,
      6,
    );
    await app.stop();
    app = await launch(dir);
    assert.deepEqual(
      (await app.request("/api/data")).games.map((g) => [
        g.session_id,
        g.moves,
      ]),
      before.games.map((g) => [g.session_id, g.moves]),
    );
    const completed = {
      ...game("rated-dedup", ["e2e4", "e7e5"], "1/2-1/2"),
      analyze: false,
    };
    await Promise.all([
      app.request("/api/games", completed),
      app.request("/api/games", completed),
    ]);
    assert.equal((await app.request("/api/profile")).rated_games, 1);
    console.log(
      "PASS serialized concurrent saves, stale prefix protection, stable restart order and completed-result deduplication",
    );

    // Imports append after live sessions; restarts must preserve their numeric
    // indices and the indices of subsequent bot sessions.
    const interleavedPgn =
      '[Event "Interleaved import"]\n[White "Tester"]\n[Black "Imported"]\n[Date "2026.11.08"]\n[Result "*"]\n\n1. d4 d5 *\n';
    const inserted = await app.request("/api/imports", { pgn: interleavedPgn });
    assert.equal(inserted.imported, 1);
    await app.request("/api/games", {
      ...game("after-import"),
      analyze: false,
    });
    const mixedOrder = (await app.request("/api/data")).games.map((g) => [
      g.session_id,
      g.black,
      g.moves,
    ]);
    await app.stop();
    app = await launch(dir);
    assert.deepEqual(
      (await app.request("/api/data")).games.map((g) => [
        g.session_id,
        g.black,
        g.moves,
      ]),
      mixedOrder,
    );
    console.log(
      "PASS interleaved PGN imports and bot games retain exact review indices across restart",
    );

    const id = "parallel-1",
      recordPath = path.join(
        dir,
        "data/sessions",
        Buffer.from(id).toString("hex") + ".json",
      );
    await app.request("/api/games", {
      ...game(id, ["e2e4", "e7e5", "g1f3"]),
      analyze: false,
    });
    const knownGood = fs.readFileSync(recordPath + ".bak");
    assert.equal(JSON.parse(knownGood).game.session_id, id);
    fs.writeFileSync(recordPath, "[");
    await app.request(
      "/api/games",
      { ...game(id, ["e2e4", "e7e5", "g1f3", "b8c6"]), analyze: false },
      503,
    );
    assert.equal(fs.readFileSync(recordPath, "utf8"), "[");
    assert.deepEqual(fs.readFileSync(recordPath + ".bak"), knownGood);
    await app.stop();
    const rejected = await launch(dir, {}, true);
    assert.match(rejected.logs, /preserved/);
    console.log(
      "PASS damaged live record never replaces original or known-good backup and prevents unsafe restart",
    );
  } finally {
    await app.stop();
  }

  const fallbackDir = fixture();
  fs.unlinkSync(path.join(fallbackDir, "vendor"));
  fs.mkdirSync(path.join(fallbackDir, "vendor/maia-model"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(fallbackDir, "vendor/maia-env/bin"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(fallbackDir, "vendor/maia-model/maia3-5m.pt"),
    "fixture",
  );
  fs.writeFileSync(
    path.join(fallbackDir, "vendor/maia-env/bin/python"),
    "not executable",
    { mode: 0o644 },
  );
  const fallback = await launch(fallbackDir, {
    STOCKFISH: path.join(root, "vendor/stockfish/usr/games/stockfish"),
  });
  try {
    const reply = await fallback.request("/api/bot", {
      fen: "8/5pk1/8/8/8/8/5PK1/8 w - - 0 30",
      rating: 1200,
    });
    assert.equal(reply.source, "Stockfish · varied policy");
    assert.match(reply.move, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
    console.log(
      "PASS Maia startup failure falls back to a legal Stockfish move",
    );
  } finally {
    await fallback.stop();
  }
}
run()
  .then(() =>
    console.log("Backend regression fixtures: " + fixtures.join(", ")),
  )
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
