import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

const meta = (original: string, extra: object = {}) => ({
  originalSha256: original,
  phoneNumber: "098765 43210",
  direction: "OUTGOING",
  startedAt: "2026-10-01T10:00:00+05:30",
  durationS: 95,
  ...extra,
});

async function uploadCall(headers: Record<string, string>, audio: Buffer, extra: object = {}) {
  const original = sha256(randomBytes(16));
  const created = await t.app.inject({ method: "POST", url: "/v1/calls", headers, payload: meta(original, extra) });
  const { callId } = created.json();
  const put = await t.app.inject({
    method: "PUT",
    url: `/v1/calls/${callId}/audio`,
    headers: { ...headers, "content-type": "audio/mp4", "x-content-sha256": sha256(audio) },
    payload: audio,
  });
  return { original, callId, created, put };
}

describe("call upload", () => {
  it("registers, uploads, dedups, and queues a job", async () => {
    const s = await t.loginDevice(uniqueEmail());
    const audio = randomBytes(4096);
    const { original, callId, created, put } = await uploadCall(s.headers, audio);
    expect(created.statusCode).toBe(201);
    expect(put.statusCode).toBe(201);

    const call = await t.db.call.findUniqueOrThrow({ where: { id: callId }, include: { jobs: true } });
    expect(call.status).toBe("UPLOADED");
    expect(call.phoneE164).toBe("+919876543210");
    expect(call.jobs).toHaveLength(1);
    expect(call.jobs[0]!.priority).toBe(10);
    expect(await t.storage.size(call.filePath!)).toBe(4096);

    const check = await t.app.inject({ method: "POST", url: "/v1/calls/check", headers: s.headers, payload: { hashes: [original, sha256("nope")] } });
    expect(check.json().known).toEqual([original]);

    const again = await t.app.inject({ method: "POST", url: "/v1/calls", headers: s.headers, payload: meta(original) });
    expect(again.json()).toMatchObject({ callId, alreadyUploaded: true });
  });

  it("rejects checksum mismatches and keeps the call pending", async () => {
    const s = await t.loginDevice(uniqueEmail());
    const created = await t.app.inject({ method: "POST", url: "/v1/calls", headers: s.headers, payload: meta(sha256("x1")) });
    const { callId } = created.json();
    const put = await t.app.inject({
      method: "PUT",
      url: `/v1/calls/${callId}/audio`,
      headers: { ...s.headers, "content-type": "audio/mp4", "x-content-sha256": sha256("different") },
      payload: randomBytes(100),
    });
    expect(put.statusCode).toBe(422);
    expect((await t.db.call.findUniqueOrThrow({ where: { id: callId } })).status).toBe("PENDING_UPLOAD");
  });

  it("enforces size and type limits", async () => {
    const s = await t.loginDevice(uniqueEmail());
    const big = randomBytes(1024 * 1024 + 10);
    expect((await uploadCall(s.headers, big)).put.statusCode).toBe(413);

    const created = await t.app.inject({ method: "POST", url: "/v1/calls", headers: s.headers, payload: meta(sha256("x2")) });
    const put = await t.app.inject({
      method: "PUT",
      url: `/v1/calls/${created.json().callId}/audio`,
      headers: { ...s.headers, "content-type": "text/html", "x-content-sha256": sha256("a") },
      payload: "a",
    });
    expect(put.statusCode).toBe(415);
  });

  it("does not let one user upload into another user's call", async () => {
    const a = await t.loginDevice(uniqueEmail());
    const b = await t.loginDevice(uniqueEmail());
    const created = await t.app.inject({ method: "POST", url: "/v1/calls", headers: a.headers, payload: meta(sha256("x3")) });
    const audio = randomBytes(10);
    const put = await t.app.inject({
      method: "PUT",
      url: `/v1/calls/${created.json().callId}/audio`,
      headers: { ...b.headers, "content-type": "audio/mp4", "x-content-sha256": sha256(audio) },
      payload: audio,
    });
    expect(put.statusCode).toBe(404);
  });
});

