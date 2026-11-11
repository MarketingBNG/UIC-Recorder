import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireDevice } from "../auth/guards.js";
import { CallMeta, CheckBody, audioProgress, knownHashes, registerCall, sha256Hex, storeAudio } from "../calls/service.js";
import { HttpError, currentDevice, currentUser, type Deps } from "../context.js";
import { WindowLimiter } from "../privacy/uploadLimit.js";
import { ALLOWED_AUDIO_MIME } from "../storage/local.js";

const CreateCall = CallMeta.extend({ source: z.enum(["LIVE", "BACKLOG"]).default("LIVE") });

/** Phone uploads: register metadata, then stream the audio. */
export async function callRoutes(app: FastifyInstance, deps: Deps) {
  const auth = { preHandler: requireDevice(deps) };

  // Audio bodies are streamed straight to disk, never buffered.
  app.addContentTypeParser(ALLOWED_AUDIO_MIME, (_req, _payload, done) => done(null));

  app.post("/v1/calls/check", auth, async (req) => {
    const { hashes } = CheckBody.parse(req.body);
    return { known: await knownHashes(deps, currentUser(req).id, hashes) };
  });

  app.post("/v1/calls", auth, async (req, reply) => {
    const { source, ...meta } = CreateCall.parse(req.body);
    const r = await registerCall(deps, currentUser(req).id, currentDevice(req).id, source, meta);
    if (r.alreadyUploaded) return reply.code(200).send(r);
    return reply.code(201).send({ ...r, uploadPath: `/v1/calls/${r.callId}/audio` });
  });

  // Per-phone upload cap; the app treats 429 like a network error and retries later.
  const uploads = new WindowLimiter(deps.config.UPLOAD_RATE_PER_HOUR, 3600_000);

  app.put<{ Params: { id: string } }>("/v1/calls/:id/audio", auth, async (req, reply) => {
    const wait = uploads.take(currentDevice(req).id);
    if (wait > 0) {
      reply.header("retry-after", wait);
      throw new HttpError(429, "Too many uploads from this phone; try again later");
    }
    const r = await storeAudio(deps, req, currentUser(req).id, z.uuid().parse(req.params.id), reply);
    // 202: part of a resumable upload arrived; the phone continues from `received`.
    if (!r.complete) return reply.code(202).header("upload-offset", r.received ?? 0).send(r);
    return reply.code(r.alreadyUploaded ? 200 : 201).send(r);
  });

  /** Resume point for an interrupted upload: how many bytes of the file with this hash the server already has. */
  app.get<{ Params: { id: string }; Querystring: { sha256?: string } }>("/v1/calls/:id/audio/progress", auth, async (req) => {
    const sha = sha256Hex.parse(req.query.sha256);
    return audioProgress(deps, currentUser(req).id, z.uuid().parse(req.params.id), sha);
  });
}
