// Per-box CLI token custody (plan U2; bearer auth added in U3).
//
// Mint/list/revoke are session-authed (operator logged in + unlocked) and run on
// the same cookie + CSRF gate as account-store. The server stores only a hash of
// the token's auth secret (parity with shares.admin_token_hash) plus the
// account-wrapped machine key — it can never read the machine key or the secret.

import { getSql } from "./db";
import { userIdFromRequest, randomToken } from "./sessions";
import {
  isCrossSite,
  sha256hex,
  constantTimeEqual,
  isWrappedKey,
  DUMMY_HASH,
} from "./shares";
import {
  clientIp,
  hashIp,
  isBanned,
  checkRateLimit,
  CLI_RATE_MAX,
} from "./abuse";
import type {
  MintTokenResponse,
  ListTokensResponse,
  CliTokenSummary,
} from "../wire-types";

const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });
const forbidden = () => Response.json({ error: "forbidden" }, { status: 403 });
const badRequest = () => Response.json({ error: "bad_request" }, { status: 400 });
const rateLimited = () => Response.json({ error: "rate_limited" }, { status: 429 });

// Throttle the last_used_at write to at most once per token per window, so a hot
// CLI loop is neither a per-request DB write nor a timing differentiator.
const LAST_USED_THROTTLE_MS = 5 * 60_000;
const lastUsedAt = new Map<string, number>();

/** Test helper: clear the last_used_at throttle state. */
export function resetCliAuthThrottle(): void {
  lastUsedAt.clear();
}

/** Parse `Authorization: Bearer <tokenId>.<secret>`, splitting on the FIRST dot. */
function parseBearer(header: string | null): { tokenId: string; secret: string } | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  const raw = m[1]!;
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null; // both halves must be non-empty
  const tokenId = raw.slice(0, dot);
  if (!/^[A-Za-z0-9_-]+$/.test(tokenId)) return null; // non-secret base64url id
  return { tokenId, secret: raw.slice(dot + 1) };
}

export interface BearerIdentity {
  userId: number;
  tokenId: string;
}

/**
 * Authenticate a CLI bearer token for upload/list/delete. Runs a per-IP flood
 * gate + ban check BEFORE the DB lookup (the token id is attacker-chosen, so the
 * per-token limit alone can't bound unknown-token floods), then a constant-time
 * hash compare over an always-fetched row with a DUMMY_HASH fallback so unknown,
 * malformed, and wrong-secret tokens are timing-indistinguishable. A revoked
 * token is rejected on all bearer endpoints. Returns the identity or an opaque
 * rejection Response. Deliberately does NOT call isCrossSite — non-browser
 * clients legitimately pass it; the bearer secret is the only gate.
 */
export async function authBearer(
  req: Request,
  directIp?: string,
): Promise<BearerIdentity | Response> {
  const ip = clientIp(req, directIp);
  if (await isBanned(hashIp(ip))) return forbidden();
  // Per-IP circuit breaker on DB-lookup load (the token id is attacker-chosen, so
  // this — not the per-token limit — bounds unknown-token floods). Sized at the
  // CLI ceiling so a legitimate burst from one box isn't throttled.
  if (!checkRateLimit(`cli:ip:${ip}`, Date.now(), CLI_RATE_MAX)) return rateLimited();

  const parsed = parseBearer(req.headers.get("authorization"));
  const sql = getSql();
  const rows = await sql`
    SELECT user_id, auth_secret_hash, revoked_at
    FROM cli_tokens WHERE token_id = ${parsed?.tokenId ?? ""}
  `;
  const storedHash = rows[0]?.auth_secret_hash ?? DUMMY_HASH;
  const presentedHash = parsed ? sha256hex(parsed.secret) : DUMMY_HASH;
  const authed = rows.length > 0 && constantTimeEqual(presentedHash, storedHash);
  // revoke = stop the box: a revoked token fails auth on every bearer endpoint.
  if (!authed || rows[0]!.revoked_at !== null) return unauthorized();

  const tokenId = parsed!.tokenId;
  if (!checkRateLimit(`cli:${tokenId}`, Date.now(), CLI_RATE_MAX)) return rateLimited();

  const now = Date.now();
  if (now - (lastUsedAt.get(tokenId) ?? 0) >= LAST_USED_THROTTLE_MS) {
    lastUsedAt.set(tokenId, now);
    // Non-critical audit write — a transient failure must not abort an otherwise
    // valid authenticated request.
    try {
      await sql`UPDATE cli_tokens SET last_used_at = now() WHERE token_id = ${tokenId}`;
    } catch {
      /* ignore: last_used_at is best-effort */
    }
  }
  return { userId: Number(rows[0]!.user_id), tokenId };
}

