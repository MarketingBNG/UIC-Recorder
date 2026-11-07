import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashKey, numberKey, parseClientCsv } from "../src/privacy/clientNumbers.js";
import { retentionCutoff, runRetention } from "../src/privacy/retention.js";
import { DEFAULT_PRIVACY_SETTINGS, getPrivacySettings, savePrivacySettings } from "../src/privacy/settings.js";
import { WindowLimiter } from "../src/privacy/uploadLimit.js";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let adminEmail: string;
let userId: string;

beforeAll(async () => {
  t = await setupTestApp({ UPLOAD_RATE_PER_HOUR: "3" });
  adminEmail = uniqueEmail("privadmin");
  await t.db.user.create({ data: { email: adminEmail, role: "ADMIN" } });
  userId = (await t.db.user.create({ data: { email: uniqueEmail("priv") } })).id;
});
afterAll(async () => {
  await savePrivacySettings(t.db, DEFAULT_PRIVACY_SETTINGS);
  await t.app.close();
  await t.db.$disconnect();
});

const asAdmin = async () => t.sessionFor(adminEmail);

describe("client number keys", () => {
  // Shared test vector with the app's PrivacyFilterTest: change both together.
  it("matches the app's key + hash rule", () => {
    expect(numberKey("+91 98765 43210")).toBe("9876543210");
    expect(numberKey("098765-43210")).toBe("9876543210");
    expect(numberKey("12345")).toBe("12345");
    expect(hashKey(numberKey("+91 98765 43210"))).toBe("7619ee8cea49187f309616e30ecf54be072259b43760f1f550a644945d5572f2");
  });

  it("parses CSV with labels, quotes, duplicates and a header row", () => {
    const { rows, rejected } = parseClientCsv('phone,name\n"+91 98765 43210","Acme, Ltd"\n9876543210\n\n022 2345 6789;Office\n123');
    expect(rows).toEqual([
      { raw: "+91 98765 43210", key: "9876543210", label: "Acme, Ltd" },
      { raw: "022 2345 6789", key: "2223456789", label: "Office" },
    ]);
    expect(rejected).toEqual(["phone,name", "123"]);
  });
});

describe("client list API", () => {
  it("adds, imports, lists, rejects duplicates and serves hashes to phones", async () => {
    const h = await asAdmin();
    const add = await t.app.inject({ method: "POST", url: "/api/client-numbers", headers: h, payload: { number: "+91 90000 11111", label: "Client A" } });
    expect(add.statusCode).toBe(201);
    const dup = await t.app.inject({ method: "POST", url: "/api/client-numbers", headers: h, payload: { number: "09000011111" } });
    expect(dup.statusCode).toBe(409);
    const bad = await t.app.inject({ method: "POST", url: "/api/client-numbers", headers: h, payload: { number: "12" } });
    expect(bad.statusCode).toBe(400);

    const imp = await t.app.inject({
      method: "POST",
      url: "/api/client-numbers/import",
      headers: h,
      payload: { csv: "number,label\n+91 90000 22222,B\n9000011111,Renamed\n" },
    });
    expect(imp.json()).toMatchObject({ added: 1, updated: 1, rejected: 1 });

    const list = await t.app.inject({ method: "GET", url: "/api/client-numbers", headers: h });
    const items = list.json().items as { raw: string; label: string }[];
    expect(items.find((i) => i.raw === "+91 90000 11111")?.label).toBe("Renamed");

    const phone = await t.loginDevice(uniqueEmail("cn"));
    const hashes = (await t.app.inject({ method: "GET", url: "/v1/device/client-numbers", headers: phone.headers })).json().hashes;
    expect(hashes).toContain(hashKey("9000011111"));
    expect(hashes).toContain(hashKey("9000022222"));
    expect(JSON.stringify(hashes)).not.toContain("9000011111");

    const id = (list.json().items as { id: string; raw: string }[]).find((i) => i.raw === "+91 90000 22222")!.id;
    expect((await t.app.inject({ method: "DELETE", url: `/api/client-numbers/${id}`, headers: h })).statusCode).toBe(204);
    const audit = await t.db.auditLog.count({ where: { action: "CLIENT_LIST_CHANGE" } });
    expect(audit).toBeGreaterThanOrEqual(3);
  });

  it("is admin only", async () => {
    const email = uniqueEmail("mgr");
    await t.db.user.create({ data: { email, role: "MANAGER" } });
    const res = await t.app.inject({ method: "GET", url: "/api/client-numbers", headers: await t.sessionFor(email) });
    expect(res.statusCode).toBe(403);
  });
});

