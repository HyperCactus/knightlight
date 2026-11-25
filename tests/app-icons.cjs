const { chromium, devices } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knightlight-icons-'));
fs.symlinkSync(path.join(root, 'static'), path.join(dir, 'static'));
const port = require('./support.cjs').allocatePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(path.join(root, 'target/release/chess-study'), [], { cwd: dir, env: { ...process.env, PORT: String(port) } });
let logs = '';
server.stderr.on('data', b => logs += b);
server.stdout.on('data', b => logs += b);
(async () => {
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(base + '/api/health')).ok; } catch {}
      if (ready) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert(ready, logs);
    const health = await (await fetch(base + '/api/health')).json();
    assert.equal(health.app, 'knightlight');
    assert.equal(health.workspace, fs.realpathSync(dir));
    const manifestResponse = await fetch(base + '/manifest.webmanifest');
    assert(manifestResponse.ok);
    assert.match(manifestResponse.headers.get('content-type'), /manifest\+json/);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.short_name, 'Knightlight');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/');
    assert(manifest.icons.some(icon => icon.purpose === 'maskable'));
    for (const icon of [...manifest.icons, { src: '/apple-touch-icon.png', sizes: '180x180' }, { src: '/icons/icon-32.png', sizes: '32x32' }]) {
      const response = await fetch(base + icon.src);
      assert(response.ok, icon.src);
      assert.match(response.headers.get('content-type'), /image\/png/);
      const png = Buffer.from(await response.arrayBuffer());
      assert.equal(png.subarray(1,4).toString(), 'PNG');
      assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
    }
    for (const icon of ['/favicon.ico', '/favicon.svg']) assert((await fetch(base + icon)).ok);
    browser = await chromium.launch({ headless: true, args: ['--mute-audio', '--enable-automation'], ...(process.env.CHESS_TEST_BROWSER ? { executablePath: process.env.CHESS_TEST_BROWSER } : {}) });
    const command = await (await browser.newBrowserCDPSession()).send('Browser.getBrowserCommandLine');
    assert(command.arguments.includes('--mute-audio'), 'Verify mute before opening app');
    for (const options of [{ viewport: { width: 1440, height: 1000 } }, devices['iPhone 13']]) {
      const context = await browser.newContext(options);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(base);
      await page.waitForFunction(() => typeof data !== 'undefined' && data.ready);
      assert.match(await page.title(), /^Knightlight/);
      assert.equal(await page.locator('link[rel="manifest"]').getAttribute('href'), '/manifest.webmanifest');
      assert.equal(await page.locator('meta[name="apple-mobile-web-app-title"]').getAttribute('content'), 'Knightlight');
      assert.equal(await page.locator('.brand-mark img').evaluate(img => img.complete && img.naturalWidth > 0), true);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal overflow');
      const brand = await page.locator('.brand').boundingBox();
      assert(brand && brand.x >= 0 && brand.x + brand.width <= page.viewportSize().width, 'Wordmark fits');
      await page.screenshot({ path: path.join(os.tmpdir(), options.viewport?.width === 1440 ? 'knightlight-desktop.png' : 'knightlight-mobile.png') });
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('PASS Knightlight icons, PNG sizes, manifest, favicon, desktop/mobile branding and muted browser');
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
