import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { requireDevice } from "../auth/guards.js";
import { HttpError, currentDevice, currentUser, type Deps } from "../context.js";
import { hashKey } from "../privacy/clientNumbers.js";
import { getSettings } from "../settings.js";

const Heartbeat = z.object({
  appVersion: z.string().max(40).optional(),
  pendingCount: z.number().int().min(0).max(10_000_000),
  permissionsOk: z.boolean(),
  freeBytes: z.number().int().min(0).optional(),
  lastSyncAt: z.iso.datetime().optional(),
});

export async function deviceRoutes(app: FastifyInstance, deps: Deps) {
  const auth = { preHandler: requireDevice(deps) };

  app.get("/v1/device/config", auth, async (req) => {
    const user = currentUser(req);
    const { deviceConfig } = await getSettings(deps.db);
    return { ...deviceConfig, excludedNumbers: user.excludedNumbers };
  });

  /**
   * Business-only mode: sha256 of each client-list number key (last 10 digits), never the numbers themselves.
   * The phone uploads a call to a saved personal contact only when its number's hash is in this list.
   */
  app.get("/v1/device/client-numbers", auth, async () => {
    const rows = await deps.db.clientNumber.findMany({ select: { key: true }, orderBy: { key: "asc" } });
    return { hashes: rows.map((r) => hashKey(r.key)) };
  });

  app.post("/v1/device/heartbeat", auth, async (req, reply) => {
    const body = Heartbeat.parse(req.body);
    await deps.db.device.update({
      where: { id: currentDevice(req).id },
      data: {
        appVersion: body.appVersion ?? undefined,
        pendingCount: body.pendingCount,
        permissionsOk: body.permissionsOk,
        freeBytes: body.freeBytes !== undefined ? BigInt(body.freeBytes) : undefined,
        lastSyncAt: body.lastSyncAt ? new Date(body.lastSyncAt) : undefined,
        lastSeenAt: new Date(),
      },
    });
    return reply.code(204).send();
  });

  app.get("/v1/app/latest", auth, async () => {
    const { latestApp } = await getSettings(deps.db);
    if (!latestApp) return { available: false };
    return { available: true, ...latestApp, downloadPath: "/v1/app/download" };
  });

  app.get("/v1/app/download", auth, async (_req, reply) => {
    const { latestApp } = await getSettings(deps.db);
    if (!latestApp) throw new HttpError(404, "No app published");
    // Inside the mounted storage dir so it survives redeploys.
    const file = path.join(deps.storage.root, "apk", latestApp.fileName);
    reply.header("content-type", "application/vnd.android.package-archive");
    reply.header("content-disposition", `attachment; filename="${latestApp.fileName}"`);
    return reply.send(createReadStream(file));
  });
}
