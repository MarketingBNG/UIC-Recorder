import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { touchWorker } from "../alerts/checks.js";
import { getCostSettings, translateCapped } from "../translation/cost.js";
import { getPrivacySettings } from "../privacy/settings.js";
import { requireWorker } from "../auth/guards.js";
import { HttpError, type Deps } from "../context.js";
import { CompressQuery, storeCompressedAudio } from "../calls/compress.js";
import { ALLOWED_AUDIO_MIME } from "../storage/local.js";
import { JOB_KINDS, claimJobs, claimOverflowJobs, completeJob, completeTranslation, failJob, heartbeatJob, recordTranslationCost } from "../jobs/queue.js";

const Claim = z.object({
  workerId: z.string().min(1).max(100),
  limit: z.number().int().min(1).max(20).default(1),
  // Old workers send no kinds and only get transcription jobs.
  kinds: z.array(z.enum(JOB_KINDS)).min(1).max(JOB_KINDS.length).default(["transcribe"]),
  // The worker's transcription provider. "sarvam" workers only get Fireflies-budget overflow jobs.
  provider: z.string().max(50).optional(),
});

const Usage = z.object({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0), batch: z.boolean() });

const Translation = z.object({
  workerId: z.string().min(1).max(100),
  model: z.string().min(1).max(100),
  textEn: z.string().max(4_000_000),
  segments: z.array(z.record(z.string(), z.unknown())).max(100_000),
  usage: Usage.optional(),
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
    // A failed translate attempt that Claude already charged for (counts toward the monthly cap).
    model: z.string().min(1).max(100).optional(),
    usage: Usage.optional(),
  }),
]);

/** Endpoints used only by transcription workers (WORKER_TOKEN). */
export async function internalRoutes(app: FastifyInstance, deps: Deps) {
  const auth = { preHandler: requireWorker(deps), config: { rateLimit: false as const } };

  app.post("/internal/jobs/claim", auth, async (req) => {
    const { workerId, limit, provider, kinds: asked } = Claim.parse(req.body);
    let kinds = asked;
    await touchWorker(deps.db, workerId);
    // Claude monthly cap: translate jobs stay QUEUED until next month or a higher cap.
    if (kinds.includes("translate") && (await translateCapped(deps.db))) kinds = kinds.filter((k) => k !== "translate");
    let jobs: Awaited<ReturnType<typeof claimJobs>> = [];
    if (provider === "sarvam") {
      // Never hand ordinary jobs to the paid overflow provider; translate jobs are still fine.
      if (kinds.includes("transcribe") && (await getCostSettings(deps.db)).sarvamOverflow) {
        jobs = await claimOverflowJobs(deps.db, workerId, limit);
      }
      const other = kinds.filter((k) => k !== "transcribe");
      if (other.length > 0 && jobs.length < limit) jobs = jobs.concat(await claimJobs(deps.db, workerId, limit - jobs.length, other));
    } else if (kinds.length > 0) {
      jobs = await claimJobs(deps.db, workerId, limit, kinds);
    }
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
    // Admin setting: the worker masks Aadhaar / card numbers before posting a transcript or translation.
    const { maskPii } = await getPrivacySettings(deps.db);
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
        maskPii,
      })),
    };
  });

  app.addContentTypeParser(ALLOWED_AUDIO_MIME, (_req, _payload, done) => done(null));

  /** Compress job result: the re-encoded audio replaces the original (which is kept on any failure). */
  app.put<{ Params: { callId: string } }>("/internal/calls/:callId/audio-compressed", auth, async (req) => {
    const callId = z.uuid().parse(req.params.callId);
    return storeCompressedAudio(deps, req, callId, CompressQuery.parse(req.query));
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
    if (!body.ok && body.usage && body.model) await recordTranslationCost(deps.db, jobId, body.model, body.usage);
    const ok = body.ok
      ? await completeJob(deps.db, jobId, body.workerId, body, {
          translate: deps.config.TRANSLATE_ENABLED,
          compress: deps.config.COMPRESS_AFTER_TRANSCRIBE,
        })
      : await failJob(deps.db, jobId, body.workerId, body.error, body.retryable);
    if (!ok) throw new HttpError(409, "Job is not locked by this worker");
    return reply.code(204).send();
  });

  app.post<{ Params: { jobId: string } }>("/internal/jobs/:jobId/translation", resultOpts, async (req, reply) => {
    const jobId = z.uuid().parse(req.params.jobId);
    const body = Translation.parse(req.body);
    if (!(await completeTranslation(deps.db, jobId, body.workerId, body))) {
      throw new HttpError(409, "Job is not a translate job locked by this worker");
    }
    return reply.code(204).send();
  });
}
