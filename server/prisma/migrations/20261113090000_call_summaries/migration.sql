-- Milestone 5: AI call summaries (summarize job) + CSV export audit action.
-- Hand-written; leaves the transcripts tsv column / GIN index and the calls phone trigram index untouched.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXPORT';

ALTER TABLE "transcripts" ADD COLUMN "summary" TEXT;
ALTER TABLE "transcripts" ADD COLUMN "action_items" JSONB;
ALTER TABLE "transcripts" ADD COLUMN "sentiment" TEXT;
ALTER TABLE "transcripts" ADD COLUMN "tags" JSONB;
ALTER TABLE "transcripts" ADD COLUMN "speaker_roles" JSONB;
ALTER TABLE "transcripts" ADD COLUMN "summary_model" TEXT;
ALTER TABLE "transcripts" ADD COLUMN "summary_input_tokens" INTEGER;
ALTER TABLE "transcripts" ADD COLUMN "summary_output_tokens" INTEGER;
ALTER TABLE "transcripts" ADD COLUMN "summary_cost_usd" DOUBLE PRECISION;
ALTER TABLE "transcripts" ADD COLUMN "summarized_at" TIMESTAMP(3);
