import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let userId: string;
let adminEmail: string;

beforeAll(async () => {
  t = await setupTestApp();
  userId = (await t.db.user.create({ data: { email: uniqueEmail("tr") } })).id;
  adminEmail = uniqueEmail("tradmin");
  await t.db.user.create({ data: { email: adminEmail, role: "ADMIN" } });
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});
// Each test sees only its own jobs.
beforeEach(async () => {
  await t.db.job.updateMany({ where: { status: { in: ["QUEUED", "RUNNING", "WAITING_BUDGET"] } }, data: { status: "DONE" } });
  await t.db.job.updateMany({ where: { costAt: { not: null } }, data: { costUsd: null, costAt: null } });
  await t.db.setting.updateMany({ data: { costs: {} } });
});

async function newCall(status: "UPLOADED" | "TRANSCRIBED" = "UPLOADED") {
  return t.db.call.create({
    data: { id: randomUUID(), userId, startedAt: new Date(), originalSha256: sha256(randomBytes(8)), status },
  });
}

const claim = (payload: object) =>
  t.app.inject({ method: "POST", url: "/internal/jobs/claim", headers: t.workerHeaders, payload });

const postResult = (jobId: string, payload: object) =>
  t.app.inject({ method: "POST", url: `/internal/jobs/${jobId}/result`, headers: t.workerHeaders, payload });

const postTranslation = (jobId: string, payload: object) =>
  t.app.inject({ method: "POST", url: `/internal/jobs/${jobId}/translation`, headers: t.workerHeaders, payload });

/** A call with a stored transcript and a QUEUED translate job. */
async function translateReady(priority = 10) {
  const call = await newCall("TRANSCRIBED");
  await t.db.transcript.create({
    data: {
      callId: call.id,
      text: "namaste ji\nkal milte",
      provider: "fireflies",
      segments: [{ text: "namaste ji" }, { text: "kal milte" }],
    },
  });
  const job = await t.db.job.create({ data: { callId: call.id, kind: "translate", priority } });
  return { callId: call.id, jobId: job.id };
}

describe("transcribe completion", () => {
  it("queues a translate job with the transcribe job's priority, once", async () => {
    const call = await newCall();
    await t.db.job.create({ data: { callId: call.id, priority: 10 } });
    const [job] = (await claim({ workerId: "w1" })).json().jobs;
    expect(job.kind).toBe("transcribe");
    expect(job.priority).toBe(10);
    const ok = { ok: true, workerId: "w1", text: "hello", provider: "fireflies" };
    expect((await postResult(job.jobId, ok)).statusCode).toBe(204);

    const tj = await t.db.job.findMany({ where: { callId: call.id, kind: "translate" } });
    expect(tj).toHaveLength(1);
    expect(tj[0]!.priority).toBe(10);
    expect(tj[0]!.status).toBe("QUEUED");

    // Re-transcribe: no second open translate job, English cleared.
    await t.db.transcript.update({ where: { callId: call.id }, data: { textEn: "old", translationModel: "m" } });
    const again = await t.db.job.create({ data: { callId: call.id, status: "RUNNING", lockedBy: "w1", lockedAt: new Date() } });
    expect((await postResult(again.id, ok)).statusCode).toBe(204);
    expect(await t.db.job.count({ where: { callId: call.id, kind: "translate" } })).toBe(1);
    const tr = await t.db.transcript.findUniqueOrThrow({ where: { callId: call.id } });
    expect(tr.textEn).toBeNull();
    expect(tr.translationModel).toBeNull();
  });

  it("re-transcription supersedes a running translate job and queues a fresh one", async () => {
    const { callId, jobId } = await translateReady();
    await claim({ workerId: "w1", kinds: ["translate"] });
    const again = await t.db.job.create({ data: { callId, status: "RUNNING", lockedBy: "w2", lockedAt: new Date() } });
    const segs = [{ text: "new text" }];
    const ok = { ok: true, workerId: "w2", text: "new text", provider: "p", segments: segs };
    expect((await postResult(again.id, ok)).statusCode).toBe(204);

    const old = await t.db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(old.status).toBe("FAILED");
    expect(old.lastError).toBe("superseded by re-transcription");
    const fresh = await t.db.job.findMany({ where: { callId, kind: "translate", status: "QUEUED" } });
    expect(fresh).toHaveLength(1);

    // The old worker's late result is rejected and the new transcript is kept.
    const late = { workerId: "w1", model: "m", textEn: "hello sir", segments: [{ text: "namaste ji", en: "hello sir" }] };
    expect((await postTranslation(jobId, late)).statusCode).toBe(409);
    const tr = await t.db.transcript.findUniqueOrThrow({ where: { callId } });
    expect(tr.text).toBe("new text");
    expect(tr.segments).toEqual(segs);
    expect(tr.textEn).toBeNull();
  });

  it("rejects an empty workerId on a translation", async () => {
    const { jobId } = await translateReady();
    expect((await postTranslation(jobId, { workerId: "", model: "m", textEn: "x", segments: [] })).statusCode).toBe(400);
  });

  it("does not queue translation when TRANSLATE_ENABLED=false", async () => {
    const off = await setupTestApp({ TRANSLATE_ENABLED: "false" });
    try {
      const call = await newCall();
      const job = await off.db.job.create({ data: { callId: call.id, status: "RUNNING", lockedBy: "w1", lockedAt: new Date() } });
      const res = await off.app.inject({
        method: "POST",
        url: `/internal/jobs/${job.id}/result`,
        headers: off.workerHeaders,
        payload: { ok: true, workerId: "w1", text: "x", provider: "p" },
      });
      expect(res.statusCode).toBe(204);
      expect(await off.db.job.count({ where: { callId: call.id, kind: "translate" } })).toBe(0);
    } finally {
      await off.app.close();
      await off.db.$disconnect();
    }
  });
});

