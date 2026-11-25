// The product layer: settings, clear progress, audio feedback, and an uninterrupted coach flow.
const settingBindings = {
  "pref-voice": "voice",
  "pref-voice-name": "voiceName",
  "pref-speed": "speed",
  "pref-voice-volume": "voiceVolume",
  "pref-auto-diagrams": "autoDiagrams",
  "pref-sound": "sound",
  "pref-ui-sounds": "uiSounds",
  "pref-move-sounds": "moveSounds",
  "pref-rewards": "rewards",
  "pref-sound-volume": "soundVolume",
  "pref-goal": "goal",
  "pref-predict": "predict",
  "pref-coach": "coach",
  "pref-pace": "pace",
  "pref-review-pace": "reviewPause",
  "pref-review-challenges": "reviewChallenges",
  "pref-theme": "theme",
  "pref-board": "board",
  "pref-coordinates": "coordinates",
  "pref-legal": "legal",
  "pref-assist": "assist",
  "pref-motion": "motion",
  "pref-text": "text",
};
let autoReviewTimer,
  lastAutoReview = "",
  guidedReview = null;
const voiceClips = new Map();
function voiceClip(text, alive = () => true, speculative = false, voice = preferences.voiceName) {
  text = text.trim().replace(/\s+/g, " ");
  const key = voice + ":" + text;
  if (voiceClips.has(key)) return voiceClips.get(key);
  const result = (async () => {
    for (let i = 0; i < 100; i++) {
      if (!alive()) throw new DOMException("Explanation changed", "AbortError");
      const response = await fetch("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 1700), voice, prefetch: speculative }),
      });
      const data = await response.json();
      if (response.ok) return data;
      if (
        speculative || response.status !== 503 ||
        !/still speaking/i.test(data.error?.message || "")
      )
        throw Error(data.error?.message || "Local voice unavailable");
      await delay(60);
    }
    throw Error("Voice is busy. Your visual explanation is still available.");
  })();
  voiceClips.set(key, result);
  result.catch(() => voiceClips.delete(key));
  if (voiceClips.size > 128) voiceClips.delete(voiceClips.keys().next().value);
  return result;
}
// Start with one complete sentence or natural clause. Never splice individual
// words or add filler; every clip retains the selected voice and full text.
function speechSegments(text) {
  const clean = text.trim().replace(/\s+/g, " ");
  const sentences = clean.match(/.*?[.!?](?=\s|$)|.+$/g) || [];
  const parts = [];
  for (const sentence of sentences) {
    let remainder = sentence.trim();
    while (remainder.length > 150) {
      const head = remainder.slice(0, 150);
      const boundaries = [...head.matchAll(/[,;:]\s+|\s+(?=and |but |so |because |which )/g)];
      const boundary = boundaries.filter(match => match.index >= 55).at(-1);
      if (!boundary) break; // Preserve the prosody of an indivisible sentence.
      const end = boundary.index + boundary[0].length;
      parts.push(remainder.slice(0, end).trim());
      remainder = remainder.slice(end).trim();
    }
    if (remainder) parts.push(remainder);
  }
  // Very short assessment sentences sound better as one thought. "Your move."
  // is deliberately standalone: it is warmed and ready before puzzles open.
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i].length < 30 && parts[i] !== "Your move." && (parts[i] + parts[i + 1]).length < 150) {
      parts.splice(i, 2, parts[i] + " " + parts[i + 1]);
    }
  }
  return parts;
}
const pendingSpeechPrefetches = new Map();
function prefetchSpeech(text, alive = () => true) {
  if (!voiceEnabled || !alive()) return Promise.resolve(null);
  const first = speechSegments(text)[0];
  if (!first) return Promise.resolve(null);
  const voice = preferences.voiceName, key = voice + ":" + first;
  if (pendingSpeechPrefetches.has(key)) return pendingSpeechPrefetches.get(key);
  if (pendingSpeechPrefetches.size >= 4) return Promise.resolve(null);
  // Speculation never waits in the inference queue. Briefly retry from the
  // browser when busy, yielding to requested speech on every attempt.
  const pending = (async () => {
    for (let i = 0; i < 12 && voiceEnabled && preferences.voiceName === voice && alive(); i++) {
      try { return await voiceClip(first, alive, true, voice); }
      catch { await delay(150); }
    }
    return null;
  })();
  pendingSpeechPrefetches.set(key, pending);
  pending.finally(() => pendingSpeechPrefetches.delete(key));
  return pending;
}
async function coachAudio(text, alive = () => true) {
  const parts = speechSegments(text), voice = preferences.voiceName;
  if (!parts.length) throw new Error("No speech text");
  const first = await voiceClip(parts[0], alive, false, voice);
  if (!alive()) throw new DOMException("Explanation changed", "AbortError");
  const audio = new Audio(first.url);
  let index = 0, next = null, switching = null, paused = false;
  const nativePlay = audio.play.bind(audio), nativePause = audio.pause.bind(audio);
  audio.coachHasMore = parts.length > 1;
  audio.play = async () => {
    paused = false;
    if (switching) await switching;
    if (alive() && !paused) return nativePlay();
  };
  audio.pause = () => { paused = true; nativePause(); };
  const prepareNext = () => {
    if (!next && index + 1 < parts.length && alive()) {
      next = voiceClip(parts[index + 1], alive, false, voice);
      next.catch(() => {});
    }
  };
  audio.addEventListener("playing", prepareNext);
  audio.addEventListener("ended", event => {
    if (!alive() || index + 1 >= parts.length) { audio.coachHasMore = false; return; }
    event.stopImmediatePropagation(); // A visual thought ends after its last clip.
    prepareNext();
    switching = (async () => {
      try {
        const result = await next;
        if (!alive()) return;
        index++;
        next = null;
        audio.src = result.url;
        audio.coachHasMore = index + 1 < parts.length;
        audio.load();
        if (!paused) await nativePlay();
      } catch (error) {
        if (alive()) {
          audio.coachHasMore = false;
          audio.onerror?.(error);
        }
      } finally { switching = null; }
    })();
  });
  return audio;
}
function puzzleAnnouncement() {
  return puzzleSolved
    ? "Well played. Recall the idea, then continue when you’re ready."
    : `Your move. ${activeDrill.objective}. Take a moment to look for checks, captures, and threats.`;
}
let lastPuzzleAnnouncement = "";
function announcePuzzle() {
  if (
    !voiceEnabled ||
    !activeDrill ||
    !$("#puzzles").classList.contains("active") ||
    visualLesson ||
    boards.puzzle.busy
  )
    return;
  const key = activeDrill.session;
  if (lastPuzzleAnnouncement === key) return;
  if (!userActivatedAudio) {
    prefetchSpeech(puzzleAnnouncement(), () => activeDrill?.session === key);
    pendingAutoSpeech = announcePuzzle;
    return;
  }
  lastPuzzleAnnouncement = key;
  speakText(puzzleAnnouncement());
}
function syncSettings() {
  for (const [id, key] of Object.entries(settingBindings)) {
    const input = $("#" + id);
    if (input.type === "checkbox") input.checked = preferences[key];
    else input.value = preferences[key];
  }
  $("#speed-value").textContent = `${Number(preferences.speed.toFixed(2))}×`;
  $("#voice-volume-value").textContent = `${preferences.voiceVolume}%`;
  $("#sound-volume-value").textContent = `${preferences.soundVolume}%`;
  $("#predict-replies").checked = preferences.predict;
  $("#coach-enabled").checked = preferences.coach;
  updateRatingControl();
  updateAudioControls();
  applyAppearance();
  syncAssist();
  if (speechAudio) configureSpeech(speechAudio);
  renderJourney();
}
function changePreference(key, value) {
  const previous = preferences[key];
  preferences[key] = value;
  if (key === "assist") {
    if (puzzleAutoAssist && !value)
      message("puzzle", "Assist is off. Try your next idea.", "try-again");
    puzzleAutoAssist = false;
  }
  savePreferences();
  voiceEnabled = preferences.voice;
  soundEnabled = preferences.sound;
  if (key === "voice" && !value) {
    pendingAutoSpeech = null;
    stopSpeech();
  }
  if (key === "voiceName" && previous !== value) stopSpeech();
  if (key === "coach" && !value) stopSpeech();
  syncSettings();
  renderPreferenceSaveStatus();
}
function renderPreferenceSaveStatus() {
  $("#settings-saved").textContent = {
    saving: "Saving…",
    saved: "All changes saved",
    error: "Couldn’t save settings — please try again",
  }[preferenceSaveStatus];
}
window.addEventListener("preferences-save", renderPreferenceSaveStatus);
renderPreferenceSaveStatus();
for (const [id, key] of Object.entries(settingBindings)) {
  const input = $("#" + id);
  input.addEventListener(input.type === "range" ? "input" : "change", () => {
    const v =
      input.type === "checkbox"
        ? input.checked
        : typeof preferenceDefaults[key] === "number"
          ? Number(input.value)
          : input.value;
    changePreference(key, v);
  });
}
$("#settings-open").onclick = () => navigate("settings");
$("#settings-import").onclick = () => {
  navigate("games");
  $("#pgn-files").click();
};
$("#settings-library").onclick = () => navigate("games");
$("#reset-preferences").onclick = () => {
  stopSpeech();
  preferences = { ...preferenceDefaults };
  $("#difficulty").value = preferences.botMode;
  $("#play-style").value = preferences.botStyle;
  $("#bot-rating").value = preferences.botRating;
  level = preferences.botLevel;
  puzzleAutoAssist = false;
  savePreferences();
  voiceEnabled = preferences.voice;
  soundEnabled = preferences.sound;
  syncSettings();
  toast("Default preferences restored. Your games and progress are unchanged.");
};
$("#preview-voice").onclick = async () => {
  const button = $("#preview-voice");
  button.disabled = true;
  $("#voice-preview-status").textContent = "Preparing your local voice…";
  try {
    const played = await speakText(
      "Take your time. Look for checks, captures, and threats. Then ask yourself: what would my opponent do next?",
    );
    $("#voice-preview-status").textContent = played
      ? "Previewing your selected voice and speed."
      : "The voice couldn’t start. Please try again.";
  } catch {
    $("#voice-preview-status").textContent =
      "The voice couldn’t start. Please try again.";
  } finally {
    button.disabled = false;
  }
};
$("#preview-sounds").onclick = () => {
  playSound("navigate");
  setTimeout(() => playSound("hint"), 260);
  setTimeout(() => playSound("success"), 550);
};
$("#predict-replies").addEventListener("change", () =>
  changePreference("predict", $("#predict-replies").checked),
);
$("#coach-enabled").addEventListener("change", () =>
  changePreference("coach", $("#coach-enabled").checked),
);
matchMedia("(prefers-color-scheme: light)").addEventListener(
  "change",
  applyAppearance,
);
matchMedia("(prefers-reduced-motion: reduce)").addEventListener(
  "change",
  applyAppearance,
);

