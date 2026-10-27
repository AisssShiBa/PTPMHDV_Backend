# Notification event catalog

The notification service consumes the legacy `wallet.events`, `payment.events`,
and `kyc.events` exchanges alongside the versioned `finvault.events` exchange.
Its notification type enum is defined in
`prisma/schema.prisma` and mirrored in `src/types/notification.ts`.

| Source | Published event/type | Notification enum | Status |
| --- | --- | --- | --- |
| `payment-service` outbox | `PAYMENT_SUCCESS` | `PAYMENT_SUCCESS` | Published to `payment.events`; HTTP fallback exists |
| `payment-service` outbox | `PAYMENT_FAILED` | `PAYMENT_FAILED` | Published to `payment.events`; HTTP fallback exists |
| `payment-service` outbox | `PAYMENT_REFUNDED` | `PAYMENT_REFUNDED` | Published to `payment.events`; HTTP fallback exists |
| `payment-service` outbox | `PAYMENT_CANCELLED` | `PAYMENT_CANCELLED` | Published to `payment.events`; HTTP fallback exists |
| `payment-service` expiry job | `PAYMENT_EXPIRED` | `PAYMENT_EXPIRED` | Outbox row is created, but the current payment outbox publisher skips this type |
| `wallet-service` outbox | `wallet.balance_added` → `WALLET_CREDITED` | `WALLET_CREDITED` | Published to `wallet.events`; HTTP fallback exists |
| `wallet-service` outbox | `wallet.balance_deducted` → `WALLET_DEBITED` | `WALLET_DEBITED` | Published to `wallet.events`; HTTP fallback exists |
| — | — | `KYC_APPROVED` | No current event source |
| — | — | `KYC_REJECTED` | No current event source |
| `user-service` outbox | `user.kyc_updated` on `finvault.events` | `KYC_TIER_CHANGED` | Consumed; legacy events without `previousTier` are supported |
| `merchant-service` outbox | `merchant.status_updated` on `finvault.events` | — | Bound and intentionally acknowledged without a notification; no recipient is defined |
| `user-service` outbox | `user.registered` on `finvault.events` | — | Bound and intentionally acknowledged without a notification; no recipient is defined |
| `payment-service` outbox | `payment.succeeded` on `finvault.events` | `PAYMENT_SUCCESS` | Creates one notification per distinct sender/receiver in one event transaction |
| `payment-service` outbox | `payment.failed` on `finvault.events` | `PAYMENT_FAILED` | Consumed for the sender; failure details are not included in the message |
| `payment-service` outbox | `payment.expired` on `finvault.events` | `PAYMENT_EXPIRED` | Consumed for the sender |

The new consumer binds only these six exact event types. It does not bind
`wallet.limit_exceeded` because no notification type is defined for it, nor
does it use broad user or merchant wildcards. Legacy exchange consumption
remains active during the migration.
