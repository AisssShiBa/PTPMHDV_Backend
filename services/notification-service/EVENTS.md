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
| `user-service` outbox | `user.kyc_reviewed` (`APPROVED`) on `finvault.events` | `KYC_APPROVED` | Bound; decision commits atomically with the profile |
| `user-service` outbox | `user.kyc_reviewed` (`REJECTED`) on `finvault.events` | `KYC_REJECTED` | Bound; rejection reason is sanitized and limited to 200 display characters |
| `user-service` outbox | `user.kyc_updated` on `finvault.events` | `KYC_TIER_CHANGED` | Consumed; legacy events without `previousTier` are supported |
| `merchant-service` outbox | `merchant.status_updated` on `finvault.events` | — | Bound and intentionally acknowledged without a notification; no recipient is defined |
| `user-service` outbox | `user.registered` on `finvault.events` | — | Bound and intentionally acknowledged without a notification; no recipient is defined |
| `payment-service` outbox | `payment.succeeded` on `finvault.events` | `PAYMENT_SUCCESS` | Envelope event ID is the Outbox row ID; optional `note` is included when present |
| `payment-service` outbox | `payment.failed` on `finvault.events` | `PAYMENT_FAILED` | Envelope event ID is the Outbox row ID |
| `payment-service` outbox | `payment.expired` on `finvault.events` | `PAYMENT_EXPIRED` | Envelope event ID is the Outbox row ID |
| `payment-service` refund outbox | `payment.refunded` on `finvault.events` | `PAYMENT_REFUNDED` | Bound; accepts whole VND decimal strings such as `"50000.00"` |
| `payment-service` outbox | `funding.cashout_completed` on `finvault.events` | `CASHOUT_SUCCEEDED` | Bound in N19; written by `cashout.service.ts` when a cash-out reaches `SUCCEEDED` |
| `payment-service` outbox | `funding.cashout_failed` on `finvault.events` | `CASHOUT_FAILED` | Bound in N19; the upstream `reason` is deliberately ignored |

The new consumer binds only the exact event types in `financeEventBindings`. Payment outbox rows
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

## Bound in N19

N19 binds `funding.cashout_completed` and `funding.cashout_failed`. Both
schemas (`fundingCashoutCompletedSchema`, `fundingCashoutFailedSchema`) are
registered in `packages/finvault-events/src/schemas.ts` (event version 1) and
were already published by `payment-service` before this task, so no shared
package change was needed. Both bindings use the same transactional handler as
`payment.succeeded`: the Inbox deduplicates by `eventId`, the notification row
is written inside the inbox transaction, and the Socket.IO emit happens
after commit. A payload that fails mapping validation (missing `userId`,
non-integer or negative `amount`) is raised as `NonRetryableError` with code
`INVALID_EVENT_PAYLOAD`, so it is dead-lettered immediately instead of
consuming the retry budget. `funding.cashout_failed` never copies the upstream
`reason` into the notification message.

## KYC review integration and rollout

`user.kyc_reviewed` version 1 contains `authUserId`, `status` (`APPROVED` or
`REJECTED`), and a required nonblank `reason` of at most 500 characters for a
rejection. It carries no document keys, images, ID number, or email. The
notification recipient is the Auth account ID, never the local profile ID.

User writes the decision event in the same transaction as the status/version
update and any `user.kyc_updated` tier event. A rejection with no tier change
still emits a review event. Repeating an already committed status emits none.
The outbox ID is the envelope ID; broker retries reuse it. Notification stores
the inbox and notification atomically and emits to the owner's socket after
commit. Replays are deduplicated; changed payloads with the same ID go to DLQ.

Before deploying the producer, apply User migration
`202611220001_user_outbox_event_type_uniqueness` using the existing `db:migrate`
command with the intended User database configuration. It replaces the unique
index on `(aggregate_id, aggregate_version)` with one including `event_type`.
Existing outbox rows, payloads and delivery states are preserved. Deploy the
updated shared events package and Notification consumer before enabling the
new User producer; retain the User publisher process and the same exchange
(`finvault.events`) in both services. Rebuild images containing the shared
package. A source change alone does not update running containers.

This change produces notifications for new decisions. It does not manufacture
events for historical reviews or change the existing tier policy.

## Utility outcomes — implemented 23 November 2026

| Producer event | Notification type | Source |
| --- | --- | --- |
| `utility.order_succeeded` | `UTILITY_SUCCEEDED` | Utility order becomes SUCCESS |
| `utility.order_failed` | `UTILITY_FAILED` | Utility order becomes FAILED or REFUND_FAILED |
| `utility.order_refunded` | `UTILITY_REFUNDED` | Utility order becomes REFUNDED |

All three version-1 schemas are registered in `finvault-events` and bound by the
Notification consumer. Data contains orderId, userId, integer-string amount,
utilityType and optional paymentId/reason; provider details are not displayed.
Utilities inserts a `UtilityOutbox` row in the same transaction as the state
change/history. The publisher claims leased rows with SKIP LOCKED and marks
published only after RabbitMQ confirms. Lost acknowledgement retries the same
eventId. Notification commits its inbox and notification atomically and emits
to the owner socket after commit. Replays do not emit a second notification.
Utilities also consumes `payment.refunded` to finish refunds without waiting for
the periodic recovery sweep.

Deployment: rebuild the shared events package and Notification first; apply
Utilities migration `202611230001_utility_outbox`, then deploy the Utilities
producer/publisher. The migration is additive. No historical terminal orders are
backfilled. Keep `finvault.events` and persistent storage for pending outbox rows.
The current Compose image applies Utilities migrations at startup.

Existing tests cover rollback on outbox failure, concurrent publisher claims,
lost acknowledgement and inbox deduplication. Browser acceptance exercises real
T1/T2 money flows and the RabbitMQ outage/replay on an isolated Compose stack;
its result JSON states whether latency includes the owner WebSocket.

`funding.topup_succeeded` remains an unregistered proposal. Actual topup
notifications already use the Wallet event stream, including manual topups;
do not add a second producer merely to duplicate that notification.
