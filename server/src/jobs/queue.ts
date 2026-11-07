import type { Db } from "../db.js";
import { claudeCostUsd } from "../translation/cost.js";

export const MAX_ATTEMPTS = 5;
export const STALE_LOCK_MINUTES = 10;
/** lastError of a translate job replaced by a newer transcript (not a real failure). */
export const SUPERSEDED = "superseded by re-transcription";

export const JOB_KINDS = ["transcribe", "translate", "compress"] as const;
/** Kinds that run on an already TRANSCRIBED call and never change its status. */
export const SIDE_KINDS = ["translate", "compress"] as const;
/** Stored audio above this bitrate is worth re-encoding (phones upload ~24 kbps AAC). */
export const COMPRESS_MIN_BPS = 40_000;
export type JobKind = (typeof JOB_KINDS)[number];

export interface ClaimedJob {
  id: string;
  callId: string;
  attempts: number;
  kind: string;
  priority: number;
}

/**
 * Atomically claims up to `limit` runnable jobs (highest priority, oldest first).
 * Jobs whose worker died (no heartbeat for STALE_LOCK_MINUTES) are reclaimed,
 * unless they've used up their attempts, in which case they're failed.
 */
export async function claimJobs(
  db: Db,
  workerId: string,
  limit: number,
  kinds: readonly string[] = ["transcribe"],
): Promise<ClaimedJob[]> {
  await failExhaustedStaleJobs(db);
  return db.$queryRaw<ClaimedJob[]>`
    UPDATE "jobs" SET
      "status" = 'RUNNING',
      "locked_at" = now(),
      "started_at" = now(),
      "locked_by" = ${workerId},
      "attempts" = "attempts" + 1,
      "updated_at" = now()
    WHERE "id" IN (
      SELECT "id" FROM "jobs"
      WHERE "kind" = ANY(${[...kinds]}::text[])
        AND (("status" IN ('QUEUED', 'WAITING_BUDGET') AND "run_after" <= now())
          OR ("status" = 'RUNNING' AND "locked_at" < now() - make_interval(mins => ${STALE_LOCK_MINUTES})
              AND "attempts" < ${MAX_ATTEMPTS}))
      ORDER BY "priority" DESC, "created_at" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "call_id" AS "callId", "attempts", "kind", "priority"`;
}

/**
 * Sarvam overflow: backlog transcribe jobs parked by the Fireflies monthly budget (reason BUDGET only).
 * Never live calls, never calls already uploaded to Fireflies (those minutes are paid for), and only
 * while an admin has switched sarvamOverflow on (checked by the caller).
 */
export async function claimOverflowJobs(db: Db, workerId: string, limit: number): Promise<ClaimedJob[]> {
  return db.$queryRaw<ClaimedJob[]>`
    UPDATE "jobs" SET
      "status" = 'RUNNING',
      "locked_at" = now(),
      "started_at" = now(),
      "locked_by" = ${workerId},
      "attempts" = "attempts" + 1,
      "updated_at" = now()
    WHERE "id" IN (
      SELECT j."id" FROM "jobs" j JOIN "calls" c ON c."id" = j."call_id"
      WHERE j."kind" = 'transcribe'
        AND j."status" = 'WAITING_BUDGET'
        AND j."last_error" LIKE 'WAITING_BUDGET: BUDGET%'
        AND j."attempts" < ${MAX_ATTEMPTS}
        AND c."source" <> 'LIVE'
        AND NOT EXISTS (SELECT 1 FROM "fireflies_reservations" r WHERE r."call_id" = j."call_id" AND r."uploaded_at" IS NOT NULL)
      ORDER BY j."priority" DESC, j."created_at" ASC
      LIMIT ${limit}
      FOR UPDATE OF j SKIP LOCKED
    )
    RETURNING "id", "call_id" AS "callId", "attempts", "kind", "priority"`;
}

