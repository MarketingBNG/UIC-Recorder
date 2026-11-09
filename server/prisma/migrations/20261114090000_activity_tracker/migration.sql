-- Dialer + activity tracker (docs/dialer-plan.md): contacts and their activities.
-- Hand-written; leaves the transcripts tsv column / GIN index and the calls phone trigram index untouched.
CREATE TYPE "ContactStatus" AS ENUM ('NEW', 'INTERESTED', 'CALL_BACK', 'NOT_INTERESTED', 'NO_ANSWER');
CREATE TYPE "ActivityType" AS ENUM ('CALL', 'WHATSAPP', 'NOTE');
CREATE TYPE "CallOutcome" AS ENUM ('INTERESTED', 'CALL_BACK', 'NOT_INTERESTED', 'NO_ANSWER');

CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "name" TEXT,
    "company" TEXT,
    "owner_id" UUID,
    "status" "ContactStatus" NOT NULL DEFAULT 'NEW',
    "next_follow_up_at" TIMESTAMP(3),
    "last_activity_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "contacts_phone_e164_key" ON "contacts" ("phone_e164");
CREATE INDEX "contacts_owner_id_idx" ON "contacts" ("owner_id");
CREATE INDEX "contacts_next_follow_up_at_idx" ON "contacts" ("next_follow_up_at");
CREATE INDEX "contacts_last_activity_at_idx" ON "contacts" ("last_activity_at" DESC);
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "activities" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "contact_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "ActivityType" NOT NULL,
    "outcome" "CallOutcome",
    "note" TEXT,
    "follow_up_at" TIMESTAMP(3),
    "duration_s" INTEGER,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "call_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "activities_client_id_key" ON "activities" ("client_id");
CREATE INDEX "activities_contact_id_occurred_at_idx" ON "activities" ("contact_id", "occurred_at" DESC);
CREATE INDEX "activities_user_id_occurred_at_idx" ON "activities" ("user_id", "occurred_at" DESC);
CREATE INDEX "activities_call_id_idx" ON "activities" ("call_id");
ALTER TABLE "activities" ADD CONSTRAINT "activities_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "activities" ADD CONSTRAINT "activities_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;
