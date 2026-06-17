import { test, expect, afterAll, beforeEach } from "bun:test";
import { migrate } from "./migrate";
import { getSql, closeSql } from "./db";
import {
  handleSetupAccount,
  handleGetAccount,
  handleGetRecoveryBlob,
  handleRotateAccount,
} from "./account-store";
import { upsertUser } from "./oauth-github";
import { createSession, SESSION_COOKIE } from "./sessions";
import { resetRateLimits } from "./abuse";
import { setupAccount, rotatePassphrase } from "../account-crypto";

const dbTest = process.env.DATABASE_URL ? test : test.skip;
const PASS = "correct horse battery staple";

beforeEach(() => resetRateLimits());
afterAll(async () => {
  if (process.env.DATABASE_URL) await closeSql();
});

// Random github_id per call so each run gets fresh users (the DB persists
// across `bun test` runs; fixed ids would collide with prior runs' accounts).
function randomGithubId(): number {
  return 700_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 100_000_000);
}
async function authCookie(_seed?: number): Promise<string> {
  const uid = await upsertUser(randomGithubId());
  const sid = await createSession(uid);
  return `${SESSION_COOKIE}=${sid}`;
}

function postReq(
  path: string,
  cookie: string | null,
  body: unknown,
  extra: Record<string, string> = {},
): Request {
  const headers: Record<string, string> = {
    host: "localhost",
    "content-type": "application/json",
    ...extra,
  };
  if (cookie) headers.cookie = cookie;
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
function getReq(path: string, cookie: string | null): Request {
  const headers: Record<string, string> = { host: "localhost" };
  if (cookie) headers.cookie = cookie;
  return new Request(`http://localhost${path}`, { headers });
}

dbTest("setup stores blobs; get returns master+verifier only; unauthed 401; setup is once", async () => {
  await migrate();
  const cookie = await authCookie(800001);
  const acct = await setupAccount(PASS);

  expect((await handleGetAccount(getReq("/api/account", null))).status).toBe(401);
  expect((await handleGetAccount(getReq("/api/account", cookie))).status).toBe(404);

  const setup = await handleSetupAccount(
    postReq("/api/account", cookie, { blobs: acct.blobs, authTag: acct.authTag }),
  );
  expect(setup.status).toBe(201);

  const got = await handleGetAccount(getReq("/api/account", cookie));
  expect(got.status).toBe(200);
  const body = (await got.json()) as Record<string, unknown>;
  expect(body.wrappedUnderMaster).toEqual(acct.blobs.wrappedUnderMaster);
  expect(body.verifier).toEqual(acct.blobs.verifier);
  expect(body.wrappedUnderRecovery).toBeUndefined(); // recovery blob not exposed here

  const again = await handleSetupAccount(
    postReq("/api/account", cookie, { blobs: acct.blobs, authTag: acct.authTag }),
  );
  expect(again.status).toBe(409);
});

dbTest("account access is scoped to the session user (no cross-user read)", async () => {
  await migrate();
  const aCookie = await authCookie(800010);
  const bCookie = await authCookie(800011);
  const acct = await setupAccount(PASS);
  await handleSetupAccount(
    postReq("/api/account", aCookie, { blobs: acct.blobs, authTag: acct.authTag }),
  );

  // B's session only ever resolves to B's row — never A's
  expect((await handleGetAccount(getReq("/api/account", bCookie))).status).toBe(404);
  expect((await handleGetAccount(getReq("/api/account", aCookie))).status).toBe(200);
});

dbTest("recovery blob is returned to the authed user", async () => {
  await migrate();
  const cookie = await authCookie(800020);
  const acct = await setupAccount(PASS);
  await handleSetupAccount(
    postReq("/api/account", cookie, { blobs: acct.blobs, authTag: acct.authTag }),
  );
  const res = await handleGetRecoveryBlob(getReq("/api/account/recovery", cookie));
  expect(res.status).toBe(200);
  expect((await res.json()).wrappedUnderRecovery).toEqual(
    acct.blobs.wrappedUnderRecovery,
  );
});

dbTest("rotate requires the current auth tag, bumps version, rejects unauth/cross-site", async () => {
  await migrate();
  const cookie = await authCookie(800030);
  const acct = await setupAccount(PASS);
  await handleSetupAccount(
    postReq("/api/account", cookie, { blobs: acct.blobs, authTag: acct.authTag }),
  );
  const rotated = await rotatePassphrase("a different strong passphrase", acct.accountKey);

  // wrong current auth tag (stolen session can't prove the current passphrase) → 403
  const bad = await handleRotateAccount(
    postReq("/api/account/rotate", cookie, {
      blobs: rotated.blobs,
      authTag: rotated.authTag,
      currentAuthTag: "wrong",
    }),
  );
  expect(bad.status).toBe(403);

  const ok = await handleRotateAccount(
    postReq("/api/account/rotate", cookie, {
      blobs: rotated.blobs,
      authTag: rotated.authTag,
      currentAuthTag: acct.authTag,
    }),
  );
  expect(ok.status).toBe(200);

  const rows = await getSql()`
    SELECT version, kdf->>'salt' AS salt FROM account_keys WHERE auth_tag = ${rotated.authTag}
  `;
  expect(rows[0]!.version).toBe(2);
  expect(rows[0]!.salt).toBe(rotated.blobs.kdf.salt);

  expect(
    (
      await handleRotateAccount(
        postReq("/api/account/rotate", null, {
          blobs: rotated.blobs,
          authTag: "x",
          currentAuthTag: "y",
        }),
      )
    ).status,
  ).toBe(401);

  const xs = await handleRotateAccount(
    postReq(
      "/api/account/rotate",
      cookie,
      { blobs: rotated.blobs, authTag: "x", currentAuthTag: "y" },
      { "sec-fetch-site": "cross-site" },
    ),
  );
  expect(xs.status).toBe(403);
});
