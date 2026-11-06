# Week 3 — H12 cash-out acceptance record

Backend-only acceptance run of the two-step cash-out (`POST /api/funding/cash-out`
→ PIN `transactionToken` → `POST /api/funding/cash-out/:id/confirm`) against a
freshly built, isolated Docker Compose project. Every result below was answered
by the stack in that run (real payment-service → wallet-service → PostgreSQL,
plus the durable mock bank). Nothing is inferred from reading code.

- Commit: `c7ab3f5` (plus the uncommitted H12 branch changes described below)
- Branch: `feat/week3-huu-cashout`
- Compose project: `finvault-acceptance-0c69458dd4d5` (random free host ports)
- Started: 2026-11-06T05:49:25.112Z · Completed: 2026-11-06T05:53:40.211Z
- Command: `node tests/acceptance/week3/phase-week3-h12.mjs`
- Full machine-readable evidence (logs, `result.json`, `report.md`,
  `c03-evidence.json`, `c13-hold-extend-evidence.json`):
  `.cache/acceptance-week2/finvault-acceptance-0c69458dd4d5/` — git-ignored.

The matrix was first recorded at `finvault-acceptance-5f43008969c1`; it was
re-run from scratch after K12 renamed the SYSTEM top-up wallet to
`CLEARING_TOPUP` and added `SETTLEMENT` as the capture counterparty, because
`K12-COUNTERPARTY` asserts on the counterparty the ledger actually records.

The mock payout provider is enabled only through a third Compose file
(`h12-compose.json`) that sets `NODE_ENV=test`, `MOCK_PAYOUT_ENABLED=true` and
`CASHOUT_HOLD_TTL_MS=30000` on payment-service. `docker-compose.yml` pins
`NODE_ENV=production`, and the mock refuses to run there by design; the override
is scoped to this disposable project.

**H12 status: the cash-out block passes.** DoD Phase 4 requires C1–C3 and the key
fault tests to PASS on an isolated runtime, and adds that while STOP-1 is open,
**C3 = BLOCKED and H12 is not DONE even if the happy path passes**. STOP-1 is now
closed — Wallet exposes a hold **extend** API and payment-service calls it on every
`AWAIT_RECONCILE` pass — so C03 and C13 are both PASS and the C3 gate no longer
blocks. K12 is also closed by this run: the capture counterparty is
`CREDIT:SETTLEMENT`. One H12 row stays BLOCKED for code outside this branch
(STOP-3 Gateway whitelist, owner Đạt). See "What must close" at the end.

## Result matrix

| Test | Result | Invariant proven |
|---|---|---|
| COMPOSE | PASS | fresh isolated stack, host ports reachable |
| B6-7 | PASS | workers, broker, storage, API health |
| SEED | PASS | ADMIN funding account created once; mock bank reachable |
| C01 | PASS | `…000` → hold → mock SUCCESS → exactly one capture; ledger 1 debit + 1 credit, counterparty `CREDIT:SETTLEMENT` |
| C02 | PASS | `…111` → `BANK_DECLINED` → release restores available and held balance |
| C03 | PASS | `…222` → UNKNOWN → `PAYOUT_PENDING` → query → exactly one capture; hold kept alive by extend |
| C04 | PASS | same `Idempotency-Key` replays one `CashOut` row |
| C05 | PASS | same key with a different amount is rejected before any effect |
| C06 | PASS | 20 parallel confirms → 1 token claim, 1 hold, 1 payout |
| C07 | PASS | other user / other `paymentId` / other amount → 403, no hold |
| C08 | PASS | token older than 60 s → 401 `TXN_TOKEN_EXPIRED`, nothing held |
| C09 | PASS | `jti` already consumed by a Payment → 409, no money moves |
| C10 | PASS | Wallet down before Hold → no double hold, no payout without a hold |
| C11 | PASS | crash after mock SUCCESS → restart captures once under the same `providerRef` |
| C12 | PASS | lost capture response → recovery reads the hold, adds no ledger rows |
| C13 | PASS | hold outlives its TTL while the bank is UNKNOWN → extend keeps it capturable → exactly one capture |
| C14 | PASS | USER and forged Gateway tokens cannot reach the mock payout |
| C15 | PASS | `SUM(Wallet.balance)` = 0 and every debit has a matching credit |
| K12-COUNTERPARTY | PASS | capture counterparty is `CREDIT:SETTLEMENT`, not `MAIN` |
| GATEWAY-CASHOUT-ROUTE | BLOCKED | Gateway makes the funding prefix public; `requireGateway` answers 401 |
| CONSERVATION | PASS | `checkSystemConservation` = 0 and `SUM(Wallet.balance)` = 0 |
| STOP | PASS | project containers/networks removed, evidence and volumes retained |

