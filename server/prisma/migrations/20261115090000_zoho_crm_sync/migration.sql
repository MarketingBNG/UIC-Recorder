-- Zoho CRM sync state per call.
ALTER TYPE "AuditAction" ADD VALUE 'CRM_SYNC';

ALTER TABLE "calls"
  ADD COLUMN "crm_status" TEXT,
  ADD COLUMN "crm_call_id" TEXT,
  ADD COLUMN "crm_note_id" TEXT,
  ADD COLUMN "crm_record_module" TEXT,
  ADD COLUMN "crm_record_id" TEXT,
  ADD COLUMN "crm_synced_at" TIMESTAMP(3),
  ADD COLUMN "crm_sync_error" TEXT,
  ADD COLUMN "crm_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "crm_queued_at" TIMESTAMP(3),
  ADD COLUMN "crm_next_attempt_at" TIMESTAMP(3);

CREATE INDEX "calls_crm_status_idx" ON "calls"("crm_status");
