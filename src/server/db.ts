import { Database } from "bun:sqlite";
import type { LeaderboardEntry } from "../shared/protocol.ts";

/**
 * Leaderboard storage.
 *
 * All statements use parameters. The server never puts a value from a request
 * into SQL text, so SQL injection is not possible.
 */

const DB_PATH = process.env.MERGE_GAME_DB ?? "data/scores.sqlite";

export const db = new Database(DB_PATH, { create: true, strict: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 3000");
db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    score      INTEGER NOT NULL,
    max_tier   INTEGER NOT NULL,
    drops      INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS scores_by_score ON scores (score DESC, created_at ASC)");

const insertScore = db.query<unknown, [string, number, number, number, number]>(
  `INSERT INTO scores (name, score, max_tier, drops, created_at)
   VALUES (?, ?, ?, ?, ?)`,
);

const countBetter = db.query<{ better: number }, [number]>(
  "SELECT COUNT(*) AS better FROM scores WHERE score > ?",
);

const topScores = db.query<{ name: string; score: number; created_at: number }, [number]>(
  `SELECT name, score, created_at
   FROM scores
   ORDER BY score DESC, created_at ASC
   LIMIT ?`,
);

const bestScore = db.query<{ best: number | null }, []>(
  "SELECT MAX(score) AS best FROM scores",
);

export interface SavedScore {
  rank: number;
  best: boolean;
}

export function saveScore(
  name: string,
  score: number,
  maxTier: number,
  drops: number,
  now = Date.now(),
): SavedScore {
  const previousBest = bestScore.get()?.best ?? -1;
  insertScore.run(name, score, maxTier, drops, now);
  const better = countBetter.get(score)?.better ?? 0;
  return { rank: better + 1, best: score > previousBest };
}

export function leaderboard(limit = 20): LeaderboardEntry[] {
  const rows = topScores.all(Math.min(Math.max(limit, 1), 100));
  return rows.map((row) => ({
    name: row.name,
    score: row.score,
    createdAt: row.created_at,
  }));
}