/** Stale jobs that already hit MAX_ATTEMPTS (e.g. a file that crashes the worker) stop here. */
async function failExhaustedStaleJobs(db: Db): Promise<void> {
  await db.$executeRaw`
    WITH dead AS (
      UPDATE "jobs" SET "status" = 'FAILED', "locked_at" = NULL, "locked_by" = NULL,
        "last_error" = coalesce("last_error", 'worker stopped responding'),
        "finished_at" = now(), "updated_at" = now()
      WHERE "status" = 'RUNNING'
        AND "locked_at" < now() - make_interval(mins => ${STALE_LOCK_MINUTES})
        AND "attempts" >= ${MAX_ATTEMPTS}
      RETURNING "call_id", "kind"
    )
    -- A failed translation or compression leaves the call TRANSCRIBED.
    UPDATE "calls" SET "status" = 'FAILED', "updated_at" = now()
    WHERE "id" IN (SELECT "call_id" FROM dead WHERE "kind" = 'transcribe')`;
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

/**
 * Stores a transcript for a transcribe job this worker holds. Returns false if the
 * lock was lost. With `translate`, also queues an English translation job.
 */
export async function completeJob(
  db: Db,
  jobId: string,
  workerId: string,
  result: TranscriptResult,
  opts: { translate?: boolean; compress?: boolean } = {},
) {
  return db.$transaction(async (tx) => {
    const job = await tx.job.findFirst({ where: { id: jobId, status: "RUNNING", lockedBy: workerId, kind: "transcribe" } });
    if (!job) return false;
    const data = {
      text: result.text,
      language: result.language ?? null,
      provider: result.provider,
      segments: (result.segments ?? undefined) as object | undefined,
      // A re-transcription invalidates any earlier English version.
      textEn: null,
      translationModel: null,
      translationInputTokens: null,
      translationOutputTokens: null,
      translationCostUsd: null,
    };
    await tx.transcript.upsert({ where: { callId: job.callId }, create: { callId: job.callId, ...data }, update: data });
    await tx.job.update({ where: { id: job.id }, data: { status: "DONE", lockedAt: null, lastError: null, finishedAt: new Date() } });
    await tx.call.update({ where: { id: job.callId }, data: { status: "TRANSCRIBED" } });
    // A running translate job already read the old transcript: take it out of play so
    // its later result is rejected (lock lost) instead of overwriting the new segments.
    await tx.job.updateMany({
      where: { callId: job.callId, kind: "translate", status: "RUNNING" },
      data: { status: "FAILED", lockedBy: null, lockedAt: null, lastError: SUPERSEDED, finishedAt: new Date() },
    });
    if (opts.translate) {
      // A queued one is fine: it reads the new transcript when claimed.
      const open = await tx.job.findFirst({
        where: { callId: job.callId, kind: "translate", status: "QUEUED" },
        select: { id: true },
      });
      if (!open) await tx.job.create({ data: { callId: job.callId, kind: "translate", priority: job.priority } });
    }
    if (opts.compress) await queueCompression(tx, job.callId);
    return true;
  });
}

export interface TranslationUsage {
  inputTokens: number;
  outputTokens: number;
  batch: boolean;
}

export interface TranslationResult {
  model: string;
  textEn: string;
  segments: Record<string, unknown>[];
  usage?: TranslationUsage | undefined;
}

/**
 * Stores the English version for a translate job this worker holds. Returns false if the lock was lost.
 * The Claude cost is recorded on the job either way: the tokens were paid for even if the result is discarded.
 */
/**
 * Adds a translate attempt's Claude cost to its job (a retried job pays again). Called for successful and
 * failed attempts alike: the tokens were paid for either way. Returns the cost, or null without usage.
 */
export async function recordTranslationCost(db: Db, jobId: string, model: string, usage: TranslationUsage | undefined) {
  const cost = usage ? claudeCostUsd(model, usage.inputTokens, usage.outputTokens, usage.batch) : null;
  if (cost !== null) {
    await db.$executeRaw`
      UPDATE "jobs" SET "cost_usd" = coalesce("cost_usd", 0) + ${cost}, "cost_at" = now()
      WHERE "id" = ${jobId}::uuid AND "kind" = 'translate'`;
  }
  return cost;
}

export async function completeTranslation(db: Db, jobId: string, workerId: string, result: TranslationResult) {
  const cost = await recordTranslationCost(db, jobId, result.model, result.usage);
  return db.$transaction(async (tx) => {
    const job = await tx.job.findFirst({ where: { id: jobId, status: "RUNNING", lockedBy: workerId, kind: "translate" } });
    if (!job) return false;
    const { count } = await tx.transcript.updateMany({
      where: { callId: job.callId },
      data: {
        textEn: result.textEn,
        translationModel: result.model,
        segments: result.segments as object[],
        translationInputTokens: result.usage?.inputTokens ?? null,
        translationOutputTokens: result.usage?.outputTokens ?? null,
        translationCostUsd: cost,
      },
    });
    if (count !== 1) return false;
    await tx.job.update({ where: { id: job.id }, data: { status: "DONE", lockedAt: null, lastError: null, finishedAt: new Date() } });
    return true;
  });
}

/** Queues a translate job (priority 0) for every untranslated transcript without an open one. */
export async function queueTranslationBackfill(db: Db): Promise<number> {
  return db.$executeRaw`
    INSERT INTO "jobs" ("id", "call_id", "kind", "priority", "status", "attempts", "run_after", "created_at", "updated_at")
    SELECT gen_random_uuid(), t."call_id", 'translate', 0, 'QUEUED', 0, now(), now(), now()
    FROM "transcripts" t
    WHERE t."text_en" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "jobs" j
        WHERE j."call_id" = t."call_id" AND j."kind" = 'translate' AND j."status" IN ('QUEUED', 'RUNNING')
      )`;
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
        finishedAt: giveUp ? new Date() : null,
        // Every failed attempt, retried or not, for the hourly failure-rate alert.
        failedAttemptAt: new Date(),
      },
    });
    // Translate / compress jobs never change the call: it stays TRANSCRIBED (a failed compression keeps the original).
    if (job.kind === "transcribe") {
      await tx.call.update({ where: { id: job.callId }, data: { status: giveUp ? "FAILED" : "UPLOADED" } });
    }
    return true;
  });
}

