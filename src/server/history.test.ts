import { test, expect, afterAll, beforeEach } from "bun:test";
import { migrate } from "./migrate";
import { getSql, closeSql } from "./db";
import { handleCreateShare, handleFetchShare } from "./shares";
import { handleListHistory, handleDeleteHistory, handleReconcile, handleUpdateHistory } from "./history";
import { upsertUser } from "./oauth-github";
import { createSession, SESSION_COOKIE } from "./sessions";
import { resetRateLimits } from "./abuse";
import { generateShareId, generateContentKey, encryptSession } from "../share-crypto";

const dbTest = process.env.DATABASE_URL ? test : test.skip;
beforeEach(() => resetRateLimits());
afterAll(async () => {
  if (process.env.DATABASE_URL) await closeSql();
});

function randomGithubId(): number {
  return 600_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 100_000_000);
}
async function authCookie(): Promise<{ cookie: string; userId: number }> {
  const userId = await upsertUser(randomGithubId());
  const sid = await createSession(userId);
  return { cookie: `${SESSION_COOKIE}=${sid}`, userId };
}
function getReq(path: string, cookie: string | null): Request {
  const headers: Record<string, string> = { host: "localhost" };
  if (cookie) headers.cookie = cookie;
  return new Request(`http://localhost${path}`, { headers });
}

async function createShareReq(
  cookie: string | null,
  wrapped: object | null,
): Promise<{ id: string; res: Response }> {
  const id = generateShareId();
  const key = await generateContentKey();
  const env = await encryptSession("session payload", key, id);
  const headers: Record<string, string> = {
    host: "localhost",
    "content-type": "application/json",
  };
  if (cookie) headers.cookie = cookie;
  const body: Record<string, unknown> = { id, v: env.v, iv: env.iv, ct: env.ct };
  if (wrapped) body.wrappedContentKey = wrapped;
  const req = new Request("http://localhost/api/shares", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const res = await handleCreateShare(req, "10.0.0.1");
  return { id, res };
}

dbTest("a logged-in create lands in history atomically; anonymous does not", async () => {
  await migrate();
  const { cookie } = await authCookie();
  const wrapped = { iv: "AAAA", ct: "BBBB" };

  const { id, res } = await createShareReq(cookie, wrapped);
  expect(res.status).toBe(201);

  const sql = getSql();
  // both rows exist (one transaction)
  const share = await sql`SELECT owner_user_id FROM shares WHERE id = ${id}`;
  expect(share[0]!.owner_user_id).not.toBeNull();
  const hist = await sql`SELECT wrapped_content_key FROM history_keys WHERE share_id = ${id}`;
  expect(hist.length).toBe(1);
  expect(hist[0]!.wrapped_content_key).toEqual(wrapped);

  // anonymous create writes no history row
  const anon = await createShareReq(null, null);
  const noHist = await sql`SELECT 1 FROM history_keys WHERE share_id = ${anon.id}`;
  expect(noHist.length).toBe(0);
});

dbTest("history is scoped to the session user, with metadata + wrapped key", async () => {
  await migrate();
  const a = await authCookie();
  const b = await authCookie();
  const { id } = await createShareReq(a.cookie, { iv: "i", ct: "c" });

  const listA = (await (await handleListHistory(getReq("/api/history", a.cookie))).json()) as {
    items: { shareId: string; wrappedContentKey: unknown; state: string }[];
  };
  expect(listA.items.some((it) => it.shareId === id)).toBe(true);
  expect(listA.items[0]!.wrappedContentKey).toEqual({ iv: "i", ct: "c" });
  expect(listA.items[0]!.state).toBe("active");

  const listB = (await (await handleListHistory(getReq("/api/history", b.cookie))).json()) as {
    items: unknown[];
  };
  expect(listB.items.some((it: any) => it.shareId === id)).toBe(false);

  // unauthenticated history is rejected
  expect((await handleListHistory(getReq("/api/history", null))).status).toBe(401);
});

function deleteHistoryReq(cookie: string | null, shareId: string): Request {
  const headers: Record<string, string> = { host: "localhost" };
  if (cookie) headers.cookie = cookie;
  return new Request(`http://localhost/api/history/${shareId}`, { method: "DELETE", headers });
}

dbTest("delete-from-history tombstones an OWNED share and removes the history row", async () => {
  await migrate();
  const { cookie } = await authCookie();
  const { id } = await createShareReq(cookie, { iv: "i", ct: "c" }); // owned (logged-in create)

  const del = await handleDeleteHistory(deleteHistoryReq(cookie, id), id);
  expect(del.status).toBe(200);

  const sql = getSql();
  expect((await sql`SELECT 1 FROM history_keys WHERE share_id = ${id}`).length).toBe(0);
  // the owned share's ciphertext is now tombstoned — no orphaned ciphertext (R12)
  const row = await sql`SELECT state, ciphertext IS NULL AS gone FROM shares WHERE id = ${id}`;
  expect(row[0]!.state).toBe("deleted");
  expect(row[0]!.gone).toBe(true);
  expect((await handleFetchShare(id)).status).toBe(404);
});

dbTest("delete-from-history of a NOT-owned (reconciled anonymous) share leaves the share intact", async () => {
  await migrate();
  const { cookie } = await authCookie();
  const { id } = await createShareReq(null, null); // anonymous share
  await handleReconcile(reconcileReq(cookie, id, { iv: "x", ct: "y" })); // user bookmarks it

  const del = await handleDeleteHistory(deleteHistoryReq(cookie, id), id);
  expect(del.status).toBe(200);

  const sql = getSql();
  // history link removed, but the un-owned share's ciphertext is untouched
  expect((await sql`SELECT 1 FROM history_keys WHERE share_id = ${id}`).length).toBe(0);
  expect((await handleFetchShare(id)).status).toBe(200);
});

dbTest("deleting the share cascade-removes its history row (no orphan)", async () => {
  await migrate();
  const { cookie } = await authCookie();
  const { id } = await createShareReq(cookie, { iv: "i", ct: "c" });

  const sql = getSql();
  await sql`DELETE FROM shares WHERE id = ${id}`; // physical delete → FK cascade
  expect((await sql`SELECT 1 FROM history_keys WHERE share_id = ${id}`).length).toBe(0);
});

function reconcileReq(cookie: string | null, shareId: string, wrapped: object): Request {
  const headers: Record<string, string> = {
    host: "localhost",
    "content-type": "application/json",
  };
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost/api/reconcile", {
    method: "POST",
    headers,
    body: JSON.stringify({ shareId, wrappedContentKey: wrapped }),
  });
}

