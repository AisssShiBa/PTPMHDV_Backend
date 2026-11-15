-- Persist the refresh-token rotation fields already used by AuthService.
-- Preserve existing token hashes, expiry and families from manually aligned DBs.
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "familyId" TEXT;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3);
UPDATE "Session" SET "familyId" = "id" WHERE "familyId" IS NULL;
ALTER TABLE "Session" ALTER COLUMN "familyId" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "Session_familyId_idx" ON "Session"("familyId");
