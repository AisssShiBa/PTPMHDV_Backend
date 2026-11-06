-- CreateEnum
CREATE TYPE "UtilityType" AS ENUM ('TELCO_TOPUP', 'BILL_PAY');

-- CreateEnum
CREATE TYPE "UtilityOrderStatus" AS ENUM (
  'PENDING_PAYMENT',
  'PAID',
  'PROVIDER_PENDING',
  'SUCCESS',
  'FAILED',
  'REFUND_REQUESTED',
  'REFUNDED',
  'REFUND_FAILED'
);

-- CreateTable
CREATE TABLE "utility_orders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "UtilityType" NOT NULL,
    "status" "UtilityOrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "amount" DECIMAL(20,2) NOT NULL,
    "discount_amount" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "target" TEXT NOT NULL,
    "provider_code" TEXT,
    "provider_ref" TEXT,
    "payment_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "failure_reason" TEXT,
    "refund_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "utility_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "utility_order_history" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "from_status" "UtilityOrderStatus",
    "to_status" "UtilityOrderStatus" NOT NULL,
    "note" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "utility_order_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "utility_inbox" (
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "utility_inbox_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "utility_orders_payment_id_key" ON "utility_orders"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "utility_orders_user_id_idempotency_key_key" ON "utility_orders"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "utility_orders_status_idx" ON "utility_orders"("status");

-- CreateIndex
CREATE INDEX "utility_order_history_order_id_at_idx" ON "utility_order_history"("order_id", "at");

-- AddForeignKey
ALTER TABLE "utility_order_history"
  ADD CONSTRAINT "utility_order_history_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "utility_orders"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
