# HỢP ĐỒNG NGHIỆP VỤ SAGA HOÀN TIỀN (K13 REFUND SAGA CONTRACT)
Mã nhiệm vụ: **K13-0**  
Ngày phê duyệt: 2026-11-04  
Các service tham gia: `payment-service`, `wallet-service`, `notification-service`

---

## 1. KHẢO SÁT HIỆN TRẠNG KIẾN TRÚC (ARCHITECTURAL SURVEY)
1. **ORM & Migration Tool (payment-service):** Sử dụng Prisma ORM (`@prisma/client` v6.19.3) với PostgreSQL. Thư mục migration tại `services/payment-service/prisma/migrations/`. Migration mới nhất hiện tại là `20261031_reconcile_transaction_tokens`. Migration CashOut của Hữu hiện **chưa có** trong repository.
2. **Luồng Capture hiện tại:**
   - **P2P:** Khóa ví nguồn và ví đích (thứ tự ID tăng dần); Hold trừ khả dụng ví nguồn (tăng `heldBalance`); Capture trừ `heldBalance` ví nguồn, ghi 2 dòng `LedgerEntry` (Debit ví nguồn, Credit ví đích), `TransferType.PAYMENT`.
   - **Non-P2P:** Hold trên ví nguồn; Capture trừ `heldBalance` ví nguồn, ghi 2 dòng `LedgerEntry` (Debit ví nguồn, Credit ví hệ thống `SETTLEMENT`), `TransferType.PAYMENT`.
   - **Idempotency:** Kiểm tra `hold.status === HoldStatus.CAPTURED`, nếu lặp lại cùng `referenceId` thì trả về kết quả cũ kèm `replayed: true`.
3. **Vị trí chặn `P2P_REFUND_UNSUPPORTED`:** Tại `services/payment-service/src/services/payment.service.ts:648` trong hàm `refund()`.
4. **OutboxEvent & Worker hiện có:**
   - `payment-service`: Bảng `OutboxEvent` sử dụng `FOR UPDATE SKIP LOCKED` kết hợp lease có thời hạn (`lockedUntil`, `lockToken` UUID, batch size 10) trong `claimPaymentOutboxEvents()`. Worker chạy theo chu kỳ cron / trigger drain.
   - `wallet-service`: Bảng `WalletOutboxEvent`, poller `claimPendingRows()` dùng `FOR UPDATE SKIP LOCKED` theo `publishedAt IS NULL`.
5. **Hàm `refund()` hiện tại:** Tại `payment.service.ts:644`, hiện đang gọi trực tiếp `this.walletClient.refundCredit(...)` (tạo credit thẳng vào ví thay vì đảo ngược bút toán Capture), chặn P2P, và cập nhật ngay lập tức `PaymentStatus.REFUNDED` trong cùng transaction cục bộ (chưa phải mô hình Saga hướng sự kiện).
6. **Phân quyền ADMIN & Gọi nội bộ:**
   - `wallet-service`: Middleware `requireGatewayOrInternalKey` xác thực token ES256 hoặc `x-internal-key`; middleware `requireInternalOrAdmin` giới hạn cho `req.isInternalCall` hoặc `req.auth.role === 'ADMIN'`.
   - `payment-service`: Middleware `requireInternalAuth` xác thực `x-internal-key`; middleware `requireGateway` kết hợp `requireRole('ADMIN')` cho luồng quản trị viên.
7. **Tra cứu theo `referenceId` tại Wallet:** Hiện tại **chưa có** endpoint công khai/nội bộ nào cho phép tra cứu trạng thái bút toán theo `referenceId`.
8. **Nơi tính hạn mức ngày:** `services/wallet-service/src/services/limit.service.ts` quản lý hạn mức qua bảng `UserDailyUsage` (`day`, `monthKey`, `spentDay`) và so khớp với `LimitPolicy` theo `kycTier`.

---

## 2. CHỐT HỢP ĐỒNG GIAO TIẾP GIỮA HAI SERVICE (API CONTRACT)

### 2.1. Request hoàn tiền sang `wallet-service`
- **Method & Path:** `POST /api/wallets/:userId/refund`
- **Xác thực:** Bắt buộc Header `x-internal-key` (service nội bộ) HOẶC `x-gateway-token` với Role `ADMIN`. Người dùng thông thường (USER) bị từ chối `403 FORBIDDEN`.
- **URL Param:** `userId` (ID của ví chủ thể nguồn cần nhận lại tiền).
- **Body Schema (JSON):**
  ```json
  {
    "referenceId": "refund_<paymentId>",
    "originalReferenceId": "<original_capture_reference_or_hold_id>",
    "amount": "100000.00"
  }
  ```
- **Quy tắc đối ứng:**
  - **P2P:** Tìm bút toán Capture gốc. Ghi nhận bút toán đảo chiều đúng đối ứng: **Debit (trừ tiền) từ ví đích (người nhận cũ)** và **Credit (cộng tiền) về ví nguồn (người gửi cũ)**.
  - **Non-P2P:** Ghi nhận bút toán đảo chiều: **Debit từ ví hệ thống `SETTLEMENT`** và **Credit về ví nguồn của người dùng**.
  - **TransferType:** Sử dụng `TransferType.REFUND`.
  - **Hạn mức giao dịch:** **KHÔNG** hoàn lại hạn mức ngày (`UserDailyUsage`) cho người dùng.

