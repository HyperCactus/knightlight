const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const pieces = {
  K: "♔",
  Q: "♕",
  R: "♖",
  B: "♗",
  N: "♘",
  P: "♙",
  k: "♚",
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
  p: "♟",
};
const pieceNames = {
  k: "king",
  q: "queen",
  r: "rook",
  b: "bishop",
  n: "knight",
  p: "pawn",
};
const $ = (s) => document.querySelector(s);
let data,
  currentPuzzle,
  puzzleIndex = 0,
  puzzleSolved = false,
  hintStep = 0;
let gameIndex = 0,
  replayPly = 0,
  replayVersion = 0,
  botBusy = false,
  gameFinished = false;
let puzzleVersion = 0,
  undoFen = null;
let level = preferences.botLevel;
const boards = Object.fromEntries(
  ["puzzle", "play", "game"].map((n) => [
    n,
    {
      fen: startFen,
      legal: [],
      selected: null,
      flip: false,
      busy: false,
      lastMove: null,
      hint: null,
      arrow: null,
      wrong: null,
    },
  ]),
);
async function api(path, body) {
  const r = await fetch("/api/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    const failure = Error(
      e.error?.message || "The local service could not complete this request.",
    );
    failure.status = r.status;
    throw failure;
  }
  return r.json();
}
function placement(fen) {
  const result = {};
  fen
    .split(" ")[0]
    .split("/")
    .forEach((row, i) => {
      let file = 0;
      for (const c of row) {
        if (/\d/.test(c)) file += +c;
        else result["abcdefgh"[file++] + (8 - i)] = c;
      }
    });
  return result;
}
function coordinates(sq, flip) {
  const x = "abcdefgh".indexOf(sq[0]),
    y = 8 - Number(sq[1]);
  return flip ? [7 - x, 7 - y] : [x, y];
}
function renderBoard(name) {
  if (name === "play" && typeof syncPlayActions === "function") syncPlayActions();
  const s = boards[name],
    el = $("#" + name + "-board"),
    map = placement(s.fen);
  const boardControl = $("#" + name + "-flip");
  if (boardControl) {
    const returning =
      typeof visualLesson !== "undefined" && visualLesson?.name === name;
    const predicting = name === "puzzle" && Boolean(pendingPrediction);
    boardControl.dataset.action = predicting
      ? "reply"
      : returning
        ? "return"
        : "flip";
    boardControl.textContent = predicting
      ? "Show reply →"
      : returning
        ? name === "play"
          ? "Back to game"
          : "Back to practice"
        : "↻ Flip";
    boardControl.classList.toggle("context-return", returning || predicting);
    boardControl.setAttribute(
      "aria-label",
      predicting || returning ? boardControl.textContent : "Flip board",
    );
  }
  const previousFen = el.dataset.fen;
  el.dataset.fen = s.fen;
  const squares = new Map(
    [...el.querySelectorAll(":scope > .square")].map((node) => [
      node.dataset.square,
      node,
    ]),
  );
  el.querySelectorAll(":scope > svg").forEach((node) => node.remove());
  let squareIndex = 0;
  el.classList.toggle("is-busy", s.busy || (name === "play" && botBusy));
  el.setAttribute("aria-busy", String(s.busy));
  el.classList.toggle("narrating", Boolean(s.narrating));
  const ranks = s.flip ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const files = s.flip ? "hgfedcba" : "abcdefgh";
  for (const r of ranks)
    for (const f of files) {
      const sq = f + r,
        p = map[sq],
        button = squares.get(sq) || document.createElement("button");
      const oldPiece = button.querySelector(".piece");
      button
        .querySelectorAll(":scope > :not(.piece)")
        .forEach((node) => node.remove());
      if (!p || button.dataset.piece !== p) oldPiece?.remove();
      const keepPiece = p && button.dataset.piece === p && oldPiece;
      if (!keepPiece) button.style.zIndex = "";
      button.dataset.piece = p || "";
      const legal =
        s.selected &&
        s.legal.some(
          (m) => m.slice(0, 2) === s.selected && m.slice(2, 4) === sq,
        );
      button.type = "button";
      button.dataset.square = sq;
      button.className =
        "square " +
        (("abcdefgh".indexOf(f) + r) % 2 ? "dark" : "light") +
        (s.selected === sq ? " selected" : "") +
        (legal ? (p ? " legal capture" : " legal") : "") +
        (s.lastMove?.includes(sq) ? " last-move" : "") +
        (s.hint === sq ? " hinted" : "") +
        (s.wrong === sq ? " wrong" : "") +
        (s.evidence?.squares?.includes(sq) ? " fact-square" : "") +
        (s.evidence?.arrows?.some((a) => a.from === sq) ? " fact-source" : "") +
        (s.evidence?.arrows?.some((a) => a.to === sq && a.kind === "control")
          ? " fact-control"
          : "") +
        (s.check &&
        p?.toLowerCase() === "k" &&
        (p === p.toUpperCase()) === (s.turn === "white")
          ? " in-check"
          : "");
      button.setAttribute(
        "aria-label",
        sq +
          (p
            ? " " +
              (p === p.toUpperCase() ? "white " : "black ") +
              pieceNames[p.toLowerCase()]
            : ""),
      );
      button.setAttribute("aria-pressed", String(s.selected === sq));
      if (f === files[0]) {
        const label = document.createElement("span");
        label.className = "coord rank";
        label.textContent = r;
        button.append(label);
      }
      if (r === ranks[7]) {
        const label = document.createElement("span");
        label.className = "coord file";
        label.textContent = f;
        button.append(label);
      }
      if (p && !keepPiece) {
        const span = document.createElement("span");
        span.className =
          "piece " + (p === p.toUpperCase() ? "white-piece" : "black-piece");
        const img = document.createElement("img");
        img.src =
          "/pieces/" +
          (p === p.toUpperCase() ? "w" : "b") +
          p.toUpperCase() +
          ".svg";
        img.alt = "";
        img.draggable = false;
        span.append(img);
        button.append(span);
      }
      if (s.badge?.square === sq) {
        const badge = document.createElement("span");
        badge.className = "move-badge " + s.badge.grade;
        badge.textContent = gradeSymbol(s.badge.grade);
        button.append(badge);
      }
      if (el.children[squareIndex] !== button)
        el.insertBefore(button, el.children[squareIndex] || null);
      squareIndex++;
    }
  if (s.arrow) {
    const [x1, y1] = coordinates(s.arrow.slice(0, 2), s.flip),
      [x2, y2] = coordinates(s.arrow.slice(2, 4), s.flip);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 800 800");
    svg.setAttribute("class", "board-arrow");
    svg.setAttribute("aria-hidden", "true");
    const angle = Math.atan2(y2 - y1, x2 - x1),
      tx = x2 * 100 + 50,
      ty = y2 * 100 + 50;
    const bx = tx - 37 * Math.cos(angle),
      by = ty - 37 * Math.sin(angle);
    svg.innerHTML = `<path d="M${x1 * 100 + 50},${y1 * 100 + 50} L${bx},${by}"/><polygon points="${tx},${ty} ${bx - 21 * Math.sin(angle)},${by + 21 * Math.cos(angle)} ${bx + 21 * Math.sin(angle)},${by - 21 * Math.cos(angle)}"/>`;
    el.append(svg);
  }
  drawEvidenceOverlay(name);
  renderAssist(name);
  if (name !== "game" && !s.explicitMotion) {
    const move = boardTransition(previousFen, s.fen);
    if (move) animateBoardMove(name, previousFen, s.fen, move);
  }
}
async function setBoard(name, fen, valid = () => true) {
  const result = await api("board", { fen });
  if (!valid()) return null;
  applyBoard(name, result);
  return result;
}
function applyBoard(name, result) {
  Object.assign(boards[name], result, {
    selected: null,
    lastMove: null,
    hint: null,
    arrow: null,
    wrong: null,
    badge: null,
    evidence: null,
  });
  renderBoard(name);
}
function message(name, text, tone = "") {
  const el = $("#" + name + "-message");
  el.textContent = text;
  el.className = "message " + tone;
  if (name === "puzzle") updatePuzzleFeedback();
}
function canInteract(name) {
  if (name === "game")
    return (
      typeof opponentChallenge !== "undefined" &&
      opponentChallenge?.phase === "solving" &&
      !boards.game.busy &&
      !visualLesson
    );
  return (
    name !== "game" &&
    (!visualLesson || visualLesson.name !== name) &&
    !boards[name].busy &&
    !(
      name === "puzzle" &&
      (!currentPuzzle || puzzleSolved || puzzlePreview || !activeDrill)
    ) &&
    !(
      name === "play" &&
      (botBusy ||
        newGameBusy ||
        playTransition ||
        gameFinished ||
        coachPreview ||
        boards.play.turn !== "white")
    )
  );
}
async function choosePromotion(moves, turn) {
  if (moves.length === 1) return moves[0];
  const dialog = $("#promotion");
  $("#promotion-options").innerHTML = "";
  return new Promise((resolve) => {
    const close = () => {
      dialog.removeEventListener("cancel", cancel);
      dialog.close();
    };
    const cancel = (e) => {
      e.preventDefault();
      close();
      resolve(null);
    };
    dialog.addEventListener("cancel", cancel);
    for (const move of moves) {
      const b = document.createElement("button");
      b.className = "promotion-choice";
      b.textContent =
        pieces[turn === "white" ? move[4].toUpperCase() : move[4]];
      b.setAttribute("aria-label", "Promote to " + pieceNames[move[4]]);
      b.onclick = () => {
        close();
        resolve(move);
      };
      $("#promotion-options").append(b);
    }
    dialog.showModal();
  });
}
async function movePiece(name, from, to) {
  if (!canInteract(name)) return;
  if (name === "game") return playPerspectiveMove(from, to);
  const s = boards[name],
    moves = s.legal.filter(
      (m) => m.slice(0, 2) === from && m.slice(2, 4) === to,
    );
  const moveSession = sessionId,
    movePuzzleVersion = puzzleVersion;
  if (!moves.length) {
    message(
      name,
      "That square isn’t a legal move. Choose one of the marked squares.",
    );
    return;
  }
  stopSpeech();
  s.busy = true;
  try {
    const move = await choosePromotion(moves, s.turn);
    if (!move) return;
    if (name === "puzzle") {
      renderBoard(name);
      await playDrill(move);
      return;
    }
    const before = s.fen;
    const result = await api("move", {
      fen: s.fen,
      history: name === "play" ? playedMoves : [],
      from,
      to,
      promotion: move[4],
    });
    Object.assign(s, result, {
      selected: null,
      lastMove: [from, to],
      hint: null,
      arrow: null,
      badge: null,
    });
    renderBoard(name);
    playSound(
      result.check ? "check" : placement(before)[to] ? "capture" : "move",
    );
    {
      undoFen = before;
      undoMoves = playedMoves.length;
      if (!practiceStartedAt) practiceStartedAt = new Date().toISOString();
      playedMoves.push(move);
      persistBoard();
      if (!result.outcome) autoSavePractice();
      updateRatingControl();
      $("#take-back").disabled = false;
      requestCoach(before, move);
      updateOpening();
      if (!finish(result)) await botTurn();
    }
  } catch (e) {
    message(name, "Couldn’t make that move. " + e.message, "error");
  } finally {
    if (
      (name !== "play" || moveSession === sessionId) &&
      (name !== "puzzle" || movePuzzleVersion === puzzleVersion)
    ) {
      s.busy = false;
      if (name === "puzzle") updateDrillTurn();
      renderBoard(name);
    }
  }
}
function clickSquare(name, sq) {
  if (!canInteract(name)) return;
  const s = boards[name];
  if (s.selected === sq) {
    s.selected = null;
    renderBoard(name);
    return;
  }
  if (
    s.selected &&
    s.legal.some((m) => m.slice(0, 2) === s.selected && m.slice(2, 4) === sq)
  ) {
    movePiece(name, s.selected, sq);
    return;
  }
  if (s.legal.some((m) => m.slice(0, 2) === sq)) {
    s.selected = sq;
    renderBoard(name);
  } else if (s.selected)
    message(name, "Choose a marked square to move, or select another piece.");
}
// Pointer events support mouse dragging and touch without relying on browser-native image dragging.
for (const name of ["puzzle", "play", "game"]) {
  const el = $("#" + name + "-board");
  let drag = null;
  el.addEventListener("pointerdown", (e) => {
    unlockAudio();
    if (e.button !== 0 || !canInteract(name)) return;
    const square = e.target.closest("[data-square]");
    if (!square) return;
    drag = {
      sq: square.dataset.square,
      x: e.clientX,
      y: e.clientY,
      id: e.pointerId,
      moved: false,
      ghost: null,
    };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 7) {
      const s = boards[name];
      if (!s.legal.some((m) => m.startsWith(drag.sq))) {
        drag = null;
        return;
      }
      drag.moved = true;
      s.selected = drag.sq;
      renderBoard(name);
      const piece = el.querySelector(`[data-square="${drag.sq}"] .piece`);
      drag.ghost = piece.cloneNode(true);
      drag.ghost.classList.add("drag-ghost");
      drag.ghost.style.fontSize = getComputedStyle(piece).fontSize;
      drag.ghost.style.width = piece.getBoundingClientRect().width + "px";
      drag.ghost.style.height = piece.getBoundingClientRect().height + "px";
      document.body.append(drag.ghost);
      piece.classList.add("drag-origin");
    }
    if (drag?.ghost) {
      drag.ghost.style.left = e.clientX + "px";
      drag.ghost.style.top = e.clientY + "px";
    }
  });
  el.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.ghost?.remove();
    el.querySelector(".drag-origin")?.classList.remove("drag-origin");
    if (el.hasPointerCapture(e.pointerId))
      el.releasePointerCapture(e.pointerId);
    if (d.moved) {
      const to = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest("[data-square]");
      if (to && el.contains(to) && to.dataset.square !== d.sq)
        movePiece(name, d.sq, to.dataset.square);
    } else clickSquare(name, d.sq);
  });
  el.addEventListener("pointercancel", () => {
    drag?.ghost?.remove();
    drag = null;
    renderBoard(name);
  });
  el.addEventListener("click", (e) => {
    if (e.detail === 0) {
      const sq = e.target.closest("[data-square]");
      if (sq) clickSquare(name, sq.dataset.square);
    }
  });
  el.addEventListener("dragstart", (e) => e.preventDefault());
}
let botRequestId = 0;
async function botTurn() {
  const request = ++botRequestId,
    session = sessionId;
  const stale = () =>
    request !== botRequestId || session !== sessionId || gameFinished;
  botBusy = true;
  $("#new-game").disabled = true;
  $("#take-back").disabled = true;
  $("#play-turn").textContent = "Your opponent is thinking…";
  $("#thinking-indicator").hidden = false;
  renderBoard("play");
  const s = boards.play;
  try {
    const start = performance.now();
    const body = {
      fen: s.fen,
      style: $("#play-style").value,
      moves: playedMoves,
      session_id: sessionId,
    };
    if (gameOpponentRating !== null) body.rating = gameOpponentRating;
    else if ($("#difficulty").value === "manual")
      body.rating = Number($("#bot-rating").value);
    // The server chooses adaptive strength for a new game. An older profile
    // response must not overwrite the calibration from the last result.
    if (body.rating !== undefined) gameOpponentRating = body.rating;
    const reply = await api("bot", body),
      m = reply.move;
    if (stale()) return;
    gameOpponentRating = reply.rating;
    $("#opponent-source").textContent =
      reply.source + " · " + reply.inference_ms + " ms inference";
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(
          0,
          botPause() + Math.random() * 450 - (performance.now() - start),
        ),
      ),
    );
    if (stale()) return;
    const result = await api("move", {
      fen: s.fen,
      history: playedMoves,
      from: m.slice(0, 2),
      to: m.slice(2, 4),
      promotion: m[4],
    });
    const before = s.fen;
    if (stale()) return;
    playedMoves.push(m);
    Object.assign(s, result, {
      lastMove: [m.slice(0, 2), m.slice(2, 4)],
      badge:
        $("#coach-enabled").checked &&
        lastCoach?.uci === playedMoves[playedMoves.length - 2]
          ? { square: lastCoach.uci.slice(2, 4), grade: lastCoach.grade }
          : null,
    });
    renderBoard("play");
    playSound(
      result.check
        ? "check"
        : placement(before)[m.slice(2, 4)]
          ? "capture"
          : "move",
    );
    $("#bot-style-label").textContent =
      reply.style[0].toUpperCase() +
      reply.style.slice(1) +
      " play" +
      (reply.book ? " · opening reference" : "");
    $("#bot-level").textContent =
      ($("#difficulty").value === "auto" ? "ADAPTIVE" : "MANUAL") +
      " · " +
      reply.rating.toLocaleString();
    if (!finish(result)) {
      if (!$("#coach-enabled").checked)
        message("play", "Your turn. Click or drag a piece.");
      $("#play-turn").textContent = "White to move · You";
    }
    updateOpening();
    persistBoard();
    if (!gameFinished) autoSavePractice();
  } catch (e) {
    if (stale()) return;
    message(
      "play",
      "The bot couldn’t reply. Use “Take back” to retry.",
      "error",
    );
  } finally {
    if (request !== botRequestId || session !== sessionId) return;
    botBusy = false;
    $("#thinking-indicator").hidden = true;
    $("#new-game").disabled = false;
    $("#take-back").disabled = !undoFen;
    renderBoard("play");
  }
}
function finish(result) {
  if (!result.outcome) return false;
  if (gameFinished && completedGame?.session === sessionId) return true;
  const outcome = result.outcome;
  botRequestId++;
  botBusy = false;
  boards.play.busy = false;
  $("#thinking-indicator").hidden = true;
  stopSpeech();
  if (coachPreview) {
    Object.assign(boards.play, coachPreview);
    coachPreview = null;
  }
  boards.play.outcome = outcome;
  const completed = (completedGame = { session: sessionId, outcome });
  gameFinished = true;
  coachRequestId++;
  $("#play-turn").textContent = "Game over";
  message("play", outcome, "success");
  $("#coach-resume").hidden = true;
  $("#new-game").disabled = $("#review-current").disabled = false;
  $("#resign-game").disabled =
    $("#coach-hint").disabled =
    $("#coach-best").disabled =
      true;
  showGameResult(completed);
  localStorage.removeItem("chess-active-game");
  savePractice()
    .then((index) => {
      if (completedGame !== completed) return;
      loadGameSummary(completed, index);
      profileAt = 0;
      refreshProfile();
    })
    .catch((e) => {
      if (completedGame === completed)
        $("#game-result-status").textContent =
          "Could not save the game. Use Review this game to try again.";
      toast(e.message);
    });
  return true;
}

