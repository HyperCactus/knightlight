// A single evidence model drives diagrams, explanations, and spoken coaching.
let puzzleLessonRecord = null;
let activeDrill = null,
  puzzlePreview = null,
  practiceData = null;
let trainingQueue = [],
  sessionCursor = 0,
  dailyMode = false,
  sessionClean = 0,
  sessionCompleted = 0;
let trainingReview = false;
const rejectedPuzzles = new Set();
const puzzleMetadata = new Map();
const practiceRequests = new Map();
let practiceFetchedAt = 0,
  practiceFetchedKey = "",
  gameOpponentRating = null;
function practiceQuery() {
  return `mode=${trainingReview ? "review" : "fresh"}&focus=${encodeURIComponent($("#training-focus").value || "all")}`;
}
let drillTranscript = [],
  puzzleSpeech = "",
  drillLoading = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function visualEvidence(fact) {
  const arrows = (fact.arrows || []).filter(
    (a) => /^[a-h][1-8]$/.test(a.from) && /^[a-h][1-8]$/.test(a.to),
  );
  return {
    ...fact,
    arrows,
    squares: [
      ...new Set([
        ...(fact.squares || []),
        ...arrows.flatMap((a) => [a.from, a.to]),
        ...(fact.text?.match(/\b[a-h][1-8]\b/g) || []),
      ]),
    ],
  };
}
// Keep move validation, retry and reply prompts visible next to the board.
// This shares the reserved board-note space with the guide and diagram key.
function updatePuzzleFeedback() {
  const feedback = $("#puzzle-board-feedback");
  if (!feedback) return;
  const caption = $("#puzzle-diagram-caption");
  const guide = feedback.parentElement.querySelector(".board-guide");
  const status = $("#puzzle-message");
  feedback.textContent = status.textContent;
  feedback.className =
    "board-feedback " + status.className.replace(/^message\s*/, "");
  feedback.hidden = !status.textContent.trim() || !caption.hidden;
  if (guide) guide.hidden = !feedback.hidden || !caption.hidden;
}
function drawEvidenceOverlay(name) {
  const boardEl = $("#" + name + "-board");
  let caption = $("#" + name + "-diagram-caption");
  if (!caption) {
    caption = element("div", "diagram-caption");
    caption.id = name + "-diagram-caption";
    const title = element("span"),
      back = element("button", "text-button", "↩ Return");
    back.onclick = () => returnToBoard(name);
    caption.append(title, back);
    const column = boardEl.closest(".board-column");
    const footer = column?.querySelector(".board-footer");
    const guide = column?.querySelector(".board-guide");
    const note = element("div", "board-note");
    (footer || boardEl.closest(".board-with-eval") || boardEl).after(note);
    if (guide) note.append(guide);
    note.append(caption);
    if (name === "puzzle") {
      const feedback = element("div", "board-feedback");
      feedback.id = "puzzle-board-feedback";
      feedback.setAttribute("role", "status");
      note.append(feedback);
    }
  }
  caption.hidden = !boards[name].evidence;
  const guide = caption.parentElement.querySelector(".board-guide");
  if (guide) guide.hidden = !caption.hidden;
  caption.lastChild.hidden = visualLesson?.name === name;
  if (name === "puzzle") updatePuzzleFeedback();
  const fact = boards[name].evidence;
  caption.firstChild.textContent =
    (fact?.title || "") +
    (fact?.arrows?.length
      ? fact.arrows.some((a) => a.kind === "control")
        ? " · Teal: controlled squares"
        : fact.arrows.some((a) => a.kind === "support")
          ? " · Blue: defending pieces"
          : fact.arrows.some((a) => a.kind === "move")
            ? " · Arrow: move in this continuation"
            : fact.arrows.some((a) => a.kind === "capture")
              ? " · Gold: recapture"
              : " · Gold: pressure · Dashed: pin"
      : "");
  const s = boards[name],
    arrows = s.evidence?.arrows || [];
  if (!arrows.length) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 800 800");
  svg.setAttribute("class", "evidence-overlay");
  svg.setAttribute("aria-hidden", "true");
  for (const a of arrows) {
    if (!/^[a-h][1-8]$/.test(a.from) || !/^[a-h][1-8]$/.test(a.to)) continue;
    const [x1, y1] = coordinates(a.from, s.flip),
      [x2, y2] = coordinates(a.to, s.flip);
    const angle = Math.atan2(y2 - y1, x2 - x1),
      tx = x2 * 100 + 50,
      ty = y2 * 100 + 50;
    const bx = tx - 32 * Math.cos(angle),
      by = ty - 32 * Math.sin(angle);
    const g = document.createElementNS(svg.namespaceURI, "g");
    g.setAttribute(
      "class",
      a.kind === "pin"
        ? "pin-arrow"
        : a.kind === "support"
          ? "support-arrow"
          : a.kind === "move"
            ? "move-arrow"
            : a.kind === "capture"
              ? "capture-arrow"
              : a.kind === "pressure"
                ? "pressure-arrow"
                : a.kind === "check"
                  ? "check-arrow"
                  : a.kind === "control"
                    ? "control-arrow"
                    : "threat-arrow",
    );
    g.dataset.from = a.from;
    g.dataset.to = a.to;
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", `M${x1 * 100 + 50},${y1 * 100 + 50} L${bx},${by}`);
    const tip = document.createElementNS(svg.namespaceURI, "polygon");
    tip.setAttribute(
      "points",
      `${tx},${ty} ${bx - 18 * Math.sin(angle)},${by + 18 * Math.cos(angle)} ${bx + 18 * Math.sin(angle)},${by - 18 * Math.cos(angle)}`,
    );
    g.append(path, tip);
    svg.append(g);
  }
  $("#" + name + "-board").append(svg);
}
function evidenceCards(id, facts = [], name) {
  const root = $("#" + id);
  if (!root) return;
  root.replaceChildren();
  for (const raw of facts.slice(0, 3)) {
    const fact = visualEvidence(raw);
    const card = element("button", "evidence-card");
    card.type = "button";
    card.append(
      element("span", "evidence-kind", fact.title),
      element(
        "span",
        "evidence-copy",
        [fact.introduction, fact.text].filter(Boolean).join(" "),
      ),
      element("span", "evidence-action", "Show on board ↗"),
    );
    card.onclick = () => {
      if (boards[name].busy || (name === "play" && botBusy)) return;
      stopSpeech();
      if (name === "play" || name === "puzzle") {
        root
          .querySelectorAll("button")
          .forEach((b) => b.classList.toggle("active", b === card));
        startVisualLesson(name, { evidence: [fact] }, voiceEnabled);
        return;
      }
      if (name === "game") $("#review-restore").hidden = false;
      Object.assign(boards[name], {
        fen: fact.fen,
        evidence: fact,
        selected: null,
        arrow: null,
        hint: null,
        lastMove: null,
        badge: null,
        check: false,
      });
      renderBoard(name);
      if (innerWidth < 900) boardElIntoView(name);
      root
        .querySelectorAll("button")
        .forEach((b) => b.classList.toggle("active", b === card));
      if (voiceEnabled) startVisualLesson(name, { evidence: [fact] }, true);
    };
    root.append(card);
  }
}
function boardElIntoView(name) {
  $("#" + name + "-board").scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
    block: "center",
  });
}
$("#review-restore").onclick = () => renderReview();
$("#puzzle-return").onclick = () => {
  if (!puzzlePreview) return;
  Object.assign(boards.puzzle, puzzlePreview);
  puzzlePreview = null;
  $("#puzzle-return").hidden = true;
  renderBoard("puzzle");
  updateDrillTurn();
};
async function refreshPractice(force = false) {
  if (!data) return;
  const key = practiceQuery();
  if (
    !force &&
    key === practiceFetchedKey &&
    Date.now() - practiceFetchedAt < 5000
  )
    return;
  if (!practiceRequests.has(key)) {
    const request = (async () => {
      try {
        const response = await fetch(`/api/practice?${key}`);
        if (!response.ok) throw Error("Practice summary unavailable");
        const practice = await response.json();
        if (key !== practiceQuery()) return;
        practiceData = practice;
        for (const p of [...data.puzzles, ...(practiceData.candidates || [])])
          puzzleMetadata.set(p.id, p);
        if (practiceData.candidates) {
          const metadata = new Map(
            [
              ...data.puzzles.filter(
                (p) => p.game !== null || p.id === currentPuzzle?.id,
              ),
              ...practiceData.candidates,
            ].map((p) => [p.id, p]),
          );
          data.puzzles = [...metadata.values()];
        }
        practiceFetchedAt = Date.now();
        practiceFetchedKey = key;
        renderPractice();
      } catch (error) {
        console.warn(error.message);
      } finally {
        practiceRequests.delete(key);
      }
    })();
    practiceRequests.set(key, request);
  }
  await practiceRequests.get(key);
  // A focus/mode switch owns the visible queue; earlier callers await that query too.
  if (key !== practiceQuery()) await refreshPractice();
}
function renderPractice() {
  const p = practiceData;
  if (!p) return;
  if (typeof renderJourney === "function") renderJourney();
  $("#daily-headline").textContent = p.due
    ? `${Math.min(preferences.goal, p.due)} positions. One sharper instinct.`
    : "Your scheduled practice is complete.";
  $("#daily-subline").textContent = p.due
    ? `${p.pool_size?.toLocaleString() || p.due} puzzles available · ${trainingReview ? "Review learned patterns" : "Fresh positions, chosen for you"}`
    : "Explore another weakness, or return tomorrow for your next review.";
  const filter = $("#training-focus"),
    selected = filter.value;
  filter.replaceChildren(element("option", "", "All weaknesses"));
  filter.firstChild.value = "all";
  for (const t of p.themes) {
    const o = element("option", "", `${t.name} · ${t.total}`);
    o.value = t.name;
    filter.append(o);
  }
  if ([...filter.options].some((o) => o.value === selected))
    filter.value = selected;
  $("#theme-library").replaceChildren();
  for (const t of p.themes) {
    const b = element("button", "theme-tile"),
      label = element("span", "", t.name);
    const progress = element("span", "theme-progress"),
      fill = element("i");
    fill.style.width = (t.mastered / Math.max(1, t.total)) * 100 + "%";
    progress.append(fill);
    b.append(
      label,
      element("small", "", `${t.due} ready · ${t.mastered} strengthening`),
      progress,
    );
    b.onclick = () => {
      filter.value = t.name;
      beginFocus();
    };
    $("#theme-library").append(b);
  }
  const week = $("#practice-week");
  week.replaceChildren();
  const max = Math.max(5, ...p.week.map((d) => d.total));
  p.week.forEach((d, i) => {
    const col = element("div", "week-column" + (i === 6 ? " today" : ""));
    const bar = element("div", "week-bar");
    bar.style.height = Math.max(4, (d.total / max) * 68) + "px";
    const clean = element("span");
    clean.style.height = (d.total ? (d.clean / d.total) * 100 : 0) + "%";
    bar.append(clean);
    col.title = `${d.total} reviewed, ${d.clean} unaided`;
    col.append(
      element("strong", "", String(d.total)),
      bar,
      element(
        "small",
        "",
        new Date(d.day * 86400000).toLocaleDateString(undefined, {
          weekday: "short",
          timeZone: "UTC",
        }),
      ),
    );
    week.append(col);
  });
  $("#practice-streak").textContent =
    `${p.streak} day streak · ${p.total} positions reviewed · ${p.clean} without hints or retries`;
}
function filteredIds() {
  const focus = $("#training-focus").value;
  return (practiceData?.candidates || data.puzzles)
    .filter(
      (p) =>
        (focus === "all" || p.theme === focus) && !rejectedPuzzles.has(p.id),
    )
    .map((p) => p.id);
}
function updateSession() {
  const total = trainingQueue.length;
  $("#session-heading").textContent = dailyMode
    ? `Daily session · ${Math.min(sessionCursor + 1, total)} of ${total}`
    : $("#training-focus").value === "all"
      ? trainingReview
        ? "Review learned patterns"
        : "Fresh puzzles for your weaknesses"
      : $("#training-focus").value;
  $("#session-caption").textContent = dailyMode
    ? `${sessionCompleted} completed · ${sessionClean} unaided`
    : "Practice the idea, then meet the strongest reply.";
  $("#session-fill").style.width = dailyMode
    ? `${(sessionCursor / Math.max(1, total)) * 100}%`
    : "0%";
}
async function beginDaily() {
  if (boards.puzzle.busy || drillLoading) return;
  await refreshPractice(true);
  navigate("puzzles");
  trainingQueue = practiceData?.queue?.length
    ? [...practiceData.queue].slice(0, preferences.goal)
    : filteredIds().slice(0, preferences.goal);
  if (!trainingQueue.length) {
    toast("Positions will appear when analysis finishes.");
    return;
  }
  dailyMode = true;
  sessionCursor = 0;
  sessionClean = 0;
  sessionCompleted = 0;
  $("#session-complete").hidden = true;
  updateSession();
  await startPosition(trainingQueue[0]);
}
async function beginFocus() {
  if (boards.puzzle.busy || drillLoading) return;
  dailyMode = false;
  await refreshPractice(true);
  sessionCursor = 0;
  trainingQueue = filteredIds();
  $("#session-complete").hidden = true;
  updateSession();
  if (trainingQueue.length) await startPosition(trainingQueue[0]);
  else
    toast(
      trainingReview
        ? "No learned positions are due yet."
        : "No fresh puzzles in this focus. Try another weakness.",
    );
}
$("#training-review").onclick = () => {
  trainingReview = !trainingReview;
  $("#training-review").textContent = trainingReview
    ? "Back to fresh puzzles"
    : "Review learned positions";
  beginFocus();
};
$("#start-daily").onclick = beginDaily;
$("#training-daily").onclick = beginDaily;
$("#training-focus").onchange = beginFocus;
$("#practice-again").onclick = beginFocus;
function updateDrillTurn() {
  $("#puzzle-board-title").textContent = puzzleSolved
    ? "Idea explored"
    : "Your move";
  $("#puzzle-turn").textContent = puzzleSolved
    ? "Practice complete"
    : (boards.puzzle.fen.split(" ")[1] === "w" ? "White" : "Black") +
      " to move · You";
}
function renderDrillSteps() {
  const root = $("#drill-steps");
  root.replaceChildren();
  const count = activeDrill?.target_turns || 3;
  for (let i = 0; i < count; i++) {
    const done = i < (activeDrill?.turns || 0);
    const span = element(
      "span",
      "drill-step" +
        (done ? " done" : "") +
        (i === (activeDrill?.turns || 0) ? " current" : ""),
      done ? "✓" : String(i + 1),
    );
    span.title = `Your move ${i + 1}`;
    root.append(span);
    if (i < count - 1) root.append(element("i", "step-connector"));
  }
}
async function startPosition(id, replacements = 0, replay = false) {
  if (boards.puzzle.busy || drillLoading) return;
  const p = data?.puzzles.find((p) => p.id === id) || puzzleMetadata.get(id);
  if (!p) return;
  if (
    visualLesson?.name === "puzzle" ||
    $("#puzzles").classList.contains("active")
  )
    stopSpeech();
  cancelPrediction();
  puzzleLessonRecord = null;
  $("#reflection-card").hidden = true;
  $("#puzzle-assessment").replaceChildren();
  $("#reward-banner").hidden = true;
  $("#next-puzzle").textContent = "Skip position →";
  const version = ++puzzleVersion;
  drillLoading = true;
  boards.puzzle.busy = true;
  activeDrill = null;
  currentPuzzle = { ...p };
  puzzlePreview = null;
  puzzleSolved = false;
  resetPuzzleAssist();
  hintStep = 0;
  drillTranscript = [];
  $("#puzzle-return").hidden = true;
  $("#training-receipt").hidden = true;
  $("#puzzle-evidence").replaceChildren();
  $("#hint").disabled = $("#solution").disabled = true;
  $("#hint").textContent = "Get a hint";
  const g = data.games[p.game];
  $("#puzzle-theme").textContent = p.theme;
  $("#puzzle-detail").textContent = g
    ? `${g.white} vs ${g.black} · move ${Math.floor(p.ply / 2) + 1} · ${g.date}`
    : `Lichess public puzzle · ${p.rating.toLocaleString()} rating · fresh practice`;
  $("#puzzle-counter").textContent = dailyMode
    ? `POSITION ${sessionCursor + 1} / ${trainingQueue.length}`
    : "PERSONAL POSITION";
  message("puzzle", "Preparing your continuation…");
  let replace = false;
  try {
    const fresh = !trainingReview && !replay;
    const drill = await api("drills", { id, fresh });
    if (version !== puzzleVersion) return;
    activeDrill = drill;
    currentPuzzle.best = drill.best;
    Object.assign(boards.puzzle, drill.board, {
      selected: null,
      lastMove: null,
      hint: null,
      arrow: null,
      evidence: null,
      badge: null,
      flip: drill.board.turn === "black",
    });
    $("#drill-objective").textContent = drill.objective;
    $("#puzzle-board-objective").textContent = drill.objective;
    message("puzzle", "Find the best move. Then follow the idea through.");
    $("#hint").disabled = $("#solution").disabled = false;
    $("#next-puzzle").className = "secondary";
    puzzleSpeech =
      drill.objective +
      ". Take your time and look for checks, captures, and threats.";
    updateDrillTurn();
    renderDrillSteps();
    renderBoard("puzzle");
  } catch (e) {
    if (e.status === 422 || e.status === 409) {
      if (e.status === 422) rejectedPuzzles.add(id);
      replace = true;
      message("puzzle", "Finding a clearer puzzle for you…");
    } else message("puzzle", e.message, "error");
  } finally {
    if (version === puzzleVersion) {
      drillLoading = false;
      boards.puzzle.busy = false;
      renderBoard("puzzle");
      if (!replace && typeof announcePuzzle === "function") announcePuzzle();
    }
  }
  if (replace && replacements < 8 && version === puzzleVersion) {
    await refreshPractice(true);
    if (version !== puzzleVersion) return;
    const ids = filteredIds();
    const next =
      (dailyMode ? ids.find((id) => !trainingQueue.includes(id)) : ids[0]) ||
      ids[0];
    if (next) {
      if (dailyMode) trainingQueue[sessionCursor] = next;
      await startPosition(next, replacements + 1);
    }
  }
}
async function playDrill(move) {
  if (!activeDrill) return;
  const s = boards.puzzle,
    old = { ...s },
    version = puzzleVersion;
  $("#puzzle-turn").textContent = "Checking your move…";
  $("#puzzle-board-title").textContent = "Checking your move";
  message("puzzle", "Checking your idea…");
  const r = await api(`drills/${activeDrill.session}/moves`, {
    uci: move,
    revision: activeDrill.revision,
    request_id: crypto.randomUUID(),
  });
  if (version !== puzzleVersion) return;
  activeDrill = { ...activeDrill, ...r };
  puzzleLessonRecord = {
    before: old.fen,
    after: r.player_step.fen,
    uci: move,
    grade: r.assessment.grade,
    loss: r.assessment.loss,
    eval_before: r.assessment.before,
    eval_after: r.assessment.after,
    evidence: r.feedback_evidence,
  };
  if (r.complete) prefetchLesson(puzzleLessonRecord, () => version === puzzleVersion);
  assessment("puzzle-assessment", r.assessment);
  if (!r.accepted) {
    Object.assign(s, {
      fen: r.player_step.fen,
      lastMove: [move.slice(0, 2), move.slice(2, 4)],
      selected: null,
      wrong: move.slice(2, 4),
      evidence: null,
    });
    renderBoard("puzzle");
    playSound("wrong");
    message(
      "puzzle",
      "Try again — compare the reply before committing.",
      "try-again",
    );
    await delay(550);
    Object.assign(s, old, { wrong: null, selected: null });
    if (assistAfterMistake())
      message(
        "puzzle",
        "Try again. Assist is on: teal shows your control, coral shows your opponent’s.",
        "try-again",
      );
    renderBoard("puzzle");
    evidenceCards("puzzle-evidence", r.feedback_evidence, "puzzle");
    puzzleSpeech = r.explanation;
    return;
  }
  puzzleWrongStreak = 0;
  Object.assign(s, {
    fen: r.player_step.fen,
    lastMove: [move.slice(0, 2), move.slice(2, 4)],
    selected: null,
    hint: null,
    arrow: null,
    evidence: null,
  });
  renderBoard("puzzle");
  playSound("move");
  drillTranscript.push(move);
  if (r.reply_step) {
    await predictReply(r);
    if (version !== puzzleVersion) return;
    $("#puzzle-turn").textContent = "Your opponent’s reply…";
    $("#puzzle-board-title").textContent = "Opponent’s reply";
    message("puzzle", `Good idea. The strongest reply is ${r.reply_step.san}…`);
    await delay(650);
    const u = r.reply_step.uci;
    Object.assign(s, {
      fen: r.reply_step.fen,
      lastMove: [u.slice(0, 2), u.slice(2, 4)],
    });
    renderBoard("puzzle");
    playSound("move");
  }
  Object.assign(s, r.board, { evidence: null });
  currentPuzzle.best = r.best;
  hintStep = 0;
  $("#hint").textContent = "Get a hint";
  renderDrillSteps();
  renderBoard("puzzle");
  updateDrillTurn();
  puzzleSpeech = r.explanation;
  if (r.complete) {
    puzzleSolved = true;
    sessionCompleted++;
    if (r.clean) sessionClean++;
    message(
      "puzzle",
      r.clean
        ? "✓ Well played! You followed the idea through unaided."
        : "✓ Well played! A useful pattern to revisit tomorrow.",
      "success",
    );
    $("#hint").disabled = $("#solution").disabled = true;
    $("#next-puzzle").className = "primary";
    $("#next-puzzle").textContent = "Continue →";
    celebratePosition(r);
    evidenceCards("puzzle-evidence", r.feedback_evidence, "puzzle");
    $("#training-receipt").hidden = false;
    $("#training-receipt").textContent = r.clean
      ? "Pattern strengthened · your next review is scheduled"
      : "Learning in progress · scheduled for another look";
    playSound("success");
    updateDrillTurn();
    updateSession();
    await refreshPractice(true);
    showReflection(r.reflection);
    if (voiceEnabled)
      setTimeout(async () => {
        while (
          version === puzzleVersion &&
          (boardIsMoving("puzzle") || boards.puzzle.busy)
        )
          await delay(40);
        if (version === puzzleVersion && puzzleSolved && puzzleLessonRecord)
          autoNarrate("puzzle", puzzleLessonRecord);
      }, 0);
  } else {
    $("#puzzle-evidence").replaceChildren();
    message(
      "puzzle",
      `Well played. Your opponent has replied — find your next move (${r.turns}/${activeDrill.target_turns || 3}).`,
      "success",
    );
    $("#drill-objective").textContent = r.objective;
    $("#puzzle-board-objective").textContent = r.objective;
    $("#hint").disabled = $("#solution").disabled = false;
  }
}
async function drillHelp(reveal) {
  if (!activeDrill || puzzleSolved || boards.puzzle.busy || puzzlePreview)
    return;
  const version = puzzleVersion;
  boards.puzzle.busy = true;
  try {
    const r = await api(`drills/${activeDrill.session}/help`, {
      kind: reveal ? "reveal" : "hint",
    });
    if (version !== puzzleVersion) return;
    activeDrill.helped = true;
    currentPuzzle.best = r.best;
    hintStep++;
    boards.puzzle.hint = r.best.slice(0, 2);
    if (reveal || hintStep > 1) {
      boards.puzzle.arrow = r.best;
      message(
        "puzzle",
        reveal
          ? "Follow the arrow, then play the continuation. This counts as guided practice."
          : "Follow the arrow. Then consider what your opponent can do.",
      );
      evidenceCards("puzzle-evidence", r.evidence, "puzzle");
      $("#hint").disabled = true;
    } else {
      message("puzzle", "Start with the highlighted piece.");
      if (voiceEnabled)
        speakText(
          "Start with the highlighted piece. What checks, captures, or threats can it create?",
        );
      $("#hint").textContent = "Show move";
    }
    renderBoard("puzzle");
    if (voiceEnabled && (reveal || hintStep > 1))
      speakText(
        "Follow the arrow. Before you play it, consider your opponent’s strongest reply.",
      );
    if (reveal) await refreshPractice(true);
  } catch (e) {
    toast(e.message);
  } finally {
    boards.puzzle.busy = false;
    renderBoard("puzzle");
  }
}
$("#puzzle-listen").onclick = () => speakText(puzzleSpeech);
async function nextTrainingPosition() {
  // Prediction waits for a choice, not an engine request. Skip can safely end
  // that wait; invalidate its continuation before loading a different puzzle.
  if (pendingPrediction && !drillLoading) {
    puzzleVersion++;
    cancelPrediction();
    activeDrill = null;
    boards.puzzle.busy = false;
  }
  if (boards.puzzle.busy || drillLoading || !data?.puzzles.length) return;
  stopSpeech();
  puzzlePreview = null;
  if (dailyMode) {
    sessionCursor++;
    updateSession();
    if (sessionCursor >= trainingQueue.length) {
      $("#session-fill").style.width = "100%";
      $("#session-complete").hidden = false;
      $("#session-heading").textContent = "Daily session complete";
      $("#session-result").textContent =
        `${sessionCompleted} positions completed, ${sessionClean} unaided. Your next reviews are scheduled. Fresh examples will help the idea stick.`;
      $("#session-complete").scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      return;
    }
  } else {
    await refreshPractice(true);
    trainingQueue = filteredIds();
    sessionCursor = 0;
    if (!trainingQueue.length) {
      toast(
        "No new positions in this focus. Choose another weakness or review learned positions.",
      );
      return;
    }
  }
  await startPosition(trainingQueue[sessionCursor]);
}
let storyReview = null,
  storyMoves = null;
