// Analytics retention purge.
//
// Deletes raw `events` older than the retention window in batches, guarded by a
// Postgres advisory lock so overlapping runs never double-scan. FOR UPDATE SKIP
// LOCKED keeps each batch from contending with a concurrent run. Like the share
// sweeper, this is NOT auto-scheduled — the ~90-day
// bound holds only if the operator schedules it (cron / a scheduled task); see docs/DEPLOYMENT.md.

import { getSql } from "./db";

// Distinct from the share sweeper's 776611, so the two jobs never block each
// other on the same advisory lock.
export const PURGE_LOCK_KEY = 776612;
const DEFAULT_BATCH = 1000;

/** Retention window in days (env-overridable), default 90. */
function retentionDays(): number {
  const n = Number(process.env.EVENTS_RETENTION_DAYS);
  return Number.isInteger(n) && n > 0 ? n : 90;
}

export interface PurgeResult {
  purged: number;
  skipped: boolean;
}

/**
 * Purge events older than the retention window. Drains in batches within a
 * single locked run so one invocation actually enforces the bound. Returns
 * `{ skipped: true }` if another run holds the lock.
 */
export async function purgeEvents(batchSize = DEFAULT_BATCH): Promise<PurgeResult> {
  const sql = getSql();

  const lock = await sql`SELECT pg_try_advisory_lock(${PURGE_LOCK_KEY}) AS locked`;
  if (!lock[0]?.locked) return { purged: 0, skipped: true };

  try {
    const days = retentionDays();
    let purged = 0;
    for (;;) {
      const batch = await sql`
        DELETE FROM events
        WHERE id IN (
          SELECT id FROM events
          WHERE created_at <= now() - make_interval(days => ${days})
          ORDER BY created_at
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id
      `;
      purged += batch.length;
      if (batch.length < batchSize) break;
    }
    return { purged, skipped: false };
  } finally {
    await sql`SELECT pg_advisory_unlock(${PURGE_LOCK_KEY})`;
  }
}

// Allow `bun run src/server/analytics-sweeper.ts` as a scheduled job entry point.
if (import.meta.main) {
  const r = await purgeEvents();
  console.log(
    `Analytics purge: ${r.purged} event(s) deleted${r.skipped ? " (skipped — lock held)" : ""}`,
  );
  const { closeSql } = await import("./db");
  await closeSql();
}
