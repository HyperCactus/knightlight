// A review challenge owns a reversible board view, never the saved game.
let opponentChallenge = null;
const perspectivePlans = new Map(),
  perspectiveSeen = new Set();

function preparePerspectives(id) {
  if (!preferences.reviewChallenges) return Promise.resolve([]);
  const revision = () => data?.games[id]?.moves.join(" ");
  const moves = revision();
  const cached = perspectivePlans.get(id);
  if (cached && cached.moves !== moves) perspectivePlans.delete(id);
  if (!perspectivePlans.has(id)) {
    const pending = fetch(`/api/reviews/${id}/perspectives`)
      .then(async (response) => {
        if (!response.ok) throw Error("Perspective analysis unavailable");
        return (await response.json()).items || [];
      })
      .then((items) => {
        if (revision() !== moves) throw Error("The reviewed game changed");
        if (gameIndex === id && !opponentChallenge)
          updatePerspectiveAvailability(items);
        return items;
      })
      .catch(() => {
        if (perspectivePlans.get(id) === pending) perspectivePlans.delete(id);
        return [];
      });
    pending.moves = moves;
    perspectivePlans.set(id, pending);
  }
  return perspectivePlans.get(id);
}

function updatePerspectiveAvailability(items) {
  const button = $("#review-perspective");
  if (!items) {
    button.hidden = true;
    const game = gameIndex,
      moves = data?.games[game]?.moves.join(" ");
    preparePerspectives(game).then((plans) => {
      if (
        !opponentChallenge &&
        gameIndex === game &&
        moves === data?.games[game]?.moves.join(" ")
      )
        updatePerspectiveAvailability(plans);
    });
    return;
  }
  button.hidden = !items.some((p) => p.ply === replayPly);
}
function perspectiveValid(c) {
  return (
    opponentChallenge === c &&
    gameIndex === c.game &&
    $("#games").classList.contains("active")
  );
}
function perspectivePrompt(text) {
  $("#game-message").textContent = text;
}
function finishPerspective(resume = false) {
  const c = opponentChallenge;
  if (!c) return;
  opponentChallenge = null;
  stopSpeech();
  const stage = $("#game-coach-stage");
  stage.classList.remove("perspective");
  stage.querySelector(".coach-stage-content").inert = false;
  $("#perspective-card").hidden = true;
  $("#games").classList.remove("perspective-active");
  const sameGame = gameIndex === c.game;
  if (sameGame) {
    Object.assign(boards.game, c.saved, {
      flip: c.flip,
      busy: false,
      selected: null,
    });
    $("#review-title").textContent = c.title;
    $("#review-subtitle").textContent = c.subtitle;
    $("#guided-caption").textContent = c.caption;
  } else boards.game.busy = false;
  $("#review-best").textContent = c.bestLabel;
  $("#review-reply").textContent = c.replyLabel;
  if (sameGame) renderReview({ narrate: false });
  reviewPlayback.playing = Boolean(resume && c.resume && sameGame);
  updateReviewTransport(
    resume
      ? "Back to your side · follow the game"
      : "Paused · step through or press Play",
  );
  c.resolve(resume);
}
async function flipPerspective(c) {
  const board = $("#game-board");
  if (
    preferences.motion !== "reduced" &&
    document.documentElement.dataset.motion !== "reduced"
  ) {
    board.animate([{ opacity: 1 }, { opacity: 0.2 }], {
      duration: 140,
      fill: "none",
    });
    await delay(140);
  }
  if (!perspectiveValid(c)) return;
  boards.game.flip = c.item.side === "black";
  renderBoard("game");
  if (document.documentElement.dataset.motion !== "reduced")
    board.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 180 });
}
function beginPerspective(item, resume = false) {
  stopSpeech();
  if (opponentChallenge) finishPerspective(false);
  let resolve;
  const done = new Promise((r) => {
    resolve = r;
  });
  const c = {
    item,
    game: gameIndex,
    ply: replayPly,
    resume,
    resolve,
    saved: boardSnapshot("game"),
    flip: boards.game.flip,
    title: $("#review-title").textContent,
    subtitle: $("#review-subtitle").textContent,
    caption: $("#guided-caption").textContent,
    bestLabel: $("#review-best").textContent,
    replyLabel: $("#review-reply").textContent,
    phase: "preparing",
    attempts: 0,
    feedback: null,
  };
  opponentChallenge = c;
  reviewPlayback.playing = false;
  perspectiveSeen.add(`${c.game}:${item.ply}`);
  $("#games").classList.add("perspective-active");
  const stage = $("#game-coach-stage");
  stage.classList.add("perspective");
  stage.querySelector(".coach-stage-content").inert = true;
  $("#perspective-card").hidden = false;
  $("#perspective-label").textContent = "PLAY THE OTHER SIDE";
  $("#perspective-title").textContent =
    item.kind === "punish" ? "Turn the tables." : "Find their defence.";
  perspectivePrompt(item.intro);
  $("#perspective-reveal").hidden = false;
  $("#perspective-reveal").disabled = false;
  $("#perspective-continue").textContent = "Skip · continue review →";
  $("#perspective-continue").className = "secondary";
  $("#review-best").textContent = "Show response";
  $("#review-reply").textContent = "Explain response";
  $("#guided-caption").textContent =
    "Opponent’s perspective · a short challenge";
  updateReviewTransport("Preparing your opponent’s position…");
  (async () => {
    const state = await api("board", { fen: item.fen });
    if (!perspectiveValid(c)) return;
    c.root = state;
    Object.assign(boards.game, state, {
      busy: false,
      selected: null,
      arrow: null,
      hint: null,
      evidence: null,
    });
    await flipPerspective(c);
    if (!perspectiveValid(c)) return;
    c.phase = "solving";
    $("#review-title").textContent =
      `Play ${item.side === "white" ? "White" : "Black"} · opponent’s perspective`;
    $("#review-subtitle").textContent = item.objective;
    $("#replay-label").textContent =
      `Your move as ${item.side === "white" ? "White" : "Black"}`;
    updateReviewTransport(item.objective);
    if (voiceEnabled) speakText(item.intro);
  })().catch(() => {
    if (perspectiveValid(c)) finishPerspective(true);
  });
  return done;
}
async function playPerspectiveMove(from, to, reveal = false) {
  const c = opponentChallenge;
  if (!c || c.phase !== "solving" || boards.game.busy) return;
  stopSpeech();
  boards.game.busy = true;
  $("#perspective-reveal").disabled = true;
  perspectivePrompt("Checking that response…");
  renderBoard("game");
  try {
    let move;
    if (!reveal) {
      const options = boards.game.legal.filter(
        (m) => m.slice(0, 2) === from && m.slice(2, 4) === to,
      );
      if (!options.length) return;
      move = await choosePromotion(options, boards.game.turn);
      if (!perspectiveValid(c)) return;
      if (!move) {
        perspectivePrompt(c.item.objective);
        return;
      }
    }
    const result = await api(
      `reviews/${c.game}/perspectives/${c.item.ply}/moves`,
      { uci: move, reveal },
    );
    if (!perspectiveValid(c)) return;
    c.attempts++;
    const before = boards.game.fen,
      u = result.feedback.uci;
    Object.assign(boards.game, result.board, {
      lastMove: [u.slice(0, 2), u.slice(2, 4)],
      selected: null,
      arrow: null,
      hint: null,
      badge: { square: u.slice(2, 4), grade: result.feedback.grade },
      explicitMotion: true,
    });
    renderBoard("game");
    boards.game.explicitMotion = false;
    animateBoardMove("game", before, boards.game.fen, u);
    playSound(result.accepted ? "success" : "wrong");
    if (!result.accepted && !reveal) {
      perspectivePrompt(
        c.item.kind === "punish"
          ? "There is a stronger way to use the opportunity. Try another response."
          : "That response gives ground. Look for a defence that keeps the position together.",
      );
      await delay(650);
      if (!perspectiveValid(c)) return;
      Object.assign(boards.game, c.root);
      boards.game.selected = null;
      boards.game.lastMove = c.saved.lastMove;
      boards.game.badge = null;
      renderBoard("game");
      return;
    }
    c.phase = "complete";
    c.feedback = result.feedback;
    $("#perspective-label").textContent = reveal ? "THE RESPONSE" : "NICE FIND";
    $("#perspective-title").textContent =
      `${result.feedback.san} · ${reveal ? "compare the idea" : "strong response"}`;
    perspectivePrompt(result.feedback.explanation);
    $("#perspective-reveal").hidden = true;
    $("#perspective-continue").textContent = "Back to your side · continue →";
    $("#perspective-continue").className = "primary";
    updateReviewTransport("Idea explored · continue when you’re ready");
    boards.game.busy = false;
    if (voiceEnabled) startVisualLesson("game", result.feedback, true, true);
  } catch (error) {
    if (perspectiveValid(c))
      perspectivePrompt(
        "Couldn’t check that response. " +
          error.message +
          " You can retry or continue the review.",
      );
  } finally {
    if (perspectiveValid(c)) {
      boards.game.busy = false;
      $("#perspective-reveal").disabled = false;
      renderBoard("game");
    }
  }
}
$("#perspective-reveal").onclick = () => playPerspectiveMove(null, null, true);
$("#perspective-continue").onclick = () => finishPerspective(true);
$("#review-perspective").onclick = async () => {
  stopReviewPlayback();
  const game = gameIndex,
    ply = replayPly;
  const items = await preparePerspectives(game);
  if (game !== gameIndex || ply !== replayPly) return;
  const item = items.find((p) => p.ply === ply);
  if (item) beginPerspective(item);
};
for (const id of [
  "review-best",
  "review-reply",
  "review-speak",
  "review-lesson",
]) {
  const original = $("#" + id).onclick;
  $("#" + id).onclick = (event) => {
    const c = opponentChallenge;
    if (!c) return original?.(event);
    if (c.phase === "solving" && ["review-best", "review-reply"].includes(id))
      playPerspectiveMove(null, null, true);
    else if (c.feedback)
      startVisualLesson("game", c.feedback, voiceEnabled, true);
    else if (voiceEnabled) speakText(c.item.intro);
  };
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && opponentChallenge && !$("#promotion").open)
    finishPerspective(true);
});
