import { test, expect, afterAll, beforeEach } from "bun:test";
import { migrate } from "./migrate";
import { getSql, closeSql } from "./db";
import { handleCliUpload, handleCliList, handleCliDelete } from "./cli-uploads";
import { handleMintToken, handleRevokeToken, resetCliAuthThrottle } from "./cli-tokens";
import { handleSetupAccount } from "./account-store";
import { handleFetchShare } from "./shares";
import { sweep } from "./sweeper";
import { upsertUser } from "./oauth-github";
import { createSession, SESSION_COOKIE } from "./sessions";
import { resetRateLimits, hashIp, banIp } from "./abuse";
import { setupAccount } from "../account-crypto";

const dbTest = process.env.DATABASE_URL ? test : test.skip;
const PASS = "correct horse battery staple";
const WMK = { iv: "aXY", ct: "Y3Q" };
const WCK = { iv: "bXZ", ct: "Z3U" };

beforeEach(() => {
  resetRateLimits();
  resetCliAuthThrottle();
});
afterAll(async () => {
  if (process.env.DATABASE_URL) await closeSql();
});

function randomGithubId(): number {
  return 720_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 70_000_000);
}
function shareId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** Mint a token for a fresh unlocked user; returns the bearer credential. */
async function mintToken(): Promise<{ tokenId: string; bearer: string; userId: number }> {
  const userId = await upsertUser(randomGithubId());
  const cookie = `${SESSION_COOKIE}=${await createSession(userId)}`;
  const acct = await setupAccount(PASS);
  await handleSetupAccount(
    new Request("http://localhost/api/account", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json", cookie },
      body: JSON.stringify({ blobs: acct.blobs, authTag: acct.authTag }),
    }),
  );
  const res = await handleMintToken(
    new Request("http://localhost/api/cli/tokens", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json", cookie },
      body: JSON.stringify({ label: "box", wrappedMachineKey: WMK }),
    }),
  );
  const { tokenId, authSecret } = (await res.json()) as { tokenId: string; authSecret: string };
  return { tokenId, bearer: `${tokenId}.${authSecret}`, userId };
}

