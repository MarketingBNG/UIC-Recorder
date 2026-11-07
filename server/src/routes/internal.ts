import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { touchWorker } from "../alerts/checks.js";
import { requireWorker } from "../auth/guards.js";
import { HttpError, type Deps } from "../context.js";
import { JOB_KINDS, claimJobs, completeJob, completeTranslation, failJob, heartbeatJob } from "../jobs/queue.js";

const Claim = z.object({
  workerId: z.string().min(1).max(100),
  limit: z.number().int().min(1).max(20).default(1),
  // Old workers send no kinds and only get transcription jobs.
  kinds: z.array(z.enum(JOB_KINDS)).min(1).max(JOB_KINDS.length).default(["transcribe"]),
});

const Translation = z.object({
  workerId: z.string().min(1).max(100),
  model: z.string().min(1).max(100),
  textEn: z.string().max(4_000_000),
  segments: z.array(z.record(z.string(), z.unknown())).max(100_000),
  usage: z
    .object({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0), batch: z.boolean() })
    .optional(),
});

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
    const { workerId, limit, kinds } = Claim.parse(req.body);
    await touchWorker(deps.db, workerId);
    const jobs = await claimJobs(deps.db, workerId, limit, kinds);
    if (jobs.length === 0) return { jobs: [] };
    const calls = await deps.db.call.findMany({
      where: { id: { in: jobs.map((j) => j.callId) } },
      select: { id: true, mimeType: true, durationS: true, user: { select: { id: true } } },
    });
    // Translation runs on an already TRANSCRIBED call; only transcription changes the call status.
    const transcribing = jobs.filter((j) => j.kind === "transcribe").map((j) => j.callId);
    if (transcribing.length > 0) {
      await deps.db.call.updateMany({ where: { id: { in: transcribing } }, data: { status: "TRANSCRIBING" } });
    }
    const byId = new Map(calls.map((c) => [c.id, c]));
    return {
      jobs: jobs.map((j) => ({
        jobId: j.id,
        callId: j.callId,
        kind: j.kind,
        priority: j.priority,
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

  app.get<{ Params: { callId: string } }>("/internal/transcripts/:callId", auth, async (req) => {
    const callId = z.uuid().parse(req.params.callId);
    const t = await deps.db.transcript.findUnique({
      where: { callId },
      select: { callId: true, text: true, language: true, segments: true },
    });
    if (!t) throw new HttpError(404, "No transcript");
    return t;
  });

  app.post<{ Params: { jobId: string } }>("/internal/jobs/:jobId/heartbeat", auth, async (req, reply) => {
    const jobId = z.uuid().parse(req.params.jobId);
    const { workerId } = z.object({ workerId: z.string().max(100) }).parse(req.body);
    await touchWorker(deps.db, workerId);
    if (!(await heartbeatJob(deps.db, jobId, workerId))) throw new HttpError(409, "Job is not locked by this worker");
    return reply.code(204).send();
  });

  // Long calls produce large transcripts + segment lists.
  const resultOpts = { ...auth, bodyLimit: 20 * 1024 * 1024 };
  app.post<{ Params: { jobId: string } }>("/internal/jobs/:jobId/result", resultOpts, async (req, reply) => {
    const jobId = z.uuid().parse(req.params.jobId);
    const body = Result.parse(req.body);
    const ok = body.ok
      ? await completeJob(deps.db, jobId, body.workerId, body, { translate: deps.config.TRANSLATE_ENABLED })
      : await failJob(deps.db, jobId, body.workerId, body.error, body.retryable);
    if (!ok) throw new HttpError(409, "Job is not locked by this worker");
    return reply.code(204).send();
  });

  app.post<{ Params: { jobId: string } }>("/internal/jobs/:jobId/translation", resultOpts, async (req, reply) => {
    const jobId = z.uuid().parse(req.params.jobId);
    const body = Translation.parse(req.body);
    if (body.usage) req.log.info({ jobId, model: body.model, usage: body.usage }, "translation usage");
    if (!(await completeTranslation(deps.db, jobId, body.workerId, body))) {
      throw new HttpError(409, "Job is not a translate job locked by this worker");
    }
    return reply.code(204).send();
  });
}
