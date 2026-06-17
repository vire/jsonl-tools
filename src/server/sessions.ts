// Server-side, revocable sessions + cookie helpers (plan U7).
//
// The session cookie carries only a random id; the `sessions` row is the source
// of truth, so logout (delete the row) and expiry are enforced server-side. The
// cookie uses the `__Host-` prefix (forces Secure + Path=/ + no Domain).

import { getSql } from "./db";

export const SESSION_COOKIE = "__Host-session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7-day absolute lifetime

export interface Session {
  id: string;
  userId: number;
}

export function randomToken(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString(
    "base64url",
  );
}

/** Create a fresh session (a new id each login = rotation / fixation defense). */
export async function createSession(userId: number): Promise<string> {
  const id = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await getSql()`
    INSERT INTO sessions (id, user_id, expires_at) VALUES (${id}, ${userId}, ${expiresAt})
  `;
  return id;
}

/** Resolve a session id to its user, or null if unknown/expired. */
export async function getSession(
  sessionId: string | undefined | null,
): Promise<Session | null> {
  if (!sessionId) return null;
  const rows = await getSql()`
    SELECT id, user_id FROM sessions WHERE id = ${sessionId} AND expires_at > now()
  `;
  if (rows.length === 0) return null;
  return { id: rows[0]!.id, userId: Number(rows[0]!.user_id) };
}

/** Delete a session server-side (logout). */
export async function revokeSession(sessionId: string): Promise<void> {
  await getSql()`DELETE FROM sessions WHERE id = ${sessionId}`;
}

/** Read the authenticated user id from a request's session cookie, or null. */
export async function userIdFromRequest(req: Request): Promise<number | null> {
  const sid = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
  const session = await getSession(sid);
  return session?.userId ?? null;
}

// --- cookie helpers (manual, so handlers stay testable with plain Requests) ---

export function serializeCookie(
  name: string,
  value: string,
  maxAgeSeconds?: number,
): string {
  let c = `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/`;
  if (maxAgeSeconds !== undefined) c += `; Max-Age=${maxAgeSeconds}`;
  return c;
}

export function clearCookie(name: string): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function sessionCookie(sessionId: string): string {
  return serializeCookie(SESSION_COOKIE, sessionId, Math.floor(SESSION_TTL_MS / 1000));
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}
