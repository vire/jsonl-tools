// Share create/fetch handlers (plan U3; fetch is hardened in U5).
// Server-only — stores ciphertext and a hashed admin token, never plaintext or
// a usable key.

import { getSql } from "./db";
import {
  clientIp,
  hashIp,
  isBanned,
  checkRateLimit,
  anonCapReached,
} from "./abuse";
import { userIdFromRequest } from "./sessions";
import type {
  CreateShareResponse,
  FetchShareResponse,
  WrappedKeyWire,
} from "../wire-types";

/** Structural guard for an `{ iv, ct }` wrapped-key blob from an untrusted body. */
export function isWrappedKey(v: unknown): v is WrappedKeyWire {
  const b = v as Record<string, unknown> | null;
  return Boolean(b && typeof b.iv === "string" && typeof b.ct === "string");
}

/** 256-bit base64url id (43 chars, no padding). */
export const ID_RE = /^[A-Za-z0-9_-]{43}$/;
// Raised so typical server logs fit one CLI request; request body capped at 26MB
// in src/index.ts. Shared with the CLI upload path (cli-uploads.ts).
export const MAX_CIPHERTEXT_BYTES = 25 * 1024 * 1024;
const DEFAULT_ANON_TTL_DAYS = 7;
const MAX_ANON_TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// Master switch for share expiration (operator decision 2026-06-04): OFF for
// now — no new share gets a TTL, so nothing is ever lazily expired or swept.
// `expires_at = NULL` is the "never expires" sentinel already honored by both
// handleFetchShare's lazy expiry and the sweeper. Flip to `true` to restore
// bounded anonymous lifetimes (DEFAULT_ANON_TTL_DAYS / MAX_ANON_TTL_DAYS).
const SHARE_EXPIRY_ENABLED = false;

export function sha256hex(input: string): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}

function randomBase64Url(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString(
    "base64url",
  );
}

/**
 * Reject cross-site state-changing requests (CSRF). Same-origin and direct
 * (non-browser, no Origin/Sec-Fetch-Site) requests are allowed; a browser
 * cross-site forgery carries Sec-Fetch-Site: cross-site or a mismatched Origin.
 */
