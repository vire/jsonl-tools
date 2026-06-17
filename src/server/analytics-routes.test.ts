import { test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { migrate } from "./migrate";
import { getSql, closeSql } from "./db";
import { flushAnalytics } from "./analytics";
import { createRoutes } from "../index";

// Boots the REAL route map (createRoutes) on a throwaway ephemeral-port server
// and drives it over HTTP, so the actual wiring is under test — which routes are
// instrumented, which page-views are derived, and which catch-alls stay bare.
const dbTest = process.env.DATABASE_URL ? test : test.skip;

let server: ReturnType<typeof Bun.serve> | null = null;
let base = "";

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  await migrate();
  server = Bun.serve({ port: 0, routes: createRoutes(() => "127.0.0.1") });
  base = server.url.origin;
});

// Each test starts from an empty table (bun runs test files sequentially, so
// this never races other files). Flush first so a prior test's fire-and-forget
// write can't land after the truncate.
beforeEach(async () => {
  if (!process.env.DATABASE_URL) return;
  await flushAnalytics();
  await getSql()`TRUNCATE events`;
});

afterAll(async () => {
  if (server) server.stop(true);
  if (process.env.DATABASE_URL) await closeSql();
});

async function events(): Promise<any[]> {
  return (await getSql()`SELECT * FROM events ORDER BY id`) as unknown as any[];
}

dbTest("Covers AE1: bulk-analyzer ping records a session-less page_view", async () => {
  // The bulk-analyzer carries no session id by design (KTD3/KTD5), so the real
  // client ping sends no X-Anon-Session — matched here.
  const res = await fetch(`${base}/api/events`, {
    method: "POST",
    headers: { "x-anon-surface": "bulk-analyzer" },
  });
  expect(res.status).toBe(204);
  await flushAnalytics();

  const rows = await events();
  expect(rows.length).toBe(1);
  expect(rows[0].kind).toBe("page_view");
  expect(rows[0].surface).toBe("bulk-analyzer");
  expect(rows[0].route).toBeNull();
  expect(rows[0].method).toBeNull();
  expect(rows[0].session_id).toBeNull(); // distinct-session counts unavailable here
});

dbTest("an invalid surface on the ping records nothing", async () => {
  const res = await fetch(`${base}/api/events`, {
    method: "POST",
    headers: { "x-anon-surface": "evil" },
  });
  expect(res.status).toBe(204); // opaque
  await flushAnalytics();
  expect((await events()).length).toBe(0);
});

dbTest("GET /api/auth/me with X-Anon-Surface: home records api + home page_view", async () => {
  const res = await fetch(`${base}/api/auth/me`, { headers: { "x-anon-surface": "home" } });
  expect(res.status).toBe(401); // unauthed; capture + page-view still fire
  await flushAnalytics();

  const rows = await events();
  expect(rows.length).toBe(2);
  const api = rows.find((r) => r.kind === "api");
  const pv = rows.find((r) => r.kind === "page_view");
  expect(api.route).toBe("/api/auth/me");
  expect(api.surface).toBe("home");
  expect(pv.surface).toBe("home");
  expect(pv.route).toBeNull();
  expect(pv.method).toBeNull();
});

dbTest("GET /api/auth/me WITHOUT the surface header records only the api event", async () => {
  const res = await fetch(`${base}/api/auth/me`);
  expect(res.status).toBe(401);
  await flushAnalytics();

  const rows = await events();
  expect(rows.length).toBe(1);
  expect(rows[0].kind).toBe("api");
  expect(rows[0].route).toBe("/api/auth/me");
  expect(rows[0].surface).toBeNull();
});

dbTest("GET /api/shares/:id with X-Anon-Surface: viewer records a session-less viewer page_view", async () => {
  // No X-Anon-Session sent — the key-bearing viewer carries none (KTD3/KTD5).
  const res = await fetch(`${base}/api/shares/nonexistent-id`, {
    headers: { "x-anon-surface": "viewer" },
  });
  expect(res.status).toBe(404); // share not found; page-view still recorded
  await flushAnalytics();

  const rows = await events();
  const pv = rows.find((r) => r.kind === "page_view");
  const api = rows.find((r) => r.kind === "api");
  expect(pv.surface).toBe("viewer");
  expect(pv.session_id).toBeNull();
  expect(api.route).toBe("/api/shares/:id"); // template, never the concrete id
  expect(rows.some((r) => JSON.stringify(r).includes("nonexistent-id"))).toBe(false);
});

dbTest("POST /api/shares records one api event keyed /api/shares + POST", async () => {
  const res = await fetch(`${base}/api/shares`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}), // invalid body → handler rejects; capture still records
  });
  // The handler's own validation response is unchanged by wrapping.
  expect(res.status).toBeGreaterThanOrEqual(400);
  await flushAnalytics();

  const api = (await events()).filter((r) => r.kind === "api");
  expect(api.length).toBe(1);
  expect(api[0].route).toBe("/api/shares");
  expect(api[0].method).toBe("POST");
});

dbTest("the /* and /api/* catch-alls record no events", async () => {
  await fetch(`${base}/some/unmatched/asset.js`); // served by "/*" (bare)
  const unknownApi = await fetch(`${base}/api/zzz-unknown`); // "/api/*" 404 (bare)
  expect(unknownApi.status).toBe(404);
  await flushAnalytics();

  expect((await events()).length).toBe(0);
});
