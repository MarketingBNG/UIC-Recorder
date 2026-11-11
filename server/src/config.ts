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
  // Optional: enables POST /internal/app/publish, used by CI to publish a signed APK for the in-app updater.
  APP_PUBLISH_TOKEN: z.string().min(32).optional().or(z.literal("").transform(() => undefined)),

  // Optional Zoho Cliq channel incoming-webhook URL (includes its zapikey: a secret). Empty = alerts off.
  CLIQ_WEBHOOK_URL: z.url().optional().or(z.literal("").transform(() => undefined)),

  DEFAULT_PHONE_REGION: z.string().length(2).default("IN"),

  // Queue an English translation job after every transcript (worker needs ANTHROPIC_API_KEY to run them).
  TRANSLATE_ENABLED: z
    .enum(["true", "false", "1", "0", ""])
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),

  // Queue an AI summary job (Claude: summary, action items, sentiment, tags, speaker roles) after every
  // English translation, or after the transcript when TRANSLATE_ENABLED is off. Counts toward the Claude cap.
  // Off by default; the admin "Summarize calls" button queues summaries for existing transcripts either way.
  SUMMARIZE_ENABLED: z
    .enum(["true", "false", "1", "0", ""])
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  // Queue a compress job after transcription when the stored audio is above 40 kbps (worker needs ffmpeg).
  // Off by default: try the admin "Compress old recordings" button on a few calls first.
  COMPRESS_AFTER_TRANSCRIBE: z
    .enum(["true", "false", "1", "0", ""])
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  // Audio uploads (PUT /v1/calls/:id/audio) allowed per phone per hour; extra ones get 429 and retry later.
  UPLOAD_RATE_PER_HOUR: z.coerce.number().int().positive().default(600),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
