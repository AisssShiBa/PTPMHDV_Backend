# Week 3 — final backend acceptance (plan §10)

Aggregate of the four phase runs. Every PASS below is read from that phase's own
`result.json`; no verdict is inferred from the code, from an earlier test-database
pass, or from a different branch. Rows no harness exercises are `NOT_RUN` or
`MANUAL_PENDING`, and open STOP gates stay `BLOCKED`.

**PASS=63, FAIL=0, BLOCKED=5, NOT_RUN=2, MANUAL_PENDING=2**

Each phase ran on its own freshly built, isolated Compose project with random
host ports. Projects are removed at the end of the run; evidence, volumes and the
per-run credentials file are retained under `.cache/acceptance-week2/`.

## Phase provenance

| Phase | Scope | Compose project | Commit | Started | Completed | Summary |
|---|---|---|---|---|---|---|
| H11 | VNPAY IPN + recovery | `finvault-acceptance-06c23428207b` | c7ab3f5 | 2026-11-06T05:41:48.135Z | 2026-11-06T05:49:13.122Z | PASS=17, FAIL=0, BLOCKED=1 |
| H12 | Two-step cash-out | `finvault-acceptance-0c69458dd4d5` | c7ab3f5 | 2026-11-06T05:49:25.112Z | 2026-11-06T05:53:40.211Z | PASS=21, FAIL=0, BLOCKED=1 |
| H13 | Outlet / API key / QR HMAC | `finvault-acceptance-671281c9a033` | c7ab3f5 | 2026-11-06T06:03:42.809Z | 2026-11-06T06:05:05.422Z | PASS=13, FAIL=0, BLOCKED=0 |
| H14 | KYC reject reason / review event / TTL | `finvault-acceptance-af9a17974b53` | c7ab3f5 | 2026-11-06T06:05:42.124Z | 2026-11-06T06:07:33.081Z | PASS=12, FAIL=0, BLOCKED=2 |

## Results

| Phase | Test | Result |
|---|---|---|
| H11 | COMPOSE | PASS |
| H11 | B6-7 | PASS |
| H11 | SEED | PASS |
| H11 | V01 | PASS |
| H11 | V02 (A6) | PASS |
| H11 | V03 | PASS |
| H11 | V04 | PASS |
| H11 | V05 | PASS |
| H11 | V06 | PASS |
| H11 | V07 | PASS |
| H11 | V09 | PASS |
| H11 | V10 | PASS |
| H11 | V11 | PASS |
| H11 | V12 | PASS |
| H11 | V08 (A6-R) | PASS |
| H11 | GATEWAY-ALIAS-CREATE | BLOCKED |
| H11 | CONSERVATION | PASS |
| H11 | STOP | PASS |
| H12 | COMPOSE | PASS |
| H12 | B6-7 | PASS |
| H12 | SEED | PASS |
| H12 | C01 | PASS |
| H12 | C02 | PASS |
| H12 | C03 | PASS |
| H12 | C04 | PASS |
| H12 | C05 | PASS |
| H12 | C06 | PASS |
| H12 | C07 | PASS |
| H12 | C08 | PASS |
| H12 | C09 | PASS |
| H12 | C10 | PASS |
| H12 | C11 | PASS |
| H12 | C12 | PASS |
| H12 | C13 | PASS |
| H12 | C14 | PASS |
| H12 | C15 | PASS |
| H12 | K12-COUNTERPARTY | PASS |
| H12 | GATEWAY-CASHOUT-ROUTE | BLOCKED |
| H12 | CONSERVATION | PASS |
| H12 | STOP | PASS |
| H13 | COMPOSE | PASS |
| H13 | B6-7 | PASS |
| H13 | SEED | PASS |
| H13 | M01 | PASS |
| H13 | M02 | PASS |
| H13 | M03 | PASS |
| H13 | M04 | PASS |
| H13 | M05 | PASS |
| H13 | M06 | PASS |
| H13 | M07 | PASS |
| H13 | M08 | PASS |
| H13 | CONSERVATION | PASS |
| H13 | STOP | PASS |
| H14 | COMPOSE | PASS |
| H14 | B6-7 | PASS |
| H14 | SEED | PASS |
| H14 | K01 | PASS |
| H14 | K02 | PASS |
| H14 | K03 | BLOCKED |
| H14 | K04 | PASS |
| H14 | K04-REVIEW | BLOCKED |
| H14 | K05 | PASS |
| H14 | K06 | PASS |
| H14 | K07 | PASS |
| H14 | K08 | PASS |
| H14 | CONSERVATION | PASS |
| H14 | STOP | PASS |
| §13 | A1-A5 | MANUAL_PENDING |
| §13 | ADMIN-KYC-REPORT | NOT_RUN |
| §13 | MIGRATION-ROLLBACK | MANUAL_PENDING |
| §13 | REAL-VNPAY-SANDBOX | NOT_RUN |
| §13 | H12-OUTBOX-CONSUMER | BLOCKED |

