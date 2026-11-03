-- Extensions (hand-added)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MANAGER', 'AGENT');

-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('INCOMING', 'OUTGOING', 'MISSED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CallSource" AS ENUM ('LIVE', 'BACKLOG', 'IMPORT');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('PENDING_UPLOAD', 'UPLOADED', 'TRANSCRIBING', 'TRANSCRIBED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('PLAY', 'DOWNLOAD', 'SEARCH', 'DELETE', 'USER_CHANGE', 'DEVICE_REVOKE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "google_sub" TEXT,
    "name" TEXT,
    "picture_url" TEXT,
    "role" "Role" NOT NULL DEFAULT 'AGENT',
    "team" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "excluded_numbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "install_id" TEXT NOT NULL,
    "model" TEXT,
    "android_version" TEXT,
    "app_version" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "last_sync_at" TIMESTAMP(3),
    "pending_count" INTEGER NOT NULL DEFAULT 0,
    "permissions_ok" BOOLEAN NOT NULL DEFAULT false,
    "free_bytes" BIGINT,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "replaced_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "phone_e164" TEXT,
    "phone_raw" TEXT,
    "contact_name" TEXT,
    "direction" "CallDirection" NOT NULL DEFAULT 'UNKNOWN',
    "source" "CallSource" NOT NULL DEFAULT 'LIVE',
    "started_at" TIMESTAMP(3) NOT NULL,
    "duration_s" INTEGER,
    "original_name" TEXT,
    "original_sha256" TEXT NOT NULL,
    "upload_sha256" TEXT,
    "mime_type" TEXT,
    "file_path" TEXT,
    "file_size" BIGINT,
    "status" "CallStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "uploaded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcripts" (
    "call_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "language" TEXT,
    "provider" TEXT NOT NULL,
    "segments" JSONB,
    "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "text")) STORED,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("call_id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "call_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'transcribe',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "run_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "action" "AuditAction" NOT NULL,
    "call_id" UUID,
    "detail" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "device_config" JSONB NOT NULL,
    "latest_app" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub");

-- CreateIndex
CREATE UNIQUE INDEX "devices_user_id_install_id_key" ON "devices"("user_id", "install_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_device_id_idx" ON "refresh_tokens"("device_id");

-- CreateIndex
CREATE INDEX "calls_user_id_started_at_idx" ON "calls"("user_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "calls_started_at_idx" ON "calls"("started_at" DESC);

-- CreateIndex
CREATE INDEX "calls_phone_e164_trgm_idx" ON "calls" USING GIN ("phone_e164" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "calls_user_id_original_sha256_key" ON "calls"("user_id", "original_sha256");

-- CreateIndex
CREATE INDEX "jobs_status_priority_created_at_idx" ON "jobs"("status", "priority" DESC, "created_at");

-- CreateIndex
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Full-text search index (hand-added)
CREATE INDEX "transcripts_tsv_idx" ON "transcripts" USING GIN ("tsv");
