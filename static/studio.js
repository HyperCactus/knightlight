// Coaching, learning, voice and review share the Rust analysis services.
let coachRequestId = 0;
let playedMoves = [],
  undoMoves = 0,
  sessionId = crypto.randomUUID(),
  lastCoach = null,
  coachPreview = null;
let completedGame = null,
  newGameBusy = false,
  playTransition = null;
let currentReview = null,
  currentReviewGame = -1,
  reviewRequest = 0,
  reviewTimer = null,
  variationActive = false;
let audioContext = null,
  speechAudio = null,
  speechSequence = 0,
  toastTimer,
  profileData = null,
  profileAt = 0;
let soundEnabled = preferences.sound,
  voiceEnabled = preferences.voice;
const gradeLabels = {
  best: "Best move",
  excellent: "Excellent",
  good: "Good move",
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  blunder: "Blunder",
};
function gradeSymbol(g) {
  return (
    {
      best: "★",
      excellent: "!",
      good: "✓",
      inaccuracy: "?!",
      mistake: "?",
      blunder: "??",
    }[g] || "·"
  );
}
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 4500);
}
function unlockAudio() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
}
function playSound(kind = "move") {
  const ui = ["select", "navigate", "hint"].includes(kind);
  const reward = ["success", "reward", "game-loss", "game-draw"].includes(kind);
  if (
    !soundEnabled ||
    (ui && !preferences.uiSounds) ||
    (reward && !preferences.rewards) ||
    (!ui && !reward && !preferences.moveSounds)
  )
    return;
  try {
    unlockAudio();
    const t = audioContext.currentTime;
    const tones =
      kind === "game-loss"
        ? [
            [330, 0, 0.18],
            [294, 0.2, 0.26],
            [262, 0.42, 0.32],
          ]
        : kind === "game-draw"
          ? [
              [392, 0, 0.18],
              [494, 0.18, 0.2],
              [392, 0.38, 0.3],
            ]
          : kind === "select"
            ? [[640, 0, 0.045]]
            : kind === "navigate"
              ? [
                  [420, 0, 0.06],
                  [560, 0.04, 0.08],
                ]
              : kind === "hint"
                ? [
                    [520, 0, 0.08],
                    [780, 0.08, 0.12],
                  ]
                : kind === "reward"
                  ? [
                      [523, 0, 0.1],
                      [659, 0.09, 0.12],
                      [784, 0.18, 0.2],
                    ]
                  : kind === "success"
                    ? [
                        [440, 0, 0.12],
                        [554, 0.1, 0.12],
                        [660, 0.2, 0.22],
                      ]
                    : kind === "wrong"
                      ? [
                          [185, 0, 0.12],
                          [147, 0.1, 0.15],
                        ]
                      : kind === "check"
                        ? [
                            [660, 0, 0.1],
                            [880, 0.12, 0.15],
                          ]
                        : kind === "capture"
                          ? [
                              [180, 0, 0.1],
                              [100, 0.035, 0.12],
                            ]
                          : [
                              [280, 0, 0.08],
                              [170, 0.025, 0.1],
                            ];
    for (const [freq, delay, duration] of tones) {
      const o = audioContext.createOscillator(),
        g = audioContext.createGain();
      o.type = kind === "move" || kind === "capture" ? "triangle" : "sine";
      o.frequency.setValueAtTime(freq, t + delay);
      g.gain.setValueAtTime(0, t + delay);
      g.gain.linearRampToValueAtTime(
        (ui ? 0.035 : 0.07) *
          (preferences.soundVolume / 50) *
          (speechAudio && !speechAudio.paused ? 0.3 : 1),
        t + delay + 0.006,
      );
      g.gain.exponentialRampToValueAtTime(0.001, t + delay + duration);
      o.connect(g);
      g.connect(audioContext.destination);
      o.start(t + delay);
      o.stop(t + delay + duration + 0.02);
    }
  } catch (e) {
    /* Sound never blocks a chess move. */
  }
}
function stopSpeech() {
  if (typeof stopVisualLesson === "function") stopVisualLesson();
  speechSequence++;
  speechAudio?.pause();
  speechAudio = null;
  $("#voice-toggle").classList.remove("speaking");
}
async function speakText(text) {
  if (!text) return;
  stopSpeech();
  const seq = speechSequence;
  try {
    const audio = await coachAudio(text, () => seq === speechSequence);
    if (seq !== speechSequence) return;
    speechAudio = audio;
    configureSpeech(audio);
    audio.onerror = () => {
      if (seq !== speechSequence || speechAudio !== audio) return;
      audio.pause();
      speechAudio = null;
      $("#voice-toggle").classList.remove("speaking");
      toast("Voice unavailable. You can continue with the visual explanation.");
    };
    speechAudio.onplaying = () => $("#voice-toggle").classList.add("speaking");
    speechAudio.onpause = speechAudio.onended = () =>
      $("#voice-toggle").classList.remove("speaking");
    if (
      typeof reviewPlayback !== "undefined" &&
      reviewPlayback.running &&
      !reviewPlayback.playing &&
      !(typeof opponentChallenge !== "undefined" && opponentChallenge) &&
      $("#games").classList.contains("active")
    )
      return true;
    await speechAudio.play();
    $("#toast").hidden = true;
    return true;
  } catch (e) {
    if (seq === speechSequence && e.name !== "AbortError") {
      if (e.name !== "NotAllowedError") {
        speechAudio?.pause();
        speechAudio = null;
      }
      if (e.name === "NotAllowedError") $("#audio-unlock").hidden = false;
      else toast("Voice unavailable: " + e.message);
    }
    return false;
  }
}
function updateAudioControls() {
  $("#sound-toggle").classList.toggle("enabled", soundEnabled);
  $("#sound-toggle").setAttribute(
    "aria-label",
    soundEnabled ? "Mute sound effects" : "Enable sound effects",
  );
  $("#sound-toggle").setAttribute("aria-pressed", String(soundEnabled));
  $("#sound-toggle-label").textContent = soundEnabled
    ? "Sounds on"
    : "Sounds off";
  $("#voice-toggle").classList.toggle("enabled", voiceEnabled);
  $("#voice-toggle").setAttribute(
    "aria-label",
    voiceEnabled ? "Mute coach voice" : "Unmute coach voice",
  );
  $("#voice-toggle").setAttribute("aria-pressed", String(voiceEnabled));
  $("#voice-toggle-label").textContent = voiceEnabled
    ? "Coach on"
    : "Coach muted";
}
$("#sound-toggle").onclick = () => {
  changePreference("sound", !soundEnabled);
  if (soundEnabled) playSound("select");
};
$("#voice-toggle").onclick = () => {
  changePreference("voice", !voiceEnabled);
  if (!voiceEnabled) return;
  if ($("#games").classList.contains("active")) {
    lastAutoReview = "";
    scheduleReviewVoice(currentReview?.moves[replayPly - 1]);
  } else if ($("#play").classList.contains("active") && lastCoach)
    coachLessonWhenReady(lastCoach);
  else if ($("#puzzles").classList.contains("active")) announcePuzzle();
};
$("#hero-play").onclick = () => navigate("play");
updateAudioControls();
function evalBar(prefix, score) {
  const percent = 50 + 45 * Math.tanh(score / 500);
  $("#" + prefix + "-eval-fill").style.height = percent + "%";
  $("#" + prefix + "-eval-label").textContent =
    Math.abs(score) > 9000
      ? score > 0
        ? "M+"
        : "M−"
      : (score >= 0 ? "+" : "") + (score / 100).toFixed(1);
}
function setGrade(id, grade) {
  const el = $(id);
  el.className = "grade-tag " + grade;
  el.textContent = (
    gradeSymbol(grade) +
    " " +
    (gradeLabels[grade] || grade)
  ).toUpperCase();
}
async function refreshProfile() {
  if (Date.now() - profileAt < 5000) return;
  profileAt = Date.now();
  try {
    profileData = await (await fetch("/api/profile")).json();
    $("#stat-samples").textContent = profileData.samples.toLocaleString();
    $("#database-status").textContent =
      profileData.opening_count.toLocaleString() +
      " named opening variations · Lichess";
    $("#voice-status").textContent = profileData.voice_available
      ? profileData.voice + " · on your computer"
      : "Local voice setup required";
    renderRating();
    const entries = Object.entries(profileData.themes)
      .filter(([, s]) => s.count >= 3)
      .sort((a, b) => b[1].errors / b[1].count - a[1].errors / a[1].count)
      .slice(0, 4);
    $("#weakness-chart").replaceChildren();
    for (const [name, stat] of entries) {
      const row = element("button", "weakness-row weakness-button");
      const label = element("div", "weakness-label");
      label.append(
        element("span", "", name),
        element("span", "", `${stat.errors} / ${stat.count} moves to revisit`),
      );
      const track = element("div", "weakness-track"),
        fill = element("span");
      fill.style.width = Math.max(4, (stat.errors / stat.count) * 100) + "%";
      track.append(fill);
      row.append(label, track);
      row.onclick = async () => {
        navigate("puzzles");
        await refreshPractice(true);
        $("#training-focus").value = name;
        beginFocus();
      };
      $("#weakness-chart").append(row);
    }
  } catch (e) {
    $("#stat-samples").textContent = "—";
  }
}
$("#difficulty").value = preferences.botMode;
$("#play-style").value = preferences.botStyle;
$("#difficulty").onchange = () => {
  preferences.botMode = $("#difficulty").value;
  if (preferences.botMode === "manual") $("#bot-rating").value = preferences.botRating;
  savePreferences();
  updateRatingControl();
};
$("#play-style").onchange = () => {
  preferences.botStyle = $("#play-style").value;
  savePreferences();
};
$("#coach-enabled").onchange = () => {
  if (!$("#coach-enabled").checked) {
    stopSpeech();
    $("#coach-explanation").textContent =
      "Coach mode is off. You can still ask for help or review this game later.";
  } else if (lastCoach) showCoachFeedback(lastCoach);
};
function shouldAutoCoach(record) {
  if (["blunder", "mistake"].includes(record.grade)) return true;
  if (record.san?.includes("#") || record.uci?.length === 5) return true;
  if (
    record.mate !== null &&
    record.mate !== undefined &&
    Math.abs(record.mate) <= 5 &&
    Math.abs(record.eval_before) < 9000
  )
    return true;
  // Routine opening development, captures and checks stay quiet.
  if (Number(record.before?.split(" ")[5] || 1) <= 10) return false;
  return (record.evidence || []).some(
    (fact) =>
      fact.fen === record.after &&
      ["Forks & double attacks", "Pins"].includes(fact.theme),
  );
}
function showCoachFeedback(record, requested = false) {
  const explain = requested || shouldAutoCoach(record);
  $("#coach-explanation").textContent = explain
    ? record.explanation
    : "Move graded. Keep playing, or choose Explain this move to explore the idea.";
  evidenceCards("coach-evidence", explain ? record.evidence : [], "play");
}
async function requestCoach(before, move) {
  const session = sessionId,
    ply = playedMoves.length,
    request = ++coachRequestId;
  lastCoach = null;
  $("#coach-speak").disabled = true;
  $("#coach-evidence").replaceChildren();
  try {
    const r = await api("coach", { fen: before, uci: move, learn: true });
    if (
      session !== sessionId ||
      gameFinished ||
      playedMoves.length < ply ||
      request !== coachRequestId
    )
      return;
    lastCoach = r;
    $("#coach-speak").disabled = false;
    evalBar("play", r.eval_after);
    refreshProfile();
    if ($("#coach-enabled").checked) {
      setGrade("#play-grade", r.grade);
      message(
        "play",
        r.san + " · " + gradeLabels[r.grade],
        r.grade === "blunder" || r.grade === "mistake" ? "try-again" : "",
      );
      showCoachFeedback(r);
      $("#coach-best").disabled = false;
      assessment("coach-assessment", {
        grade: r.grade,
        loss: r.loss,
        before: r.eval_before,
        after: r.eval_after,
      });
      if (!coachPreview && !visualLesson) {
        boards.play.badge = { square: r.uci.slice(2, 4), grade: r.grade };
        renderBoard("play");
      }
      if (shouldAutoCoach(r)) coachLessonWhenReady(r);
    }
  } catch (e) {
    if (
      session === sessionId &&
      request === coachRequestId &&
      $("#coach-enabled").checked
    )
      $("#coach-explanation").textContent =
        "The coach could not analyze that move. " + e.message;
  }
}
$("#coach-best").onclick = () => {
  if (!lastCoach || botBusy || boards.play.busy) return;
  stopSpeech();
  if (!coachPreview) coachPreview = boardSnapshot("play");
  Object.assign(boards.play, {
    fen: lastCoach.before,
    arrow: lastCoach.best,
    hint: lastCoach.best.slice(0, 2),
    selected: null,
    lastMove: null,
    badge: null,
    check: false,
    evidence: null,
  });
  renderBoard("play");
  $("#coach-resume").hidden = false;
  $("#take-back").disabled = true;
  $("#new-game").disabled = true;
  $("#review-current").disabled = true;
  $("#play-turn").textContent = "Exploring an alternative · game paused";
};
$("#coach-resume").onclick = () => {
  if (!coachPreview) return;
  stopSpeech();
  Object.assign(boards.play, coachPreview);
  coachPreview = null;
  renderBoard("play");
  $("#coach-resume").hidden = true;
  $("#take-back").disabled = !undoFen;
  $("#new-game").disabled = false;
  $("#review-current").disabled = false;
  $("#play-turn").textContent = "White to move · You";
};
$("#coach-hint").onclick = async () => {
  if (botBusy || boards.play.busy || gameFinished || coachPreview) return;
  stopSpeech();
  const current = boards.play.fen;
  $("#coach-hint").disabled = true;
  try {
    const r = await api("coach", { fen: current });
    if (current !== boards.play.fen) return;
    boards.play.hint = r.best.slice(0, 2);
    boards.play.arrow = r.best;
    renderBoard("play");
    $("#coach-explanation").textContent =
      "Consider " +
      r.best_san +
      ". " +
      r.explanation.split(". ").slice(2).join(". ");
    if (voiceEnabled) speakText($("#coach-explanation").textContent);
  } catch (e) {
    toast(e.message);
  } finally {
    $("#coach-hint").disabled = false;
  }
};
async function updateOpening() {
  const moves = playedMoves.slice();
  try {
    const result = await api("opening", { moves });
    if (JSON.stringify(moves) !== JSON.stringify(playedMoves)) return;
    $("#play-opening").textContent = result.opening
      ? result.opening.eco +
        " · " +
        result.opening.name +
        " · Lichess opening reference"
      : "Outside the named opening reference. Look for checks, captures, and threats.";
  } catch (e) {
    $("#play-opening").textContent = "Opening reference unavailable.";
  }
}
function recordAttempt(solved) {
  if (currentPuzzle?.id)
    api("attempts", { id: currentPuzzle.id, solved }).catch(() => {});
}
let historySaveQueue = Promise.resolve(),
  practiceStartedAt = null;
