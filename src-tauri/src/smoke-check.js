setTimeout(async () => {
  try {
    const response = await fetch('/api/data');
    if (!response.ok) throw Error('Backend unavailable');
    const data = await response.json();
    if (data.games.length) throw Error('Test profile contains personal games');
    for (const page of ['puzzles', 'play', 'games', 'overview', 'puzzles']) {
      const control = document.querySelector(`[data-page="${page}"]`);
      control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      control.click();
      const section = document.getElementById(page);
      if (!section.classList.contains('active') || section.getBoundingClientRect().height <= 0)
        throw Error(`${page} navigation left a blank page`);
    }
    if (document.querySelectorAll('#puzzle-board .square').length !== 64)
      throw Error('Training board missing');
    if (window.__nativeAudioMuted) {
      // WebKit may keep a muted context suspended. Building its real graph
      // still exercises the missing-plugin crash without demanding audibility.
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      gain.gain.value = 0;
      oscillator.connect(gain); gain.connect(audioContext.destination);
      oscillator.start(); oscillator.stop(audioContext.currentTime + 0.02);
      // A silent PCM clip tests the separate media/coach playback pipeline too.
      const bytes = new ArrayBuffer(1644), view = new DataView(bytes);
      const word = (offset, value) => [...value].forEach((c, n) => view.setUint8(offset + n, c.charCodeAt(0)));
      word(0, 'RIFF'); view.setUint32(4, 1636, true); word(8, 'WAVE'); word(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
      view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      word(36, 'data'); view.setUint32(40, 1600, true);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      const audio = new Audio(url); audio.muted = true;
      try {
        await Promise.race([
          new Promise((resolve, reject) => {
            audio.onended = resolve;
            audio.onerror = () => reject(Error('Coach audio playback failed'));
            audio.play().catch(reject);
          }),
          new Promise((_, reject) => setTimeout(() => reject(Error('Coach audio stalled')), 5000)),
        ]);
      } finally { audio.pause(); URL.revokeObjectURL(url); }
    }
    if (__nativeErrors.length) throw Error(__nativeErrors.join('; '));
    // Record real WebKit frame pacing without asserting hardware-dependent
    // thresholds on shared CI runners. Mute remains verified throughout.
    const frames = [], originalScroll = scrollY;
    let previous;
    for (let n = 0; n < 36; n++) {
      const now = await new Promise(requestAnimationFrame);
      if (previous !== undefined) frames.push(now - previous);
      previous = now;
      scrollTo(0, Math.min(400, n * 12));
    }
    scrollTo(0, originalScroll);
    const sorted = frames.sort((a, b) => a - b);
    const navigation = performance.getEntriesByType('navigation')[0];
    const metrics = new URLSearchParams({
      dom_ready_ms: Math.round(navigation?.domContentLoadedEventEnd || 0),
      scroll_frame_p95_ms: sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
    });
    location.href = 'knightlight-smoke://passed?' + metrics;
  } catch (error) {
    location.href = 'knightlight-smoke://failed/' + encodeURIComponent(error.message);
  }
}, 2500);
