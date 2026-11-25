const { spawnSync } = require("node:child_process");

// Ask the OS for an available ephemeral port. Random fixed ranges sometimes
// selected browser-blocked ports (for example 6666) and collided across suites.
function allocatePort() {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const server = require('node:net').createServer(); server.listen(0, '127.0.0.1', () => { process.stdout.write(String(server.address().port)); server.close(); }); server.on('error', error => { console.error(error.message); process.exitCode = 1; });",
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  if (result.status !== 0)
    throw new Error(
      "Cannot allocate test port: " + (result.stderr || result.error),
    );
  const port = Number(result.stdout);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid test port: " + result.stdout);
  return port;
}

module.exports = { allocatePort };
