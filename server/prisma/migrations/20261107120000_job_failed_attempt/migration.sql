-- Milestone 1 fix: record every failed job attempt (not only the final one) for the failure-rate alert.
-- Hand-written; leaves the transcripts tsv column / GIN index and the trigram index untouched.
ALTER TABLE "jobs" ADD COLUMN "failed_attempt_at" TIMESTAMP(3);
CREATE INDEX "jobs_failed_attempt_at_idx" ON "jobs" ("failed_attempt_at");
-- Existing final failures count as failed attempts.
UPDATE "jobs" SET "failed_attempt_at" = "finished_at" WHERE "status" = 'FAILED' AND "finished_at" IS NOT NULL;
