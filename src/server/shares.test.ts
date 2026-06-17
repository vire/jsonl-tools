import { test, expect, afterAll } from "bun:test";
import { migrate } from "./migrate";
import { getSql, closeSql } from "./db";
import {
  handleCreateShare,
  handleFetchShare,
  handleDeleteShare,
  sha256hex,
} from "./shares";
import {
  generateShareId,
  generateContentKey,
  encryptSession,
  decryptSession,
} from "../share-crypto";

// Requires Postgres; skips cleanly without DATABASE_URL.
const dbTest = process.env.DATABASE_URL ? test : test.skip;

afterAll(async () => {
  if (process.env.DATABASE_URL) await closeSql();
});

function makeReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/shares", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", ...headers },
    body: JSON.stringify(body),
  });
}

dbTest(
  "create persists ciphertext + hashed token + server-derived size, then fetch round-trips",
  async () => {
    await migrate();
    const id = generateShareId();
    const key = await generateContentKey();
    const session = "line one\nline two — customer secret #4815";
    const env = await encryptSession(session, key, id);

    const res = await handleCreateShare(
      makeReq({ id, v: env.v, iv: env.iv, ct: env.ct, expiresInDays: 9999 }),
    );
    expect(res.status).toBe(201);
    const { adminToken } = (await res.json()) as { adminToken: string };

    const sql = getSql();
    const rows = await sql`
      SELECT size_bytes, admin_token_hash, state, expires_at
      FROM shares WHERE id = ${id}
    `;
    const row = rows[0]!;
    expect(row.state).toBe("active");
    // admin token stored only as its hash; raw token never persisted
    expect(row.admin_token_hash).toBe(sha256hex(adminToken));
    expect(row.admin_token_hash).not.toBe(adminToken);
    // size derived server-side from the real ciphertext bytes
    expect(row.size_bytes).toBe(Buffer.from(env.ct, "base64url").length);
    // expiration disabled for now (SHARE_EXPIRY_ENABLED=false): a requested TTL
    // is ignored and expires_at stays NULL — the share never expires.
    expect(row.expires_at).toBeNull();

    // fetch + client-side decrypt round-trip
    const fres = await handleFetchShare(id);
    expect(fres.status).toBe(200);
    const fbody = (await fres.json()) as { v: number; iv: string; ct: string };
    const out = await decryptSession(
      { v: fbody.v, iv: fbody.iv, ct: fbody.ct },
      key,
      id,
    );
    expect(out).toBe(session);
  },
);

dbTest("create rejects a cross-site request (CSRF)", async () => {
  const id = generateShareId();
  const res = await handleCreateShare(
    makeReq(
      { id, v: 1, iv: "x", ct: "AAAA" },
      { "sec-fetch-site": "cross-site" },
    ),
  );
  expect(res.status).toBe(403);
});

dbTest("create rejects a malformed id", async () => {
  const res = await handleCreateShare(makeReq({ id: "too-short", v: 1, iv: "x", ct: "AAAA" }));
  expect(res.status).toBe(400);
});

async function createTestShare(): Promise<{ id: string; adminToken: string }> {
  const id = generateShareId();
  const key = await generateContentKey();
  const env = await encryptSession("payload", key, id);
  const res = await handleCreateShare(makeReq({ id, v: env.v, iv: env.iv, ct: env.ct }));
  const { adminToken } = (await res.json()) as { adminToken: string };
  return { id, adminToken };
}

