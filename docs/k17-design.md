# Thiết Kế Chi Tiết K17: Báo Cáo Đối Soát Và Điều Chỉnh (Reconciliation Reporting & Adjustment)

## Tóm Tắt Hiện Trạng Hệ Thống (Tối đa 25 dòng)
1. **ReconciliationService hiện tại**: Phát hiện 4 loại bất thường (`NEGATIVE_BALANCE`, `BALANCE_DRIFT_QUICK`, `BALANCE_DRIFT_FULL`, `TRANSACTION_UNBALANCED`). Quick drift đối chiếu `Wallet.balance` với `balanceAfter` của `LedgerEntry` gần nhất; Full drift đối chiếu với $\sum(\text{CREDIT} - \text{DEBIT})$ của toàn bộ sổ cái ví. Đã có bảng `ReconciliationReport` và `ReconciliationAnomaly` nhưng chưa lưu `mode` (`QUICK`|`FULL`), chưa có các trường trạng thái xử lý (`status`, `expected`, `actual`, `difference`, `detectedAt`). Báo cáo trả về chưa serialize mảng `anomalies`.
2. **Route đối soát & phân quyền**: `wallet-service` hiện có `GET /api/wallets/admin/reconciliation` (thuộc `admin.routes.ts`), bảo vệ bởi `requireGateway` + `requireRole('ADMIN')`. Luồng gọi từ client đi qua `gateway` (port 3000, rate limiter, verify token) -> proxy sang `admin-service` (`/api/admin/reconciliation/*`) -> `admin-service` gọi `WalletReconciliationClient` sang `wallet-service` (`/api/wallets/admin/reconciliation/*`).
3. **AdminAuditLog**: Do `admin-service` sở hữu trong DB riêng. Ghi audit theo mô hình intent-first (`PENDING` trước khi gọi wallet-service, cập nhật `SUCCEEDED`/`REJECTED`/`UNKNOWN` sau khi hoàn tất). `wallet-service` ghi log có cấu trúc và lưu bản ghi điều chỉnh nội bộ (`AnomalyAdjustment` / trường resolution).
4. **Kiểu tiền & TransferType**: Dùng `Decimal(20, 2)` (Prisma Decimal), không dùng float; helper `money()` chuẩn hóa 2 số thập phân. `TransferType.ADJUSTMENT` hiện dùng trong `WalletAdminService.adjust()` để ADMIN chuyển tiền đối ứng giữa ví user và ví hệ thống `SETTLEMENT` (`SystemWalletCode.SETTLEMENT`).
5. **Quyền DB trên bảng Wallet**: User DB của `wallet-service` (`wallet_user`) có quyền `GRANT SELECT, INSERT, UPDATE ON TABLE "Wallet"`. Trigger `prevent_ledger_modification` chỉ chặn UPDATE/DELETE trên `LedgerEntry` (bất biến), hoàn toàn cho phép UPDATE trên `Wallet.balance`.
6. **Dữ liệu seed & Bảo toàn hệ thống**: `prisma/seed.ts` seed `LimitPolicy` (3 kycTier); ví hệ thống `SETTLEMENT`, `CLEARING_TOPUP`, `FEE` được seed trong migration với số dư ban đầu 0. `checkSystemConservation()` tính $\sum(\text{Wallet.balance}) = 0$ (hệ khép kín bảo toàn tiền giữa ví user và ví hệ thống).

---

## Chốt Thiết Kế K17

### 1. Mở Rộng Schema Database (Migration riêng biệt)
Bổ sung các trường vào bảng hiện có mà không làm mất dữ liệu cũ:
- **`ReconciliationReport`**:
  - `mode`: `VARCHAR(10)` (mặc định `'QUICK'`, hỗ trợ `'QUICK'` | `'FULL'`).
- **`ReconciliationAnomaly`**:
  - `status`: Enum `AnomalyStatus` (`OPEN`, `RESOLVED`), mặc định `OPEN`.
  - `expected`: `Decimal(20, 2)` nullable.
  - `actual`: `Decimal(20, 2)` nullable.
  - `difference`: `Decimal(20, 2)` nullable (được tính bằng $\text{actual} - \text{expected}$).
  - `detectedAt`: `DateTime` mặc định `now()`.
  - `resolvedAt`: `DateTime` nullable.
  - `resolvedBy`: `VARCHAR(50)` nullable (adminId xử lý).
  - `resolutionNote`: `TEXT` nullable (lý do điều chỉnh).
  - `adjustmentReferenceId`: `VARCHAR(255)` nullable unique (khóa chống trùng lặp `adjust_<anomalyId>`).