function uploadReq(
  bearer: string | null,
  body: unknown,
  extra: Record<string, string> = {},
): Request {
  const headers: Record<string, string> = { host: "localhost", "content-type": "application/json", ...extra };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return new Request("http://localhost/api/cli/uploads", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
function payload(id: string, ct = "aGVsbG8") {
  return { id, v: 1, iv: "AAAA", ct, encryptedTitle: null, wrappedContentKey: WCK };
}

dbTest("valid token creates an owned, never-expiring share + tagged history row", async () => {
  await migrate();
  const { tokenId, bearer, userId } = await mintToken();
  const id = shareId();

  const res = await handleCliUpload(uploadReq(bearer, payload(id)), "1.2.3.4");
  expect(res.status).toBe(201);
  expect((await res.json()).id).toBe(id);

  const sql = getSql();
  const share = await sql`SELECT owner_user_id, expires_at, state FROM shares WHERE id = ${id}`;
  expect(Number(share[0]!.owner_user_id)).toBe(userId);
  expect(share[0]!.expires_at).toBeNull();
  expect(share[0]!.state).toBe("active");

  const hk = await sql`SELECT cli_token_id, wrapped_content_key FROM history_keys WHERE share_id = ${id}`;
  expect(hk[0]!.cli_token_id).toBe(tokenId);
  expect(hk[0]!.wrapped_content_key).toEqual(WCK);
});

dbTest("AE2: a revoked token is rejected but its prior upload stays fetchable", async () => {
  await migrate();
  const { tokenId, bearer } = await mintToken();
  const id = shareId();
  expect((await handleCliUpload(uploadReq(bearer, payload(id)), "1.2.3.4")).status).toBe(201);

  // revoke directly
  await getSql()`UPDATE cli_tokens SET revoked_at = now() WHERE token_id = ${tokenId}`;

  // a fresh upload with the revoked token is rejected (opaque 401)
  const after = await handleCliUpload(uploadReq(bearer, payload(shareId())), "1.2.3.4");
  expect(after.status).toBe(401);

  // the already-pushed share is still active and fetchable
  const fetched = await handleFetchShare(id);
  expect(fetched.status).toBe(200);
});

dbTest("malformed / missing / wrong-secret bearer tokens all reject opaquely", async () => {
  await migrate();
  const { tokenId, bearer } = await mintToken();
  const id = shareId();

  const cases = [
    null, // no Authorization header
    "", // empty
    "noseparator", // no dot
    `${tokenId}.`, // empty secret
    `.somesecret`, // empty token id
    `${tokenId}.wrongsecret`, // wrong secret, valid token id
    `bad!chars.secret`, // invalid token-id charset
  ];
  for (const cred of cases) {
    const res = await handleCliUpload(uploadReq(cred, payload(id)), "9.9.9.9");
    expect(res.status).toBe(401);
  }
  // sanity: the valid bearer still works (proves the rejects weren't incidental)
  expect((await handleCliUpload(uploadReq(bearer, payload(id)), "9.9.9.9")).status).toBe(201);
});

dbTest("a banned IP is rejected on the bearer path", async () => {
  await migrate();
  const { bearer } = await mintToken();
  const ip = "203.0.113.7";
  await banIp(hashIp(ip), "test");
  const res = await handleCliUpload(uploadReq(bearer, payload(shareId())), ip);
  expect(res.status).toBe(403);
});

dbTest("a cross-site-headed request with a valid token is accepted", async () => {
  await migrate();
  const { bearer } = await mintToken();
  const res = await handleCliUpload(
    uploadReq(bearer, payload(shareId()), { "sec-fetch-site": "cross-site", origin: "https://evil.example" }),
    "1.2.3.4",
  );
  expect(res.status).toBe(201);
});

dbTest("a client id colliding with another account's share returns 409 and writes no history row", async () => {
  await migrate();
  const a = await mintToken();
  const b = await mintToken();
  const id = shareId();
  expect((await handleCliUpload(uploadReq(a.bearer, payload(id)), "1.1.1.1")).status).toBe(201);

  // B tries to reuse A's id
  const collide = await handleCliUpload(uploadReq(b.bearer, payload(id)), "2.2.2.2");
  expect(collide.status).toBe(409);

  // exactly one history row for that id, owned by A — B got none
  const hk = await getSql()`SELECT user_id FROM history_keys WHERE share_id = ${id}`;
  expect(hk.length).toBe(1);
  expect(Number(hk[0]!.user_id)).toBe(a.userId);
});

dbTest("a same-token re-upload of an existing id returns an opaque 409", async () => {
  await migrate();
  const { bearer } = await mintToken();
  const id = shareId();
  expect((await handleCliUpload(uploadReq(bearer, payload(id)), "1.2.3.4")).status).toBe(201);
  // re-POST the same id (PK collision) → 409 conflict, not a 503
  expect((await handleCliUpload(uploadReq(bearer, payload(id)), "1.2.3.4")).status).toBe(409);
});

dbTest("invalid id shape and over-ceiling ciphertext are rejected (AE1 server side)", async () => {
  await migrate();
  const { bearer } = await mintToken();

  // bad id shape
  expect((await handleCliUpload(uploadReq(bearer, payload("too-short")), "1.2.3.4")).status).toBe(400);

  // ciphertext over the 25MB ceiling. base64url decodes 4 chars -> 3 bytes, so
  // ~35MB of chars decodes to ~26MB, just over the limit.
  const huge = "A".repeat(35 * 1024 * 1024);
  expect((await handleCliUpload(uploadReq(bearer, payload(shareId(), huge)), "1.2.3.4")).status).toBe(400);
});

dbTest("a CLI upload survives a sweep (durability — expires_at NULL)", async () => {
  await migrate();
  const { bearer } = await mintToken();
  const id = shareId();
  await handleCliUpload(uploadReq(bearer, payload(id)), "1.2.3.4");

  await sweep();
  const rows = await getSql()`SELECT state, ciphertext IS NOT NULL AS has_ct FROM shares WHERE id = ${id}`;
  expect(rows[0]!.state).toBe("active");
  expect(rows[0]!.has_ct).toBe(true);
});

function listReq(bearer: string | null): Request {
  const headers: Record<string, string> = { host: "localhost" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return new Request("http://localhost/api/cli/uploads", { headers });
}
function deleteReq(bearer: string | null, id: string): Request {
  const headers: Record<string, string> = { host: "localhost" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return new Request(`http://localhost/api/cli/uploads/${id}`, { method: "DELETE", headers });
}

dbTest("a revoked token is rejected on list and delete, not just upload", async () => {
  await migrate();
  const { tokenId, bearer } = await mintToken();
  const id = shareId();
  await handleCliUpload(uploadReq(bearer, payload(id)), "1.2.3.4");
  await getSql()`UPDATE cli_tokens SET revoked_at = now() WHERE token_id = ${tokenId}`;

  // every bearer endpoint shares authBearer — all must reject the revoked token
  expect((await handleCliList(listReq(bearer), "1.2.3.4")).status).toBe(401);
  expect((await handleCliDelete(deleteReq(bearer, id), id, "1.2.3.4")).status).toBe(401);
  // and the prior upload was not tombstoned by the rejected delete
  expect((await getSql()`SELECT state FROM shares WHERE id = ${id}`)[0]!.state).toBe("active");
});

dbTest("deleting a user with CLI uploads is not blocked by the RESTRICT FK", async () => {
  await migrate();
  const { bearer, userId } = await mintToken();
  const id = shareId();
  await handleCliUpload(uploadReq(bearer, payload(id)), "1.2.3.4");

  const sql = getSql();
  // both history_keys and cli_tokens cascade from users; the RESTRICT between them
  // must not deadlock the user-deletion cascade.
  await sql`DELETE FROM users WHERE id = ${userId}`;
  expect((await sql`SELECT 1 FROM cli_tokens WHERE user_id = ${userId}`).length).toBe(0);
  expect((await sql`SELECT 1 FROM history_keys WHERE share_id = ${id}`).length).toBe(0);
});

dbTest("list is scoped to the authenticating token, with wrapped content keys", async () => {
  await migrate();
  const a = await mintToken();
  const b = await mintToken();
  const id1 = shareId();
  const id2 = shareId();
  await handleCliUpload(uploadReq(a.bearer, payload(id1)), "1.2.3.4");
  await handleCliUpload(uploadReq(a.bearer, payload(id2)), "1.2.3.4");
  await handleCliUpload(uploadReq(b.bearer, payload(shareId())), "5.6.7.8");

  const res = await handleCliList(listReq(a.bearer), "1.2.3.4");
  expect(res.status).toBe(200);
  const { items } = (await res.json()) as { items: any[] };
  const ids = items.map((i) => i.shareId).sort();
  expect(ids).toEqual([id1, id2].sort());
  expect(items[0].wrappedContentKey).toEqual(WCK);
  // unauthenticated list is rejected
  expect((await handleCliList(listReq(null), "1.2.3.4")).status).toBe(401);
});

dbTest("delete tombstones an owned upload, removes the history row, and is opaque for non-owned", async () => {
  await migrate();
  const a = await mintToken();
  const b = await mintToken();
  const id = shareId();
  await handleCliUpload(uploadReq(a.bearer, payload(id)), "1.2.3.4");

  // B cannot tombstone A's upload (opaque ok, no effect)
  expect((await handleCliDelete(deleteReq(b.bearer, id), id, "5.6.7.8")).status).toBe(200);
  const stillThere = await getSql()`SELECT state FROM shares WHERE id = ${id}`;
  expect(stillThere[0]!.state).toBe("active");

  // A deletes — ciphertext tombstoned, history row gone, fetch unavailable
  expect((await handleCliDelete(deleteReq(a.bearer, id), id, "1.2.3.4")).status).toBe(200);
  const sql = getSql();
  const row = await sql`SELECT state, ciphertext IS NULL AS gone FROM shares WHERE id = ${id}`;
  expect(row[0]!.state).toBe("deleted");
  expect(row[0]!.gone).toBe(true);
  expect((await sql`SELECT 1 FROM history_keys WHERE share_id = ${id}`).length).toBe(0);
  expect((await handleFetchShare(id)).status).toBe(404);
  // deleted upload no longer appears in list
  const { items } = (await (await handleCliList(listReq(a.bearer), "1.2.3.4")).json()) as { items: any[] };
  expect(items.some((i) => i.shareId === id)).toBe(false);
});
