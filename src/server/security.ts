import { randomBytes } from "node:crypto";

/**
 * Security helpers: game sessions, rate limits, request checks and response
 * headers. Everything here treats the browser as untrusted.
 */

export const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SESSIONS = 20_000;

export interface GameSession {
  readonly id: string;
  readonly seed: number;
  readonly createdAt: number;
  readonly ip: string;
  used: boolean;
}

const sessions = new Map<string, GameSession>();

export function createSession(ip: string, now = Date.now()): GameSession {
  pruneSessions(now);
  if (sessions.size >= MAX_SESSIONS) {
    // Drop the oldest session. A Map keeps insertion order.
    const oldest = sessions.keys().next();
    if (!oldest.done) sessions.delete(oldest.value);
  }
  const session: GameSession = {
    // 256 bits of randomness. An attacker cannot guess a session id.
    id: randomBytes(32).toString("base64url"),
    seed: randomBytes(4).readUInt32BE(0),
    createdAt: now,
    ip,
    used: false,
  };
  sessions.set(session.id, session);
  return session;
}

/** Finds a session and marks it used. Each session pays for one score only. */
export function takeSession(token: unknown, now = Date.now()): GameSession | null {
  if (typeof token !== "string" || token.length !== 43) return null;
  const session = sessions.get(token);
  if (!session || session.used) return null;
  if (now - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  session.used = true;
  return session;
}

export function pruneSessions(now = Date.now()): void {
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id);
    else break; // The map is in insertion order, so the rest are newer.
  }
}

export function sessionCount(): number {
  return sessions.size;
}

/* ------------------------------------------------------------------ */
/* Rate limits                                                         */
/* ------------------------------------------------------------------ */

interface FixedWindow {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, FixedWindow>();
const MAX_BUCKETS = 50_000;

/** Returns true if the caller stays inside the limit. */
export function allowRequest(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    if (buckets.size >= MAX_BUCKETS) buckets.clear();
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

export function resetRateLimits(): void {
  buckets.clear();
}

/* ------------------------------------------------------------------ */
/* Request checks                                                      */
/* ------------------------------------------------------------------ */

export const MAX_BODY_BYTES = 4096;

/**
 * Rejects a request that a different web site started. Browsers set
 * Sec-Fetch-Site. Old clients send nothing, so an absent header is allowed,
 * but a cross-site value is not.
 */
export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}

/** Reads a JSON body of limited size. Returns null if the body is not good. */
export async function readJsonBody(request: Request): Promise<unknown | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) return null;

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;

  const text = await readLimitedText(request, MAX_BODY_BYTES);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function readLimitedText(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

/* ------------------------------------------------------------------ */
/* Player names                                                        */
/* ------------------------------------------------------------------ */

export const MAX_NAME_LENGTH = 16;

/** Control characters, bidirectional overrides and invisible marks. */
const UNSAFE_CHARACTERS =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;

/**
 * Cleans a player name. The result is plain text. The browser shows it with
 * textContent, never as HTML, so this is defence in depth.
 */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return "Anonymous";
  if (raw.length > 256) return "Anonymous";
  const cleaned = raw
    .normalize("NFKC")
    .replace(UNSAFE_CHARACTERS, "")
    .replace(/\s+/gu, " ")
    .trim();
  const cut = [...cleaned].slice(0, MAX_NAME_LENGTH).join("");
  return cut.length > 0 ? cut : "Anonymous";
}

/* ------------------------------------------------------------------ */
/* Response headers                                                    */
/* ------------------------------------------------------------------ */

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

export function securityHeaders(useHsts: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
  };
  if (useHsts) {
    headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}