### 2.2. Response thành công (HTTP 200 OK)
- **Response Schema:**
  ```json
  {
    "success": true,
    "data": {
      "transactionId": "550e8400-e29b-41d4-a716-446655440000",
      "referenceId": "refund_61b1f874-c87d-4a11-8912-3c1234567890",
      "status": "COMPLETED",
      "amount": "100000.00",
      "originalReferenceId": "hold_12345678",
      "createdAt": "2026-11-04T12:00:00.000Z",
      "replayed": false
    }
  }
  ```
- **Lũy đẳng (Idempotency):** Khi gọi lại với cùng `referenceId` và cùng nội dung, Wallet trả về chính xác kết quả ban đầu kèm HTTP 200, trường `replayed: true`, tuyệt đối **không** tạo thêm bút toán hay làm thay đổi số dư ví.

### 2.3. Quy ước phân loại mã lỗi (Error Codes)
- **Mã lỗi 4xx xác định (Deterministic Business Errors) — Payment KHÔNG RETRY, chuyển sang `REFUND_FAILED`:**
  1. `INSUFFICIENT_FUNDS` (422/400): Ví đích không có đủ số dư khả dụng để hoàn tiền về cho người gửi.
  2. `CAPTURE_NOT_FOUND` (404): Không tìm thấy giao dịch Capture gốc với `originalReferenceId` tương ứng.
  3. `AMOUNT_MISMATCH` (400/422): Số tiền yêu cầu hoàn không bằng chính xác số tiền đã Capture (chỉ hỗ trợ hoàn 100% toàn phần).
  4. `ALREADY_REFUNDED` (409): Giao dịch Capture gốc đã được hoàn trước đó bởi một `referenceId` khác (bảo vệ chống hoàn đôi).
  5. `REFERENCE_ID_REUSED` (409): `referenceId` đã tồn tại cho một giao dịch khác hoặc nội dung yêu cầu khác.
- **Mã lỗi 5xx / Timeout (Indeterminate Network/Server Errors):**
  - Mọi lỗi mạng, timeout (504), hoặc lỗi máy chủ (500, 502, 503) đều là **KHÔNG XÁC ĐỊNH**.
  - Worker của Payment **BẮT BUỘC GIỮ NGUYÊN** trạng thái `REFUNDING`, tra cứu lại Wallet trước khi thử lại với cùng một `referenceId`.

### 2.4. Endpoint tra cứu theo `referenceId` tại `wallet-service`
- **Method & Path:** `GET /api/wallets/transactions/lookup?referenceId=refund_<paymentId>`
- **Xác thực:** `x-internal-key` hoặc `ADMIN`.
- **Response khi đã ghi nhận (HTTP 200):**
  ```json
  {
    "success": true,
    "data": {
      "exists": true,
      "transactionId": "550e8400-e29b-41d4-a716-446655440000",
      "referenceId": "refund_61b1f874-c87d-4a11-8912-3c1234567890",
      "status": "COMPLETED",
      "amount": "100000.00",
      "createdAt": "2026-11-04T12:00:00.000Z"
    }
  }
  ```
- **Response khi chưa ghi nhận (HTTP 200):**
  ```json
  {
    "success": true,
    "data": {
      "exists": false
    }
  }
  ```

---

## 3. PAYLOAD SỰ KIỆN OUTBOX (EVENT SPECIFICATIONS)

### 3.1. Sự kiện `payment.refund_requested`
- **Thời điểm phát:** Khi Admin/Service nội bộ yêu cầu hoàn tiền, ghi nhận nguyên tử trong transaction chuyển `Payment.status` từ `SUCCESS` $\rightarrow$ `REFUNDING`.
- **Payload Schema:**
  ```json
  {
    "paymentId": "61b1f874-c87d-4a11-8912-3c1234567890",
    "referenceId": "refund_61b1f874-c87d-4a11-8912-3c1234567890",
    "originalHoldId": "hold_12345678",
    "userId": "usr_sender_123",
    "destinationUserId": "usr_receiver_456",
    "amount": "100000.00",
    "reason": "Yêu cầu hoàn tiền từ quản trị viên",
    "requestedBy": "usr_admin_001",
    "requestedAt": "2026-11-04T12:00:00.000Z"
  }
  ```

### 3.2. Sự kiện `payment.refunded`
- **Thời điểm phát:** Khi Worker gọi Wallet refund thành công, cập nhật `REFUNDING` $\rightarrow$ `REFUNDED`.
- **Payload Schema:**
  ```json
  {
    "paymentId": "61b1f874-c87d-4a11-8912-3c1234567890",
    "referenceId": "refund_61b1f874-c87d-4a11-8912-3c1234567890",
    "walletTransactionId": "550e8400-e29b-41d4-a716-446655440000",
    "userId": "usr_sender_123",
    "destinationUserId": "usr_receiver_456",
    "amount": "100000.00",
    "status": "REFUNDED",
    "refundedAt": "2026-11-04T12:00:05.000Z"
  }
  ```

### 3.3. Sự kiện `payment.refund_failed`
- **Thời điểm phát:** Khi Worker nhận lỗi 4xx xác định từ Wallet, cập nhật `REFUNDING` $\rightarrow$ `REFUND_FAILED`.
- **Payload Schema:**
  ```json
  {
    "paymentId": "61b1f874-c87d-4a11-8912-3c1234567890",
    "referenceId": "refund_61b1f874-c87d-4a11-8912-3c1234567890",
    "userId": "usr_sender_123",
    "destinationUserId": "usr_receiver_456",
    "amount": "100000.00",
    "status": "REFUND_FAILED",
    "failureCode": "INSUFFICIENT_FUNDS",
    "failureReason": "Ví đích không đủ số dư khả dụng để hoàn trả giao dịch",
    "failedAt": "2026-11-04T12:00:05.000Z",
    "needsAttention": true
  }
  ```
