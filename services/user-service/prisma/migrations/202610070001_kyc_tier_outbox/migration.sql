-- Tier is independent of KYC status. Existing and new profiles start at 0.
ALTER TABLE "users" ADD COLUMN "kyc_tier" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "user_outbox_events" (
    "id" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    CONSTRAINT "user_outbox_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_outbox_events_aggregate_id_aggregate_version_key"
    ON "user_outbox_events"("aggregate_id", "aggregate_version");
CREATE INDEX "user_outbox_events_status_created_at_idx"
    ON "user_outbox_events"("status", "created_at");