`PASS=21, FAIL=0, BLOCKED=1`.

The outbox consumer gap is not a row in `result.json` — the harness never
asserted it, so it is not counted above. It is recorded separately below as
observed evidence, and appears in the §10 aggregate as `H12-OUTBOX-CONSUMER`.

## STOP-1 — the fix, and the evidence that it holds

STOP-1 was structural: `WalletHold` had no way to push `expiresAt` forward, so
`releaseExpiredHolds()` (cron `*/10 * * * * *`) expired any PENDING hold whose
expiry had passed — regardless of what the bank was doing — and the later
`captureHold()` answered `409 HOLD_EXPIRED` after the bank had already paid. In
that state the user kept the balance, zero ledger rows were written, and
`SUM(Wallet.balance)` still summed to 0, so conservation could not detect it.

The fix is a Wallet-side extend contract, not a Payment-side timestamp bump:

- `POST /wallets/:userId/hold/extend` → `WalletHoldService.extendHold`. It is
  **monotonic** (`requested <= hold.expiresAt` replays and changes nothing),
  **PENDING-only** via a conditional `updateMany` guarded on
  `status = PENDING AND expiresAt < requested`, **capped** by
  `WALLET_HOLD_MAX_LIFETIME_MS` (default 24 h) measured from `hold.createdAt`,
  and it takes the same Wallet lock as capture/release/the sweeper, in the same
  order, so it cannot deadlock against them. It moves no money: `heldBalance`,
  the usage reservation and the status are untouched.
- `releaseExpiredHolds()` re-checks `expiresAt < now()` inside the conditional
  `updateMany`, so a hold extended after the candidate list was read survives.
- `CashOutService.protectHold()` calls extend **before** every provider query in
  the `AWAIT_RECONCILE` branch. It is deliberately non-terminal: a Wallet that
  already captured/released/expired answers 409 and the pass continues, because
  the bank may still settle SUCCESS and `capture()` must decide.

C13 proves the mechanism, not just the outcome. The hold was created with a 30 s
TTL and the bank was held UNKNOWN across 13 reconcile passes; `expiresAt` was
pushed forward every time and the eventual SUCCESS captured that same hold
exactly once.

`c13-hold-extend-evidence.json`, from this run:

```json
{
  "bank": { "result": "SUCCESS", "timeoutResponse": true,
            "bankTransactionId": "BANK-05f2deaa-b802-402b-8630-ea95f67d18c7",
            "failureCode": null },
  "cashOut": { "status": "SUCCEEDED", "workflow": "IDLE", "failureReason": null,
               "providerRef": "cashoutpay_6b727b80-…", "leaseUntil": null },
  "hold": { "status": "CAPTURED", "amount": 100222,
            "transactionId": "bb3f232a-c9ce-4e4b-b1dc-2c242903e0dc",
            "expiresAt": "2026-11-06T05:53:51.794Z",
            "createdAt": "2026-11-06T05:52:15.883Z" },
  "ledger": { "rows": 2, "transactions": 1, "debits": 1, "credits": 1, "balanced": true },
  "holdTtlMs": 30000,
  "initialExpiry": "2026-11-06T05:52:45.850Z",
  "finalExpiry": "2026-11-06T05:53:46.367Z",
  "balance": { "before": { "balance": 1000000, "held": 0 },
               "after":  { "balance": 899778,  "held": 0 } }
}
```

The 13 observations recorded during the window were all
`status = PENDING` with a strictly future `expiresAt`, starting
`2026-11-06T05:52:48.705Z` and ending `2026-11-06T05:53:46.367Z`. The original
expiry (`05:52:45.850Z`) passed 61 s before the final observation, so the hold was
demonstrably *extended*, not merely lucky: the scenario asserts
`finalExpiry > initialExpiry` and `finalExpiry > now`, and asserts the ledger is
empty for the whole window. The user ends 100222 lower with nothing still held,
the system side is +100222, and there is exactly one debit and one credit.

C03 covers the adjacent transition: an UNKNOWN payout leaves the row
`PAYOUT_PENDING / AWAIT_RECONCILE` with the hold PENDING and one payout; a second
drive while still UNKNOWN changes nothing; the provider's SUCCESS is then
reconciled into exactly one capture on the same hold (`c03-evidence.json`).

