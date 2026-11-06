# Notification event catalog

The notification service consumes the legacy `wallet.events`, `payment.events`,
and `kyc.events` exchanges alongside the versioned `finvault.events` exchange.
Its notification type enum is defined in
`prisma/schema.prisma` and mirrored in `src/types/notification.ts`.

| Source | Published event/type | Notification enum | Status |
| --- | --- | --- | --- |
| `payment-service` outbox | `PAYMENT_SUCCESS` → `payment.succeeded` | `PAYMENT_SUCCESS` | Published to `finvault.events`; sender and receiver get one inbox item each |
| `payment-service` outbox | `PAYMENT_FAILED` → `payment.failed` | `PAYMENT_FAILED` | Published to `finvault.events`; failure details are not included in the message |
| `payment-service` outbox | `PAYMENT_REFUNDED` | `PAYMENT_REFUNDED` | Published to `payment.events`; HTTP fallback exists |
| `payment-service` outbox | `PAYMENT_CANCELLED` | `PAYMENT_CANCELLED` | Published to `payment.events`; HTTP fallback exists |
| `payment-service` outbox/expiry job | `PAYMENT_EXPIRED` → `payment.expired` | `PAYMENT_EXPIRED` | Published to `finvault.events`; sender receives a notification |
| `wallet-service` outbox | `wallet.balance_added` → `WALLET_CREDITED` | `WALLET_CREDITED` | Published to `wallet.events`; HTTP fallback exists |
| `wallet-service` outbox | `wallet.balance_deducted` → `WALLET_DEBITED` | `WALLET_DEBITED` | Published to `wallet.events`; HTTP fallback exists |
| — | — | `KYC_APPROVED` | No current event source |
| — | — | `KYC_REJECTED` | No current event source |
| `user-service` outbox | `user.kyc_updated` on `finvault.events` | `KYC_TIER_CHANGED` | Consumed; legacy events without `previousTier` are supported |
| `merchant-service` outbox | `merchant.status_updated` on `finvault.events` | — | Bound and intentionally acknowledged without a notification; no recipient is defined |
| `user-service` outbox | `user.registered` on `finvault.events` | — | Bound and intentionally acknowledged without a notification; no recipient is defined |
| `payment-service` outbox | `payment.succeeded` on `finvault.events` | `PAYMENT_SUCCESS` | Envelope event ID is the Outbox row ID; optional `note` is included when present |
| `payment-service` outbox | `payment.failed` on `finvault.events` | `PAYMENT_FAILED` | Envelope event ID is the Outbox row ID |
| `payment-service` outbox | `payment.expired` on `finvault.events` | `PAYMENT_EXPIRED` | Envelope event ID is the Outbox row ID |

The new consumer binds only these six exact event types. Payment outbox rows
are claimed with `FOR UPDATE SKIP LOCKED`, drained after the state transaction
commits, and retried by a one-second fallback scheduler. The legacy payment
publisher remains active for refund/cancel events. Wallet outbox rows are
similarly drained after commit and every second; P2P wallet messages are
suppressed to avoid duplicating the shared payment notification. For merchant
and other `PAYMENT` transfers, the shared payment event is the canonical
notification; the legacy wallet debit/credit notification is suppressed.
`TOPUP` and `REFUND` wallet notifications remain unchanged. The new
consumer does not bind
`wallet.limit_exceeded` because no notification type is defined for it, nor
does it use broad user or merchant wildcards. Legacy exchange consumption
remains active during the migration.

## Proposed mappings added in N14a (mapping only, not bound)

N14a adds the notification enum values and pure mapping cases below. **These
event names are proposals and are not registered in
`packages/finvault-events/src/schemas.ts`**, so they are deliberately absent
from `financeEventBindings` and from the consumer handlers. Binding an
unregistered event would make the consumer dead-letter every message (N14b is
blocked until the schemas exist on `main`).

| Proposed event | Notification enum | Message |
| --- | --- | --- |
| `funding.topup_succeeded` | `TOPUP_SUCCEEDED` | `Bạn đã nạp <amount> vào ví thành công.` |
| `payment.refunded` | `PAYMENT_REFUNDED` | `Bạn được hoàn <amount> vào ví.` (`amount` may be `"50000.00"`; a non-zero fraction is rejected) |
| `funding.cashout_completed` | `CASHOUT_SUCCEEDED` | `Lệnh rút <amount> của bạn đã thành công.` |
| `funding.cashout_failed` | `CASHOUT_FAILED` | `Lệnh rút <amount> của bạn không thành công.` (upstream reason is ignored) |
| `utility.order_succeeded` | `UTILITY_SUCCEEDED` | `Giao dịch tiện ích <amount> đã thành công.` |
| `utility.order_failed` | `UTILITY_FAILED` | `Giao dịch tiện ích <amount> không thành công.` |
| `utility.order_refunded` | `UTILITY_REFUNDED` | `Giao dịch tiện ích <amount> đã được hoàn tiền.` |
| `user.kyc_reviewed` | `KYC_APPROVED` / `KYC_REJECTED` | Approval message, or a rejection message with an optional sanitized reason (≤200 chars). |

Amounts are validated as BigInt integer VND strings; malformed amounts and
missing `userId`/`authUserId` throw `TypeError`, which the consumer treats as
non-retryable. KYC reasons have control characters removed and are truncated to
200 characters. The existing `user.kyc_updated` → `KYC_TIER_CHANGED` mapping is
unchanged; `user.kyc_reviewed` is a separate event.