dbTest("reconcile is idempotent, never claims ownership, leaves the share decryptable", async () => {
  await migrate();
  const { cookie } = await authCookie();
  // an anonymous share (created the Phase-A way, no wrapped key)
  const { id } = await createShareReq(null, null);
  const sql = getSql();
  expect((await sql`SELECT owner_user_id FROM shares WHERE id = ${id}`)[0]!.owner_user_id).toBeNull();

  const a = await handleReconcile(reconcileReq(cookie, id, { iv: "x", ct: "y" }));
  expect(a.status).toBe(200);
  const b = await handleReconcile(reconcileReq(cookie, id, { iv: "x", ct: "y" }));
  expect(b.status).toBe(200);

  // exactly one history row; share stays anonymous and still fetchable
  expect((await sql`SELECT 1 FROM history_keys WHERE share_id = ${id}`).length).toBe(1);
  expect((await sql`SELECT owner_user_id FROM shares WHERE id = ${id}`)[0]!.owner_user_id).toBeNull();
  expect((await handleFetchShare(id)).status).toBe(200);
});

dbTest("concurrent reconcile of the same share yields exactly one row", async () => {
  await migrate();
  const { cookie } = await authCookie();
  const { id } = await createShareReq(null, null);

  await Promise.all([
    handleReconcile(reconcileReq(cookie, id, { iv: "x", ct: "y" })),
    handleReconcile(reconcileReq(cookie, id, { iv: "x", ct: "y" })),
  ]);
  const rows = await getSql()`SELECT 1 FROM history_keys WHERE share_id = ${id}`;
  expect(rows.length).toBe(1);
});

dbTest("AE2 (web side): a revoked token's uploads still carry the machine key in history", async () => {
  await migrate();
  const { cookie, userId } = await authCookie();
  // simulate a CLI upload by writing the rows directly: a cli_token + a tagged
  // history row, then revoke the token.
  const sql = getSql();
  const tokenId = `tok-${Math.abs(crypto.getRandomValues(new Int32Array(1))[0]!)}`;
  const wmk = { iv: "mIv", ct: "mCt" };
  await sql`
    INSERT INTO cli_tokens (token_id, user_id, auth_secret_hash, wrapped_machine_key, label)
    VALUES (${tokenId}, ${userId}, ${"0".repeat(64)}, ${wmk}, 'box')
  `;
  const { id } = await createShareReq(null, null); // an anonymous share to attach to
  await sql`
    INSERT INTO history_keys (user_id, share_id, wrapped_content_key, cli_token_id)
    VALUES (${userId}, ${id}, ${{ iv: "cIv", ct: "cCt" }}, ${tokenId})
  `;
  // revoke the token
  await sql`UPDATE cli_tokens SET revoked_at = now() WHERE token_id = ${tokenId}`;

  const list = (await (await handleListHistory(getReq("/api/history", cookie))).json()) as {
    items: any[];
  };
  const item = list.items.find((it) => it.shareId === id)!;
  expect(item.cliTokenId).toBe(tokenId);
  // the revoked token's machine key is STILL returned, so past uploads decrypt
  expect(item.wrappedMachineKey).toEqual(wmk);
});