function renderStory() {
  const root = $("#review-story");
  if (!currentReview) {
    root.replaceChildren();
    storyReview = storyMoves = null;
    return;
  }
  if (storyReview !== currentReview || storyMoves !== currentReview.moves) {
    storyReview = currentReview;
    storyMoves = currentReview.moves;
    root.replaceChildren();
    const mine = currentReview.moves.filter((m) => m.player);
    const choices = mine
      .filter((m) => m.loss > 80)
      .sort((a, b) => b.loss - a.loss)
      .slice(0, 3)
      .sort((a, b) => a.ply - b.ply);
    if (!choices.length)
      choices.push(...mine.filter((m) => m.grade === "best").slice(0, 3));
    choices.forEach((m, i) => {
      const card = element("button", "story-card");
      card.dataset.ply = m.ply + 1;
      card.append(
        element(
          "span",
          "eyebrow",
          `0${i + 1} · MOVE ${Math.floor(m.ply / 2) + 1}`,
        ),
        element("strong", "", m.theme),
        element("span", "", `${m.san} · ${gradeLabels[m.grade]}`),
        element("small", "", "Explore this turning point ↗"),
      );
      card.onclick = () => seekReview(m.ply + 1);
      root.append(card);
    });
  }
  for (const card of root.children)
    card.classList.toggle("active", Number(card.dataset.ply) === replayPly);
}
$("#practice-moment").onclick = async () => {
  const m = currentReview?.moves[replayPly - 1];
  if (!m) return;
  const p = data.puzzles.find((p) => p.game === gameIndex && p.ply === m.ply);
  if (p) {
    dailyMode = false;
    trainingQueue = [p.id];
    sessionCursor = 0;
    updateSession();
    navigate("puzzles");
    await startPosition(p.id, 0, true);
  }
};
$("#bot-rating").value = preferences.botRating;
function updateRatingControl() {
  const manual = $("#difficulty").value === "manual";
  const r = manual
    ? Number($("#bot-rating").value)
    : profileData?.adaptive_rating || 1100;
  $("#bot-rating-value").textContent = r.toLocaleString();
  $("#match-settings-label").textContent =
    `${manual ? "Manual" : "Adaptive"} · ${r.toLocaleString()} rating · ${$("#coach-enabled").checked ? "coach on" : "coach off"}`;
  $("#bot-rating").disabled = !manual;
  if (!manual) $("#bot-rating").value = r;
  $("#rating-mode-note").textContent = playedMoves.length
    ? "New settings apply to your next game. This game's opponent rating is fixed."
    : manual
      ? "Choose your challenge. This is an estimated practice rating."
      : "Adaptive adjusts to your recent results and aims for a challenging opponent.";
  $("#bot-level").textContent =
    (manual ? "MANUAL" : "ADAPTIVE") +
    " · " +
    (gameOpponentRating || r).toLocaleString();
}
$("#bot-rating").oninput = () => {
  $("#difficulty").value = "manual";
  preferences.botMode = "manual";
  preferences.botRating = Number($("#bot-rating").value);
  savePreferences();
  updateRatingControl();
};
function renderRating() {
  if (!profileData) return;
  $("#practice-rating").textContent =
    profileData.practice_rating.toLocaleString();
  $("#rating-confidence").textContent =
    `${profileData.rating_samples} DATED GAMES · 14-DAY HALF-LIFE`;
  const ratings = [
    profileData.initial_rating || 1000,
    ...profileData.rating_history.map((p) => p.rating),
  ];
  const low = Math.min(...ratings) - 30,
    high = Math.max(...ratings) + 30;
  const points = ratings
    .map(
      (r, i) =>
        `${(i / Math.max(1, ratings.length - 1)) * 300},${65 - ((r - low) / (high - low)) * 55}`,
    )
    .join(" ");
  $("#rating-history").innerHTML =
    `<svg viewBox="0 0 300 75" role="img" aria-label="Practice rating trend"><path d="M0,70 H300" stroke="var(--line)"/><polyline points="${points}" stroke="var(--accent)" stroke-width="2" fill="none"/></svg>`;
  updateRatingControl();
}
function persistBoard() {
  if (!playedMoves.length) {
    localStorage.removeItem("chess-active-game");
    return;
  }
  if (gameFinished || coachPreview) return;
  localStorage.setItem(
    "chess-active-game",
    JSON.stringify({
      fen: boards.play.fen,
      moves: playedMoves,
      session: sessionId,
      rating: gameOpponentRating,
      undoFen,
      undoMoves,
      startedAt: practiceStartedAt,
    }),
  );
}
async function restoreGame() {
  try {
    const saved = JSON.parse(
      localStorage.getItem("chess-active-game") || "null",
    );
    if (!saved || !Array.isArray(saved.moves) || saved.moves.length > 600)
      return;
    await setBoard("play", saved.fen);
    playedMoves = saved.moves;
    sessionId = saved.session;
    gameOpponentRating = saved.rating;
    practiceStartedAt = saved.startedAt || new Date().toISOString();
    undoFen = saved.undoFen;
    undoMoves = saved.undoMoves;
    $("#take-back").disabled = !undoFen;
    updateRatingControl();
    updateOpening();
    if (boards.play.turn === "black") await botTurn();
  } catch (e) {
    localStorage.removeItem("chess-active-game");
  }
}
$("#resign-game").onclick = () => {
  if (
    (boards.play.busy && !botBusy) ||
    newGameBusy ||
    gameFinished ||
    !playedMoves.length
  )
    return;
  stopSpeech();
  if (coachPreview) {
    Object.assign(boards.play, coachPreview);
    coachPreview = null;
  }
  boards.play.outcome = "Black wins by resignation";
  finish(boards.play);
};
updateRatingControl();