## Transport, money and notes (§10.4)

`walletReferenceId` and `ledgerInvariant` are populated for the money phases
(H11/H12); the merchant and KYC phases move no money, so those cells are `-` by
construction rather than by omission.

| Phase | Test | httpStatus | errorCode | walletReferenceId | ledgerInvariant | notes |
|---|---|---|---|---|---|---|
| H11 | COMPOSE | - | - | - | - | finvault-acceptance-06c23428207b |
| H11 | B6-7 | - | - | - | - | - |
| H11 | SEED | - | - | - | - | account ready for the VNPAY matrix |
| H11 | V01 | 200 | 00 | NAP0B4B3217 | user +100000, CLEARING_TOPUP -100000, one transactionId | - |
| H11 | V02 (A6) | 200 | 00 then 02 | NAP422C25E5 | exactly one credit across two IPNs | - |
| H11 | V03 | 200 | 99,00,99,99,99,99,99,02,02,02,02,02,02,02,02,02,02,02,02,02 | NAP274A96A5 | 20 concurrent IPNs -> exactly one credit | - |
| H11 | V04 | 200 | 97 | NAPC5BABCF4 | unchanged, zero ledger rows | - |
| H11 | V05 | 200 | 04 | NAPA39A1F1A | unchanged, zero ledger rows | - |
| H11 | V06 | 200 | 97 | NAPF0263F43 | unchanged, zero ledger rows | - |
| H11 | V07 | 200 | 01 | - | no matching TopupRequest, nothing created | - |
| H11 | V09 | 200 | recovered | NAPE004028A | one credit across crash window | manual pass: {"scanned":1,"approved":1,"retried":0} |
| H11 | V10 | 200 | 00 via alias, 02 via legacy | NAP0EECB135 | both routes -> one transaction | - |
| H11 | V11 | 401 | INVALID_GATEWAY_TOKEN | NAP3FCA627B | return URL is read-only | - |
| H11 | V12 | 400 | VALIDATION_ERROR,INVALID_AMOUNT,VALIDATION_ERROR,VALIDATION_ERROR,VALIDATION_ERROR,VALIDATION_ERROR | NAP300B45D1 | max amount persisted exactly; invalid amounts never created | - |
| H11 | V08 (A6-R) | 200 | 99 then recovered | NAP56F69ADE | PROCESSING -> APPROVED, exactly one credit | - |
| H11 | GATEWAY-ALIAS-CREATE | - | - | - | - | Gateway PUBLIC_ROUTES whitelist /^\/api\/funding(\/.*)?$/ (owner: Dat) makes the alias create route public, so requireGateway sees no x-gateway-token: no Bearer=401, Bearer=401 (INVALID_GATEWAY_TOKEN). IPN/return aliases remain usable because they authenticate by HMAC. |
| H11 | CONSERVATION | - | - | - | - | - |
| H11 | STOP | - | - | - | - | - |
| H12 | COMPOSE | - | - | - | - | finvault-acceptance-0c69458dd4d5 |
| H12 | B6-7 | - | - | - | - | - |
| H12 | SEED | - | - | - | - | ADMIN account ready; mock bank answers 404 PAYOUT_NOT_FOUND |
| H12 | C01 | 200 | - | cashout_d9f41796-cfa2-4a43-81ff-6fc729e69c87 | user -100000, system +100000, 1 debit / 1 credit, hold CAPTURED | hold -> SUCCESS payout -> one capture; ledger 1 debit + 1 credit; counterparty CREDIT:SETTLEMENT |
| H12 | C02 | 409 | CASHOUT_FAILED | cashout_fcffaaab-ff12-4c72-9020-51654cc46e63 | balance unchanged, heldBalance 0, hold RELEASED, 0 capture rows | declined payout released the hold; available balance and heldBalance restored |
| H12 | C03 | 503 | CASHOUT_PROCESSING | cashout_0d95bd23-8242-4ceb-a947-a5e3ba2d2eeb | while UNKNOWN: balance unchanged, hold PENDING; after query: hold CAPTURED, 1 debit / 1 credit | UNKNOWN payout -> PAYOUT_PENDING -> provider query -> exactly one capture; the hold survives the window |
| H12 | C04 | 201 | - | cashout_0e6bf02e-bc54-44a2-822d-8487e48de07d | no hold, no payout, 0 ledger rows; one CashOut row | same Idempotency-Key replays one CashOut row |
| H12 | C05 | 422 | IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD | cashout_2ce0f220-de33-4ef8-8885-e6024b602156 | no hold, no payout, 0 ledger rows; one CashOut row | same key with a different amount is rejected before any effect |
| H12 | C06 | 200 | - | cashout_59d3f236-cc69-4f7a-8789-4b10eb72ea47 | 1 claim, 1 hold CAPTURED, 1 payout, 1 debit / 1 credit | 20 parallel confirms -> 1 claim, 1 hold, 1 payout |
| H12 | C07 | 403 | TXN_TOKEN_MISMATCH | cashout_7002cd53-dd69-4c49-9e3a-819295b27889 | no hold, no payout, 0 ledger rows for either cash-out | other user / other paymentId / other amount all answer 403 with no hold |
| H12 | C08 | 401 | TXN_TOKEN_EXPIRED | cashout_bf4882fb-74aa-4331-ae18-5433437fd06d | no hold, no payout, 0 ledger rows | a token older than 60s answers 401 TXN_TOKEN_EXPIRED and holds nothing |
| H12 | C09 | 409 | TXN_TOKEN_REUSED | cashout_751763a7-167c-4c19-86d8-bf4c06281fcd | no hold, no payout, 0 ledger rows; CashOut stays REQUESTED | a jti consumed by a Payment is rejected for CashOut with 409 and no money moves |
| H12 | C10 | 503 | CASHOUT_PROCESSING | cashout_56ec669d-6a69-4b31-b588-39e1aeeeaec8 | no hold during the outage; after recovery 1 hold CAPTURED and 1 debit / 1 credit | Wallet outage before the hold: recovery created one hold, then one payout |
| H12 | C11 | - | - | cashout_19a345ff-9186-4160-978a-fd1ff7712118 | 1 payout under one providerRef, hold CAPTURED, 1 debit / 1 credit | crash after the payout: restart captured once under the same providerRef |
| H12 | C12 | - | - | cashout_6883dcfd-6e7d-4ece-8217-1de770c1176b | hold CAPTURED once, exactly 2 ledger rows, recovery added none | lost capture response: the recovery looked up the hold and added no ledger rows |
| H12 | C13 | 503 | CASHOUT_PROCESSING | cashout_6b727b80-2266-4858-b49b-9140bfa25032 | hold PENDING past its original TTL, then CAPTURED: user -100222, system +100222, 1 debit / 1 credit | UNKNOWN bank window outlived the hold TTL; extension kept it capturable and the SUCCESS captured once |
| H12 | C14 | - | - | - | - | internal mock and forged Gateway tokens are rejected; nothing is paid |
| H12 | C15 | - | - | - | SUM(Wallet.balance) = 0, every transaction debit = credit, heldBalance >= 0 | audited 7 cash-out references; system balance is 0 |
| H12 | K12-COUNTERPARTY | - | - | - | - | capture counterparty is SETTLEMENT |
| H12 | GATEWAY-CASHOUT-ROUTE | - | - | - | - | Gateway PUBLIC_ROUTES whitelist /^\/api\/funding(\/.*)?$/ (owner: Dat) makes POST /api/funding/cash-out public, so no x-gateway-token is minted and requireGateway answers 401 INVALID_GATEWAY_TOKEN. STOP-3: the public cash-out route is not reachable through the Gateway. The C-matrix runs the same service over internal HTTP. |
| H12 | CONSERVATION | - | - | - | - | - |
| H12 | STOP | - | - | - | - | - |
| H13 | COMPOSE | - | - | - | - | finvault-acceptance-671281c9a033 |
| H13 | B6-7 | - | - | - | - | - |
| H13 | SEED | - | - | - | - | ADMIN + 3 USER principals; merchants A/B APPROVED, merchant PENDING |
| H13 | M01 | 201 | - | - | - | outlet 201; list totalElements=1; registered/status_updated/profile_updated at versions 1/2/3 |
| H13 | M02 | 409 | MERCHANT_NOT_APPROVED | - | - | PENDING merchant: outlet, api-key and QR all 409; zero outlet rows |
| H13 | M03 | 403 | FORBIDDEN | - | - | foreign USER: list/create/QR/revoke all 403; ADMIN list and read 200 |
| H13 | M04 | 409 | DUPLICATE_RESOURCE | - | - | same-merchant and cross-merchant duplicate both 409 DUPLICATE_RESOURCE; one row; no constraint name leaked |
| H13 | M05 | 200 | - | - | - | served QR verifies; mutated code, truncated token and other-merchant binding all invalid; outlet from A under B is 404 |
| H13 | M06 | 201 | - | - | - | secret only on create; no-store set; DB holds SHA-256(secret) and the 8-char prefix; raw secret absent from DB; revoke response carries neither |
| H13 | M07 | 200 | - | - | - | revoke twice keeps the first revokedAt; no secret in either response; unknown keyId 404 NOT_FOUND. No production HTTP surface calls verifyApiKey yet (it is exported for the checkout consumer), so "revoked key cannot authenticate" is proven by unit/integration tests, not here |
| H13 | M08 | - | - | - | - | merchants A/B intact; registered event once each; zero duplicate (aggregate_id, aggregate_version); 6 outbox row(s) PUBLISHED by the real publisher |
| H13 | CONSERVATION | - | - | - | - | - |
| H13 | STOP | - | - | - | - | - |
| H14 | COMPOSE | - | - | - | - | finvault-acceptance-af9a17974b53 |
| H14 | B6-7 | - | - | - | - | - |
| H14 | SEED | - | - | - | - | ADMIN + second USER ready; log scan starts at 2026-11-06T06:06:50.329Z |
| H14 | K01 | 400 | VALIDATION_ERROR | - | - | 9 malformed bodies rejected; profile unchanged (PENDING, tier 0, version 1); zero outbox rows and zero audit rows |
| H14 | K02 | 200 | - | - | - | owner sees the reason on /users/me/kyc only; generic payloads omit it; another USER gets 403; one REJECT_KYC audit row carries outcome SUCCEEDED and the same reason |
| H14 | K03 | - | - | - | - | PARTIAL: reject-with-reason works, but PENDING tier 1 became tier 0 (plan 9.1 wants the tier preserved). The outbox row [{"kycTier":0,"authUserId":"0994f7e4-d772-4e18-b75d-fa408099f9b6","previousTier":1}] would also push that downgrade to Wallet. State transition/backward compatibility needs agreement (Khoa money, Dat review) before the test is rewritten. See k03-evidence.json. |
| H14 | K04 | 200 | - | - | - | one PUBLISHED user.kyc_updated {kycTier 1, previousTier 0}; zero user.kyc_reviewed; Wallet.kycTier=1 |
| H14 | K04-REVIEW | - | - | - | - | BLOCKED by plan 9.2/10.1: (1) user_outbox_events is unique on (aggregate_id, aggregate_version) and the tier event already owns version 2 (insert failed with 23505), (2) parseFinvaultEvent answers UNKNOWN_EVENT_TYPE because packages/finvault-events has no schema. Publishing outside the transaction is forbidden. Owners: Nguyen/Dat. See k04-review-evidence.json. |
| H14 | K05 | 200/200 | - | - | - | statuses 200/200; version 2->3; exactly one {previousTier 1 -> kycTier 0} event |
| H14 | K06 | - | EVENT_CONFLICT | - | - | two identical redeliveries kept WalletInbox at one row and tier 1; an altered payload for the same eventId was dead-lettered as EVENT_CONFLICT. A real process kill is not simulated; the crash-after-confirm outcome is this duplicate delivery. |
| H14 | K07 | 200 | - | - | - | X-Amz-Expires=2 honoured from KYC_URL_TTL_SECONDS, Cache-Control no-store, unsigned URL 403, both URLs 403 after expiresAt. Production default 900 s is configured at env.ts:17, docker-compose.yml:73 and services/user-service/.env.example:13 (root .env.example has no such key) |
| H14 | K08 | 403 | FORBIDDEN | - | - | ADMIN on the owner routes, USER on the internal documents route and a foreign USER all get 403; logs since 2026-11-06T06:06:50Z contain no CCCD number, no presigned-URL parameter and no reject reason |
| H14 | CONSERVATION | - | - | - | - | - |
| H14 | STOP | - | - | - | - | - |
| §13 | A1-A5 | - | - | - | - | Owned by the P2P/PIN/Wallet owners. Not run by this branch; must be run by the owner before the common gate (§13) is signed off. |
| §13 | ADMIN-KYC-REPORT | - | - | - | - | No Admin reconciliation API exists in this branch. §10.1 lists it as a cross-owner handoff. |
| §13 | MIGRATION-ROLLBACK | - | - | - | - | Every H11–H14 migration was applied to disposable isolated projects only. Backing up and rehearsing a rollback against a retained dataset is a release step, not an acceptance scenario. |
| §13 | REAL-VNPAY-SANDBOX | - | - | - | - | Callbacks are signed locally with a synthetic terminal. Plan risk R11 stays MEDIUM; no sandbox credentials were used. |
| §13 | H12-OUTBOX-CONSUMER | - | - | - | - | The events are committed transactionally with a registered schema and a valid envelope, and are readable from the run volume, but nothing binds funding.cashout_* on finvault.events. Observed: 6 funding.cashout_completed + 2 funding.cashout_failed left PENDING with retryCount 4-9 while payment.succeeded on the same publisher reached SENT. Money state is persisted and conserved; only notify is missing, which is §10.1's declared fallback rather than a dropped event. See docs/week3-h12-cashout-acceptance.md. |

