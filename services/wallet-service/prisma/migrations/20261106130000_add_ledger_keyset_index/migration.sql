-- CreateIndex
CREATE INDEX IF NOT EXISTS "LedgerEntry_walletId_createdAt_id_idx"
  ON "LedgerEntry"("walletId", "createdAt" DESC, "id" DESC);
