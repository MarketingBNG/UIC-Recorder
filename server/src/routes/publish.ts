import type { FastifyInstance, FastifyRequest } from "fastify";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { safeEqual } from "../auth/tokens.js";
import { HttpError, type Deps } from "../context.js";
import { LatestApp, getSettings } from "../settings.js";
import { DEFAULT_DEVICE_CONFIG } from "../settings.js";
import { UploadTooLargeError } from "../storage/local.js";

const APK_MIME = "application/vnd.android.package-archive";
const MAX_APK_BYTES = 200 * 1024 * 1024;
const Meta = z.object({
  versionCode: z.coerce.number().int().positive(),
  versionName: z.string().trim().min(1).max(40),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/**
 * CI publishes a signed release APK here (POST body = the APK); phones see it via /v1/app/latest and show the
 * update banner. Disabled unless APP_PUBLISH_TOKEN is set. Only a higher versionCode replaces the current one.
 */
export async function publishRoutes(app: FastifyInstance, deps: Deps) {
  const token = deps.config.APP_PUBLISH_TOKEN;
  if (!token) return;

  const guard = async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ") || !safeEqual(h.slice(7), token)) throw new HttpError(401, "Bad publish token");
  };
  app.addContentTypeParser(APK_MIME, (_req, _payload, done) => done(null));

  app.post("/internal/app/publish", { preHandler: guard, config: { rateLimit: false as const } }, async (req, reply) => {
    if (req.headers["content-type"]?.split(";")[0]?.trim() !== APK_MIME) throw new HttpError(415, `Send the APK as ${APK_MIME}`);
    const meta = Meta.parse({
      versionCode: req.headers["x-version-code"],
      versionName: req.headers["x-version-name"],
      sha256: req.headers["x-content-sha256"],
    });
    const { latestApp: current } = await getSettings(deps.db);
    if (current && meta.versionCode <= current.versionCode) {
      // Re-running the same CI job is fine; an older build never replaces a newer one.
      if (meta.versionCode === current.versionCode && meta.sha256 === current.sha256) return { published: false, current };
      throw new HttpError(409, `Server already has versionCode ${current.versionCode}; bump it`);
    }

    const fileName = `uic-recorder-${meta.versionCode}.apk`;
    let saved;
    try {
      saved = await deps.storage.save(req.raw, `apk/${fileName}`, MAX_APK_BYTES);
    } catch (e) {
      if (e instanceof UploadTooLargeError) throw new HttpError(413, "APK too large");
      throw e;
    }
    if (saved.sha256 !== meta.sha256) {
      await deps.storage.remove(`apk/${fileName}`);
      throw new HttpError(422, "Checksum mismatch");
    }

    const latestApp: LatestApp = { versionCode: meta.versionCode, versionName: meta.versionName, sha256: meta.sha256, fileName };
    await deps.db.setting.upsert({
      where: { id: 1 },
      create: { id: 1, deviceConfig: DEFAULT_DEVICE_CONFIG, latestApp },
      update: { latestApp },
    });
    // Keep the new APK and the one before it (a phone may be mid-download); drop older ones.
    const dir = path.join(deps.storage.root, "apk");
    const keep = new Set([fileName, current?.fileName].filter(Boolean));
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (name.endsWith(".apk") && !keep.has(name)) await rm(path.join(dir, name), { force: true });
    }
    req.log.info({ versionCode: meta.versionCode, versionName: meta.versionName }, "app published");
    return reply.code(201).send({ published: true, current: latestApp });
  });
}
