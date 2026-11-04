-- Fireflies provider: monthly minute reservations, settings JSON, WAITING_BUDGET job status.
-- Hand-checked: Prisma also wanted to drop the transcripts tsvector index/default
-- (it can't model them, see schema.prisma header); those statements were removed.

-- CreateEnum
CREATE TYPE "FirefliesReservationStatus" AS ENUM ('RESERVED', 'COMMITTED', 'RELEASED');

-- AlterEnum
ALTER TYPE "JobStatus" ADD VALUE 'WAITING_BUDGET';

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "fireflies" JSONB;

-- CreateTable
CREATE TABLE "fireflies_reservations" (
    "id" UUID NOT NULL,
    "call_id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "actual_minutes" INTEGER,
    "live" BOOLEAN NOT NULL,
    "status" "FirefliesReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "uploaded_at" TIMESTAMP(3),
    "transcript_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fireflies_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fireflies_reservations_month_status_idx" ON "fireflies_reservations"("month", "status");

-- CreateIndex
CREATE INDEX "fireflies_reservations_call_id_status_idx" ON "fireflies_reservations"("call_id", "status");

-- AddForeignKey
ALTER TABLE "fireflies_reservations" ADD CONSTRAINT "fireflies_reservations_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
