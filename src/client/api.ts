import type {
  LeaderboardResponse,
  ScoreResult,
  ScoreSubmission,
  StartGameResponse,
} from "../shared/protocol.ts";

/** All calls stay on this origin and send no cookies. */
async function call<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "omit",
    mode: "same-origin",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const data = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `request failed (${response.status})`;
    throw new Error(message);
  }
  return data as T;
}

export function startGame(): Promise<StartGameResponse> {
  return call<StartGameResponse>("/api/game", "POST", {});
}

export function submitScore(submission: ScoreSubmission): Promise<ScoreResult> {
  return call<ScoreResult>("/api/score", "POST", submission);
}

export function getLeaderboard(): Promise<LeaderboardResponse> {
  return call<LeaderboardResponse>("/api/leaderboard", "GET");
}