dbTest("reconcile of a missing share is skipped; unauthenticated is rejected", async () => {
  await migrate();
  const { cookie } = await authCookie();

  const missing = await handleReconcile(reconcileReq(cookie, generateShareId(), { iv: "x", ct: "y" }));
  expect(missing.status).toBe(200);
  expect((await missing.json()).skipped).toBe(true);

  expect((await handleReconcile(reconcileReq(null, generateShareId(), { iv: "x", ct: "y" }))).status).toBe(401);
});

function patchReq(cookie: string | null, shareId: string, body: object): Request {
  const headers: Record<string, string> = { host: "localhost", "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request(`http://localhost/api/history/${shareId}`, {
    method: "PATCH", headers, body: JSON.stringify(body),
  });
}
async function createPrivate(cookie: string): Promise<string> {
  const id = generateShareId();
  const key = await generateContentKey();
  const env = await encryptSession("payload", key, id);
  const req = new Request("http://localhost/api/shares", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", cookie },
    body: JSON.stringify({ id, v: env.v, iv: env.iv, ct: env.ct, wrappedContentKey: { iv: "i", ct: "c" }, private: true }),
  });
  await handleCreateShare(req, "10.0.0.3");
  return id;
}

dbTest("toggle private→active makes the share resolve; active→private hides it; ciphertext preserved", async () => {
  await migrate();
  const { cookie } = await authCookie();
  const id = await createPrivate(cookie);
  expect((await handleFetchShare(id)).status).toBe(404); // starts private

  expect((await handleUpdateHistory(patchReq(cookie, id, { state: "active" }), id)).status).toBe(200);
  expect((await handleFetchShare(id)).status).toBe(200); // now shared

  expect((await handleUpdateHistory(patchReq(cookie, id, { state: "private" }), id)).status).toBe(200);
  expect((await handleFetchShare(id)).status).toBe(404); // hidden again

  const row = await getSql()`SELECT ciphertext IS NOT NULL AS has_ct FROM shares WHERE id = ${id}`;
  expect(row[0]!.has_ct).toBe(true); // toggling never nulls ciphertext
});

dbTest("rename updates the share's encrypted_title for the owner", async () => {
  await migrate();
  const { cookie } = await authCookie();
  const id = await createPrivate(cookie);
  expect((await handleUpdateHistory(patchReq(cookie, id, { encryptedTitle: "ENC-TITLE" }), id)).status).toBe(200);
  const row = await getSql()`SELECT encrypted_title FROM shares WHERE id = ${id}`;
  expect(row[0]!.encrypted_title).toBe("ENC-TITLE");
});

dbTest("a combined PATCH updates both state and encrypted_title atomically", async () => {
  await migrate();
  const { cookie } = await authCookie();
  const id = await createPrivate(cookie);

  expect((await handleUpdateHistory(patchReq(cookie, id, { state: "active", encryptedTitle: "BOTH" }), id)).status).toBe(200);
  expect((await handleFetchShare(id)).status).toBe(200); // now shared
  const row = await getSql()`SELECT state, encrypted_title FROM shares WHERE id = ${id}`;
  expect(row[0]!.state).toBe("active");
  expect(row[0]!.encrypted_title).toBe("BOTH");
});

dbTest("PATCH guards: non-owner is a no-op, bad state / deleted / cross-site / logged-out are rejected", async () => {
  await migrate();
  const owner = await authCookie();
  const other = await authCookie();
  const id = await createPrivate(owner.cookie);

  // a different user cannot change the state (no-op; share stays private)
  expect((await handleUpdateHistory(patchReq(other.cookie, id, { state: "active" }), id)).status).toBe(200);
  expect((await handleFetchShare(id)).status).toBe(404);

  // invalid target state
  expect((await handleUpdateHistory(patchReq(owner.cookie, id, { state: "deleted" }), id)).status).toBe(400);

  // logged out
  expect((await handleUpdateHistory(patchReq(null, id, { state: "active" }), id)).status).toBe(401);

  // cross-site (forged Origin)
  const xreq = new Request(`http://localhost/api/history/${id}`, {
    method: "PATCH",
    headers: { host: "localhost", "content-type": "application/json", cookie: owner.cookie, origin: "https://evil.test" },
    body: JSON.stringify({ state: "active" }),
  });
  expect((await handleUpdateHistory(xreq, id)).status).toBe(403);
});
