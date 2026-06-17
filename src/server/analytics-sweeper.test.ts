import { test, expect, afterAll, beforeEach } from "bun:test";
import { SQL } from "bun";
import { migrate } from "./migrate";
import { getSql, closeSql } from "./db";
import { purgeEvents, PURGE_LOCK_KEY } from "./analytics-sweeper";

const dbTest = process.env.DATABASE_URL ? test : test.skip;

beforeEach(async () => {
  if (process.env.DATABASE_URL) {
    await migrate();
    await getSql()`TRUNCATE events`;
  }
});
afterAll(async () => {
  if (process.env.DATABASE_URL) await closeSql();
});

test("the purge lock key is distinct from the share sweeper's", () => {
  expect(PURGE_LOCK_KEY).not.toBe(776611);
});

dbTest("purges events older than the retention window, keeps those inside it", async () => {
  const sql = getSql();
  // 120 days old (outside default 90d) vs fresh (inside).
  await sql`INSERT INTO events (kind, authenticated, created_at)
            VALUES ('api', false, now() - make_interval(days => 120)),
                   ('page_view', false, now() - make_interval(days => 120))`;
  await sql`INSERT INTO events (kind, authenticated, created_at)
            VALUES ('api', false, now())`;

  const r = await purgeEvents();
  expect(r.skipped).toBe(false);
  expect(r.purged).toBe(2);

  const remaining = await sql`SELECT count(*)::int AS n FROM events`;
  expect(remaining[0]!.n).toBe(1); // only the fresh row survives
});

dbTest("a second run with the lock held is skipped and deletes nothing", async () => {
  const sql = getSql();
  await sql`INSERT INTO events (kind, authenticated, created_at)
            VALUES ('api', false, now() - make_interval(days => 120))`;

  // Hold the same advisory key on a separate connection.
  const holder = new SQL(process.env.DATABASE_URL!);
  await holder`SELECT pg_advisory_lock(${PURGE_LOCK_KEY})`;
  try {
    const r = await purgeEvents();
    expect(r.skipped).toBe(true);
    expect(r.purged).toBe(0);
    const remaining = await sql`SELECT count(*)::int AS n FROM events`;
    expect(remaining[0]!.n).toBe(1); // nothing deleted while the lock is held
  } finally {
    await holder`SELECT pg_advisory_unlock(${PURGE_LOCK_KEY})`;
    await holder.end();
  }
});

dbTest("EVENTS_RETENTION_DAYS overrides the default window", async () => {
  const sql = getSql();
  await sql`INSERT INTO events (kind, authenticated, created_at)
            VALUES ('api', false, now() - make_interval(days => 10))`;

  const saved = process.env.EVENTS_RETENTION_DAYS;
  process.env.EVENTS_RETENTION_DAYS = "7"; // 10-day-old row now exceeds the window
  try {
    const r = await purgeEvents();
    expect(r.purged).toBe(1);
  } finally {
    if (saved === undefined) delete process.env.EVENTS_RETENTION_DAYS;
    else process.env.EVENTS_RETENTION_DAYS = saved;
  }
});
