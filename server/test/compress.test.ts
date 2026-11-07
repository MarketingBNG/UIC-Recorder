import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compressionStats, queueCompressionBackfill } from "../src/jobs/queue.js";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let userId: string;
let adminEmail: string;

beforeAll(async () => {
  t = await setupTestApp();
  userId = (await t.db.user.create({ data: { email: uniqueEmail("cmp") } })).id;
  adminEmail = uniqueEmail("cmpadmin");
  await t.db.user.create({ data: { email: adminEmail, role: "ADMIN" } });
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});
// Each test sees only its own jobs and calls.
beforeEach(async () => {
  await t.db.job.updateMany({ where: { status: { in: ["QUEUED", "RUNNING", "WAITING_BUDGET"] } }, data: { status: "DONE" } });
  await t.db.call.updateMany({ where: { status: "TRANSCRIBED", compressedAt: null }, data: { status: "FAILED" } });
});

const root = () => t.storage.root;

/** A call with a stored file of `bytes` and `durationS`; 100 KB / 10 s = 80 kbps (worth compressing). */
async function storedCall(opts: { bytes?: number; durationS?: number; status?: "TRANSCRIBED" | "UPLOADED"; startedAt?: Date } = {}) {
  const id = randomUUID();
  const audio = randomBytes(opts.bytes ?? 100_000);
  const rel = `${userId}/2026/01/${id}.wav`;
  await mkdir(path.join(root(), path.dirname(rel)), { recursive: true });
  await writeFile(path.join(root(), rel), audio);
  const call = await t.db.call.create({
    data: {
      id,
      userId,
      startedAt: opts.startedAt ?? new Date(),
      durationS: opts.durationS ?? 10,
      originalSha256: sha256(audio),
      status: opts.status ?? "TRANSCRIBED",
      filePath: rel,
      fileSize: BigInt(audio.length),
      mimeType: "audio/wav",
    },
  });
  return { call, rel };
}

const claim = (workerId = "cw") =>
  t.app.inject({ method: "POST", url: "/internal/jobs/claim", headers: t.workerHeaders, payload: { workerId, kinds: ["compress"] } });

const putCompressed = (callId: string, jobId: string, body: Buffer, opts: { workerId?: string; sha?: string; type?: string } = {}) =>
  t.app.inject({
    method: "PUT",
    url: `/internal/calls/${callId}/audio-compressed?jobId=${jobId}&workerId=${opts.workerId ?? "cw"}`,
    headers: { ...t.workerHeaders, "content-type": opts.type ?? "audio/mp4", "x-content-sha256": opts.sha ?? sha256(body) },
    payload: body,
  });