- **Bảng `AnomalyAdjustment`** (Lưu vết kiểm toán điều chỉnh độc lập trong `wallet-service`):
  - `id`: `BigInt @id @default(autoincrement())`
  - `anomalyId`: `BigInt @unique`
  - `walletId`: `Int`
  - `delta`: `Decimal(20, 2)`
  - `reason`: `TEXT`
  - `adminId`: `VARCHAR(50)`
  - `referenceId`: `VARCHAR(255) @unique`
  - `createdAt`: `DateTime @default(now())`

### 2. Ánh Xạ Loại Bất Thường
- Bất thường `BALANCE_DRIFT_QUICK` và `BALANCE_DRIFT_FULL` được chuẩn hóa thành `BALANCE_DRIFT` trong response API (chi tiết chế độ phát hiện ghi trong `detail.mode`).
- `NEGATIVE_BALANCE`: Giữ nguyên, phát hiện khi số dư ví người dùng/merchant bị âm (`balance < 0`).
- `TRANSACTION_UNBALANCED`: Giữ nguyên nếu phát hiện giao dịch không cân nợ - có.
- Định dạng trả về của mỗi Anomaly:
  ```json
  {
    "id": "1",
    "reportId": 10,
    "type": "BALANCE_DRIFT",
    "walletId": 5,
    "expected": "100000.00",
    "actual": "120000.00",
    "difference": "20000.00",
    "status": "OPEN",
    "detectedAt": "2026-11-10T08:00:00.000Z",
    "detail": { "mode": "FULL" }
  }
  ```

### 3. Ngữ Nghĩa W4 & Chứng Minh Bằng Số Liệu
#### 3.1. Chứng minh toán học: Tại sao bút toán kép đảo KHÔNG THỂ giải quyết `BALANCE_DRIFT`?
- Giả sử ví $W$ có số dư cache `Wallet.balance = 120.000đ` (do lỗi ghi trực tiếp hoặc crash), nhưng tổng lịch sử sổ cái $\sum \text{LedgerEntry} = 100.000đ$.
- Chênh lệch lệch sổ (Drift): $\text{Drift} = \text{Balance} - \text{LedgerSum} = 120.000 - 100.000 = +20.000đ$.
- Nếu ta cố gắng dùng một bút toán kép `ADJUSTMENT` trừ 20.000đ:
  - Bút toán kép bắt buộc phải ghi 1 dòng `DEBIT 20.000đ` vào `LedgerEntry` của ví $W$ VÀ đồng thời trừ 20.000đ vào `Wallet.balance`.
  - Kết quả sau bút toán:
    - `Wallet.balance` mới = $120.000 - 20.000 = 100.000đ$.
    - Tổng sổ cái $\sum \text{LedgerEntry}$ mới = $100.000 - 20.000 = 80.000đ$.
    - Chênh lệch mới: $\text{Drift}_{\text{mới}} = 100.000 - 80.000 = +20.000đ$.
- **Kết luận**: Mọi bút toán kép đều dịch chuyển cả `Wallet.balance` và $\sum \text{LedgerEntry}$ đi cùng một lượng $\Delta$, do đó độ lệch $\text{Drift}$ luôn được bảo toàn, **chênh lệch không bao giờ biến mất**!

#### 3.2. Cơ chế điều chỉnh được chốt cho W4:
1. **Đối với `BALANCE_DRIFT` (Sổ cái là nguồn sự thật duy nhất - Single Source of Truth)**:
   - Sổ cái `LedgerEntry` là bảng bất biến không được phép sửa/xóa. Lỗi drift sinh ra do cột đệm `Wallet.balance` không đồng bộ với sổ cái.
   - **Thao tác W4**: Trong một transaction DB có khóa hàng ví (`SELECT ... FOR UPDATE`), W4 đồng bộ lại `Wallet.balance = expectedBalance` (tổng sổ cái đã xác thực).
   - Tuyệt đối không INSERT/UPDATE/DELETE vào `LedgerEntry`.
   - Ghi bản ghi `AnomalyAdjustment` và đánh dấu Anomaly thành `RESOLVED`.
   - Kết quả: Sau W4, `Wallet.balance` khớp 100% sổ cái, kiểm tra đối soát sạch 0 drift, LedgerEntry giữ nguyên 100%, bảo toàn tính toàn vẹn.
2. **Đối với `NEGATIVE_BALANCE`**:
   - Nếu số dư thực tế và sổ cái đều âm (người dùng bị thấu chi thật):
     - KHÔNG được phép tự đồng bộ che dấu số âm (vi phạm bảo toàn tiền).
     - Tạo bút toán kép `ADJUSTMENT` bù tiền từ ví hệ thống `SETTLEMENT` sang ví người dùng, hoặc từ chối tự động bằng `ADJUST_NOT_SUPPORTED` và yêu cầu xử lý nghiệp vụ theo quy trình thu hồi.