describe("worker jobs + search", () => {
  it("claims without overlap, completes, and makes transcripts searchable within scope", async () => {
    const agentEmail = uniqueEmail("agent");
    const s = await t.loginDevice(agentEmail);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await uploadCall(s.headers, randomBytes(64))).callId);

    const claim = (workerId: string) =>
      t.app.inject({ method: "POST", url: "/internal/jobs/claim", headers: t.workerHeaders, payload: { workerId, limit: 3 } });
    const [c1, c2] = await Promise.all([claim("w1"), claim("w2")]);
    const j1 = c1.json().jobs as { jobId: string; callId: string }[];
    const j2 = c2.json().jobs as { jobId: string; callId: string }[];
    const all = [...j1, ...j2].map((j) => j.jobId);
    expect(new Set(all).size).toBe(all.length); // no job handed out twice

    const mine = [...j1.map((j) => ({ ...j, w: "w1" })), ...j2.map((j) => ({ ...j, w: "w2" }))];
    const target = mine.find((j) => ids.includes(j.callId))!;

    const audio = await t.app.inject({ method: "GET", url: `/internal/audio/${target.callId}`, headers: t.workerHeaders });
    expect(audio.statusCode).toBe(200);

    // Wrong worker can't post results for someone else's lock.
    const stolen = await t.app.inject({
      method: "POST",
      url: `/internal/jobs/${target.jobId}/result`,
      headers: t.workerHeaders,
      payload: { ok: true, workerId: "intruder", text: "x", provider: "stub" },
    });
    expect(stolen.statusCode).toBe(409);

    const done = await t.app.inject({
      method: "POST",
      url: `/internal/jobs/${target.jobId}/result`,
      headers: t.workerHeaders,
      payload: { ok: true, workerId: target.w, text: "Client asked about the GST invoice for October", language: "en", provider: "stub" },
    });
    expect(done.statusCode).toBe(204);
    expect((await t.db.call.findUniqueOrThrow({ where: { id: target.callId } })).status).toBe("TRANSCRIBED");

    // The agent finds it by transcript text...
    const own = await t.sessionFor(agentEmail);
    const found = await t.app.inject({ method: "GET", url: "/api/calls?q=gst%20invoice", headers: { cookie: own.cookie } });
    expect(found.json().items.map((c: { id: string }) => c.id)).toContain(target.callId);

    // ...another agent cannot.
    const otherEmail = uniqueEmail("other");
    await t.db.user.create({ data: { email: otherEmail } });
    const other = await t.sessionFor(otherEmail);
    const hidden = await t.app.inject({ method: "GET", url: "/api/calls?q=gst%20invoice", headers: { cookie: other.cookie } });
    expect(hidden.json().items).toHaveLength(0);
    const detail = await t.app.inject({ method: "GET", url: `/api/calls/${target.callId}`, headers: { cookie: other.cookie } });
    expect(detail.statusCode).toBe(404);
  });

  it("retries failures with backoff, then gives up", async () => {
    const s = await t.loginDevice(uniqueEmail());
    const { callId } = await uploadCall(s.headers, randomBytes(32));
    const job = await t.db.job.findFirstOrThrow({ where: { callId } });
    // Force this job to be the one claimed.
    await t.db.job.update({ where: { id: job.id }, data: { priority: 1000 } });

    const claimed = await t.app.inject({ method: "POST", url: "/internal/jobs/claim", headers: t.workerHeaders, payload: { workerId: "w9" } });
    expect(claimed.json().jobs[0].jobId).toBe(job.id);
    await t.app.inject({
      method: "POST",
      url: `/internal/jobs/${job.id}/result`,
      headers: t.workerHeaders,
      payload: { ok: false, workerId: "w9", error: "provider timeout" },
    });
    let after = await t.db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("QUEUED");
    expect(after.runAfter.getTime()).toBeGreaterThan(Date.now());

    await t.db.job.update({ where: { id: job.id }, data: { runAfter: new Date(0), attempts: 4 } });
    await t.app.inject({ method: "POST", url: "/internal/jobs/claim", headers: t.workerHeaders, payload: { workerId: "w9" } });
    await t.app.inject({
      method: "POST",
      url: `/internal/jobs/${job.id}/result`,
      headers: t.workerHeaders,
      payload: { ok: false, workerId: "w9", error: "still failing" },
    });
    after = await t.db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("FAILED");
    expect((await t.db.call.findUniqueOrThrow({ where: { id: callId } })).status).toBe("FAILED");
  });

  it("rejects bad worker tokens", async () => {
    const res = await t.app.inject({ method: "POST", url: "/internal/jobs/claim", headers: { authorization: "Bearer nope" }, payload: { workerId: "x" } });
    expect(res.statusCode).toBe(401);
  });
});

