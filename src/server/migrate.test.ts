import { test, expect } from "bun:test";
import { migrate } from "./migrate";
import { getSql, closeSql } from "./db";

// These tests require a PostgreSQL instance. They skip cleanly when DATABASE_URL
// is unset (e.g. CI without a DB) and run for real when one is provided.
const dbTest = process.env.DATABASE_URL ? test : test.skip;

dbTest("migrate creates the shares table and is idempotent", async () => {
  await migrate();
  const second = await migrate();
  expect(second.applied).toEqual([]); // nothing left to apply on re-run

  const sql = getSql();
  const rows = await sql`SELECT to_regclass('public.shares') AS t`;
  expect(rows[0]!.t).toBe("shares");

  await closeSql();
});

dbTest("schema creates cli_tokens and the history_keys.cli_token_id column", async () => {
  await migrate();
  const sql = getSql();

  // cli_tokens table exists
  const tbl = await sql`SELECT to_regclass('public.cli_tokens') AS t`;
  expect(tbl[0]!.t).toBe("cli_tokens");

  // expected columns and types on cli_tokens
  const cols = await sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'cli_tokens'
    ORDER BY column_name
  `;
  const byName = Object.fromEntries(cols.map((c: any) => [c.column_name, c]));
  expect(byName.token_id?.is_nullable).toBe("NO");
  expect(byName.auth_secret_hash?.is_nullable).toBe("NO");
  expect(byName.wrapped_machine_key?.data_type).toBe("jsonb");
  expect(byName.revoked_at?.is_nullable).toBe("YES");
  expect(byName.last_used_at?.is_nullable).toBe("YES");

  // history_keys gained a nullable cli_token_id column
  const hk = await sql`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'history_keys' AND column_name = 'cli_token_id'
  `;
  expect(hk.length).toBe(1);
  expect(hk[0]!.is_nullable).toBe("YES");

  // the FK index is present
  const idx = await sql`SELECT to_regclass('public.history_keys_cli_token_idx') AS i`;
  expect(idx[0]!.i).toBe("history_keys_cli_token_idx");

  await closeSql();
});

dbTest("the baseline schema is idempotent on re-run", async () => {
  await migrate();
  const second = await migrate();
  expect(second.applied).toEqual([]);
  await closeSql();
});