async function savePractice(analyze = true) {
  if (!playedMoves.length) return null;
  const outcome =
    completedGame?.session === sessionId
      ? completedGame.outcome
      : boards.play.outcome || "";
  const result = outcome.startsWith("White wins")
    ? "1-0"
    : outcome.startsWith("Black wins")
      ? "0-1"
      : outcome.startsWith("Draw")
        ? "1/2-1/2"
        : "*";
  const savingSession = sessionId;
  const payload = {
    white: data?.player || "You",
    black: "Study bot · " + $("#play-style").value,
    result,
    date: new Date(practiceStartedAt || Date.now()).toLocaleDateString("en-CA"),
    played_at: practiceStartedAt || new Date().toISOString(),
    event: "Practice",
    moves: playedMoves.slice(),
    session_id: sessionId,
    source: "practice",
    opponent_rating: gameOpponentRating,
    analyze,
  };
  $("#history-save-status").textContent = "Saving to your game history…";
  const save = async () => {
    const r = await api("games", payload);
    const previous = data?.games[r.index];
    if (r.game && data && r.index <= data.games.length) {
      data.games[r.index] = r.game;
      data.ready = r.ready;
      data.progress = r.progress;
      data.total = r.total;
      if (previous?.moves.join(" ") !== r.game.moves.join(" ")) {
        if (currentReviewGame === r.index) currentReview = null;
        if (typeof perspectivePlans !== "undefined")
          perspectivePlans.delete(r.index);
        if (typeof perspectiveSeen !== "undefined")
          for (const key of perspectiveSeen)
            if (key.startsWith(`${r.index}:`)) perspectiveSeen.delete(key);
      }
      update(data);
      if (profileData && Number.isFinite(r.practice_rating)) {
        profileData.practice_rating = r.practice_rating;
        if (Number.isFinite(r.adaptive_rating))
          profileData.adaptive_rating = r.adaptive_rating;
        $("#practice-rating").textContent = r.practice_rating.toLocaleString();
        updateRatingControl();
      }
    } else {
      // Older services and gaps from another browser tab need a full snapshot.
      const snapshot = await (await fetch("/api/data")).json();
      if (currentReviewGame === r.index) currentReview = null;
      update(snapshot);
      if (!snapshot.ready && !pollTimer && !pollInFlight) poll();
    }
    if (r.ready === false && !pollTimer && !pollInFlight) poll();
    if (savingSession === sessionId)
      $("#history-save-status").textContent =
        result === "*"
          ? "✓ Saved to history · in progress"
          : "✓ Completed game saved to history";
    return r.index;
  };
  historySaveQueue = historySaveQueue.catch(() => {}).then(save);
  return historySaveQueue;
}
function autoSavePractice() {
  savePractice(false).catch((e) => {
    $("#history-save-status").textContent =
      "Could not save to history. Your board is kept in this browser.";
    toast(e.message);
  });
}
// Board transitions hold one lock across persistence and board preparation.
// The old session remains intact until a replacement position is ready.
function beginPlayTransition() {
  if (playTransition || botBusy || boards.play.busy) return null;
  const transition = { session: sessionId, controls: [] };
  playTransition = transition;
  boards.play.busy = true;
  for (const id of [
    "new-game",
    "play-again",
    "take-back",
    "review-current",
    "coach-hint",
    "coach-best",
    "coach-speak",
    "resign-game",
  ]) {
    const control = $("#" + id);
    transition.controls.push([control, control.disabled]);
    control.disabled = true;
  }
  renderBoard("play");
  return transition;
}
function endPlayTransition(transition) {
  if (playTransition !== transition) return;
  playTransition = null;
  boards.play.busy = false;
  for (const [control, disabled] of transition.controls)
    control.disabled = disabled;
  renderBoard("play");
}
async function newPractice() {
  if (newGameBusy || playTransition || botBusy || boards.play.busy) return;
  stopSpeech();
  coachRequestId++;
  closeGameResult();
  $("#game-options").open = false;
  const transition = beginPlayTransition();
  if (!transition) return;
  newGameBusy = true;
  let created = false;
  try {
    if (playedMoves.length) await savePractice();
    const position = await api("board", { fen: startFen });
    if (playTransition !== transition || sessionId !== transition.session)
      return;
    stopSpeech();
    coachRequestId++;
    sessionId = crypto.randomUUID();
    gameOpponentRating = null;
    practiceStartedAt = null;
    $("#history-save-status").textContent =
      "Your game will be saved to history as you play.";
    localStorage.removeItem("chess-active-game");
    $("#coach-evidence").replaceChildren();
    playedMoves = [];
    undoFen = null;
    undoMoves = 0;
    lastCoach = null;
    coachPreview = null;
    gameFinished = false;
    completedGame = null;
    $("#game-result").hidden = true;
    $("#coach-assessment").replaceChildren();
    $("#coach-resume").hidden = true;
    applyBoard("play", position);
    message("play", "Your turn. Take your time.");
    $("#play-grade").className = "grade-tag neutral";
    $("#play-grade").textContent = "LET’S PLAY";
    $("#coach-explanation").textContent =
      "Play at your pace. I’ll explain important moments; you can ask about any move.";
    $("#play-turn").textContent = "White to move · You";
    evalBar("play", 0);
    updateOpening();
    updateRatingControl();
    created = true;
  } catch (error) {
    toast(
      "Could not start a new game. Your current board is kept. " +
        error.message,
    );
  } finally {
    newGameBusy = false;
    endPlayTransition(transition);
    if (created) {
      $("#take-back").disabled =
        $("#coach-best").disabled =
        $("#coach-speak").disabled =
          true;
      $("#new-game").disabled =
        $("#play-again").disabled =
        $("#review-current").disabled =
        $("#coach-hint").disabled =
        $("#resign-game").disabled =
          false;
    }
  }
}
$("#play-again").onclick = () => newPractice();
$("#review-finished").onclick = () => $("#review-current").click();
$("#review-current").onclick = async () => {
  if (botBusy || boards.play.busy) {
    toast("Wait for this turn to finish.");
    return;
  }
  try {
    const index = await savePractice();
    if (index === null) {
      toast("Play a few moves first.");
      return;
    }
    gameIndex = index;
    replayPly = 0;
    currentReview = null;
    navigate("games");
    replay();
  } catch (e) {
    toast(e.message);
  }
};
// Date-only PGNs use the same Brisbane day as the history rating. Explicit
// UTC headers and saved bot timestamps retain their actual time of day.
function pgnPlayedTime(date, time = "00:00:00", offset = 10 * 3600000) {
  const day = /^(\d{4})[.-](\d{2})[.-](\d{2})$/.exec(date || "");
  if (!day) return null;
  const [, year, month, number] = day.map(Number);
  const midnight = new Date(0);
  midnight.setUTCFullYear(year, month - 1, number);
  midnight.setUTCHours(0, 0, 0, 0);
  if (midnight.getUTCFullYear() !== year || midnight.getUTCMonth() !== month - 1 || midnight.getUTCDate() !== number)
    return null;
  const clock = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time || "");
  const [hour, minute, second] = clock ? clock.slice(1).map(Number) : [0, 0, 0];
  const validClock = hour < 24 && minute < 60 && second < 60;
  return midnight.getTime() - offset + (validClock ? (hour * 3600 + minute * 60 + second) * 1000 : 0);
}
function gamePlayedTime(game) {
  const stamp = game.played_at;
  if (typeof stamp === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(stamp) && pgnPlayedTime(stamp.slice(0, 10)) !== null) {
    const time = Date.parse(stamp);
    if (Number.isFinite(time)) return time;
  }
  return pgnPlayedTime(game.tags?.UTCDate || (game.tags?.UTCTime ? game.date : null), game.tags?.UTCTime, 0) ??
    pgnPlayedTime(game.date, game.tags?.Time || game.tags?.StartTime) ?? -Infinity;
}
function reviewLibraryEntries(games) {
  return games.map((game, index) => ({ game, index, time: gamePlayedTime(game) }))
    .sort((a, b) => a.time === b.time ? b.index - a.index : b.time - a.time);
}
function syncLibrary() {
  if (!data) return;
  const select = $("#review-select");
  const signature = JSON.stringify(data.games.map(g => [
    g.session_id, g.moves.length, g.result, g.date, g.played_at,
    g.tags?.UTCDate, g.tags?.UTCTime, g.tags?.Time, g.tags?.StartTime,
    g.white, g.black, g.event, g.source,
  ]));
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.innerHTML = "";
    $("#game-list").innerHTML = "";
    reviewLibraryEntries(data.games).forEach(({ game: g, index: i }) => {
      const option = document.createElement("option");
      option.value = i;
      const source = g.source === "upload" ? " · Imported" : g.source === "practice" ? " · Practice" : "";
      option.textContent = `${g.date || "Date unknown"} · ${g.white} vs ${g.black} · ${g.result}${source}`;
      select.append(option);
      const b = document.createElement("button");
      b.className = "game-row";
      b.dataset.gameIndex = String(i);
      b.textContent = g.white + " vs " + g.black;
      const small = document.createElement("small");
      small.textContent = (g.date || "Date unknown") + " · " + g.result + source;
      b.append(small);
      b.onclick = () => {
        gameIndex = i;
        replayPly = 0;
        currentReview = null;
        replay();
      };
      $("#game-list").append(b);
    });
  }
  select.value = gameIndex;
  $("#export-game").href = "/api/games/" + gameIndex + "/pgn";
}
$("#review-select").onchange = () => {
  stopSpeech();
  gameIndex = Number($("#review-select").value);
  replayPly = 0;
  currentReview = null;
  replay();
};
async function replay() {
  if (typeof opponentChallenge !== "undefined" && opponentChallenge)
    stopReviewPlayback();
  if (!data?.games[gameIndex]) return;
  clearTimeout(reviewTimer);
  const id = gameIndex,
    request = ++reviewRequest,
    g = data.games[id];
  const valid = () => request === reviewRequest && gameIndex === id;
  syncLibrary();
  $("#review-title").textContent = g.white + " vs " + g.black;
  $("#review-subtitle").textContent =
    g.date +
    " · " +
    g.result +
    " · " +
    (g.source === "practice" ? "Practice game" : g.event);
  boards.game.flip = g.black === data.player;
  try {
    if (currentReviewGame !== id || !currentReview) {
      const response = await fetch("/api/reviews/" + id);
      if (!valid()) return;
      if (response.status === 202) {
        $("#review-explanation").textContent =
          "Analyzing this game locally. You can keep playing while the review is prepared.";
        $("#review-grade").className = "grade-tag neutral";
        $("#review-grade").textContent = "ANALYZING";
        await setBoard("game", startFen, valid);
        if (!valid()) return;
        reviewTimer = setTimeout(replay, 1600);
        return;
      }
      if (!response.ok) throw Error("Could not load review");
      const review = await response.json();
      if (!valid()) return;
      currentReview = review;
      currentReviewGame = id;
    }
    if (!valid()) return;
    replayPly = Math.max(0, Math.min(replayPly, currentReview.moves.length));
    renderReview();
  } catch (e) {
    if (valid()) $("#review-explanation").textContent = e.message;
  }
}
function renderReview(options = {}) {
  if (typeof visualLesson !== "undefined" && visualLesson?.name === "game")
    stopSpeech();
  if (!currentReview) return;
  variationActive = false;
  $("#variation").hidden = true;
  if (
    typeof guidedReview !== "undefined" &&
    guidedReview &&
    guidedReview.game !== gameIndex
  )
    endGuidedReview();
  const r = currentReview,
    m = r.moves[replayPly - 1];
  Object.assign(boards.game, {
    fen: m ? m.after : startFen,
    lastMove: m ? [m.uci.slice(0, 2), m.uci.slice(2, 4)] : null,
    arrow: null,
    hint: null,
    selected: null,
    check: Boolean(m && /[+#]/.test(m.san)),
    turn: replayPly % 2 ? "black" : "white",
    badge: m ? { square: m.uci.slice(2, 4), grade: m.grade } : null,
    evidence: null,
  });
  $("#review-restore").hidden = true;
  evidenceCards("review-evidence", m?.evidence || [], "game");
  assessment(
    "review-assessment",
    m
      ? {
          grade: m.grade,
          loss: m.loss,
          before: m.eval_before,
          after: m.eval_after,
        }
      : null,
  );
  renderStory();
  $("#practice-moment").disabled =
    !m || !data.puzzles.some((p) => p.game === gameIndex && p.ply === m.ply);
  renderBoard("game");
  $("#review-accuracy").textContent = Math.round(r.accuracy) + "%";
  $("#review-mistakes").textContent = r.mistakes;
  $("#review-blunders").textContent = r.blunders;
  $("#replay-label").textContent = m
    ? `${Math.floor(m.ply / 2) + 1}${m.ply % 2 ? "…" : "."} ${m.san}`
    : "Starting position";
  $("#review-ply").textContent = `${replayPly} / ${r.moves.length} PLIES`;
  $("#prev-move").disabled = $("#first-move").disabled = replayPly === 0;
  $("#next-move").disabled = $("#last-move").disabled =
    replayPly === r.moves.length;
  $("#review-best").disabled = $("#review-reply").disabled = !m;
  if (m) {
    setGrade("#review-grade", m.grade);
    $("#review-move-title").textContent = `${m.san} · ${gradeLabels[m.grade]}`;
    $("#review-explanation").textContent = m.explanation;
    evalBar("review", m.eval_after);
  } else {
    $("#review-grade").className = "grade-tag neutral";
    $("#review-grade").textContent = "STARTING POSITION";
    $("#review-move-title").textContent = "The first move is yours to explore.";
    $("#review-explanation").textContent =
      "Use the arrows or select any move below. The graph shows how the balance changes; colored markers identify mistakes and blunders.";
    evalBar("review", 0);
  }
  drawChart();
  renderMoveList();
  const id = gameIndex,
    ply = replayPly;
  api("opening", { moves: data.games[id].moves.slice(0, ply) })
    .then((o) => {
      if (gameIndex === id && replayPly === ply)
        $("#review-opening").textContent = o.opening
          ? `${o.opening.eco} · ${o.opening.name} · Lichess opening reference`
          : "No named opening matched yet.";
    })
    .catch(() => {});
  document
    .querySelectorAll(".game-row")
    .forEach(e => e.classList.toggle("current-game", Number(e.dataset.gameIndex) === gameIndex));
  if (options.narrate !== false && typeof scheduleReviewVoice === "function")
    scheduleReviewVoice(m);
  if (typeof updateReviewTransport === "function") updateReviewTransport();
  if (typeof updatePerspectiveAvailability === "function")
    updatePerspectiveAvailability();
}
let chartReview = null,
  chartMoves = null,
  moveListReview = null,
  moveListMoves = null,
  reviewMoveButtons = [],
  activeReviewButton = null;
function drawChart() {
  const count = currentReview.moves.length;
  if (chartReview === currentReview && chartMoves === currentReview.moves) {
    $("#eval-chart .eval-cursor")?.setAttribute(
      "d",
      `M${(replayPly / Math.max(1, count)) * 600},0 V70`,
    );
    return;
  }
  chartReview = currentReview;
  chartMoves = currentReview.moves;
  const moves = currentReview.moves,
    w = 600,
    h = 70;
  const y = (v) => h / 2 - Math.tanh(v / 600) * 30;
  const points = [
    [0, y(0)],
    ...moves.map((m, i) => [((i + 1) / moves.length) * w, y(m.eval_after)]),
  ];
  const path = points
    .map(([x, y], i) => (i ? "L" : "M") + x + "," + y)
    .join(" ");
  let dots = "";
  moves.forEach((m, i) => {
    if (m.grade === "blunder" || m.grade === "mistake")
      dots += `<circle cx="${((i + 1) / moves.length) * w}" cy="${y(m.eval_after)}" r="2.7" fill="${m.grade === "blunder" ? "#d87980" : "#d8aa63"}"/>`;
  });
  $("#eval-chart").innerHTML =
    `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="M0,35 H600" stroke="var(--line)"/><path d="${path} L600,70 L0,70 Z" fill="var(--accent)" opacity=".08"/><path d="${path}" stroke="var(--accent)" fill="none" stroke-width="1.5"/>${dots}<path class="eval-cursor" d="M${(replayPly / Math.max(1, moves.length)) * w},0 V70" stroke="var(--gold)" stroke-width="1.5"/></svg>`;
}
function renderMoveList() {
  const list = $("#move-list");
  if (
    moveListReview !== currentReview ||
    moveListMoves !== currentReview.moves
  ) {
    moveListReview = currentReview;
    moveListMoves = currentReview.moves;
    reviewMoveButtons = [];
    activeReviewButton = null;
    const fragment = document.createDocumentFragment();
    currentReview.moves.forEach((m, i) => {
      if (i % 2 === 0)
        fragment.append(
          element("span", "move-number", Math.floor(i / 2) + 1 + "."),
        );
      const button = element("button", "move-item " + m.grade);
      button.setAttribute(
        "aria-label",
        `Move ${Math.floor(i / 2) + 1} ${i % 2 ? "Black" : "White"} ${m.san}, ${gradeLabels[m.grade]}`,
      );
      button.append(
        element("span", "", m.san),
        element("span", "mini-grade", gradeSymbol(m.grade)),
      );
      button.onclick = () => seekReview(i + 1);
      reviewMoveButtons.push(button);
      fragment.append(button);
    });
    list.replaceChildren(fragment);
    list.scrollTop = 0;
  }
  activeReviewButton?.classList.remove("active");
  const active = reviewMoveButtons[replayPly - 1];
  activeReviewButton = active;
  active?.classList.add("active");
  if (active) {
    const item = active.getBoundingClientRect(),
      viewport = list.getBoundingClientRect();
    if (item.top < viewport.top || item.bottom > viewport.bottom)
      list.scrollTop += item.top - viewport.top - 40;
  }
}
function stepReview(delta) {
  return seekReview(replayPly + delta);
}
function showVariation(which) {
  if (typeof stopReviewPlayback === "function") stopReviewPlayback();
  stopSpeech();
  const m = currentReview?.moves[replayPly - 1];
  if (!m) return;
  const best = which === "best",
    line = best ? m.best_line : m.reply_line;
  variationActive = true;
  $("#variation").hidden = false;
  $("#variation-title").textContent = best
    ? "BEST CONTINUATION"
    : "OPPONENT’S STRONGEST REPLY";
  $("#variation-moves").innerHTML = "";
  Object.assign(boards.game, {
    fen: best ? m.before : m.after,
    arrow: line[0]?.uci || null,
    hint: line[0]?.uci.slice(0, 2) || null,
    lastMove: null,
    badge: null,
    evidence: null,
  });
  renderBoard("game");
  line.forEach((step, i) => {
    const button = document.createElement("button");
    button.className = "pv-move";
    button.textContent = i + 1 + ". " + step.san;
    button.onclick = () => {
      showReviewLineStep(step, i ? line[i - 1].fen : best ? m.before : m.after);
      $("#variation-moves")
        .querySelectorAll("button")
        .forEach((b, k) => b.classList.toggle("active", k === i));
    };
    $("#variation-moves").append(button);
  });
  if (!line.length)
    $("#variation-moves").textContent =
      "The position is terminal; there are no further moves.";
}
$("#review-best").onclick = () => showVariation("best");
$("#review-reply").onclick = () => showVariation("reply");
$("#variation-close").onclick = renderReview;
$("#review-speak").onclick = () =>
  speakText($("#review-explanation").textContent);
document.addEventListener("keydown", (e) => {
  if (
    $("#games").classList.contains("active") &&
    !["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName) &&
    !$("#promotion").open
  ) {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      stepReview(1);
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      stepReview(-1);
    }
  }
});