// ---- Compression (Milestone 2b) ------------------------------------------

type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

/** SQL filter for calls whose stored audio is worth re-encoding: transcribed, big bitrate, not yet compressed. */
const compressible = (alias: string) => `
  ${alias}."status" = 'TRANSCRIBED' AND ${alias}."file_path" IS NOT NULL AND ${alias}."compressed_at" IS NULL
  AND ${alias}."duration_s" > 0 AND ${alias}."file_size" * 8 / ${alias}."duration_s" > ${COMPRESS_MIN_BPS}
  AND NOT EXISTS (SELECT 1 FROM "jobs" j WHERE j."call_id" = ${alias}."id" AND j."kind" = 'compress'
                  AND j."status" IN ('QUEUED', 'RUNNING'))`;

/** Queues a compress job (priority -1, below everything else) for one call if its audio is large. */
export async function queueCompression(tx: Tx | Db, callId: string): Promise<number> {
  return tx.$executeRawUnsafe(
    `INSERT INTO "jobs" ("id", "call_id", "kind", "priority", "status", "attempts", "run_after", "created_at", "updated_at")
     SELECT gen_random_uuid(), c."id", 'compress', -1, 'QUEUED', 0, now(), now(), now()
     FROM "calls" c WHERE c."id" = $1::uuid AND ${compressible("c")}`,
    callId,
  );
}

/** Queues compress jobs for the oldest large transcribed recordings (all of them without `limit`). */
export async function queueCompressionBackfill(db: Db, limit?: number): Promise<number> {
  return db.$executeRawUnsafe(
    `INSERT INTO "jobs" ("id", "call_id", "kind", "priority", "status", "attempts", "run_after", "created_at", "updated_at")
     SELECT gen_random_uuid(), c."id", 'compress', -1, 'QUEUED', 0, now(), now(), now()
     FROM (SELECT c."id" FROM "calls" c WHERE ${compressible("c")} ORDER BY c."started_at" ASC
           ${limit ? "LIMIT $1" : ""}) c`,
    ...(limit ? [limit] : []),
  );
}

/** Disk space freed so far and what is left to do, for the dashboard. */
export async function compressionStats(db: Db) {
  const [row] = await db.$queryRawUnsafe<{ compressed: bigint; saved: bigint | null; eligible: bigint; queued: bigint }[]>(
    `SELECT
       (SELECT count(*) FROM "calls" WHERE "compressed_at" IS NOT NULL) AS "compressed",
       (SELECT sum("bytes_saved") FROM "calls" WHERE "compressed_at" IS NOT NULL) AS "saved",
       (SELECT count(*) FROM "calls" c WHERE ${compressible("c")}) AS "eligible",
       (SELECT count(*) FROM "jobs" WHERE "kind" = 'compress' AND "status" IN ('QUEUED', 'RUNNING')) AS "queued"`,
  );
  return {
    compressedCalls: Number(row?.compressed ?? 0),
    bytesSaved: Number(row?.saved ?? 0),
    eligibleCalls: Number(row?.eligible ?? 0),
    queuedJobs: Number(row?.queued ?? 0),
  };
}
