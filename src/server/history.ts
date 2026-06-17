// Durable "My History" — list + delete (plan U9). Zero-knowledge: the server
// returns wrapped content keys and an encrypted title it cannot read; the client
// decrypts after unlock. Every query is scoped to the session user (R24).

import { getSql } from "./db";
import { userIdFromRequest } from "./sessions";
import { isCrossSite, isWrappedKey } from "./shares";

const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });
const forbidden = () => Response.json({ error: "forbidden" }, { status: 403 });
const badRequest = () => Response.json({ error: "bad_request" }, { status: 400 });

/**
 * GET /api/history — the session user's saved shares (metadata + wrapped keys).
 * Web shares carry a content key wrapped under the account key (cli_token_id
 * NULL); CLI uploads carry one wrapped under a box's machine key, so each item
 * also surfaces its cli_token_id and that token's account-wrapped machine key.
 * The cli_tokens join includes REVOKED tokens, so a revoked box's past uploads
 * stay decryptable. A structurally-malformed machine-key blob is omitted (NULL)
 * rather than relayed to the browser's crypto layer.
 */
export async function handleListHistory(req: Request): Promise<Response> {
  const userId = await userIdFromRequest(req);
  if (userId === null) return unauthorized();

  const rows = await getSql()`
    SELECT h.share_id, h.wrapped_content_key, h.cli_token_id, ct.wrapped_machine_key,
           s.encrypted_title, s.size_bytes, s.created_at, s.expires_at, s.state
    FROM history_keys h
    JOIN shares s ON s.id = h.share_id
    LEFT JOIN cli_tokens ct ON ct.token_id = h.cli_token_id
    WHERE h.user_id = ${userId}
    ORDER BY s.created_at DESC
  `;

  const items = rows.map((r: any) => ({
    shareId: r.share_id,
    wrappedContentKey: r.wrapped_content_key,
    // null for web shares; set for CLI uploads (decrypt via the machine key)
    cliTokenId: r.cli_token_id ?? null,
    wrappedMachineKey: isWrappedKey(r.wrapped_machine_key)
      ? r.wrapped_machine_key
      : null,
    encryptedTitle: r.encrypted_title,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    // a non-active share (deleted/expired tombstone, or a still-private entry)
    // renders as "unavailable" to recipients; the row stays in the owner's history
    state: r.state,
  }));
  return Response.json({ items });
}

/**
 * POST /api/reconcile — add an anonymous device-local share to durable history
 * (plan U10). Per-item, idempotent (first-writer-wins), and never claims share
 * ownership — the share stays anonymous; the user just gains a durable wrapped
 * key. Safe to retry: re-reconcile is a no-op; a since-purged share is skipped.
 */
export async function handleReconcile(req: Request): Promise<Response> {
  if (isCrossSite(req)) return forbidden();
  const userId = await userIdFromRequest(req);
  if (userId === null) return unauthorized();

  let body: { shareId?: unknown; wrappedContentKey?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest();
  }
  if (typeof body.shareId !== "string" || !isWrappedKey(body.wrappedContentKey)) {
    return badRequest();
  }

  try {
    await getSql()`
      INSERT INTO history_keys (user_id, share_id, wrapped_content_key)
      VALUES (${userId}, ${body.shareId}, ${body.wrappedContentKey})
      ON CONFLICT (user_id, share_id) DO NOTHING
    `;
  } catch {
    // FK violation: the share no longer exists (expired/purged) — nothing to do.
    return Response.json({ ok: true, skipped: true });
  }
  return Response.json({ ok: true });
}

/**
 * Remove a user's history link AND tombstone the share's ciphertext when the user
 * owns it — in one transaction. The share tombstone is an UPDATE (not a DELETE),
 * so the history_keys FK does NOT cascade; the row must be removed explicitly or
 * a NULL-TTL owned share leaves a permanent "unavailable" entry the sweeper never
 * purges. A reconciled anonymous share (owner_user_id NULL) keeps its existing
 * behavior: the history link is removed, the share itself is left untouched.
 * Ownership is filtered in the UPDATE's WHERE so the operation is opaque,
 * idempotent, and never tombstones a share the user doesn't own.
 */
export async function tombstoneOwnedShare(
  userId: number,
  shareId: string,
): Promise<void> {
  await getSql().begin(async (tx) => {
    await tx`
      DELETE FROM history_keys WHERE user_id = ${userId} AND share_id = ${shareId}
    `;
    await tx`
      UPDATE shares SET state = 'deleted', ciphertext = NULL, uploader_ip_hash = NULL
      WHERE id = ${shareId} AND owner_user_id = ${userId} AND state <> 'deleted'
    `;
  });
}

/**
 * PATCH /api/history/:shareId — owner-only edits to a share that lives in the
 * user's history. Scoped to `owner_user_id = userId AND state IN ('active','private')`
 * so it can never un-delete, alter an expired row, or touch a share the user does
 * not own. Body fields (either or both):
 *   { state: 'active' | 'private' }  → the share/unshare toggle (no other state allowed)
 *   { encryptedTitle: string }       → rename (client-encrypted; server cannot read it)
 * Toggling only changes `state`; it never nulls ciphertext (Delete/expiry do that).
 * Opaque `{ ok: true }` — it does not reveal whether a row matched.
 */
export async function handleUpdateHistory(req: Request, shareId: string): Promise<Response> {
  if (isCrossSite(req)) return forbidden();
  const userId = await userIdFromRequest(req);
  if (userId === null) return unauthorized();

  let body: { state?: unknown; encryptedTitle?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest();
  }

  const hasState = body.state !== undefined;
  const hasTitle = typeof body.encryptedTitle === "string" && body.encryptedTitle.length > 0;
  if (hasState && body.state !== "active" && body.state !== "private") return badRequest();
  if (!hasState && !hasTitle) return badRequest();

  await getSql().begin(async (tx) => {
    if (hasTitle) {
      await tx`
        UPDATE shares SET encrypted_title = ${body.encryptedTitle as string}
        WHERE id = ${shareId} AND owner_user_id = ${userId} AND state IN ('active','private')
      `;
    }
    if (hasState) {
      await tx`
        UPDATE shares SET state = ${body.state as string}
        WHERE id = ${shareId} AND owner_user_id = ${userId} AND state IN ('active','private')
      `;
    }
  });
  return Response.json({ ok: true });
}

/** DELETE /api/history/:shareId — remove the history entry and tombstone an owned share. */
export async function handleDeleteHistory(
  req: Request,
  shareId: string,
): Promise<Response> {
  if (isCrossSite(req)) return Response.json({ error: "forbidden" }, { status: 403 });
  const userId = await userIdFromRequest(req);
  if (userId === null) return unauthorized();
  await tombstoneOwnedShare(userId, shareId);
  return Response.json({ ok: true });
}
