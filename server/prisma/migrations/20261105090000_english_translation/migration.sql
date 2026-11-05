-- English translation: text_en + translation_model on transcripts; full-text search covers both languages.
-- Hand-written: the generated tsvector column and its GIN index are not modelled by Prisma.

-- AlterTable
ALTER TABLE "transcripts" ADD COLUMN "text_en" TEXT,
ADD COLUMN "translation_model" TEXT;

-- Recreate the generated search column to include the English text.
DROP INDEX IF EXISTS "transcripts_tsv_idx";
ALTER TABLE "transcripts" DROP COLUMN "tsv";
ALTER TABLE "transcripts" ADD COLUMN "tsv" tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', "text" || ' ' || coalesce("text_en", ''))) STORED;
CREATE INDEX "transcripts_tsv_idx" ON "transcripts" USING GIN ("tsv");
