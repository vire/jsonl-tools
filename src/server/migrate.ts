// Append-only, checksummed migration runner (plan U1).
//
// Bun.sql ships no migration framework, so this is the hand-rolled equivalent:
// ordered *.sql files, each applied once with its DDL and ledger row committed
// in the SAME transaction. A previously-applied file whose content changed is a
// hard error — migrations are append-only; new schema goes in a new file.

import { Glob } from "bun";
import { getSql } from "./db";

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url).pathname;

export interface MigrateResult {
  applied: string[];
}

export async function migrate(): Promise<MigrateResult> {
  const sql = getSql();

  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text PRIMARY KEY,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

  // deterministic order by zero-padded filename — never readdir order
  const files = [...new Glob("*.sql").scanSync({ cwd: MIGRATIONS_DIR })].sort();
  const applied: string[] = [];

  for (const file of files) {
    const content = await Bun.file(`${MIGRATIONS_DIR}${file}`).text();
    const checksum = new Bun.CryptoHasher("sha256")
      .update(content)
      .digest("hex");

    const existing = await sql`
      SELECT checksum FROM schema_migrations WHERE filename = ${file}
    `;
    if (existing.length > 0) {
      if (existing[0]!.checksum !== checksum) {
        throw new Error(
          `Migration ${file} changed after being applied (checksum drift). ` +
            `Migrations are append-only — add a new file instead of editing this one.`,
        );
      }
      continue; // already applied, unchanged
    }

    // DDL + ledger row in one transaction: a crash mid-apply leaves the ledger
    // consistent with what actually ran, so the next run resumes cleanly.
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`
        INSERT INTO schema_migrations (filename, checksum)
        VALUES (${file}, ${checksum})
      `;
    });
    applied.push(file);
  }

  return { applied };
}

// Allow `bun run src/server/migrate.ts` as a one-shot migration command.
if (import.meta.main) {
  const { applied } = await migrate();
  console.log(
    applied.length > 0
      ? `Applied migrations: ${applied.join(", ")}`
      : "No pending migrations.",
  );
  const { closeSql } = await import("./db");
  await closeSql();
}
