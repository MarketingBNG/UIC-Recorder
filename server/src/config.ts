import { z } from "zod";

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(8000),
  PUBLIC_URL: z.url().default("http://localhost:8000"),
  DATABASE_URL: z.string().min(1),
  STORAGE_DIR: z.string().default("./data/recordings"),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(200),

  // Google OAuth. The web client ID is also the audience of ID tokens sent by the app.
  GOOGLE_WEB_CLIENT_ID: z.string().min(1),
  GOOGLE_WEB_CLIENT_SECRET: z.string().default(""),
  // Optional Google Workspace domain; users from it are auto-provisioned as agents.
  ALLOWED_DOMAIN: z.string().optional().transform((v) => v?.trim().toLowerCase() || undefined),
  ADMIN_EMAILS: csv,

  // 32+ byte secrets, e.g. `openssl rand -base64 48`.
  JWT_SECRET: z.string().min(32),
  SESSION_SECRET: z.string().min(32),
  WORKER_TOKEN: z.string().min(32),
  // Optional: enables /internal/import/* for bulk-importing already-copied recordings.
  IMPORT_TOKEN: z.string().min(32).optional().or(z.literal("").transform(() => undefined)),

  DEFAULT_PHONE_REGION: z.string().length(2).default("IN"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
