# Thiết Kế Chi Tiết K15: API Ví Cho Luồng Mới (/me & /me/ledger)

## Tóm Tắt Hiện Trạng & Đối Chiếu Hợp Đồng v2 (Tối đa 20 dòng)
1. **Hợp đồng v2**: Quy định `GET /api/wallets/me` trả số dư ví và `GET /api/wallets/me/ledger` tra cứu sổ cái phân trang cursor; định dạng tiền dạng số/chuỗi chuẩn hệ thống (không dùng float). Phân trang dùng opaque cursor, limit mặc định 20, trần 100, trả `nextCursor`; mã lỗi chuẩn 400 (`INVALID_CURSOR`), 401 (`UNAUTHORIZED`), 404 (`WALLET_NOT_FOUND`).
2. **Middleware xác thực**: `wallet-service` dùng `requireGatewayOrInternalKey` để giải mã và xác thực token ES256 `x-gateway-token` (hoặc internal API key). Đối với route người dùng, danh tính lấy từ `req.auth.userId`.
3. **Gateway Proxy**: `gateway/src/app.ts` đã cấu hình proxy `/api/wallets` tới `wallet-service`, tự động bóc tách Bearer token, xác thực Access Token, ký `x-gateway-token` và áp dụng global rate limiting; header client giả mạo bị loại bỏ.
4. **Thứ tự khai báo route**: Trong `wallet.routes.ts`, `/me` và `/me/ledger` PHẢI được khai báo trước `/:userId/*` để tránh bị Express router match nhầm `"me"` thành `:userId`.
5. **Schema & Chỉ mục**: Bảng `Wallet` có unique index `[userId, ownerType]`. Bảng `LedgerEntry` có chỉ mục `@@index([walletId, createdAt])`. Cần bổ sung composite index `(walletId, createdAt DESC, id DESC)` để tối ưu hóa truy vấn keyset cursor.
6. **Phân trang cũ `/:userId/history`**: Dùng offset pagination (`page`, `limit`, `skip = (page-1)*limit`, `total`), có nhược điểm trôi dữ liệu khi có bản ghi mới và chậm khi offset lớn.
7. **OpenAPI**: Đặt tại `services/wallet-service/docs/openapi.json` tuân theo chuẩn OpenAPI 3.0.3, khớp cấu trúc `{ success, data, error }`.

---

## 1. Thiết Kế GET /api/wallets/me
- **Mục đích**: Lấy số dư và thông tin ví người dùng hiện tại một cách an toàn.
- **Xác thực**: Bắt buộc có `req.auth.userId` từ `x-gateway-token`. Bỏ qua hoàn toàn mọi `userId` truyền qua query, body hoặc params.
- **Xử lý**:
  - Truy vấn ví của user: `wallet.findFirst({ where: { userId, ownerType: 'USER' } })`.
  - Tính `availableBalance = balance - heldBalance`.
  - Nếu không tìm thấy: throw `DomainException(404, 'WALLET_NOT_FOUND', 'Ví người dùng không tồn tại')`.
- **Response Format** (chuẩn ApiResponse):
  ```json
  {
    "success": true,
    "data": {
      "id": 123,
      "userId": "usr_abc123",
      "balance": "500000.00",
      "heldBalance": "0.00",
      "availableBalance": "500000.00",
      "currency": "VND",
      "status": "ACTIVE",
      "createdAt": "2026-11-01T00:00:00.000Z",
      "updatedAt": "2026-11-06T00:00:00.000Z"
    }
  }
  ```

---

## 2. Thiết Kế GET /api/wallets/me/ledger (Keyset Cursor Pagination)
- **Mục đích**: Xem lịch sử biến động số dư (sổ cái) của chính mình, ổn định khi có bút toán chèn đồng thời.
- **Query Parameters**:
  - `limit`: Số bản ghi tối đa (mặc định 20, tối đa 100). Nếu `< 1` hoặc không phải số nguyên -> 400 `INVALID_LIMIT`.
  - `cursor`: Chuỗi opaque base64url đại diện cho `(createdAt, id)` của bản ghi cuối trang trước.
- **Cấu trúc Cursor**:
  - Mã hoá: `Buffer.from(JSON.stringify({ createdAt: isoString, id: idString })).toString('base64url')`.
  - Giải mã: Phân tích JSON từ chuỗi base64url. Kiểm tra tính hợp lệ của ISO Date và bigint id. Nếu sai định dạng -> throw `DomainException(400, 'INVALID_CURSOR', 'Cursor phân trang không hợp lệ')`.
- **Truy vấn Keyset**:
  - Trang đầu (không có cursor):
    ```sql
    SELECT * FROM "LedgerEntry"
    WHERE "walletId" = $1
    ORDER BY "createdAt" DESC, "id" DESC
    LIMIT $limit + 1;
    ```
  - Trang tiếp theo (có cursor `{ createdAt: C, id: I }`):
    ```sql
    SELECT * FROM "LedgerEntry"
    WHERE "walletId" = $1
      AND (
        "createdAt" < $C
        OR ("createdAt" = $C AND "id" < $I)
      )
    ORDER BY "createdAt" DESC, "id" DESC
    LIMIT $limit + 1;
    ```
- **Xác định nextCursor**:
  - Nếu số kết quả trả về `> limit`: Lấy bản ghi thứ `limit + 1` làm mốc tạo `nextCursor`, cắt mảng dữ liệu về đúng `limit` phần tử.
  - Nếu số kết quả `<= limit`: `nextCursor = null`.
- **Chống lộ dữ liệu (Privacy Guard)**:
  - Chỉ trả các trường thuộc về bản thân người dùng: `id`, `transactionId`, `direction`, `amount`, `balanceAfter`, `referenceId`, `transferType`, `note`, `createdAt`.
  - KHÔNG trả `walletId` của ví đối ứng hay `userId` nội bộ của người khác.

---

## 3. Chỉ Mục Cơ Sở Dữ Liệu
Bổ sung composite index trên bảng `LedgerEntry`:
```sql
CREATE INDEX IF NOT EXISTS "idx_ledger_wallet_keyset" ON "LedgerEntry" ("walletId", "createdAt" DESC, "id" DESC);
```
Chỉ mục này đảm bảo truy vấn keyset cursor chạy Index Scan tối ưu `O(log N + limit)`, không bao giờ bị table scan.

---

## 4. Xử Lý Lỗi & Ghi Log Có Cấu Trúc
- Các lỗi nghiệp vụ trả HTTP tương ứng: 400 `INVALID_CURSOR`, 400 `INVALID_LIMIT`, 401 `UNAUTHORIZED`, 404 `WALLET_NOT_FOUND`.
- Log có cấu trúc bao gồm: `{ route, userId, errorCode, message }`.
- Tuyệt đối KHÔNG log toàn bộ access token hoặc raw cursor trong log.
