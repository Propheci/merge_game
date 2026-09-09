import { SPAWNABLE_TIERS } from "./tiers.ts";

/**
 * Deterministic pseudo random number generator (mulberry32).
 *
 * The server gives each game a seed. The browser and the server both make the
 * same sequence of drops from that seed. The server can therefore replay the
 * sequence and reject a score that the sequence cannot produce.
 *
 * This generator is NOT for cryptography.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Makes the drop sequence for one game. */
export function createSpawner(seed: number): () => number {
  const random = mulberry32(seed);
  return () => Math.floor(random() * SPAWNABLE_TIERS);
}

/** Counts how many items of each tier the first `drops` drops give. */
export function spawnCounts(seed: number, drops: number): number[] {
  const counts = new Array<number>(SPAWNABLE_TIERS).fill(0);
  const nextTier = createSpawner(seed);
  for (let i = 0; i < drops; i += 1) {
    const tier = nextTier();
    counts[tier] = (counts[tier] ?? 0) + 1;
  }
  return counts;
}
