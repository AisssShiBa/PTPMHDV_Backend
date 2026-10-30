-- CreateTable
CREATE TABLE "UsedTransactionToken" (
    "jti" VARCHAR(100) NOT NULL,
    "paymentId" UUID NOT NULL,
    "userId" VARCHAR(50) NOT NULL,
    "usedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsedTransactionToken_pkey" PRIMARY KEY ("jti")
);

-- CreateIndex
CREATE INDEX "UsedTransactionToken_usedAt_idx" ON "UsedTransactionToken"("usedAt");

-- CreateIndex
CREATE INDEX "UsedTransactionToken_paymentId_idx" ON "UsedTransactionToken"("paymentId");

