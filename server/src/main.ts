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
import { startRetentionLoop } from "./privacy/retention.js";
import { CrmLoop, crmFromConfig, startCrmLoop } from "./crm/sync.js";
import { ZohoClient } from "./crm/zoho.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const storage = new LocalStorage(config.STORAGE_DIR);
await storage.init();

const oidc = config.GOOGLE_WEB_CLIENT_SECRET
  ? await DashboardOidc.create(config.GOOGLE_WEB_CLIENT_ID, config.GOOGLE_WEB_CLIENT_SECRET, config.PUBLIC_URL)
  : undefined;

const crm = config.ZOHO_REFRESH_TOKEN
  ? crmFromConfig(
      db,
      config,
      new ZohoClient({
        clientId: config.ZOHO_CLIENT_ID,
        clientSecret: config.ZOHO_CLIENT_SECRET,
        refreshToken: config.ZOHO_REFRESH_TOKEN,
        accountsUrl: config.ZOHO_ACCOUNTS_URL,
        apiUrl: config.ZOHO_API_URL,
      }),
    )
  : undefined;
// Errors are logged through app.log once the app exists.
let logCrmError: (err: unknown) => void = () => {};
const crmLoop = crm
  ? new CrmLoop(crm, {
      db,
      onError: (err) => logCrmError(err),
      alert: config.CLIQ_WEBHOOK_URL ? cliqSender(config.CLIQ_WEBHOOK_URL, (m) => logCrmError(m)) : undefined,
    })
  : undefined;

const app = await buildApp(
  {
    config,
    db,
    storage,
    tokens: new TokenService(db, config.JWT_SECRET, config.SESSION_SECRET),
    verifyGoogle: createGoogleVerifier(config.GOOGLE_WEB_CLIENT_ID),
    oidc,
    crm,
    crmLoop,
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

// Zoho CRM sync every minute (single instance); off when ZOHO_REFRESH_TOKEN is empty.
// Global Zoho failures back the loop off (5 to 60 min) and raise one Cliq alert. Only messages are logged.
logCrmError = (err) => app.log.error({ err: err instanceof Error ? err.message : err }, "zoho crm sync failed");
const crmRunner = crmLoop
  ? startCrmLoop(crmLoop)
  : (app.log.info("ZOHO_REFRESH_TOKEN not set: Zoho CRM sync disabled"), { stop: async () => {} });

// Daily audio retention; a no-op until an admin sets retentionMonths (default: keep forever).
const stopRetention = startRetentionLoop(
  db,
  storage,
  (err) => app.log.error({ err }, "retention run failed"),
  (r) => app.log.info(r, "retention: deleted old audio files"),
);

// Every 6 h, drop half-uploaded files no phone has continued for 3 days.
const sweepPartials = () =>
  storage.sweepPartials(3 * 86400_000).then(
    (n) => n > 0 && app.log.info({ removed: n }, "removed stale partial uploads"),
    (err: unknown) => app.log.error({ err }, "partial upload sweep failed"),
  );
void sweepPartials();
const partialTimer = setInterval(sweepPartials, 6 * 3600_000);
partialTimer.unref();

const shutdown = async () => {
  stopAlerts();
  stopRetention();
  clearInterval(partialTimer);
  // Let a running CRM pass finish (it releases its claimed calls), but don't hang shutdown on Zoho.
  await Promise.race([crmRunner.stop(), new Promise((r) => setTimeout(r, 10_000))]);
  await app.close();
  await db.$disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ host: "0.0.0.0", port: config.PORT });
