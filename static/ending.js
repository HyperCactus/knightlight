// One completion experience, scoped to the game that actually finished.
function syncPlayActions() {
  const newGame = $("#new-game"), takeBack = $("#take-back");
  const review = $("#review-current"), options = $("#game-options > div");
  const toolbar = review.parentElement;
  const mainAction = gameFinished ? newGame : takeBack;
  const secondaryAction = gameFinished ? takeBack : newGame;
  if (mainAction.parentElement !== toolbar) toolbar.insertBefore(mainAction, review);
  if (secondaryAction.parentElement !== options) options.prepend(secondaryAction);
  newGame.classList.toggle("primary", gameFinished);
  newGame.classList.toggle("secondary", !gameFinished);
}
function closeGameResult() {
  stopSpeech();
  $("#game-over-dialog").close();
}
function showGameResult(completed) {
  syncPlayActions();
  const verdict = completed.outcome.startsWith("White wins")
    ? "win"
    : completed.outcome.startsWith("Black wins")
      ? "loss"
      : "draw";
  completed.verdict = verdict;
  $("#game-result").dataset.verdict = verdict;
  $("#game-result").hidden = false;
  $("#game-result-symbol").textContent = { win: "♔", loss: "♞", draw: "½" }[
    verdict
  ];
  $("#game-result-label").textContent = {
    win: "VICTORY",
    loss: "GAME COMPLETE",
    draw: "HONORS SHARED",
  }[verdict];
  $("#game-result-title").textContent = {
    win: "You won!",
    loss: "A lesson for the next game",
    draw: "A hard-fought draw",
  }[verdict];
  $("#game-result-copy").textContent =
    completed.outcome
      .replace(/^White wins/, "You win")
      .replace(/^Black wins/, "Your opponent wins") + ".";
  $("#game-result-status").textContent = playedMoves.length
    ? "Saving your game and finding its turning points…"
    : "Play again whenever you’re ready.";
  $("#game-result-takeaway").hidden = true;
  $("#game-result-stats").replaceChildren();
  $("#retry-game-summary").hidden = true;
  $("#game-over-dialog").showModal();
  $("#play-again").focus({ preventScroll: true });
  playSound(
    verdict === "win"
      ? "success"
      : verdict === "loss"
        ? "game-loss"
        : "game-draw",
  );
}
async function loadGameSummary(completed, index) {
  if (index === null || completedGame !== completed) return;
  completed.index = index;
  const request = (completed.summaryRequest =
    (completed.summaryRequest || 0) + 1);
  const valid = () =>
    completedGame === completed &&
    sessionId === completed.session &&
    completed.summaryRequest === request;
  $("#retry-game-summary").hidden = true;
  try {
    for (let attempt = 0; attempt < 90 && valid(); attempt++) {
      const response = await fetch(`/api/reviews/${index}`);
      if (!valid()) return;
      if (response.status === 202) {
        await delay(1000);
        continue;
      }
      if (!response.ok) throw Error("Review is unavailable");
      const review = await response.json();
      if (!valid()) return;
      const summary = review.summary;
      if (!summary) throw Error("Summary is unavailable");
      completed.summary = summary;
      $("#game-result-copy").textContent = summary.story;
      $("#game-result-takeaway").textContent = summary.takeaway;
      $("#game-result-takeaway").hidden = false;
      $("#game-result-status").textContent =
        "Saved in your history · ready to review";
      const stats = $("#game-result-stats");
      for (const [value, label] of [
        [`${Math.round(summary.accuracy)}%`, "Move quality"],
        [summary.moves, "Moves"],
        [summary.mistakes + summary.blunders, "Mistakes & blunders"],
      ]) {
        const cell = element("div");
        cell.append(
          element("strong", "", String(value)),
          element("span", "", label),
        );
        stats.append(cell);
      }
      if (
        voiceEnabled &&
        userActivatedAudio &&
        !document.hidden &&
        $("#play").classList.contains("active") &&
        $("#game-over-dialog").open
      )
        speakText(summary.story + " " + summary.takeaway);
      return;
    }
    if (valid()) throw Error("Analysis is taking longer than usual");
  } catch {
    if (!valid()) return;
    $("#game-result-status").textContent =
      "Your game is saved. You can review it now or retry the summary.";
    $("#retry-game-summary").hidden = false;
  }
}
$("#close-game-result").onclick = $("#result-back-board").onclick =
  closeGameResult;
$("#game-over-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeGameResult();
});
$("#retry-game-summary").onclick = () => {
  if (completedGame?.index !== undefined)
    loadGameSummary(completedGame, completedGame.index);
};
$("#review-finished").onclick = () => {
  closeGameResult();
  if (completedGame?.index === undefined) {
    $("#review-current").click();
    return;
  }
  gameIndex = completedGame.index;
  replayPly = completedGame.summary?.key_ply || 0;
  currentReview = null;
  navigate("games");
  replay();
};
