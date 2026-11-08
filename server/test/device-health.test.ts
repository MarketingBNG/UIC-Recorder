import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateChecks } from "../src/alerts/checks.js";
import { bucketName, callsWithoutRecordings, isThrottled } from "../src/devices/health.js";
import type { LocalStorage } from "../src/storage/local.js";
import { setupTestApp, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
const disk = { diskUsage: async () => ({ totalBytes: 100, freeBytes: 90 }) } as unknown as LocalStorage;

beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

describe("device health flags", () => {
  it("bucket names and flags", () => {
    expect(bucketName(10)).toBe("WORKING_SET");
    expect(bucketName(30)).toBe("RARE");
    expect(bucketName(45)).toBe("RESTRICTED");
    expect(bucketName(null)).toBeNull();
    expect(isThrottled({ standbyBucket: 20, calls7d: null, recordings7d: null })).toBe(false);
    expect(isThrottled({ standbyBucket: 30, calls7d: null, recordings7d: null })).toBe(true);
    expect(callsWithoutRecordings({ standbyBucket: null, calls7d: 6, recordings7d: 0 })).toBe(true);
    expect(callsWithoutRecordings({ standbyBucket: null, calls7d: 5, recordings7d: 0 })).toBe(false);
    expect(callsWithoutRecordings({ standbyBucket: null, calls7d: 9, recordings7d: 1 })).toBe(false);
    expect(callsWithoutRecordings({ standbyBucket: null, calls7d: 9, recordings7d: null })).toBe(false);
  });

  it("heartbeat stores the new fields; /api/devices flags them; alert fires", async () => {
    const email = uniqueEmail("hb");
    const phone = await t.loginDevice(email);
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/device/heartbeat",
      headers: phone.headers,
      payload: {
        pendingCount: 0,
        permissionsOk: true,
        standbyBucket: 40,
        lastStopReason: 9,
        calls7d: 12,
        recordings7d: 0,
        autostartIntent: "com.miui.securitycenter/com.miui.permcenter.autostart.AutoStartManagementActivity",
        defaultDialer: "com.google.android.dialer",
      },
    });
    expect(res.statusCode).toBe(204);
    // Older apps without the fields still work.
    const old = await t.app.inject({ method: "POST", url: "/v1/device/heartbeat", headers: phone.headers, payload: { pendingCount: 1, permissionsOk: true } });
    expect(old.statusCode).toBe(204);

    const admin = uniqueEmail("hbadmin");
    await t.db.user.create({ data: { email: admin, role: "ADMIN" } });
    const list = await t.app.inject({ method: "GET", url: "/api/devices", headers: await t.sessionFor(admin) });
    const d = list.json().find((x: { user: { email: string } }) => x.user.email === email);
    expect(d).toMatchObject({
      standbyBucket: 40,
      standbyBucketName: "RESTRICTED",
      throttled: true,
      callsWithoutRecordings: true,
      lastStopReason: 9,
      defaultDialer: "com.google.android.dialer",
    });

    const checks = await evaluateChecks(t.db, disk);
    const c = checks.find((x) => x.key === "calls-no-recordings");
    expect(c?.firing).toBe(true);
    expect(c?.text).toContain(email);
    await t.db.device.updateMany({ where: { user: { email } }, data: { recordings7d: 3 } });
    const after = (await evaluateChecks(t.db, disk)).find((x) => x.key === "calls-no-recordings");
    expect(after?.text).not.toContain(email);
  });
});
