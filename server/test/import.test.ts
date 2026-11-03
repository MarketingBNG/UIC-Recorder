import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRecordingName } from "../src/calls/filename.js";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

const IST = 330;

describe("parseRecordingName", () => {
  it("parses Samsung names", () => {
    const p = parseRecordingName("Call recording Ravi Kumar_231015_143022.m4a", IST);
    expect(p.contactName).toBe("Ravi Kumar");
    expect(p.startedAt?.toISOString()).toBe("2023-10-15T09:00:22.000Z");
    expect(p.phone).toBeUndefined();
  });
  it("parses MIUI names with number in brackets", () => {
    const p = parseRecordingName("Ravi Kumar(9876543210)_20231015143022.mp3", IST);
    expect(p).toMatchObject({ phone: "9876543210", contactName: "Ravi Kumar" });
    expect(p.startedAt?.toISOString()).toBe("2023-10-15T09:00:22.000Z");
  });
  it("parses number + separated date", () => {
    const p = parseRecordingName("+919876543210_2023-10-15_14-30-22.amr", IST);
    expect(p.phone).toBe("+919876543210");
    expect(p.contactName).toBeUndefined();
    expect(p.startedAt?.toISOString()).toBe("2023-10-15T09:00:22.000Z");
  });
  it("does not mistake a phone number for a date", () => {
    const p = parseRecordingName("12025550123.m4a", IST);
    expect(p.startedAt).toBeUndefined();
    expect(p.phone).toBe("12025550123");
  });
  it("reads direction hints", () => {
    expect(parseRecordingName("incoming_9876543210_20231015143022.m4a", IST).direction).toBe("INCOMING");
  });
});

describe("import endpoints", () => {
  const IMPORT_TOKEN = "i".repeat(40);
  let t: Awaited<ReturnType<typeof setupTestApp>>;
  const h = { authorization: `Bearer ${IMPORT_TOKEN}` };
  beforeAll(async () => {
    t = await setupTestApp({ IMPORT_TOKEN, ALLOWED_DOMAIN: "usaindiacfo.com" });
  });
  afterAll(async () => {
    await t.app.close();
    await t.db.$disconnect();
  });

  it("imports for a domain user, queues a low-priority job, and dedups", async () => {
    const email = uniqueEmail("imp");
    const audio = randomBytes(300);
    const hash = sha256(audio);
    const meta = { email, originalSha256: hash, startedAt: "2023-10-15T09:00:22.000Z", phoneNumber: "9876543210" };

    const reg = await t.app.inject({ method: "POST", url: "/internal/import/calls", headers: h, payload: meta });
    expect(reg.statusCode).toBe(201);
    const { callId } = reg.json();
    const put = await t.app.inject({
      method: "PUT",
      url: `/internal/import/calls/${callId}/audio`,
      headers: { ...h, "content-type": "audio/mp4", "x-content-sha256": hash },
      payload: audio,
    });
    expect(put.statusCode).toBe(201);

    const call = await t.db.call.findUniqueOrThrow({ where: { id: callId }, include: { jobs: true, user: true } });
    expect(call).toMatchObject({ source: "IMPORT", status: "UPLOADED", phoneE164: "+919876543210" });
    expect(call.user.role).toBe("AGENT");
    expect(call.jobs[0]!.priority).toBe(0);

    const check = await t.app.inject({ method: "POST", url: "/internal/import/check", headers: h, payload: { email, hashes: [hash] } });
    expect(check.json().known).toEqual([hash]);
  });

  it("rejects bad tokens and outside-domain unknown users", async () => {
    const bad = await t.app.inject({ method: "POST", url: "/internal/import/check", headers: { authorization: "Bearer x" }, payload: {} });
    expect(bad.statusCode).toBe(401);
    const outsider = await t.app.inject({
      method: "POST",
      url: "/internal/import/calls",
      headers: h,
      payload: { email: "someone@gmail.com", originalSha256: sha256("o"), startedAt: "2023-10-15T09:00:22.000Z" },
    });
    expect(outsider.statusCode).toBe(404);
  });

  it("can't upload into a phone (non-import) call", async () => {
    const s = await t.loginDevice(uniqueEmail());
    const created = await t.app.inject({
      method: "POST",
      url: "/v1/calls",
      headers: s.headers,
      payload: { originalSha256: sha256("phone"), startedAt: "2023-10-15T09:00:22.000Z" },
    });
    const put = await t.app.inject({
      method: "PUT",
      url: `/internal/import/calls/${created.json().callId}/audio`,
      headers: { ...h, "content-type": "audio/mp4", "x-content-sha256": sha256("a") },
      payload: "a",
    });
    expect(put.statusCode).toBe(404);
  });

  it("live phone calls are claimed before imported backlog", async () => {
    // Drain jobs left by earlier tests so only this test's jobs are queued.
    while ((await t.app.inject({ method: "POST", url: "/internal/jobs/claim", headers: t.workerHeaders, payload: { workerId: "drain", limit: 20 } })).json().jobs.length) {}
    const email = uniqueEmail("prio");
    for (let i = 0; i < 3; i++) {
      const audio = randomBytes(50);
      const reg = await t.app.inject({
        method: "POST",
        url: "/internal/import/calls",
        headers: h,
        payload: { email, originalSha256: sha256(audio), startedAt: "2023-10-15T09:00:22.000Z" },
      });
      await t.app.inject({
        method: "PUT",
        url: `/internal/import/calls/${reg.json().callId}/audio`,
        headers: { ...h, "content-type": "audio/mp4", "x-content-sha256": sha256(audio) },
        payload: audio,
      });
    }
    const s = await t.loginDevice(uniqueEmail());
    const audio = randomBytes(50);
    const live = await t.app.inject({
      method: "POST",
      url: "/v1/calls",
      headers: s.headers,
      payload: { originalSha256: sha256(audio), startedAt: "2026-11-03T10:00:00Z" },
    });
    await t.app.inject({
      method: "PUT",
      url: `/v1/calls/${live.json().callId}/audio`,
      headers: { ...s.headers, "content-type": "audio/mp4", "x-content-sha256": sha256(audio) },
      payload: audio,
    });
    const claimed = await t.app.inject({ method: "POST", url: "/internal/jobs/claim", headers: t.workerHeaders, payload: { workerId: "p", limit: 1 } });
    expect(claimed.json().jobs[0].callId).toBe(live.json().callId);
  });
});
