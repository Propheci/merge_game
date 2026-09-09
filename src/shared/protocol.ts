/** Shapes that the browser and the server exchange over HTTP. */

export interface StartGameResponse {
  /** Opaque session id. The browser sends it back with the score. */
  token: string;
  /** Seed of the drop sequence for this game. */
  seed: number;
  /** Server time limit for one game, in milliseconds. */
  ttlMs: number;
}

export interface ScoreSubmission {
  token: string;
  /** Player name. The server trims and cleans it. */
  name: string;
  /** Number of items that the player dropped. */
  drops: number;
  /** mergeCounts[i] = number of merges that made an item of tier i. */
  mergeCounts: number[];
  /** Score that the browser calculated. The server calculates it again. */
  score: number;
}

export interface ScoreResult {
  accepted: true;
  score: number;
  rank: number;
  best: boolean;
}

export interface LeaderboardEntry {
  name: string;
  score: number;
  createdAt: number;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
}

export interface ApiError {
  error: string;
}