describe("claim kinds", () => {
  it("old claim body without kinds only gets transcribe jobs", async () => {
    const { jobId } = await translateReady();
    const res = await claim({ workerId: "w1", limit: 5 });
    expect(res.json().jobs).toHaveLength(0);
    expect((await t.db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("QUEUED");
  });

  it("filters by kinds and a translate claim leaves the call TRANSCRIBED", async () => {
    const { callId, jobId } = await translateReady(0);
    const other = await newCall();
    await t.db.job.create({ data: { callId: other.id } });

    const jobs = (await claim({ workerId: "w1", limit: 5, kinds: ["translate"] })).json().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ jobId, callId, kind: "translate", priority: 0 });
    expect((await t.db.call.findUniqueOrThrow({ where: { id: callId } })).status).toBe("TRANSCRIBED");
    expect((await t.db.call.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("UPLOADED");

    const both = await claim({ workerId: "w1", limit: 5, kinds: ["transcribe", "translate"] });
    expect(both.json().jobs.map((j: { kind: string }) => j.kind)).toEqual(["transcribe"]);
  });

  it("rejects unknown kinds", async () => {
    expect((await claim({ workerId: "w1", kinds: ["nope"] })).statusCode).toBe(400);
  });
});

describe("translation result", () => {
  it("serves the transcript to the worker and stores the English version, searchable", async () => {
    const { callId, jobId } = await translateReady();
    const tr = await t.app.inject({ method: "GET", url: `/internal/transcripts/${callId}`, headers: t.workerHeaders });
    expect(tr.statusCode).toBe(200);
    expect(tr.json()).toMatchObject({ callId, text: "namaste ji\nkal milte", segments: [{ text: "namaste ji" }, { text: "kal milte" }] });
    const missing = await t.app.inject({ method: "GET", url: `/internal/transcripts/${randomUUID()}`, headers: t.workerHeaders });
    expect(missing.statusCode).toBe(404);

    await claim({ workerId: "w1", kinds: ["translate"] });
    const word = `zebrafinance${randomBytes(3).toString("hex")}`;
    const payload = {
      workerId: "w1",
      model: "claude-opus-5-5",
      textEn: `hello sir\nsee you tomorrow ${word}`,
      segments: [
        { text: "namaste ji", en: "hello sir" },
        { text: "kal milte", en: `see you tomorrow ${word}` },
      ],
      usage: { inputTokens: 100, outputTokens: 20, batch: false },
    };
    expect((await postTranslation(jobId, { ...payload, workerId: "w2" })).statusCode).toBe(409);
    expect((await postTranslation(jobId, payload)).statusCode).toBe(204);

    const stored = await t.db.transcript.findUniqueOrThrow({ where: { callId } });
    expect(stored.textEn).toBe(payload.textEn);
    expect(stored.translationModel).toBe("claude-opus-5-5");
    expect(stored.segments).toEqual(payload.segments);
    expect((await t.db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("DONE");
    expect((await t.db.call.findUniqueOrThrow({ where: { id: callId } })).status).toBe("TRANSCRIBED");

    const session = await t.sessionFor(adminEmail);
    const search = await t.app.inject({ method: "GET", url: `/api/calls?q=${word}`, headers: { cookie: session.cookie } });
    expect(search.statusCode).toBe(200);
    expect(search.json().items.map((c: { id: string }) => c.id)).toEqual([callId]);

    const detail = await t.app.inject({ method: "GET", url: `/api/calls/${callId}`, headers: { cookie: session.cookie } });
    expect(detail.json().transcript).toMatchObject({
      textEn: payload.textEn,
      translationModel: "claude-opus-5-5",
      translationPending: false,
    });
  });

  it("rejects a translation for a transcribe job, and a transcript for a translate job", async () => {
    const call = await newCall();
    const tjob = await t.db.job.create({ data: { callId: call.id, status: "RUNNING", lockedBy: "w1", lockedAt: new Date() } });
    expect((await postTranslation(tjob.id, { workerId: "w1", model: "m", textEn: "x", segments: [] })).statusCode).toBe(409);

    const { jobId } = await translateReady();
    await claim({ workerId: "w1", kinds: ["translate"] });
    expect((await postResult(jobId, { ok: true, workerId: "w1", text: "x", provider: "p" })).statusCode).toBe(409);
  });

  it("a failed translate job keeps the call TRANSCRIBED", async () => {
    const { callId, jobId } = await translateReady();
    await claim({ workerId: "w1", kinds: ["translate"] });
    expect((await postResult(jobId, { ok: false, workerId: "w1", error: "boom", retryable: false })).statusCode).toBe(204);
    expect((await t.db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("FAILED");
    expect((await t.db.call.findUniqueOrThrow({ where: { id: callId } })).status).toBe("TRANSCRIBED");
  });

  it("an exhausted stale translate job fails without failing the call", async () => {
    const { callId, jobId } = await translateReady();
    await t.db.job.update({
      where: { id: jobId },
      data: { status: "RUNNING", lockedBy: "dead", lockedAt: new Date(Date.now() - 60 * 60_000), attempts: 5 },
    });
    await claim({ workerId: "w1", kinds: ["translate"] });
    expect((await t.db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("FAILED");
    expect((await t.db.call.findUniqueOrThrow({ where: { id: callId } })).status).toBe("TRANSCRIBED");
  });
});

describe("translate backfill", () => {
  it("queues untranslated transcripts without an open job; admin only", async () => {
    await t.db.transcript.updateMany({ where: { textEn: null }, data: { textEn: "done" } });
    const a = await newCall("TRANSCRIBED");
    await t.db.transcript.create({ data: { callId: a.id, text: "a", provider: "p" } });
    const b = await translateReady(); // already has an open job
    const c = await newCall("TRANSCRIBED");
    await t.db.transcript.create({ data: { callId: c.id, text: "c", provider: "p", textEn: "c", translationModel: "m" } });

    const agentEmail = uniqueEmail("agent");
    await t.db.user.create({ data: { email: agentEmail } });
    const agent = await t.sessionFor(agentEmail);
    expect((await t.app.inject({ method: "POST", url: "/api/admin/translate-backfill", headers: agent })).statusCode).toBe(403);

    const admin = await t.sessionFor(adminEmail);
    const noOrigin = await t.app.inject({ method: "POST", url: "/api/admin/translate-backfill", headers: { cookie: admin.cookie } });
    expect(noOrigin.statusCode).toBe(403);

    const res = await t.app.inject({ method: "POST", url: "/api/admin/translate-backfill", headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ queued: 1 });
    const jobs = await t.db.job.findMany({ where: { callId: a.id, kind: "translate" } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ priority: 0, status: "QUEUED" });
    expect(await t.db.job.count({ where: { callId: b.callId, kind: "translate" } })).toBe(1);

    const detail = await t.app.inject({ method: "GET", url: `/api/calls/${a.id}`, headers: { cookie: admin.cookie } });
    expect(detail.json().transcript.translationPending).toBe(true);

    const again = await t.app.inject({ method: "POST", url: "/api/admin/translate-backfill", headers: admin });
    expect(again.json()).toEqual({ queued: 0 });
  });
});
