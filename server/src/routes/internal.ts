import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireWorker } from "../auth/guards.js";
import { HttpError, type Deps } from "../context.js";
import { claimJobs, completeJob, failJob } from "../jobs/queue.js";

const Claim = z.object({ workerId: z.string().min(1).max(100), limit: z.number().int().min(1).max(20).default(1) });

const Result = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    workerId: z.string().max(100),
    text: z.string().max(2_000_000),
    language: z.string().max(20).optional(),
    provider: z.string().max(50),
    segments: z.array(z.record(z.string(), z.unknown())).max(100_000).optional(),
  }),
  z.object({
    ok: z.literal(false),
    workerId: z.string().max(100),
    error: z.string().max(5000),
    retryable: z.boolean().default(true),
  }),
]);

/** Endpoints used only by transcription workers (WORKER_TOKEN). */
export async function internalRoutes(app: FastifyInstance, deps: Deps) {
  const auth = { preHandler: requireWorker(deps), config: { rateLimit: false as const } };

  app.post("/internal/jobs/claim", auth, async (req) => {
    const { workerId, limit } = Claim.parse(req.body);
    const jobs = await claimJobs(deps.db, workerId, limit);
    if (jobs.length === 0) return { jobs: [] };
    const calls = await deps.db.call.findMany({
      where: { id: { in: jobs.map((j) => j.callId) } },
      select: { id: true, mimeType: true, durationS: true, user: { select: { id: true } } },
    });
    await deps.db.call.updateMany({ where: { id: { in: calls.map((c) => c.id) } }, data: { status: "TRANSCRIBING" } });
    const byId = new Map(calls.map((c) => [c.id, c]));
    return {
      jobs: jobs.map((j) => ({
        jobId: j.id,
        callId: j.callId,
        attempt: j.attempts,
        mimeType: byId.get(j.callId)?.mimeType ?? null,
        durationS: byId.get(j.callId)?.durationS ?? null,
        audioPath: `/internal/audio/${j.callId}`,
      })),
    };
  });

  app.get<{ Params: { callId: string } }>("/internal/audio/:callId", auth, async (req, reply) => {
    const callId = z.uuid().parse(req.params.callId);
    const call = await deps.db.call.findUnique({ where: { id: callId }, select: { filePath: true, mimeType: true } });
    if (!call?.filePath) throw new HttpError(404, "No audio");
    reply.header("content-type", call.mimeType ?? "application/octet-stream");
    reply.header("content-length", await deps.storage.size(call.filePath));
    return reply.send(deps.storage.read(call.filePath));
  });

  app.post<{ Params: { jobId: string } }>("/internal/jobs/:jobId/result", auth, async (req, reply) => {
    const jobId = z.uuid().parse(req.params.jobId);
    const body = Result.parse(req.body);
    const ok = body.ok
      ? await completeJob(deps.db, jobId, body.workerId, body)
      : await failJob(deps.db, jobId, body.workerId, body.error, body.retryable);
    if (!ok) throw new HttpError(409, "Job is not locked by this worker");
    return reply.code(204).send();
  });
}
