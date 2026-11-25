// Run interaction checks against a disposable copy of the user's library and analysis cache.
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  { spawn } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "chess-board-"));
for (const folder of ["static", "scripts", "vendor"])
  fs.symlinkSync(path.join(root, folder), path.join(dir, folder));
fs.mkdirSync(path.join(dir, "data"));
for (const file of fs.readdirSync(root).filter((f) => f.endsWith(".pgn")))
  fs.copyFileSync(path.join(root, file), path.join(dir, file));
fs.symlinkSync(
  path.join(root, "data/openings"),
  path.join(dir, "data/openings"),
);
if (fs.existsSync(path.join(root, "data/reviews")))
  fs.cpSync(path.join(root, "data/reviews"), path.join(dir, "data/reviews"), {
    recursive: true,
  });
fs.copyFileSync(
  path.join(root, "data/public-puzzles.json"),
  path.join(dir, "data/public-puzzles.json"),
);
const port = require("./support.cjs").allocatePort(),
  url = `http://127.0.0.1:${port}`;
const server = spawn(path.join(root, "target/release/chess-study"), [], {
  cwd: dir,
  env: { ...process.env, PORT: String(port) },
});
let logs = "";
server.stderr.on("data", (b) => (logs += b));
server.stdout.on("data", (b) => (logs += b));
(async () => {
  try {
    let ready = false;
    for (let i = 0; i < 300; i++) {
      try {
        const r = await fetch(url + "/api/data");
        if ((await r.json()).ready) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) throw Error(logs);
    const test = spawn(
      process.execPath,
      [path.join(__dirname, "browser.cjs")],
      {
        cwd: root,
        env: { ...process.env, CHESS_TEST_URL: url },
        stdio: "inherit",
      },
    );
    const code = await new Promise((r) => test.once("exit", r));
    if (code) process.exitCode = code;
  } finally {
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
