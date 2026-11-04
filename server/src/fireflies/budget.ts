import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { getFirefliesState, isBlocked, saveFirefliesState, type FirefliesState } from "./settings.js";

type Tx = Prisma.TransactionClient;

/** Retry delay for gates an admin has to open (disabled, batch gate). */
export const GATE_RETRY_MS = 3600_000;
/** RESERVED rows untouched this long belong to a dead job; they're settled automatically. */
const STALE_RESERVATION_HOURS = 6;
/** Bytes/second assumed when a call has no duration. Low on purpose: overestimates minutes. */
const ESTIMATE_BYTES_PER_S = 2000;
export const ALERT_THRESHOLDS = [50, 80, 100] as const;

export const monthKey = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
export const nextMonthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));

/** Whole minutes Fireflies will count for a call (rounded up, at least 1). */
export function estimateMinutes(durationS: number | null, fileSize: bigint | number | null): number {
  const seconds = durationS && durationS > 0 ? durationS : Number(fileSize ?? 0) / ESTIMATE_BYTES_PER_S;
  return Math.max(1, Math.ceil(seconds / 60));
}

async function monthTotals(tx: Tx | Db, month: string) {
  const rows = await tx.$queryRaw<{ used: bigint | null; reserved: bigint | null }[]>`
    SELECT
      sum(CASE WHEN "status" = 'COMMITTED' THEN coalesce("actual_minutes", "minutes") END) AS "used",
      sum(CASE WHEN "status" = 'RESERVED' THEN "minutes" END) AS "reserved"
    FROM "fireflies_reservations" WHERE "month" = ${month}`;
  return { used: Number(rows[0]?.used ?? 0), reserved: Number(rows[0]?.reserved ?? 0) };
}

/** Backlog/import calls ever sent (or being sent) to Fireflies; compared with approvedBacklogCount. */
const backlogSent = (tx: Tx | Db) => tx.firefliesReservation.count({ where: { live: false, status: { not: "RELEASED" } } });

async function settleStale(tx: Tx) {
  const cutoff = new Date(Date.now() - STALE_RESERVATION_HOURS * 3600_000);
  // Uploaded but never finalized: Fireflies counted it, so keep it as used.
  await tx.firefliesReservation.updateMany({
    where: { status: "RESERVED", updatedAt: { lt: cutoff }, uploadedAt: { not: null } },
    data: { status: "COMMITTED" },
  });
  await tx.firefliesReservation.updateMany({
    where: { status: "RESERVED", updatedAt: { lt: cutoff }, uploadedAt: null },
    data: { status: "RELEASED" },
  });
}

/** Puts a job back in the queue without spending an attempt. */
async function deferJob(tx: Tx, jobId: string, callId: string, reason: string, until: Date) {
  await tx.$executeRaw`
    UPDATE "jobs" SET "status" = 'WAITING_BUDGET', "attempts" = greatest("attempts" - 1, 0),
      "locked_at" = NULL, "locked_by" = NULL, "run_after" = ${until},
      "last_error" = ${`WAITING_BUDGET: ${reason}`}, "updated_at" = now()
    WHERE "id" = ${jobId}::uuid`;
  await tx.call.update({ where: { id: callId }, data: { status: "UPLOADED" } });
}

export type RefusalReason = "DISABLED" | "BLOCKED" | "BATCH_GATE" | "BUDGET";

export type ReserveResult =
  | { status: "lost" }
  | {
      status: "reserved";
      reservationId: string;
      minutes: number;
      uploaded: boolean;
      transcriptId: string | null;
      deleteAfterFetch: boolean;
    }
  | { status: "refused"; reason: RefusalReason; retryAt: Date; message: string };

/**
 * Reserves Fireflies minutes for the call behind a job this worker holds.
 * Serialized with an advisory lock so concurrent workers can't overspend.
 * On refusal the job is deferred (WAITING_BUDGET) and keeps its attempts.
 */
