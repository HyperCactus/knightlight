// One validated source of preferences; every setting has an immediate, reversible effect.
const preferenceDefaults = Object.freeze({
  voice: true,
  voiceName: "af_heart",
  speed: 1,
  voiceVolume: 85,
  sound: true,
  uiSounds: true,
  moveSounds: true,
  rewards: true,
  soundVolume: 50,
  autoDiagrams: true,
  goal: 5,
  predict: true,
  coach: true,
  pace: "normal",
  reviewPause: 1400,
  reviewChallenges: true,
  theme: "dark",
  board: "sage",
  coordinates: true,
  legal: true,
  assist: false,
  motion: "system",
  text: "comfortable",
  botMode: "auto",
  botRating: 1050,
  botStyle: "varied",
  botLevel: 3,
});
function validPreferences(value) {
  const p = { ...preferenceDefaults };
  if (!value || typeof value !== "object") return p;
  for (const key of Object.keys(p)) {
    if (typeof p[key] === "boolean" && typeof value[key] === "boolean")
      p[key] = value[key];
  }
  for (const [key, lo, hi] of [
    ["speed", 0.75, 1.5],
    ["voiceVolume", 0, 100],
    ["soundVolume", 0, 100],
  ]) {
    if (typeof value[key] === "number" && Number.isFinite(value[key]))
      p[key] = Math.max(lo, Math.min(hi, value[key]));
  }
  for (const [key, options] of Object.entries({
    voiceName: ["af_heart", "am_michael", "bf_emma", "piper"],
    goal: [3, 5, 10],
    theme: ["dark", "light", "system"],
    board: ["sage", "walnut", "slate"],
    pace: ["normal", "calm", "brisk"],
    reviewPause: [800, 1400, 2250],
    motion: ["system", "full", "reduced"],
    text: ["comfortable", "large"],
    botMode: ["auto", "manual"],
    botStyle: ["varied", "balanced", "attacking", "positional"],
  }))
    if (options.includes(value[key])) p[key] = value[key];
  for (const [key, lo, hi] of [["botRating", 400, 2400], ["botLevel", 0, 20]]) {
    if (typeof value[key] === "number" && Number.isFinite(value[key]))
      p[key] = Math.round(Math.max(lo, Math.min(hi, value[key])));
  }
  return p;
}
function readPreferenceStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function parsePreferenceStorage(key) {
  try { return JSON.parse(readPreferenceStorage(key) || "null"); } catch { return null; }
}
function preferenceSnapshot(value) {
  return value && Number.isSafeInteger(value.updated_at) && value.updated_at >= 0 &&
    value.values && typeof value.values === "object" && !Array.isArray(value.values)
      ? value : null;
}
const serverPreferences = window.knightlightSavedPreferences;
const cachedPreferences = preferenceSnapshot(parsePreferenceStorage("knightlight-preferences-cache"));
const legacyPreferences = parsePreferenceStorage("chess-preferences");
const hasLegacyPreferences = Boolean(legacyPreferences) ||
  ["chess-voice", "chess-sound", "chess-theme", "chess-difficulty", "chess-bot-rating", "chess-style", "chess-level"]
    .some(key => readPreferenceStorage(key) !== null);
// Only an explicitly pending local change can supersede the server. An old
// browser cache must not roll back settings saved from a different URL/window.
const recoverPendingPreferences = cachedPreferences?.pending &&
  cachedPreferences.updated_at > (serverPreferences?.updated_at || 0);
const restoredPreferences = recoverPendingPreferences ? cachedPreferences : serverPreferences;
let preferences = validPreferences(restoredPreferences?.values || (() => {
  const saved = legacyPreferences || {
    voice: readPreferenceStorage("chess-voice") !== "off",
    sound: readPreferenceStorage("chess-sound") !== "off",
    theme: readPreferenceStorage("chess-theme") || "dark",
  };
  if ([1600, 2800, 4500].includes(saved.reviewPause)) saved.reviewPause /= 2;
  return {
    ...saved,
    botMode: saved.botMode ?? readPreferenceStorage("chess-difficulty"),
    botRating: saved.botRating ?? Number(readPreferenceStorage("chess-bot-rating") || 1050),
    botStyle: saved.botStyle ?? readPreferenceStorage("chess-style"),
    botLevel: saved.botLevel ?? Number(readPreferenceStorage("chess-level") || 3),
  };
})());
let preferenceRevision = Math.max(serverPreferences?.updated_at || 0, cachedPreferences?.updated_at || 0);
let pendingPreferenceSave = null, preferenceSaveTimer;
let preferenceSaveStatus = "saved";
let userActivatedAudio = false, pendingAutoSpeech = null;
function cachePreferences(pending) {
  try {
    localStorage.setItem("chess-preferences", JSON.stringify(preferences));
    localStorage.setItem("knightlight-preferences-cache", JSON.stringify({
      values: preferences, updated_at: preferenceRevision, pending,
    }));
    localStorage.setItem("chess-voice", preferences.voice ? "on" : "off");
    localStorage.setItem("chess-sound", preferences.sound ? "on" : "off");
    localStorage.setItem("chess-theme", preferences.theme);
  } catch { /* The local server remains durable when browser storage is blocked. */ }
}
function preferenceSaveState(status) {
  preferenceSaveStatus = status;
  window.dispatchEvent(new CustomEvent("preferences-save", { detail: status }));
}
async function flushPreferences() {
  clearTimeout(preferenceSaveTimer);
  const snapshot = pendingPreferenceSave;
  if (!snapshot) return;
  try {
    const response = await fetch("/api/preferences", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot), keepalive: true,
    });
    if (!response.ok) throw Error("Preferences could not be saved");
    if (snapshot.updated_at === preferenceRevision) {
      pendingPreferenceSave = null;
      cachePreferences(false);
      preferenceSaveState("saved");
    }
  } catch {
    if (snapshot.updated_at === preferenceRevision) preferenceSaveState("error");
  }
}
function savePreferences() {
  preferences = validPreferences(preferences);
  preferenceRevision = Math.max(Date.now(), preferenceRevision + 1);
  pendingPreferenceSave = { values: { ...preferences }, updated_at: preferenceRevision };
  cachePreferences(true);
  preferenceSaveState("saving");
  clearTimeout(preferenceSaveTimer);
  preferenceSaveTimer = setTimeout(flushPreferences, 120);
}
// Navigating/closing immediately after a slider change must not drop that edit.
window.addEventListener("pagehide", () => {
  if (pendingPreferenceSave) {
    const body = new Blob([JSON.stringify(pendingPreferenceSave)], { type: "application/json" });
    if (!navigator.sendBeacon("/api/preferences", body)) flushPreferences();
  }
});
window.addEventListener("online", () => { if (pendingPreferenceSave) flushPreferences(); });
if (recoverPendingPreferences || (!serverPreferences && hasLegacyPreferences)) savePreferences();
else cachePreferences(false);
function configureSpeech(audio) {
  audio.volume = preferences.voiceVolume / 100;
  audio.playbackRate = preferences.speed;
  audio.preservesPitch = true;
}
function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme =
    preferences.theme === "system"
      ? matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : preferences.theme;
  root.dataset.board = preferences.board;
  root.dataset.coordinates = String(preferences.coordinates);
  root.dataset.legal = String(preferences.legal);
  root.dataset.motion =
    preferences.motion === "system"
      ? matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "reduced"
        : "full"
      : preferences.motion;
  root.dataset.text = preferences.text;
}
function botPause() {
  return { calm: 1800, normal: 1000, brisk: 650 }[preferences.pace];
}
applyAppearance();
