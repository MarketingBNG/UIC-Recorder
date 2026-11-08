import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { callsCsv, csvCell } from "../src/calls/export.js";
import { monthSpendUsd } from "../src/translation/cost.js";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let userId: string;
let adminEmail: string;
let agentEmail: string;

beforeAll(async () => {
  t = await setupTestApp({ SUMMARIZE_ENABLED: "true" });
  agentEmail = uniqueEmail("sum");
  userId = (await t.db.user.create({ data: { email: agentEmail, name: "Ravi Staff" } })).id;
  adminEmail = uniqueEmail("sumadmin");
  await t.db.user.create({ data: { email: adminEmail, role: "ADMIN" } });
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});
beforeEach(async () => {
  await t.db.job.updateMany({ where: { status: { in: ["QUEUED", "RUNNING", "WAITING_BUDGET"] } }, data: { status: "DONE" } });
  await t.db.job.updateMany({ where: { costAt: { not: null } }, data: { costUsd: null, costAt: null } });
  await t.db.setting.updateMany({ data: { costs: {} } });
});

async function newCall(status: "UPLOADED" | "TRANSCRIBED" = "UPLOADED") {
  return t.db.call.create({
    data: { id: randomUUID(), userId, startedAt: new Date(), originalSha256: sha256(randomBytes(8)), status, phoneE164: "+919876543210" },
  });
}

const inject = (method: "POST" | "GET" | "PUT", url: string, payload?: object, headers: object = t.workerHeaders) =>
  t.app.inject({ method, url, headers: headers as Record<string, string>, ...(payload ? { payload } : {}) });

const SUMMARY = {
  model: "claude-sonnet-5-5",
  summary: "Client asked about the GST return due date.",
  actionItems: ["Send GSTR-3B by Friday"],
  sentiment: "positive",
  tags: ["GST"],
  speakerRoles: [
    { speaker: "Ravi", role: "Agent" },
    { speaker: "Speaker 2", role: "Customer" },
  ],
  usage: { inputTokens: 1_000_000, outputTokens: 0, batch: false },
};

async function summarizeReady(priority = 10) {
  const call = await newCall("TRANSCRIBED");
  await t.db.transcript.create({
    data: { callId: call.id, text: "namaste", provider: "fireflies", textEn: "hello", segments: [{ text: "namaste", en: "hello" }] },
  });
  const job = await t.db.job.create({ data: { callId: call.id, kind: "summarize", priority } });
  return { callId: call.id, jobId: job.id };
}

describe("summarize queueing", () => {
  it("queues a summary after the English translation, with its priority", async () => {
    const call = await newCall("TRANSCRIBED");
    await t.db.transcript.create({ data: { callId: call.id, text: "namaste", provider: "p", segments: [{ text: "namaste" }] } });
    const tj = await t.db.job.create({ data: { callId: call.id, kind: "translate", priority: 10 } });
    const [job] = (await inject("POST", "/internal/jobs/claim", { workerId: "w1", kinds: ["translate"] })).json().jobs;
    expect(job.jobId).toBe(tj.id);
    const res = await inject("POST", `/internal/jobs/${tj.id}/translation`, {
      workerId: "w1", model: "m", textEn: "hello", segments: [{ text: "namaste", en: "hello" }],
    });
    expect(res.statusCode).toBe(204);
    const sj = await t.db.job.findMany({ where: { callId: call.id, kind: "summarize" } });
    expect(sj).toHaveLength(1);
    expect(sj[0]!.priority).toBe(10);
  });

  it("queues a summary straight after transcription when translation is off", async () => {
    const off = await setupTestApp({ SUMMARIZE_ENABLED: "true", TRANSLATE_ENABLED: "false" });
    try {
      const call = await newCall();
      const job = await off.db.job.create({ data: { callId: call.id, status: "RUNNING", lockedBy: "w1", lockedAt: new Date() } });
      const res = await off.app.inject({
        method: "POST", url: `/internal/jobs/${job.id}/result`, headers: off.workerHeaders,
        payload: { ok: true, workerId: "w1", text: "x", provider: "p" },
      });
      expect(res.statusCode).toBe(204);
      expect(await off.db.job.count({ where: { callId: call.id, kind: "summarize" } })).toBe(1);
      expect(await off.db.job.count({ where: { callId: call.id, kind: "translate" } })).toBe(0);
    } finally {
      await off.app.close();
      await off.db.$disconnect();
    }
  });

  it("does not queue summaries when SUMMARIZE_ENABLED is off (the default)", async () => {
    const off = await setupTestApp({ TRANSLATE_ENABLED: "false" });
    try {
      const call = await newCall();
      const job = await off.db.job.create({ data: { callId: call.id, status: "RUNNING", lockedBy: "w1", lockedAt: new Date() } });
      await off.app.inject({
        method: "POST", url: `/internal/jobs/${job.id}/result`, headers: off.workerHeaders,
        payload: { ok: true, workerId: "w1", text: "x", provider: "p" },
      });
      expect(await off.db.job.count({ where: { callId: call.id, kind: "summarize" } })).toBe(0);
    } finally {
      await off.app.close();
      await off.db.$disconnect();
    }
  });
});

