// First-party usage capture (plan U2).
//
// Records two event kinds into the `events` table: `api` (one per wrapped
// /api/* call) and `page_view` (derived from a surface's on-load request, or the
// bulk-analyzer load ping). Capture is best-effort and NON-BLOCKING: the write
// is fired off the hot path and swallows its own errors (logging once), so a
// store outage degrades analytics to nothing without ever delaying or failing a
// user's request (KTD8 / origin R16).
//
// Privacy invariants enforced here, not by discipline: the client-supplied
// session id and surface label are untrusted input and validated before storage
// (KTD4); no IP is ever read or written; `route` is always the caller's literal
// template, never a concrete id (KTD1 / origin R4).

import { getSql } from "./db";
import { userIdFromRequest } from "./sessions";

/** Exact UUID-v4 (case-insensitive). Rejects CRLF, control chars, over-length. */
const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The only surface labels we store; anything else becomes null. */
const SURFACES = new Set(["home", "viewer", "bulk-analyzer"]);

/** Accept a client-set session id only if it is an exact UUID v4, else null. */
export function validSessionId(raw: string | null | undefined): string | null {
  return raw && SESSION_ID_RE.test(raw) ? raw : null;
}

/** Accept a surface label only if it is in the fixed allowlist, else null. */
export function validSurface(raw: string | null | undefined): string | null {
  return raw && SURFACES.has(raw) ? raw : null;
}

export interface AnalyticsEvent {
  kind: "page_view" | "api";
  surface: string | null;
  route: string | null;
  method: string | null;
  sessionId: string | null;
  authenticated: boolean;
}

// In-flight best-effort writes, tracked so tests (and a future graceful drain)
// can await them. Each tracked promise is guaranteed not to reject.
const inflight = new Set<Promise<void>>();
function track(p: Promise<void>): void {
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

/** Await all in-flight analytics writes. Used by tests; harmless in prod. */
export async function flushAnalytics(): Promise<void> {
  await Promise.all([...inflight]);
}

/**
 * Best-effort INSERT. NEVER throws or rejects: on any failure (store down,
 * constraint violation) it emits exactly one structured log line and swallows,
 * so the floating promise always resolves and cannot surface as an unhandled
 * rejection (KTD8).
 */
export async function recordEvent(e: AnalyticsEvent): Promise<void> {
  try {
    await getSql()`
      INSERT INTO events (kind, surface, route, method, session_id, authenticated)
      VALUES (${e.kind}, ${e.surface}, ${e.route}, ${e.method}, ${e.sessionId}, ${e.authenticated})
    `;
  } catch (err) {
    console.error("[analytics]", err);
  }
}

/** Resolve whether the request is session-authed. Never throws (DB down → false). */
async function isAuthed(req: Request): Promise<boolean> {
  try {
    return (await userIdFromRequest(req)) !== null;
  } catch {
    return false;
  }
}

/**
 * Wrap a named /api/* handler. Records one `api` event for the call — keyed on
 * the caller's literal route TEMPLATE (never the concrete id) — then delegates.
 * The event write runs off the hot path: `next()` is returned without waiting on
 * the auth lookup or the INSERT, so capture is latency-transparent.
 */
export async function capture(
  template: string,
  method: string,
  req: Request,
  next: () => Response | Promise<Response>,
): Promise<Response> {
  const sessionId = validSessionId(req.headers.get("x-anon-session"));
  const surface = validSurface(req.headers.get("x-anon-surface"));
  track(
    isAuthed(req).then((authenticated) =>
      recordEvent({ kind: "api", surface, route: template, method, sessionId, authenticated }),
    ),
  );
  return await next();
}

/**
 * Record a page-view for `surface` (a trusted caller-supplied literal: the
 * home/viewer landing requests pass their constant label; the bulk-analyzer
 * ping passes a header-validated one). Fire-and-forget, same best-effort posture
 * as `capture`. `route`/`method` are null for page-views.
 */
export function recordPageView(surface: string, req: Request): void {
  const sessionId = validSessionId(req.headers.get("x-anon-session"));
  track(
    isAuthed(req).then((authenticated) =>
      recordEvent({ kind: "page_view", surface, route: null, method: null, sessionId, authenticated }),
    ),
  );
}
