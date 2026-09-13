# Wallet service

Independent NestJS service for wallet balances, holds and a double-entry ledger.
It owns no `User` table and has no database foreign key to another service.  Before
creating a non-system wallet it calls `GET {USER_SERVICE_URL}/internal/users/:id`;
the response must identify an active user.

## Run with Docker

```powershell
Copy-Item .env.example .env
docker compose up --build
```

The compose file runs an isolated PostgreSQL 16 database and this service.  Its
database is exposed on port `5434` by default, so it does not collide with the
other services.  In production, set a strong `INTERNAL_API_KEY` and a reachable
`USER_SERVICE_URL`; the service intentionally refuses wallet creation without
user verification.

## API

All routes require `X-Internal-Key` when `INTERNAL_API_KEY` is configured.

| Route | Purpose |
| --- | --- |
| `POST /internal/wallets` | Create a USER or MERCHANT wallet idempotently by `userId` |
| `GET /internal/wallets/:userId/balance` | Read balance, held balance and available balance |
| `POST /internal/wallets/:userId/hold` | Reserve available funds; body includes `amount`, `referenceId`, `expiresAt` |
| `POST /internal/wallets/:userId/capture` | Convert a hold to a PAYMENT ledger transfer |
| `POST /internal/wallets/:userId/release` | Release a pending hold |
| `POST /internal/wallets/transfer` | P2P transfer using `fromUserId`, `toUserId`, `amount`, `referenceId` |
| `POST /internal/wallets/:userId/credit` | TOPUP or REFUND from the clearing wallet |
| `POST /internal/wallets/:userId/debit` | PAYMENT from a wallet to the clearing wallet |
| `GET /internal/wallets/:userId/history` | Ledger history; range is limited to 90 days |
| `POST /admin/wallets/:userId/lock`, `/unlock` | Lock/unlock new money operations |
| `POST /admin/wallets/:userId/adjust` | Credit/debit adjustment with `direction`, `reason`, `referenceId` |
| `GET /admin/wallets` | List/search wallets |
| `GET /admin/reconciliation` | Report (never repair) ledger/balance mismatches |

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
