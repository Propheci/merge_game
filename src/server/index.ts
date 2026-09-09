import { serve } from "bun";
import { buildClient, loadAssets, type Asset } from "./assets.ts";
import { leaderboard, saveScore } from "./db.ts";
import { parseSubmission, validateRun } from "./validate.ts";
import {
  allowRequest,
  createSession,
  isSameOrigin,
  readJsonBody,
  sanitizeName,
  securityHeaders,
  SESSION_TTL_MS,
  takeSession,
} from "./security.ts";
import type {
  LeaderboardResponse,
  ScoreResult,
  StartGameResponse,
} from "../shared/protocol.ts";

const PORT = Number(process.env.PORT ?? 3000);
/** Address to bind. Leave unset to listen on every interface. */
const HOSTNAME = process.env.HOST || undefined;
const PRODUCTION = process.env.NODE_ENV === "production";
/** Set MERGE_GAME_HSTS=1 only when the site runs behind HTTPS. */
const USE_HSTS = process.env.MERGE_GAME_HSTS === "1";
/** Set MERGE_GAME_TRUST_PROXY=1 only behind a proxy that you control. */
const TRUST_PROXY = process.env.MERGE_GAME_TRUST_PROXY === "1";

const BASE_HEADERS = securityHeaders(USE_HSTS);

await buildClient(PRODUCTION);
const assets = await loadAssets();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Only the part of the server that this helper needs. */
interface IpSource {
  requestIP(request: Request): { address: string } | null;
}

function clientIp(request: Request, server: IpSource): string {
  if (TRUST_PROXY) {
    const forwarded = request.headers.get("x-forwarded-for");
    const first = forwarded?.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return server.requestIP(request)?.address ?? "unknown";
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...BASE_HEADERS,
      ...extra,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function fail(status: number, message: string): Response {
  return json({ error: message }, status);
}

function sendAsset(asset: Asset, request: Request): Response {
  if (request.headers.get("if-none-match") === asset.etag) {
    return new Response(null, { status: 304, headers: { ...BASE_HEADERS, etag: asset.etag } });
  }
  return new Response(asset.body, {
    headers: {
      ...BASE_HEADERS,
      "content-type": asset.type,
      "cache-control": asset.cache,
      etag: asset.etag,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

function startGame(request: Request, ip: string): Response {
  if (!isSameOrigin(request)) return fail(403, "cross site request");
  if (!allowRequest(`game:${ip}`, 40, 5 * 60_000)) return fail(429, "too many games");

  const session = createSession(ip);
  const body: StartGameResponse = {
    token: session.id,
    seed: session.seed,
    ttlMs: SESSION_TTL_MS,
  };
  return json(body);
}

async function submitScore(request: Request, ip: string): Promise<Response> {
  if (!isSameOrigin(request)) return fail(403, "cross site request");
  if (!allowRequest(`score:${ip}`, 30, 5 * 60_000)) return fail(429, "too many scores");

  const body = await readJsonBody(request);
  if (body === null) return fail(400, "bad request body");

  const submission = parseSubmission(body);
  if (!submission) return fail(400, "bad score report");

  const now = Date.now();
  const session = takeSession(submission.token, now);
  if (!session) return fail(403, "unknown or used game");

  const result = validateRun(submission, session.seed, now - session.createdAt);
  if (!result.ok) return fail(422, result.reason);

  const name = sanitizeName(submission.name);
  const saved = saveScore(name, result.run.score, result.run.maxTier, result.run.drops, now);
  const response: ScoreResult = {
    accepted: true,
    score: result.run.score,
    rank: saved.rank,
    best: saved.best,
  };
  return json(response);
}

function getLeaderboard(ip: string): Response {
  if (!allowRequest(`board:${ip}`, 120, 60_000)) return fail(429, "too many requests");
  const body: LeaderboardResponse = { entries: leaderboard(20) };
  return json(body);
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const server = serve({
  port: PORT,
  hostname: HOSTNAME,
  // Refuse a body that is larger than any request this server accepts.
  maxRequestBodySize: 16 * 1024,
  idleTimeout: 30,

  async fetch(request, self) {
    const ip = clientIp(request, self);
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" || request.method === "HEAD") {
      const asset = assets.get(path === "/index.html" ? "/" : path);
      if (asset) return sendAsset(asset, request);
      if (path === "/api/leaderboard") return getLeaderboard(ip);
      return fail(404, "not found");
    }

    if (request.method === "POST") {
      if (path === "/api/game") return startGame(request, ip);
      if (path === "/api/score") return submitScore(request, ip);
      return fail(404, "not found");
    }

    return fail(405, "method not allowed");
  },

  error(error) {
    // Never send an internal message or a stack to the browser.
    console.error("[merge-game]", error);
    return fail(500, "internal error");
  },
});

console.log(
  `merge game on http://${server.hostname}:${server.port}  (production=${PRODUCTION})`,
);
