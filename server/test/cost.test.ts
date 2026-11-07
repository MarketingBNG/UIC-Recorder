import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claudeCostUsd, monthSpendUsd, translationUsage } from "../src/translation/cost.js";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let userId: string;
let adminEmail: string;
let managerEmail: string;

beforeAll(async () => {
  t = await setupTestApp();
  userId = (await t.db.user.create({ data: { email: uniqueEmail("cost") } })).id;
  adminEmail = uniqueEmail("costadmin");
  managerEmail = uniqueEmail("costmgr");
  await t.db.user.create({ data: { email: adminEmail, role: "ADMIN" } });
  await t.db.user.create({ data: { email: managerEmail, role: "MANAGER" } });
});
afterAll(async () => {
  // Leave no spend behind for other test files.
  await t.db.job.updateMany({ where: { costAt: { not: null } }, data: { costUsd: null, costAt: null } });
  await t.db.setting.updateMany({ data: { costs: {} } });
  await t.app.close();
  await t.db.$disconnect();
});
beforeEach(async () => {
  await t.db.job.updateMany({ where: { status: { in: ["QUEUED", "RUNNING", "WAITING_BUDGET"] } }, data: { status: "DONE" } });
  await t.db.job.updateMany({ where: { costAt: { not: null } }, data: { costUsd: null, costAt: null } });
  await t.db.setting.updateMany({ data: { costs: {} } });
  await t.db.firefliesReservation.deleteMany();
});

async function newCall(status: "UPLOADED" | "TRANSCRIBED" = "UPLOADED", source: "LIVE" | "BACKLOG" = "LIVE") {
  return t.db.call.create({
    data: { id: randomUUID(), userId, startedAt: new Date(), originalSha256: sha256(randomBytes(8)), status, source },
  });
}

async function translateJob(status: "QUEUED" | "RUNNING" = "QUEUED") {
  const call = await newCall("TRANSCRIBED");
  await t.db.transcript.create({ data: { callId: call.id, text: "namaste", provider: "fireflies", segments: [{ text: "namaste" }] } });
  return t.db.job.create({
    data: { callId: call.id, kind: "translate", status, ...(status === "RUNNING" ? { lockedBy: "w1", lockedAt: new Date() } : {}) },
  });
}

const claim = (payload: object) => t.app.inject({ method: "POST", url: "/internal/jobs/claim", headers: t.workerHeaders, payload });
const setCosts = (costs: object) =>
  t.db.setting.upsert({ where: { id: 1 }, create: { id: 1, deviceConfig: {}, costs }, update: { costs } });
const translation = (jobId: string, usage?: object) =>
  t.app.inject({
    method: "POST",
    url: `/internal/jobs/${jobId}/translation`,
    headers: t.workerHeaders,
    payload: { workerId: "w1", model: "claude-opus-5-5", textEn: "hello", segments: [{ text: "namaste", en: "hello" }], usage },
  });

describe("claudeCostUsd", () => {
  it("prices per model, halves batch, charges unknown models at the top rate", () => {
    expect(claudeCostUsd("claude-opus-5-5", 1_000_000, 1_000_000, false)).toBe(24);
    expect(claudeCostUsd("claude-opus-5-5", 1_000_000, 1_000_000, true)).toBe(12);
    expect(claudeCostUsd("claude-sonnet-5-5", 1_000_000, 0, false)).toBe(2);
    expect(claudeCostUsd("claude-sonnet-5-5", 0, 1_000_000, true)).toBe(5);
    expect(claudeCostUsd("some-new-model", 1_000_000, 0, false)).toBe(4);
  });
});

describe("translation cost tracking", () => {
  it("stores tokens + cost on the transcript and the job", async () => {
    const job = await translateJob("RUNNING");
    const res = await translation(job.id, { inputTokens: 100_000, outputTokens: 50_000, batch: true });
    expect(res.statusCode).toBe(204);
    const tr = await t.db.transcript.findUniqueOrThrow({ where: { callId: job.callId } });
    expect(tr.translationInputTokens).toBe(100_000);
    expect(tr.translationOutputTokens).toBe(50_000);
    expect(tr.translationCostUsd).toBeCloseTo(0.7); // (0.4 + 1.0) / 2
    const j = await t.db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(j.costUsd).toBeCloseTo(0.7);
    expect(await monthSpendUsd(t.db)).toBeCloseTo(0.7);
  });

  it("counts the spend even when the lock was lost", async () => {
    const job = await translateJob("RUNNING");
    await t.db.job.update({ where: { id: job.id }, data: { status: "FAILED", lockedBy: null } });
    const res = await translation(job.id, { inputTokens: 1_000_000, outputTokens: 0, batch: false });
    expect(res.statusCode).toBe(409);
    expect(await monthSpendUsd(t.db)).toBeCloseTo(4);
  });

  it("spend from an earlier month does not count", async () => {
    const job = await translateJob();
    await t.db.job.update({ where: { id: job.id }, data: { costUsd: 50, costAt: new Date(Date.UTC(2020, 0, 15)) } });
    expect(await monthSpendUsd(t.db)).toBe(0);
    expect(await monthSpendUsd(t.db, new Date(Date.UTC(2020, 0, 31)))).toBe(50);
  });
});

