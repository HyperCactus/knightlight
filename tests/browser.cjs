const { chromium, devices } = require("playwright");
const assert = require("node:assert/strict");
const url = process.env.CHESS_TEST_URL || "http://127.0.0.1:3000";
async function drag(page, name, from, to) {
  await page.locator(`#${name}-board`).scrollIntoViewIfNeeded();
  const a = await page
    .locator(`#${name}-board [data-square="${from}"]`)
    .boundingBox();
  const b = await page
    .locator(`#${name}-board [data-square="${to}"]`)
    .boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}
(async () => {
  const browser = await chromium.launch({
    args: ["--mute-audio"],
    headless: true,
    ...(process.env.CHESS_TEST_BROWSER
      ? { executablePath: process.env.CHESS_TEST_BROWSER }
      : {}),
  });
  try {
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(() => Boolean(currentPuzzle));
    await page.evaluate(() => {
      window.pieceMotions = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        const a = animate.apply(this, args);
        if (this.classList.contains("piece")) {
          const item = {
            board: this.closest(".board")?.id,
            square: this.parentElement.dataset.square,
            duration: a.effect.getTiming().duration,
            finished: false,
            connected: false,
          };
          pieceMotions.push(item);
          a.finished
            .then(() => {
              item.finished = true;
              item.connected = this.isConnected;
            })
            .catch(() => {});
        }
        return a;
      };
    });
    await page.locator('[data-page="play"]').click();
    await page.locator('#play-board [data-square="e2"]').click();
    assert.deepEqual(
      await page
        .locator("#play-board .legal")
        .evaluateAll((es) => es.map((e) => e.dataset.square).sort()),
      ["e3", "e4"],
    );
    await page.locator('#play-board [data-square="e4"]').click();
    await page.waitForFunction(
      () => !botBusy && !boards.play.busy && boards.play.fen !== startFen,
    );
    assert.equal(
      await page.evaluate(
        () =>
          placement(
            visualLesson?.name === "play"
              ? visualLesson.saved.fen
              : boards.play.fen,
          ).e4,
      ),
      "P",
    );
    assert.equal(await page.locator("#play-board .last-move").count(), 2);
    await page.waitForFunction(
      () =>
        pieceMotions.length >= 2 &&
        pieceMotions.slice(0, 2).every((m) => m.finished),
    );
    const openingMotions = await page.evaluate(() => pieceMotions.slice(0, 2));
    assert.equal(openingMotions[0].square, "e4");
    assert(
      openingMotions.every((m) => m.duration === 280 && m.connected),
      "Both sides' moves must finish on connected pieces despite UI redraws",
    );
    console.log(
      "PASS player and opponent movements animate fully through state and coach redraws",
    );
    console.log("PASS click-to-move, legal targets, bot reply, last move");
    await page.locator("#take-back").click();
    await page.waitForFunction(() => boards.play.fen === startFen);
    await drag(page, "play", "d2", "d4");
    await page.waitForFunction(
      () => !botBusy && !boards.play.busy && boards.play.fen !== startFen,
    );
    assert.equal(
      await page.evaluate(
        () =>
          placement(
            visualLesson?.name === "play"
              ? visualLesson.saved.fen
              : boards.play.fen,
          ).d4,
      ),
      "P",
    );
    console.log("PASS take back and mouse drag");
    await page.locator('[data-page="puzzles"]').click();
    await page.locator("#hint").click();
    await page.waitForFunction(() => !boards.puzzle.busy);
    assert.equal(
      await page.locator("#puzzle-board .hinted").getAttribute("data-square"),
      await page.evaluate(() => currentPuzzle.best.slice(0, 2)),
    );
    await page.locator("#hint").click();
    await page.waitForFunction(() => !boards.puzzle.busy);
    assert.equal(
      await page.locator("#puzzle-board .board-arrow path").count(),
      1,
    );
    const arrow = await page
      .locator("#puzzle-board .board-arrow path")
      .getAttribute("d");
    await page.locator("#puzzle-flip").click();
    assert.notEqual(
      await page.locator("#puzzle-board .board-arrow path").getAttribute("d"),
      arrow,
    );
    console.log("PASS visual hint, move arrow, flipped arrow");
    // A legal wrong move must leave the puzzle intact and show useful feedback.
    const original = await page.evaluate(() => boards.puzzle.fen);
    const wrong = await page.evaluate(async () => {
      for (const m of boards.puzzle.legal.filter(
        (m) => m !== currentPuzzle.best && m.length === 4,
      )) {
        const r = await api("coach", { fen: boards.puzzle.fen, uci: m });
        if (r.loss > 200) return m;
      }
      return null;
    });
    if (wrong) {
      await drag(page, "puzzle", wrong.slice(0, 2), wrong.slice(2, 4));
      await page.waitForFunction(() => !boards.puzzle.busy);
      assert.equal(await page.evaluate(() => boards.puzzle.fen), original);
      assert.match(
        await page.locator("#puzzle-message").textContent(),
        /Try again/,
      );
    }
    for (let i = 0; i < 3 && !(await page.evaluate(() => puzzleSolved)); i++) {
      const best = await page.evaluate(() => currentPuzzle.best);
      await drag(page, "puzzle", best.slice(0, 2), best.slice(2, 4));
      if (best.length === 5)
        await page
          .getByRole("button", {
            name:
              "Promote to " +
              { q: "queen", r: "rook", b: "bishop", n: "knight" }[best[4]],
          })
          .click();
      await page.waitForFunction(() => !boards.puzzle.busy);
    }
    assert(await page.evaluate(() => puzzleSolved));
    assert.match(
      await page.locator("#puzzle-message").textContent(),
      /Well played/,
    );
    console.log(
      "PASS incorrect move feedback and solving a puzzle by dragging",
    );
    await page.locator("#next-puzzle").click();
    await page.waitForFunction(
      () => !puzzleSolved && !boards.puzzle.busy && activeDrill,
    );
    assert.equal(await page.locator("#puzzle-board .board-arrow").count(), 0);
    await page.locator("#solution").click();
    await page.waitForFunction(() => !boards.puzzle.busy);
    assert.equal(await page.locator("#puzzle-board .board-arrow").count(), 1);
    console.log("PASS next puzzle clears hints and reveal draws an arrow");
    // Special moves use the same motion pipeline, including both castling pieces.
    const special = await page.evaluate(async () => {
      stopSpeech();
      const results = [];
      for (const [fen, uci, targets] of [
        ["4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1", "e1g1", ["g1", "f1"]],
        ["4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1", "e1c1", ["c1", "d1"]],
        ["7k/8/8/3pP3/8/8/8/7K w - d6 0 1", "e5d6", ["d6"]],
        ["7k/P7/8/8/8/8/8/7K w - - 0 1", "a7a8q", ["a8"]],
      ]) {
        await setBoard("play", fen);
        await new Promise((r) => setTimeout(r, 300));
        const result = await api("move", {
          fen,
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci[4],
        });
        Object.assign(boards.play, result, {
          lastMove: [uci.slice(0, 2), uci.slice(2, 4)],
        });
        renderBoard("play");
        const pieces = targets.map((sq) =>
          document.querySelector(`#play-board [data-square="${sq}"] .piece`),
        );
        const animations = pieces.map((p) => p.getAnimations()[0]);
        renderBoard("play");
        results.push({
          uci,
          count: animations.filter(Boolean).length,
          preserved: pieces.every(
            (p, i) => p.isConnected && p.getAnimations()[0] === animations[i],
          ),
        });
        await Promise.all(animations.filter(Boolean).map((a) => a.finished));
        await setBoard("play", fen);
        const reverseTargets = [
          uci.slice(0, 2),
          ...(/e1[gc]1/.test(uci) ? [uci[2] === "g" ? "h1" : "a1"] : []),
        ];
        const reverseAnimations = reverseTargets.map(
          (sq) =>
            document
              .querySelector(`#play-board [data-square="${sq}"] .piece`)
              .getAnimations()[0],
        );
        results[results.length - 1].undo =
          reverseAnimations.filter(Boolean).length;
        await Promise.all(
          reverseAnimations.filter(Boolean).map((a) => a.finished),
        );
      }
      changePreference("motion", "reduced");
      await setBoard("play", startFen);
      const result = await api("move", { fen: startFen, from: "e2", to: "e4" });
      Object.assign(boards.play, result);
      renderBoard("play");
      results.push({ reduced: !boardIsMoving("play") });
      changePreference("motion", "full");
      return results;
    });
    assert.deepEqual(special.map((r) => r.count).slice(0, 4), [2, 2, 1, 1]);
    assert(special.slice(0, 4).every((r) => r.preserved && r.undo === r.count));
    assert(special[4].reduced);
    console.log(
      "PASS castling, en passant and promotion animate through redraws; reduced-motion preference is respected",
    );
    await page.locator('[data-page="play"]').click();
    await page.evaluate(async () => {
      stopSpeech();
      lastCoach = null;
      coachRequestId++;
      gameFinished = false;
      playedMoves = [];
      gameOpponentRating = null;
      await setBoard("play", "7k/P7/8/8/8/8/8/7K w - - 0 1");
    });
    await drag(page, "play", "a7", "a8");
    await page.locator("#promotion").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Promote to queen" }).click();
    await page.waitForFunction(() => !botBusy && !boards.play.busy);
    assert.equal(
      await page.evaluate(
        () =>
          placement(
            visualLesson?.name === "play"
              ? visualLesson.saved.fen
              : boards.play.fen,
          ).a8,
      ),
      "Q",
    );
    console.log("PASS promotion picker");
    assert.deepEqual(errors, []);
    console.log("PASS no browser JavaScript errors");
    await page.screenshot({ path: "/tmp/chess-desktop.png", fullPage: true });
    const mobile = await browser.newContext({ ...devices["iPhone 13"] });
    const phone = await mobile.newPage();
    await phone.goto(url);
    await phone.waitForFunction(() => Boolean(currentPuzzle));
    await phone.locator('[data-page="play"]').tap();
    await phone.locator('#play-board [data-square="e2"]').tap();
    await phone.locator('#play-board [data-square="e4"]').tap();
    await phone.waitForFunction(
      () => !botBusy && !boards.play.busy && boards.play.fen !== startFen,
    );
    assert.equal(
      await phone.evaluate(
        () =>
          placement(
            visualLesson?.name === "play"
              ? visualLesson.saved.fen
              : boards.play.fen,
          ).e4,
      ),
      "P",
    );
    assert.equal(
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    console.log("PASS mobile touch movement and no horizontal overflow");
    await phone.locator("#take-back").tap();
    await phone.waitForFunction(() => boards.play.fen === startFen);
    await phone.locator("#play-board").scrollIntoViewIfNeeded();
    const touch = await mobile.newCDPSession(phone);
    const a = await phone
      .locator('#play-board [data-square="d2"]')
      .boundingBox();
    const b = await phone
      .locator('#play-board [data-square="d4"]')
      .boundingBox();
    const x = a.x + a.width / 2,
      y = a.y + a.height / 2,
      tx = b.x + b.width / 2,
      ty = b.y + b.height / 2;
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (let i = 1; i <= 8; i++)
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + ((tx - x) * i) / 8, y: y + ((ty - y) * i) / 8 }],
      });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await phone.waitForFunction(
      () => !botBusy && !boards.play.busy && boards.play.fen !== startFen,
    );
    assert.equal(
      await phone.evaluate(
        () =>
          placement(
            visualLesson?.name === "play"
              ? visualLesson.saved.fen
              : boards.play.fen,
          ).d4,
      ),
      "P",
    );
    console.log("PASS mobile touch dragging");
    await phone.screenshot({ path: "/tmp/chess-mobile.png", fullPage: true });
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
