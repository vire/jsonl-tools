import { test, expect, afterAll, afterEach, beforeEach } from "bun:test";
import { migrate } from "./migrate";
import { getSql, closeSql } from "./db";
import { upsertUser } from "./oauth-github";
import { createSession, SESSION_COOKIE } from "./sessions";
import { flushAnalytics } from "./analytics";
import { handleAnalyticsDashboard } from "./analytics-dashboard";

const dbTest = process.env.DATABASE_URL ? test : test.skip;

function randomGithubId(): number {
  return 700_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 100_000_000);
}
function getReq(cookie: string | null, query = ""): Request {
  const headers: Record<string, string> = { host: "localhost" };
  if (cookie) headers.cookie = cookie;
  return new Request(`http://localhost/admin/analytics${query}`, { headers });
}
async function cookieFor(githubId: number, login?: string): Promise<string> {
  const uid = await upsertUser(githubId, login);
  return `${SESSION_COOKIE}=${await createSession(uid)}`;
}

const savedEnv = process.env.OPERATOR_GITHUB_IDS;
beforeEach(async () => {
  if (process.env.DATABASE_URL) {
    await migrate();
    await getSql()`TRUNCATE events`;
  }
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.OPERATOR_GITHUB_IDS;
  else process.env.OPERATOR_GITHUB_IDS = savedEnv;
});
afterAll(async () => {
  if (process.env.DATABASE_URL) await closeSql();
});

dbTest("Covers AE4: logged-out and logged-in non-operator get an identical bodyless 404", async () => {
  process.env.OPERATOR_GITHUB_IDS = String(randomGithubId()); // some other operator
  const nonOpCookie = await cookieFor(randomGithubId(), "mallory");

  const loggedOut = await handleAnalyticsDashboard(getReq(null));
  const nonOp = await handleAnalyticsDashboard(getReq(nonOpCookie));

  expect(loggedOut.status).toBe(404);
  expect(nonOp.status).toBe(404);
  expect(await loggedOut.text()).toBe("");
  expect(await nonOp.text()).toBe(""); // nothing distinguishes forbidden from absent
});

dbTest("an operator gets a 200 HTML page with per-surface and route aggregates", async () => {
  const opId = randomGithubId();
  process.env.OPERATOR_GITHUB_IDS = `999, ${opId}, 1000`;
  const opCookie = await cookieFor(opId, "alice");

  const sql = getSql();
  // home: 3 page-views across 2 distinct sessions; viewer + bulk: session-less.
  await sql`INSERT INTO events (kind, surface, session_id, authenticated)
            VALUES ('page_view','home','11111111-1111-4111-8111-111111111111', false),
                   ('page_view','home','11111111-1111-4111-8111-111111111111', false),
                   ('page_view','home','22222222-2222-4222-8222-222222222222', true),
                   ('page_view','viewer', NULL, false),
                   ('page_view','bulk-analyzer', NULL, false)`;
  await sql`INSERT INTO events (kind, surface, route, method, authenticated)
            VALUES ('api','home','/api/shares','POST', true)`;

  const res = await handleAnalyticsDashboard(getReq(opCookie));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const html = await res.text();

  expect(html).toContain("<td>home</td><td>3</td><td>2</td>"); // views + distinct sessions
  expect(html).toContain("<td>viewer</td><td>1</td><td>n/a</td>"); // session-less surface
  expect(html).toContain("<td>bulk-analyzer</td><td>1</td><td>n/a</td>"); // session-less surface
  expect(html).toContain("<td>POST</td><td>/api/shares</td><td>1</td>");
});

dbTest("the gate is keyed on github_id, not the mutable login", async () => {
  const opId = randomGithubId();
  process.env.OPERATOR_GITHUB_IDS = String(opId);

  // Renaming the operator's login keeps access (same github_id).
  const renamed = await cookieFor(opId, "renamed-handle");
  expect((await handleAnalyticsDashboard(getReq(renamed))).status).toBe(200);

  // A different github_id is denied even if it reuses a familiar login string.
  const impostor = await cookieFor(randomGithubId(), "alice");
  expect((await handleAnalyticsDashboard(getReq(impostor))).status).toBe(404);
});

dbTest("date-range params bound the aggregates; out-of-range rows are excluded", async () => {
  const opId = randomGithubId();
  process.env.OPERATOR_GITHUB_IDS = String(opId);
  const opCookie = await cookieFor(opId);

  const sql = getSql();
  // One home page-view today, one 400 days ago (outside the default 30d window).
  await sql`INSERT INTO events (kind, surface, day, authenticated)
            VALUES ('page_view','home', current_date, false),
                   ('page_view','home', current_date - 400, false)`;

  // Default range (last 30d) sees only today's row.
  const def = await (await handleAnalyticsDashboard(getReq(opCookie))).text();
  expect(def).toContain("<td>home</td><td>1</td>");

  // An explicit range covering only the old day sees only that row.
  const oldDay = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
  const ranged = await (
    await handleAnalyticsDashboard(getReq(opCookie, `?from=${oldDay}&to=${oldDay}`))
  ).text();
  expect(ranged).toContain("<td>home</td><td>1</td>");

  // A reversed range is tolerated (swapped), not silently rendered empty.
  const today = new Date().toISOString().slice(0, 10);
  const reversed = await (
    await handleAnalyticsDashboard(getReq(opCookie, `?from=${today}&to=${oldDay}`))
  ).text();
  expect(reversed).toContain("<td>home</td><td>2</td>"); // both days now in range
});

dbTest("requesting the dashboard records no analytics event (route is unwrapped)", async () => {
  const opId = randomGithubId();
  process.env.OPERATOR_GITHUB_IDS = String(opId);
  const opCookie = await cookieFor(opId);

  await handleAnalyticsDashboard(getReq(opCookie));
  await flushAnalytics();

  const rows = await getSql()`SELECT count(*)::int AS n FROM events`;
  expect(rows[0]!.n).toBe(0); // the dashboard never measures itself (R14)
});
