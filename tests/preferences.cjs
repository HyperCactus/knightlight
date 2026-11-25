const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knightlight-preferences-'));
fs.symlinkSync(path.join(root, 'static'), path.join(dir, 'static'));
let port = require('./support.cjs').allocatePort(), server, browser;
let logs = '';
const base = () => `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    try { if (await fn()) return; } catch {}
    await sleep(100);
  }
  throw Error('Timed out: ' + logs);
}
async function launch() {
  server = spawn(path.join(root, 'target/release/chess-study'), [], { cwd: dir, env: { ...process.env, PORT: String(port) } });
  server.stdout.on('data', b => logs += b);
  server.stderr.on('data', b => logs += b);
  await until(async () => (await fetch(base() + '/api/health')).ok);
}
async function stop() {
  if (!server) return;
  const exited = new Promise(r => server.once('exit', r));
  server.kill('SIGTERM');
  await exited;
  server = null;
}
async function saved() { return (await fetch(base() + '/api/preferences')).json(); }
async function mutedBrowser() {
  const result = await chromium.launch({ headless: true, args: ['--mute-audio', '--enable-automation'], ...(process.env.CHESS_TEST_BROWSER ? { executablePath: process.env.CHESS_TEST_BROWSER } : {}) });
  const command = await (await result.newBrowserCDPSession()).send('Browser.getBrowserCommandLine');
  assert(command.arguments.includes('--mute-audio'));
  return result;
}
async function ready(page, url = base()) {
  await page.goto(url);
  await page.waitForFunction(() => typeof data !== 'undefined' && data.ready && typeof syncSettings === 'function');
}
(async () => {
  try {
    await launch();
    assert.equal(await saved(), null);
    browser = await mutedBrowser();
    let context = await browser.newContext();
    await context.addInitScript(() => {
      if (!localStorage.getItem('chess-preferences')) {
        localStorage.setItem('chess-preferences', JSON.stringify({ voice: false, board: 'walnut', speed: 0.9, reviewPause: 2800 }));
        localStorage.setItem('chess-difficulty', 'manual');
        localStorage.setItem('chess-bot-rating', '900');
        localStorage.setItem('chess-style', 'attacking');
      }
    });
    let page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await ready(page);
    await until(async () => (await saved())?.values.botRating === 900);
    assert.equal((await saved()).values.reviewPause, 1400);
    assert.equal((await saved()).values.voice, false);
    await page.locator('#settings-open').click();
    await page.locator('#pref-theme').selectOption('light');
    await page.locator('#pref-voice-name').selectOption('bf_emma');
    await page.locator('#pref-speed').fill('1.25');
    await page.locator('#pref-speed').dispatchEvent('input');
    await page.locator('#pref-goal').selectOption('10');
    await page.locator('#pref-review-pace').selectOption('2250');
    await page.locator('#pref-ui-sounds').uncheck();
    await page.locator('#pref-assist').check();
    await until(async () => (await saved())?.values.assist && await page.locator('#settings-saved').textContent() === 'All changes saved');
    let expected = await page.evaluate(() => ({ ...preferences }));
    assert.deepEqual((await saved()).values, expected);
    console.log('PASS existing preferences and bot setup migrate, UI changes reach durable storage');
    const state = await saved();
    const send = payload => fetch(base() + '/api/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal((await send(state)).status, 200, 'Retry is idempotent');
    assert.equal((await send({ ...state, updated_at: state.updated_at - 1 })).status, 409, 'Stale save rejected');
    assert.equal((await send({ ...state, updated_at: state.updated_at + 1, values: { speed: 50 } })).status, 400);
    assert.equal((await fetch(base() + '/api/preferences', { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(base() + '/api/preferences/bootstrap.js')).headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(base() + '/api/preferences/bootstrap.js')).headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.deepEqual(errors, []);
    await context.close();
    await browser.close();
    browser = null;
    await stop();
    // New browser process, empty browser storage, different port and hostname.
    port = require('./support.cjs').allocatePort();
    await launch();
    browser = await mutedBrowser();
    context = await browser.newContext();
    page = await context.newPage();
    await ready(page, `http://localhost:${port}`);
    assert.deepEqual(await page.evaluate(() => ({ ...preferences })), expected);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await page.locator('#difficulty').inputValue(), 'manual');
    assert.equal(await page.locator('#bot-rating').inputValue(), '900');
    assert.equal(await page.locator('#play-style').inputValue(), 'attacking');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => typeof syncSettings === 'function' && typeof data !== 'undefined' && data.ready);
    assert.deepEqual(await page.evaluate(() => ({ ...preferences })), expected);
    console.log('PASS browser/server relaunch, fresh profile, localhost alias, port change and cleared browser storage');
    // Closing immediately must flush the last edit before the debounce expires.
    await page.evaluate(() => changePreference('voiceVolume', 17));
    await page.close();
    await until(async () => (await saved())?.values.voiceVolume === 17);
    page = await context.newPage();
    await ready(page);
    await page.route('**/api/preferences', route => route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"Disk unavailable"}}' }) : route.continue());
    await page.evaluate(() => changePreference('speed', 1.1));
    await page.waitForFunction(() => preferenceSaveStatus === 'error');
    assert.equal((await saved()).values.speed, 1.25, 'Failed save cannot claim persistence');
    await page.unroute('**/api/preferences');
    await page.reload();
    await page.waitForFunction(() => typeof data !== 'undefined' && data.ready);
    await until(async () => (await saved())?.values.speed === 1.1);
    assert.equal(await page.evaluate(() => preferences.speed), 1.1);
    await page.locator('#settings-open').click();
    await page.locator('#reset-preferences').click();
    await until(async () => (await saved())?.values.theme === 'dark' && (await saved()).values.botMode === 'auto');
    assert.equal((await saved()).values.voice, true, 'Automatic narration default preserved');
    assert.equal((await saved()).values.speed, 1);
    console.log('PASS immediate-close save, visible disk-error status, pending-edit recovery and durable default reset');
  } finally {
    if (browser) await browser.close();
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
