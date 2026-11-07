-- Milestone 2b: compress old recordings. Hand-written; leaves the transcripts tsv column / GIN index
-- and the trigram index untouched.
ALTER TABLE "calls" ADD COLUMN "compressed_at" TIMESTAMP(3);
ALTER TABLE "calls" ADD COLUMN "bytes_saved" BIGINT;
