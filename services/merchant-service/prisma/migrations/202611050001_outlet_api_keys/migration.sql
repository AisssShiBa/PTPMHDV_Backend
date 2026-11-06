-- CreateTable
CREATE TABLE "outlets" (
  "id" TEXT PRIMARY KEY,
  "merchant_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "outlets_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "outlets_code_key" ON "outlets"("code");

-- CreateIndex
CREATE INDEX "outlets_merchant_id_idx" ON "outlets"("merchant_id");

-- CreateTable
CREATE TABLE "merchant_api_keys" (
  "id" TEXT PRIMARY KEY,
  "merchant_id" TEXT NOT NULL,
  "key_id" TEXT NOT NULL,
  "prefix" TEXT NOT NULL,
  "secret_hash" TEXT NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "last_used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "merchant_api_keys_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "merchant_api_keys_key_id_key" ON "merchant_api_keys"("key_id");

-- CreateIndex
CREATE INDEX "merchant_api_keys_merchant_id_revoked_at_idx" ON "merchant_api_keys"("merchant_id", "revoked_at");
