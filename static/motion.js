// Infer a single board transition, including captures, promotion and castling.
// UI-only redraws keep the same piece nodes, so running animations survive.
function boardTransition(before, after) {
  if (!before || before === after) return null;
  const old = placement(before),
    next = placement(after);
  const left = Object.keys(old).filter((s) => old[s] !== next[s]);
  const arrived = Object.keys(next).filter((s) => next[s] !== old[s]);
  if (arrived.length === 2 && left.length === 2) {
    const king = arrived.find((s) => next[s].toLowerCase() === "k");
    const origin = left.find((s) => old[s] === next[king]);
    if (
      king &&
      origin &&
      king[1] === origin[1] &&
      Math.abs(king.charCodeAt(0) - origin.charCodeAt(0)) === 2
    ) {
      const rook = arrived.find((s) => s !== king);
      if (next[rook] === (next[king] === "K" ? "R" : "r")) return origin + king;
    }
  }
  // Undoing a capture restores the captured piece as well as moving ours back.
  if (arrived.length === 2 && left.length === 1) {
    const from = left[0],
      was = old[from];
    const destinations = arrived.filter((to) => {
      const piece = next[to];
      return (
        was === piece ||
        ((was.toUpperCase() === was) === (piece.toUpperCase() === piece) &&
          piece.toLowerCase() === "p" &&
          /[18]/.test(from[1]))
      );
    });
    if (destinations.length === 1) return from + destinations[0];
  }
  if (arrived.length !== 1 || left.length > 2) return null;
  const to = arrived[0],
    piece = next[to];
  const origins = left.filter((from) => {
    const was = old[from];
    if (was === piece) return true;
    const sameColor =
      (was === was.toUpperCase()) === (piece === piece.toUpperCase());
    return (
      sameColor &&
      ((was.toLowerCase() === "p" && /[18]/.test(to[1])) ||
        (piece.toLowerCase() === "p" && /[18]/.test(from[1])))
    );
  });
  return origins.length === 1 ? origins[0] + to : null;
}
function animateBoardMove(
  name,
  before,
  after,
  uci,
  reverse = false,
  duration = 280,
) {
  if (
    !uci ||
    before === after ||
    document.documentElement.dataset.motion === "reduced"
  )
    return [];
  const root = $("#" + name + "-board"),
    map = placement(before),
    next = placement(after);
  let from = uci.slice(0, 2),
    to = uci.slice(2, 4);
  const king = (map[reverse ? to : from] || "").toLowerCase() === "k";
  const pairs = [[reverse ? to : from, reverse ? from : to]];
  if (king && Math.abs(from.charCodeAt(0) - to.charCodeAt(0)) === 2) {
    const rook = map[pairs[0][0]] === "K" ? "R" : "r";
    const a = Object.keys(map).find((s) => map[s] === rook && next[s] !== rook),
      b = Object.keys(next).find((s) => next[s] === rook && map[s] !== rook);
    if (a && b) pairs.push([a, b]);
  }
  const size = root.getBoundingClientRect().width / 8,
    result = [];
  for (const [origin, target] of pairs) {
    const piece = root.querySelector(`[data-square="${target}"] .piece`);
    if (!piece) continue;
    const [x, y] = coordinates(origin, boards[name].flip),
      [tx, ty] = coordinates(target, boards[name].flip);
    piece.parentElement.style.zIndex = "4";
    const animation = piece.animate(
      [
        { transform: `translate(${(x - tx) * size}px,${(y - ty) * size}px)` },
        { transform: "translate(0,-1px)" },
      ],
      { duration, easing: "cubic-bezier(.25,.7,.25,1)" },
    );
    animation.finished
      .then(() => {
        if (piece.parentElement) piece.parentElement.style.zIndex = "";
      })
      .catch(() => {});
    result.push(animation);
  }
  return result;
}
function boardIsMoving(name) {
  return $("#" + name + "-board")
    .getAnimations({ subtree: true })
    .some(
      (a) =>
        a.effect?.target?.classList.contains("piece") &&
        a.playState === "running",
    );
}
