import { test, expect, afterAll } from "bun:test";
import { migrate } from "./migrate";
import { getSql, closeSql } from "./db";
import {
  handleLogin,
  handleCallback,
  handleLogout,
  handleMe,
  upsertUser,
  validateNext,
} from "./oauth-github";
import { createSession, getSession, SESSION_COOKIE } from "./sessions";

const dbTest = process.env.DATABASE_URL ? test : test.skip;
afterAll(async () => {
  if (process.env.DATABASE_URL) await closeSql();
});

function setCookieValue(res: Response, name: string): string | undefined {
  const c = res.headers.getSetCookie().find((s) => s.startsWith(`${name}=`));
  if (!c) return undefined;
  return c.split(";")[0]!.slice(name.length + 1);
}

function githubStub(
  token: string | null,
  githubId: number | null,
  login: string | null = null,
): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("access_token")) {
      return new Response(JSON.stringify(token ? { access_token: token } : {}), {
        status: 200,
      });
    }
    if (u.includes("/user")) {
      return new Response(
        JSON.stringify(githubId ? { id: githubId, login: login ?? undefined } : {}),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

function callbackReq(query: string, cookie: string): Request {
  return new Request(`http://localhost/api/auth/callback?${query}`, {
    headers: { cookie },
  });
}

test("validateNext allows same-origin paths only", () => {
  expect(validateNext("/history")).toBe("/history");
  expect(validateNext("//evil.com")).toBeNull();
  expect(validateNext("https://evil.com")).toBeNull();
  expect(validateNext("")).toBeNull();
  expect(validateNext(null)).toBeNull();
});

test("login redirects to GitHub with PKCE + state and sets transient cookies", async () => {
  const res = await handleLogin(new Request("http://localhost/api/auth/login"));
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  expect(loc.searchParams.get("code_challenge")).toBeTruthy();
  expect(loc.searchParams.get("state")).toBe(setCookieValue(res, "oauth_state"));
  expect(setCookieValue(res, "oauth_verifier")).toBeTruthy();
});

test("login rejects an off-origin next", async () => {
  const res = await handleLogin(
    new Request("http://localhost/api/auth/login?next=//evil.com"),
  );
  expect(setCookieValue(res, "oauth_next")).toBeUndefined();
});

dbTest("callback happy path creates the user + a session and rotates the cookie", async () => {
  await migrate();
  const res = await handleCallback(
    callbackReq("code=abc&state=s1", "oauth_state=s1; oauth_verifier=v1"),
    githubStub("tok", 900001),
  );
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/");

  const sid = setCookieValue(res, SESSION_COOKIE);
  expect(sid).toBeTruthy();
  const session = await getSession(sid);
  expect(session).not.toBeNull();

  const sql = getSql();
  const users = await sql`SELECT id FROM users WHERE github_id = 900001`;
  expect(users.length).toBe(1);
  expect(session!.userId).toBe(Number(users[0]!.id));
});

dbTest("callback rejects a state mismatch (CSRF) and a denial", async () => {
  await migrate();
  const mismatch = await handleCallback(
    callbackReq("code=abc&state=WRONG", "oauth_state=s1; oauth_verifier=v1"),
    githubStub("tok", 900002),
  );
  expect(mismatch.headers.get("location")).toBe("/?auth_error=state");
  expect(setCookieValue(mismatch, SESSION_COOKIE)).toBeUndefined();

  const denied = await handleCallback(
    callbackReq("error=access_denied&state=s1", "oauth_state=s1"),
    githubStub("tok", 900002),
  );
  expect(denied.headers.get("location")).toBe("/?auth_error=denied");
});

dbTest("callback reports a code-exchange failure distinctly", async () => {
  await migrate();
  const res = await handleCallback(
    callbackReq("code=abc&state=s1", "oauth_state=s1; oauth_verifier=v1"),
    githubStub(null, null), // no access_token
  );
  expect(res.headers.get("location")).toBe("/?auth_error=exchange");
});

dbTest("a returning github_id maps to the same user; off-origin next falls back to /", async () => {
  await migrate();
  const a = await upsertUser(900050);
  const b = await upsertUser(900050);
  expect(a).toBe(b);

  const res = await handleCallback(
    callbackReq("code=abc&state=s1", "oauth_state=s1; oauth_verifier=v1; oauth_next=//evil.com"),
    githubStub("tok", 900050),
  );
  expect(res.headers.get("location")).toBe("/"); // open redirect rejected
});

dbTest("callback captures the GitHub login on the user row", async () => {
  await migrate();
  const res = await handleCallback(
    callbackReq("code=abc&state=s1", "oauth_state=s1; oauth_verifier=v1"),
    githubStub("tok", 900003, "torvalds"),
  );
  expect(res.status).toBe(302);
  const rows = await getSql()`SELECT login FROM users WHERE github_id = 900003`;
  expect(rows[0]!.login).toBe("torvalds");
});

dbTest("upsertUser writes login on insert and refreshes it on a rename", async () => {
  await migrate();
  await upsertUser(900060, "octocat");
  const sql = getSql();
  let rows = await sql`SELECT login FROM users WHERE github_id = 900060`;
  expect(rows[0]!.login).toBe("octocat");

  // a GitHub rename on the next login is reflected
  await upsertUser(900060, "octocat-renamed");
  rows = await sql`SELECT login FROM users WHERE github_id = 900060`;
  expect(rows[0]!.login).toBe("octocat-renamed");
});

dbTest("GET /api/auth/me returns {login} for a valid session and 401 otherwise", async () => {
  await migrate();
  const uid = await upsertUser(900070, "mona");
  const sid = await createSession(uid);

  const ok = await handleMe(
    new Request("http://localhost/api/auth/me", {
      headers: { cookie: `${SESSION_COOKIE}=${sid}` },
    }),
  );
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ login: "mona" });

  // no session cookie → unauthenticated
  const anon = await handleMe(new Request("http://localhost/api/auth/me"));
  expect(anon.status).toBe(401);
});

dbTest("GET /api/auth/me reports {login:null} for a pre-migration row", async () => {
  await migrate();
  const uid = await upsertUser(900071); // no login captured
  const sid = await createSession(uid);
  const res = await handleMe(
    new Request("http://localhost/api/auth/me", {
      headers: { cookie: `${SESSION_COOKIE}=${sid}` },
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ login: null });
});

dbTest("logout revokes the session server-side; expired sessions are rejected", async () => {
  await migrate();
  const uid = await upsertUser(900090);
  const sid = await createSession(uid);
  expect(await getSession(sid)).not.toBeNull();

  await handleLogout(
    new Request("http://localhost/api/auth/logout", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${sid}` },
    }),
  );
  expect(await getSession(sid)).toBeNull(); // a stolen pre-logout cookie is now dead

  // expired session
  const sql = getSql();
  const expired = "expired-" + sid;
  await sql`INSERT INTO sessions (id, user_id, expires_at) VALUES (${expired}, ${uid}, now() - INTERVAL '1 hour')`;
  expect(await getSession(expired)).toBeNull();
});
