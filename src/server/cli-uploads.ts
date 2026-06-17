// Token-authed, zero-knowledge CLI uploads (plan U3) + list/delete (U4).
// Server-only — stores ciphertext the CLI encrypted on the box; the content key
// is wrapped under the box's machine key, so the server can never read it.

import { getSql } from "./db";
import { ID_RE, MAX_CIPHERTEXT_BYTES, sha256hex, isWrappedKey } from "./shares";
import { authBearer } from "./cli-tokens";
import { tombstoneOwnedShare } from "./history";
import { randomToken } from "./sessions";
import type {
  CliUploadResponse,
  CliListResponse,
  CliUploadSummary,
} from "../wire-types";

const badRequest = () => Response.json({ error: "bad_request" }, { status: 400 });
const conflict = () => Response.json({ error: "conflict" }, { status: 409 });
const temporarilyUnavailable = () =>
  Response.json({ error: "temporarily_unavailable" }, { status: 503 });

/** Postgres unique_violation SQLSTATE — Bun.sql surfaces it on `err.errno`. */
const PG_UNIQUE_VIOLATION = "23505";

/**
 * POST /api/cli/uploads — create an owned, never-expiring, zero-knowledge share
 * from the CLI. Mirrors the owner branch of handleCreateShare: the share row and
 * its history_keys row (tagged with the token id, content key wrapped under the
 * machine key) are written in one transaction. A client-chosen id colliding with
 * any existing share rolls the whole transaction back and returns an opaque 409 —
 * no history row is written, and own vs foreign collisions are indistinguishable.
 */
export async function handleCliUpload(
  req: Request,
  directIp?: string,
): Promise<Response> {
  const auth = await authBearer(req, directIp);
  if (auth instanceof Response) return auth;
  const { userId, tokenId } = auth;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return badRequest();
  }

  const { id, v, iv, ct } = body;
  const encryptedTitle =
    typeof body.encryptedTitle === "string" ? body.encryptedTitle : null;
  if (
    typeof id !== "string" ||
    !ID_RE.test(id) ||
    typeof v !== "number" ||
    typeof iv !== "string" ||
    typeof ct !== "string" ||
    !isWrappedKey(body.wrappedContentKey)
  ) {
    return badRequest();
  }

  const ctBytes = Buffer.from(ct, "base64url");
  if (ctBytes.length === 0 || ctBytes.length > MAX_CIPHERTEXT_BYTES) {
    return badRequest();
  }

  // admin_token_hash is NOT NULL; CLI uploads are deleted via owner auth, so we
  // store a hash of a discarded random token purely to satisfy the constraint.
  const adminTokenHash = sha256hex(randomToken(32));

  const sql = getSql();
  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO shares
          (id, ciphertext, iv, aad, encrypted_title, size_bytes, state,
           expires_at, admin_token_hash, owner_user_id)
        VALUES
          (${id}, ${ctBytes}, ${iv}, ${{ v }}, ${encryptedTitle},
           ${ctBytes.length}, 'active', ${null}, ${adminTokenHash}, ${userId})
      `;
      await tx`
        INSERT INTO history_keys (user_id, share_id, wrapped_content_key, cli_token_id)
        VALUES (${userId}, ${id}, ${body.wrappedContentKey}, ${tokenId})
      `;
    });
  } catch (err) {
    // A PK collision (own or foreign id) is the expected case → opaque 409 after a
    // full rollback (no history row written). Any other DB error is transient, so
    // return a retryable 503 rather than misreporting it as a permanent conflict.
    if ((err as { errno?: string })?.errno === PG_UNIQUE_VIOLATION) return conflict();
    return temporarilyUnavailable();
  }

  const payload: CliUploadResponse = { id };
  return Response.json(payload, { status: 201 });
}

/**
 * GET /api/cli/uploads — list this box's uploads (Bearer). Scoped to the
 * authenticating token: each upload's content key is wrapped under that token's
 * machine key, so only this box can decrypt them — listing other boxes' uploads
 * would surface entries this box can't read. The web app (with the account key)
 * is where every box's uploads are visible together.
 */
export async function handleCliList(req: Request, directIp?: string): Promise<Response> {
  const auth = await authBearer(req, directIp);
  if (auth instanceof Response) return auth;

  const rows = await getSql()`
    SELECT h.share_id, s.encrypted_title, s.size_bytes, s.created_at, s.state,
           h.wrapped_content_key
    FROM history_keys h
    JOIN shares s ON s.id = h.share_id
    WHERE h.user_id = ${auth.userId} AND h.cli_token_id = ${auth.tokenId}
    ORDER BY s.created_at DESC
  `;
  const items: CliUploadSummary[] = rows.map((r: any) => ({
    shareId: r.share_id,
    encryptedTitle: r.encrypted_title,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
    state: r.state,
    wrappedContentKey: r.wrapped_content_key,
  }));
  const payload: CliListResponse = { items };
  return Response.json(payload);
}

/**
 * DELETE /api/cli/uploads/:id — tombstone an owned upload (Bearer). Reuses the
 * shared owner-authed tombstone: ciphertext is nulled and the history row removed
 * in one transaction. Opaque and idempotent for unknown / non-owned ids.
 */
export async function handleCliDelete(
  req: Request,
  shareId: string,
  directIp?: string,
): Promise<Response> {
  const auth = await authBearer(req, directIp);
  if (auth instanceof Response) return auth;
  await tombstoneOwnedShare(auth.userId, shareId);
  return Response.json({ ok: true });
}
