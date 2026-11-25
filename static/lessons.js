// Guided explanation pairs one spoken idea at a time with its exact board diagram.
let visualLesson = null,
  lessonToken = 0,
  dismissedCoach = null,
  pendingPrediction = null;
const dismissedLessons = new WeakSet();
function boardSnapshot(name) {
  // Position data is reversible; live request locks and orientation are not.
  const { busy, flip, explicitMotion, ...position } = boards[name];
  return { ...position, selected: null };
}
function returnToBoard(name) {
  if (
    name === "game" &&
    typeof opponentChallenge !== "undefined" &&
    opponentChallenge
  ) {
    finishPerspective(true);
    return;
  }
  if (visualLesson?.name === name) dismissedLessons.add(visualLesson.record);
  dismissedCoach = lastCoach;
  pendingAutoSpeech = null;
  clearTimeout(autoReviewTimer);
  stopSpeech();
  if (name === "play" && coachPreview) $("#coach-resume").click();
  if (name === "puzzle" && puzzlePreview) $("#puzzle-return").click();
  if (name === "game") renderReview({ narrate: false });
  boards[name].selected = null;
  renderBoard(name);
}
function hybridWords(fact) {
  if (fact.spoken_text) return fact.spoken_text;
  const map = placement(fact.fen),
    source = fact.arrows?.[0]?.from;
  const actor =
    source && map[source] ? pieceNames[map[source].toLowerCase()] : "piece";
  const controls = fact.arrows?.filter((a) => a.kind === "control") || [];
  if (controls.length)
    return `The outlined ${actor} controls ${controls.length === 1 ? "the teal square" : "the teal squares"}. ${/central|center/.test(fact.text) ? "This gives it influence in the center." : "The arrows show its reach from this position."}`;
  if (fact.theme === "Forks & double attacks" && fact.arrows?.length >= 2) {
    const targets = fact.arrows.map((a) =>
      map[a.to] ? pieceNames[map[a.to].toLowerCase()] : "target",
    );
    return `The ${actor} attacks the ${targets.join(" and ")} at once.${targets.includes("king") ? " The check must be answered first." : ""}`;
  }
  if (fact.theme === "Pins")
    return `This ${pieceNames[map[fact.squares?.[0]]?.toLowerCase()] || "piece"} is pinned to its king. It cannot leave the marked line without exposing check.`;
  if (/Checkmate/.test(fact.title))
    return "This is checkmate. The king is attacked, and there is no escape, capture, or block.";
  if (/forcing check/i.test(fact.title))
    return "The king is in check, so this threat takes priority over any other plan.";
  if (/recapture/i.test(fact.title))
    return `The capture takes a ${fact.text.match(/captures a (\w+)/)?.[1] || "piece"}, but the destination is also attacked.`;
  if (/undefended capture/i.test(fact.title))
    return `The ${fact.text.match(/captures a (\w+)/)?.[1] || "piece"} is captured on a square no opposing piece currently attacks.`;
  if (fact.theme === "Piece activity" && fact.arrows?.length) {
    const targets = fact.arrows.map((a) =>
      map[a.to] ? pieceNames[map[a.to].toLowerCase()] : "square",
    );
    return `The outlined ${actor} attacks the highlighted ${targets.join(" and ")}.`;
  }
  // Keep distinct square names when a fact refers to more than one location.
  return fact.text;
}
function factContext(fact) {
  return (
    fact.context ||
    (fact.title.startsWith("Opponent")
      ? "opponent_reply"
      : fact.title.startsWith("Better plan")
        ? "alternative"
        : fact.title.startsWith("Your idea")
          ? "played"
          : "suggestion")
  );
}
function factWords(fact, introduce = true) {
  const detail = hybridWords(fact);
  if (!introduce) return detail;
  const lead =
    fact.introduction ||
    {
      opponent_reply: "Now your opponent has this possible reply.",
      alternative: "A different option would have been this move.",
      suggestion: "Here is one possible continuation.",
    }[factContext(fact)] ||
    "";
  return lead ? lead + " " + detail : detail;
}
function assessment(id, value) {
  const root = $("#" + id);
  if (!root) return;
  root.replaceChildren();
  if (!value) return;
  const g = value.grade,
    loss = value.loss || 0;
  const header = element("div", "assessment-heading");
  header.append(
    element("strong", g, gradeSymbol(g) + " " + (gradeLabels[g] || g)),
    element(
      "span",
      "",
      loss ? `${loss} cp given up` : "Preferred continuation",
    ),
  );
  const meter = element("div", "quality-meter");
  const grades = [
    "blunder",
    "mistake",
    "inaccuracy",
    "good",
    "excellent",
    "best",
  ];
  const active = grades.indexOf(g);
  grades.forEach((name, i) => {
    const bar = element("span", name + (i === active ? " selected" : ""));
    bar.title = gradeLabels[name];
    meter.append(bar);
  });
  const balance = element("div", "assessment-balance");
  const score = (v) =>
    Math.abs(v) > 9000
      ? "Forced mate"
      : (v >= 0 ? "+" : "") + (v / 100).toFixed(1);
  balance.append(
    element("span", "", `Before ${score(value.before)}`),
    element("span", "", "→"),
    element("span", "", `After ${score(value.after)}`),
  );
  root.append(
    header,
    meter,
    balance,
    element(
      "small",
      "",
      "Position balance from White’s side · engine estimate",
    ),
  );
}
function lessonPlan(record) {
  const steps = [];
  if (record.uci && record.after) {
    const quality = {
      grade: record.grade,
      loss: record.loss,
      before: record.eval_before,
      after: record.eval_after,
    };
    steps.push({
      title: "First, judge the move",
      fen: record.after,
      squares: [record.uci.slice(0, 2), record.uci.slice(2, 4)],
      arrows: [],
      text: `${record.player === false ? "Your opponent played" : "You played"} ${record.san || (pieceNames[placement(record.before)[record.uci.slice(0, 2)]?.toLowerCase()] || "a piece") + " to " + record.uci.slice(2, 4)}. ${gradeLabels[record.grade] || "Move review"}.`,
      before: record.before,
      uci: record.uci,
      quality,
      badge: { square: record.uci.slice(2, 4), grade: record.grade },
    });
  }
  const allFacts = record.evidence || [];
  const explainPlayed =
    record.loss <= 80 && allFacts.some((f) => factContext(f) === "played");
  const facts = [],
    candidates = [];
  const seen = new Set();
  for (const fact of allFacts) {
    if (explainPlayed && factContext(fact) === "alternative") continue;
    const key = [fact.fen, fact.theme, fact.text].join(":");
    if (seen.has(key)) continue;
    // A quiet reply relocation adds no explanation to the mistake; keep the concrete better idea.
    if (
      fact.title.startsWith("Opponent") &&
      /^Piece activity$/.test(fact.theme) &&
      /repositions/.test(fact.text)
    )
      continue;
    seen.add(key);
    candidates.push(fact);
  }
  const lineKey = (fact) =>
    [factContext(fact), fact.before, fact.uci].join(":");
  const lines = new Set();
  // Reserve room for the alternative instead of using both steps on one reply.
  for (const fact of candidates) {
    if (lines.has(lineKey(fact))) continue;
    lines.add(lineKey(fact));
    facts.push(fact);
    if (facts.length === 2) break;
  }
  for (const fact of candidates) {
    if (facts.length === 2) break;
    if (
      !facts.includes(fact) &&
      !facts.some(
        (selected) =>
          lineKey(selected) === lineKey(fact) &&
          (selected.follow_up?.length || selected.outlook),
      )
    )
      facts.push(fact);
  }
  const introduced = new Set();
  for (const fact of facts) {
    const key = lineKey(fact),
      context = factContext(fact);
    steps.push({
      ...visualEvidence(fact),
      context,
      title:
        {
          opponent_reply: "Possible reply",
          alternative: "Alternative move",
          played: "Played move",
          suggestion: "Suggested continuation",
        }[context] +
        " · " +
        fact.title.split(" · ").at(-1),
      text: factWords(fact, !introduced.has(key)),
    });
    introduced.add(key);
    for (const follow of fact.follow_up || []) {
      steps.push({
        ...visualEvidence(follow),
        context: "continuation",
        text: follow.text,
      });
    }
    if (fact.outlook?.steps?.length) {
      const path = fact.outlook.steps;
      steps.push({
        ...visualEvidence(path.at(-1)),
        title: fact.outlook.title,
        text: fact.outlook.text,
        context: "outlook",
        before: path[0].before,
        sequence: path,
      });
    }
  }
  return steps;
}
function stopVisualLesson() {
  const l = visualLesson;
  if (!l) return;
  lessonToken++;
  visualLesson = null;
  Object.assign(boards[l.name], l.saved, {
    narrating: false,
    explicitMotion: false,
    selected: null,
  });
  const stage = $("#" + l.name + "-coach-stage");
  stage.classList.remove("coaching");
  stage.querySelector(".coach-stage-content").inert =
    stage.classList.contains("perspective");
  $("#" + l.name + "-lesson-player")?.remove();
  renderBoard(l.name);
}
function prefetchLesson(record, alive = () => true) {
  if (!voiceEnabled) return;
  const first = lessonPlan(record)[0];
  if (first) prefetchSpeech(first.text, alive);
}
function startVisualLesson(name, record, spoken = true, automatic = false) {
  if (boards[name].busy || (name === "play" && botBusy)) {
    toast(
      "Wait for this turn to finish, then listen to the visual explanation.",
    );
    return;
  }
  stopSpeech();
  // A card may have opened a preview. Lessons always return to the playable position.
  if (name === "play" && coachPreview) $("#coach-resume").click();
  if (name === "puzzle" && puzzlePreview) $("#puzzle-return").click();
  if (typeof autoReviewTimer !== "undefined") clearTimeout(autoReviewTimer);
  const steps = lessonPlan(record);
  if (!steps.length) {
    toast("Choose a reviewed move to explore.");
    return;
  }
  visualLesson = {
    name,
    record,
    steps,
    index: 0,
    saved: boardSnapshot(name),
    spoken,
    automatic,
    returnOnFinish: name === "play" || name === "puzzle",
    paused: false,
  };
  const player = element("div", "lesson-player");
  player.id = name + "-lesson-player";
  const heading = element("div", "lesson-heading");
  heading.append(
    element("span", "eyebrow", "VISUAL COACH"),
    element("span", "lesson-counter"),
  );
  const caption = element("p", "lesson-subtitle");
  caption.setAttribute("aria-live", "polite");
  const controls = element("div", "lesson-controls");
  const prev = element("button", "secondary", "←"),
    pause = element(
      "button",
      "secondary",
      spoken ? "Pause voice" : visualLesson.returnOnFinish ? "Pause" : "Listen",
    ),
    next = element("button", "secondary", "Next →"),
    close = element(
      "button",
      "primary lesson-return",
      name === "play"
        ? "Back to game"
        : name === "puzzle"
          ? "Back to practice"
          : "Back to review",
    );
  prev.setAttribute("aria-label", "Previous explanation step");
  next.setAttribute("aria-label", "Next explanation step");
  prev.onclick = () => lessonStep(visualLesson.index - 1);
  next.onclick = () => lessonStep(visualLesson.index + 1);
  pause.onclick = () => {
    if (!visualLesson.spoken) {
      if (visualLesson.returnOnFinish) {
        visualLesson.paused = !visualLesson.paused;
        pause.textContent = visualLesson.paused ? "Resume" : "Pause";
        return;
      }
      visualLesson.spoken = true;
      lessonStep(visualLesson.index);
      return;
    }
    if (!speechAudio) {
      visualLesson.paused = !visualLesson.paused;
      pause.textContent = visualLesson.paused
        ? "Resume voice"
        : "Preparing voice…";
      return;
    }
    if (speechAudio.paused) {
      visualLesson.paused = false;
      speechAudio.play().catch((e) => toast(e.message));
      pause.textContent = "Pause voice";
    } else {
      visualLesson.paused = true;
      speechAudio.pause();
      pause.textContent = "Resume voice";
    }
  };
  close.onclick = () => returnToBoard(name);
  controls.append(prev, pause, next, close);
  player.append(heading, caption, controls);
  const stage = $("#" + name + "-coach-stage");
  stage.classList.add("coaching");
  stage.querySelector(".coach-stage-content").inert = true;
  stage.append(player);
  lessonStep(0);
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && visualLesson) {
    event.preventDefault();
    returnToBoard(visualLesson.name);
  }
});
async function lessonStep(index) {
  const l = visualLesson;
  if (!l) return;
  lessonToken++;
  const token = lessonToken;
  speechAudio?.pause();
  speechAudio = null;
  l.index = Math.max(0, Math.min(index, l.steps.length - 1));
  const step = l.steps[l.index];
  const voiceReady = l.spoken
    ? coachAudio(step.text, () => token === lessonToken && visualLesson === l)
    : null;
  voiceReady?.catch(() => {});
  const player = $("#" + l.name + "-lesson-player");
  player.querySelector(".lesson-counter").textContent =
    `${l.index + 1} / ${l.steps.length}`;
  player.querySelector(".lesson-subtitle").textContent = step.text;
  const buttons = player.querySelectorAll(".lesson-controls button");
  buttons[0].disabled = l.index === 0;
  buttons[2].disabled = l.index === l.steps.length - 1;
  buttons[1].textContent = l.spoken
    ? "Preparing voice…"
    : l.returnOnFinish
      ? l.paused
        ? "Resume"
        : "Pause"
      : "Listen";
  const valid = () => token === lessonToken && visualLesson === l;
  const wait = async (ms) => {
    let left = ms,
      previous = performance.now();
    while (left > 0 && valid()) {
      await delay(40);
      const now = performance.now();
      if (!l.paused) left -= now - previous;
      previous = now;
    }
    return valid();
  };
  const advance = () => {
    if (!valid()) return;
    if (l.index < l.steps.length - 1) lessonStep(l.index + 1);
    else if (l.automatic || l.returnOnFinish) stopSpeech();
    else {
      buttons[1].textContent = "Listen again";
      speechAudio = null;
      l.spoken = false;
    }
  };
  const show = async () => {
    // Show the short engine line as one visual thought; speak only its payoff.
    if (step.sequence?.length) {
      if (boards[l.name].fen !== step.before) {
        Object.assign(boards[l.name], {
          fen: step.before,
          evidence: null,
          lastMove: null,
          arrow: null,
          hint: null,
          badge: null,
        });
        renderBoard(l.name);
        if (!(await wait(400))) return false;
      }
      player.querySelector(".lesson-subtitle").textContent =
        "Watch how the idea develops…";
      for (const move of step.sequence) {
        if (!valid()) return false;
        while (l.paused && valid()) await delay(40);
        if (!valid()) return false;
        Object.assign(boards[l.name], {
          fen: move.fen,
          evidence: null,
          lastMove: [move.uci.slice(0, 2), move.uci.slice(2, 4)],
          explicitMotion: true,
          narrating: true,
          arrow: null,
          hint: null,
          badge: null,
          selected: null,
        });
        renderBoard(l.name);
        boards[l.name].explicitMotion = false;
        const animations = animateBoardMove(
          l.name,
          move.before,
          move.fen,
          move.uci,
        );
        if (l.name === "game" && typeof reviewPlayback !== "undefined")
          reviewPlayback.animations = animations;
        if (!(await wait(600))) return false;
      }
    }
    if (
      step.before &&
      step.uci &&
      boards[l.name].fen !== step.before &&
      boards[l.name].fen !== step.fen
    ) {
      Object.assign(boards[l.name], {
        fen: step.before,
        lastMove: null,
        evidence: null,
        hint: step.uci.slice(0, 2),
        arrow: step.uci,
        badge: null,
        check: false,
      });
      renderBoard(l.name);
      player.querySelector(".lesson-subtitle").textContent =
        step.context === "alternative"
          ? "Let’s go back and compare a different move."
          : step.context === "opponent_reply"
            ? "After that move, this reply becomes possible."
            : "From this position, watch how the move leads to the idea.";
      if (!(await wait(l.name === "game" ? 450 : 650))) return false;
    }
    const beforeFen = boards[l.name].fen;
    const old = placement(boards[l.name].fen),
      now = placement(step.fen),
      candidates = [];
    for (const [from, piece] of Object.entries(old))
      if (now[from] !== piece)
        for (const [to, arrived] of Object.entries(now))
          if (arrived === piece && old[to] !== piece)
            candidates.push([from, to]);
    const movement = candidates.length === 1 ? candidates[0] : null;
    Object.assign(boards[l.name], {
      fen: step.fen,
      evidence: step,
      narrating: true,
      arrow: null,
      hint: null,
      lastMove: movement,
      selected: null,
      badge: step.badge || null,
      check: false,
      explicitMotion: true,
    });
    renderBoard(l.name);
    boards[l.name].explicitMotion = false;
    if (step.uci && beforeFen !== step.fen) {
      const animations = animateBoardMove(
        l.name,
        beforeFen,
        step.fen,
        step.uci,
      );
      if (l.name === "game" && typeof reviewPlayback !== "undefined")
        reviewPlayback.animations = animations;
      if (!(await wait(325))) return false;
    }
    player.querySelector(".lesson-subtitle").textContent = step.text;
    const id = {
      play: "coach-assessment",
      game: "review-assessment",
      puzzle: "puzzle-assessment",
    }[l.name];
    if (step.quality) assessment(id, step.quality);
    return true;
  };
  if (!(await show())) return;
  if (!l.spoken) {
    if (l.returnOnFinish || l.automatic) {
      const readingTime = Math.max(
        2400,
        Math.min(8500, step.text.split(/\s+/).length * 260),
      );
      if (await wait(readingTime)) advance();
    }
    return;
  }
  let failedVoice = false;
  const voiceFailed = (error) => {
    if (!valid() || failedVoice) return;
    failedVoice = true;
    speechAudio?.pause();
    speechAudio = null;
    player.classList.remove("speaking");
    $("#voice-toggle").classList.remove("speaking");
    l.spoken = false;
    buttons[1].textContent = "Listen";
    if (error.name === "NotAllowedError") $("#audio-unlock").hidden = false;
    else if (error.name !== "AbortError") {
      toast("Voice unavailable. You can continue with the visual explanation.");
      if (l.returnOnFinish || l.automatic)
        wait(
          Math.max(2400, Math.min(8500, step.text.split(/\s+/).length * 260)),
        ).then((ready) => {
          if (ready) advance();
        });
    }
  };
  try {
    const preparedAudio = await voiceReady;
    if (!preparedAudio || !valid()) return;
    speechAudio = preparedAudio;
    configureSpeech(speechAudio);
    speechAudio.onerror = () =>
      voiceFailed(Error("Local voice media unavailable"));
    speechAudio.onplaying = () => {
      if (valid()) {
        // Reassert this exact diagram when speech starts, including after resume.
        Object.assign(boards[l.name], {
          fen: step.fen,
          evidence: step,
          narrating: true,
          arrow: null,
          hint: null,
          badge: step.badge || null,
        });
        renderBoard(l.name);
        player.querySelector(".lesson-subtitle").textContent = step.text;
        buttons[1].textContent = "Pause voice";
        player.classList.add("speaking");
        $("#voice-toggle").classList.add("speaking");
        const nextStep = l.steps[l.index + 1];
        if (nextStep && !speechAudio.coachHasMore)
          prefetchSpeech(nextStep.text, () => visualLesson === l);
      }
    };
    speechAudio.onpause = () => {
      player.classList.remove("speaking");
      $("#voice-toggle").classList.remove("speaking");
    };
    speechAudio.onended = async () => {
      if (token !== lessonToken) return;
      player.classList.remove("speaking");
      $("#voice-toggle").classList.remove("speaking");
      if (!(await wait(l.name === "game" ? 450 : 650))) return;
      advance();
    };
    if (l.paused) buttons[1].textContent = "Resume voice";
    else await speechAudio.play();
  } catch (error) {
    voiceFailed(error);
  }
}
async function coachLessonWhenReady(record) {
  if (!shouldAutoCoach(record) || !$("#coach-enabled").checked) return;
  const session = sessionId;
  prefetchLesson(record, () => session === sessionId && lastCoach === record && !gameFinished);
  for (let i = 0; i < 200; i++) {
    if (
      !$("#coach-enabled").checked ||
      gameFinished ||
      session !== sessionId ||
      lastCoach !== record ||
      dismissedCoach === record
    )
      return;
    if (!botBusy && !boards.play.busy && !boardIsMoving("play")) {
      if ($("#play").classList.contains("active")) {
        if (voiceEnabled) autoNarrate("play", record);
        // Muted coaching leaves the live board available and explains in the panel.
      }
      return;
    }
    await delay(100);
  }
}
function readCurrentReview(spoken = true) {
  const m = currentReview?.moves[replayPly - 1];
  if (m) startVisualLesson("game", m, spoken);
  else toast("Select a move first.");
}
$("#review-speak").onclick = () => readCurrentReview(true);
$("#review-lesson").onclick = () => readCurrentReview(false);
$("#coach-speak").onclick = () => {
  if (!lastCoach || botBusy || boards.play.busy) return;
  showCoachFeedback(lastCoach, true);
  startVisualLesson("play", lastCoach, voiceEnabled);
};
$("#puzzle-listen").onclick = async () => {
  if (!activeDrill || boards.puzzle.busy) return;
  if (!puzzleSolved && !activeDrill.helped) {
    await drillHelp(false);
  }
  startVisualLesson(
    "puzzle",
    puzzleLessonRecord || { evidence: activeDrill.evidence },
    true,
  );
};
function hidePredictionCard() {
  $("#prediction-card").hidden = true;
  const stage = $("#puzzle-coach-stage");
  stage.classList.remove("predicting");
  stage.querySelector(".coach-stage-content").inert =
    stage.classList.contains("coaching");
}
function cancelPrediction() {
  const resolve = pendingPrediction;
  pendingPrediction = null;
  if (resolve) stopSpeech();
  hidePredictionCard();
  resolve?.();
  renderBoard("puzzle");
}
async function predictReply(result) {
  if (
    !dailyMode ||
    !$("#predict-replies").checked ||
    result.turns !== 1 ||
    !result.reply_step
  )
    return;
  const version = puzzleVersion;
  const card = $("#prediction-card");
  card.replaceChildren();
  card.hidden = false;
  const stage = $("#puzzle-coach-stage");
  stage.classList.add("predicting");
  stage.querySelector(".coach-stage-content").inert = true;
  $("#puzzle-turn").textContent = "Predict the reply";
  $("#puzzle-board-title").textContent = "Your move is correct";
  card.append(
    element("span", "eyebrow", "BEFORE YOUR OPPONENT MOVES"),
    element("h4", "", "Which reply would you investigate first?"),
    element(
      "p",
      "fine",
      "Choose a candidate, then compare it with the engine’s continuation.",
    ),
  );
  const options = element("div", "prediction-options");
  await new Promise((resolve) => {
    pendingPrediction = resolve;
    for (const choice of result.reply_choices || []) {
      const button = element("button", "secondary", choice.san);
      const preview = () => {
        boards.puzzle.arrow = choice.uci;
        boards.puzzle.hint = choice.uci.slice(0, 2);
        renderBoard("puzzle");
      };
      button.onmouseenter = button.onfocus = preview;
      button.onclick = () => {
        card.querySelectorAll("button").forEach((b) => (b.disabled = true));
        card.append(
          element(
            "p",
            "prediction-feedback",
            choice.uci === result.reply_step.uci
              ? "That matches the engine’s choice. Now look for your response."
              : `Compare that with ${result.reply_step.san}, the reply the engine prioritizes here.`,
          ),
        );
        pendingPrediction = null;
        stopSpeech();
        $("#puzzle-turn").textContent = "Your opponent’s reply…";
        renderBoard("puzzle");
        resolve();
      };
      options.append(button);
    }
    const show = element("button", "text-button", "Show the reply");
    show.onclick = () => {
      pendingPrediction = null;
      stopSpeech();
      $("#puzzle-turn").textContent = "Your opponent’s reply…";
      renderBoard("puzzle");
      resolve();
    };
    card.append(options, show);
    message(
      "puzzle",
      "Your move is correct. Predict a reply, or choose Show reply to continue.",
    );
    renderBoard("puzzle");
    if (voiceEnabled)
      speakText(
        "Good move. What would your opponent play? Choose a reply, or select Show reply to continue.",
      );
  });
  await delay(650);
  if (version !== puzzleVersion) return;
  hidePredictionCard();
  renderBoard("puzzle");
}
function showReflection(question) {
  const card = $("#reflection-card");
  card.replaceChildren();
  card.hidden = !question;
  if (!question) return;
  card.append(
    element("span", "eyebrow", "MAKE THE IDEA YOURS"),
    element("h4", "", question.question),
    element(
      "p",
      "fine",
      "Recall the rule before moving on. You can revisit the visual explanation above.",
    ),
  );
  const session = activeDrill.session,
    version = puzzleVersion;
  for (const answer of question.options) {
    const button = element("button", "reflection-option", answer);
    button.onclick = async () => {
      card.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        const result = await api(`drills/${session}/reflection`, { answer });
        if (version !== puzzleVersion) return;
        button.classList.add(result.correct ? "correct" : "incorrect");
        card.append(
          element(
            "p",
            "reflection-feedback",
            (result.correct
              ? "Exactly. "
              : "Try this rule: " + result.answer + ". ") + result.explanation,
          ),
        );
        const visual = element(
          "button",
          "text-button",
          "See the idea on the board ↗",
        );
        visual.onclick = () =>
          startVisualLesson("puzzle", puzzleLessonRecord, false);
        card.append(visual);
        await refreshPractice(true);
      } catch (e) {
        toast(e.message);
        card.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    };
    card.append(button);
  }
}
