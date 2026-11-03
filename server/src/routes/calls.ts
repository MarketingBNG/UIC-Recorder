import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireDevice } from "../auth/guards.js";
import { CallMeta, CheckBody, knownHashes, registerCall, storeAudio } from "../calls/service.js";
import { currentDevice, currentUser, type Deps } from "../context.js";
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

  app.put<{ Params: { id: string } }>("/v1/calls/:id/audio", auth, async (req, reply) => {
    const r = await storeAudio(deps, req, currentUser(req).id, z.uuid().parse(req.params.id));
    return reply.code(r.alreadyUploaded ? 200 : 201).send(r);
  });
}