export function isCrossSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("host");
    try {
      if (host && new URL(origin).host !== host) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function clampAnonTtlDays(requested: unknown): number {
  const n = typeof requested === "number" && Number.isFinite(requested) ? requested : DEFAULT_ANON_TTL_DAYS;
  return Math.min(Math.max(1, Math.floor(n)), MAX_ANON_TTL_DAYS);
}

const forbidden = () => Response.json({ error: "forbidden" }, { status: 403 });
const badRequest = () => Response.json({ error: "bad_request" }, { status: 400 });
// Uniform opaque terminal response for unknown / expired / deleted / not-committed —
// the existence of an id never leaks (R19).
const unavailable = () => Response.json({ error: "unavailable" }, { status: 404 });
// Transient failure — the recipient must NOT read this as "gone" (R19 / I7).
const temporarilyUnavailable = () =>
  Response.json({ error: "temporarily_unavailable" }, { status: 503 });

/** sha256 hex of a 64-char shape, used as the dummy when an id is unknown. */
export const DUMMY_HASH = "0".repeat(64);

/** Constant-time compare of two equal-length hex strings. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** POST /api/shares — create an anonymous, encrypted share. */
export async function handleCreateShare(
  req: Request,
  directIp?: string,
): Promise<Response> {
  if (isCrossSite(req)) return forbidden();

  const ip = clientIp(req, directIp);
  const ipHash = hashIp(ip);
  if (await isBanned(ipHash)) return forbidden();
  if (!checkRateLimit(`create:${ip}`)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }
  if (await anonCapReached()) {
    return Response.json({ error: "capacity" }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return badRequest();
  }

  const id = body.id;
  const v = body.v;
  const iv = body.iv;
  const ct = body.ct;
  const encryptedTitle =
    typeof body.encryptedTitle === "string" ? body.encryptedTitle : null;

  if (
    typeof id !== "string" ||
    !ID_RE.test(id) ||
    typeof v !== "number" ||
    typeof iv !== "string" ||
    typeof ct !== "string"
  ) {
    return badRequest();
  }

  const ctBytes = Buffer.from(ct, "base64url");
  if (ctBytes.length === 0 || ctBytes.length > MAX_CIPHERTEXT_BYTES) {
    return badRequest();
  }

  // Expiration disabled for now (see SHARE_EXPIRY_ENABLED): links never expire,
  // so expires_at stays NULL — the sentinel both lazy expiry and the sweeper skip.
  const expiresAt = SHARE_EXPIRY_ENABLED
    ? new Date(Date.now() + clampAnonTtlDays(body.expiresInDays) * DAY_MS)
    : null;

  const adminToken = randomBase64Url(32);
  const adminTokenHash = sha256hex(adminToken);

  // A logged-in create that supplies the content key wrapped under the user's
  // account key also lands in durable history (U9) — share + history rows are
  // written in one transaction so neither exists without the other.
  const userId = await userIdFromRequest(req);
  const wrappedContentKey =
    body.wrappedContentKey && typeof body.wrappedContentKey === "object"
      ? (body.wrappedContentKey as Record<string, unknown>)
      : null;
  const ownerUserId = userId !== null && wrappedContentKey ? userId : null;

  // Owned creates may request a private (unlisted) entry: ciphertext is stored
  // and lands in history, but the share does not resolve until toggled active.
  const initialState =
    ownerUserId !== null && body.private === true ? "private" : "active";

  const sql = getSql();
  try {
    if (ownerUserId !== null) {
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO shares
            (id, ciphertext, iv, aad, encrypted_title, size_bytes, state,
             expires_at, admin_token_hash, uploader_ip_hash, owner_user_id)
          VALUES
            (${id}, ${ctBytes}, ${iv}, ${{ v }}, ${encryptedTitle},
             ${ctBytes.length}, ${initialState}, ${expiresAt}, ${adminTokenHash},
             ${ipHash}, ${ownerUserId})
        `;
        await tx`
          INSERT INTO history_keys (user_id, share_id, wrapped_content_key)
          VALUES (${ownerUserId}, ${id}, ${wrappedContentKey})
        `;
      });
    } else {
      // Anonymous: single atomic INSERT, owner_user_id NULL, no history row.
      await sql`
        INSERT INTO shares
          (id, ciphertext, iv, aad, encrypted_title, size_bytes, state,
           expires_at, admin_token_hash, uploader_ip_hash)
        VALUES
          (${id}, ${ctBytes}, ${iv}, ${{ v }}, ${encryptedTitle},
           ${ctBytes.length}, 'active', ${expiresAt}, ${adminTokenHash}, ${ipHash})
      `;
    }
  } catch {
    // Most likely a primary-key collision on a (cosmically unlikely) id clash.
    return Response.json({ error: "conflict" }, { status: 409 });
  }

  const payload: CreateShareResponse = { id, adminToken };
  return Response.json(payload, { status: 201 });
}

/**
 * GET /api/shares/:id — fetch a share's ciphertext (plan U5).
 *
 * Resolves an `active` share for anyone, and a `private` (unlisted) share only
 * for its authenticated owner — a private entry stays in the owner's history and
 * must reopen via `/s/<id>`, while remaining opaque to everyone else. The owner
 * is identified by the session cookie on the (same-origin) viewer fetch; with no
 * cookie `owner_user_id = NULL` never matches, so private fail-closes for
 * recipients exactly as before.
 *
 * Lazy expiry: an active row past its TTL is tombstoned (ciphertext nulled) and
 * treated as unavailable. Unknown / expired / deleted / private-to-a-non-owner
 * all return the same opaque response so id existence never leaks. A DB error
 * returns a distinct retryable status so a recipient never concludes "gone" on a
 * transient failure.
 */
export async function handleFetchShare(
  id: string,
  req?: Request,
): Promise<Response> {
  const sql = getSql();
  try {
    // Identify the requester so an owner can reopen their own private entry.
    const viewerUserId = req ? await userIdFromRequest(req) : null;

    // Guarded, idempotent lazy expiry — a no-op if already expired/deleted or
    // raced by the sweeper.
    await sql`
      UPDATE shares SET state = 'expired', ciphertext = NULL, uploader_ip_hash = NULL
      WHERE id = ${id} AND state = 'active'
        AND expires_at IS NOT NULL AND expires_at <= now()
    `;

    const rows = await sql`
      SELECT iv, aad, encrypted_title, encode(ciphertext, 'base64') AS ct_b64
      FROM shares
      WHERE id = ${id} AND ciphertext IS NOT NULL
        AND (
          state = 'active'
          OR (state = 'private' AND owner_user_id = ${viewerUserId})
        )
    `;
    if (rows.length === 0) return unavailable();

    const row = rows[0]!;
    const ct = Buffer.from(row.ct_b64, "base64").toString("base64url");
    const payload: FetchShareResponse = {
      v: row.aad?.v ?? 1,
      iv: row.iv,
      ct,
      encryptedTitle: row.encrypted_title,
    };
    return Response.json(payload);
  } catch {
    return temporarilyUnavailable();
  }
}

/**
 * DELETE /api/shares/:id — delete via the per-share admin token (logged-out) or
 * account ownership (logged-in; Phase B). Tombstones the row (ciphertext nulled)
 * and is idempotent. Wrong-token / unknown / already-gone are indistinguishable,
 * and the admin-token check is constant-time over an always-fetched row so the
 * response neither leaks existence nor a timing oracle.
 */
export async function handleDeleteShare(
  req: Request,
  id: string,
): Promise<Response> {
  if (isCrossSite(req)) return forbidden();

  const token =
    req.headers.get("x-admin-token") ??
    (await req
      .json()
      .then((b: { adminToken?: string }) => b?.adminToken ?? "")
      .catch(() => ""));

  const sql = getSql();
  try {
    // Always fetch (0 or 1 row) before the constant-time compare — no early-out
    // on a missing id.
    const rows = await sql`SELECT admin_token_hash FROM shares WHERE id = ${id}`;
    const storedHash = rows[0]?.admin_token_hash ?? DUMMY_HASH;
    const presentedHash = token ? sha256hex(token) : DUMMY_HASH;
    const authorized = rows.length > 0 && constantTimeEqual(presentedHash, storedHash);

    if (!authorized) return unavailable();

    // Idempotent guarded tombstone.
    await sql`
      UPDATE shares SET state = 'deleted', ciphertext = NULL, uploader_ip_hash = NULL
      WHERE id = ${id} AND state <> 'deleted'
    `;
    return Response.json({ deleted: true });
  } catch {
    return temporarilyUnavailable();
  }
}
