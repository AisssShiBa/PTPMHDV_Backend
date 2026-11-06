# H14 — KYC reject reason, review event, TTL 900s: acceptance record

Date: 2026-11-06 (acceptance matrix re-run 2026-11-06T06:05Z after K12)
Plan: `FinVault_KeHoach_Huu_Tuan3_ChiTiet_Theo_Phase.md` §9 (Phase 6, H14)
Branch: `feat/week3-huu-kyc-review`

Verdict: **PASS for the reject reason and the 900s TTL. BLOCKED for `user.kyc_reviewed` and for the
K03 tier rule.** No PASS below is inferred from code that was merely written, and no test flag was
changed to turn a BLOCKED item into a PASS.

## What changed

| File | Change |
|---|---|
| `prisma/schema.prisma:21` | `kycRejectReason String? @map("kyc_reject_reason")` |
| `prisma/migrations/20261106_user_kyc_reject_reason/migration.sql` | `ALTER TABLE "users" ADD COLUMN "kyc_reject_reason" TEXT;` |
| `src/validations/user.validation.ts` | `updateKycStatusSchema` (`superRefine`) requires trimmed `reason`, 1–500 chars, when `kycStatus === 'REJECTED'`; body is `.strict()` |
| `src/services/user.service.ts` | `setKycStatus()` writes the reason in the same transaction, clears it on approve/resubmit; `userResponse()` strips it from every profile payload |
| `src/controllers/userController.ts` | `getMyKyc` returns the reason only to the owner and only while `REJECTED` |
| `services/admin-service/src/controllers/kycController.ts:20` | `detail` is required when `status === 'REJECTED'` (trimmed, 1–500 chars) before the remote call |
| `services/admin-service/src/services/kycActions.ts:52` | `review()` forwards the accepted `detail` to User as `reason`; audit intent is still written first |
| `src/config/env.ts:17` | `KYC_URL_TTL_SECONDS` default 300 → **900** (max 3600) |
| `.env.example`, `docker-compose.yml:73` | default 900 |
| `docs/openapi.json` | optional `kycRejectReason` on the `Kyc` schema; `expiresIn` examples 900 |

## Verification run

Executed from `services/user-service` on 2026-11-06 with the test Compose stack up
(`postgres:16` at `127.0.0.1:25432/finvault_test` schemas `user_test`/`admin_test`, RabbitMQ 5673,
MinIO 19000).

| Command | Result |
|---|---|
| `npm test` | **32/32 pass** (5562 ms) |
| `npm run test:integration` | **49/49 pass** (13435 ms) — was 41 before H14 |
| `npm run typecheck` | exit 0 |
| `npx tsc --noEmit` (admin-service) | exit 0 |

The new file is `tests/integration/kyc-reject.test.ts` (8 tests). It boots the real user-service app
and the real admin-service app over HTTP, so the Admin → User contract is exercised end to end
rather than stubbed.

## Plan items K01–K08

### K01 — reject without a usable reason: PASS
`kyc-reject.test.ts:55`. Six bodies are rejected with `400 VALIDATION_ERROR`: missing `reason`, empty
string, whitespace-only, 501 chars, non-string, and a body with an extra field. The subject is seeded
at `kycTier: 1` so the follow-up assertions are meaningful: status stays `PENDING`, tier stays 1,
`kycRejectReason` stays `null`, `version` stays 0, and `user_outbox_events` stays empty — a successful
reject would have emitted a tier event.

### K02 — reject with reason reaches the owner and the audit trail: PASS
`kyc-reject.test.ts:79`. `POST /api/admin/kyc/:userId/review` on the real admin app with
`{status:'REJECTED', detail}` returns 200 and does **not** echo the reason; the DB row has it;
`GET /api/users/me/kyc` as the owner returns `kycStatus: REJECTED` plus `kycRejectReason`; the
generic profile route omits it; another USER gets 403 on the profile route and 404 on `/me/kyc`; and
`AdminAuditLog` holds one `REJECT_KYC` row whose detail JSON carries `outcome: SUCCEEDED`, the same
reason, and `kycStatus: REJECTED`.