function delReq(id: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/shares/${id}`, {
    method: "DELETE",
    headers: { host: "localhost", ...headers },
  });
}

dbTest("an expired share is lazily tombstoned and fetched as opaque unavailable", async () => {
  await migrate();
  const id = generateShareId();
  const sql = getSql();
  // insert an already-expired active row directly
  await sql`
    INSERT INTO shares (id, ciphertext, iv, aad, size_bytes, state, expires_at, admin_token_hash)
    VALUES (${id}, ${Buffer.from("x")}, 'iv', '{"v":1}'::jsonb, 1, 'active',
            now() - INTERVAL '1 hour', ${sha256hex("t")})
  `;

  const res = await handleFetchShare(id);
  expect(res.status).toBe(404);

  const rows = await sql`SELECT state, ciphertext FROM shares WHERE id = ${id}`;
  expect(rows[0]!.state).toBe("expired");
  expect(rows[0]!.ciphertext).toBeNull();
});

dbTest("delete with the correct admin token tombstones, and is idempotent", async () => {
  const { id, adminToken } = await createTestShare();

  const first = await handleDeleteShare(delReq(id, { "x-admin-token": adminToken }), id);
  expect(first.status).toBe(200);

  const sql = getSql();
  const rows = await sql`SELECT state, ciphertext FROM shares WHERE id = ${id}`;
  expect(rows[0]!.state).toBe("deleted");
  expect(rows[0]!.ciphertext).toBeNull();

  // second delete is a no-op success
  const second = await handleDeleteShare(delReq(id, { "x-admin-token": adminToken }), id);
  expect(second.status).toBe(200);

  // the share is now opaque-unavailable to fetch
  expect((await handleFetchShare(id)).status).toBe(404);
});

dbTest("delete with a wrong token, and of an unknown id, are both opaque (no existence leak)", async () => {
  const { id } = await createTestShare();

  const wrong = await handleDeleteShare(delReq(id, { "x-admin-token": "not-the-token" }), id);
  expect(wrong.status).toBe(404);

  const unknown = await handleDeleteShare(
    delReq(generateShareId(), { "x-admin-token": "whatever" }),
    generateShareId(),
  );
  expect(unknown.status).toBe(404);

  // the real share is untouched by the failed delete
  const sql = getSql();
  const rows = await sql`SELECT state FROM shares WHERE id = ${id}`;
  expect(rows[0]!.state).toBe("active");
});

dbTest("cross-site delete is rejected", async () => {
  const { id, adminToken } = await createTestShare();
  const res = await handleDeleteShare(
    delReq(id, { "x-admin-token": adminToken, "sec-fetch-site": "cross-site" }),
    id,
  );
  expect(res.status).toBe(403);
});

// --- Task 1: private share state ---

import { upsertUser } from "./oauth-github";
import { createSession, SESSION_COOKIE } from "./sessions";

function randomGithubId(): number {
  return 700_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 100_000_000);
}
async function authCookie(): Promise<{ cookie: string; userId: number }> {
  const userId = await upsertUser(randomGithubId());
  const sid = await createSession(userId);
  return { cookie: `${SESSION_COOKIE}=${sid}`, userId };
}
async function createPrivateReq(cookie: string): Promise<{ id: string; res: Response }> {
  const id = generateShareId();
  const key = await generateContentKey();
  const env = await encryptSession("private payload", key, id);
  const req = new Request("http://localhost/api/shares", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", cookie },
    body: JSON.stringify({
      id, v: env.v, iv: env.iv, ct: env.ct,
      wrappedContentKey: { iv: "i", ct: "c" }, private: true,
    }),
  });
  return { id, res: await handleCreateShare(req, "10.0.0.2") };
}

dbTest("a logged-in private create stores state='private' and does NOT resolve via fetch", async () => {
  await migrate();
  const { cookie } = await authCookie();
  const { id, res } = await createPrivateReq(cookie);
  expect(res.status).toBe(201);

  const sql = getSql();
  const row = await sql`SELECT state, ciphertext IS NOT NULL AS has_ct FROM shares WHERE id = ${id}`;
  expect(row[0]!.state).toBe("private");
  expect(row[0]!.has_ct).toBe(true);               // ciphertext is stored, just not served
  expect((await handleFetchShare(id)).status).toBe(404); // private → opaque unavailable
});

async function createOwnedPrivateShare(
  cookie: string,
): Promise<{ id: string; key: Awaited<ReturnType<typeof generateContentKey>>; plaintext: string }> {
  const id = generateShareId();
  const key = await generateContentKey();
  const plaintext = "owner-only private payload — secret #2025";
  const env = await encryptSession(plaintext, key, id);
  const req = new Request("http://localhost/api/shares", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", cookie },
    body: JSON.stringify({
      id, v: env.v, iv: env.iv, ct: env.ct,
      wrappedContentKey: { iv: "i", ct: "c" }, private: true,
    }),
  });
  const res = await handleCreateShare(req, "10.0.0.3");
  expect(res.status).toBe(201);
  return { id, key, plaintext };
}

function fetchReq(id: string, cookie?: string): Request {
  return new Request(`http://localhost/api/shares/${id}`, {
    method: "GET",
    headers: { host: "localhost", ...(cookie ? { cookie } : {}) },
  });
}

dbTest("the authenticated owner can fetch + decrypt their own private share; nobody else can", async () => {
  await migrate();
  const owner = await authCookie();
  const { id, key, plaintext } = await createOwnedPrivateShare(owner.cookie);

  // Owner (authenticated via session cookie) → 200 and round-trips.
  const ownerRes = await handleFetchShare(id, fetchReq(id, owner.cookie));
  expect(ownerRes.status).toBe(200);
  const body = (await ownerRes.json()) as { v: number; iv: string; ct: string };
  expect(await decryptSession({ v: body.v, iv: body.iv, ct: body.ct }, key, id)).toBe(plaintext);

  // A different signed-in user → opaque 404 (private stays unlisted; no existence leak).
  const other = await authCookie();
  expect((await handleFetchShare(id, fetchReq(id, other.cookie))).status).toBe(404);

  // Anonymous (no cookie) → opaque 404.
  expect((await handleFetchShare(id, fetchReq(id))).status).toBe(404);
  // Back-compat: a reqless call treats private as unavailable (the existing default).
  expect((await handleFetchShare(id)).status).toBe(404);
});

dbTest("an anonymous private:true create is ignored — stays active, no history row", async () => {
  await migrate();
  const id = generateShareId();
  const key = await generateContentKey();
  const env = await encryptSession("payload", key, id);
  const req = new Request("http://localhost/api/shares", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" }, // NO cookie / no auth
    body: JSON.stringify({ id, v: env.v, iv: env.iv, ct: env.ct, private: true }), // no wrappedContentKey
  });
  const res = await handleCreateShare(req, "10.0.0.9");
  expect(res.status).toBe(201);

  const sql = getSql();
  const row = await sql`SELECT state, owner_user_id FROM shares WHERE id = ${id}`;
  expect(row[0]!.state).toBe("active");           // private ignored without an owner
  expect(row[0]!.owner_user_id).toBeNull();
  expect((await sql`SELECT 1 FROM history_keys WHERE share_id = ${id}`).length).toBe(0);
  expect((await handleFetchShare(id)).status).toBe(200); // resolves like a normal anonymous share
});