## Provenance fields (§10.4)

| Phase | Test | owner | commit | environment | startedAt | evidencePath |
|---|---|---|---|---|---|---|
| H11 | COMPOSE | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:41:48.176Z | result.json#COMPOSE |
| H11 | B6-7 | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:45:41.543Z | result.json#B6-7 |
| H11 | SEED | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:45:46.280Z | result.json#SEED |
| H11 | V01 | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:45:47.468Z | result.json#V01 |
| H11 | V02 (A6) | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:45:54.198Z | result.json#V02 (A6) |
| H11 | V03 | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:45:55.838Z | result.json#V03 |
| H11 | V04 | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:45:57.546Z | result.json#V04 |
| H11 | V05 | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:45:58.538Z | result.json#V05 |
| H11 | V06 | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:45:59.655Z | result.json#V06 |
| H11 | V07 | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:46:00.495Z | result.json#V07 |
| H11 | V09 | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:46:00.509Z | result.json#V09 |
| H11 | V10 | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:46:04.473Z | result.json#V10 |
| H11 | V11 | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:46:06.446Z | result.json#V11 |
| H11 | V12 | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:46:08.314Z | result.json#V12 |
| H11 | V08 (A6-R) | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:46:09.986Z | result.json#V08 (A6-R) |
| H11 | GATEWAY-ALIAS-CREATE | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:49:01.596Z | - |
| H11 | CONSERVATION | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:49:01.628Z | result.json#CONSERVATION |
| H11 | STOP | Huu | c7ab3f5 | finvault-acceptance-06c23428207b | 2026-11-06T05:49:02.765Z | result.json#STOP |
| H12 | COMPOSE | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:49:25.212Z | result.json#COMPOSE |
| H12 | B6-7 | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:50:31.623Z | result.json#B6-7 |
| H12 | SEED | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:50:38.213Z | result.json#SEED |
| H12 | C01 | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:50:40.350Z | result.json#C01 |
| H12 | C02 | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:50:45.383Z | result.json#C02 |
| H12 | C03 | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:50:49.989Z | result.json#C03 |
| H12 | C04 | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:50:58.250Z | result.json#C04 |
| H12 | C05 | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:51:01.644Z | result.json#C05 |
| H12 | C06 | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:51:04.977Z | result.json#C06 |
| H12 | C07 | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:51:08.940Z | result.json#C07 |
| H12 | C08 | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:51:16.776Z | result.json#C08 |
| H12 | C09 | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:51:19.895Z | result.json#C09 |
| H12 | C10 | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:51:39.234Z | result.json#C10 |
| H12 | C11 | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:52:01.456Z | result.json#C11 |
| H12 | C12 | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:52:08.715Z | result.json#C12 |
| H12 | C13 | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:52:13.066Z | result.json#C13 |
| H12 | C14 | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:53:24.555Z | result.json#C14 |
| H12 | C15 | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:53:26.177Z | result.json#C15 |
| H12 | K12-COUNTERPARTY | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:53:28.999Z | result.json#K12-COUNTERPARTY |
| H12 | GATEWAY-CASHOUT-ROUTE | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:53:29.375Z | - |
| H12 | CONSERVATION | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:53:29.392Z | result.json#CONSERVATION |
| H12 | STOP | Huu | c7ab3f5 | finvault-acceptance-0c69458dd4d5 | 2026-11-06T05:53:30.749Z | result.json#STOP |
| H13 | COMPOSE | Huu | c7ab3f5 | finvault-acceptance-671281c9a033 | 2026-11-06T06:03:42.855Z | result.json#COMPOSE |
| H13 | B6-7 | Huu | c7ab3f5 | finvault-acceptance-671281c9a033 | 2026-11-06T06:04:40.333Z | result.json#B6-7 |
| H13 | SEED | Huu | c7ab3f5 | finvault-acceptance-671281c9a033 | 2026-11-06T06:04:45.378Z | result.json#SEED |
| H13 | M01 | Huu | c7ab3f5 | finvault-acceptance-671281c9a033 | 2026-11-06T06:04:48.139Z | result.json#M01 |
| H13 | M02 | Huu | c7ab3f5 | finvault-acceptance-671281c9a033 | 2026-11-06T06:04:49.142Z | result.json#M02 |
| H13 | M03 | Huu | c7ab3f5 | finvault-acceptance-671281c9a033 | 2026-11-06T06:04:49.762Z | result.json#M03 |
| H13 | M04 | Huu | c7ab3f5 | finvault-acceptance-671281c9a033 | 2026-11-06T06:04:50.038Z | result.json#M04 |
| H13 | M05 | Huu | c7ab3f5 | finvault-acceptance-671281c9a033 | 2026-11-06T06:04:50.515Z | result.json#M05 |
| H13 | M06 | Huu | c7ab3f5 | finvault-acceptance-671281c9a033 | 2026-11-06T06:04:50.595Z | result.json#M06 |
| H13 | M07 | Huu | c7ab3f5 | finvault-acceptance-671281c9a033 | 2026-11-06T06:04:51.543Z | result.json#M07 |
| H13 | M08 | Huu | c7ab3f5 | finvault-acceptance-671281c9a033 | 2026-11-06T06:04:52.283Z | result.json#M08 |
| H13 | CONSERVATION | Huu | c7ab3f5 | finvault-acceptance-671281c9a033 | 2026-11-06T06:04:53.642Z | result.json#CONSERVATION |
| H13 | STOP | Huu | c7ab3f5 | finvault-acceptance-671281c9a033 | 2026-11-06T06:04:54.920Z | result.json#STOP |
| H14 | COMPOSE | Huu | c7ab3f5 | finvault-acceptance-af9a17974b53 | 2026-11-06T06:05:42.165Z | result.json#COMPOSE |
| H14 | B6-7 | Huu | c7ab3f5 | finvault-acceptance-af9a17974b53 | 2026-11-06T06:06:37.499Z | result.json#B6-7 |
| H14 | SEED | Huu | c7ab3f5 | finvault-acceptance-af9a17974b53 | 2026-11-06T06:06:47.119Z | result.json#SEED |
| H14 | K01 | Huu | c7ab3f5 | finvault-acceptance-af9a17974b53 | 2026-11-06T06:06:50.330Z | result.json#K01 |
| H14 | K02 | Huu | c7ab3f5 | finvault-acceptance-af9a17974b53 | 2026-11-06T06:06:55.283Z | result.json#K02 |
| H14 | K03 | Huu | c7ab3f5 | finvault-acceptance-af9a17974b53 | 2026-11-06T06:06:58.344Z | `finvault-acceptance-af9a17974b53/k03-evidence.json` |
| H14 | K04 | Huu | c7ab3f5 | finvault-acceptance-af9a17974b53 | 2026-11-06T06:07:05.418Z | result.json#K04 |
| H14 | K04-REVIEW | Huu | c7ab3f5 | finvault-acceptance-af9a17974b53 | 2026-11-06T06:07:07.882Z | `finvault-acceptance-af9a17974b53/k04-review-evidence.json` |
| H14 | K05 | Huu | c7ab3f5 | finvault-acceptance-af9a17974b53 | 2026-11-06T06:07:09.536Z | result.json#K05 |
| H14 | K06 | Huu | c7ab3f5 | finvault-acceptance-af9a17974b53 | 2026-11-06T06:07:11.191Z | result.json#K06 |
| H14 | K07 | Huu | c7ab3f5 | finvault-acceptance-af9a17974b53 | 2026-11-06T06:07:18.165Z | result.json#K07 |
| H14 | K08 | Huu | c7ab3f5 | finvault-acceptance-af9a17974b53 | 2026-11-06T06:07:21.402Z | result.json#K08 |
| H14 | CONSERVATION | Huu | c7ab3f5 | finvault-acceptance-af9a17974b53 | 2026-11-06T06:07:22.002Z | result.json#CONSERVATION |
| H14 | STOP | Huu | c7ab3f5 | finvault-acceptance-af9a17974b53 | 2026-11-06T06:07:22.995Z | result.json#STOP |
| §13 | A1-A5 | Chủ P2P/PIN/Wallet | - | - | - | - |
| §13 | ADMIN-KYC-REPORT | Nguyên | - | - | - | - |
| §13 | MIGRATION-ROLLBACK | Huu | - | - | - | - |
| §13 | REAL-VNPAY-SANDBOX | Khoa | - | - | - | - |
| §13 | H12-OUTBOX-CONSUMER | Nguyên | - | - | - | - |