function navigate(page) {
  if (!document.querySelector("#" + page)?.classList.contains("page")) return;
  document.documentElement.dataset.view = page;
  if (page !== "games" && typeof stopReviewPlayback === "function")
    stopReviewPlayback();
  window.scrollTo({ top: 0, behavior: "instant" });
  document
    .querySelectorAll(".page,.nav")
    .forEach((e) => e.classList.remove("active"));
  $("#" + page).classList.add("active");
  document.querySelector(`[data-page="${page}"]`).classList.add("active");
  document
    .querySelectorAll(".nav")
    .forEach((e) =>
      e.setAttribute(
        "aria-current",
        e.dataset.page === page ? "page" : "false",
      ),
    );
  stopSpeech();
  if (page !== "puzzles") cancelPrediction();
  if (page === "puzzles") {
    refreshPractice();
    if (typeof announcePuzzle === "function") announcePuzzle();
  }
  if (page === "games") {
    poll(); // Include games imported from another window since the last visit.
    replay();
  }
  $("#title").textContent = {
    overview: "Your next good move.",
    puzzles: "The training room.",
    play: "Time to play.",
    games: "Your games, collected.",
    settings: "Make it yours.",
  }[page];
}
document
  .querySelectorAll(".nav")
  .forEach((b) => (b.onclick = () => navigate(b.dataset.page)));
