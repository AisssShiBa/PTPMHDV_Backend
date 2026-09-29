-- Stop with an explicit error; never silently delete existing merchants.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "merchants" GROUP BY "owner_id" HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate merchant owner_id: resolve duplicate profiles before applying this migration';
  END IF;
END $$;
CREATE UNIQUE INDEX "merchants_owner_id_key" ON "merchants"("owner_id");
ALTER TABLE "merchants" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
CREATE TABLE "merchant_outbox_events" (
  "id" TEXT PRIMARY KEY,
  "aggregate_id" TEXT NOT NULL,
  "aggregate_version" INTEGER NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_until" TIMESTAMP(3),
  "lock_token" TEXT,
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMP(3)
);
CREATE INDEX "merchant_outbox_events_status_next_attempt_at_idx" ON "merchant_outbox_events"("status", "next_attempt_at");
CREATE UNIQUE INDEX "merchant_outbox_events_aggregate_id_aggregate_version_key" ON "merchant_outbox_events"("aggregate_id", "aggregate_version");