## Still open

### BLOCKED (5)

- **GATEWAY-ALIAS-CREATE** (H11, owner Huu) — Gateway PUBLIC_ROUTES whitelist /^\/api\/funding(\/.*)?$/ (owner: Dat) makes the alias create route public, so requireGateway sees no x-gateway-token: no Bearer=401, Bearer=401 (INVALID_GATEWAY_TOKEN). IPN/return aliases remain usable because they authenticate by HMAC.
- **GATEWAY-CASHOUT-ROUTE** (H12, owner Huu) — Gateway PUBLIC_ROUTES whitelist /^\/api\/funding(\/.*)?$/ (owner: Dat) makes POST /api/funding/cash-out public, so no x-gateway-token is minted and requireGateway answers 401 INVALID_GATEWAY_TOKEN. STOP-3: the public cash-out route is not reachable through the Gateway. The C-matrix runs the same service over internal HTTP.
- **K03** (H14, owner Huu) — PARTIAL: reject-with-reason works, but PENDING tier 1 became tier 0 (plan 9.1 wants the tier preserved). The outbox row [{"kycTier":0,"authUserId":"0994f7e4-d772-4e18-b75d-fa408099f9b6","previousTier":1}] would also push that downgrade to Wallet. State transition/backward compatibility needs agreement (Khoa money, Dat review) before the test is rewritten. See k03-evidence.json.
- **K04-REVIEW** (H14, owner Huu) — BLOCKED by plan 9.2/10.1: (1) user_outbox_events is unique on (aggregate_id, aggregate_version) and the tier event already owns version 2 (insert failed with 23505), (2) parseFinvaultEvent answers UNKNOWN_EVENT_TYPE because packages/finvault-events has no schema. Publishing outside the transaction is forbidden. Owners: Nguyen/Dat. See k04-review-evidence.json.
- **H12-OUTBOX-CONSUMER** (§13, owner Nguyên) — The events are committed transactionally with a registered schema and a valid envelope, and are readable from the run volume, but nothing binds funding.cashout_* on finvault.events. Observed: 6 funding.cashout_completed + 2 funding.cashout_failed left PENDING with retryCount 4-9 while payment.succeeded on the same publisher reached SENT. Money state is persisted and conserved; only notify is missing, which is §10.1's declared fallback rather than a dropped event. See docs/week3-h12-cashout-acceptance.md.

