import { BOARD, MergeGame } from "./game.ts";
import { drawDrinkInBox } from "./drinks.ts";
import { getLeaderboard, startGame, submitScore } from "./api.ts";
import { TIERS } from "../shared/tiers.ts";

/**
 * Page code. It builds every element with textContent, never with innerHTML,
 * so text from the leaderboard cannot become markup.
 */

function need<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as unknown as T;
}

const canvas = need<HTMLCanvasElement>("board");
const context = canvas.getContext("2d");
if (!context) throw new Error("this browser has no 2D canvas");
const ctx = context;

const scoreOut = need<HTMLElement>("score");
const bestOut = need<HTMLElement>("best");
const nextCanvas = need<HTMLCanvasElement>("next");
const nextCtx = nextCanvas.getContext("2d");

const overlay = need<HTMLElement>("overlay");
const panelTitle = need<HTMLElement>("panel-title");
const panelText = need<HTMLElement>("panel-text");
const panelScore = need<HTMLElement>("panel-score");
const submitRow = need<HTMLElement>("submit-row");
const nameInput = need<HTMLInputElement>("player-name");
const submitButton = need<HTMLButtonElement>("submit");
const submitNote = need<HTMLElement>("submit-note");
const playButton = need<HTMLButtonElement>("play");
const leaderboardList = need<HTMLOListElement>("leaderboard");
const ladder = need<HTMLElement>("ladder");

let sessionToken: string | null = null;
let offline = false;

/* ------------------------------------------------------------------ */
/* Local best score                                                    */
/* ------------------------------------------------------------------ */

const BEST_KEY = "merge-game:best";

function readBest(): number {
  try {
    const stored = Number(window.localStorage.getItem(BEST_KEY));
    return Number.isSafeInteger(stored) && stored > 0 ? stored : 0;
  } catch {
    return 0;
  }
}

function writeBest(value: number): void {
  try {
    window.localStorage.setItem(BEST_KEY, String(value));
  } catch {
    // Private browsing can block storage. The game still works.
  }
}

let best = readBest();
bestOut.textContent = String(best);

/* ------------------------------------------------------------------ */
/* Game                                                                */
/* ------------------------------------------------------------------ */

const game = new MergeGame({
  onScore(score) {
    scoreOut.textContent = String(score);
    if (score > best) {
      best = score;
      bestOut.textContent = String(score);
      writeBest(score);
    }
  },
  onNext(tier) {
    drawNextPreview(tier);
  },
  onGameOver() {
    showGameOver();
  },
});

function drawNextPreview(tier: number): void {
  if (!nextCtx) return;
  nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  drawDrinkInBox(nextCtx, tier, nextCanvas.width / 2, nextCanvas.height / 2, nextCanvas.width);
}

/* ------------------------------------------------------------------ */
/* Canvas size                                                         */
/* ------------------------------------------------------------------ */

