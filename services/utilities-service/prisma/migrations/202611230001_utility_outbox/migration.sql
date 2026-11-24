CREATE TABLE "utility_outbox" (
  "id" UUID NOT NULL,
  "order_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMP(3),
  "locked_until" TIMESTAMP(3),
  "lock_token" UUID,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "utility_outbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "utility_outbox_order_id_event_type_key" ON "utility_outbox"("order_id", "event_type");
CREATE INDEX "utility_outbox_published_at_locked_until_created_at_idx" ON "utility_outbox"("published_at", "locked_until", "created_at");