describe("regressions", () => {
  it("stops reclaiming stale jobs after MAX_ATTEMPTS and fails them", async () => {
    const s = await t.loginDevice(uniqueEmail());
    const { callId } = await uploadCall(s.headers, randomBytes(32));
    const job = await t.db.job.findFirstOrThrow({ where: { callId } });
    await t.db.job.update({
      where: { id: job.id },
      data: { status: "RUNNING", lockedBy: "dead", lockedAt: new Date(Date.now() - 3600_000), attempts: 5, priority: 2000 },
    });
    const claimed = await t.app.inject({ method: "POST", url: "/internal/jobs/claim", headers: t.workerHeaders, payload: { workerId: "w5", limit: 20 } });
    expect(claimed.json().jobs.map((j: { jobId: string }) => j.jobId)).not.toContain(job.id);
    expect((await t.db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("FAILED");
    expect((await t.db.call.findUniqueOrThrow({ where: { id: callId } })).status).toBe("FAILED");
  });

  it("heartbeat keeps a long job from being reclaimed", async () => {
    const s = await t.loginDevice(uniqueEmail());
    const { callId } = await uploadCall(s.headers, randomBytes(32));
    const job = await t.db.job.findFirstOrThrow({ where: { callId } });
    await t.db.job.update({
      where: { id: job.id },
      data: { status: "RUNNING", lockedBy: "slow", lockedAt: new Date(Date.now() - 3600_000), attempts: 1, priority: 3000 },
    });
    const hb = await t.app.inject({ method: "POST", url: `/internal/jobs/${job.id}/heartbeat`, headers: t.workerHeaders, payload: { workerId: "slow" } });
    expect(hb.statusCode).toBe(204);
    const claimed = await t.app.inject({ method: "POST", url: "/internal/jobs/claim", headers: t.workerHeaders, payload: { workerId: "thief", limit: 20 } });
    expect(claimed.json().jobs.map((j: { jobId: string }) => j.jobId)).not.toContain(job.id);
    const wrong = await t.app.inject({ method: "POST", url: `/internal/jobs/${job.id}/heartbeat`, headers: t.workerHeaders, payload: { workerId: "thief" } });
    expect(wrong.statusCode).toBe(409);
  });

  it("search finds an agent's call even when other users have >1000 matches", async () => {
    const noisy = await t.db.user.create({ data: { email: uniqueEmail("noisy") } });
    const rows = Array.from({ length: 1100 }, (_, i) => ({
      userId: noisy.id,
      originalSha256: sha256(`noisy-${noisy.id}-${i}`),
      startedAt: new Date(Date.now() - i * 1000),
      status: "TRANSCRIBED" as const,
    }));
    await t.db.call.createMany({ data: rows });
    const ids = await t.db.call.findMany({ where: { userId: noisy.id }, select: { id: true } });
    await t.db.transcript.createMany({ data: ids.map((c) => ({ callId: c.id, text: "zebra quarterly invoice", provider: "stub" })) });

    const agentEmail = uniqueEmail("quiet");
    const agent = await t.db.user.create({ data: { email: agentEmail } });
    const mine = await t.db.call.create({
      data: { userId: agent.id, originalSha256: sha256(`mine-${agent.id}`), startedAt: new Date("2020-01-01"), status: "TRANSCRIBED" },
    });
    await t.db.transcript.create({ data: { callId: mine.id, text: "zebra quarterly invoice from me", provider: "stub" } });

    const sess = await t.sessionFor(agentEmail);
    const res = await t.app.inject({ method: "GET", url: "/api/calls?q=zebra", headers: { cookie: sess.cookie } });
    expect(res.json().items.map((c: { id: string }) => c.id)).toEqual([mine.id]);
  });

  it("logs PLAY for browser range requests starting at 0", async () => {
    const email = uniqueEmail("player");
    const s = await t.loginDevice(email);
    const { callId } = await uploadCall(s.headers, randomBytes(500));
    const sess = await t.sessionFor(email);
    const res = await t.app.inject({ method: "GET", url: `/api/calls/${callId}/audio`, headers: { cookie: sess.cookie, range: "bytes=0-" } });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-499/500");
    await new Promise((r) => setTimeout(r, 200));
    expect(await t.db.auditLog.count({ where: { callId, action: "PLAY" } })).toBe(1);
  });
});
