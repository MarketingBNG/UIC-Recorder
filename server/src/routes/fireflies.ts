import type { FastifyInstance } from "fastify";
import path from "node:path";
import { z } from "zod";
import { requireSession, requireWorker } from "../auth/guards.js";
import { HttpError, type Deps } from "../context.js";
import { blockFireflies, finalizeReservation, firefliesUsage, markUploaded, reserveForJob } from "../fireflies/budget.js";
import { FirefliesConfig, getFirefliesState, saveFirefliesState } from "../fireflies/settings.js";
import { signAudioPath, verifyAudioSignature } from "../fireflies/signed-url.js";

const WorkerBody = z.object({ workerId: z.string().min(1).max(100) });
const SettingsPatch = FirefliesConfig.partial().extend({ clearBlock: z.boolean().optional() });

/**
 * Fireflies provider support:
 *  - /internal/fireflies/*  worker-only (WORKER_TOKEN): budget reservation, signed audio URL, hard stop
 *  - /public/audio/:callId  no auth; only a valid, unexpired HMAC signature for that call id
 *  - /api/fireflies/usage, /api/settings/fireflies  dashboard (MANAGER read, ADMIN write)
 */
export async function firefliesRoutes(app: FastifyInstance, deps: Deps) {
  const worker = { preHandler: requireWorker(deps), config: { rateLimit: false as const } };
  const managers = { preHandler: requireSession(deps, ["ADMIN", "MANAGER"]) };
  const admins = { preHandler: requireSession(deps, ["ADMIN"]) };
  const secret = deps.config.JWT_SECRET;

  // ---- Worker ------------------------------------------------------------

  app.post<{ Params: { jobId: string } }>("/internal/fireflies/jobs/:jobId/reserve", worker, async (req) => {
    const jobId = z.uuid().parse(req.params.jobId);
    const { workerId } = WorkerBody.parse(req.body);
    const r = await reserveForJob(deps.db, jobId, workerId);
    if (r.status === "lost") throw new HttpError(409, "Job is not locked by this worker");
    return r;
  });

  app.post<{ Params: { id: string } }>("/internal/fireflies/reservations/:id/uploaded", worker, async (req, reply) => {
    const id = z.uuid().parse(req.params.id);
    const { transcriptId } = z.object({ transcriptId: z.string().max(200).optional() }).parse(req.body ?? {});
    if (!(await markUploaded(deps.db, id, transcriptId))) throw new HttpError(409, "Reservation is not open");
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/internal/fireflies/reservations/:id/finalize", worker, async (req, reply) => {
    const id = z.uuid().parse(req.params.id);
    const { actualMinutes } = z.object({ actualMinutes: z.number().int().min(0).max(100_000).optional() }).parse(req.body ?? {});
    await finalizeReservation(deps.db, id, actualMinutes);
    return reply.code(204).send();
  });

  app.post("/internal/fireflies/block", worker, async (req) => {
    const body = z
      .object({ error: z.string().min(1).max(2000), jobId: z.uuid().optional(), workerId: z.string().max(100).optional() })
      .parse(req.body);
    const job = body.jobId && body.workerId ? { jobId: body.jobId, workerId: body.workerId } : undefined;
    const until = await blockFireflies(deps.db, body.error, job);
    req.log.error({ error: body.error, until }, "fireflies hard stop");
    return { blockedUntil: until };
  });

  app.get<{ Params: { callId: string } }>("/internal/fireflies/audio-url/:callId", worker, async (req) => {
    const callId = z.uuid().parse(req.params.callId);
    const call = await deps.db.call.findUnique({ where: { id: callId }, select: { filePath: true } });
    if (!call?.filePath) throw new HttpError(404, "No audio");
    const { path: p, expiresAt } = signAudioPath(secret, callId, path.extname(call.filePath).toLowerCase());
    return { url: new URL(p, deps.config.PUBLIC_URL).toString(), expiresAt };
  });

  // ---- Public (signed) ----------------------------------------------------

  app.get<{ Params: { file: string }; Querystring: { exp?: string; sig?: string } }>(
    "/public/audio/:file",
    // Info-level request logs would contain the working signed URL (exp & sig); keep them out.
    { logLevel: "warn" },
    async (req, reply) => {
      // "<uuid>" or "<uuid>.<ext>"; anything else (incl. traversal attempts) is a 404.
      const m = /^([0-9a-f-]{36})(\.[a-z0-9]{1,5})?$/.exec(req.params.file);
      const callId = m && z.uuid().safeParse(m[1]).success ? m[1]! : null;
      if (!callId || !verifyAudioSignature(secret, callId, req.query.exp, req.query.sig)) {
        throw new HttpError(404, "Not found");
      }
      const call = await deps.db.call.findUnique({ where: { id: callId }, select: { filePath: true, mimeType: true } });
      if (!call?.filePath) throw new HttpError(404, "Not found");
      const size = await deps.storage.size(call.filePath);
      reply.header("accept-ranges", "bytes");
      reply.header("content-type", call.mimeType ?? "application/octet-stream");
      reply.header("cache-control", "private, no-store");
      reply.header("x-robots-tag", "noindex");
      const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (r && (r[1] || r[2])) {
        const start = Math.max(0, r[1] ? Number(r[1]) : size - Number(r[2]));
        const end = Math.min(r[1] && r[2] ? Number(r[2]) : size - 1, size - 1);
        if (start > end) return reply.code(416).header("content-range", `bytes */${size}`).send();
        reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1);
        return reply.send(deps.storage.read(call.filePath, { start, end }));
      }
      reply.header("content-length", size);
      return reply.send(deps.storage.read(call.filePath));
    },
  );

  // ---- Dashboard ---------------------------------------------------------

  app.get("/api/fireflies/usage", managers, async () => firefliesUsage(deps.db));

  app.put("/api/settings/fireflies", admins, async (req) => {
    const { clearBlock, ...patch } = SettingsPatch.parse(req.body);
    // Same advisory lock as reserve/block, so a concurrent hard stop is never overwritten.
    await deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('uic:fireflies-budget'))`;
      const state = await getFirefliesState(tx);
      const next = { ...state, ...patch };
      if (clearBlock) {
        next.blockedUntil = null;
        // Jobs parked by the hard stop become runnable again right away.
        await tx.job.updateMany({
          where: { status: "WAITING_BUDGET", lastError: { startsWith: "WAITING_BUDGET: BLOCKED" } },
          data: { runAfter: new Date() },
        });
      }
      await saveFirefliesState(tx, next);
      await tx.auditLog.create({
        data: { userId: req.user?.id ?? null, action: "SETTINGS_CHANGE", detail: { fireflies: { ...patch, clearBlock } }, ip: req.ip },
      });
      // Raising the batch gate or budget, or re-enabling, should not leave jobs parked for an hour.
      if (patch.approvedBacklogCount !== undefined || patch.budgetMinutes !== undefined || patch.enabled || patch.liveReservePct !== undefined) {
        await tx.job.updateMany({ where: { status: "WAITING_BUDGET", runAfter: { gt: new Date() } }, data: { runAfter: new Date() } });
      }
    });
    return firefliesUsage(deps.db);
  });
}
