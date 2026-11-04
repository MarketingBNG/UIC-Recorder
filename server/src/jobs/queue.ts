import type { Db } from "../db.js";

export const MAX_ATTEMPTS = 5;
export const STALE_LOCK_MINUTES = 10;

export interface ClaimedJob {
  id: string;
  callId: string;
  attempts: number;
}

/**
 * Atomically claims up to `limit` runnable jobs (highest priority, oldest first).
 * Jobs whose worker died (no heartbeat for STALE_LOCK_MINUTES) are reclaimed,
 * unless they've used up their attempts, in which case they're failed.
 */
export async function claimJobs(db: Db, workerId: string, limit: number): Promise<ClaimedJob[]> {
  await failExhaustedStaleJobs(db);
  return db.$queryRaw<ClaimedJob[]>`
    UPDATE "jobs" SET
      "status" = 'RUNNING',
      "locked_at" = now(),
      "locked_by" = ${workerId},
      "attempts" = "attempts" + 1,
      "updated_at" = now()
    WHERE "id" IN (
      SELECT "id" FROM "jobs"
      WHERE ("status" IN ('QUEUED', 'WAITING_BUDGET') AND "run_after" <= now())
         OR ("status" = 'RUNNING' AND "locked_at" < now() - make_interval(mins => ${STALE_LOCK_MINUTES})
             AND "attempts" < ${MAX_ATTEMPTS})
      ORDER BY "priority" DESC, "created_at" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "call_id" AS "callId", "attempts"`;
}

/** Stale jobs that already hit MAX_ATTEMPTS (e.g. a file that crashes the worker) stop here. */
async function failExhaustedStaleJobs(db: Db): Promise<void> {
  await db.$executeRaw`
    WITH dead AS (
      UPDATE "jobs" SET "status" = 'FAILED', "locked_at" = NULL, "locked_by" = NULL,
        "last_error" = coalesce("last_error", 'worker stopped responding'), "updated_at" = now()
      WHERE "status" = 'RUNNING'
        AND "locked_at" < now() - make_interval(mins => ${STALE_LOCK_MINUTES})
        AND "attempts" >= ${MAX_ATTEMPTS}
      RETURNING "call_id"
    )
    UPDATE "calls" SET "status" = 'FAILED', "updated_at" = now() WHERE "id" IN (SELECT "call_id" FROM dead)`;
}

/** Keeps a long-running job's lock fresh. Returns false if the lock was lost. */
export async function heartbeatJob(db: Db, jobId: string, workerId: string): Promise<boolean> {
  const { count } = await db.job.updateMany({
    where: { id: jobId, status: "RUNNING", lockedBy: workerId },
    data: { lockedAt: new Date() },
  });
  return count === 1;
}

export interface TranscriptResult {
  text: string;
  language?: string | undefined;
  provider: string;
  segments?: unknown;
}

/** Stores a transcript for a job this worker holds. Returns false if the lock was lost. */
export async function completeJob(db: Db, jobId: string, workerId: string, result: TranscriptResult) {
  return db.$transaction(async (tx) => {
    const job = await tx.job.findFirst({ where: { id: jobId, status: "RUNNING", lockedBy: workerId } });
    if (!job) return false;
    const data = {
      text: result.text,
      language: result.language ?? null,
      provider: result.provider,
      segments: (result.segments ?? undefined) as object | undefined,
    };
    await tx.transcript.upsert({ where: { callId: job.callId }, create: { callId: job.callId, ...data }, update: data });
    await tx.job.update({ where: { id: job.id }, data: { status: "DONE", lockedAt: null, lastError: null } });
    await tx.call.update({ where: { id: job.callId }, data: { status: "TRANSCRIBED" } });
    return true;
  });
}

/** Records a failure; retries with exponential backoff until MAX_ATTEMPTS. */
export async function failJob(db: Db, jobId: string, workerId: string, error: string, retryable: boolean) {
  return db.$transaction(async (tx) => {
    const job = await tx.job.findFirst({ where: { id: jobId, status: "RUNNING", lockedBy: workerId } });
    if (!job) return false;
    const giveUp = !retryable || job.attempts >= MAX_ATTEMPTS;
    const backoffMs = 2 ** job.attempts * 60_000;
    await tx.job.update({
      where: { id: job.id },
      data: {
        status: giveUp ? "FAILED" : "QUEUED",
        lastError: error.slice(0, 2000),
        lockedAt: null,
        lockedBy: null,
        runAfter: giveUp ? job.runAfter : new Date(Date.now() + backoffMs),
      },
    });
    await tx.call.update({ where: { id: job.callId }, data: { status: giveUp ? "FAILED" : "UPLOADED" } });
    return true;
  });
}