function activateAudio() {
  if (userActivatedAudio) return;
  userActivatedAudio = true;
  unlockAudio();
  const queued = pendingAutoSpeech;
  pendingAutoSpeech = null;
  if (queued && voiceEnabled) setTimeout(queued, 0);
}
document.addEventListener("pointerdown", activateAudio, { capture: true });
document.addEventListener("keydown", activateAudio, { capture: true });
document.addEventListener(
  "click",
  (event) => {
    const b = event.target.closest("button,summary,a");
    if (
      !b ||
      b.disabled ||
      b.classList.contains("square") ||
      b.closest("#promotion")
    )
      return;
    if (["sound-toggle", "voice-toggle", "preview-sounds"].includes(b.id))
      return;
    playSound(
      b.classList.contains("nav") || b.classList.contains("brand") || b.id === "settings-open"
        ? "navigate"
        : /hint|solution/.test(b.id)
          ? "hint"
          : "select",
    );
  },
  { capture: true },
);
document.addEventListener("change", (event) => {
  if (event.target.matches("select,input[type=checkbox]")) playSound("select");
});
// Restore the live position before an action checks turn/preview state. The
// coach occupies a fixed slot, so cancelling cannot move the pressed target.
function interruptCoachForAction(event) {
  if (
    !visualLesson ||
    event.target.closest(
      ".lesson-player,.context-return,#review-play,.assist-toggle",
    )
  )
    return;
  if (
    !event.target.closest("button,a,input,select,summary,[role=button],.board")
  )
    return;
  dismissedLessons.add(visualLesson.record);
  dismissedCoach = lastCoach;
  pendingAutoSpeech = null;
  clearTimeout(autoReviewTimer);
  stopSpeech();
}
document.addEventListener("pointerdown", interruptCoachForAction, {
  capture: true,
});
// Keyboard and assistive-technology activations have no preceding pointerdown.
document.addEventListener("click", interruptCoachForAction, { capture: true });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopSpeech();
});
$("#enable-audio").onclick = () => {
  userActivatedAudio = true;
  $("#audio-unlock").hidden = true;
  if (speechAudio) {
    if (visualLesson) visualLesson.spoken = true;
    configureSpeech(speechAudio);
    speechAudio.play().catch(() => {
      $("#audio-unlock").hidden = false;
    });
  } else if (visualLesson) {
    visualLesson.spoken = true;
    lessonStep(visualLesson.index);
  }
};
$("#dismiss-audio").onclick = () => {
  $("#audio-unlock").hidden = true;
  changePreference("voice", false);
};

