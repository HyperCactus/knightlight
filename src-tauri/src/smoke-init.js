// Tests keep narration preferences intact. Native Linux verifies the whole
// webview is muted before enabling real playback paths for regression checks.
window.__nativeErrors = [];
addEventListener('error', event => __nativeErrors.push(event.message));
addEventListener('unhandledrejection', event => __nativeErrors.push(String(event.reason)));
const nativePlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function (...args) {
  this.muted = true;
  return window.__nativeAudioMuted ? nativePlay.apply(this, args) : Promise.resolve();
};
for (const name of ['AudioContext', 'webkitAudioContext']) {
  if (!window[name]) continue;
  const resume = window[name].prototype.resume;
  window[name].prototype.resume = function (...args) {
    return window.__nativeAudioMuted ? resume.apply(this, args) : Promise.resolve();
  };
}
