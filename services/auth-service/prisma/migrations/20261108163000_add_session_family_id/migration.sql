-- AlterTable
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "familyId" TEXT NOT NULL DEFAULT gen_random_uuid(),
ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Session_familyId_idx" ON "Session"("familyId");

