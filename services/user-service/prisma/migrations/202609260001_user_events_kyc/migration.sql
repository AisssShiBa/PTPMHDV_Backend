ALTER TABLE "users"
  ADD COLUMN "kyc_object_key" TEXT,
  ADD COLUMN "kyc_mime_type" TEXT,
  ADD COLUMN "kyc_file_size" INTEGER,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "consumed_events" (
  "id" TEXT PRIMARY KEY,
  "payload_hash" TEXT NOT NULL,
  "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "storage_cleanup" (
  "object_key" TEXT PRIMARY KEY,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "storage_cleanup_next_attempt_at_idx" ON "storage_cleanup"("next_attempt_at");