$(".brand").addEventListener("click", (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate("overview");
});
$("#hero-puzzles").onclick = () => navigate("puzzles");
$("#overview-games").onclick = () => navigate("games");
async function showPuzzle() {
  if (boards.puzzle.busy) return;
  await refreshPractice(true);
  const ids = filteredIds();
  if (ids.length) await startPosition(ids[0]);
  else {
    $("#puzzle-theme").textContent = "Fresh positions complete";
    $("#puzzle-detail").textContent =
      "Choose another focus, or use Review learned positions to revisit a pattern.";
    message("puzzle", "No unseen positions remain in this focus.");
    $("#hint").disabled = $("#solution").disabled = true;
  }
}
$("#next-puzzle").onclick = () => nextTrainingPosition();
$("#hint").onclick = () => drillHelp(false);
$("#solution").onclick = () => drillHelp(true);
for (const n of ["puzzle", "play"])
  $("#" + n + "-flip").onclick = () => {
    if (n === "puzzle" && pendingPrediction) {
      cancelPrediction();
      return;
    }
    if (visualLesson?.name === n) {
      returnToBoard(n);
      return;
    }
    boards[n].flip = !boards[n].flip;
    renderBoard(n);
  };
$("#new-game").onclick = () => newPractice();
$("#take-back").onclick = async () => {
  if (botBusy || boards.play.busy || playTransition || !undoFen) return;
  const transition = beginPlayTransition();
  if (!transition) return;
  stopSpeech();
  coachRequestId++;
  let restored = false;
  try {
    const position = await api("board", { fen: undoFen });
    if (playTransition !== transition || sessionId !== transition.session)
      return;
    if (gameFinished) {
      sessionId = crypto.randomUUID();
      practiceStartedAt = new Date().toISOString();
      completedGame = null;
      $("#game-result").hidden = true;
    }
    applyBoard("play", position);
    playedMoves = playedMoves.slice(0, undoMoves);
    undoFen = null;
    gameFinished = false;
    lastCoach = null;
    updateOpening();
    persistBoard();
    message("play", "Move taken back. Try another idea.");
    $("#play-turn").textContent = "White to move · You";
    restored = true;
  } catch (error) {
    toast("Could not take back the move. " + error.message);
  } finally {
    endPlayTransition(transition);
    if (restored) {
      $("#take-back").disabled =
        $("#coach-speak").disabled =
        $("#coach-best").disabled =
          true;
      $("#resign-game").disabled = $("#coach-hint").disabled = false;
    }
  }
};
async function legacyReplay() {
  const version = ++replayVersion,
    g = data.games[gameIndex],
    ply = replayPly;
  $("#prev-move").disabled = ply === 0;
  $("#next-move").disabled = ply === g.moves.length;
  let result = await api("board", { fen: startFen });
  for (let i = 0; i < ply; i++) {
    const m = g.moves[i];
    result = await api("move", {
      fen: result.fen,
      from: m.slice(0, 2),
      to: m.slice(2, 4),
      promotion: m[4],
    });
    if (version !== replayVersion) return;
  }
  if (version !== replayVersion) return;
  const m = g.moves[ply - 1];
  Object.assign(boards.game, result, {
    lastMove: m ? [m.slice(0, 2), m.slice(2, 4)] : null,
  });
  renderBoard("game");
  $("#replay-label").textContent =
    `Move ${Math.ceil(ply / 2)} / ${Math.ceil(g.moves.length / 2)}`;
  document
    .querySelectorAll(".game-row")
    .forEach(e => e.classList.toggle("current-game", Number(e.dataset.gameIndex) === gameIndex));
}
$("#prev-move").onclick = () => {
  if (data && replayPly > 0) {
    replayPly--;
    replay();
  }
};
$("#next-move").onclick = () => {
  if (data && replayPly < data.games[gameIndex].moves.length) {
    replayPly++;
    replay();
  }
};
let libraryDataVersion = 0;
function update(d) {
  libraryDataVersion++;
  const first = !data;
  data = d;
  $("#username").textContent = d.player;
  $("#stat-games").textContent = d.games.length;
  let w = 0,
    l = 0,
    dr = 0;
  for (const g of d.games) {
    if (g.result === "1/2-1/2") dr++;
    else if (
      (g.white === d.player && g.result === "1-0") ||
      (g.black === d.player && g.result === "0-1")
    )
      w++;
    else if (g.result === "1-0" || g.result === "0-1") l++;
  }
  $("#stat-record").textContent = `${w} / ${dr} / ${l}`;
  $("#stat-puzzles").textContent = d.puzzles.filter(
    (p) => p.source !== "lichess",
  ).length;
  $("#analysis-status").textContent = d.error
    ? "Analysis error: " + d.error
    : d.ready
      ? "Analysis complete"
      : `Analyzing games ${d.progress} / ${d.total}…`;
  $("#game-count").textContent = d.games.length + " GAMES";
  const counts = {};
  d.puzzles
    .filter((p) => p.game !== null)
    .forEach((p) => (counts[p.theme] = (counts[p.theme] || 0) + 1));
  const ordered = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (ordered.length)
    $("#insight-text").textContent =
      `Start with ${ordered[0][0].toLowerCase()}: ${ordered[0][1]} positions from your games are ready to practice. Select a piece to see its legal moves, or ask for a visual hint when you get stuck.`;
  if (first) {
    d.games.forEach((g, i) => {
      const b = document.createElement("button");
      b.className = "game-row";
      b.dataset.gameIndex = String(i);
      b.textContent = `${g.white} vs ${g.black}`;
      const small = document.createElement("small");
      small.textContent = `${g.date} · ${g.result} · ${g.event}`;
      b.append(small);
      b.onclick = () => {
        gameIndex = i;
        replayPly = 0;
        boards.game.flip = g.black === d.player;
        replay();
      };
      $("#game-list").append(b);
    });
    if (d.games.length) replay();
  }
  if (!currentPuzzle && d.puzzles.length) showPuzzle();
  syncLibrary();
  refreshProfile();
  refreshPractice();
}
let pollTimer = null,
  pollInFlight = false;
async function poll() {
  if (pollInFlight) return;
  clearTimeout(pollTimer);
  pollInFlight = true;
  const version = libraryDataVersion;
  try {
    const r = await fetch("/api/data");
    if (!r.ok) throw Error();
    const d = await r.json();
    // A successful import or autosave may have installed a newer library while
    // this older response was downloading. Never remove those newer games.
    if (version !== libraryDataVersion) {
      pollTimer = setTimeout(poll, 250);
      return;
    }
    update(d);
    if (!d.ready && !d.error) pollTimer = setTimeout(poll, 2500);
  } catch (e) {
    $("#analysis-status").textContent = "Cannot connect to the local server.";
    pollTimer = setTimeout(poll, 5000);
  } finally {
    pollInFlight = false;
  }
}
$("#bot-level").textContent = "ADAPTIVE · LEARNING YOUR LEVEL";
Promise.all(["play", "puzzle", "game"].map((n) => setBoard(n, startFen)))
  .then(async () => {
    await restoreGame();
    await poll();
  })
  .catch(() => {
    $("#analysis-status").textContent =
      "Could not load the boards. Refresh to reconnect.";
  });
