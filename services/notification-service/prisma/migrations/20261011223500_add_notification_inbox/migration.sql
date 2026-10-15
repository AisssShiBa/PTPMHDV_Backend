ALTER TABLE "Notification" ADD COLUMN "eventId" TEXT;

CREATE UNIQUE INDEX "Notification_eventId_key" ON "Notification"("eventId");

CREATE TABLE "NotificationInbox" (
    "eventId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationInbox_pkey" PRIMARY KEY ("eventId")
);
