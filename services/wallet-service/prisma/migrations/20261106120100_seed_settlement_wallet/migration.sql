-- Separate migration because 'SETTLEMENT' was added by the previous one and a new
-- enum value cannot be referenced in the transaction that creates it.
INSERT INTO "Wallet" ("systemCode", "ownerType", "balance", "heldBalance", "currency", "status", "createdAt", "updatedAt")
VALUES ('SETTLEMENT', 'SYSTEM', 0, 0, 'VND', 'ACTIVE', NOW(), NOW())
ON CONFLICT ("systemCode") DO NOTHING;