function resizeCanvas(): void {
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(BOARD.width * ratio);
  canvas.height = Math.round(BOARD.height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

/** Board position of a screen point. The game clamps the result to the table. */
function boardX(clientX: number): number {
  const rect = canvas.getBoundingClientRect();
  return ((clientX - rect.left) / rect.width) * BOARD.width;
}

/** Parts of the page that have their own job for a click. */
function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button, input, a, .overlay, .hud, .ladder") !== null;
}

// The window gets these events, not the canvas. The player can therefore aim
// and release past the edge of the table.
let aiming = false;

window.addEventListener("pointerdown", (event) => {
  if (!game.isRunning || isControl(event.target)) return;
  aiming = true;
  game.aimAt(boardX(event.clientX));
});
window.addEventListener("pointermove", (event) => {
  if (!game.isRunning) return;
  game.aimAt(boardX(event.clientX));
});
window.addEventListener("pointerup", (event) => {
  if (!aiming) return;
  aiming = false;
  if (!game.isRunning) return;
  game.aimAt(boardX(event.clientX));
  game.drop();
});
window.addEventListener("pointercancel", () => {
  aiming = false;
});
canvas.addEventListener("contextmenu", (event) => event.preventDefault());

window.addEventListener("keydown", (event) => {
  if (!game.isRunning) return;
  if (event.key === "ArrowLeft") {
    game.nudge(-1);
    event.preventDefault();
  } else if (event.key === "ArrowRight") {
    game.nudge(1);
    event.preventDefault();
  } else if (event.key === " " || event.key === "Enter") {
    game.drop();
    event.preventDefault();
  }
});

/* ------------------------------------------------------------------ */
/* Loop                                                                */
/* ------------------------------------------------------------------ */

const STEP_MS = 1000 / 60;
let previous = performance.now();
let backlog = 0;

function frame(now: number): void {
  backlog += Math.min(now - previous, 250);
  previous = now;
  while (backlog >= STEP_MS) {
    game.step();
    backlog -= STEP_MS;
  }
  game.render(ctx);
  window.requestAnimationFrame(frame);
}
window.requestAnimationFrame(frame);

/* ------------------------------------------------------------------ */
/* Overlay                                                             */
/* ------------------------------------------------------------------ */

function setHidden(element: Element, hidden: boolean): void {
  element.classList.toggle("hidden", hidden);
}

async function beginGame(): Promise<void> {
  playButton.disabled = true;
  playButton.textContent = "Loading...";
  submitNote.textContent = "";

  let seed: number;
  try {
    const session = await startGame();
    sessionToken = session.token;
    seed = session.seed;
    offline = false;
  } catch {
    // The server is not reachable. The game still runs, but no score goes up.
    sessionToken = null;
    offline = true;
    seed = Math.floor(Math.random() * 0xffffffff);
    submitNote.textContent = "Offline: the leaderboard is not available.";
  }

  playButton.disabled = false;
  playButton.textContent = "Play again";
  setHidden(overlay, true);
  setHidden(submitRow, true);
  setHidden(panelScore, true);
  game.start(seed);
}

function showGameOver(): void {
  panelTitle.textContent = "Bar closed";
  panelText.textContent = "The drinks reached the line.";
  panelScore.textContent = `Score ${game.report().score}`;
  setHidden(panelScore, false);
  setHidden(overlay, false);
  setHidden(submitRow, offline);
  submitButton.disabled = false;
  submitButton.textContent = "Send score";
  void refreshLeaderboard();
}

playButton.addEventListener("click", () => {
  void beginGame();
});

submitButton.addEventListener("click", () => {
  void sendScore();
});

async function sendScore(): Promise<void> {
  if (!sessionToken) return;
  submitButton.disabled = true;
  submitButton.textContent = "Sending...";
  const report = game.report();
  try {
    const result = await submitScore({
      token: sessionToken,
      name: nameInput.value,
      drops: report.drops,
      mergeCounts: report.mergeCounts,
      score: report.score,
    });
    sessionToken = null;
    submitNote.textContent = result.best
      ? `New record! Rank ${result.rank}.`
      : `Saved at rank ${result.rank}.`;
    setHidden(submitRow, true);
    await refreshLeaderboard();
  } catch (error) {
    submitButton.disabled = false;
    submitButton.textContent = "Send score";
    submitNote.textContent = error instanceof Error ? error.message : "Could not save.";
  }
}

async function refreshLeaderboard(): Promise<void> {
  try {
    const board = await getLeaderboard();
    leaderboardList.replaceChildren(
      ...board.entries.map((entry) => {
        const item = document.createElement("li");
        const name = document.createElement("span");
        name.className = "entry-name";
        name.textContent = entry.name; // Text only. Never innerHTML.
        const score = document.createElement("span");
        score.className = "entry-score";
        score.textContent = String(entry.score);
        item.append(name, score);
        return item;
      }),
    );
    if (board.entries.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "No scores yet.";
      leaderboardList.replaceChildren(empty);
    }
  } catch {
    leaderboardList.replaceChildren();
  }
}

/* ------------------------------------------------------------------ */
/* Tier strip                                                          */
/* ------------------------------------------------------------------ */

const LADDER_CELL = 34;

function buildLadder(): void {
  ladder.replaceChildren(
    ...TIERS.map((tier, index) => {
      const cell = document.createElement("canvas");
      const ratio = Math.min(window.devicePixelRatio || 1, 3);
      cell.className = "ladder-cell";
      cell.width = LADDER_CELL * ratio;
      cell.height = LADDER_CELL * ratio;
      cell.title = `${index + 1}. ${tier.name}`;
      const cellCtx = cell.getContext("2d");
      if (cellCtx) {
        cellCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
        drawDrinkInBox(cellCtx, index, LADDER_CELL / 2, LADDER_CELL / 2, LADDER_CELL);
      }
      return cell;
    }),
  );
}

buildLadder();
drawNextPreview(0);
void refreshLeaderboard();
