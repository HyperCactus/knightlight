#!/usr/bin/env node
// Capture the real interface with example games; never load the user's profile.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'knightlight-screenshots-'));
const output = path.join(root, 'docs/screenshots');
for (const name of ['static', 'scripts', 'vendor']) fs.symlinkSync(path.join(root, name), path.join(directory, name));
fs.mkdirSync(path.join(directory, 'data'));
for (const name of ['openings', 'puzzle-bank.json', 'public-puzzles.json', 'bot-openings.json']) {
  if (fs.existsSync(path.join(root, 'data', name))) fs.symlinkSync(path.join(root, 'data', name), path.join(directory, 'data', name));
}
fs.writeFileSync(path.join(directory, 'example.pgn'), `[Event "The Opera Game"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Date "1858.??.??"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0
`);
const port = require('../tests/support.cjs').allocatePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(path.join(root, 'target/release/chess-study'), [], {
  cwd: directory, env: { ...process.env, PORT: String(port), CHESS_PLAYER: 'Paul Morphy' },
});
let logs = '', browser;
server.stdout.on('data', b => logs += b);
server.stderr.on('data', b => logs += b);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  try {
    let ready = false;
    for (let i = 0; i < 600; i++) {
      try { ready = (await (await fetch(base + '/api/data')).json()).ready; } catch {}
      if (ready) break;
      if (server.exitCode !== null) throw Error(logs);
      await wait(200);
    }
    assert(ready, logs);
    browser = await chromium.launch({ headless: true, args: ['--mute-audio', '--enable-automation'],
      ...(process.env.CHESS_TEST_BROWSER ? { executablePath: process.env.CHESS_TEST_BROWSER } : {}) });
    const command = await (await browser.newBrowserCDPSession()).send('Browser.getBrowserCommandLine');
    assert(command.arguments.includes('--mute-audio'), 'Verify browser is muted before opening the app');
    const context = await browser.newContext({ viewport: { width: 1440, height: 1240 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => typeof data !== 'undefined' && data.ready);
    await page.evaluate(() => document.fonts.ready);
    fs.mkdirSync(output, { recursive: true });
    async function shot(name) {
      await wait(650);
      await page.screenshot({ path: path.join(output, name + '.png') });
      console.log('Captured', name);
    }
    await shot('overview');
    await page.locator('[data-page="puzzles"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#puzzle-board .square').length === 64);
    await shot('training');
    await page.locator('[data-page="play"]').click();
    await page.locator('#play-board [data-square="e2"]').click();
    await page.locator('#play-board [data-square="e4"]').click();
    await page.waitForFunction(() => boards.play && !boards.play.busy && !botBusy && boards.play.turn === 'white', null, { timeout: 30000 });
    await shot('play');
    await page.locator('[data-page="games"]').click();
    await page.waitForFunction(() => typeof currentReview !== 'undefined' && currentReview?.moves.length === 33);
    // Navigate using the same move list the reader will use, then show the best line.
    await page.evaluate(() => { stopSpeech(); return seekReview(19, { explain: false }); });
    await wait(650);
    await page.locator('#game-board').evaluate(board => board.scrollIntoView({ block: 'center' }));
    await shot('review');
    assert.deepEqual(errors, []);
    console.log('PASS: real app screenshots; verified muted Chromium; disposable example library only');
    await context.close();
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
