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

Wallet routes accept either a valid `x-gateway-token` (verified by
`finvault-internal-auth`) or an `x-internal-key` matching `INTERNAL_KEY`.
Gateway-authenticated users may operate only on their own wallet unless their
role is `ADMIN`; internal calls are allowed through the owner check. Credit and
debit additionally require an internal call or `ADMIN`.

Admin routes require a valid `x-gateway-token` and the `ADMIN` role; they do not
use the internal-key middleware.

| Route | Purpose |
| --- | --- |
| `POST /api/wallets` | Create a USER or MERCHANT wallet idempotently by `userId` |
| `GET /api/wallets/:userId/balance` | Read balance, held balance and available balance |
| `POST /api/wallets/:userId/hold` | Reserve available funds; body includes `amount`, `referenceId`, `expiresAt`, and `destinationUserId` |
| `POST /api/wallets/:userId/capture` | Convert a hold to a PAYMENT ledger transfer |
| `POST /api/wallets/:userId/release` | Release a pending hold |
| `POST /api/wallets/:userId/transfer` | P2P transfer using `toUserId`, `amount`, and `referenceId` |
| `POST /api/wallets/:userId/credit` | Credit from the clearing wallet; internal call or ADMIN only |
| `POST /api/wallets/:userId/debit` | Debit to the clearing wallet; internal call or ADMIN only |
| `GET /api/wallets/:userId/history` | Ledger history |
| `POST /api/wallets/admin/:userId/lock`, `/unlock` | Lock/unlock new money operations |
| `POST /api/wallets/admin/:userId/adjust` | Credit/debit adjustment |
| `GET /api/wallets/admin` | List/search wallets |
| `GET /api/wallets/admin/reconciliation` | Report ledger/balance mismatches |

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
  as the money operation. A queue relay can publish `wallet.credited`,
  `wallet.debited` and `wallet.locked` to notification-service without allowing
  notification failures to roll back money.

The SYSTEM clearing wallet is created lazily. As specified by the accounting
model, a settlement process must provision clearing liquidity before a TOPUP or
refund can move money out of it; this service will not let that wallet go
negative.

## Migration note

The conversion migration removes the accidental auth-era `User`, `Session`,
`WalletTransaction`, and `WalletIdempotency` tables from the wallet database.
Back up a pre-existing development database before applying it: legacy one-sided
transactions cannot be truthfully converted into the new mandatory paired ledger.
