import { test, expect, afterAll } from "bun:test";
import { migrate } from "./migrate";
import { getSql, closeSql } from "./db";
import { sweep } from "./sweeper";
import { generateShareId } from "../share-crypto";
import { sha256hex } from "./shares";

const dbTest = process.env.DATABASE_URL ? test : test.skip;
afterAll(async () => {
  if (process.env.DATABASE_URL) await closeSql();
});

async function insertShare(state: string, hoursFromNow: number): Promise<string> {
  const id = generateShareId();
  const sql = getSql();
  await sql`
    INSERT INTO shares (id, ciphertext, iv, aad, size_bytes, state, expires_at, admin_token_hash)
    VALUES (${id}, ${Buffer.from("x")}, 'iv', '{"v":1}'::jsonb, 1, ${state},
            now() + make_interval(hours => ${hoursFromNow}), ${sha256hex("t")})
  `;
  return id;
}

dbTest("sweep tombstones expired-active rows and purges tombstoned rows past grace", async () => {
  await migrate();
  const expiredActive = await insertShare("active", -1); // expired 1h ago, still 'active'
  const oldTombstone = await insertShare("expired", -48); // tombstoned, 2d past expiry (> 1d grace)
  const freshActive = await insertShare("active", 24); // valid

  const r = await sweep();
  expect(r.skipped).toBe(false);
  expect(r.expired).toBeGreaterThanOrEqual(1);

  const sql = getSql();
  const a = await sql`SELECT state, ciphertext FROM shares WHERE id = ${expiredActive}`;
  expect(a[0]!.state).toBe("expired");
  expect(a[0]!.ciphertext).toBeNull();

  // the old tombstone is physically gone
  const gone = await sql`SELECT 1 FROM shares WHERE id = ${oldTombstone}`;
  expect(gone.length).toBe(0);

  // a still-valid share is untouched
  const f = await sql`SELECT state FROM shares WHERE id = ${freshActive}`;
  expect(f[0]!.state).toBe("active");

  // re-running is safe (idempotent, lock released)
  const r2 = await sweep();
  expect(r2.skipped).toBe(false);
});