describe("compress queueing", () => {
  it("backfill queues only large, transcribed, uncompressed calls, oldest first, with a limit", async () => {
    const old = await storedCall({ startedAt: new Date("2025-01-01") });
    const newer = await storedCall({ startedAt: new Date("2025-06-01") });
    await storedCall({ bytes: 20_000 }); // 16 kbps: already small
    await storedCall({ status: "UPLOADED" }); // not transcribed yet
    expect(await queueCompressionBackfill(t.db, 1)).toBe(1);
    expect(await t.db.job.count({ where: { callId: old.call.id, kind: "compress", status: "QUEUED" } })).toBe(1);
    // No duplicate for the queued one; the rest get queued.
    expect(await queueCompressionBackfill(t.db)).toBe(1);
    expect(await t.db.job.count({ where: { callId: newer.call.id, kind: "compress" } })).toBe(1);
    expect(await queueCompressionBackfill(t.db)).toBe(0);
  });

  it("the admin endpoint queues and the stats report it", async () => {
    await storedCall();
    const headers = await t.sessionFor(adminEmail);
    const res = await t.app.inject({ method: "POST", url: "/api/admin/compress-backfill", headers, payload: { limit: 5 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().queued).toBe(1);
    const stats = await t.app.inject({ method: "GET", url: "/api/stats", headers });
    expect(stats.json().compression.queuedJobs).toBe(1);
  });

  it("transcribe completion queues compression only when COMPRESS_AFTER_TRANSCRIBE is on", async () => {
    const auto = await setupTestApp({ COMPRESS_AFTER_TRANSCRIBE: "true", TRANSLATE_ENABLED: "false" });
    try {
      const { call } = await storedCall({ status: "UPLOADED" });
      // Same DB, different storage root: only the row matters here.
      await auto.db.job.create({ data: { callId: call.id } });
      const [job] = (
        await auto.app.inject({ method: "POST", url: "/internal/jobs/claim", headers: auto.workerHeaders, payload: { workerId: "a" } })
      ).json().jobs;
      const res = await auto.app.inject({
        method: "POST",
        url: `/internal/jobs/${job.jobId}/result`,
        headers: auto.workerHeaders,
        payload: { ok: true, workerId: "a", text: "hi", provider: "stub" },
      });
      expect(res.statusCode).toBe(204);
      expect(await auto.db.job.count({ where: { callId: call.id, kind: "compress", status: "QUEUED" } })).toBe(1);
    } finally {
      await auto.app.close();
      await auto.db.$disconnect();
    }
  });
});

describe("compressed upload", () => {
  async function claimed() {
    const s = await storedCall();
    await queueCompressionBackfill(t.db);
    const [job] = (await claim()).json().jobs;
    expect(job.kind).toBe("compress");
    expect(job.callId).toBe(s.call.id);
    return { ...s, jobId: job.jobId as string };
  }

  it("swaps the file, keeps originalSha256, deletes the original and records the saving", async () => {
    const { call, rel, jobId } = await claimed();
    const small = randomBytes(20_000);
    const res = await putCompressed(call.id, jobId, small);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ oldBytes: 100_000, newBytes: 20_000 });

    const after = await t.db.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(after.filePath).toBe(`${userId}/2026/01/${call.id}-c.m4a`);
    expect(after.mimeType).toBe("audio/mp4");
    expect(Number(after.fileSize)).toBe(20_000);
    expect(Number(after.bytesSaved)).toBe(80_000);
    expect(after.compressedAt).not.toBeNull();
    expect(after.originalSha256).toBe(call.originalSha256);
    expect(after.status).toBe("TRANSCRIBED");
    expect(existsSync(path.join(root(), rel))).toBe(false);
    expect(existsSync(path.join(root(), after.filePath!))).toBe(true);
    expect((await t.db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("DONE");

    // Streaming via the worker audio path serves the new file.
    const audio = await t.app.inject({ method: "GET", url: `/internal/audio/${call.id}`, headers: t.workerHeaders });
    expect(audio.headers["content-type"]).toBe("audio/mp4");
    expect(audio.rawPayload.length).toBe(20_000);

    const stats = await compressionStats(t.db);
    expect(stats.compressedCalls).toBeGreaterThanOrEqual(1);
    expect(stats.bytesSaved).toBeGreaterThanOrEqual(80_000);
    // Not queued again.
    expect(await queueCompressionBackfill(t.db)).toBe(0);
  });

  it("keeps the original when the result is not smaller", async () => {
    const { call, rel, jobId } = await claimed();
    const res = await putCompressed(call.id, jobId, randomBytes(100_000));
    expect(res.statusCode).toBe(422);
    const after = await t.db.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(after.filePath).toBe(rel);
    expect(after.compressedAt).toBeNull();
    expect(existsSync(path.join(root(), rel))).toBe(true);
    expect(existsSync(path.join(root(), `${userId}/2026/01/${call.id}-c.m4a`))).toBe(false);
  });

  it("keeps the original on a checksum mismatch, wrong type, or a worker without the lock", async () => {
    const { call, rel, jobId } = await claimed();
    const small = randomBytes(1000);
    expect((await putCompressed(call.id, jobId, small, { sha: "0".repeat(64) })).statusCode).toBe(422);
    expect((await putCompressed(call.id, jobId, small, { type: "audio/wav" })).statusCode).toBe(415);
    expect((await putCompressed(call.id, jobId, small, { workerId: "other" })).statusCode).toBe(409);
    expect((await t.db.call.findUniqueOrThrow({ where: { id: call.id } })).filePath).toBe(rel);
    expect(existsSync(path.join(root(), rel))).toBe(true);
  });

  it("never touches a call that is being re-transcribed", async () => {
    const { call, rel, jobId } = await claimed();
    await t.db.call.update({ where: { id: call.id }, data: { status: "TRANSCRIBING" } });
    expect((await putCompressed(call.id, jobId, randomBytes(1000))).statusCode).toBe(409);
    expect((await t.db.call.findUniqueOrThrow({ where: { id: call.id } })).filePath).toBe(rel);
  });

  it("a failed compress job leaves the call TRANSCRIBED", async () => {
    const { call, jobId } = await claimed();
    const res = await t.app.inject({
      method: "POST",
      url: `/internal/jobs/${jobId}/result`,
      headers: t.workerHeaders,
      payload: { ok: false, workerId: "cw", error: "ffmpeg failed", retryable: false },
    });
    expect(res.statusCode).toBe(204);
    expect((await t.db.call.findUniqueOrThrow({ where: { id: call.id } })).status).toBe("TRANSCRIBED");
    expect((await t.db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("FAILED");
  });
});