function autoNarrate(name, record) {
  if (!voiceEnabled || document.hidden) return;
  if (
    dismissedLessons.has(record) ||
    (name === "play" && dismissedCoach === record)
  )
    return;
  if (name === "game" && !shouldNarrateReview(record)) return;
  if (!userActivatedAudio) {
    pendingAutoSpeech = () => {
      if (
        $(
          "#" +
            (name === "game"
              ? "games"
              : name === "puzzle"
                ? "puzzles"
                : "play"),
        ).classList.contains("active")
      )
        autoNarrate(name, record);
    };
    return;
  }
  if (visualLesson && !visualLesson.automatic) return;
  if (!preferences.autoDiagrams) {
    return speakText(
      record.explanation ||
        (record.evidence || []).map((f) => f.text).join(" "),
    );
  }
  startVisualLesson(name, record, true, true);
}
function shouldNarrateReview(record, history = currentReview?.moves || []) {
  if (!record) return false;
  if (
    ["mistake", "blunder"].includes(record.grade) ||
    record.san?.includes("#") ||
    record.uci?.length === 5
  )
    return true;
  if (Number(record.before?.split(" ")[5] || 1) <= 10) return false;
  if (record.loss > 80 || shouldAutoCoach(record)) return true;
  const ideas = (record.evidence || []).filter(
    (f) => f.outlook && factContext(f) === "played",
  );
  if (!ideas.length) return false;
  // Repeated plans stay available on request, but don't interrupt adjacent turns.
  const recent = history
    .filter((m) => m.ply < record.ply && m.player === record.player)
    .slice(-3);
  return ideas.some(
    (idea) =>
      !recent.some((m) =>
        (m.evidence || []).some((f) => f.outlook?.title === idea.outlook.title),
      ),
  );
}
function scheduleReviewVoice(record) {
  clearTimeout(autoReviewTimer);
  if (
    !record ||
    !voiceEnabled ||
    !shouldNarrateReview(record) ||
    !$("#games").classList.contains("active")
  )
    return;
  if (
    typeof reviewPlayback !== "undefined" &&
    (reviewPlayback.running || reviewPlayback.seeking)
  )
    return;
  const key = `${gameIndex}:${replayPly}`;
  if (lastAutoReview === key) return;
  prefetchLesson(record, () => `${gameIndex}:${replayPly}` === key && $("#games").classList.contains("active"));
  autoReviewTimer = setTimeout(() => {
    if (
      `${gameIndex}:${replayPly}` !== key ||
      !$("#games").classList.contains("active") ||
      visualLesson ||
      variationActive
    )
      return;
    lastAutoReview = key;
    autoNarrate("game", record);
  }, 650);
}
function renderJourney() {
  if (typeof practiceData === "undefined" || !practiceData) return;
  const p = practiceData,
    count = p.daily_unique || 0,
    goal = preferences.goal;
  $("#goal-count").textContent = `${Math.min(count, goal)} / ${goal}`;
  $("#goal-ring").style.setProperty(
    "--goal-progress",
    Math.min(100, (count / goal) * 100) + "%",
  );
  $("#goal-title").textContent =
    count >= goal
      ? "Today’s goal, complete."
      : count
        ? "You’re building momentum."
        : "Make room for a discovery.";
  $("#goal-copy").textContent =
    count >= goal
      ? "Nicely done. Come back tomorrow to keep the patterns fresh."
      : `${Math.max(0, goal - count)} more distinct positions for your daily goal. Hints are welcome.`;
  $("#journey-xp").textContent = `${p.today_xp || 0} XP today`;
  $("#journey-streak").textContent = `${p.streak} day streak`;
  $("#side-level").textContent = `Level ${p.level || 1} · ${p.xp || 0} XP`;
  $("#side-xp-fill").style.width = ((p.level_progress || 0) / 150) * 100 + "%";
  $("#side-xp").textContent =
    `${p.level_progress || 0} / 150 XP to the next level`;
  $("#side-streak").textContent = p.streak
    ? `${p.streak} day learning streak`
    : "Your next chapter starts today.";
  $("#learning-xp").textContent = `${p.today_xp || 0} XP today`;
  $("#learning-goal").textContent =
    `${Math.min(count, goal)} / ${goal} daily goal`;
  $("#achievement-list").replaceChildren();
  for (const badge of p.achievements || []) {
    const item = element(
      "div",
      "achievement" + (badge.earned ? " earned" : ""),
    );
    item.append(element("span", "achievement-medal", badge.earned ? "✦" : "◇"));
    const copy = element("div");
    copy.append(
      element("strong", "", badge.name),
      element("small", "", badge.description),
    );
    item.append(
      copy,
      element(
        "span",
        "achievement-state",
        badge.earned ? "Earned" : "To discover",
      ),
    );
    $("#achievement-list").append(item);
  }
}
function celebratePosition(result) {
  const amount = result.xp_earned || 0;
  const banner = $("#reward-banner");
  banner.hidden = false;
  banner.replaceChildren();
  banner.append(
    element("span", "reward-spark", "✦"),
    element(
      "strong",
      "",
      amount ? `+${amount} XP · Idea explored` : "Pattern revisited",
    ),
    element(
      "small",
      "",
      amount
        ? "A little closer to your daily goal."
        : "The next spaced review will help this stick.",
    ),
  );
  if (preferences.rewards && amount) {
    banner.classList.remove("celebrate");
    requestAnimationFrame(() => banner.classList.add("celebrate"));
    playSound("reward");
  }
}
syncSettings();

// Put the game first; opponent settings are one explicit action away.
$("#match-settings").open = false;
