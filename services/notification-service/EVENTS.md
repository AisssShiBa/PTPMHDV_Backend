# Notification event catalog

The notification service currently consumes `wallet.events`, `payment.events`,
and `kyc.events`. Its notification type enum is defined in
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
| `user-service` outbox | `user.kyc_updated` on `finvault.events` | `KYC_TIER_CHANGED` | Not mapped to a notification type; the exchange is not consumed here |
| `merchant-service` outbox | `merchant.status_updated` on `finvault.events` | `MERCHANT_APPROVED` | No current notification mapping; the exchange is not consumed here |
| `merchant-service` outbox | `merchant.status_updated` on `finvault.events` | `MERCHANT_REJECTED` | No current notification mapping; the exchange is not consumed here |

`user-service` and `merchant-service` events on `finvault.events` are not
connected to this consumer yet. `kyc.events` currently has no source publisher.
Connecting these event flows is outside the current notification-service scope.
