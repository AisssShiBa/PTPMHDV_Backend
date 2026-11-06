# Utilities service (N12)

Phone top-up (`TELCO_TOPUP`) and bill payment (`BILL_PAY`) for FinVault.
Every route is mounted behind the Gateway (`requireGateway`); the user identity
always comes from `req.auth.userId`, never from the request body.

## Endpoints

| Method | Route | Notes |
| --- | --- | --- |
| `POST` | `/api/utilities/topup` | Requires `Idempotency-Key` (≤255 chars). Body `{phone, amount}`. Amount is one of `10000, 20000, 50000, 100000, 200000, 500000`. |
| `GET` | `/api/utilities/orders/:id` | Returns the caller's order. Another user's order is `404`. |
| `GET` | `/api/utilities/bills/lookup?provider=&customerCode=` | Deterministic sandbox lookup. |
| `POST` | `/api/utilities/bills/pay` | Same idempotency rule as top-up; body `{provider, customerCode, amount}`. A wrong amount is `409 BILL_AMOUNT_MISMATCH`. |
| `POST` | `/internal/mock-provider/topup` | Only mounted when `MOCK_PROVIDER_ENABLED=true`; `x-internal-key` required. |
| `GET` | `/internal/mock-provider/orders/:orderId` | Sandbox status query. |

Order state machine:

```
PENDING_PAYMENT -> PAID -> PROVIDER_PENDING -> SUCCESS
PENDING_PAYMENT -> FAILED                      (payment failed/expired)
PAID/PROVIDER_PENDING -> REFUND_REQUESTED -> REFUNDED | REFUND_FAILED
```

A provider timeout never triggers a refund (D10); the order stays
`PROVIDER_PENDING` and the recovery job asks the provider again.

## Idempotency and money

- `unique(userId, idempotencyKey)` plus a stable payload hash. Reusing a key
  with a different payload returns `422 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`.
- Checkout is called outside the database transaction with
  `Idempotency-Key = util-<orderId>` and `referenceId = <orderId>`, so a retry
  resumes the same payment.
- The caller's `x-gateway-token` is forwarded unchanged. The internal service
  key is never sent to checkout.
- `discountAmount = floor(amount × 3 / 100)` is stored only; this service does
  not move money and does not post a ledger entry.

## Events

Consumes `finvault.events` with queue `utilities.finvault.events`, bound only to
`payment.succeeded`, `payment.failed`, `payment.expired`. An event whose
`paymentId` belongs to no utilities order is acknowledged and ignored. Inbox
deduplication uses `utility_inbox`.

This service deliberately does **not** publish `utility.*` events: those types
are not registered in `packages/finvault-events`, and publishing them would be
outside this task's scope.

## Sandbox provider

The mock provider is deterministic: the last two digits of the phone/customer
code decide the outcome (`11` = rejected, `22` = timeout on the first attempt,
anything else = success). Results are stored per `orderId`, so a duplicate
callback never delivers twice.

## Known integration gaps

- `payment-service` on `main` only accepts `CARD_TOPUP, BUS_TICKET,
  MOVIE_TICKET, TRAIN_TICKET, WALLET_TRANSFER`. `PHONE_TOPUP` and `BILL_PAYMENT`
  must be added by Khoa (K13). Until then a real checkout returns a definite
  4xx and the order becomes `FAILED`.
- Refund uses the synchronous `POST /api/payments/:id/refund` that exists on
  `main`. There is no internal refund-status endpoint yet, so
  `PaymentClient.getRefundStatus` returns `UNKNOWN`. The refund path is tested
  with a stub, not against the real K13 flow.
- T1/T2 end-to-end scenarios (payment + wallet + K13) have not been run; tests
  use fake payment/provider clients.