## K12 — capture now settles into SYSTEM `SETTLEMENT`

`K12-COUNTERPARTY` was BLOCKED in every earlier H12 run because the capture
credited `CREDIT:MAIN`. K12 is now implemented, and this run reads the result
back out of the ledger rather than off the code:

- Migration `20261106120000_rename_topup_pool_add_settlement` renames the enum
  value in place — `ALTER TYPE "SystemWalletCode" RENAME VALUE 'TOPUP_POOL' TO
  'CLEARING_TOPUP'` — so the existing SYSTEM wallet, its balance and every
  ledger entry that references it by id are preserved, and adds `SETTLEMENT`.
  `20261106120100_seed_settlement_wallet` seeds the new wallet, in its own file
  because a freshly added enum value cannot be referenced in the transaction
  that adds it (Prisma runs one migration per transaction).
- `LedgerService.getSystemWalletCode(TOPUP)` → `CLEARING_TOPUP`;
  `PAYMENT / REFUND / ADJUSTMENT` → `MAIN`.
- `WalletHoldService` resolves a capture with no explicit `destinationWalletId`
  to `CAPTURE_SYSTEM_CODE = SystemWalletCode.SETTLEMENT`.

`getSystemWalletTx()` deliberately keeps its `MAIN` default: `WalletAdminService
.adjust()` calls it with no argument and must keep crediting `MAIN`. Only the
capture path passes `SETTLEMENT` explicitly.

The assertions read the observed money, not the configuration. `C01`'s
counterparty query joins `LedgerEntry` to `Wallet` on the SYSTEM side and reads
`CREDIT:SETTLEMENT`; `CONSERVATION` and `C15` still sum the system side to zero
across 7 audited cash-out references. The H11 run makes the mirror check and
reads `DEBIT:CLEARING_TOPUP` for every top-up. Between them the two runs also
show the rename moved the existing wallet rather than seeding a second one: the
freshly migrated database exposes exactly four SYSTEM wallets
(`MAIN`, `FEE`, `CLEARING_TOPUP`, `SETTLEMENT`) and no `TOPUP_POOL`.

## One blocked check — not this branch's code

`GATEWAY-CASHOUT-ROUTE` is BLOCKED, not failed. The Gateway `PUBLIC_ROUTES`
whitelist `/^\/api\/funding(\/.*)?$/` (owner: Đạt) marks the whole funding prefix
public, so no `x-gateway-token` is minted and `requireGateway` answers
`401 INVALID_GATEWAY_TOKEN` on `POST /api/funding/cash-out`. This is plan STOP-3:
the public cash-out route is deliberately not exposed. The C-matrix therefore
runs the same service over its internal HTTP port, minting a Gateway token with
the Gateway's own ES256 key inside the gateway container and calling
`http://payment-service:3005`. Every assertion is still answered by the real
service, the real database and the real Wallet — only the Gateway hop is skipped.

## Outbox consumer gap — observed, not inferred

Plan §7.1 requires `funding.cashout_completed` / `funding.cashout_failed` to be
written to the transactional Outbox **and** registered with a consumer that
Inbox-deduplicates by `eventId`. Half of that is done and half is not.

What the run proves directly. The events are written inside the `finish()`
transaction (`cashout.service.ts:357-369`), both types are in
`eventSchemaRegistry` (`schemas.ts:83-84`), and the stored envelopes are valid —
read back from the retained volume of an earlier H12 run after the project was
removed:

```json
{ "eventId": "0e9b2998-…", "eventType": "funding.cashout_completed",
  "eventVersion": 1, "occurredAt": "2026-11-05T19:46:21.904Z",
  "data": { "cashOutId": "79dcc16d-…", "userId": "a790fffc-…",
            "amount": "100000", "walletTransactionId": "bb39aa3f-…" } }
```

Nothing consumes them. `financeEventBindings` in notification-service lists
`user.registered`, `user.kyc_updated`, `merchant.status_updated`,
`payment.succeeded`, `payment.failed`, `payment.expired` — no `funding.cashout_*`
(`financeEventsConsumer.ts:15-22`), and there is no handler for them either. The
only other `finvault.events` consumer is wallet-service, bound to
`user.registered` / `user.kyc_updated` / `merchant.status_updated`
(`kyc.consumer.ts:30`). The legacy notification consumer binds `#`, but only on
`wallet.events` / `payment.events` / `kyc.events` (`rabbitmqConsumer.ts:11`), so
it never sees the exchange in question.

The effect is visible in that volume. `OutboxEvent` after the run:

