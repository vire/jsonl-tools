import { test, expect, afterAll, beforeEach } from "bun:test";
import { migrate } from "./migrate";
import { getSql, closeSql } from "./db";
import {
  handleMintToken,
  handleListTokens,
  handleRevokeToken,
} from "./cli-tokens";
import { handleSetupAccount } from "./account-store";
import { upsertUser } from "./oauth-github";
import { createSession, SESSION_COOKIE } from "./sessions";
import { resetRateLimits } from "./abuse";
import { setupAccount } from "../account-crypto";

const dbTest = process.env.DATABASE_URL ? test : test.skip;
const PASS = "correct horse battery staple";
const WMK = { iv: "aXY", ct: "Y3Q" }; // a stand-in wrapped-machine-key blob

beforeEach(() => resetRateLimits());
afterAll(async () => {
  if (process.env.DATABASE_URL) await closeSql();
});

function randomGithubId(): number {
  return 710_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 80_000_000);
}

/** A logged-in session whose user also has an account_keys row set up. */
async function unlockedUser(): Promise<{ cookie: string; userId: number }> {
  const userId = await upsertUser(randomGithubId());
  const sid = await createSession(userId);
  const cookie = `${SESSION_COOKIE}=${sid}`;
  const acct = await setupAccount(PASS);
  await handleSetupAccount(
    new Request("http://localhost/api/account", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json", cookie },
      body: JSON.stringify({ blobs: acct.blobs, authTag: acct.authTag }),
    }),
  );
  return { cookie, userId };
}

function postReq(cookie: string | null, body: unknown, extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = {
    host: "localhost",
    "content-type": "application/json",
    ...extra,
  };
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost/api/cli/tokens", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
function getReq(cookie: string | null): Request {
  const headers: Record<string, string> = { host: "localhost" };
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost/api/cli/tokens", { headers });
}
function delReq(cookie: string | null, tokenId: string, extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { host: "localhost", ...extra };
  if (cookie) headers.cookie = cookie;
  return new Request(`http://localhost/api/cli/tokens/${tokenId}`, { method: "DELETE", headers });
}

dbTest("mint returns the secret once and stores only the hash", async () => {
  await migrate();
  const { cookie, userId } = await unlockedUser();

  const res = await handleMintToken(postReq(cookie, { label: "ci box", wrappedMachineKey: WMK }));
  expect(res.status).toBe(201);
  const { tokenId, authSecret } = (await res.json()) as { tokenId: string; authSecret: string };
  expect(tokenId).toBeTruthy();
  expect(authSecret).toBeTruthy();

  const rows = await getSql()`
    SELECT auth_secret_hash, wrapped_machine_key, label FROM cli_tokens
    WHERE token_id = ${tokenId} AND user_id = ${userId}
  `;
  expect(rows.length).toBe(1);
  // the raw secret never appears in the row; only its hash
  expect(rows[0]!.auth_secret_hash).not.toBe(authSecret);
  expect(rows[0]!.auth_secret_hash.length).toBe(64); // sha256 hex
  expect(rows[0]!.wrapped_machine_key).toEqual(WMK);
  expect(rows[0]!.label).toBe("ci box");
});

dbTest("mint is rejected without an account or with a malformed wrapped key", async () => {
  await migrate();
  // logged-in user WITHOUT an account_keys row
  const uid = await upsertUser(randomGithubId());
  const cookie = `${SESSION_COOKIE}=${await createSession(uid)}`;
  const noAccount = await handleMintToken(postReq(cookie, { wrappedMachineKey: WMK }));
  expect(noAccount.status).toBe(400);

  // unlocked user but malformed wrappedMachineKey
  const { cookie: ok } = await unlockedUser();
  const malformed = await handleMintToken(postReq(ok, { wrappedMachineKey: { iv: "only" } }));
  expect(malformed.status).toBe(400);
});

dbTest("list is user-scoped and includes revoked tokens with their wrapped key", async () => {
  await migrate();
  const { cookie: aCookie } = await unlockedUser();
  const { cookie: bCookie } = await unlockedUser();

  const mintA = await handleMintToken(postReq(aCookie, { label: "a", wrappedMachineKey: WMK }));
  const { tokenId: aToken } = (await mintA.json()) as { tokenId: string };
  await handleMintToken(postReq(bCookie, { label: "b", wrappedMachineKey: WMK }));

  // revoke A's token — it must still appear in A's list with its wrapped key
  await handleRevokeToken(delReq(aCookie, aToken), aToken);

  const listA = await handleListTokens(getReq(aCookie));
  const { tokens } = (await listA.json()) as { tokens: any[] };
  expect(tokens.length).toBe(1);
  expect(tokens[0].tokenId).toBe(aToken);
  expect(tokens[0].revoked).toBe(true);
  expect(tokens[0].wrappedMachineKey).toEqual(WMK);
  // never leaks the secret hash
  expect(JSON.stringify(tokens[0])).not.toContain("auth_secret_hash");
});

dbTest("revoke sets revoked_at, is idempotent, and never touches another user's token", async () => {
  await migrate();
  const { cookie: aCookie } = await unlockedUser();
  const { cookie: bCookie } = await unlockedUser();
  const mintA = await handleMintToken(postReq(aCookie, { wrappedMachineKey: WMK }));
  const { tokenId: aToken } = (await mintA.json()) as { tokenId: string };

  // B cannot revoke A's token (opaque ok, but no state change)
  expect((await handleRevokeToken(delReq(bCookie, aToken), aToken)).status).toBe(200);
  let row = await getSql()`SELECT revoked_at FROM cli_tokens WHERE token_id = ${aToken}`;
  expect(row[0]!.revoked_at).toBeNull();

  // A revokes — sets revoked_at
  await handleRevokeToken(delReq(aCookie, aToken), aToken);
  row = await getSql()`SELECT revoked_at FROM cli_tokens WHERE token_id = ${aToken}`;
  expect(row[0]!.revoked_at).not.toBeNull();

  // idempotent: revoking again still ok
  expect((await handleRevokeToken(delReq(aCookie, aToken), aToken)).status).toBe(200);
});

dbTest("mint/revoke reject cross-site and unauthenticated requests", async () => {
  await migrate();
  const { cookie } = await unlockedUser();
  expect((await handleMintToken(postReq(null, { wrappedMachineKey: WMK }))).status).toBe(401);
  expect(
    (await handleMintToken(postReq(cookie, { wrappedMachineKey: WMK }, { "sec-fetch-site": "cross-site" }))).status,
  ).toBe(403);
  expect((await handleListTokens(getReq(null))).status).toBe(401);
  expect((await handleRevokeToken(delReq(null, "x"), "x")).status).toBe(401);
});