describe("summary result", () => {
  it("hands the agent name to the worker, stores the summary and its cost, shows it on the call", async () => {
    const { callId, jobId } = await summarizeReady();
    const [job] = (await inject("POST", "/internal/jobs/claim", { workerId: "w1", kinds: ["summarize"] })).json().jobs;
    expect(job).toMatchObject({ jobId, kind: "summarize", agentName: "Ravi Staff" });
    const tr = (await inject("GET", `/internal/transcripts/${callId}`)).json();
    expect(tr.textEn).toBe("hello");

    expect((await inject("POST", `/internal/jobs/${jobId}/summary`, { workerId: "w1", ...SUMMARY })).statusCode).toBe(204);
    const row = await t.db.transcript.findUniqueOrThrow({ where: { callId } });
    expect(row.summary).toBe(SUMMARY.summary);
    expect(row.actionItems).toEqual(SUMMARY.actionItems);
    expect(row.speakerRoles).toEqual(SUMMARY.speakerRoles);
    expect(row.summaryCostUsd).toBeCloseTo(2);
    expect(await monthSpendUsd(t.db)).toBeCloseTo(2);

    const detail = (await inject("GET", `/api/calls/${callId}`, undefined, await t.sessionFor(adminEmail))).json();
    expect(detail.transcript).toMatchObject({ summary: SUMMARY.summary, sentiment: "positive", tags: ["GST"], summaryPending: false });
  });

  it("validates sentiment and roles, and rejects a summary for another kind of job", async () => {
    const { jobId } = await summarizeReady();
    await inject("POST", "/internal/jobs/claim", { workerId: "w1", kinds: ["summarize"] });
    expect((await inject("POST", `/internal/jobs/${jobId}/summary`, { workerId: "w1", ...SUMMARY, sentiment: "angry" })).statusCode).toBe(400);
    const bad = { ...SUMMARY, speakerRoles: [{ speaker: "x", role: "Boss" }] };
    expect((await inject("POST", `/internal/jobs/${jobId}/summary`, { workerId: "w1", ...bad })).statusCode).toBe(400);
    const tj = await t.db.job.create({ data: { callId: (await newCall("TRANSCRIBED")).id, kind: "translate", status: "RUNNING", lockedBy: "w1" } });
    expect((await inject("POST", `/internal/jobs/${tj.id}/summary`, { workerId: "w1", ...SUMMARY })).statusCode).toBe(409);
  });

  it("counts a failed summarize attempt's spend", async () => {
    const { jobId } = await summarizeReady();
    await inject("POST", "/internal/jobs/claim", { workerId: "w1", kinds: ["summarize"] });
    const res = await inject("POST", `/internal/jobs/${jobId}/result`, {
      ok: false, workerId: "w1", error: "bad json", model: "claude-sonnet-5-5", usage: { inputTokens: 500_000, outputTokens: 0, batch: false },
    });
    expect(res.statusCode).toBe(204);
    expect(await monthSpendUsd(t.db)).toBeCloseTo(1);
    const call = await t.db.job.findUniqueOrThrow({ where: { id: jobId }, include: { call: true } });
    expect(call.call.status).toBe("TRANSCRIBED");
  });

  it("re-transcription clears the summary and supersedes a running summarize job", async () => {
    const { callId, jobId } = await summarizeReady();
    await inject("POST", "/internal/jobs/claim", { workerId: "w1", kinds: ["summarize"] });
    await t.db.transcript.update({ where: { callId }, data: { summary: "old", sentiment: "neutral", tags: ["x"] } });
    const again = await t.db.job.create({ data: { callId, status: "RUNNING", lockedBy: "w2", lockedAt: new Date() } });
    expect((await inject("POST", `/internal/jobs/${again.id}/result`, { ok: true, workerId: "w2", text: "new", provider: "p" })).statusCode).toBe(204);
    expect((await t.db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("FAILED");
    const tr = await t.db.transcript.findUniqueOrThrow({ where: { callId } });
    expect(tr.summary).toBeNull();
    expect(tr.tags).toBeNull();
    expect((await inject("POST", `/internal/jobs/${jobId}/summary`, { workerId: "w1", ...SUMMARY })).statusCode).toBe(409);
  });
});

describe("queued summary on re-transcription", () => {
  it("drops a queued summary (it would read untranslated text); the translation queues a fresh one", async () => {
    const { callId, jobId } = await summarizeReady(0);
    const again = await t.db.job.create({ data: { callId, status: "RUNNING", lockedBy: "w2", lockedAt: new Date() } });
    expect((await inject("POST", `/internal/jobs/${again.id}/result`, { ok: true, workerId: "w2", text: "new", provider: "p" })).statusCode).toBe(204);
    expect((await t.db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("FAILED");
    expect(await t.db.job.count({ where: { callId, kind: "summarize", status: "QUEUED" } })).toBe(0);
    expect(await t.db.job.count({ where: { callId, kind: "translate", status: "QUEUED" } })).toBe(1);
  });
});

describe("Claude cap covers summaries", () => {
  it("stops handing out summarize jobs at the cap", async () => {
    await summarizeReady(0);
    await t.db.setting.upsert({ where: { id: 1 }, create: { id: 1, deviceConfig: {}, costs: { translateBudgetUsd: 0 } }, update: { costs: { translateBudgetUsd: 0 } } });
    expect((await inject("POST", "/internal/jobs/claim", { workerId: "w1", kinds: ["summarize"] })).json().jobs).toHaveLength(0);
    await t.db.setting.update({ where: { id: 1 }, data: { costs: { translateBudgetUsd: 100 } } });
    expect((await inject("POST", "/internal/jobs/claim", { workerId: "w1", kinds: ["summarize"] })).json().jobs).toHaveLength(1);
  });
});

describe("summary backfill", () => {
  it("queues unsummarized transcripts, skips ones still being translated; admin only", async () => {
    const { callId: hasJob } = await summarizeReady();
    const plain = await newCall("TRANSCRIBED");
    await t.db.transcript.create({ data: { callId: plain.id, text: "a", provider: "p" } });
    const translating = await newCall("TRANSCRIBED");
    await t.db.transcript.create({ data: { callId: translating.id, text: "b", provider: "p" } });
    await t.db.job.create({ data: { callId: translating.id, kind: "translate" } });

    const agent = await t.sessionFor(agentEmail);
    expect((await inject("POST", "/api/admin/summarize-backfill", {}, agent)).statusCode).toBe(403);
    const res = await inject("POST", "/api/admin/summarize-backfill", {}, await t.sessionFor(adminEmail));
    expect(res.statusCode).toBe(200);
    expect(await t.db.job.count({ where: { callId: plain.id, kind: "summarize", status: "QUEUED" } })).toBe(1);
    expect(await t.db.job.count({ where: { callId: translating.id, kind: "summarize" } })).toBe(0);
    expect(await t.db.job.count({ where: { callId: hasJob, kind: "summarize", status: "QUEUED" } })).toBe(1);
  });
});

describe("CSV export", () => {
  it("csvCell quotes and neutralises formulas", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+91 98")).toBe("'+91 98");
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe("42");
  });

  it("callsCsv writes a header, BOM and one line per call", () => {
    const csv = callsCsv([
      {
        id: "c1", startedAt: new Date("2026-01-02T03:04:05Z"), direction: "INCOMING", phoneE164: null, phoneRaw: "98765",
        contactName: null, durationS: 61, status: "TRANSCRIBED", user: { name: null, email: "a@b.c" },
        transcript: { language: "hi", text: "line1\nline2", textEn: null, summary: "s", actionItems: ["x", "y"], sentiment: "neutral", tags: ["t"] },
      },
    ]);
    const lines = csv.slice(1).split("\r\n");
    expect(csv.startsWith("﻿call_id,")).toBe(true);
    expect(lines[1]).toBe('c1,2026-01-02T03:04:05.000Z,INCOMING,98765,,a@b.c,61,TRANSCRIBED,hi,neutral,t,s,x; y,,"line1\nline2"');
  });

  it("managers export the filtered list (audited); agents cannot", async () => {
    const { callId } = await summarizeReady();
    await t.db.transcript.update({ where: { callId }, data: { summary: "Exported summary" } });
    expect((await inject("GET", "/api/calls/export", undefined, await t.sessionFor(agentEmail))).statusCode).toBe(403);
    const res = await inject("GET", `/api/calls/export?userId=${userId}`, undefined, await t.sessionFor(adminEmail));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.body).toContain("Exported summary");
    expect(res.body).toContain("'+919876543210");
    const log = await t.db.auditLog.findFirst({ where: { action: "EXPORT" }, orderBy: { createdAt: "desc" } });
    expect(log).not.toBeNull();
    const audit = (await inject("GET", "/api/audit?action=EXPORT", undefined, await t.sessionFor(adminEmail))).json();
    expect(audit.items.length).toBeGreaterThan(0);
  });
});