| eventType | status | rows | retryCount |
|---|---|---|---|
| `funding.cashout_completed` | `PENDING` | 6 | climbing (4–9) |
| `funding.cashout_failed` | `PENDING` | 2 | climbing (4–8) |
| `payment.succeeded` | `SENT` | 1 | 0 |

`funding.cashout_*` never reaches `SENT` while `payment.succeeded` on the same
publisher does. The publish uses `mandatory: true`, so a message with no matching
binding is returned and rejected as `UNROUTABLE_EVENT` (`broker.ts:67,79`), and
`processPaymentOutboxEvent` treats every publish failure as retryable on purpose
— "a prolonged RabbitMQ outage must not permanently lose committed events"
(`payment-outbox-event.ts:36-47`) — so these rows retry with backoff forever and
never reach a terminal status. Store-and-commit is correct; delivery is not.

Caveat on what this proves: the volume shows the rows never reached `SENT` and
the binding declarations show no matching consumer, which together establish the
gap. It does not itself show which error the publisher saw; an unroutable return
is what the code path produces for a mandatory publish with no binding, and that
is the only explanation consistent with a compatible `payment.succeeded` publish
succeeding seconds later on the same publisher.

This is plan §10.1's declared fallback, not a violated invariant: "Terminal tiền
vẫn được lưu nhưng notify = BLOCKED, không drop event". Money state is persisted
and conserved; only the notification is missing. It stays BLOCKED until Nguyên
adds `funding.cashout_*` to `financeEventBindings` plus an Inbox-deduplicating
handler. Owner: Nguyên. The unbounded retry loop should be bounded at the same
time — with no consumer bound it is pure load.

## Harness defect found and fixed before this run

The first run of the rewritten C13 failed at
`the hold must be created with a future expiry` even though the hold was correct.
The cause was in the harness, not the product: `WalletHold.expiresAt` is a naive
Postgres `TIMESTAMP(3)` (no time zone), so `psql -At` prints
`2026-11-06 02:50:56.123` with no offset, and Node parses a timezone-less string
as **local** time. This host is UTC+7, so a hold expiring 30 s in the future read
as seven hours in the past. `hold()` and `cashOut()` now render those columns
with `to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`, so the harness compares
instants instead of guessing a zone. No product behaviour was changed to make
this pass, and no assertion was relaxed — the naive parse was verified to shift
by exactly the host offset (7 h) before the fix and to round-trip exactly after.

## Product fixes that earlier runs validated

Two things had to be fixed before the matrix could answer anything; both are in
this branch and were re-exercised by this run:

1. **`directMany` was synchronous while `direct` chained `.then()` on its
   array return.** Every scenario that created or confirmed a cash-out died with
   `TypeError: directMany(...).then is not a function`. Both helpers are now
   `async` and `direct` awaits the result.

2. **The recovery cron races every scenario.** `startRecoverCashoutsJob` runs
   `* * * * *`, so any HTTP snapshot or `drive()` return value can be stale
   before the assertion runs. The scenarios assert against the durable `CashOut`
   row through `settle(id, status)` / `accepted()`, and treat
   `CASHOUT_PROCESSING` / `CASHOUT_PAYOUT_PENDING` as in-flight rather than as a
   verdict.

## Reproduce

```bash
node tests/acceptance/week3/phase-week3-h12.mjs            # removes the project, keeps volumes
node tests/acceptance/week3/phase-week3-h12.mjs --keep     # leaves the stack up for inspection
node tests/acceptance/week3/phase-week3-h12.mjs --no-build # reuse existing images
```

Unit coverage for the state machine (no database):

```bash
cd services/payment-service
npx tsx --test tests/cashout-state-machine.test.ts
```

Three of those tests cover this contract directly:
`C13 AWAIT_RECONCILE extends the hold before every provider query`,
`C13 an extend failure is not terminal and the provider conclusion still settles`,
and `C13 bank SUCCESS but an expired hold is never reported as SUCCEEDED`.

## What must close before H12 can be called DONE

1. STOP-3 — Đạt narrows the Gateway funding whitelist so the public route is not
   public.
2. `H12-OUTBOX-CONSUMER` — Nguyên binds `funding.cashout_*` on `finvault.events`
   with an Inbox handler that deduplicates by `eventId`. Until then those rows
   retry forever and no notification is delivered.

STOP-1 and K12 are closed and no longer appear here. STOP-3 is the remaining
prerequisite to the CashOut migration per plan §14 item 7, so work continues with
H13 while it stays open.
