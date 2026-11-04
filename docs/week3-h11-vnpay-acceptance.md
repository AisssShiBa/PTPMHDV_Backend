# Week 3 — H11 VNPAY IPN acceptance record

Backend-only acceptance run against a freshly built, isolated Docker Compose
project. Every result below was answered by the stack in that run (real
Gateway → payment-service → wallet-service → PostgreSQL). Nothing is inferred
from reading code.

- Commit: `f3217d1`
- Compose project: `finvault-acceptance-052e547d79d3` (random free host ports)
- Started: 2026-11-04T06:52:15Z · Completed: 2026-11-04T06:57:18Z
- Command: `node tests/acceptance/week3/phase-week3.mjs`
- Full machine-readable evidence (logs, `result.json`, `report.md`):
  `.cache/acceptance-week2/finvault-acceptance-052e547d79d3/` — git-ignored.

The VNPAY callbacks are locally signed with a synthetic terminal
(`SYNTH_TMN_CODE`) and a test hash secret; no VNPAY sandbox is contacted. These
results prove the decision table and money invariants, not a real sandbox
round-trip (plan risk R11 stays MEDIUM).

## Result matrix

| Test | Result | HTTP | RspCode | Ledger / state invariant |
|---|---|---|---|---|
| COMPOSE | PASS | – | – | fresh isolated stack, host ports reachable |
| B6-7 | PASS | – | – | workers, broker, storage, API health |
| SEED | PASS | – | – | acceptance account created once |
| V01 | PASS | 200 | 00 | `APPROVED`; user +100000, `TOPUP_POOL` −100000, one `transactionId` |
| V02 (A6) | PASS | 200 | 00 then 02 | two sequential IPNs → exactly one credit |
| V03 | PASS | 200 | 00 then 99×19 | 20 concurrent IPNs → exactly one credit |
| V04 | PASS | 200 | 97 | forged checksum: row unchanged, zero ledger rows |
| V05 | PASS | 200 | 04 | amount mismatch: row unchanged, zero ledger rows |
| V06 | PASS | 200 | 97 | foreign `vnp_TmnCode`: no credit |
| V07 | PASS | 200 | 01 | unknown reference: no row created |
| V09 | PASS | 200 | recovered | crash after credit → recovery approves with one credit |
| V10 | PASS | 200 | 00 alias / 02 legacy | alias and legacy IPN → one transaction |
| V11 | PASS | 401 | `INVALID_GATEWAY_TOKEN` | create requires Bearer; return URL is read-only |
| V12 | PASS | 400 | `VALIDATION_ERROR` / `INVALID_AMOUNT` | max amount persisted exactly; bad amounts never created |
| V08 (A6-R) | PASS | 200 | 99 then recovered | wallet outage → `PROCESSING`, recovery → `APPROVED`, one credit |
| GATEWAY-ALIAS-CREATE | BLOCKED | 401 | `INVALID_GATEWAY_TOKEN` | see below |
| CONSERVATION | PASS | – | – | `checkSystemConservation` = 0 and `SUM(Wallet.balance)` = 0 |

`PASS=17, FAIL=0, BLOCKED=1`.

## A6-R evidence (the money-safety case)

payment-service log for the scenario, from `a6r-payment.log`:

```
[Topup] Wallet credit outcome unknown { topupId: 'b36fd05f-…', code: 'NAP158C3ED6',
                                        walletStatus: null, walletCode: null }
GET /api/funding/vnpay/ipn?… 200 76.252 ms - 42        <- RspCode 99, row stays PROCESSING
[Job:recoverTopups] approved=1 retried=0               <- wallet back up, recovery approves
```

The topup was not marked `FAILED` while the wallet outcome was unknown, the IPN
did not answer `00`, and the recovery worker settled it with the original
`topup.code`, so the wallet's `(walletId, referenceId)` uniqueness prevented a
second credit.

## One blocked check — not this owner's code

`GATEWAY-ALIAS-CREATE` is BLOCKED, not failed. The Gateway `PUBLIC_ROUTES`
whitelist `/^\/api\/funding(\/.*)?$/` (owner: Đạt) marks the whole funding
prefix public, so `requireGateway` never sees `x-gateway-token` on
`POST /api/funding/vnpay/create`. Both unauthenticated and Bearer requests
answer `401 INVALID_GATEWAY_TOKEN`. The IPN/return aliases remain usable because
they authenticate by HMAC. Narrowing that whitelist is a Gateway change owned by
Đạt; this branch does not edit it (plan STOP-3). The legacy create route
`POST /api/payments/topups` is unaffected and is what V01–V12 exercise.

## Product fix that this run validates

`topupRequest.updateMany()` was being called with a nested `auditLogs: { create: … }`
relation write, which Prisma rejects (`Unknown argument`). Every paid-IPN
approval and every FAILED transition therefore threw against a real database,
leaving the wallet credited while the topup stayed unapproved. The status updates
now carry scalars only and the audit row is appended afterwards through a
best-effort `recordAudit()` helper, so an audit failure can never roll back a
money decision.

## Reproduce

```bash
node tests/acceptance/week3/phase-week3.mjs            # removes the project, keeps volumes
node tests/acceptance/week3/phase-week3.mjs --keep     # leaves the stack up for inspection
```

Unit coverage for the same decision table (no database):

```bash
cd services/payment-service
npx tsx --test tests/topup-vnpay-ipn.test.ts tests/wallet-credit-outcome.test.ts
```
