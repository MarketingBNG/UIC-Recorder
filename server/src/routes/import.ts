import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { safeEqual } from "../auth/tokens.js";
import { CallMeta, CheckBody, knownHashes, registerCall, storeAudio } from "../calls/service.js";
import { HttpError, type Deps } from "../context.js";
import { ALLOWED_AUDIO_MIME } from "../storage/local.js";

const Email = z.email().transform((e) => e.toLowerCase());

/**
 * Bulk import of recordings already copied off phones (scripts/import-existing.ts).
 * Disabled unless IMPORT_TOKEN is set; same dedup/upload/queue path as the app.
 */
export async function importRoutes(app: FastifyInstance, deps: Deps) {
  const token = deps.config.IMPORT_TOKEN;
  if (!token) return;

  const guard = async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ") || !safeEqual(h.slice(7), token)) throw new HttpError(401, "Bad import token");
  };
  const opts = { preHandler: guard, config: { rateLimit: false as const } };

  app.addContentTypeParser(ALLOWED_AUDIO_MIME, (_req, _payload, done) => done(null));

  /** Imports go to an existing active user, or a new agent from the Workspace domain. */
  const userFor = async (email: string) => {
    const user = await deps.db.user.findUnique({ where: { email } });
    if (user) {
      if (!user.active) throw new HttpError(403, `${email} is deactivated`);
      return user;
    }
    if (deps.config.ALLOWED_DOMAIN && email.endsWith(`@${deps.config.ALLOWED_DOMAIN}`)) {
      return deps.db.user.create({ data: { email, role: "AGENT" } });
    }
    throw new HttpError(404, `No user ${email}; add them in the dashboard first`);
  };

  app.post("/internal/import/check", opts, async (req) => {
    const body = CheckBody.extend({ email: Email }).parse(req.body);
    const user = await userFor(body.email);
    return { known: await knownHashes(deps, user.id, body.hashes) };
  });

  app.post("/internal/import/calls", opts, async (req, reply) => {
    const { email, ...meta } = CallMeta.extend({ email: Email }).parse(req.body);
    const user = await userFor(email);
    const r = await registerCall(deps, user.id, null, "IMPORT", meta);
    return reply.code(r.alreadyUploaded ? 200 : 201).send(r);
  });

  app.put<{ Params: { id: string } }>("/internal/import/calls/:id/audio", opts, async (req, reply) => {
    const id = z.uuid().parse(req.params.id);
    const call = await deps.db.call.findUnique({ where: { id }, select: { userId: true, source: true } });
    if (!call || call.source !== "IMPORT") throw new HttpError(404, "Call not found");
    const r = await storeAudio(deps, req, call.userId, id);
    return reply.code(r.alreadyUploaded ? 200 : 201).send(r);
  });
}
