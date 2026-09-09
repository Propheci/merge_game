import { describe, expect, test } from "bun:test";
import { MERGE_POINTS, TIERS } from "../shared/tiers.ts";
import { spawnCounts } from "../shared/rng.ts";
import { MIN_MILLISECONDS_PER_DROP, parseSubmission, validateRun } from "./validate.ts";
import { sanitizeName } from "./security.ts";

const SEED = 123456;

/** Makes the merge counts of an honest game that merges as much as it can. */
function honestRun(drops: number): { mergeCounts: number[]; score: number } {
  const available = spawnCounts(SEED, drops);
  const mergeCounts = new Array<number>(TIERS.length).fill(0);
  const pool = new Array<number>(TIERS.length).fill(0);
  available.forEach((count, tier) => {
    pool[tier] = count;
  });

  for (let tier = 0; tier < TIERS.length - 1; tier += 1) {
    const merges = Math.floor((pool[tier] ?? 0) / 2);
    mergeCounts[tier + 1] = merges;
    pool[tier + 1] = (pool[tier + 1] ?? 0) + merges;
  }

  const score = mergeCounts.reduce(
    (total, merges, tier) => total + merges * (MERGE_POINTS[tier] ?? 0),
    0,
  );
  return { mergeCounts, score };
}

function submission(over: Partial<Record<string, unknown>> = {}) {
  const drops = 60;
  const run = honestRun(drops);
  return {
    token: "t".repeat(43),
    name: "Player",
    drops,
    mergeCounts: run.mergeCounts,
    score: run.score,
    ...over,
  };
}

const LONG_ENOUGH = 60 * MIN_MILLISECONDS_PER_DROP + 1000;

describe("validateRun", () => {
  test("accepts a game that the drop sequence can make", () => {
    const result = validateRun(submission(), SEED, LONG_ENOUGH);
    expect(result.ok).toBe(true);
  });

  test("refuses merges that the drop sequence cannot supply", () => {
    const bad = submission();
    bad.mergeCounts = [...bad.mergeCounts];
    bad.mergeCounts[10] = 99;
    bad.score = bad.mergeCounts.reduce(
      (total, merges, tier) => total + merges * (MERGE_POINTS[tier] ?? 0),
      0,
    );
    const result = validateRun(bad, SEED, LONG_ENOUGH);
    expect(result.ok).toBe(false);
  });

  test("refuses a score that does not match the merges", () => {
    const result = validateRun(submission({ score: 999_999 }), SEED, LONG_ENOUGH);
    expect(result).toEqual({ ok: false, reason: "score does not match" });
  });

  test("refuses a game that ran too fast", () => {
    const result = validateRun(submission(), SEED, 500);
    expect(result).toEqual({ ok: false, reason: "game was too fast" });
  });

  test("refuses a different seed", () => {
    const result = validateRun(submission(), SEED + 1, LONG_ENOUGH);
    expect(result.ok).toBe(false);
  });
});

describe("parseSubmission", () => {
  test("refuses a wrong shape", () => {
    expect(parseSubmission(null)).toBeNull();
    expect(parseSubmission({ token: 1 })).toBeNull();
    expect(parseSubmission({ ...submission(), drops: -1 })).toBeNull();
    expect(parseSubmission({ ...submission(), mergeCounts: [1, 2] })).toBeNull();
    expect(parseSubmission({ ...submission(), score: 1.5 })).toBeNull();
  });

  test("accepts a good shape", () => {
    expect(parseSubmission(submission())).not.toBeNull();
  });
});

describe("sanitizeName", () => {
  test("removes control characters and cuts the length", () => {
    expect(sanitizeName("a\u0000b\u202Ec")).toBe("abc");
    expect(sanitizeName("x".repeat(50))).toHaveLength(16);
    expect(sanitizeName("   ")).toBe("Anonymous");
    expect(sanitizeName(42)).toBe("Anonymous");
  });

  test("keeps markup as plain text", () => {
    expect(sanitizeName("<img src=x>")).toBe("<img src=x>");
  });
});

describe("outlines", () => {
  /** Matter.js can only build a body from a convex outline without a helper. */
  function isConvex(points: readonly { x: number; y: number }[]): boolean {
    let sign = 0;
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      const c = points[(i + 2) % points.length]!;
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (cross === 0) continue;
      const current = Math.sign(cross);
      if (sign === 0) sign = current;
      else if (current !== sign) return false;
    }
    return true;
  }

  test("every vessel outline is convex", () => {
    for (const tier of TIERS) {
      expect(isConvex(tier.outline)).toBe(true);
    }
  });

  test("the vessels grow with the tier", () => {
    for (let i = 1; i < TIERS.length; i += 1) {
      expect(TIERS[i]!.radius).toBeGreaterThan(TIERS[i - 1]!.radius);
    }
  });
});
