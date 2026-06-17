// Server-side storage for zero-knowledge account-key blobs (plan U8).
//
// Every read/write derives the user from the session cookie only — never a
// client-supplied id (R24). The server holds wrapped blobs it cannot use; the
// recovery-blob fetch and rotation are rate-limited, and rotation requires the
// current auth tag (proof of the current passphrase) so a stolen session alone
// cannot overwrite custody.

import { getSql } from "./db";
import { userIdFromRequest } from "./sessions";
import { isCrossSite } from "./shares";
import { checkRateLimit } from "./abuse";

const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });
const forbidden = () => Response.json({ error: "forbidden" }, { status: 403 });
const badRequest = () => Response.json({ error: "bad_request" }, { status: 400 });
const rateLimited = () => Response.json({ error: "rate_limited" }, { status: 429 });

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function validBlobs(blobs: unknown): boolean {
  const b = blobs as Record<string, unknown> | null;
  return Boolean(
    b && b.kdf && b.wrappedUnderMaster && b.wrappedUnderRecovery && b.verifier,
  );
}

/** POST /api/account — first-time setup. One account_keys row per user. */
export async function handleSetupAccount(req: Request): Promise<Response> {
  if (isCrossSite(req)) return forbidden();
  const userId = await userIdFromRequest(req);
  if (userId === null) return unauthorized();

  let body: { blobs?: unknown; authTag?: unknown; recoveryAuthTag?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest();
  }
  if (!validBlobs(body.blobs) || typeof body.authTag !== "string") return badRequest();
  const blobs = body.blobs as Record<string, unknown>;
  const recoveryAuthTag =
    typeof body.recoveryAuthTag === "string" ? body.recoveryAuthTag : null;

  const rows = await getSql()`
    INSERT INTO account_keys
      (user_id, kdf, wrapped_under_master, wrapped_under_recovery, verifier,
       auth_tag, recovery_auth_tag)
    VALUES
      (${userId}, ${blobs.kdf}, ${blobs.wrappedUnderMaster},
       ${blobs.wrappedUnderRecovery}, ${blobs.verifier}, ${body.authTag},
       ${recoveryAuthTag})
    ON CONFLICT (user_id) DO NOTHING
    RETURNING user_id
  `;
  if (rows.length === 0) return Response.json({ error: "exists" }, { status: 409 });
  return Response.json({ ok: true }, { status: 201 });
}

/** GET /api/account — kdf + master-wrapped key + verifier for unlocking. */
export async function handleGetAccount(req: Request): Promise<Response> {
  const userId = await userIdFromRequest(req);
  if (userId === null) return unauthorized();
  const rows = await getSql()`
    SELECT kdf, wrapped_under_master, verifier FROM account_keys WHERE user_id = ${userId}
  `;
  if (rows.length === 0) return Response.json({ error: "no_account" }, { status: 404 });
  const r = rows[0]!;
  return Response.json({
    kdf: r.kdf,
    wrappedUnderMaster: r.wrapped_under_master,
    verifier: r.verifier,
  });
}

/** GET /api/account/recovery — the recovery-wrapped key (authenticated, rate-limited). */
export async function handleGetRecoveryBlob(req: Request): Promise<Response> {
  const userId = await userIdFromRequest(req);
  if (userId === null) return unauthorized();
  if (!checkRateLimit(`recovery:${userId}`)) return rateLimited();
  const rows = await getSql()`
    SELECT wrapped_under_recovery FROM account_keys WHERE user_id = ${userId}
  `;
  if (rows.length === 0) return Response.json({ error: "no_account" }, { status: 404 });
  return Response.json({ wrappedUnderRecovery: rows[0]!.wrapped_under_recovery });
}

/** POST /api/account/rotate — overwrite blobs, gated on the current auth tag. */
export async function handleRotateAccount(req: Request): Promise<Response> {
  if (isCrossSite(req)) return forbidden();
  const userId = await userIdFromRequest(req);
  if (userId === null) return unauthorized();
  if (!checkRateLimit(`rotate:${userId}`)) return rateLimited();

  let body: {
    blobs?: unknown;
    authTag?: unknown;
    currentAuthTag?: unknown;
    recoveryAuthTag?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest();
  }
  if (
    !validBlobs(body.blobs) ||
    typeof body.authTag !== "string" ||
    typeof body.currentAuthTag !== "string"
  ) {
    return badRequest();
  }
  const blobs = body.blobs as Record<string, unknown>;
  const newRecoveryAuthTag =
    typeof body.recoveryAuthTag === "string" ? body.recoveryAuthTag : null;

  const sql = getSql();
  const rows = await sql`
    SELECT auth_tag, recovery_auth_tag FROM account_keys WHERE user_id = ${userId}
  `;
  if (rows.length === 0) return Response.json({ error: "no_account" }, { status: 404 });
  // proof of the current passphrase OR the recovery code (lost-passphrase flow) —
  // a stolen session alone has neither.
  const stored = rows[0]!;
  const authorized =
    constantTimeEqual(body.currentAuthTag, stored.auth_tag) ||
    (stored.recovery_auth_tag !== null &&
      constantTimeEqual(body.currentAuthTag, stored.recovery_auth_tag));
  if (!authorized) return forbidden();

  await sql`
    UPDATE account_keys SET
      kdf = ${blobs.kdf},
      wrapped_under_master = ${blobs.wrappedUnderMaster},
      wrapped_under_recovery = ${blobs.wrappedUnderRecovery},
      verifier = ${blobs.verifier},
      auth_tag = ${body.authTag},
      recovery_auth_tag = ${newRecoveryAuthTag},
      version = version + 1,
      updated_at = now()
    WHERE user_id = ${userId}
  `;
  return Response.json({ ok: true });
}
