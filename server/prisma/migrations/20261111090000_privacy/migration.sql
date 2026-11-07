-- Milestone 3: privacy and compliance. Hand-written; leaves the transcripts tsv column / GIN index
-- and the calls phone trigram index untouched.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SETTINGS_CHANGE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CLIENT_LIST_CHANGE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RETENTION_DELETE';

ALTER TABLE "settings" ADD COLUMN "privacy" JSONB;
ALTER TABLE "calls" ADD COLUMN "audio_deleted_at" TIMESTAMP(3);

CREATE INDEX "audit_log_action_created_at_idx" ON "audit_log" ("action", "created_at" DESC);

CREATE TABLE "client_numbers" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "client_numbers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "client_numbers_key_key" ON "client_numbers" ("key");
