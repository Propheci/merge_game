import { MERGE_POINTS, SPAWNABLE_TIERS, TIERS, TOP_TIER } from "../shared/tiers.ts";
import { spawnCounts } from "../shared/rng.ts";
import type { ScoreSubmission } from "../shared/protocol.ts";

/**
 * Score checks.
 *
 * The browser holds the game, so the browser can lie. These rules make a lie
 * expensive:
 *
 *  1. The server made the drop sequence, so it knows which items the player
 *     received. A merge count that the sequence cannot supply is impossible.
 *  2. The server calculates the score again from the merge counts. The client
 *     score is only a check value.
 *  3. Each game needs real time. A game that reports many drops in a few
 *     seconds is not a human game.
 *
 * A cheater who plays the true game with a robot can still get a high score.
 * Only a full simulation on the server stops that.
 */

export const MAX_DROPS = 5000;
export const MIN_MILLISECONDS_PER_DROP = 180;

export interface ValidatedRun {
  score: number;
  maxTier: number;
  drops: number;
}

export type ValidationResult =
  | { ok: true; run: ValidatedRun }
  | { ok: false; reason: string };

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Checks the shape of the body that a browser posted. */
export function parseSubmission(body: unknown): ScoreSubmission | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.token !== "string") return null;
  if (!isCount(raw.drops) || !isCount(raw.score)) return null;
  if (!Array.isArray(raw.mergeCounts)) return null;
  if (raw.mergeCounts.length !== TIERS.length) return null;
  if (!raw.mergeCounts.every(isCount)) return null;
  return {
    token: raw.token,
    name: typeof raw.name === "string" ? raw.name : "",
    drops: raw.drops,
    mergeCounts: raw.mergeCounts as number[],
    score: raw.score,
  };
}

/**
 * Tests one game report against the drop sequence of its session.
 *
 * @param seed        Seed that the server gave to this game.
 * @param elapsedMs   Time from the start of the session, measured by the server.
 */
export function validateRun(
  submission: ScoreSubmission,
  seed: number,
  elapsedMs: number,
): ValidationResult {
  const { drops, mergeCounts } = submission;

  if (drops > MAX_DROPS) return { ok: false, reason: "too many drops" };
  if (elapsedMs < drops * MIN_MILLISECONDS_PER_DROP) {
    return { ok: false, reason: "game was too fast" };
  }

  // No merge makes the smallest tier, and the largest tier does not merge.
  if (mergeCounts[0] !== 0) return { ok: false, reason: "bad merge counts" };

  // produced[i] = items of tier i that the game made.
  const spawned = spawnCounts(seed, drops);
  const produced = new Array<number>(TIERS.length).fill(0);
  for (let tier = 0; tier < TIERS.length; tier += 1) {
    const fromDrops = tier < SPAWNABLE_TIERS ? (spawned[tier] ?? 0) : 0;
    produced[tier] = fromDrops + (mergeCounts[tier] ?? 0);
  }

  // Each merge that makes tier i + 1 uses two items of tier i.
  for (let tier = 0; tier < TOP_TIER; tier += 1) {
    const used = 2 * (mergeCounts[tier + 1] ?? 0);
    if (used > (produced[tier] ?? 0)) {
      return { ok: false, reason: `impossible merges at tier ${tier + 1}` };
    }
  }

  let score = 0;
  let totalMerges = 0;
  let maxTier = 0;
  for (let tier = 1; tier < TIERS.length; tier += 1) {
    const merges = mergeCounts[tier] ?? 0;
    score += merges * (MERGE_POINTS[tier] ?? 0);
    totalMerges += merges;
    if (merges > 0) maxTier = tier;
  }

  // Every merge removes one item from the board. The board cannot go negative.
  if (totalMerges > drops) return { ok: false, reason: "more merges than drops" };

  if (score !== submission.score) return { ok: false, reason: "score does not match" };

  return { ok: true, run: { score, maxTier, drops } };
}
