import { existsSync } from "node:fs";
import { cliqSender } from "./alerts/cliq.js";
import { startAlertLoop } from "./alerts/checks.js";
import { buildApp } from "./app.js";
import { createGoogleVerifier } from "./auth/google.js";
import { DashboardOidc } from "./auth/oidc.js";
import { TokenService } from "./auth/tokens.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { LocalStorage } from "./storage/local.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const storage = new LocalStorage(config.STORAGE_DIR);
await storage.init();

const oidc = config.GOOGLE_WEB_CLIENT_SECRET
  ? await DashboardOidc.create(config.GOOGLE_WEB_CLIENT_ID, config.GOOGLE_WEB_CLIENT_SECRET, config.PUBLIC_URL)
  : undefined;

const app = await buildApp(
  {
    config,
    db,
    storage,
    tokens: new TokenService(db, config.JWT_SECRET, config.SESSION_SECRET),
    verifyGoogle: createGoogleVerifier(config.GOOGLE_WEB_CLIENT_ID),
    oidc,
  },
  {
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
  },
);

if (!oidc) app.log.warn("GOOGLE_WEB_CLIENT_SECRET not set: dashboard sign-in disabled");

// Zoho Cliq alerts every 5 minutes; off when CLIQ_WEBHOOK_URL is empty.
const stopAlerts = config.CLIQ_WEBHOOK_URL
  ? startAlertLoop(db, storage, cliqSender(config.CLIQ_WEBHOOK_URL, (m) => app.log.warn(m)), (err) =>
      app.log.error({ err }, "alert checks failed"),
    )
  : (app.log.warn("CLIQ_WEBHOOK_URL not set: alerts disabled"), () => {});

const shutdown = async () => {
  stopAlerts();
  await app.close();
  await db.$disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ host: "0.0.0.0", port: config.PORT });
