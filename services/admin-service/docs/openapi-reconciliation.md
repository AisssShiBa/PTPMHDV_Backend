# Admin reconciliation API (N13)

All routes live under `/api/admin` and are protected by the Gateway
(`x-gateway-token`) plus `requireRole('ADMIN')`. The admin identity always comes
from the verified token (`req.auth.userId`); the Gateway token is forwarded to
wallet-service and the internal service key is never sent to wallet admin routes.

> **Integration status:** W1-W4 are the agreed wallet contract, but on `main`
> only `GET /api/wallets/admin/reconciliation` (W1) exists and it does **not**
> return anomalies. W2-W4 do not exist yet. These endpoints are implemented and
> tested against a fake wallet HTTP server only; they are **not integrated with
> the real wallet** until Khoa ships W1 (with anomalies) and W2-W4.

## 1. Run a reconciliation

`POST /api/admin/reconciliation/run?mode=quick|full`

- `mode` is optional and defaults to `quick`; any other value is `400 INVALID_MODE`.
- The wallet is called with `isFull=true` for `full`, `isFull=false` for `quick`.
- An `AdminAuditLog` row (`RUN_RECONCILIATION`, outcome `PENDING`) is written
  **before** the wallet call; it is then updated to `SUCCEEDED`, `REJECTED` or
  `UNKNOWN`. The Gateway token is never stored in the audit detail.
- A local `ReconciliationRunLog` row is kept for each attempt (`RUNNING` →
  `SUCCEEDED` / `FAILED` / `UNKNOWN`).
- Only one run per mode may be in progress: a second concurrent request gets
  `409 RECONCILIATION_IN_PROGRESS`. A `RUNNING` row older than 60 seconds is
  treated as stale and moved to `UNKNOWN`.
- Wallet `4xx` is forwarded (wallet `401/403` becomes a generic `403 FORBIDDEN`).
  Wallet `5xx`/network errors become `502 WALLET_UNAVAILABLE`; client timeouts
  become `504 WALLET_TIMEOUT`. Both leave the audit as `UNKNOWN`.

Example:

```http
POST /api/admin/reconciliation/run?mode=full
x-gateway-token: <ADMIN JWT>
```

```json
{
  "success": true,
  "data": {
    "id": 42,
    "runAt": "2026-11-06T10:00:00.000Z",
    "totalWallets": 10,
    "anomaliesFound": 2,
    "systemBalanceExpected": "0.00",
    "systemBalanceActual": "-15000.00",
    "isBalanced": false,
    "anomalies": [
      { "id": "123", "type": "NEGATIVE_BALANCE", "walletId": 7, "detail": { "balance": "-15000.00" } }
    ]
  }
}
```

## 2. List reports

`GET /api/admin/reconciliation/reports?page=1&limit=20`

- Calls wallet W2 and returns `{ items, page, limit, total }`.
- `page` is clamped to `>= 1`; `limit` is clamped to `1..100`.
- Anomaly IDs are strings because wallet uses `BigInt`.

## 3. Read one report

`GET /api/admin/reconciliation/reports/:id`

- `:id` must be a positive integer (`400 INVALID_REPORT_ID` otherwise).
- Calls wallet W3; a wallet `404` becomes `404 NOT_FOUND`.
- Returns a report with its anomalies.

## 4. Adjust one anomaly

`POST /api/admin/reconciliation/anomalies/:id/adjust`

```json
{
  "direction": "CREDIT",
  "amount": "50000",
  "reason": "Correcting a negative balance"
}
```

- `:id` must be a positive integer (`400 INVALID_ANOMALY_ID`).
- `direction` must be `CREDIT` or `DEBIT` (`400 INVALID_DIRECTION`).
- `amount` must be a positive integer string within `DECIMAL(20,2)` range
  (`400 INVALID_AMOUNT`).
- `reason` is required and must contain 5-500 characters after trimming
  (`400 REASON_REQUIRED` / `400 INVALID_REASON`).
- One local `AnomalyAdjustment` claim is created per anomaly (unique
  `anomalyId`), with the fixed `referenceId = adjust-anomaly-<anomalyId>`.
  Concurrent requests for the same anomaly get `409 ADJUSTMENT_IN_PROGRESS`;
  repeating a successful adjustment gets `409 ALREADY_ADJUSTED`.
- A `FAILED` adjustment (definite wallet rejection) can be retried by using the
  same fixed reference; an `UNKNOWN` outcome is not retried automatically.
- `AdminAuditLog` (`ADJUST_ANOMALY`) is written as `PENDING` before W4. If the
  audit cannot be written the request fails with `503 AUDIT_UNAVAILABLE` and the
  wallet is **not** called.
- Wallet `4xx` marks the adjustment `FAILED` and the audit `REJECTED`.
  Wallet `5xx`/timeout marks the adjustment `UNKNOWN`, the audit `UNKNOWN`, and
  returns `503 ADJUST_OUTCOME_UNKNOWN`.

Example response:

```json
{
  "success": true,
  "data": {
    "anomalyId": "123",
    "status": "SUCCEEDED",
    "referenceId": "adjust-anomaly-123",
    "transactionId": "1f8f6a5e-...",
    "replayed": false
  }
}
```

## Local persistence

| Table | Purpose |
| --- | --- |
| `reconciliation_run_logs` | One row per run attempt (`QUICK`/`FULL`, `RUNNING`/`SUCCEEDED`/`FAILED`/`UNKNOWN`). A partial unique index allows only one `RUNNING` row per mode. |
| `anomaly_adjustments` | One row per anomaly (`anomalyId` unique, `referenceId` unique), status `PENDING`/`SUCCEEDED`/`FAILED`/`UNKNOWN`. |

## Test scope

`npm test` uses a real PostgreSQL database (`admin_test`) and a **fake wallet
HTTP server**. It does not call the real wallet. Acceptance criterion RC1
(`isBalanced=true`, 0 anomalies after every scenario) is not claimed because the
real stack has not been run.
