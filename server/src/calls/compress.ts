import path from "node:path";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError, type Deps } from "../context.js";
import { UploadTooLargeError } from "../storage/local.js";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const CompressQuery = z.object({ jobId: z.uuid(), workerId: z.string().min(1).max(100) });

/**
 * Compressed audio sits next to the original as <callId>-c-<jobId>.m4a: the original is never overwritten in
 * place, and the name is unique per job so a failed job can only ever remove its own file.
 */
export function compressedPath(filePath: string, callId: string, jobId: string): string {
  return path.posix.join(path.posix.dirname(filePath), `${callId}-c-${jobId}.m4a`);
}

/**
 * Swaps a call's stored audio for the worker's re-encoded AAC (Milestone 2b).
 * The new file is written to a temp file and renamed into place; the call row then points at it in one
 * transaction (only while the job lock, TRANSCRIBED status and old path still hold), and only after that
 * commit is the original deleted. Any failure leaves the original untouched. originalSha256 is unchanged.
 */
export async function storeCompressedAudio(
  deps: Deps,
  req: FastifyRequest,
  callId: string,
  q: z.infer<typeof CompressQuery>,
) {
  if ((req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() !== "audio/mp4") {
    throw new HttpError(415, "Compressed audio must be audio/mp4");
  }
  const expected = sha256Hex.safeParse(req.headers["x-content-sha256"]);
  if (!expected.success) throw new HttpError(400, "Missing or invalid X-Content-SHA256");

  const job = await deps.db.job.findFirst({ where: { id: q.jobId, callId, kind: "compress" } });
  const call = await deps.db.call.findUnique({ where: { id: callId } });
  // A resend after a lost response: this very job already swapped the file in. Answer as before (idempotent).
  if (job?.status === "DONE" && call?.compressedAt && call.filePath && call.fileSize !== null
      && call.bytesSaved !== null && path.posix.basename(call.filePath) === `${callId}-c-${job.id}.m4a`) {
    req.raw.resume();
    const newBytes = Number(call.fileSize);
    return { oldBytes: newBytes + Number(call.bytesSaved), newBytes };
  }
  if (!job || job.status !== "RUNNING" || job.lockedBy !== q.workerId) {
    throw new HttpError(409, "Job is not a compress job for this call locked by this worker");
  }
  if (!call?.filePath || call.fileSize === null) throw new HttpError(404, "No audio");
  if (call.status !== "TRANSCRIBED") throw new HttpError(409, "Call is not transcribed; original kept");
  if (call.compressedAt) throw new HttpError(409, "Call is already compressed");
  const oldPath = call.filePath;

  const oldSize = Number(call.fileSize);
  const rel = compressedPath(oldPath, callId, job.id);
  // Rejected before reading the body when the size is announced (the stream check below is the backstop).
  if (Number(req.headers["content-length"] ?? 0) >= oldSize) {
    throw new HttpError(422, "Compressed file is not smaller; original kept");
  }
  let saved;
  try {
    // Must come out smaller than the original, or there is nothing to gain.
    saved = await deps.storage.save(req.raw, rel, oldSize - 1);
  } catch (e) {
    if (e instanceof UploadTooLargeError) throw new HttpError(422, "Compressed file is not smaller; original kept");
    throw e;
  }
  if (saved.sha256 !== expected.data) {
    await deps.storage.remove(rel);
    throw new HttpError(422, "Checksum mismatch");
  }

  try {
    await deps.db.$transaction(async (tx) => {
      const locked = await tx.job.updateMany({
        where: { id: job.id, status: "RUNNING", lockedBy: q.workerId },
        data: { status: "DONE", lockedAt: null, lastError: null, finishedAt: new Date() },
      });
      if (locked.count !== 1) throw new HttpError(409, "Lost job lock");
      const moved = await tx.call.updateMany({
        where: { id: callId, status: "TRANSCRIBED", filePath: oldPath, compressedAt: null },
        data: {
          filePath: rel,
          fileSize: BigInt(saved.size),
          mimeType: "audio/mp4",
          uploadSha256: saved.sha256,
          compressedAt: new Date(),
          bytesSaved: BigInt(oldSize - saved.size),
        },
      });
      if (moved.count !== 1) throw new HttpError(409, "Call changed during compression; original kept");
    });
  } catch (e) {
    await deps.storage.remove(rel);
    throw e;
  }
  await deps.storage
    .remove(oldPath)
    .catch((err: unknown) => req.log.error({ err, callId }, "could not delete original after compression"));
  req.log.info({ callId, oldBytes: oldSize, newBytes: saved.size }, "recording compressed");
  return { oldBytes: oldSize, newBytes: saved.size };
}
