DROP INDEX "Notification_eventId_key";

CREATE UNIQUE INDEX "Notification_eventId_userId_key"
ON "Notification"("eventId", "userId");
