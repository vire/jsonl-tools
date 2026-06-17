// Local-dev convenience: wipe the `DATABASE_URL` database back to a fresh,
// fully-migrated state. Drops everything in the `public` schema (including the
// `schema_migrations` ledger), then re-applies the full migration history.
//
// Guarded against `NODE_ENV=production` so a mis-pointed DATABASE_URL can't nuke
// real data. Operates on whatever DATABASE_URL points to — keep it on a dev DB.
//
//   bun run db:reset

import { getSql, closeSql } from "./db";
import { migrate } from "./migrate";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run db:reset with NODE_ENV=production.");
  process.exit(1);
}

const sql = getSql();
// One statement: drop the schema and its contents, then recreate it empty.
await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
const { applied } = await migrate();
console.log(`db:reset — schema wiped; ${applied.length} migrations applied.`);
await closeSql();
