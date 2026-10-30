-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('CARD_TOPUP', 'BUS_TICKET', 'MOVIE_TICKET', 'TRAIN_TICKET', 'WALLET_TRANSFER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'REFUNDED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OutboxEventStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "TopupStatus" AS ENUM ('PENDING', 'PROCESSING', 'APPROVED', 'REJECTED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "userId" VARCHAR(50) NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "type" "PaymentType" NOT NULL,
    "referenceId" VARCHAR(255) NOT NULL,
    "callbackTopic" VARCHAR(100) NOT NULL,
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "holdId" VARCHAR(255),
    "holdExpiresAt" TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentHistory" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "fromStatus" "PaymentStatus",
    "toStatus" "PaymentStatus" NOT NULL,
    "note" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "aggregateId" VARCHAR(255) NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "topic" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopupRequest" (
    "id" UUID NOT NULL,
    "userId" VARCHAR(50) NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "status" "TopupStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP NOT NULL,
    "approvedBy" VARCHAR(50),
    "approvedAt" TIMESTAMP,
    "rejectReason" TEXT,
    "walletTransactionId" UUID,
    "vnpTransactionNo" VARCHAR(50),
    "vnpBankCode" VARCHAR(20),
    "vnpPayDate" VARCHAR(20),
    "vnpResponseCode" VARCHAR(10),
    "paymentUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopupRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopupAuditLog" (
    "id" UUID NOT NULL,
    "topupRequestId" UUID NOT NULL,
    "actorId" VARCHAR(50) NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "fromStatus" "TopupStatus",
    "toStatus" "TopupStatus" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TopupAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payment_userId_createdAt_idx" ON "Payment"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "PaymentHistory_paymentId_idx" ON "PaymentHistory"("paymentId");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_createdAt_idx" ON "OutboxEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_nextRetryAt_idx" ON "OutboxEvent"("nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "TopupRequest_code_key" ON "TopupRequest"("code");

-- CreateIndex
CREATE INDEX "TopupRequest_userId_idx" ON "TopupRequest"("userId");

-- CreateIndex
CREATE INDEX "TopupRequest_status_idx" ON "TopupRequest"("status");

-- CreateIndex
CREATE INDEX "TopupAuditLog_topupRequestId_idx" ON "TopupAuditLog"("topupRequestId");

-- AddForeignKey
ALTER TABLE "PaymentHistory" ADD CONSTRAINT "PaymentHistory_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopupAuditLog" ADD CONSTRAINT "TopupAuditLog_topupRequestId_fkey" FOREIGN KEY ("topupRequestId") REFERENCES "TopupRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
