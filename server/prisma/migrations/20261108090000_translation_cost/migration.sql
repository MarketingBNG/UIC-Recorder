-- Milestone 2: Claude translation cost tracking + monthly cap settings.
-- Hand-written; leaves the transcripts tsv column / GIN index and the trigram index untouched.
ALTER TABLE "transcripts" ADD COLUMN "translation_input_tokens" INTEGER;
ALTER TABLE "transcripts" ADD COLUMN "translation_output_tokens" INTEGER;
ALTER TABLE "transcripts" ADD COLUMN "translation_cost_usd" DOUBLE PRECISION;
ALTER TABLE "jobs" ADD COLUMN "cost_usd" DOUBLE PRECISION;
ALTER TABLE "settings" ADD COLUMN "costs" JSONB;
ALTER TABLE "jobs" ADD COLUMN "cost_at" TIMESTAMP(3);
CREATE INDEX "jobs_cost_at_idx" ON "jobs" ("cost_at");