export async function reserveForJob(db: Db, jobId: string, workerId: string, now = new Date()): Promise<ReserveResult> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('uic:fireflies-budget'))`;
    const job = await tx.job.findFirst({
      where: { id: jobId, status: "RUNNING", lockedBy: workerId },
      include: { call: { select: { id: true, source: true, durationS: true, fileSize: true } } },
    });
    if (!job) return { status: "lost" } as const;
    await settleStale(tx);
    const state = await getFirefliesState(tx);

    // A retry of a job that already reserved (maybe already uploaded) reuses that reservation.
    const existing = await tx.firefliesReservation.findFirst({ where: { callId: job.callId, status: "RESERVED" } });
    if (existing) {
      await tx.firefliesReservation.update({ where: { id: existing.id }, data: { updatedAt: now } });
      return reserved(existing, state);
    }

    const refuse = async (reason: RefusalReason, retryAt: Date, message: string) => {
      await deferJob(tx, job.id, job.callId, `${reason} ${message}`, retryAt);
      return { status: "refused", reason, retryAt, message } as const;
    };

    if (!state.enabled) return refuse("DISABLED", new Date(now.getTime() + GATE_RETRY_MS), "Fireflies sending is disabled");
    if (isBlocked(state, now)) {
      return refuse("BLOCKED", new Date(state.blockedUntil!), `Fireflies hard stop: ${state.lastError ?? "limit reached"}`);
    }

    const live = job.call.source === "LIVE";
    if (!live) {
      const sent = await backlogSent(tx);
      if (sent >= state.approvedBacklogCount) {
        return refuse("BATCH_GATE", new Date(now.getTime() + GATE_RETRY_MS),
          `${sent}/${state.approvedBacklogCount} approved backlog calls sent; raise approvedBacklogCount`);
      }
    }

    const minutes = estimateMinutes(job.call.durationS, job.call.fileSize);
    const month = monthKey(now);
    const { used, reserved: held } = await monthTotals(tx, month);
    const limit = live ? state.budgetMinutes : Math.floor((state.budgetMinutes * (100 - state.liveReservePct)) / 100);
    if (used + held + minutes > limit) {
      return refuse("BUDGET", nextMonthStart(now),
        `${used + held}+${minutes} min would exceed the ${live ? "monthly" : "backlog"} limit of ${limit} min (${month})`);
    }
    const row = await tx.firefliesReservation.create({ data: { callId: job.callId, month, minutes, live } });
    return reserved(row, state);
  });
}

function reserved(
  r: { id: string; minutes: number; uploadedAt: Date | null; transcriptId: string | null },
  state: FirefliesState,
): ReserveResult {
  return {
    status: "reserved",
    reservationId: r.id,
    minutes: r.minutes,
    uploaded: !!r.uploadedAt,
    transcriptId: r.transcriptId,
    deleteAfterFetch: state.deleteAfterFetch,
  };
}

/** The worker handed the file to Fireflies: from now on the minutes count even if the job fails. */
export async function markUploaded(db: Db, reservationId: string, transcriptId?: string) {
  const { count } = await db.firefliesReservation.updateMany({
    where: { id: reservationId, status: "RESERVED" },
    data: { uploadedAt: new Date(), ...(transcriptId ? { transcriptId } : {}) },
  });
  return count === 1;
}

/** Settles a reservation: uploaded ones become used (actual minutes when known), others are released. */
export async function finalizeReservation(db: Db, reservationId: string, actualMinutes?: number) {
  const r = await db.firefliesReservation.findUnique({ where: { id: reservationId } });
  if (!r || r.status !== "RESERVED") return false;
  await db.firefliesReservation.update({
    where: { id: r.id },
    data: r.uploadedAt
      ? { status: "COMMITTED", actualMinutes: actualMinutes ?? null }
      : { status: "RELEASED" },
  });
  return true;
}

/**
 * Hard stop after a Fireflies quota/plan/payment error: no more sends until the
 * month rolls over or an admin clears it. The job is deferred, not failed.
 */
export async function blockFireflies(db: Db, error: string, job?: { jobId: string; workerId: string }, now = new Date()) {
  const until = nextMonthStart(now);
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('uic:fireflies-budget'))`;
    const state = await getFirefliesState(tx);
    await saveFirefliesState(tx, {
      ...state,
      blockedUntil: until.toISOString(),
      lastError: error.slice(0, 1000),
      lastErrorAt: now.toISOString(),
    });
    if (job) {
      const held = await tx.job.findFirst({ where: { id: job.jobId, status: "RUNNING", lockedBy: job.workerId } });
      if (held) await deferJob(tx, held.id, held.callId, `BLOCKED ${error.slice(0, 500)}`, until);
    }
  });
  return until;
}

export async function firefliesUsage(db: Db, now = new Date()) {
  const state = await getFirefliesState(db);
  const month = monthKey(now);
  const [{ used, reserved }, sent, waiting] = await Promise.all([
    monthTotals(db, month),
    backlogSent(db),
    db.job.count({ where: { status: "WAITING_BUDGET" } }),
  ]);
  const pct = state.budgetMinutes > 0 ? Math.round(((used + reserved) / state.budgetMinutes) * 1000) / 10 : 100;
  return {
    month,
    enabled: state.enabled,
    budgetMinutes: state.budgetMinutes,
    liveReservePct: state.liveReservePct,
    usedMinutes: used,
    reservedMinutes: reserved,
    pct,
    thresholds: ALERT_THRESHOLDS.filter((t) => pct >= t),
    approvedBacklogCount: state.approvedBacklogCount,
    backlogSent: sent,
    deleteAfterFetch: state.deleteAfterFetch,
    blocked: isBlocked(state, now),
    blockedUntil: isBlocked(state, now) ? state.blockedUntil : null,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    waitingBudgetJobs: waiting,
  };
}
