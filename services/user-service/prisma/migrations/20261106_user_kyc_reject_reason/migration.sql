-- Reason supplied by an administrator when rejecting KYC; cleared on re-submission
-- and on approval so a stale reason can never be shown for a non-rejected profile.
ALTER TABLE "users" ADD COLUMN "kyc_reject_reason" TEXT;
