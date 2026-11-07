-- Milestone 2b review fix: at most one open compress job per call, so two jobs can never race on one recording.
-- Hand-written; leaves the transcripts tsv column / GIN index and the trigram index untouched.
-- Close any duplicates first (keeps the oldest open job per call).
UPDATE "jobs" j SET "status" = 'FAILED', "last_error" = 'duplicate compress job', "locked_at" = NULL,
       "finished_at" = now(), "updated_at" = now()
WHERE j."kind" = 'compress' AND j."status" IN ('QUEUED', 'RUNNING')
  AND EXISTS (SELECT 1 FROM "jobs" o WHERE o."call_id" = j."call_id" AND o."kind" = 'compress'
              AND o."status" IN ('QUEUED', 'RUNNING') AND (o."created_at", o."id") < (j."created_at", j."id"));
CREATE UNIQUE INDEX "jobs_one_open_compress_per_call" ON "jobs" ("call_id")
  WHERE "kind" = 'compress' AND "status" IN ('QUEUED', 'RUNNING');
