import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError, type Deps } from "../context.js";
import type { CallSource } from "../generated/prisma/client.js";
import { linkCallToActivity } from "../activity/service.js";
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
  // The rep may have logged the call's outcome in the dialer before the recording was found.
  await linkCallToActivity(deps, call);
  return { callId: call.id, alreadyUploaded: false };
}

/** Marks the call UPLOADED and queues transcription; only one concurrent upload wins the transition. */
async function markStored(
  deps: Deps,
  call: { id: string; source: CallSource },
  rel: string,
  saved: { sha256: string; size: number },
  mime: string,
): Promise<boolean> {
  return deps.db.$transaction(async (tx) => {
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
}

const intHeader = (v: string | string[] | undefined): number | undefined => {
  if (typeof v !== "string" || !/^\d{1,15}$/.test(v)) return undefined;
  return Number(v);
};

/** Partial uploads being written right now (this process; the server runs as a single instance). */
const activePartials = new Set<string>();

export type StoreResult = { callId: string; alreadyUploaded: boolean; complete: boolean; received?: number };

/**
 * Streams the request body to disk, verifying X-Content-SHA256, then marks the
 * call UPLOADED and queues its transcription job (exactly once).
 *
 * Resumable mode (the app sends Upload-Offset and Upload-Length): bytes are appended to a partial file kept
 * across dropped connections; Upload-Offset must equal what the server already has (else 409 with the right
 * offset in the Upload-Offset header). The checksum covers the whole file and is checked once it is complete.
 * Without those headers the body is the whole file, as before.
 */
export async function storeAudio(
  deps: Deps,
  req: FastifyRequest,
  userId: string,
  callId: string,
  reply?: { header: (k: string, v: string | number) => unknown },
): Promise<StoreResult> {
  const maxBytes = deps.config.MAX_UPLOAD_MB * 1024 * 1024;
  const mime = mimeFromContentType(req.headers["content-type"]);
  if (!mime) throw new HttpError(415, "Unsupported audio type");
  const expected = sha256Hex.safeParse(req.headers["x-content-sha256"]);
  if (!expected.success) throw new HttpError(400, "Missing or invalid X-Content-SHA256");
  const offset = intHeader(req.headers["upload-offset"]);
  const total = intHeader(req.headers["upload-length"]);
  if (offset !== undefined && total === undefined) throw new HttpError(400, "Upload-Offset needs Upload-Length");
  if ((total ?? Number(req.headers["content-length"] ?? 0)) > maxBytes) throw new HttpError(413, "File too large");

  const call = await deps.db.call.findFirst({ where: { id: callId, userId } });
  if (!call) throw new HttpError(404, "Call not found");
  if (call.status !== "PENDING_UPLOAD") return { callId: call.id, alreadyUploaded: true, complete: true };

  const rel = deps.storage.callPath(userId, call.id, call.startedAt, mime);

  if (offset !== undefined && total !== undefined) {
    // One writer per partial file. A dropped request can still be flushing its last bytes when the phone's
    // retry arrives; letting both append would interleave them and corrupt the file.
    const key = `${call.id}.${expected.data}`;
    if (activePartials.has(key)) {
      reply?.header("upload-offset", await deps.storage.partialSize(call.id, expected.data));
      throw new HttpError(409, "An upload of this file is still in progress; try again shortly");
    }
    activePartials.add(key);
    let size: number;
    try {
      const have = await deps.storage.partialSize(call.id, expected.data);
      if (offset !== have) {
        reply?.header("upload-offset", have);
        throw new HttpError(409, `Upload offset mismatch; server has ${have} bytes`);
      }
      size = await deps.storage.appendPartial(req.raw, call.id, expected.data, maxBytes);
    } catch (e) {
      if (e instanceof UploadTooLargeError) throw new HttpError(413, "File too large");
      throw e;
    } finally {
      activePartials.delete(key);
    }
    if (size < total) return { callId: call.id, alreadyUploaded: false, complete: false, received: size };
    if (size > total) {
      await deps.storage.removePartial(call.id, expected.data);
      throw new HttpError(422, "More bytes than Upload-Length");
    }
    const saved = await deps.storage.finishPartial(call.id, expected.data, rel);
    if (saved.sha256 !== expected.data) {
      await deps.storage.remove(rel);
      throw new HttpError(422, "Checksum mismatch");
    }
    const won = await markStored(deps, call, rel, saved, mime);
    return { callId: call.id, alreadyUploaded: !won, complete: true };
  }

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
  const won = await markStored(deps, call, rel, saved, mime);
  return { callId: call.id, alreadyUploaded: !won, complete: true };
}

/** How many bytes of this upload the server has (for resuming), or that it is already complete. */
export async function audioProgress(
  deps: Deps,
  userId: string,
  callId: string,
  sha256: string,
): Promise<{ complete: boolean; received: number }> {
  const call = await deps.db.call.findFirst({ where: { id: callId, userId }, select: { id: true, status: true } });
  if (!call) throw new HttpError(404, "Call not found");
  if (call.status !== "PENDING_UPLOAD") return { complete: true, received: 0 };
  return { complete: false, received: await deps.storage.partialSize(call.id, sha256) };
}
