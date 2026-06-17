// Abuse and safety controls for anonymous upload (plan U11).
//
// Anonymous encrypted-blob upload is the Firefox Send failure mode, so the
// envelope and the uploader identity are bounded even though content is
// unreadable: per-IP rate limiting, a global anonymous cap, an operator ban
// list, and a report endpoint that never confirms a share's existence and never
// auto-deletes. IPs are stored only as salted hashes.

import { getSql } from "./db";
import { isCrossSite, sha256hex } from "./shares";

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60; // create/report attempts per IP per minute
/** Higher per-token ceiling for authenticated CLI traffic (upload bursts, list). */
export const CLI_RATE_MAX = 240;
const GLOBAL_ANON_MAX = 100_000; // cap on concurrently-active anonymous shares

// Process-local sliding window. Single-instance for now; a multi-instance deploy
// would back this with a shared store (see docs/DEPLOYMENT.md → Scaling).
const ipHits = new Map<string, number[]>();

/**
 * Resolve the client IP. Behind a reverse proxy (e.g. Traefik/nginx) the real
 * client is in X-Forwarded-For — but a client can prepend a forged entry, so the
 * trustworthy value is the Nth-from-the-right hop that the trusted proxy added,
 * NOT the left-most. Set TRUSTED_PROXY=1 (one hop) in production behind a reverse proxy;
 * use TRUSTED_PROXY_HOPS for additional trusted proxies. With no trusted proxy,
 * X-Forwarded-For is ignored entirely (it would be client-controlled).
 */
export function clientIp(req: Request, directIp: string | undefined): string {
  const hops = trustedProxyHops();
  if (hops > 0) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const parts = xff
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const idx = parts.length - hops;
      if (idx >= 0 && parts[idx]) return parts[idx]!;
    }
  }
  return directIp ?? "unknown";
}

function trustedProxyHops(): number {
  const explicit = Number(process.env.TRUSTED_PROXY_HOPS);
  if (Number.isInteger(explicit) && explicit >= 0) return explicit;
  return process.env.TRUSTED_PROXY === "1" ? 1 : 0;
}

/**
 * Sliding-window rate check. Returns false when the limit is exceeded. `limit`
 * defaults to RATE_MAX; the CLI bearer path passes CLI_RATE_MAX for its per-token
 * key (`now` stays the second positional arg so existing callers are unaffected).
 */
export function checkRateLimit(
  key: string,
  now: number = Date.now(),
  limit: number = RATE_MAX,
): boolean {
  const recent = (ipHits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= limit) {
    ipHits.set(key, recent);
    return false;
  }
  recent.push(now);
  ipHits.set(key, recent);
  return true;
}

/** Test helper: clear the in-memory rate-limit state. */
export function resetRateLimits(): void {
  ipHits.clear();
}

export function hashIp(ip: string): string {
  return sha256hex((process.env.IP_HASH_SALT ?? "dev-ip-salt") + ip);
}

export async function isBanned(ipHash: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`SELECT 1 FROM banned_ips WHERE ip_hash = ${ipHash}`;
  return rows.length > 0;
}

export async function anonCapReached(): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    SELECT count(*)::int AS n FROM shares
    WHERE owner_user_id IS NULL AND state = 'active'
  `;
  return (rows[0]?.n ?? 0) >= GLOBAL_ANON_MAX;
}

/**
 * POST /api/report — record an abuse report. Cross-site rejected, rate-limited,
 * never confirms whether the id exists, and never auto-deletes/bans (operator
 * action only). Always returns the same opaque ok.
 */
export async function handleReportAbuse(
  req: Request,
  directIp: string | undefined,
): Promise<Response> {
  const opaqueOk = () => Response.json({ ok: true });
  if (isCrossSite(req)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const ip = clientIp(req, directIp);
  if (!checkRateLimit(`report:${ip}`)) return opaqueOk(); // silently drop, no signal

  let body: { shareId?: unknown; reason?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const shareId = typeof body.shareId === "string" ? body.shareId : null;
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 1000) : null;
  const reporterIpHash = hashIp(ip);

  const sql = getSql();
  // Record share_id only if it exists (avoids an FK error) — the uniform
  // response means this lookup never reveals existence to the reporter.
  let linkedId: string | null = null;
  if (shareId) {
    const exists = await sql`SELECT 1 FROM shares WHERE id = ${shareId}`;
    if (exists.length > 0) linkedId = shareId;
  }
  await sql`
    INSERT INTO report_abuse (share_id, reason, reporter_ip_hash)
    VALUES (${linkedId}, ${reason}, ${reporterIpHash})
  `;

  return opaqueOk();
}

// --- Operator-only actions (not exposed as open endpoints) ---

/** Take down a share by id (tombstone + null ciphertext and uploader IP). */
export async function takedown(id: string): Promise<void> {
  const sql = getSql();
  await sql`
    UPDATE shares SET state = 'deleted', ciphertext = NULL, uploader_ip_hash = NULL
    WHERE id = ${id}
  `;
}

/** Ban an IP (by salted hash) from creating new shares. */
export async function banIp(ipHash: string, reason: string): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO banned_ips (ip_hash, reason) VALUES (${ipHash}, ${reason})
    ON CONFLICT (ip_hash) DO NOTHING
  `;
}
