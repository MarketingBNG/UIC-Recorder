// Local development only: creates a user + device and prints an app access token,
// so the upload API can be exercised with curl without a phone or Google sign-in.
//   npx tsx scripts/dev-token.ts you@usaindiacfo.com
import { existsSync } from "node:fs";
import { TokenService } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();
if (config.NODE_ENV === "production") throw new Error("dev-token is disabled in production");

const email = (process.argv[2] ?? "dev@usaindiacfo.com").toLowerCase();
const db = createDb(config.DATABASE_URL);
const user = await db.user.upsert({ where: { email }, create: { email, role: "ADMIN" }, update: {} });
const device = await db.device.upsert({
  where: { userId_installId: { userId: user.id, installId: "dev-cli" } },
  create: { userId: user.id, installId: "dev-cli", model: "curl" },
  update: { revokedAt: null },
});
const tokens = await new TokenService(db, config.JWT_SECRET, config.SESSION_SECRET).issueForDevice(user.id, device.id);
console.log(tokens.accessToken);
await db.$disconnect();
