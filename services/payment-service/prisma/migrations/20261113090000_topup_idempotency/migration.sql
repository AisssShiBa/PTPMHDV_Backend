ALTER TABLE "TopupRequest" ADD COLUMN "idempotencyKey" UUID;
CREATE UNIQUE INDEX "TopupRequest_userId_idempotencyKey_key" ON "TopupRequest"("userId", "idempotencyKey");
