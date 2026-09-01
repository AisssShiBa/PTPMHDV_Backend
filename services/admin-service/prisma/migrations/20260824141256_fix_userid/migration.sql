/*
  Warnings:

  - You are about to drop the column `userID` on the `Session` table. All the data in the column will be lost.
  - Added the required column `userId` to the `Session` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Session" DROP CONSTRAINT "Session_userID_fkey";

-- DropIndex
DROP INDEX "Session_userID_idx";

-- AlterTable
ALTER TABLE "Session" DROP COLUMN "userID",
ADD COLUMN     "userId" INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
