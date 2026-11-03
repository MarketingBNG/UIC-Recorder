import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireDevice } from "../auth/guards.js";
import { HttpError, currentDevice, currentUser, type Deps } from "../context.js";
import { toE164 } from "../phone.js";
import { ALLOWED_AUDIO_MIME, UploadTooLargeError, mimeFromContentType } from "../storage/local.js";

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

const CheckBody = z.object({ hashes: z.array(sha256Hex).min(1).max(500) });

const CreateCall = z.object({
  originalSha256: sha256Hex,
  phoneNumber: z.string().max(40).optional(),
  contactName: z.string().max(200).optional(),
  direction: z.enum(["INCOMING", "OUTGOING", "MISSED", "UNKNOWN"]).default("UNKNOWN"),
  source: z.enum(["LIVE", "BACKLOG"]).default("LIVE"),
  startedAt: z.iso.datetime({ offset: true }),
  durationS: z.number().int().min(0).max(24 * 3600).optional(),
  originalName: z.string().max(255).optional(),
});

const PRIORITY = { LIVE: 10, BACKLOG: 0, IMPORT: 0 } as const;

export async function callRoutes(app: FastifyInstance, deps: Deps) {
  const auth = { preHandler: requireDevice(deps) };
  const maxBytes = deps.config.MAX_UPLOAD_MB * 1024 * 1024;

  // Audio bodies are streamed straight to disk, never buffered.
  app.addContentTypeParser(ALLOWED_AUDIO_MIME, (_req, _payload, done) => done(null));

  /** Which of these original-file hashes are already fully uploaded for this user? */
  app.post("/v1/calls/check", auth, async (req) => {
    const { hashes } = CheckBody.parse(req.body);
    const rows = await deps.db.call.findMany({
      where: { userId: currentUser(req).id, originalSha256: { in: hashes }, status: { not: "PENDING_UPLOAD" } },
      select: { originalSha256: true },
    });
    return { known: rows.map((r) => r.originalSha256) };
  });

  /** Step 1: register metadata (idempotent on the original file hash). */
  app.post("/v1/calls", auth, async (req, reply) => {
    const body = CreateCall.parse(req.body);
    const user = currentUser(req);
    const data = {
      deviceId: currentDevice(req).id,
      phoneRaw: body.phoneNumber ?? null,
      phoneE164: toE164(body.phoneNumber, deps.config.DEFAULT_PHONE_REGION) ?? null,
      contactName: body.contactName ?? null,
      direction: body.direction,
      source: body.source,
      startedAt: new Date(body.startedAt),
      durationS: body.durationS ?? null,
      originalName: body.originalName ?? null,
    };
    const existing = await deps.db.call.findUnique({
      where: { userId_originalSha256: { userId: user.id, originalSha256: body.originalSha256 } },
    });
    if (existing && existing.status !== "PENDING_UPLOAD") {
      return reply.code(200).send({ callId: existing.id, alreadyUploaded: true });
    }
    const call = existing
      ? await deps.db.call.update({ where: { id: existing.id }, data })
      : await deps.db.call.create({ data: { ...data, userId: user.id, originalSha256: body.originalSha256 } });
    return reply.code(201).send({ callId: call.id, alreadyUploaded: false, uploadPath: `/v1/calls/${call.id}/audio` });
  });

  /**
   * Step 2: upload audio (possibly re-encoded on the phone). The X-Content-SHA256
   * header is the hash of the bytes sent and is verified while streaming.
   */
  app.put<{ Params: { id: string } }>("/v1/calls/:id/audio", auth, async (req, reply) => {
    const id = z.uuid().parse(req.params.id);
    const user = currentUser(req);
    const mime = mimeFromContentType(req.headers["content-type"]);
    if (!mime) throw new HttpError(415, "Unsupported audio type");
    const expected = sha256Hex.safeParse(req.headers["x-content-sha256"]);
    if (!expected.success) throw new HttpError(400, "Missing or invalid X-Content-SHA256");
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > maxBytes) throw new HttpError(413, "File too large");

    const call = await deps.db.call.findFirst({ where: { id, userId: user.id } });
    if (!call) throw new HttpError(404, "Call not found");
    if (call.status !== "PENDING_UPLOAD") return reply.code(200).send({ callId: call.id, alreadyUploaded: true });

    const rel = deps.storage.callPath(user.id, call.id, call.startedAt, mime);
    let saved;
    try {
      saved = await deps.storage.save(req.raw, rel, maxBytes);
    } catch (e) {
      if (e instanceof UploadTooLargeError) throw new HttpError(413, "File too large");
      throw e;
    }
    if (saved.sha256 !== expected.data) {
      await deps.storage.remove(rel);
      throw new HttpError(422, "Checksum mismatch");
    }

    // Only one concurrent upload can win the PENDING_UPLOAD -> UPLOADED transition.
    const won = await deps.db.$transaction(async (tx) => {
      const { count } = await tx.call.updateMany({
        where: { id: call.id, status: "PENDING_UPLOAD" },
        data: {
          status: "UPLOADED",
          filePath: rel,
          fileSize: BigInt(saved.size),
          uploadSha256: saved.sha256,
          mimeType: mime,
          uploadedAt: new Date(),
        },
      });
      if (count === 1) await tx.job.create({ data: { callId: call.id, priority: PRIORITY[call.source] } });
      return count === 1;
    });
    return reply.code(won ? 201 : 200).send({ callId: call.id, alreadyUploaded: !won });
  });
}
