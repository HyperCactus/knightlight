// Disposable histories and a delayed real worker prove the opening path does
// not wait for model loading. No browser or audio playback is launched here.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knightlight-opponent-'));
for (const name of ['static', 'vendor']) fs.symlinkSync(path.join(root, name), path.join(dir, name));
fs.mkdirSync(path.join(dir, 'scripts'));
fs.symlinkSync(path.join(root, 'scripts/speech.py'), path.join(dir, 'scripts/speech.py'));
// Slow startup is external to the application, like a cold machine. The actual
// Maia model loads after the delay, then takes over the same game normally.
fs.writeFileSync(path.join(dir, 'scripts/opponent.py'), `import time, runpy\ntime.sleep(2)\nrunpy.run_path(${JSON.stringify(path.join(root, 'scripts/opponent.py'))}, run_name='__main__')\n`);
fs.mkdirSync(path.join(dir, 'data'));
fs.writeFileSync(path.join(dir, 'fixture.pgn'), '[White "Tester"]\n[Black "Other"]\n[WhiteElo "500"]\n[Date "2026.10.01"]\n[Result "0-1"]\n\n1. e4 e5 0-1\n');
const port = require('./support.cjs').allocatePort(), base = `http://127.0.0.1:${port}`;
let server, logs = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start() {
  logs = '';
  server = spawn(path.join(root, 'target/release/chess-study'), [], { cwd: dir, env: { ...process.env, PORT: String(port), CHESS_PLAYER: 'Tester' } });
  server.stdout.on('data', b => logs += b); server.stderr.on('data', b => logs += b);
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await sleep(30);
  }
  throw Error(logs);
}
async function stop() {
  if (!server) return;
  const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited; server = null;
}
async function get(route) { return (await fetch(base + '/api/' + route)).json(); }
async function post(route, body, expected = 200) {
  const r = await fetch(base + '/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(r.status, expected, await r.clone().text()); return r.json();
}
(async () => {
  const measurements = {};
  try {
    await start();
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const begin = performance.now();
    const reply = await post('bot', { fen: afterE4, moves: ['e2e4'], session_id: 'cold-start', style: 'varied' });
    measurements.cached_first_reply_ms = Math.round(performance.now() - begin);
    assert.equal(reply.cached, true);
    assert.equal(reply.book, true);
    assert.match(reply.source, /Maia-3.*cached/);
    assert(!logs.includes('Human opponent ready'), 'Opening must arrive before model readiness');
    assert((await post('board', { fen: afterE4 })).legal.includes(reply.move));
    const replies = new Set([reply.move]);
    for (let i = 0; i < 12; i++) {
      const variation = await post('bot', { fen: afterE4, moves: ['e2e4'], rating: 1200, session_id: 'cold-start' });
      assert.equal(variation.rating, 1200);
      replies.add(variation.move);
    }
    assert(replies.size > 1, 'Cache stores a human move distribution, not one fixed reply');
    console.log('PASS cached first reply arrives during delayed model startup, with legal varied rating-conditioned choices');
    const waitStart = performance.now();
    while (!logs.includes('Human opponent ready')) {
      assert(performance.now() - waitStart < 40000, logs);
      await sleep(40);
    }
    const warmStart = performance.now();
    const live = await post('bot', { fen: afterE4, moves: ['e2e4'], rating: 1200, session_id: 'cold-start' });
    measurements.warm_live_reply_ms = Math.round(performance.now() - warmStart);
    assert.equal(live.cached, false);
    assert.match(live.source, /human move model/);
    console.log('PASS warmed Maia takes over after the opening without changing game state');
    const before = await get('profile');
    const saved = async (id, result, rating = 550) => post('games', {
      white: 'Tester', black: 'Bot', result, date: '2026.11.25', event: 'Adaptation fixture',
      played_at: new Date(Date.UTC(2026, 10, 25, 0, Number(id))).toISOString(),
      session_id: 'adaptive-' + id, moves: ['e2e4', 'e7e5'], opponent_rating: rating,
    });
    for (let i = 0; i < 8; i++) await saved(String(i), '1-0');
    const wins = await get('profile');
    assert(wins.adaptive_rating > before.adaptive_rating + 150);
    const chosen = await post('bot', { fen: startFen });
    assert.equal(chosen.rating, wins.adaptive_rating, 'Server selects calibrated rating for a new adaptive game');
    const fixed = await post('bot', { fen: startFen, rating: 800 });
    assert.equal(fixed.rating, 800, 'Manual/current-game rating is honored');
    const duplicate = await saved('7', '1-0');
    assert.equal(duplicate.adaptive_rating, wins.adaptive_rating, 'Autosave retries cannot inflate difficulty');
    for (let i = 8; i < 14; i++) await saved(String(i), '0-1', wins.adaptive_rating);
    const losses = await get('profile');
    assert(losses.adaptive_rating < wins.adaptive_rating);
    measurements.difficulty = { before: before.adaptive_rating, after_wins: wins.adaptive_rating, after_losses: losses.adaptive_rating };
    await stop(); await start();
    assert.equal((await get('profile')).adaptive_rating, losses.adaptive_rating, 'Difficulty survives restart from existing history');
    console.log('PASS winning streak raises challenge, losses ease it, manual strength stays fixed and adaptation survives restart');
    fs.writeFileSync(path.join(root, 'reports/opponent-startup.json'), JSON.stringify(measurements, null, 2) + '\n');
    console.log(JSON.stringify(measurements));
  } finally { await stop(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
