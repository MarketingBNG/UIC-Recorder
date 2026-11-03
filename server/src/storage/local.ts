import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const EXT_BY_MIME: Record<string, string> = {
  "audio/mp4": ".m4a",
  "audio/m4a": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/mpeg": ".mp3",
  "audio/amr": ".amr",
  "audio/3gpp": ".3gp",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/webm": ".webm",
};

export const ALLOWED_AUDIO_MIME = Object.keys(EXT_BY_MIME);

export class UploadTooLargeError extends Error {}

/** Stores audio on the local disk. Paths are always built server-side. */
export class LocalStorage {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async init(): Promise<void> {
    await mkdir(path.join(this.root, ".tmp"), { recursive: true });
  }

  /** Relative path for a call: <userId>/<yyyy>/<mm>/<callId><ext> */
  callPath(userId: string, callId: string, startedAt: Date, mime: string): string {
    const yyyy = String(startedAt.getUTCFullYear());
    const mm = String(startedAt.getUTCMonth() + 1).padStart(2, "0");
    return path.posix.join(userId, yyyy, mm, `${callId}${EXT_BY_MIME[mime] ?? ".bin"}`);
  }

  private abs(rel: string): string {
    const full = path.resolve(this.root, rel);
    if (!full.startsWith(this.root + path.sep)) throw new Error("Path escapes storage root");
    return full;
  }

  /**
   * Streams `body` to a temp file while hashing it, then moves it into place.
   * Throws UploadTooLargeError past `maxBytes`; the temp file is removed on any failure.
   */
  async save(body: Readable, rel: string, maxBytes: number): Promise<{ sha256: string; size: number }> {
    const tmp = path.join(this.root, ".tmp", randomUUID());
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new UploadTooLargeError(`Upload exceeds ${maxBytes} bytes`));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(tmp, { flags: "wx" }));
      const dest = this.abs(rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await rename(tmp, dest);
      return { sha256: hash.digest("hex"), size };
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async size(rel: string): Promise<number> {
    return (await stat(this.abs(rel))).size;
  }

  read(rel: string, range?: { start: number; end: number }): Readable {
    return createReadStream(this.abs(rel), range);
  }

  async remove(rel: string): Promise<void> {
    await rm(this.abs(rel), { force: true });
  }

  async diskUsage(): Promise<{ totalBytes: number; freeBytes: number }> {
    const s = await statfs(this.root);
    return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
  }
}

export function mimeFromContentType(header: string | undefined): string | undefined {
  const mime = header?.split(";")[0]?.trim().toLowerCase();
  return mime && EXT_BY_MIME[mime] ? mime : undefined;
}