### NOT_RUN / MANUAL_PENDING (4)

- **A1-A5** (MANUAL_PENDING, owner Chủ P2P/PIN/Wallet) — Owned by the P2P/PIN/Wallet owners. Not run by this branch; must be run by the owner before the common gate (§13) is signed off.
- **ADMIN-KYC-REPORT** (NOT_RUN, owner Nguyên) — No Admin reconciliation API exists in this branch. §10.1 lists it as a cross-owner handoff.
- **MIGRATION-ROLLBACK** (MANUAL_PENDING, owner Huu) — Every H11–H14 migration was applied to disposable isolated projects only. Backing up and rehearsing a rollback against a retained dataset is a release step, not an acceptance scenario.
- **REAL-VNPAY-SANDBOX** (NOT_RUN, owner Khoa) — Callbacks are signed locally with a synthetic terminal. Plan risk R11 stays MEDIUM; no sandbox credentials were used.

## Money invariants (§10.2)

| Scenario | Proven by | Result |
|---|---|---|
| Topup +100.000 → user +100.000, SYSTEM CLEARING_TOPUP −100.000, 1 debit / 1 credit | H11 V01 | PASS |
| Cash-out SUCCESS → user −100.000, system +100.000, hold CAPTURED | H12 C01 | PASS |
| Cash-out FAILED → no balance change, hold RELEASED, no capture rows | H12 C02 | PASS |
| Cash-out UNKNOWN → balance unchanged, hold PENDING | H12 C03 | PASS |
| Hold outlives its TTL while the bank is UNKNOWN → still CAPTURED once | H12 C13 | PASS |
| SUM(balance) = 0, ledger debit = credit | H11 CONSERVATION, H12 CONSERVATION, H12 C15, H13 CONSERVATION, H14 CONSERVATION | PASS |

