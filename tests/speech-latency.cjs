// Real synthesis and real playback-state measurements; Chromium stays muted.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knightlight-speech-latency-'));
for (const name of ['static', 'scripts', 'vendor']) fs.symlinkSync(path.join(root, name), path.join(dir, name));
const port = require('./support.cjs').allocatePort(), base = `http://127.0.0.1:${port}`;
const server = spawn(path.join(root, 'target/release/chess-study'), [], { cwd: dir, env: { ...process.env, PORT: String(port) } });
let logs = '', browser;
server.stdout.on('data', b => logs += b); server.stderr.on('data', b => logs += b);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 30000) {
  const start = performance.now();
  while (performance.now() - start < timeout) { try { if (await fn()) return; } catch {} await sleep(40); }
  throw Error('Timed out: ' + logs);
}
async function speech(text, options = {}) {
  const start = performance.now();
  const r = await fetch(base + '/api/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, ...options }) });
  assert.equal(r.status, 200, await r.clone().text());
  return { ...(await r.json()), wall_ms: Math.round(performance.now() - start) };
}
(async () => {
  const measurements = {};
  try {
    const start = performance.now();
    await until(async () => (await fetch(base + '/api/health')).ok);
    const warm = await speech('Your move.');
    measurements.startup_warm_ms = Math.round(performance.now() - start);
    assert.equal(warm.cached, true, 'Startup generates a ready-to-play phrase');
    measurements.cached_phrase = await speech('Your move.');
    measurements.full_uncached = await speech('Your queen is active, but your king needs care. Before moving, look for checks, captures, and threats.');
    measurements.first_sentence_uncached = await speech('Your queen is active, but your king needs care.');
    // A cached clip must bypass inference in progress, including after restart.
    let busyDone = false;
    const busy = speech('This bishop is well placed to control the long diagonal and restrict the enemy rook. Before you commit to the attack, improve the king position, secure the center, and compare the forcing replies available to your opponent.').finally(() => busyDone = true);
    await sleep(80);
    assert.equal(busyDone, false);
    measurements.cached_during_inference = await speech('Your move.');
    assert.equal(measurements.cached_during_inference.cached, true);
    assert.equal(busyDone, false, 'Cache hit must finish before the unrelated inference');
    const prefetch = await fetch(base + '/api/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Speculative background phrase.', prefetch: true }) });
    assert.equal(prefetch.status, 503, 'Speculation must not queue behind foreground speech');
    await busy;
    console.log('PASS startup warming, normalized persistent cache, cache hits bypass busy inference, speculation yields');
    browser = await chromium.launch({ headless: true, args: ['--mute-audio', '--enable-automation'], ...(process.env.CHESS_TEST_BROWSER ? { executablePath: process.env.CHESS_TEST_BROWSER } : {}) });
    const command = await (await browser.newBrowserCDPSession()).send('Browser.getBrowserCommandLine');
    assert(command.arguments.includes('--mute-audio'));
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base); await page.waitForFunction(() => typeof data !== 'undefined' && data.ready && typeof coachAudio === 'function');
    await page.locator('[data-page="settings"]').click(); // Activate audio inside muted browser.
    const segmentation = await page.evaluate(() => {
      const original = 'A better option would have been to improve the rook. Your opponent must defend the king, so you have time to develop the knight.';
      return { original, parts: speechSegments(original), decimals: speechSegments('This is 1.25 times faster. Keep the same voice.') };
    });
    assert.equal(segmentation.parts.join(' '), segmentation.original);
    assert(segmentation.parts.length >= 2);
    assert(segmentation.decimals.join(' ').includes('1.25'));
    const measure = async text => page.evaluate(async text => {
      stopSpeech();
      const start = performance.now();
      let firstPlaying;
      const played = new Promise(resolve => firstPlaying = resolve);
      const audio = await coachAudio(text);
      const prepared = performance.now() - start;
      window.latencyPreparationMs = prepared;
      speechAudio = audio; configureSpeech(audio);
      audio.addEventListener('playing', () => firstPlaying(performance.now() - start), { once: true });
      await audio.play();
      return Math.round(await played);
    }, text);
    measurements.browser_uncached_first_audio_ms = await measure('Your knight can use this outpost. It controls the center and forces the rook to defend the seventh rank.');
    await page.evaluate(() => stopSpeech());
    const preparedText = 'The bishop now protects your rook. Use the next turn to bring your king toward the center.';
    // Let the canceled previous clip finish its in-flight synthesis, then
    // prepare the exact next first sentence without ever playing it.
    const prefetched = await page.evaluate(text => prefetchSpeech(text), preparedText);
    assert(prefetched?.url, "The speculative phrase must actually be ready");
    measurements.prefetched_entry = await page.evaluate(async text => ({
      key: preferences.voiceName + ':' + speechSegments(text)[0],
      value: await voiceClips.get(preferences.voiceName + ':' + speechSegments(text)[0]),
    }), preparedText);
    measurements.browser_prefetched_first_audio_ms = await measure(preparedText);
    measurements.prefetched_preparation_ms = await page.evaluate(() => latencyPreparationMs);
    assert(measurements.prefetched_entry.value?.url);
    assert(measurements.prefetched_preparation_ms < 100, "Prepared speech must not run inference again");
    await page.evaluate(() => stopSpeech());
    measurements.browser_common_phrase_ms = await measure('Your move.');
    await page.evaluate(() => stopSpeech());
    // Exercise sentence-boundary pause/resume, exact order, and final-only ended.
    await speech('Protect your king before starting the attack.'); await speech('Then activate your rook along the open file.');
    await page.evaluate(async () => {
      window.segmentEvents = []; window.finalEnds = 0;
      speechAudio = await coachAudio('Protect your king before starting the attack. Then activate your rook along the open file.');
      speechAudio.addEventListener('playing', () => segmentEvents.push(speechAudio.currentSrc));
      speechAudio.onended = () => finalEnds++;
      configureSpeech(speechAudio); await speechAudio.play();
    });
    await page.waitForFunction(() => segmentEvents.length === 1);
    await page.evaluate(() => { speechAudio.pause(); speechAudio.dispatchEvent(new Event('ended')); });
    await sleep(200);
    assert.equal(await page.evaluate(() => segmentEvents.length), 1);
    assert.equal(await page.evaluate(() => finalEnds), 0);
    await page.evaluate(() => speechAudio.play());
    await page.waitForFunction(() => segmentEvents.length === 2);
    await page.evaluate(() => speechAudio.dispatchEvent(new Event('ended')));
    assert.equal(await page.evaluate(() => finalEnds), 1);
    await page.evaluate(() => stopSpeech());
    // Cancel while a later sentence is still preparing. Its late response must
    // never restart audio or complete the abandoned visual step.
    const firstSentence = 'Protect your king before starting the attack.';
    const laterSentence = 'A delayed continuation must not revive an explanation you have closed.';
    const readyFirst = await speech(firstSentence);
    let releaseLater, sawLater;
    const laterArrived = new Promise(resolve => sawLater = resolve);
    const release = new Promise(resolve => releaseLater = resolve);
    await page.route('**/api/speech', async route => {
      if (route.request().postDataJSON().text !== laterSentence) return route.continue();
      sawLater(); await release;
      await route.fulfill({ json: readyFirst });
    });
    await page.evaluate(text => speakText(text), firstSentence + ' ' + laterSentence);
    await laterArrived;
    await page.evaluate(() => {
      window.canceledAudio = speechAudio;
      speechAudio.dispatchEvent(new Event('ended'));
      stopSpeech();
    });
    releaseLater();
    await sleep(200);
    assert.equal(await page.evaluate(() => speechAudio), null);
    assert.equal(await page.evaluate(() => canceledAudio.paused), true);
    await page.unroute('**/api/speech');
    console.log('PASS interrupted sentence preparation cannot restart a canceled explanation');
    assert.deepEqual(errors, []);
    console.log('PASS same text/voice sentence playback, pause across clips, final-only completion and muted first-playing measurements');
    fs.writeFileSync(path.join(root, 'reports/speech-latency.json'), JSON.stringify(measurements, null, 2) + '\n');
    console.log(JSON.stringify(measurements, null, 2));
  } finally {
    if (browser) await browser.close();
    const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await stopped;
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
