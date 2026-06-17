// Hand-rolled GitHub OAuth (authorization-code + PKCE) and session issuance
// (plan U7). Identity only — no key material is ever derived from OAuth.
//
// Config from env (server-only, never BUN_PUBLIC_): GITHUB_CLIENT_ID,
// GITHUB_CLIENT_SECRET, OAUTH_REDIRECT_URI. The HTTP calls take an injectable
// fetch so the flow is testable without live GitHub.

import { getSql } from "./db";
import {
  createSession,
  revokeSession,
  randomToken,
  sessionCookie,
  serializeCookie,
  clearCookie,
  parseCookies,
  userIdFromRequest,
  SESSION_COOKIE,
} from "./sessions";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const SCOPE = "read:user";
const OAUTH_TMP_TTL = 600; // 10 min for the transient state/verifier cookies

function config() {
  return {
    clientId: process.env.GITHUB_CLIENT_ID ?? "",
    clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    redirectUri: process.env.OAUTH_REDIRECT_URI ?? "",
  };
}

/** Only same-origin relative paths are honored as a post-login redirect. */
export function validateNext(next: string | null | undefined): string | null {
  if (!next) return null;
  // must be a path, not protocol-relative (`//host`) or absolute URL
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  return next;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(new Uint8Array(digest)).toString("base64url");
}

function errorRedirect(reason: string): Response {
  const headers = new Headers({ Location: `/?auth_error=${reason}` });
  // clear any transient oauth cookies on failure
  for (const n of ["oauth_state", "oauth_verifier", "oauth_next"]) {
    headers.append("Set-Cookie", clearCookie(n));
  }
  return new Response(null, { status: 302, headers });
}

/** GET /api/auth/login — redirect to GitHub with state + PKCE. */
export async function handleLogin(req: Request): Promise<Response> {
  const { clientId, redirectUri } = config();
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = await pkceChallenge(verifier);
  const next = validateNext(new URL(req.url).searchParams.get("next"));

  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", SCOPE);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");

  const headers = new Headers({ Location: authorize.toString() });
  headers.append("Set-Cookie", serializeCookie("oauth_state", state, OAUTH_TMP_TTL));
  headers.append("Set-Cookie", serializeCookie("oauth_verifier", verifier, OAUTH_TMP_TTL));
  if (next) headers.append("Set-Cookie", serializeCookie("oauth_next", next, OAUTH_TMP_TTL));
  return new Response(null, { status: 302, headers });
}

/** GET /api/auth/callback — verify state/PKCE, exchange code, issue a session. */
export async function handleCallback(
  req: Request,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(req.url);
  const cookies = parseCookies(req.headers.get("cookie"));

  if (url.searchParams.get("error")) return errorRedirect("denied");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const verifier = cookies.oauth_verifier;
  // CSRF: the state in the query must match the one we set in the cookie
  if (!code || !state || state !== cookies.oauth_state || !verifier) {
    return errorRedirect("state");
  }

  const { clientId, clientSecret, redirectUri } = config();
  let accessToken: string | undefined;
  try {
    const r = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    accessToken = ((await r.json()) as { access_token?: string }).access_token;
  } catch {
    return errorRedirect("exchange");
  }
  if (!accessToken) return errorRedirect("exchange");

  let githubId: number | undefined;
  let login: string | undefined;
  try {
    const r = await fetchImpl(USER_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "jsonl-tools",
      },
    });
    const user = (await r.json()) as { id?: number; login?: string };
    githubId = user.id;
    login = user.login;
  } catch {
    return errorRedirect("exchange");
  }
  if (!githubId) return errorRedirect("exchange");

  const userId = await upsertUser(githubId, login);
  const sessionId = await createSession(userId);
  const next = validateNext(cookies.oauth_next) ?? "/";

  const headers = new Headers({ Location: next });
  headers.append("Set-Cookie", sessionCookie(sessionId));
  for (const n of ["oauth_state", "oauth_verifier", "oauth_next"]) {
    headers.append("Set-Cookie", clearCookie(n));
  }
  return new Response(null, { status: 302, headers });
}

/** POST /api/auth/logout — revoke the session server-side. */
export async function handleLogout(req: Request): Promise<Response> {
  const sid = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
  if (sid) await revokeSession(sid);
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", clearCookie(SESSION_COOKIE));
  return new Response(null, { status: 302, headers });
}

/**
 * GET /api/auth/me — identity only. Returns `{ login }` (login may be null for a
 * pre-migration row) with 200 for a valid session, else 401. Unlike /api/account
 * this answers "who is signed in" and works before any account key is set up.
 */
export async function handleMe(req: Request): Promise<Response> {
  const userId = await userIdFromRequest(req);
  if (userId === null) return new Response(null, { status: 401 });
  const rows = await getSql()`SELECT login FROM users WHERE id = ${userId}`;
  const login = (rows[0]?.login ?? null) as string | null;
  return Response.json({ login });
}

/**
 * Idempotent: a returning github_id maps to the same users row. `login` is
 * stored on insert and refreshed on conflict so a GitHub rename is reflected;
 * COALESCE keeps a known login if a later call ever arrives without one rather
 * than nulling it.
 */
export async function upsertUser(
  githubId: number,
  login?: string | null,
): Promise<number> {
  const rows = await getSql()`
    INSERT INTO users (github_id, login) VALUES (${githubId}, ${login ?? null})
    ON CONFLICT (github_id)
    DO UPDATE SET login = COALESCE(EXCLUDED.login, users.login)
    RETURNING id
  `;
  return Number(rows[0]!.id);
}