describe("monthly cap", () => {
  it("stops handing out translate jobs at the cap; raising it releases them", async () => {
    await setCosts({ translateBudgetUsd: 1 });
    const spent = await translateJob();
    await t.db.job.update({ where: { id: spent.id }, data: { status: "DONE", costUsd: 1.2, costAt: new Date() } });
    const waiting = await translateJob();
    const transcribe = await t.db.job.create({ data: { callId: (await newCall()).id } });

    const r1 = (await claim({ workerId: "w1", limit: 5, kinds: ["transcribe", "translate"] })).json().jobs;
    expect(r1.map((j: { jobId: string }) => j.jobId)).toEqual([transcribe.id]);
    expect((await t.db.job.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe("QUEUED");
    expect((await claim({ workerId: "w1", limit: 5, kinds: ["translate"] })).json().jobs).toEqual([]);

    const s = await t.sessionFor(adminEmail);
    const put = await t.app.inject({ method: "PUT", url: "/api/settings/costs", headers: s, payload: { translateBudgetUsd: 5 } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ budgetUsd: 5, capped: false, spentUsd: 1.2 });
    const r2 = (await claim({ workerId: "w1", limit: 5, kinds: ["translate"] })).json().jobs;
    expect(r2.map((j: { jobId: string }) => j.jobId)).toEqual([waiting.id]);
  });

  it("defaults to a 500 USD cap; usage readable by managers, writable only by admins", async () => {
    const u = await translationUsage(t.db);
    expect(u).toMatchObject({ budgetUsd: 500, capped: false, sarvamOverflow: false });
    const m = await t.sessionFor(managerEmail);
    expect((await t.app.inject({ method: "GET", url: "/api/translation/usage", headers: m })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "PUT", url: "/api/settings/costs", headers: m, payload: { translateBudgetUsd: 1 } })).statusCode).toBe(403);
    const a = await t.sessionFor(adminEmail);
    expect((await t.app.inject({ method: "PUT", url: "/api/settings/costs", headers: a, payload: { translateBudgetUsd: -1 } })).statusCode).toBe(400);
    const stats = await t.app.inject({ method: "GET", url: "/api/stats", headers: a });
    expect(stats.json().translation).toMatchObject({ budgetUsd: 500, capped: false });
  });
});

describe("Sarvam overflow claim", () => {
  async function parked(source: "LIVE" | "BACKLOG", reason: string) {
    const call = await newCall("UPLOADED", source);
    return t.db.job.create({
      data: { callId: call.id, status: "WAITING_BUDGET", lastError: `WAITING_BUDGET: ${reason}`, runAfter: new Date(Date.now() + 86400_000) },
    });
  }

  it("only budget-parked backlog jobs, only when switched on, never already-uploaded calls", async () => {
    const ok = await parked("BACKLOG", "BUDGET 900+3 min would exceed");
    await parked("LIVE", "BUDGET 900+3 min would exceed");
    await parked("BACKLOG", "BLOCKED Fireflies hard stop");
    await parked("BACKLOG", "BATCH_GATE 20/20 approved");
    const uploaded = await parked("BACKLOG", "BUDGET x");
    await t.db.firefliesReservation.create({
      data: { callId: uploaded.callId, month: "2026-11", minutes: 3, live: false, status: "COMMITTED", uploadedAt: new Date() },
    });
    const ordinary = await t.db.job.create({ data: { callId: (await newCall()).id } });

    // Off by default: a sarvam worker gets nothing, not even ordinary QUEUED jobs.
    expect((await claim({ workerId: "s1", limit: 10, provider: "sarvam" })).json().jobs).toEqual([]);

    await setCosts({ sarvamOverflow: true });
    const got = (await claim({ workerId: "s1", limit: 10, provider: "sarvam" })).json().jobs;
    expect(got.map((j: { jobId: string }) => j.jobId)).toEqual([ok.id]);
    expect((await t.db.job.findUniqueOrThrow({ where: { id: ordinary.id } })).status).toBe("QUEUED");

    // Workers without a provider behave as before.
    const plain = (await claim({ workerId: "w1", limit: 10 })).json().jobs;
    expect(plain.map((j: { jobId: string }) => j.jobId)).toEqual([ordinary.id]);
  });
});