`SUM(balance) = 0` is one check, not proof of correctness. The per-transaction
invariants above are what the ledger assertions actually verify. C13 is why the
converse matters too: before the hold gained an extend API, a hold that expired
during an UNKNOWN bank window left `SUM(balance)` summing to 0 while the bank had
paid and the user kept the money — the loss sat between the system and the bank,
not inside the ledger, so no conservation check could see it. C13 now pins the
positive invariant: the hold is pushed forward on every reconcile pass, survives
its original TTL, and the eventual SUCCESS captures it exactly once.

## §13 common gate

| Gate | Result | Evidence |
|---|---|---|
| Build/typecheck/test of the three owned services | PASS | payment-service `npm run build` clean, `npm test` 43 pass / 1 skipped (pre-existing); merchant-service `typecheck` clean, `npm test` 33/33; user-service `typecheck` clean, `npm test` 32/32 — all re-run for this report |
| `SUM(balance)` = 0, debit = credit, `heldBalance` ≥ 0 | PASS | CONSERVATION in all four runs, C15 in H12 |
| Migration has backup + rollback strategy | MANUAL_PENDING | see MIGRATION-ROLLBACK |
| No secret/token/CCCD in Git or logs | PASS | K08 scans the run logs; per-run credentials live in `.cache/` (git-ignored) and no secret is printed into any report |
| P2P/PIN/Wallet A1–A5 regression | MANUAL_PENDING | see A1-A5 |
| Every PR has a reviewer and evidence link | MANUAL_PENDING | PRs cannot be opened from this machine (no `gh`, no token); see §11.1 |

