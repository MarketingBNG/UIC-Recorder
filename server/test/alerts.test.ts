import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REPEAT_MS, cliqSender, resolveAlert, sendAlert } from "../src/alerts/cliq.js";
import { runChecks, touchWorker } from "../src/alerts/checks.js";
import { backlogMinutes, jobStats } from "../src/alerts/metrics.js";
import type { LocalStorage } from "../src/storage/local.js";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let userId: string;
let adminEmail: string;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Fake Cliq: records messages; `ok` toggles acceptance. */
function fakeCliq() {
  const f = {
    sent: [] as string[],
    ok: true,
    send: async (text: string) => {
      if (!f.ok) return false;
      f.sent.push(text);
      return true;
    },
  };
  return f;
}
const disk = (usedPct: number) =>
  ({ diskUsage: async () => ({ totalBytes: 100 * 1024 ** 3, freeBytes: (100 - usedPct) * 1024 ** 3 }) }) as unknown as LocalStorage;

beforeAll(async () => {
  t = await setupTestApp();
  userId = (await t.db.user.create({ data: { email: uniqueEmail("al") } })).id;
  adminEmail = uniqueEmail("aladmin");
  await t.db.user.create({ data: { email: adminEmail, role: "ADMIN" } });
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});
// Other test files share the database: neutralize their jobs, devices and Fireflies state.
beforeEach(async () => {
  await t.db.job.updateMany({ where: { status: { in: ["QUEUED", "RUNNING", "WAITING_BUDGET"] } }, data: { status: "DONE" } });
  await t.db.job.updateMany({ data: { finishedAt: null, failedAttemptAt: null, costUsd: null, costAt: null } });
  await t.db.device.updateMany({ data: { lastSeenAt: new Date(), calls7d: null } });
  await t.db.firefliesReservation.deleteMany();
  await t.db.setting.updateMany({ data: { fireflies: {}, costs: {} } });
  await t.db.workerSeen.deleteMany();
  await t.db.alertState.deleteMany();
});

async function newCall(durationS: number | null = 120, fileSize?: number) {
  return t.db.call.create({
    data: {
      id: randomUUID(),
      userId,
      startedAt: new Date(),
      originalSha256: sha256(randomBytes(8)),
      status: "UPLOADED",
      durationS,
      fileSize: fileSize === undefined ? null : BigInt(fileSize),
    },
  });
}
async function finishedJob(status: "DONE" | "FAILED", finishedAt: Date, seconds = 60, lastError?: string) {
  const call = await newCall();
  return t.db.job.create({
    data: {
      callId: call.id,
      status,
      startedAt: new Date(finishedAt.getTime() - seconds * 1000),
      finishedAt,
      failedAttemptAt: status === "FAILED" && !lastError ? finishedAt : null,
      lastError: lastError ?? null,
    },
  });
}

describe("sendAlert / resolveAlert dedupe", () => {
  it("sends once, repeats after 6 h, resolves once", async () => {
    const c = fakeCliq();
    const t0 = new Date("2026-11-07T00:00:00Z");
    expect(await sendAlert(t.db, c.send, "k", "boom", t0)).toBe(true);
    expect(await sendAlert(t.db, c.send, "k", "boom", new Date(t0.getTime() + HOUR))).toBe(false);
    expect(await sendAlert(t.db, c.send, "k", "boom", new Date(t0.getTime() + REPEAT_MS + 1))).toBe(true);
    expect(c.sent).toEqual(["boom", "boom\n(still happening)"]);

    expect(await resolveAlert(t.db, c.send, "k", "ok again", t0)).toBe(true);
    expect(await resolveAlert(t.db, c.send, "k", "ok again", t0)).toBe(false);
    expect(c.sent.at(-1)).toBe("Resolved: ok again");
    // Never-raised key: no resolved message.
    expect(await resolveAlert(t.db, c.send, "never", "x", t0)).toBe(false);
    expect(c.sent).toHaveLength(3);
  });

  it("retries a failed send on the next run", async () => {
    const c = fakeCliq();
    c.ok = false;
    const now = new Date();
    expect(await sendAlert(t.db, c.send, "f", "down", now)).toBe(false);
    c.ok = true;
    expect(await sendAlert(t.db, c.send, "f", "down", new Date(now.getTime() + MIN))).toBe(true);
    expect(c.sent).toEqual(["down"]);
    // A failed resolve keeps the alert active so the next run retries.
    c.ok = false;
    expect(await resolveAlert(t.db, c.send, "f", "up", now)).toBe(false);
    c.ok = true;
    expect(await resolveAlert(t.db, c.send, "f", "up", now)).toBe(true);
  });

  it("repeat: false sends once per activation", async () => {
    const c = fakeCliq();
    const t0 = new Date();
    await sendAlert(t.db, c.send, "once", "80%", t0, { repeat: false });
    await sendAlert(t.db, c.send, "once", "80%", new Date(t0.getTime() + 2 * REPEAT_MS), { repeat: false });
    expect(c.sent).toEqual(["80%"]);
  });
});

