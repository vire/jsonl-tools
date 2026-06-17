import { test, expect, afterAll, spyOn } from "bun:test";
import { migrate } from "./migrate";
import { getSql, closeSql } from "./db";
import { upsertUser } from "./oauth-github";
import { createSession, SESSION_COOKIE } from "./sessions";
import {
  capture,
  recordPageView,
  recordEvent,
  flushAnalytics,
  validSessionId,
  validSurface,
} from "./analytics";

// DB-gated tests skip cleanly without DATABASE_URL; the pure-function tests
// below always run.
const dbTest = process.env.DATABASE_URL ? test : test.skip;

afterAll(async () => {
  if (process.env.DATABASE_URL) await closeSql();
});

const GOOD_UUID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"; // a real v4

function uuid(): string {
  return crypto.randomUUID();
}
// A fresh, unique route template per call so each row is found deterministically
// regardless of what session_id/surface resolved to (events persist across runs).
function uniqueRoute(): string {
  return `/api/test/${crypto.randomUUID()}`;
}
function req(opts: { url?: string; cookie?: string; session?: string; surface?: string } = {}): Request {
  const headers: Record<string, string> = { host: "localhost" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.session) headers["x-anon-session"] = opts.session;
  if (opts.surface) headers["x-anon-surface"] = opts.surface;
  return new Request(opts.url ?? "http://localhost/x", { headers });
}
async function authCookie(): Promise<string> {
  const gid = 700_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 100_000_000);
  const uid = await upsertUser(gid);
  const sid = await createSession(uid);
  return `${SESSION_COOKIE}=${sid}`;
}
async function rowByRoute(route: string): Promise<any> {
  const rows = await getSql()`SELECT * FROM events WHERE route = ${route}`;
  return rows[0] ?? null;
}
async function rowBySession(sessionId: string, kind: string): Promise<any> {
  const rows = await getSql()`
    SELECT * FROM events WHERE session_id = ${sessionId} AND kind = ${kind}
  `;
  return rows[0] ?? null;
}
const ok = () => new Response("ok");

// --- Pure validation (no DB; always runs) ---

test("validSessionId accepts an exact UUID v4 (case-insensitive) and rejects all else", () => {
  expect(validSessionId(GOOD_UUID)).toBe(GOOD_UUID);
  expect(validSessionId(GOOD_UUID.toUpperCase())).toBe(GOOD_UUID.toUpperCase());
  expect(validSessionId(null)).toBeNull();
  expect(validSessionId(undefined)).toBeNull();
  expect(validSessionId("")).toBeNull();
  expect(validSessionId("not-a-uuid")).toBeNull();
  expect(validSessionId(GOOD_UUID + "extra")).toBeNull(); // over-length
  expect(validSessionId(GOOD_UUID + "\n")).toBeNull(); // trailing CRLF / control char
  expect(validSessionId(" " + GOOD_UUID)).toBeNull(); // leading space
  // version nibble must be 4
  expect(validSessionId("1b9d6bcd-bbfd-1b2d-9b5d-ab8dfbbd4bed")).toBeNull();
  // variant nibble must be 8/9/a/b
  expect(validSessionId("1b9d6bcd-bbfd-4b2d-7b5d-ab8dfbbd4bed")).toBeNull();
});

test("validSurface accepts only the fixed allowlist", () => {
  expect(validSurface("home")).toBe("home");
  expect(validSurface("viewer")).toBe("viewer");
  expect(validSurface("bulk-analyzer")).toBe("bulk-analyzer");
  expect(validSurface("admin")).toBeNull();
  expect(validSurface("HOME")).toBeNull();
  expect(validSurface(null)).toBeNull();
  expect(validSurface("")).toBeNull();
});

// --- Capture behavior (DB-gated) ---

