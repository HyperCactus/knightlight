// Isolated, silent UI timings plus structural regressions; no hardware-specific budget.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { allocatePort } = require('./support.cjs');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knightlight-ui-performance-'));
const port = allocatePort();
for (const name of ['static', 'scripts', 'vendor']) fs.symlinkSync(path.join(root, name), path.join(dir, name));
fs.mkdirSync(path.join(dir, 'data'));
fs.symlinkSync(path.join(root, 'data/openings'), path.join(dir, 'data/openings'));
const server = spawn(path.join(root, 'target/release/chess-study'), [], { cwd: dir, env: { ...process.env, PORT: String(port), CHESS_PLAYER: 'UI Performance' } });
let logs = '', browser;
server.stdout.on('data', b => logs += b);
server.stderr.on('data', b => logs += b);
(async () => {
  for (let n = 0;;n++) {
    try { if ((await (await fetch(`http://127.0.0.1:${port}/api/data`)).json()).ready) break; } catch {}
    if (n > 600 || server.exitCode !== null) throw Error(logs);
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ headless: true, args: ['--mute-audio', '--enable-automation'], ...(process.env.CHESS_TEST_BROWSER ? { executablePath: process.env.CHESS_TEST_BROWSER } : {}) });
  const browserSession = await browser.newBrowserCDPSession();
  assert((await browserSession.send('Browser.getBrowserCommandLine')).arguments.includes('--mute-audio'));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  // A slow/unreachable public font host must not delay the installed app.
  let fontRequests = 0;
  await page.route(/https:\/\/(fonts.googleapis.com|fonts.gstatic.com)\//, async route => {
    fontRequests++;
    await new Promise(r => setTimeout(r, 2000));
    await route.abort();
  });
  const start = performance.now();
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
  const documentReady = performance.now() - start;
  await page.waitForFunction(() => typeof boards !== 'undefined' && document.querySelector('#play-board .square'));
  const fontLoads = await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('400 16px "DM Sans"'),
      document.fonts.load('700 16px "DM Sans"'),
      document.fonts.load('400 24px "DM Serif Display"'),
      document.fonts.load('italic 400 24px "DM Serif Display"'),
    ]);
    return [...document.fonts].filter(font => font.status === "loaded").length;
  });
  await page.evaluate(() => navigate('play'));
  await page.waitForTimeout(300); // Finish the normal page entrance animation.
  const report = await page.evaluate(() => {
    // Isolate rendering from request, speech and opponent work.
    boards.play.fen = startFen;
    boards.play.selected = null;
    renderBoard('play');
    const board = document.querySelector('#play-board');
    const labels = [...board.querySelectorAll('.coord')];
    const piecesBefore = [...board.querySelectorAll('.piece')];
    const mutations = new MutationObserver(() => {});
    mutations.observe(board, { subtree: true, attributes: true, childList: true });
    const times = [];
    for (let batch = 0; batch < 5; batch++) {
      const start = performance.now();
      for (let n = 0; n < 100; n++) renderBoard('play');
      times.push((performance.now() - start) / 100);
    }
    const records = mutations.takeRecords();
    mutations.disconnect();
    return { render_ms: times, mutations_per_render: records.length / 500,
      stable_coordinates: labels.every(node => node.isConnected),
      stable_pieces: piecesBefore.every(node => node.isConnected),
      squares: board.querySelectorAll(':scope > .square').length };
  });
  const result = { document_ready_ms: +documentReady.toFixed(1), remote_font_requests: fontRequests, ...report };
  console.log(JSON.stringify(result, null, 2));
  if (!process.env.CHESS_UI_BASELINE) {
    assert.equal(fontRequests, 0, 'Startup still depends on a public font server');
    assert.equal(fontLoads, 3, 'All bundled typefaces should load locally');
    assert(report.stable_coordinates, 'Redraw replaces unchanged coordinate labels');
    assert(report.stable_pieces, 'Redraw replaces unchanged pieces');
    assert.equal(report.squares, 64);
    assert(report.mutations_per_render < 10, 'Unchanged boards should not churn the DOM');
    const states = await page.evaluate(() => {
      const board = document.querySelector('#play-board');
      boards.play.flip = true;
      renderBoard('play');
      const flipped = board.firstElementChild.dataset.square === 'h1'
        && board.querySelector('[data-square="h1"] .rank').textContent === '1'
        && board.querySelector('[data-square="a8"] .file').textContent === 'a'
        && !board.querySelector('[data-square="a1"] .rank');
      boards.play.flip = false;
      boards.play.selected = 'e2';
      boards.play.legal = ['e2e3', 'e2e4'];
      renderBoard('play');
      const selected = board.querySelector('[data-square="e2"]').getAttribute('aria-pressed') === 'true'
        && board.querySelector('[data-square="e4"]').classList.contains('legal');
      preferences.assist = true;
      boards.play.threats = { position: startFen, white: ['e4'], black: ['d5'] };
      cacheAssist(boards.play.threats);
      renderBoard('play');
      renderBoard('play');
      const assistObserver = new MutationObserver(() => {});
      assistObserver.observe(board, { subtree: true, attributes: true, childList: true });
      renderBoard('play');
      const assistMutations = assistObserver.takeRecords().length;
      assistObserver.disconnect();
      const assist = board.querySelector('[data-square="e4"]').dataset.assist === 'you'
        && board.querySelector('[data-square="e4"]').getAttribute('aria-label').includes('controlled by your pieces');
      preferences.assist = false;
      renderBoard('play');
      const cleared = !board.querySelector('[data-square="e4"]').getAttribute('aria-label').includes('controlled by');
      return { flipped, selected, assist, cleared, assistMutations };
    });
    assert.deepEqual(states, { flipped: true, selected: true, assist: true, cleared: true, assistMutations: 0 });
    let poolRequests = 0;
    await page.route('**/api/practice?*', async route => {
      const response = await route.fetch();
      const body = await response.json();
      body.pool_ready = ++poolRequests >= 3;
      await route.fulfill({ response, json: body });
    });
    await page.evaluate(() => { practiceFetchedAt = 0; navigate('puzzles'); });
    await page.waitForFunction(() => practiceData?.pool_ready === false);
    await page.waitForFunction(() => practiceData?.pool_ready === true);
    assert.equal(poolRequests, 3, 'Background loading should bypass the five-second summary cache');
    await page.evaluate(() => { practiceData.pool_ready = false; syncPracticePoolRefresh(); navigate('play'); });
    await page.waitForTimeout(650);
    assert.equal(poolRequests, 3, 'Leaving Training must cancel the pool-ready poll');
    assert.equal(await page.evaluate(() => practicePoolTimer), null);
  }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (server.exitCode === null) { const stopped = new Promise(r => server.once('exit', r)); server.kill('SIGTERM'); await stopped; }
  fs.rmSync(dir, { recursive: true, force: true });
});
