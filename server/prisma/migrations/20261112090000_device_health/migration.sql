-- M4: phone throttling / recording health fields from the heartbeat (all nullable, additive).
ALTER TABLE "devices" ADD COLUMN "standby_bucket" INTEGER;
ALTER TABLE "devices" ADD COLUMN "last_stop_reason" INTEGER;
ALTER TABLE "devices" ADD COLUMN "calls_7d" INTEGER;
ALTER TABLE "devices" ADD COLUMN "recordings_7d" INTEGER;
ALTER TABLE "devices" ADD COLUMN "autostart_intent" TEXT;
ALTER TABLE "devices" ADD COLUMN "default_dialer" TEXT;
