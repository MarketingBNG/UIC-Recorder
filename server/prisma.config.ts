import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Local dev reads server/.env; on Coolify the env vars are injected directly.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"] ?? "",
  },
});