describe("privacy settings", () => {
  it("default to keep forever and no masking, and changes are audited", async () => {
    await savePrivacySettings(t.db, DEFAULT_PRIVACY_SETTINGS);
    const h = await asAdmin();
    expect((await t.app.inject({ method: "GET", url: "/api/settings/privacy", headers: h })).json()).toEqual({ retentionMonths: null, maskPii: false });
    const put = await t.app.inject({ method: "PUT", url: "/api/settings/privacy", headers: h, payload: { maskPii: true } });
    expect(put.json()).toEqual({ retentionMonths: null, maskPii: true });
    expect(await t.db.auditLog.count({ where: { action: "SETTINGS_CHANGE" } })).toBeGreaterThan(0);
    const bad = await t.app.inject({ method: "PUT", url: "/api/settings/privacy", headers: h, payload: { retentionMonths: 0 } });
    expect(bad.statusCode).toBe(400);
    await savePrivacySettings(t.db, DEFAULT_PRIVACY_SETTINGS);
  });

  it("sends maskPii to the worker with each claimed job", async () => {
    await t.db.job.updateMany({ where: { status: { in: ["QUEUED", "RUNNING", "WAITING_BUDGET"] } }, data: { status: "DONE" } });
    const call = await t.db.call.create({ data: { userId, startedAt: new Date(), originalSha256: randomUUID(), status: "UPLOADED" } });
    await t.db.job.create({ data: { callId: call.id } });
    await savePrivacySettings(t.db, { retentionMonths: null, maskPii: true });
    const res = await t.app.inject({ method: "POST", url: "/internal/jobs/claim", headers: t.workerHeaders, payload: { workerId: "pii" } });
    expect(res.json().jobs[0]).toMatchObject({ callId: call.id, maskPii: true });
    await savePrivacySettings(t.db, DEFAULT_PRIVACY_SETTINGS);
  });
});