dbTest("Covers AE3: capture stores the route template, never the concrete id", async () => {
  await migrate();
  const session = uuid();
  // The URL carries the concrete id; capture only ever receives the template.
  const res = await capture(
    "/api/shares/:id",
    "GET",
    req({ url: "http://localhost/api/shares/abc123def", session }),
    () => Response.json({ ok: true }),
  );
  await flushAnalytics();

  expect(await res.json()).toEqual({ ok: true }); // transparent passthrough
  const row = await rowBySession(session, "api");
  expect(row).not.toBeNull();
  expect(row.kind).toBe("api");
  expect(row.route).toBe("/api/shares/:id");
  expect(row.method).toBe("GET");
  expect(row.session_id).toBe(session);
  // the concrete id never reaches capture, so it can appear in no column
  expect(JSON.stringify(row)).not.toContain("abc123");
});

dbTest("X-Anon-Session is validated before storage", async () => {
  await migrate();
  const good = uuid();
  const rGood = uniqueRoute();
  const rBad = uniqueRoute();
  const rLong = uniqueRoute();
  const rAbsent = uniqueRoute();
  await capture(rGood, "GET", req({ session: good }), ok);
  await capture(rBad, "GET", req({ session: "not-a-uuid" }), ok);
  await capture(rLong, "GET", req({ session: good + "aaaa" }), ok);
  await capture(rAbsent, "GET", req(), ok);
  await flushAnalytics();

  expect((await rowByRoute(rGood)).session_id).toBe(good);
  expect((await rowByRoute(rBad)).session_id).toBeNull();
  expect((await rowByRoute(rLong)).session_id).toBeNull();
  expect((await rowByRoute(rAbsent)).session_id).toBeNull();
});

dbTest("X-Anon-Surface outside the allowlist stores null", async () => {
  await migrate();
  const rGood = uniqueRoute();
  const rBad = uniqueRoute();
  await capture(rGood, "GET", req({ surface: "home" }), ok);
  await capture(rBad, "GET", req({ surface: "evil" }), ok);
  await flushAnalytics();

  expect((await rowByRoute(rGood)).surface).toBe("home");
  expect((await rowByRoute(rBad)).surface).toBeNull();
});

dbTest("authenticated reflects a valid session cookie", async () => {
  await migrate();
  const cookie = await authCookie();
  const rAuthed = uniqueRoute();
  const rAnon = uniqueRoute();
  await capture(rAuthed, "GET", req({ cookie }), ok);
  await capture(rAnon, "GET", req(), ok);
  await flushAnalytics();

  expect((await rowByRoute(rAuthed)).authenticated).toBe(true);
  expect((await rowByRoute(rAnon)).authenticated).toBe(false);
});

dbTest("recordPageView writes a page_view with null route/method", async () => {
  await migrate();
  const session = uuid();
  recordPageView("home", req({ session }));
  await flushAnalytics();

  const row = await rowBySession(session, "page_view");
  expect(row).not.toBeNull();
  expect(row.kind).toBe("page_view");
  expect(row.surface).toBe("home");
  expect(row.route).toBeNull();
  expect(row.method).toBeNull();
  expect(row.session_id).toBe(session);
});

dbTest("capture is transparent: returns next()'s response unchanged", async () => {
  await migrate();
  const body = { hello: "world", n: 42 };
  const res = await capture(uniqueRoute(), "POST", req(), () =>
    Response.json(body, { status: 201, headers: { "x-test": "1" } }),
  );
  expect(res.status).toBe(201);
  expect(res.headers.get("x-test")).toBe("1");
  expect(await res.json()).toEqual(body);
  await flushAnalytics();
});

dbTest("Covers AE5: a failing write is swallowed and logged once", async () => {
  await migrate();
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    // An invalid `kind` violates the CHECK constraint, forcing the INSERT to
    // throw. recordEvent must catch it, log exactly once, and resolve (no throw).
    await recordEvent({
      kind: "bogus" as any,
      surface: null,
      route: null,
      method: null,
      sessionId: null,
      authenticated: false,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe("[analytics]");
  } finally {
    spy.mockRestore();
  }
});
