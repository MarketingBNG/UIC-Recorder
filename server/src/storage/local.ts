import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
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

  // ---- Resumable uploads -------------------------------------------------
  // A partial upload lives in .tmp/partial/<callId>.<sha256 the phone promised>. Keying on the hash means a
  // different file for the same call (e.g. re-compressed differently) starts fresh instead of mixing bytes.

  private partialAbs(callId: string, sha256: string): string {
    if (!/^[0-9a-f-]{36}$/.test(callId) || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Bad partial key");
    return path.join(this.root, ".tmp", "partial", `${callId}.${sha256}`);
  }

  /** Bytes already received for this upload (0 when none). */
  async partialSize(callId: string, sha256: string): Promise<number> {
    try {
      return (await stat(this.partialAbs(callId, sha256))).size;
    } catch {
      return 0;
    }
  }

  /**
   * Appends `body` to the partial file. Bytes written before a dropped connection are kept, so the phone can
   * continue from partialSize(). Throws UploadTooLargeError past `maxBytes` in total (the partial is removed).
   */
  async appendPartial(body: Readable, callId: string, sha256: string, maxBytes: number): Promise<number> {
    const file = this.partialAbs(callId, sha256);
    await mkdir(path.dirname(file), { recursive: true });
    let size = await this.partialSize(callId, sha256);
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new UploadTooLargeError(`Upload exceeds ${maxBytes} bytes`));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(file, { flags: "a" }));
    } catch (err) {
      if (err instanceof UploadTooLargeError) await rm(file, { force: true });
      throw err; // a dropped connection keeps what arrived
    }
    return size;
  }

  /** Hashes the complete partial file and moves it to `rel`. The caller compares the hash. */
  async finishPartial(callId: string, sha256: string, rel: string): Promise<{ sha256: string; size: number }> {
    const file = this.partialAbs(callId, sha256);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(file)) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
    const dest = this.abs(rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(file, dest);
    return { sha256: hash.digest("hex"), size };
  }

  async removePartial(callId: string, sha256: string): Promise<void> {
    await rm(this.partialAbs(callId, sha256), { force: true });
  }

  /** Drops partial uploads nobody has continued for `maxAgeMs` (phones normally resume within hours). */
  async sweepPartials(maxAgeMs: number): Promise<number> {
    const dir = path.join(this.root, ".tmp", "partial");
    let removed = 0;
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      const s = await stat(file).catch(() => null);
      if (s && Date.now() - s.mtimeMs > maxAgeMs) {
        await rm(file, { force: true });
        removed++;
      }
    }
    return removed;
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
