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
unless their role is `ADMIN`. The hold, hold-extend, capture, release, transfer,
credit, and debit routes additionally require an internal call or `ADMIN`; balance and
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
| `GET /api/wallets/me` | Lấy số dư ví của chính người gọi (Chuẩn luồng mới K15) | Gateway authenticated USER |
| `GET /api/wallets/me/ledger` | Lịch sử sổ cái phân trang Keyset Cursor (Chuẩn luồng mới K15) | Gateway authenticated USER |
| `POST /api/wallets` | Create a USER or MERCHANT wallet idempotently by `userId` | Current: owner, `ADMIN`, or internal; target: `ADMIN`/internal (đang chờ K9) |
| `GET /api/wallets/:userId/balance` | Read balance, held balance and available balance (Route cũ, giữ tương thích ngược) | Owner, `ADMIN`, or internal |
| `POST /api/wallets/:userId/hold` | Reserve funds; body includes `amount`, `referenceId`, `expiresAt`, and `destinationUserId` | Internal or `ADMIN` |
| `POST /api/wallets/:userId/hold/extend` | Push a pending hold's `expiresAt` forward; body is `referenceId` and a later `expiresAt`. Moves no money and never shortens a hold | Internal or `ADMIN` |
| `POST /api/wallets/:userId/capture` | Convert a hold to a PAYMENT ledger transfer | Internal or `ADMIN` |
| `POST /api/wallets/:userId/release` | Release a pending hold | Internal or `ADMIN` |
| `POST /api/wallets/:userId/transfer` | P2P transfer using `toUserId`, `amount`, and `referenceId` | Internal or `ADMIN` |
| `POST /api/wallets/:userId/credit` | Credit from the clearing wallet | Internal or `ADMIN` |
| `POST /api/wallets/:userId/debit` | Debit to the clearing wallet | Internal or `ADMIN` |
| `GET /api/wallets/:userId/history` | Ledger history theo offset/page (Route cũ, giữ tương thích ngược) | Owner, `ADMIN`, or internal |
| `POST /api/wallets/admin/:userId/lock`, `/unlock` | Lock/unlock new money operations | Gateway `ADMIN` |
| `POST /api/wallets/admin/:userId/adjust` | Credit/debit adjustment | Gateway `ADMIN` |
| `GET /api/wallets/admin` | List/search wallets | Gateway `ADMIN` |
| `GET /api/wallets/admin/reconciliation` | Report ledger/balance mismatches | Gateway `ADMIN` |

## Luồng Mới API Ví (/me & /me/ledger) - Nhiệm Vụ K15

### 1. Quy tắc nguồn danh tính (Identity Source)
- **Tuyệt đối an toàn:** Danh tính `userId` **chỉ được trích xuất duy nhất** từ `req.auth.userId` do API Gateway xác thực chữ ký số ES256 của `x-gateway-token` (hoặc Client Bearer Token khi đi qua Gateway).
- Hệ thống lờ đi và loại bỏ mọi tham số `userId` được truyền qua query params, URL path hay body từ phía client nhằm ngăn chặn hoàn toàn việc xem trộm số dư hay sổ cái của người dùng khác.

### 2. Chi tiết Endpoint
#### `GET /api/wallets/me`
Trả về thông tin số dư của chính người dùng hiện tại:
- `balance`: Tổng số dư tài khoản (chuỗi 2 chữ số thập phân).
- `heldBalance`: Số tiền đang bị tạm giữ (hold).
- `availableBalance`: Số dư khả dụng (`balance - heldBalance`).
- `currency`: Đơn vị tiền tệ (ví dụ `VND`).
- `status`: Trạng thái ví (`ACTIVE`, `LOCKED`).
- Nếu người dùng chưa có ví, hệ thống trả về HTTP `404` với mã lỗi `WALLET_NOT_FOUND`.

#### `GET /api/wallets/me/ledger`
Trả về lịch sử sổ cái biến động số dư theo cơ chế phân trang **Keyset Cursor**:
- Tham số query:
  - `limit`: Số lượng bản ghi tối đa (mặc định `20`, trần tối đa `100`). Nếu `<= 0` hoặc sai định dạng trả `400 INVALID_LIMIT`.
  - `cursor`: Chuỗi opaque base64url đại diện cho `(createdAt, id)` của bản ghi cuối cùng ở trang trước. Nếu sai hoặc bị sửa đổi trả `400 INVALID_CURSOR`.
- Cơ chế Keyset: Sắp xếp theo `(createdAt DESC, id DESC)`. Đảm bảo không trùng lặp, không bỏ sót bản ghi, và ổn định ngay cả khi có bút toán mới được tạo đồng thời giữa các lần lật trang.
- **Chống lộ dữ liệu (Data Privacy):** Mỗi bản ghi sổ cái chỉ phản ánh biến động trên ví của chính người gọi; tuyệt đối không tiết lộ `walletId` hoặc `userId` của ví đối ứng (kể cả trong giao dịch P2P chuyển nhận tiền).

### 3. Hướng dẫn sử dụng Cursor (Ví dụ curl nhiều trang)

```bash
# Bước 1: Lấy trang đầu tiên (limit = 10)
curl -X GET "http://localhost:3000/api/wallets/me/ledger?limit=10" \
  -H "Authorization: Bearer <YOUR_ACCESS_TOKEN>"

# Giả sử response trả về:
# {
#   "success": true,
#   "data": {
#     "items": [ ... 10 bản ghi ... ],
#     "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTExLTA2VDA2OjA5OjA1LjE2M1oiLCJpZCI6IjE1MjEifQ"
#   }
# }

# Bước 2: Dùng nextCursor để lấy trang tiếp theo
curl -X GET "http://localhost:3000/api/wallets/me/ledger?limit=10&cursor=eyJjcmVhdGVkQXQiOiIyMDI2LTExLTA2VDA2OjA5OjA1LjE2M1oiLCJpZCI6IjE1MjEifQ" \
  -H "Authorization: Bearer <YOUR_ACCESS_TOKEN>"

# Lặp lại cho đến khi response trả về "nextCursor": null (đã duyệt đến trang cuối cùng).
```

### 4. Ghi chú tương thích ngược
- Các endpoint cũ `GET /api/wallets/:userId/balance` và `GET /api/wallets/:userId/history` (phân trang dạng offset `page`/`limit`) vẫn được bảo lưu nguyên trạng hành vi để đảm bảo tương thích ngược với các luồng nội bộ hiện có, và nằm ngoài phạm vi refactor của K15.

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
- A hold whose payment is still settling can be extended, so it outlives an
  outcome the caller cannot yet observe. Extension is PENDING-only, never
  shortens a hold, and is capped by `WALLET_HOLD_MAX_LIFETIME_MS` (default 24 h).
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
