// Expiry/tombstone sweeper (plan U5).
//
// Two batched passes guarded by a single Postgres advisory lock so overlapping
// runs never double-process: (1) tombstone active rows past their TTL (ciphertext
// nulled), (2) physically purge tombstoned rows past a grace window. FOR UPDATE
// SKIP LOCKED keeps each batch from contending with lazy-expiry on read. When the
// FK from history_keys lands (U9, ON DELETE CASCADE), the purge cleans those too.

import { getSql } from "./db";

const SWEEP_LOCK_KEY = 776611; // arbitrary key for pg_try_advisory_lock
const DEFAULT_BATCH = 500;

export interface SweepResult {
  expired: number;
  purged: number;
  skipped: boolean;
}

export async function sweep(batchSize = DEFAULT_BATCH): Promise<SweepResult> {
  const sql = getSql();

  const lock = await sql`SELECT pg_try_advisory_lock(${SWEEP_LOCK_KEY}) AS locked`;
  if (!lock[0]?.locked) return { expired: 0, purged: 0, skipped: true };

  try {
    const expired = await sql`
      UPDATE shares SET state = 'expired', ciphertext = NULL, uploader_ip_hash = NULL
      WHERE id IN (
        SELECT id FROM shares
        WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at <= now()
        ORDER BY expires_at
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `;

    const purged = await sql`
      DELETE FROM shares
      WHERE id IN (
        SELECT id FROM shares
        WHERE state IN ('expired', 'deleted')
          AND expires_at IS NOT NULL
          AND expires_at <= now() - INTERVAL '1 day'
        ORDER BY expires_at
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `;

    return { expired: expired.length, purged: purged.length, skipped: false };
  } finally {
    await sql`SELECT pg_advisory_unlock(${SWEEP_LOCK_KEY})`;
  }
}

// Allow `bun run src/server/sweeper.ts` as a scheduled job entry point.
if (import.meta.main) {
  const r = await sweep();
  console.log(
    `Sweep: expired ${r.expired}, purged ${r.purged}${r.skipped ? " (skipped — lock held)" : ""}`,
  );
  const { closeSql } = await import("./db");
  await closeSql();
}
