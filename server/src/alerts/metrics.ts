import type { Db } from "../db.js";
import { ESTIMATE_BYTES_PER_S, firefliesUsage } from "../fireflies/budget.js";
import { SUPERSEDED } from "../jobs/queue.js";

const HOUR = 3600_000;

/** Finished transcribe jobs over a window: throughput, failure rate and time per job. */
export async function jobStats(db: Db, windowMs: number, now = new Date(), kind = "transcribe") {
  const since = new Date(now.getTime() - windowMs);
  const rows = await db.$queryRaw<{ done: bigint; failed: bigint; avg_s: number | null }[]>`
    SELECT
      count(*) FILTER (WHERE "status" = 'DONE') AS "done",
      count(*) FILTER (WHERE "status" = 'FAILED') AS "failed",
      avg(extract(epoch FROM "finished_at" - "started_at")) FILTER (WHERE "status" = 'DONE' AND "started_at" IS NOT NULL)::float8 AS "avg_s"
    FROM "jobs"
    WHERE "kind" = ${kind} AND "finished_at" > ${since} AND "finished_at" <= ${now}
      AND coalesce("last_error", '') <> ${SUPERSEDED}`;
  const done = Number(rows[0]?.done ?? 0);
  const failed = Number(rows[0]?.failed ?? 0);
  const total = done + failed;
  return {
    done,
    failed,
    failureRatePct: total > 0 ? Math.round((failed / total) * 1000) / 10 : 0,
    avgJobSeconds: rows[0]?.avg_s == null ? null : Math.round(rows[0].avg_s),
  };
}

/** Fireflies minutes still needed by calls with an open transcribe job (same estimate as reservations). */
export async function backlogMinutes(db: Db): Promise<{ calls: number; minutes: number }> {
  const rows = await db.$queryRaw<{ calls: bigint; minutes: bigint | null }[]>`
    SELECT count(*) AS "calls",
      sum(greatest(1, ceil(CASE WHEN c."duration_s" > 0 THEN c."duration_s"
        ELSE coalesce(c."file_size", 0)::float8 / ${ESTIMATE_BYTES_PER_S} END / 60.0)))::bigint AS "minutes"
    FROM "calls" c
    WHERE EXISTS (SELECT 1 FROM "jobs" j WHERE j."call_id" = c."id" AND j."kind" = 'transcribe'
      AND j."status" IN ('QUEUED', 'RUNNING', 'WAITING_BUDGET'))`;
  return { calls: Number(rows[0]?.calls ?? 0), minutes: Number(rows[0]?.minutes ?? 0) };
}

/**
 * Health metrics for /api/stats. Backlog ETA is limited by the Fireflies monthly budget:
 * months = backlog minutes / budget minutes (rate-based hours given too).
 */
export async function throughput(db: Db, now = new Date()) {
  const [day, hour, backlog, ff] = await Promise.all([
    jobStats(db, 24 * HOUR, now),
    jobStats(db, HOUR, now),
    backlogMinutes(db),
    firefliesUsage(db, now),
  ]);
  const jobsPerHour = Math.round((day.done / 24) * 10) / 10;
  return {
    jobsPerHour,
    doneLastHour: hour.done,
    failureRatePct: day.failureRatePct,
    failureRatePctLastHour: hour.failureRatePct,
    avgJobSeconds: day.avgJobSeconds,
    backlogCalls: backlog.calls,
    backlogMinutes: backlog.minutes,
    // Months of Fireflies budget the backlog needs; null when there is no budget.
    backlogEtaMonths: ff.budgetMinutes > 0 ? Math.round((backlog.minutes / ff.budgetMinutes) * 10) / 10 : null,
    // Hours at the last 24 h rate; null when nothing finished.
    backlogEtaHours: jobsPerHour > 0 ? Math.round(backlog.calls / jobsPerHour) : null,
  };
}