describe("cliqSender", () => {
  it("posts {text} and reports non-2xx without leaking the URL", async () => {
    const calls: { url: string; body: string }[] = [];
    const logs: string[] = [];
    const url = "https://cliq.zoho.in/api/v2/channelsbyname/alerts/message?zapikey=SECRET";
    const fake = (async (u: string, init: RequestInit) => {
      calls.push({ url: u, body: String(init.body) });
      return new Response(null, { status: calls.length === 1 ? 204 : 401 });
    }) as unknown as typeof fetch;
    const send = cliqSender(url, (m) => logs.push(m), fake);
    expect(await send("hi")).toBe(true);
    expect(await send("hi")).toBe(false);
    expect(JSON.parse(calls[0]!.body)).toEqual({ text: "hi" });
    expect(logs.join(" ")).toContain("401");
    expect(logs.join(" ")).not.toContain("SECRET");
  });
});

describe("checks", () => {
  it("worker silent > 10 min alerts, then resolves when it polls again", async () => {
    const c = fakeCliq();
    const now = new Date();
    await touchWorker(t.db, "old-worker", new Date(now.getTime() - 15 * MIN));
    await runChecks(t.db, disk(10), c.send, now);
    expect(c.sent.filter((m) => m.startsWith("Worker down"))).toHaveLength(1);

    // The claim endpoint records the poll.
    const res = await t.app.inject({ method: "POST", url: "/internal/jobs/claim", headers: t.workerHeaders, payload: { workerId: "w-new" } });
    expect(res.statusCode).toBe(200);
    await runChecks(t.db, disk(10), c.send, new Date());
    expect(c.sent.at(-1)).toMatch(/^Resolved: Worker/);
  });

  it("worker down for over a week keeps alerting (newest sighting is never pruned)", async () => {
    const c = fakeCliq();
    const now = new Date();
    await touchWorker(t.db, "dead-worker", new Date(now.getTime() - 15 * MIN));
    await runChecks(t.db, disk(10), c.send, now);
    const later = new Date(now.getTime() + 8 * 24 * HOUR);
    await runChecks(t.db, disk(10), c.send, later);
    await runChecks(t.db, disk(10), c.send, later);
    expect(await t.db.workerSeen.count()).toBe(1);
    expect(c.sent.some((m) => m.startsWith("Resolved: Worker"))).toBe(false);
  });

  it("disk probe with zero total bytes is ignored", async () => {
    const c = fakeCliq();
    const zero = { diskUsage: async () => ({ totalBytes: 0, freeBytes: 0 }) } as unknown as LocalStorage;
    await runChecks(t.db, disk(85), c.send);
    await runChecks(t.db, zero, c.send);
    expect(c.sent).toEqual([expect.stringMatching(/^Server disk 85% full/)]);
  });

  it("retried failures count toward the failure rate", async () => {
    const c = fakeCliq();
    const now = new Date();
    for (let i = 0; i < 9; i++) await finishedJob("DONE", new Date(now.getTime() - 10 * MIN));
    for (let i = 0; i < 3; i++) {
      const call = await newCall();
      await t.db.job.create({ data: { callId: call.id, status: "QUEUED", attempts: 1, runAfter: new Date(now.getTime() + HOUR), failedAttemptAt: new Date(now.getTime() - 5 * MIN) } });
    }
    await runChecks(t.db, disk(10), c.send, now);
    expect(c.sent).toEqual([expect.stringMatching(/^Job failures: 3 of 12/)]);
  });

  it("queue stall ignores translate jobs", async () => {
    const c = fakeCliq();
    const now = new Date();
    const call = await newCall();
    await t.db.job.create({ data: { callId: call.id, runAfter: new Date(now.getTime() - 3 * HOUR) } });
    // A finished translate job doesn't hide the stalled transcribe queue.
    await t.db.job.create({ data: { callId: call.id, kind: "translate", status: "DONE", finishedAt: new Date(now.getTime() - MIN) } });
    await runChecks(t.db, disk(10), c.send, now);
    expect(c.sent).toEqual([expect.stringMatching(/^Queue not moving: 1 transcription jobs/)]);
    await t.db.job.updateMany({ where: { callId: call.id }, data: { status: "DONE" } });

    // A translate-only stall doesn't fire.
    const c2 = fakeCliq();
    await t.db.alertState.deleteMany();
    await t.db.job.create({ data: { callId: call.id, kind: "translate", runAfter: new Date(now.getTime() - 3 * HOUR) } });
    await runChecks(t.db, disk(10), c2.send, now);
    expect(c2.sent).toEqual([]);
    await t.db.job.updateMany({ where: { callId: call.id }, data: { status: "DONE" } });
  });

  it("no worker ever seen does not alert", async () => {
    const c = fakeCliq();
    await runChecks(t.db, disk(10), c.send);
    expect(c.sent).toEqual([]);
  });

  it("disk above 80% alerts", async () => {
    const c = fakeCliq();
    await runChecks(t.db, disk(85), c.send);
    expect(c.sent).toEqual([expect.stringMatching(/^Server disk 85% full/)]);
    await runChecks(t.db, disk(50), c.send);
    expect(c.sent.at(-1)).toMatch(/^Resolved: Server disk/);
  });

  it("failure rate above 5% over the hour alerts, but needs a minimum sample", async () => {
    const c = fakeCliq();
    const now = new Date();
    await finishedJob("FAILED", new Date(now.getTime() - 5 * MIN));
    await runChecks(t.db, disk(10), c.send, now);
    expect(c.sent).toEqual([]); // 1 of 1 is too few to judge

    for (let i = 0; i < 10; i++) await finishedJob("DONE", new Date(now.getTime() - 10 * MIN));
    // Superseded translations aren't failures.
    await finishedJob("FAILED", new Date(now.getTime() - 5 * MIN), 1, "superseded by re-transcription");
    await runChecks(t.db, disk(10), c.send, now);
    expect(c.sent).toEqual([expect.stringMatching(/^Job failures: 1 of 11/)]);
  });

  it("queue stalled 2 h alerts; budget-deferred jobs don't count", async () => {
    const c = fakeCliq();
    const now = new Date();
    const call = await newCall();
    await t.db.job.create({ data: { callId: call.id, status: "WAITING_BUDGET", runAfter: new Date(now.getTime() - 3 * HOUR) } });
    await runChecks(t.db, disk(10), c.send, now);
    expect(c.sent).toEqual([]);

    await t.db.job.create({ data: { callId: call.id, runAfter: new Date(now.getTime() - 3 * HOUR) } });
    await runChecks(t.db, disk(10), c.send, now);
    expect(c.sent).toEqual([expect.stringMatching(/^Queue not moving/)]);

    await finishedJob("DONE", new Date(now.getTime() - MIN));
    await runChecks(t.db, disk(10), c.send, now);
    expect(c.sent.at(-1)).toMatch(/^Resolved: Queue/);
  });

  it("phones silent 48 h alert (revoked phones ignored)", async () => {
    const c = fakeCliq();
    const now = new Date();
    const old = new Date(now.getTime() - 50 * HOUR);
    await t.db.device.create({ data: { userId, installId: randomUUID(), model: "Redmi 9", lastSeenAt: old } });
    await t.db.device.create({ data: { userId, installId: randomUUID(), model: "Gone", lastSeenAt: old, revokedAt: now } });
    await runChecks(t.db, disk(10), c.send, now);
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toMatch(/^1 phone\(s\) not seen/);
    expect(c.sent[0]).toContain("Redmi 9");
    // A phone that registered 50 h ago and never checked in is flagged too.
    const nev = await t.db.device.create({ data: { userId, installId: randomUUID(), model: "Never", lastSeenAt: null } });
    await t.db.device.update({ where: { id: nev.id }, data: { createdAt: old } });
    await t.db.alertState.deleteMany();
    await runChecks(t.db, disk(10), c.send, now);
    expect(c.sent.at(-1)).toMatch(/^2 phone\(s\) not seen/);
    expect(c.sent.at(-1)).toContain("Never");
    await t.db.device.updateMany({ where: { userId }, data: { revokedAt: now } });
  });

  it("Fireflies hard stop and 80% budget alert", async () => {
    const c = fakeCliq();
    const now = new Date();
    const fireflies = { budgetMinutes: 100, blockedUntil: new Date(now.getTime() + HOUR).toISOString(), lastError: "quota" };
    await t.db.setting.upsert({ where: { id: 1 }, create: { id: 1, deviceConfig: {}, fireflies }, update: { fireflies } });
    const call = await newCall();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    await t.db.firefliesReservation.create({ data: { callId: call.id, month, minutes: 85, live: true, status: "COMMITTED" } });
    await runChecks(t.db, disk(10), c.send, now);
    expect(c.sent.some((m) => m.startsWith("Fireflies hard stop"))).toBe(true);
    expect(c.sent.some((m) => m.startsWith("Fireflies budget 85% used"))).toBe(true);
    expect(c.sent).toHaveLength(2); // 100% threshold not reached
  });
});