/**
 * POST /api/cli/tokens — mint a per-box token. The client generated the machine
 * key and wrapped it under the account key; we store that blob plus the hash of a
 * fresh auth secret, and return the (tokenId, authSecret) pair exactly once.
 */
export async function handleMintToken(req: Request): Promise<Response> {
  if (isCrossSite(req)) return forbidden();
  const userId = await userIdFromRequest(req);
  if (userId === null) return unauthorized();

  let body: { label?: unknown; wrappedMachineKey?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest();
  }
  if (!isWrappedKey(body.wrappedMachineKey)) return badRequest();
  const label = typeof body.label === "string" ? body.label.slice(0, 200) : null;

  const sql = getSql();
  // Minting against a not-yet-set-up account would store a machine key wrapped
  // under a key that doesn't exist — an undecryptable orphan. Require the account.
  const acct = await sql`SELECT 1 FROM account_keys WHERE user_id = ${userId}`;
  if (acct.length === 0) return badRequest();

  const tokenId = randomToken(16); // non-secret lookup id
  const authSecret = randomToken(20); // ≥160-bit secret half
  const authSecretHash = sha256hex(authSecret);

  await sql`
    INSERT INTO cli_tokens (token_id, user_id, auth_secret_hash, wrapped_machine_key, label)
    VALUES (${tokenId}, ${userId}, ${authSecretHash}, ${body.wrappedMachineKey}, ${label})
  `;

  const payload: MintTokenResponse = { tokenId, authSecret };
  return Response.json(payload, { status: 201 });
}

/**
 * GET /api/cli/tokens — list the session user's tokens. Includes revoked tokens
 * (with their wrapped machine key) so the web app can still decrypt a revoked
 * box's past uploads. Never returns the auth-secret hash.
 */
export async function handleListTokens(req: Request): Promise<Response> {
  const userId = await userIdFromRequest(req);
  if (userId === null) return unauthorized();

  const rows = await getSql()`
    SELECT token_id, label, created_at, last_used_at, revoked_at, wrapped_machine_key
    FROM cli_tokens
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `;
  const tokens: CliTokenSummary[] = rows.map((r: any) => ({
    tokenId: r.token_id,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revoked: r.revoked_at !== null,
    wrappedMachineKey: r.wrapped_machine_key,
  }));
  const payload: ListTokensResponse = { tokens };
  return Response.json(payload);
}

/**
 * DELETE /api/cli/tokens/:id — soft-revoke a token owned by the session user.
 * Idempotent: unknown / already-revoked / other-user's tokens all return the same
 * opaque ok without revealing which case applied. Revoke is soft (revoked_at) so
 * the row — and its machine key — survive for the decrypt path.
 */
export async function handleRevokeToken(req: Request, tokenId: string): Promise<Response> {
  if (isCrossSite(req)) return forbidden();
  const userId = await userIdFromRequest(req);
  if (userId === null) return unauthorized();

  await getSql()`
    UPDATE cli_tokens SET revoked_at = now()
    WHERE token_id = ${tokenId} AND user_id = ${userId} AND revoked_at IS NULL
  `;
  return Response.json({ ok: true });
}