describe("retention", () => {
  const root = () => t.storage.root;
  async function storedCall(startedAt: Date, status: "TRANSCRIBED" | "UPLOADED" = "TRANSCRIBED") {
    const id = randomUUID();
    const audio = randomBytes(1000);
    const rel = `${userId}/old/${id}.m4a`;
    await mkdir(path.join(root(), path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root(), rel), audio);
    const call = await t.db.call.create({
      data: { id, userId, startedAt, originalSha256: sha256(audio), status, filePath: rel, fileSize: 1000n, mimeType: "audio/mp4" },
    });
    await t.db.transcript.create({ data: { callId: id, text: "hello", provider: "stub" } }).catch(() => {});
    return { call, rel };
  }

  beforeEach(async () => {
    await t.db.job.updateMany({ where: { status: { in: ["QUEUED", "RUNNING", "WAITING_BUDGET"] } }, data: { status: "DONE" } });
  });

  it("computes calendar-month cutoffs", () => {
    expect(retentionCutoff(new Date("2026-03-31T10:00:00Z"), 1).toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(retentionCutoff(new Date("2026-11-07T00:00:00Z"), 12).toISOString()).toBe("2025-11-07T00:00:00.000Z");
  });

  it("does nothing while retention is off (the default)", async () => {
    await savePrivacySettings(t.db, DEFAULT_PRIVACY_SETTINGS);
    const { call, rel } = await storedCall(new Date("2000-01-01T00:00:00Z"));
    expect(await runRetention(t.db, t.storage)).toBeNull();
    expect(existsSync(path.join(root(), rel))).toBe(true);
    expect((await t.db.call.findUniqueOrThrow({ where: { id: call.id } })).filePath).toBe(rel);
  });

  it("deletes old audio, keeps transcripts, skips new calls and calls with open jobs, and audits", async () => {
    const now = new Date("2026-11-07T00:00:00Z");
    const old = await storedCall(new Date("2026-01-01T00:00:00Z"));
    const recent = await storedCall(new Date("2026-10-01T00:00:00Z"));
    const busy = await storedCall(new Date("2026-01-01T00:00:00Z"));
    const notDone = await storedCall(new Date("2026-01-01T00:00:00Z"), "UPLOADED");
    await t.db.job.create({ data: { callId: busy.call.id, kind: "compress", status: "RUNNING" } });
    await savePrivacySettings(t.db, { retentionMonths: 6, maskPii: false });

    const r = await runRetention(t.db, t.storage, now);
    expect(r!.deleted).toBeGreaterThanOrEqual(1);

    expect(existsSync(path.join(root(), old.rel))).toBe(false);
    const after = await t.db.call.findUniqueOrThrow({ where: { id: old.call.id }, include: { transcript: true } });
    expect(after.filePath).toBeNull();
    expect(after.audioDeletedAt).not.toBeNull();
    expect(after.transcript?.text).toBe("hello");
    for (const kept of [recent, busy, notDone]) expect(existsSync(path.join(root(), kept.rel))).toBe(true);
    expect(await t.db.auditLog.count({ where: { action: "RETENTION_DELETE" } })).toBeGreaterThan(0);

    const h = await asAdmin();
    expect((await t.app.inject({ method: "GET", url: `/api/calls/${old.call.id}/audio`, headers: h })).statusCode).toBe(404);
    await savePrivacySettings(t.db, DEFAULT_PRIVACY_SETTINGS);
  });
});

describe("audit", () => {
  it("logs DOWNLOAD for ?download=1 and lists the audit log for admins", async () => {
    const audio = randomBytes(500);
    const id = randomUUID();
    const rel = `${userId}/dl/${id}.m4a`;
    await mkdir(path.join(t.storage.root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(t.storage.root, rel), audio);
    await t.db.call.create({ data: { id, userId, startedAt: new Date(), originalSha256: sha256(audio), status: "TRANSCRIBED", filePath: rel, fileSize: 500n, mimeType: "audio/mp4" } });
    const h = await asAdmin();
    const res = await t.app.inject({ method: "GET", url: `/api/calls/${id}/audio?download=1`, headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="call-${id}.m4a"`);
    await new Promise((r) => setTimeout(r, 50)); // audit write is fire-and-forget
    const log = await t.app.inject({ method: "GET", url: "/api/audit?action=DOWNLOAD", headers: h });
    const items = log.json().items as { action: string; callId: string; user: { email: string } }[];
    expect(items.some((i) => i.callId === id && i.user.email === adminEmail)).toBe(true);
    expect(items.every((i) => i.action === "DOWNLOAD")).toBe(true);

    const agent = await t.loginDevice(uniqueEmail("auditagent"));
    expect((await t.app.inject({ method: "GET", url: "/api/audit", headers: agent.headers })).statusCode).toBe(403);
  });

  it("pages with a cursor", async () => {
    const h = await asAdmin();
    const first = (await t.app.inject({ method: "GET", url: "/api/audit?limit=1", headers: h })).json();
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = (await t.app.inject({ method: "GET", url: `/api/audit?limit=1&cursor=${first.nextCursor}`, headers: h })).json();
    expect(second.items[0].id).not.toBe(first.items[0].id);
  });
});

describe("upload rate limit", () => {
  it("counts per key and resets after the window", () => {
    let now = 0;
    const l = new WindowLimiter(2, 1000, () => now);
    expect(l.take("a")).toBe(0);
    expect(l.take("a")).toBe(0);
    expect(l.take("a")).toBe(1);
    expect(l.take("b")).toBe(0);
    now = 1000;
    expect(l.take("a")).toBe(0);
  });

  it("answers 429 with Retry-After once a phone exceeds UPLOAD_RATE_PER_HOUR", async () => {
    const phone = await t.loginDevice(uniqueEmail("rl"));
    const codes: number[] = [];
    let last;
    for (let i = 0; i < 4; i++) {
      last = await t.app.inject({
        method: "PUT",
        url: `/v1/calls/${randomUUID()}/audio`,
        headers: { ...phone.headers, "content-type": "audio/mp4", "x-content-sha256": "a".repeat(64) },
        payload: Buffer.from("x"),
      });
      codes.push(last.statusCode);
    }
    expect(codes.slice(0, 3)).toEqual([404, 404, 404]);
    expect(codes[3]).toBe(429);
    expect(Number(last!.headers["retry-after"])).toBeGreaterThan(0);
  });
});