describe("Claude spend alert", () => {
  it("alerts at 80% and 100% of the cap once each, then resolves", async () => {
    const c = fakeCliq();
    const now = new Date();
    await t.db.setting.upsert({ where: { id: 1 }, create: { id: 1, deviceConfig: {}, costs: { translateBudgetUsd: 10 } }, update: { costs: { translateBudgetUsd: 10 } } });
    const call = await newCall();
    const job = await t.db.job.create({ data: { callId: call.id, kind: "translate", status: "DONE", costUsd: 8.5, costAt: now } });
    await runChecks(t.db, disk(10), c.send, now);
    expect(c.sent.filter((m) => m.startsWith("Claude translation spend 85%"))).toHaveLength(1);
    await runChecks(t.db, disk(10), c.send, new Date(now.getTime() + 7 * HOUR));
    expect(c.sent).toHaveLength(1); // repeat: false

    await t.db.job.update({ where: { id: job.id }, data: { costUsd: 10 } });
    await runChecks(t.db, disk(10), c.send, now);
    expect(c.sent.some((m) => m.includes("paused"))).toBe(true);

    await t.db.setting.update({ where: { id: 1 }, data: { costs: { translateBudgetUsd: 100 } } });
    await runChecks(t.db, disk(10), c.send, now);
    expect(c.sent.filter((m) => m.startsWith("Resolved:"))).toHaveLength(2);
  });
});

