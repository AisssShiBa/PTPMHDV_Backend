# Wallet service

Express service for wallet balances, holds and a double-entry ledger. It owns no
`User` table and has no database foreign key to another service.

## Run with Docker

From the repository root, build the service image:

```powershell
docker build -f services/wallet-service/Dockerfile -t wallet-service .
```

The image applies Prisma migrations on startup and exposes port `3004`. Set
`DATABASE_URL` and `INTERNAL_KEY` for the deployment; `PORT` can override the
server port. Wallet routes are mounted at `/api/wallets`; admin routes are
mounted at `/api/wallets/admin`. The current wallet creation path does not call
the user-service to verify that the supplied user is active.

## API

The Express app mounts wallet routes at `/api/wallets` and admin routes at
`/api/wallets/admin`. Wallet routes first accept either a valid
`x-gateway-token` (verified by `finvault-internal-auth`) or an `x-internal-key`
matching `INTERNAL_KEY`. Gateway users are restricted to their own `userId`
unless their role is `ADMIN`. The hold, capture, release, transfer, credit, and
debit routes additionally require an internal call or `ADMIN`; balance and
history allow the owner, `ADMIN`, or an internal call. Admin routes require a
Gateway token with the `ADMIN` role and do not accept the internal-key path.

**M23 access target:** end users should have only `GET balance` and `GET
history`; money-changing operations must be internal or `ADMIN`. Those money
routes already enforce that policy. `POST /api/wallets` currently allows an
authenticated owner or `ADMIN` (or an internal call) to create a wallet; making
creation internal/`ADMIN`-only remains **đang chờ K9**. This README records the
target without changing wallet routes.

| Route | Purpose |
| --- | --- |
| Route | Purpose | Access |
| --- | --- | --- |
| `POST /api/wallets` | Create a USER or MERCHANT wallet idempotently by `userId` | Current: owner, `ADMIN`, or internal; target: `ADMIN`/internal (đang chờ K9) |
| `GET /api/wallets/:userId/balance` | Read balance, held balance and available balance | Owner, `ADMIN`, or internal |
| `POST /api/wallets/:userId/hold` | Reserve funds; body includes `amount`, `referenceId`, `expiresAt`, and `destinationUserId` | Internal or `ADMIN` |
| `POST /api/wallets/:userId/capture` | Convert a hold to a PAYMENT ledger transfer | Internal or `ADMIN` |
| `POST /api/wallets/:userId/release` | Release a pending hold | Internal or `ADMIN` |
| `POST /api/wallets/:userId/transfer` | P2P transfer using `toUserId`, `amount`, and `referenceId` | Internal or `ADMIN` |
| `POST /api/wallets/:userId/credit` | Credit from the clearing wallet | Internal or `ADMIN` |
| `POST /api/wallets/:userId/debit` | Debit to the clearing wallet | Internal or `ADMIN` |
| `GET /api/wallets/:userId/history` | Ledger history | Owner, `ADMIN`, or internal |
| `POST /api/wallets/admin/:userId/lock`, `/unlock` | Lock/unlock new money operations | Gateway `ADMIN` |
| `POST /api/wallets/admin/:userId/adjust` | Credit/debit adjustment | Gateway `ADMIN` |
| `GET /api/wallets/admin` | List/search wallets | Gateway `ADMIN` |
| `GET /api/wallets/admin/reconciliation` | Report ledger/balance mismatches | Gateway `ADMIN` |

Set `?ownerType=MERCHANT` on single-wallet operations when addressing a merchant
wallet.  All money amounts are decimal strings with no more than two places.

## Accounting and delivery guarantees

- PostgreSQL checks prevent negative balances and prevent held balance exceeding
  total balance.
- `moveMoney` is the only balance mutation path. It obtains `FOR UPDATE` locks
  in ascending wallet-ID order, writes two opposite ledger entries with one UUID,
  and runs at serializable isolation.
- A `referenceId` is the idempotency key for every money side effect. Replays
  return the original result; a different request using the same reference fails.
- Ledger rows are append-only: a database trigger rejects `UPDATE` and `DELETE`.
- Expired holds are released by the scheduled worker. Capture/release of an
  already-resolved hold is safe and never double-adjusts held balance.
- Notification events are written to `WalletOutboxEvent` in the same transaction
  as balance mutations. The relay drains after commit and every second as a
  fallback, publishing legacy notification messages through `wallet.events`
  (with HTTP   fallback). Wallet `PAYMENT` messages are suppressed because the payment flow
  emits the canonical `payment.succeeded` event; TOPUP and REFUND messages are
  still delivered from the wallet outbox.

The SYSTEM clearing wallet is created lazily. As specified by the accounting
model, a settlement process must provision clearing liquidity before a TOPUP or
refund can move money out of it; this service will not let that wallet go
negative.

## Migration note

The conversion migration removes the accidental auth-era `User`, `Session`,
`WalletTransaction`, and `WalletIdempotency` tables from the wallet database.
Back up a pre-existing development database before applying it: legacy one-sided
transactions cannot be truthfully converted into the new mandatory paired ledger.
