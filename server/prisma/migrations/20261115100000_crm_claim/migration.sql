-- Zoho CRM sync: lease so two server containers (rolling deploy) never sync the same call at once.
ALTER TABLE "calls" ADD COLUMN "crm_locked_until" TIMESTAMP(3);