3. **Xác thực số liệu thời điểm điều chỉnh**:
   - Khi chạy W4, hệ thống kiểm tra lại số liệu hiện tại của ví: nếu chênh lệch hiện tại đã thay đổi so với thời điểm phát hiện (do có giao dịch mới làm thay đổi bản chất), hệ thống từ chối điều chỉnh (throw `STALE_ANOMALY_DATA` / 409) để tránh ghi đè sai lệch dữ liệu.

### 4. Tính Lũy Đẳng (Idempotency) & Tương Tranh (Concurrency)
- Khóa hàng: Transaction sử dụng `SELECT ... FOR UPDATE` trên hàng Anomaly và hàng Wallet theo thứ tự tăng dần của ID (`id ASC`) để triệt tiêu hoàn toàn nguy cơ Deadlock.
- Khóa lũy đẳng: Sử dụng `referenceId = "adjust_<anomalyId>"` duy nhất.
- Trạng thái Anomaly:
  - Chỉ xử lý khi `status == 'OPEN'`.
  - Cập nhật có điều kiện `UPDATE "ReconciliationAnomaly" SET status = 'RESOLVED', ... WHERE id = $1 AND status = 'OPEN'`.
  - Nếu `status == 'RESOLVED'` từ trước: Trả về kết quả điều chỉnh ban đầu (200 OK kèm `replayed: true` hoặc 409 `ANOMALY_ALREADY_RESOLVED` tùy trường hợp request trùng).
  - Khi có 10 request song song: Duy nhất 1 request chiếm được khóa và thực thi điều chỉnh, 9 request còn lại nhận `replayed: true` hoặc `ANOMALY_ALREADY_RESOLVED`.

### 5. Ràng Buộc Lý Do Điều Chỉnh (Reason Validation)
- Bắt buộc phải có `reason` trong request body.
- Độ dài tối thiểu: 10 ký tự sau khi `trim()` (chống chuỗi toàn dấu cách, ký tự vô nghĩa).
- Nếu thiếu hoặc `< 10` ký tự -> Trả về lỗi `400 REASON_REQUIRED`.

### 6. Danh Mục Mã Lỗi & HTTP Status
- `400 REASON_REQUIRED`: Thiếu lý do hoặc lý do dưới 10 ký tự.
- `400 INVALID_CURSOR`: Cursor phân trang keyset không hợp lệ.
- `401 INVALID_GATEWAY_TOKEN`: Không có token hoặc token không hợp lệ.
- `403 FORBIDDEN`: Không có quyền ADMIN (`req.auth.role !== 'ADMIN'`).
- `404 ANOMALY_NOT_FOUND`: Không tìm thấy bản ghi bất thường với ID tương ứng.
- `404 REPORT_NOT_FOUND`: Không tìm thấy báo cáo đối soát với ID tương ứng.
- `409 ANOMALY_ALREADY_RESOLVED`: Bất thường đã được giải quyết từ trước.
- `409 STALE_ANOMALY_DATA`: Số liệu ví đã biến động so với thời điểm phát hiện bất thường.
- `422 ADJUST_NOT_SUPPORTED`: Loại bất thường không hỗ trợ điều chỉnh tự động.

### 7. Đặc Tả Chi Tiết 4 API
1. **W1: `GET /api/wallets/admin/reconciliation`**
   - Query: `isFull` (`boolean`, default: `false`) hoặc `mode` (`'quick'` | `'full'`).
   - Xử lý: Thực hiện quét, tạo bản ghi `ReconciliationReport` và các `ReconciliationAnomaly` tương ứng.
   - Trả về: Toàn bộ thông tin báo cáo kèm danh sách `anomalies`, `isBalanced`, `totalWallets`, `systemBalanceExpected`, `systemBalanceActual`.
2. **W2: `GET /api/wallets/admin/reconciliation/reports`**
   - Query: `cursor` (opaque base64url keyset `runAt + id`), `limit` (mặc định 20, tối đa 100).
   - Xử lý: Lấy danh sách báo cáo mới nhất trước (`runAt DESC, id DESC`).
   - Trả về: `{ items: [...], nextCursor: string | null }`.
3. **W3: `GET /api/wallets/admin/reconciliation/reports/:id`**
   - Params: `id` (int).
   - Xử lý: Lấy chi tiết báo cáo và toàn bộ anomalies của báo cáo đó.
   - Trả về: Thông tin báo cáo đầy đủ. Nếu không có -> 404 `REPORT_NOT_FOUND`.
4. **W4: `POST /api/wallets/admin/reconciliation/anomalies/:id/adjust`**
   - Params: `id` (bigint/string).
   - Body: `{ "reason": "Dieu chinh lech so du theo bien ban kiem toan" }`.
   - Xử lý: Khóa anomaly, đồng bộ số dư `Wallet.balance`, ghi `AnomalyAdjustment`, đánh dấu `RESOLVED`.
   - Trả về: `{ "success": true, "data": { "anomalyId": "...", "status": "RESOLVED", "walletId": 5, "delta": "20000.00", "replayed": false } }`.
