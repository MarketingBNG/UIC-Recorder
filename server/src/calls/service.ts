import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError, type Deps } from "../context.js";
import type { CallSource } from "../generated/prisma/client.js";
import { toE164 } from "../phone.js";
import { UploadTooLargeError, mimeFromContentType } from "../storage/local.js";

export const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

export const CheckBody = z.object({ hashes: z.array(sha256Hex).min(1).max(500) });

export const CallMeta = z.object({
  originalSha256: sha256Hex,
  phoneNumber: z.string().max(40).optional(),
  contactName: z.string().max(200).optional(),
  direction: z.enum(["INCOMING", "OUTGOING", "MISSED", "UNKNOWN"]).default("UNKNOWN"),
  startedAt: z.iso.datetime({ offset: true }),
  durationS: z.number().int().min(0).max(24 * 3600).optional(),
  originalName: z.string().max(255).optional(),
});
export type CallMeta = z.infer<typeof CallMeta>;

/** Live calls are transcribed before backlog/imported ones. */
export const PRIORITY: Record<CallSource, number> = { LIVE: 10, BACKLOG: 0, IMPORT: 0 };

/** Which of these original-file hashes are already fully uploaded for this user? */
export async function knownHashes(deps: Deps, userId: string, hashes: string[]): Promise<string[]> {
  const rows = await deps.db.call.findMany({
    where: { userId, originalSha256: { in: hashes }, status: { not: "PENDING_UPLOAD" } },
    select: { originalSha256: true },
  });
  return rows.map((r) => r.originalSha256);
}

/** Registers call metadata; idempotent on (user, original file hash). */
export async function registerCall(
  deps: Deps,
  userId: string,
  deviceId: string | null,
  source: CallSource,
  body: CallMeta,
): Promise<{ callId: string; alreadyUploaded: boolean }> {
  const data = {
    deviceId,
    source,
    phoneRaw: body.phoneNumber ?? null,
    phoneE164: toE164(body.phoneNumber, deps.config.DEFAULT_PHONE_REGION) ?? null,
    contactName: body.contactName ?? null,
    direction: body.direction,
    startedAt: new Date(body.startedAt),
    durationS: body.durationS ?? null,
    originalName: body.originalName ?? null,
  };
  const existing = await deps.db.call.findUnique({
    where: { userId_originalSha256: { userId, originalSha256: body.originalSha256 } },
  });
  if (existing && existing.status !== "PENDING_UPLOAD") return { callId: existing.id, alreadyUploaded: true };
  const call = existing
    ? await deps.db.call.update({ where: { id: existing.id }, data })
    : await deps.db.call.create({ data: { ...data, userId, originalSha256: body.originalSha256 } });
  return { callId: call.id, alreadyUploaded: false };
}

/**
 * Streams the request body to disk, verifying X-Content-SHA256, then marks the
 * call UPLOADED and queues its transcription job (exactly once).
 */
export async function storeAudio(
  deps: Deps,
  req: FastifyRequest,
  userId: string,
  callId: string,
): Promise<{ callId: string; alreadyUploaded: boolean }> {
  const maxBytes = deps.config.MAX_UPLOAD_MB * 1024 * 1024;
  const mime = mimeFromContentType(req.headers["content-type"]);
  if (!mime) throw new HttpError(415, "Unsupported audio type");
  const expected = sha256Hex.safeParse(req.headers["x-content-sha256"]);
  if (!expected.success) throw new HttpError(400, "Missing or invalid X-Content-SHA256");
  if (Number(req.headers["content-length"] ?? 0) > maxBytes) throw new HttpError(413, "File too large");

  const call = await deps.db.call.findFirst({ where: { id: callId, userId } });
  if (!call) throw new HttpError(404, "Call not found");
  if (call.status !== "PENDING_UPLOAD") return { callId: call.id, alreadyUploaded: true };

  const rel = deps.storage.callPath(userId, call.id, call.startedAt, mime);
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
  return { callId: call.id, alreadyUploaded: !won };
}
