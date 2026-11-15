# N19 – Inventory of notification event sources (Backend)

Checked on branch `nguyen` against `origin/main`. Every row below was verified
by opening the cited file in this repository; nothing is inferred from the
Week 3 report.

Scope reminder: `packages/finvault-events` and the other services belong to
other owners, so this inventory records what exists and what is missing
instead of changing them.

## 1. Bound on `finvault.events` after N19

`services/notification-service/src/services/financeEventsConsumer.ts`
`financeEventBindings` now contains exactly eight routing keys:

| Routing key | Notification type | Handler | Publisher (verified) |
| --- | --- | --- | --- |
| `user.registered` | — (ignored) | none | `user-service` outbox |
| `user.kyc_updated` | `KYC_TIER_CHANGED` | yes | `services/user-service/src/services/kyc-tier.service.ts` (`recordTierChange`) |
| `merchant.status_updated` | — (ignored) | none | `merchant-service` outbox |
| `payment.succeeded` | `PAYMENT_SUCCESS` | yes | `services/payment-service/src/events/finvault.publisher.ts` (`buildPaymentFinvaultEvent`) |
| `payment.failed` | `PAYMENT_FAILED` | yes | same |
| `payment.expired` | `PAYMENT_EXPIRED` | yes | same |
| `funding.cashout_completed` | `CASHOUT_SUCCEEDED` | yes (added in N19) | `services/payment-service/src/funding/events/cashout.events.ts`, written to the outbox by `funding/services/cashout.service.ts` |
| `funding.cashout_failed` | `CASHOUT_FAILED` | yes (added in N19) | same |

Both `funding.cashout_*` schemas are registered in
`packages/finvault-events/src/schemas.ts` (`eventSchemaRegistry`, version 1),
so binding them required no change to the shared package.

## 2. Needed notification types that cannot be bound yet

| Business event | Notification type | Schema in `finvault-events`? | Publisher found? | Current alternative | Owner decision needed |
| --- | --- | --- | --- | --- | --- |
| Nạp tiền thành công | `TOPUP_SUCCEEDED` | **No** (`funding.topup_succeeded` absent from `eventSchemaRegistry`) | **No** publishing site exists in `services/` | `wallet-service` outbox publishes `wallet.balance_added` on `wallet.events`; the legacy consumer maps it to `WALLET_CREDITED` (`services/wallet-service/src/services/ledger.service.ts`, `jobs/outbox.scheduler.ts`, `services/notification-service/src/services/rabbitmqConsumer.ts`) | Yes — either register `funding.topup_succeeded` or accept `WALLET_CREDITED` and measure its latency |
| Rút tiền thành công / thất bại | `CASHOUT_SUCCEEDED` / `CASHOUT_FAILED` | Yes | Yes | — | None (closed by N19) |
| Hoàn tiền | `PAYMENT_REFUNDED` | **No** (`payment.refunded` absent) | **No** — `buildPaymentFinvaultEvent` returns `undefined` for `PAYMENT_REFUNDED`, so the row falls through to the legacy branch in `services/payment-service/src/jobs/outbox.job.ts` (exchange `payment.events`, routing key `payment.notification`) | Legacy `payment.events` → `PAYMENT_REFUNDED`, plus HTTP fallback `NotificationClient.send` | Yes — register `payment.refunded` or keep the legacy path with evidence |
| Nạp điện thoại / thanh toán hóa đơn | `UTILITY_SUCCEEDED` / `UTILITY_FAILED` / `UTILITY_REFUNDED` | **No** (`utility.order_*` absent) | **No** — `services/utilities-service` has no outbox or publisher; it only *consumes* `payment.succeeded/failed/expired` (`src/services/utilityEventsConsumer.ts`) | None found | Yes — `utilities-service` must publish before a notification can exist |
| KYC được duyệt / bị từ chối | `KYC_APPROVED` / `KYC_REJECTED` | **No** (`user.kyc_reviewed` absent) | **No** — `user-service` only emits `user.kyc_updated` when the tier changes, which maps to `KYC_TIER_CHANGED` | Tier change notification only; a rejection produces no notification | Yes — `user-service` must publish `user.kyc_reviewed` |

`wallet.limit_exceeded` is registered and published but intentionally not bound:
no notification type is defined for it.

## 3. Consequences

- Binding `funding.topup_succeeded`, `payment.refunded`, `utility.order_*` or
  `user.kyc_reviewed` today would make the consumer dead-letter every message
  of those types (`UNKNOWN_EVENT_TYPE`) and would not produce a notification
  anyway, because nothing publishes them.
- The N15 Frontend work still expands `NotificationType` so the UI can render
  these types if an owner later adds the schemas and producers.
- `fixtures`: a valid cash-out envelope must carry `cashOutId`, `userId` and an
  integer `amount` string (plus `reason` for the failure event); `payment-service`
  already produces exactly that shape.

## 4. Build note found while running the N19 tests

`services/*/node_modules/finvault-events` is a junction to
`packages/finvault-events`, whose `dist/` is a local build artifact (not
tracked). The `dist/` in this working copy predated the cash-out schema, so
`parseFinvaultEvent` rejected the new event types until
`npm run build` was run inside `packages/finvault-events`. Docker builds are
unaffected because `npm install` runs the package's `prepare` script, but any
local run must rebuild the package first. No tracked file was changed by this.
