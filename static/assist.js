// Rust supplies the control map. Cache by position so overlays also follow
// review diagrams and continuations, which can change FEN without a move API.
const assistMaps = new Map(),
  assistRequests = new Map();
let puzzleAutoAssist = false,
  puzzleWrongStreak = 0;

function assistKey(fen) {
  // Control depends on piece placement, not turn, castling or en-passant rights.
  return fen.split(" ")[0];
}
function assistEnabled(name) {
  return preferences.assist || (name === "puzzle" && puzzleAutoAssist);
}
function assistSide(name) {
  if (name === "puzzle")
    return currentPuzzle?.fen?.split(" ")[1] === "b" ? "black" : "white";
  if (name === "game") {
    if (typeof opponentChallenge !== "undefined" && opponentChallenge)
      return opponentChallenge.item.side;
    const game = data?.games[gameIndex];
    if (game?.black?.toLowerCase() === data?.player?.toLowerCase())
      return "black";
  }
  return "white";
}
function cacheAssist(map) {
  assistMaps.set(assistKey(map.position), map);
  if (assistMaps.size > 256) assistMaps.delete(assistMaps.keys().next().value);
}
function renderAssist(name) {
  const state = boards[name],
    board = $("#" + name + "-board");
  const button = $("#" + name + "-assist");
  if (!button) return;
  const enabled = assistEnabled(name),
    key = assistKey(state.fen);
  button.setAttribute("aria-pressed", String(enabled));
  button.textContent = enabled ? "◉ Assist on" : "◎ Assist off";
  button.setAttribute(
    "aria-label",
    enabled ? "Turn assist mode off" : "Turn assist mode on",
  );
  button.closest(".assist-toolbar").classList.toggle("active", enabled);
  if (state.threats && assistKey(state.threats.position) === key)
    cacheAssist(state.threats);
  const map = enabled && assistMaps.get(key);
  const us = assistSide(name),
    them = us === "white" ? "black" : "white";
  const ours = new Set(map?.[us] || []),
    theirs = new Set(map?.[them] || []);
  for (const square of board.querySelectorAll(":scope > .square")) {
    const sq = square.dataset.square;
    const own = ours.has(sq),
      opponent = theirs.has(sq);
    const kind =
      own && opponent ? "both" : own ? "you" : opponent ? "opponent" : "";
    if (kind) square.dataset.assist = kind;
    else delete square.dataset.assist;
    const label = square
      .getAttribute("aria-label")
      .split("; controlled by ")[0];
    square.setAttribute(
      "aria-label",
      label +
        (kind
          ? "; controlled by " +
            (kind === "both"
              ? "both sides"
              : kind === "you"
                ? "your pieces"
                : "opponent pieces")
          : ""),
    );
  }
  board.dataset.assistStatus = !enabled ? "off" : map ? "ready" : "loading";
  if (map) board.dataset.assistFen = key;
  else delete board.dataset.assistFen;
  if (!enabled || map || assistRequests.has(key)) return;
  const request = api("board", { fen: state.fen })
    .then((result) => {
      if (!result.threats) throw Error("Control map unavailable");
      cacheAssist(result.threats);
      assistRequests.delete(key);
      // Applying a map never changes a position, turn, selection or request lock.
      for (const target of ["puzzle", "play", "game"])
        if (assistKey(boards[target].fen) === key) renderAssist(target);
    })
    .catch(() => {
      assistRequests.delete(key);
      for (const target of ["puzzle", "play", "game"])
        if (assistEnabled(target) && assistKey(boards[target].fen) === key)
          $("#" + target + "-board").dataset.assistStatus = "error";
    });
  assistRequests.set(key, request);
}
function syncAssist() {
  for (const name of ["puzzle", "play", "game"]) renderAssist(name);
}
function resetPuzzleAssist() {
  puzzleAutoAssist = false;
  puzzleWrongStreak = 0;
  renderAssist("puzzle");
}
function assistAfterMistake() {
  puzzleWrongStreak++;
  if (puzzleWrongStreak !== 3 || assistEnabled("puzzle")) return false;
  puzzleAutoAssist = true;
  renderAssist("puzzle");
  return true;
}
for (const name of ["puzzle", "play", "game"])
  document
    .querySelector("#" + name + "-assist")
    .addEventListener("click", () =>
      changePreference("assist", !assistEnabled(name)),
    );
