-- Milestone 1: alerting + throughput metrics.
-- Hand-written; leaves the transcripts tsv column / GIN index and the trigram index untouched.

-- Job timing for jobs/hour and average seconds per job (locked_at is cleared on completion).
ALTER TABLE "jobs" ADD COLUMN "started_at" TIMESTAMP(3),
ADD COLUMN "finished_at" TIMESTAMP(3);
CREATE INDEX "jobs_finished_at_idx" ON "jobs" ("finished_at");

-- Last time each worker talked to the server (claim or heartbeat).
CREATE TABLE "worker_seen" (
    "worker_id" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "worker_seen_pkey" PRIMARY KEY ("worker_id")
);

-- Dedupe state for Zoho Cliq alerts: one row per alert key.
CREATE TABLE "alert_states" (
    "key" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT,
    "first_at" TIMESTAMP(3),
    "last_sent_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    CONSTRAINT "alert_states_pkey" PRIMARY KEY ("key")
);