describe("metrics", () => {
  it("jobStats and backlog minutes", async () => {
    const now = new Date();
    await finishedJob("DONE", new Date(now.getTime() - 10 * MIN), 30);
    await finishedJob("DONE", new Date(now.getTime() - 10 * MIN), 90);
    await finishedJob("FAILED", new Date(now.getTime() - 10 * MIN));
    const s = await jobStats(t.db, HOUR, now);
    expect(s).toMatchObject({ done: 2, failed: 1, avgJobSeconds: 60 });
    expect(s.failureRatePct).toBeCloseTo(33.3);

    const before = await backlogMinutes(t.db);
    const a = await newCall(61); // 2 min
    const b = await newCall(null, 2000 * 150); // 150 s by size -> 3 min
    await t.db.job.create({ data: { callId: a.id } });
    await t.db.job.create({ data: { callId: b.id, status: "WAITING_BUDGET" } });
    const after = await backlogMinutes(t.db);
    expect(after.calls - before.calls).toBe(2);
    expect(after.minutes - before.minutes).toBe(5);
  });

  it("/api/stats includes throughput; test-alert needs the webhook", async () => {
    const s = await t.sessionFor(adminEmail);
    const stats = await t.app.inject({ method: "GET", url: "/api/stats", headers: s });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().throughput).toMatchObject({ jobsPerHour: expect.any(Number), backlogCalls: expect.any(Number) });
    expect(stats.json().alertsEnabled).toBe(false);
    const res = await t.app.inject({ method: "POST", url: "/api/admin/test-alert", headers: s, payload: {} });
    expect(res.statusCode).toBe(409);
  });
});