## H12 status

The H12 cash-out block passes on an isolated runtime: C01–C15 are all PASS,
CONSERVATION is PASS, and the two money invariants that depended on STOP-1
(C03 UNKNOWN → one capture, C13 hold outliving its TTL) are PASS with their own
evidence. STOP-1 is closed by a Wallet hold **extend** API
(`POST /wallets/:userId/hold/extend`, monotonic, PENDING-guarded, capped by
`WALLET_HOLD_MAX_LIFETIME_MS`) that payment-service calls on every
`AWAIT_RECONCILE` pass before it queries the bank, so the sweeper can no longer
take a hold that is still backing a live payout. C13 proves the extend rather
than merely observing survival: `expiresAt` advances from
`2026-11-06T05:52:45.850Z` to `2026-11-06T05:53:46.367Z` across 13 reconcile
passes, then the bank's SUCCESS captures the same hold exactly once.

K12 is also closed. The SYSTEM wallet enum is `MAIN / FEE / CLEARING_TOPUP /
SETTLEMENT`: the top-up counterparty is `CLEARING_TOPUP` (renamed in place, so
the existing wallet and every ledger reference survive) and a capture with no
explicit destination settles into `SETTLEMENT`. Both phases re-ran from empty
databases on the same commit and read it back off the ledger —
`DEBIT:CLEARING_TOPUP` in H11, `CREDIT:SETTLEMENT` in H12 — rather than off the
configuration.

One H12 row remains BLOCKED, outside this branch's code: the Gateway funding
whitelist (STOP-3, owner Đạt). It is not a money defect and is not reachable from
the Wallet/Payment changes made here. A third gap, `H12-OUTBOX-CONSUMER`, is
recorded as BLOCKED on observed evidence rather than assumed: nothing binds
`funding.cashout_*` on `finvault.events`, so those rows stay `PENDING` with a
climbing retry count while `payment.succeeded` on the same publisher reaches
`SENT`. Money state is persisted and conserved; only the notification is
missing, which is §10.1's declared fallback, not a dropped event.

H13 and H14 are complete as scoped. `user.kyc_reviewed` remains BLOCKED by §9.2
(event-version scheme unagreed, registry entry missing) and is not published
outside the transaction.
