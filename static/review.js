// Review owns its clock. Speech, animations and reading time all finish before the next move.
const reviewPlayback = {
  playing: false,
  running: false,
  token: 0,
  movement: 0,
  seeking: false,
  guided: false,
  animations: [],
  resumeVoice: false,
};
function updateReviewTransport(status) {
  const count = currentReview?.moves.length || 0;
  $("#review-play").disabled = !count;
  $("#review-play").setAttribute(
    "aria-label",
    reviewPlayback.playing ? "Pause review" : "Play review",
  );
  $("#review-play").setAttribute(
    "aria-pressed",
    String(reviewPlayback.playing),
  );
  $("#review-play").textContent = reviewPlayback.playing
    ? "Ⅱ Pause"
    : replayPly >= count && count
      ? "↻ Replay"
      : "▶ Play review";
  if (typeof opponentChallenge !== "undefined" && opponentChallenge) {
    $("#review-play").textContent = "▶ Continue review";
    $("#review-play").setAttribute("aria-label", "Continue review");
  }
  $("#review-position").max = count || 1;
  $("#review-position").value = replayPly;
  $("#review-position").setAttribute(
    "aria-valuetext",
    replayPly
      ? `After move ${Math.ceil(replayPly / 2)}, ${replayPly % 2 ? "White" : "Black"}`
      : "Starting position",
  );
  if (status) $("#review-playback-status").textContent = status;
}
function stopReviewPlayback({ speech = true } = {}) {
  reviewPlayback.token++;
  reviewPlayback.movement++;
  reviewPlayback.playing =
    reviewPlayback.running =
    reviewPlayback.seeking =
      false;
  if (typeof opponentChallenge !== "undefined" && opponentChallenge)
    finishPerspective(false);
  for (const a of reviewPlayback.animations) a.cancel();
  reviewPlayback.animations = [];
  if (speech) stopSpeech();
  updateReviewTransport("Paused · step through or press Play");
}
function pauseReviewPlayback() {
  if (!reviewPlayback.running) return;
  reviewPlayback.playing = false;
  reviewPlayback.resumeVoice = Boolean(speechAudio && !speechAudio.paused);
  speechAudio?.pause();
  if (visualLesson?.name === "game") visualLesson.paused = true;
  for (const a of reviewPlayback.animations)
    if (a.playState === "running") a.pause();
  updateReviewTransport("Paused · take your time");
}
async function reviewWait(ms, valid, playback = false) {
  let left = ms,
    last = performance.now();
  while (left > 0) {
    if (!valid()) return false;
    await delay(Math.min(45, left));
    const now = performance.now();
    if (!playback || reviewPlayback.playing) left -= now - last;
    last = now;
  }
  return valid();
}
function reviewBoard(fen) {
  Object.assign(boards.game, {
    fen,
    selected: null,
    lastMove: null,
    arrow: null,
    hint: null,
    evidence: null,
    badge: null,
    narrating: false,
    check: false,
  });
  renderBoard("game");
}
async function seekReview(
  target,
  { automatic = false, context = true, explain = true } = {},
) {
  if (!currentReview) return false;
  if (!automatic) stopReviewPlayback();
  else stopSpeech();
  clearTimeout(autoReviewTimer);
  const revision = ++reviewPlayback.movement,
    game = gameIndex,
    previous = replayPly;
  const valid = () =>
    revision === reviewPlayback.movement &&
    game === gameIndex &&
    $("#games").classList.contains("active");
  target = Math.max(0, Math.min(currentReview.moves.length, target));
  reviewPlayback.seeking = true;
  const move =
    target < previous && previous - target === 1
      ? currentReview.moves[previous - 1]
      : currentReview.moves[target - 1];
  const reverse = previous - target === 1;
  if (context && Math.abs(target - previous) > 1 && move) {
    reviewBoard(move.before);
    updateReviewTransport(
      `Before ${Math.ceil(target / 2)}${target % 2 ? "." : "…"} ${move.san} · watch the move`,
    );
    $("#review-position").value = target;
    if (!(await reviewWait(400, valid, automatic))) return false;
  }
  if (!valid()) return false;
  const before = boards.game.fen;
  replayPly = target;
  renderReview({ narrate: false });
  reviewPlayback.animations = animateBoardMove(
    "game",
    before,
    boards.game.fen,
    move?.uci,
    reverse,
  );
  if (move && target !== previous)
    playSound(
      move.san.includes("x")
        ? "capture"
        : /[+#]/.test(move.san)
          ? "check"
          : "move",
    );
  updateReviewTransport(
    target
      ? `Move ${Math.ceil(target / 2)} · ${target % 2 ? "White" : "Black"} just played`
      : "Starting position",
  );
  if (!(await reviewWait(300, valid, automatic))) return false;
  reviewPlayback.animations = [];
  reviewPlayback.seeking = false;
  if (explain && !automatic && target && voiceEnabled) {
    lastAutoReview = "";
    scheduleReviewVoice(currentReview.moves[target - 1]);
  }
  return true;
}
function reviewReadingPause(move) {
  const factor = move?.review_pace?.multiplier;
  // Old services and incomplete caches retain the user's chosen base pace.
  return Math.round(
    preferences.reviewPause *
      (Number.isFinite(factor) ? Math.max(0.5, Math.min(2, factor)) : 1),
  );
}
async function startReviewPlayback({ guided = false, fromStart = false } = {}) {
  if (typeof opponentChallenge !== "undefined" && opponentChallenge) {
    finishPerspective(true);
    return;
  }
  if (!currentReview?.moves.length) return;
  if (reviewPlayback.running && !reviewPlayback.playing && !fromStart) {
    reviewPlayback.playing = true;
    if (visualLesson?.name === "game") visualLesson.paused = false;
    if (speechAudio && (reviewPlayback.resumeVoice || speechAudio.coachHasMore || !speechAudio.ended))
      speechAudio.play().catch(() => {});
    for (const a of reviewPlayback.animations)
      if (a.playState === "paused") a.play();
    updateReviewTransport("Playing · pause whenever you like");
    return;
  }
  stopReviewPlayback();
  if (fromStart || replayPly >= currentReview.moves.length) {
    replayPly = 0;
    renderReview({ narrate: false });
  }
  reviewPlayback.guided = guided;
  reviewPlayback.running = reviewPlayback.playing = true;
  const token = ++reviewPlayback.token,
    game = gameIndex;
  const valid = () =>
    token === reviewPlayback.token &&
    game === gameIndex &&
    $("#games").classList.contains("active");
  let perspectiveItems = [];
  // Optional teaching analysis must never hold up ordinary review playback.
  if (typeof preparePerspectives === "function")
    preparePerspectives(game).then((items) => {
      if (valid()) perspectiveItems = items;
    });
  updateReviewTransport("Playing · watch each move unfold");
  while (valid() && replayPly < currentReview.moves.length) {
    if (!(await reviewWait(175, valid, true))) break;
    if (
      !(await seekReview(replayPly + 1, {
        automatic: true,
        context: false,
        explain: false,
      }))
    )
      break;
    const m = currentReview.moves[replayPly - 1];
    const key = Boolean(m.player && m.loss >= 80);
    const perspective =
      preferences.reviewChallenges &&
      perspectiveItems.find(
        (item) =>
          item.ply === replayPly && !perspectiveSeen.has(`${game}:${item.ply}`),
      );
    if (perspective) {
      await beginPerspective(perspective, true);
      if (!valid()) break;
      continue;
    }
    if (guidedReview) {
      guidedReview.index = Math.max(0, guidedReview.moments.indexOf(replayPly));
      $("#guided-caption").textContent = key
        ? `Key move · ${m.san}. Pause to explore this moment.`
        : `Following the game · move ${Math.ceil(replayPly / 2)}`;
    }
    if (
      voiceEnabled &&
      m.player &&
      (!guided || key) &&
      shouldNarrateReview(m)
    ) {
      updateReviewTransport(
        "Coach explanation · Play/Pause controls the whole review",
      );
      const result = autoNarrate("game", m);
      if (result && typeof result.then === "function") await result;
      while (
        valid() &&
        ((visualLesson?.name === "game" && visualLesson.spoken) ||
          (speechAudio && (!speechAudio.ended || speechAudio.coachHasMore) && !speechAudio.error))
      ) {
        if (visualLesson && !visualLesson.spoken && !speechAudio) break;
        await delay(80);
      }
      if (!valid()) break;
      if (visualLesson?.name === "game") stopSpeech();
    }
    // Prepare the next explanation while the current move is on screen.
    const upcoming = currentReview.moves.slice(replayPly).find(record =>
      record.player && (!guided || record.loss >= 80) && shouldNarrateReview(record));
    if (upcoming) prefetchLesson(upcoming, valid);
    if (!(await reviewWait(reviewReadingPause(m), valid, true))) break;
  }
  if (token === reviewPlayback.token) {
    reviewPlayback.playing = reviewPlayback.running = false;
    updateReviewTransport(
      "Review complete · choose a turning point to practice",
    );
  }
}
function keyMove(direction) {
  if (!currentReview) return;
  const keys = currentReview.moves
    .filter(
      (m) =>
        m.player &&
        (["mistake", "blunder"].includes(m.grade) || m.san.includes("#")),
    )
    .map((m) => m.ply + 1);
  const target =
    direction > 0
      ? keys.find((n) => n > replayPly)
      : [...keys].reverse().find((n) => n < replayPly);
  if (target === undefined) {
    toast(
      direction > 0
        ? "No later key moves. You can replay or choose any move."
        : "No earlier key moves.",
    );
    return;
  }
  seekReview(target);
}
async function showReviewLineStep(step, before) {
  stopReviewPlayback();
  const revision = ++reviewPlayback.movement;
  const valid = () => revision === reviewPlayback.movement && variationActive;
  if (boards.game.fen !== before) {
    reviewBoard(before);
    updateReviewTransport("Before the alternative · watch the move");
    if (!(await reviewWait(400, valid))) return;
  }
  if (!valid()) return;
  reviewBoard(step.fen);
  Object.assign(boards.game, {
    lastMove: [step.uci.slice(0, 2), step.uci.slice(2, 4)],
  });
  renderBoard("game");
  reviewPlayback.animations = animateBoardMove(
    "game",
    before,
    step.fen,
    step.uci,
  );
  updateReviewTransport(`Alternative · ${step.san}`);
  playSound();
}
$("#review-play").onclick = () =>
  reviewPlayback.playing
    ? pauseReviewPlayback()
    : startReviewPlayback({ guided: reviewPlayback.guided });
$("#prev-move").onclick = () => seekReview(replayPly - 1);
$("#next-move").onclick = () => seekReview(replayPly + 1);
$("#first-move").onclick = () => seekReview(0, { explain: false });
$("#last-move").onclick = () => seekReview(currentReview?.moves.length || 0);
$("#previous-key").onclick = () => keyMove(-1);
$("#next-key").onclick = $("#review-blunder").onclick = () => keyMove(1);
$("#review-position").oninput = () => {
  const value = $("#review-position").value;
  stopReviewPlayback();
  $("#review-position").value = value;
  updateReviewTransport(`Choose move ${Math.ceil(Number(value) / 2)}`);
  $("#review-position").value = value;
};
$("#review-position").onchange = () =>
  seekReview(Number($("#review-position").value));
$("#eval-chart").onclick = (event) => {
  if (!currentReview) return;
  const box = event.currentTarget.getBoundingClientRect();
  seekReview(
    Math.round(
      ((event.clientX - box.x) / box.width) * currentReview.moves.length,
    ),
  );
};
$("#guided-review").onclick = () => {
  if (!currentReview) return;
  guidedReview = {
    game: gameIndex,
    moments: currentReview.moves
      .filter((m) => m.player && m.loss >= 80)
      .map((m) => m.ply + 1),
    index: 0,
  };
  $("#guided-review").hidden = true;
  $("#guided-next").hidden = false;
  $("#guided-exit").hidden = false;
  $("#guided-caption").textContent =
    "From the first move · the coach pauses at your turning points.";
  startReviewPlayback({ guided: true, fromStart: true });
};
$("#guided-next").onclick = () => keyMove(1);
function endGuidedReview() {
  stopReviewPlayback();
  guidedReview = null;
  reviewPlayback.guided = false;
  $("#guided-review").hidden = false;
  $("#guided-next").hidden = true;
  $("#guided-exit").hidden = true;
  $("#guided-caption").textContent =
    "Learn from the moments that changed your game.";
}
$("#guided-exit").onclick = endGuidedReview;
$("#review-select").addEventListener("change", () => stopReviewPlayback());
document.addEventListener(
  "change",
  (event) => {
    if (event.target.matches("#review-select")) stopReviewPlayback();
  },
  { capture: true },
);
document.addEventListener(
  "click",
  (event) => {
    if (event.target.closest(".nav,#settings-open,.game-row"))
      stopReviewPlayback();
    if (
      event.target.closest(
        "#review-speak,#review-lesson,#review-evidence,#review-best,#review-reply",
      )
    )
      pauseReviewPlayback();
  },
  { capture: true },
);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pauseReviewPlayback();
});
document.addEventListener("keydown", (event) => {
  if (
    event.code === "Space" &&
    $("#games").classList.contains("active") &&
    !event.target.closest("button,a,input,select,textarea,[contenteditable]")
  ) {
    event.preventDefault();
    $("#review-play").click();
  }
});
$("#review-play").setAttribute("aria-keyshortcuts", "Space");
updateReviewTransport();
