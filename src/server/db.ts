// Server-only Postgres access via Bun's native SQL client (plan U1).
//
// This module is under src/server/ and must never be imported by a browser
// bundle — the boundary build-graph test enforces that. DATABASE_URL is read
// from process.env (Bun auto-loads .env); it must NOT be a BUN_PUBLIC_ var,
// which would be inlined into the browser build.

import { SQL } from "bun";

let client: SQL | null = null;

/** Lazily open the pooled Postgres connection. Throws if DATABASE_URL is unset. */
export function getSql(): SQL {
  if (client) return client;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — a PostgreSQL connection string is required to run the server.",
    );
  }
  client = new SQL(url);
  return client;
}

/** Test/teardown helper: close and reset the connection. */
export async function closeSql(): Promise<void> {
  if (client) {
    await client.end();
    client = null;
  }
}