### K03 — reject must not silently downgrade an existing tier: BLOCKED
`kyc-reject.test.ts:113` pins today's behaviour instead of asserting the planned one:
PENDING + tier 1 → REJECTED currently yields `kycTier: 0`. Plan §9.1 asks for the opposite ("REJECTED
từ PENDING không tự hạ tier đang có"), and it explicitly says the state transition must be agreed with
the team before tests are rewritten. The test comment marks the divergence so it cannot be read as
acceptance. The same test does confirm the APPROVED tier 1 → 0 path still emits exactly one
`user.kyc_updated` with `{kycTier: 0, previousTier: 1}`, so Wallet notification is unaffected by
whichever rule is chosen.

Outstanding decision: whether PENDING → REJECTED keeps the current tier. Owner: Khoa (money) and Đạt
(review). Until then this line stays BLOCKED and the test stays red-on-policy-change.

### K04 — approval keeps the tier event; review event emitted exactly once: PARTIAL — PASS / BLOCKED
`kyc-reject.test.ts:131` proves the passing half: an approval through the real admin app writes exactly
one outbox row, `eventType: user.kyc_updated`, data `{authUserId, kycTier: 1, previousTier: 0}`, and
zero `user.kyc_reviewed` rows. The Wallet consumer therefore still receives the tier change.

The second half — "review event emitted exactly once" — cannot pass; see the `user.kyc_reviewed`
section below.

### K05 — two concurrent reviews: PASS
`kyc-reject.test.ts:167`. Two parallel admin reviews on an APPROVED tier-1 profile both land in
`{200, 409}` with at least one 200. The row ends `REJECTED` at `version: 1`, and exactly one outbox
event exists with `{kycTier: 0, previousTier: 1}`. This is asserted as an invariant rather than a fixed
status pairing because the loser either trips the version CAS (409) or resolves after commit and
no-ops (200) — both are correct, and neither duplicates the event.

### K06 — publisher dies after broker confirm: PASS for the user-service inbox, BLOCKED for Wallet
Covered by pre-existing suites, not by new code:
- `tests/integration/profile.test.ts:34` — "consumer replay and concurrent delivery create one profile
  and one inbox record" (same `eventId`, concurrent delivery).
- `tests/integration/profile.test.ts:45` — conflict path rolls back the inbox and never revives a
  deleted user.
- `tests/integration/broker.test.ts:73` — "consumer process restart drains persisted messages and
  replay remains idempotent".
- `tests/integration/phase2.test.ts:114` — unconfirmed messages retry, failed rows require replay, and
  an expired lease retains event identity.

Wallet-side dedupe (`services/wallet-service/src/events/kyc.consumer.ts`, `walletInbox()`) has its own
`ON CONFLICT ("eventId")` path, but this suite does not exercise it against a killed publisher, so the
cross-service claim is not certifiable here and is recorded as BLOCKED.

### K07 — 900s signed URL, short TTL proves expiry: PASS
`kyc-reject.test.ts:185` asserts `env.kycUrlTtlSeconds === 900`, and that `storage.url()` signs with
`X-Amz-Expires=900` and `response-cache-control=no-store`. The 2-second expiry proof (URL returns 200,
then 403 after the window, unsigned URL 403) lives in `tests/integration/storage.test.ts:175`, and the
full-stack version is S12 in `tests/acceptance/week2/scenarios.mjs:51` with `KYC_URL_TTL_SECONDS=2`.
Deployment-time expectations were updated to 900: `tests/deployment/huu-smoke.mjs:93`,
`docs/phase2-huu.md:69`, `docs/phase3-huu.md:52`, `docs/phase4-huu.md:31`, `tests/acceptance/README.md:53`,
`services/user-service/docs/openapi.json`.

### K08 — wrong-endpoint image reads are 403 and nothing sensitive is logged: PASS
`kyc-reject.test.ts:193`. All four console channels are hijacked while these run: ADMIN on
`/:id/kyc/document` → 403, ADMIN on `/:id/kyc/documents` → 403, owner on `/:id/kyc/documents` → 403,
then a successful reject. The captured output contains none of: the CCCD number `000000001234`,
`X-Amz-Signature`, `X-Amz-Credential`, the reject reason just submitted, or the stored
`kycRejectReason`.

## `user.kyc_reviewed` — BLOCKED

Plan §9.2 requires the outbox event-version scheme to be agreed before the event is implemented, and
§9.1 forbids publishing outside the transaction. Two independent blockers are proven executable in
`kyc-reject.test.ts:144`:

1. **Outbox version uniqueness.** `UserOutboxEvent` is unique on `(aggregateId, aggregateVersion)`, and
   `recordTierChange()` writes `user.kyc_updated` at `aggregateVersion = profile.version`. On an
   APPROVED tier 1 → REJECTED transition that row is version 1. Inserting a review event for the same
   transition reuses `(aggregateId, 1)` and PostgreSQL rejects it — the test asserts `error.code ===
   'P2002'`. In production this would roll back the business transaction, i.e. the reject itself would
   fail.
2. **Unregistered schema.** `parseFinvaultEvent()` throws `UNKNOWN_EVENT_TYPE` for `user.kyc_reviewed`
   because `eventSchemaRegistry` in `packages/finvault-events/src/schemas.ts` has no entry. Even a row
   that got written would park in the publisher and end in the DLQ.

Both fixes belong to other owners per §10.1: Nguyên/Đạt own the schema registry plus the notification
mapping, and someone must decide between the preferred per-aggregate sequence/ordinal (new unique index
plus publisher ordering, migration with replay test) and the minimal two sequential aggregate versions
(which changes `User.version` semantics). Not chosen here.

## Follow-ups outside this change

- `tests/acceptance/run.mjs:200` calls the review route with a USER token and `{status:'REJECTED'}` and
  expects 403. Authorization runs before body validation, so no reason is needed there.
- Superseded: `tests/acceptance/week3/kyc-scenarios.mjs` now exists and ran K01–K08 on a fresh
  isolated stack — project `finvault-acceptance-af9a17974b53`, commit `c7ab3f5`,
  2026-11-06T06:05:42Z → 06:07:33Z, **PASS=12, FAIL=0, BLOCKED=2**. The two BLOCKED rows are K03
  (REJECTED from PENDING lowers tier 1 → 0, plan §9.1) and K04-REVIEW (the `user.kyc_reviewed` event),
  both carried into the §10 aggregate. Evidence: `.cache/acceptance-week2/finvault-acceptance-af9a17974b53/result.json`.
  This is a re-run of the first matrix (`finvault-acceptance-601860616db9`, 2026-11-05T19:13:45Z →
  19:15:20Z, same `PASS=12, FAIL=0, BLOCKED=2`) after K12 changed the SYSTEM wallet enum, so the §10
  aggregate cites only runs of the reported commit's code.
