# THIẾT KẾ GIA CỐ JOB HOLD HẾT HẠN (K14)

## 1. Khảo sát hiện trạng (Answers a-h, <= 20 dòng)
1. **(a) releaseExpiredHolds hiện nay**: Quét bằng `findMany` không lock (`take: limit`). Transaction từng hold khóa ví `SELECT FOR UPDATE`, cập nhật `WalletHold` PENDING -> EXPIRED, trừ `heldBalance`, hoàn hạn mức. Chạy ở `wallet-service` qua cron `*/10 * * * * *` (mỗi 10s) trong `wallet-hold.scheduler.ts`.
2. **(b) Thứ tự khóa**: `createHold`, `captureHold`, `refundCapture` đều khóa Ví trước (`lockAndFetchWalletsTx` sắp ID tăng dần) rồi mới tạo/khóa/cập nhật `WalletHold` (Thứ tự: **Ví -> Hold**).
3. **(c) captureHold khi hold hết hạn**: Tự chuyển `WalletHold` sang `EXPIRED`, trừ `heldBalance`, hoàn hạn mức `refundUsage`, commit transaction rồi trả lỗi `409 HOLD_EXPIRED`.
4. **(d) Ngày hoàn hạn mức**: `limitService.refundUsage` hoàn hạn mức theo `hold.usageDay` (lưu từ lúc reserve theo UTC+7), fallback `getVnDay(hold.createdAt)`. Không dùng "hôm nay".
5. **(e) Tính lũy đẳng của releaseHold**: Đã trả `{ hold, replayed: true }` khi hold ở trạng thái `RELEASED` hoặc `EXPIRED`, không cập nhật số dư/hạn mức lần hai.
6. **(f) payment-expiry.job khi ví đã nhả**: Nhận response thành công từ `walletClient.releaseHold`, tiếp tục chuyển `Payment` sang `EXPIRED` và ghi OutboxEvent `PAYMENT_EXPIRED`.
7. **(g) Event wallet -> payment**: Hiện tại **không có** event từ wallet sang payment khi hold hết hạn; payment-service tự quét theo dõi qua `payment-expiry.job` và `p2p.recover`.
8. **(h) Cấu hình hold P2P 5 phút**: Hardcode `300000` ms (`5 * 60 * 1000`) tại `services/payment-service/src/services/p2p.service.ts` và `payment.service.ts`.

---

## 2. Thiết kế chi tiết & Quyết định kiến trúc

### 2.1. Thứ tự khóa và cơ chế Claim hold (FOR UPDATE SKIP LOCKED)
- **Lý do chọn Ví -> Hold**: Toàn bộ luồng chuyển tiền và capture (`captureHold`, `moveMoneyTxInternal`) đều khóa `Wallet` trước, sau đó mới cập nhật `WalletHold`. Nếu sweeper khóa `WalletHold` trước rồi mới khóa `Wallet`, điều kiện đua giữa `captureHold` và `releaseExpiredHolds` chắc chắn sẽ gây **Deadlock (40P01)**.
- **Quy trình claim mỗi hold (Transaction ngắn riêng biệt)**:
  1. Đọc danh sách ứng viên (candidate batch) không khóa:
     ```sql
     SELECT id, "sourceWalletId" FROM "WalletHold"
     WHERE status = 'PENDING' AND "expiresAt" <= NOW()
     ORDER BY "expiresAt" ASC, id ASC
     LIMIT :batchLimit;
     ```
  2. Với từng candidate trong batch:
     - Mở transaction ngắn:
     - **Bước 1 (Khóa Ví)**: `SELECT id, "heldBalance", "userId", "ownerType" FROM "Wallet" WHERE id = :sourceWalletId FOR UPDATE`.
     - **Bước 2 (Khóa Hold với SKIP LOCKED)**:
       ```sql
       SELECT id, amount, "usageDay", "createdAt", status, "expiresAt"
       FROM "WalletHold"
       WHERE id = :candidateId AND status = 'PENDING' AND "expiresAt" <= NOW()
       FOR UPDATE SKIP LOCKED;
       ```
     - Nếu không lấy được row (do instance khác đang xử lý hoặc hold đã thay đổi trạng thái): Bỏ qua (tăng biến đếm `skippedCount`), commit/kết thúc transaction nhanh chóng, không bị block.
     - Nếu lấy được row: Thực hiện giải phóng nguyên tử (atomic):
       - Kiểm tra tính hợp lệ: nếu `heldBalance < amount` hoặc `spentDay < amount`, rollback transaction ngay lập tức và ghi structured log lỗi (không clamp im lặng).
       - Cập nhật `WalletHold` sang `EXPIRED` (`WHERE id = :holdId AND status = 'PENDING'`).
       - Trừ `heldBalance -= amount` trên `Wallet`.
       - Hoàn hạn mức `spentDay -= amount` trên `UserDailyUsage` cho đúng ngày `usageDay`.

### 2.2. Hợp đồng lũy đẳng (Idempotency Contract)
- `releaseHold` / sweeper: Khi hold đã ở trạng thái kết thúc (`EXPIRED` hoặc `RELEASED`), trả về `{ hold, replayed: true }` với HTTP 200, không thay đổi số dư và không hoàn hạn mức lần 2.
- `captureHold`: Khi hold đã bị sweeper nhả (`EXPIRED`), tiếp tục trả về lỗi `HOLD_EXPIRED` (409 Conflict) nhất quán, không làm biến đổi số dư hay hạn mức.
- `payment-expiry.job`: Khi gọi `releaseHold` nhận kết quả lũy đẳng từ ví, cập nhật trạng thái Payment sang `EXPIRED` có điều kiện (`WHERE status = 'PENDING'`) và ghi OutboxEvent đúng một lần duy nhất.

### 2.3. Cấu hình & Ghi log có cấu trúc
- Env cấu hình:
  - `WALLET_HOLD_EXPIRY_BATCH_SIZE`: Mặc định `100`.
  - `WALLET_HOLD_EXPIRY_INTERVAL_MS`: Mặc định `10000` (10s).
- Log định dạng JSON/One-line mỗi chu kỳ quét:
  `{"instanceId": "...", "scanned": N, "released": N, "skipped": N, "errors": N, "durationMs": N}`.
