-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('PAYMENT_SUCCESS', 'PAYMENT_FAILED', 'KYC_APPROVED', 'KYC_REJECTED', 'MERCHANT_APPROVED', 'MERCHANT_REJECTED');

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");
