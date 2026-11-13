# KẾ HOẠCH NGHIỆM THU K20 (MỤC G8 - KỊCH BẢN THẬT)

## Tóm Tắt Hiện Trạng & Kế Hoạch Chạy (Tối đa 25 dòng)
1. **Kiểm kê MANUAL_PENDING hiện có**: `docs/week3-final-acceptance.md` ghi nhận `A1-A5`, `MIGRATION-ROLLBACK`, và `Every PR has reviewer/evidence`; `docs/phase4-huu.md` và `phase5-huu.md` có `B6-8`; `week2-p2p-implementation.md` có `R1-UI`.
2. **Phạm vi K20 (5 việc chốt)**: A1 (20 request song song 60k trên ví 100k), A2 (Bấm checkout 2 lần cùng Idempotency-Key), A9 (Hạn mức Cấp 0 chi@demo.vn), A8 (Đối soát làm lệch số dư & W4 adjust), Rollback migration K12 (Đổi tên enum SystemWalletCode trên bản sao DB).
3. **Mục ngoài phạm vi K20**: A3 (Khóa PIN 5 lần), A4 (Token hết hạn/dùng lại), A5 (Giả mạo header Gateway), B6-8/R1-UI/PR review. Các mục này CHỈ ghi nhận trong báo cáo, KHÔNG tự thêm vào phạm vi, KHÔNG tự chạy.
4. **Hiện trạng script trong phạm vi**: A1 trước đây gọi `ledgerService.transfer()` hoặc test unit (bị M23 chặn route ví trực tiếp); A2 có test unit K16 và `s15`; A9 có `walletA9` (gọi admin wallet route); A8 có test unit K17 nhưng thiếu harness E2E; K12 có down SQL nhưng chưa có kịch bản chạy trên bản sao DB.
5. **Dựng lại A1 qua luồng P2P chuẩn (M23)**: Toàn bộ 20 request đi qua `POST /api/payments/p2p/quote` -> `POST /api/payments/p2p/checkout` -> `POST /api/auth/pin/verify` -> `POST /api/payments/:id/confirm`. Tuyệt đối không gọi route ví trực tiếp.
6. **Tình trạng phụ thuộc**: K17 (W1-W4 reconciliation) đã merge (commit `43a94b3`); K12 (script đảo) đã có (`scripts/rollback/down_k12_system_wallet_codes.sql`); K16 (tách HTTP khỏi transaction) đã merge (commit `8aad8f9`, `301fe60`). Đủ 100% phụ thuộc.
7. **Khôi phục seed & Snapshot DB**: Mỗi kịch bản bắt đầu từ trạng thái seed chuẩn (an: 1.25M tier 2, binh: 300k tier 1, chi: 100k tier 0, highlands: merchant, admin: ADMIN). Bản sao DB tạo bằng `pg_dump` hoặc `CREATE DATABASE ... TEMPLATE` trên PostgreSQL test.
8. **Kiểm tra bảo toàn tiền**: Sau mỗi kịch bản, chạy hàm kiểm tra bất biến: $\sum(\text{Wallet.balance}) = 0$ (User + SYSTEM), tổng Debit = Credit trên `LedgerEntry`, không có ví âm (`balance < 0` với User), không có hold treo (`heldBalance = 0`).
9. **Kỹ thuật 20 luồng song song (A1)**: Sử dụng token thật của an@demo.vn, phát đồng thời 20 request với `Idempotency-Key` UUID riêng biệt, chỉ duy nhất 1 checkout thành công lấy `transactionToken` để confirm, 19 request còn lại nhận lỗi 422 `INSUFFICIENT_FUNDS`.

---

## Chi Tiết Kế Hoạch Từng Kịch Bản Nghiệm Thu

### 1. Kịch Bản A2: Bấm Hai Lần (Idempotent Checkout) [K20-2]
- **Điều kiện đầu**:
  - Reset DB về trạng thái seed sạch.
  - Đăng nhập `an@demo.vn` lấy Bearer access token thật.
  - Người nhận: `binh@demo.vn`.
- **Lệnh thực thi**:
  - `node scripts/k20-acceptance-runner.mjs A2`
- **Các bước thực hiện**:
  1. Gửi request 1: `POST /api/payments/p2p/checkout` với `Idempotency-Key: <UUID-A2>`, số tiền `50.000đ`, `destinationUserId: <binh.id>`.
  2. Gửi request 2 (tuần tự ngay sau đó): Cùng header `Idempotency-Key: <UUID-A2>`, cùng payload.
  3. Biến thể song song: Gửi đồng thời 2 request cùng `Idempotency-Key: <UUID-A2-PARALLEL>`.
- **Giá trị ĐÚNG (Kỳ vọng)**:
  - Chỉ có đúng 1 payment được tạo trong database.
  - Lần gửi đầu tiên: trả về HTTP 201, `replayed: false`, `payment.id` xác định.
  - Lần gửi thứ hai: trả về HTTP 201 (hoặc 200), `replayed: true`, cùng `payment.id` với lần 1.
  - Kiểm tra DB: Đúng 1 dòng trong bảng `Payment`, đúng 1 dòng trong `WalletHold` với `status: PENDING`.
- **Kiểm tra bảo toàn tiền**:
  - $\sum(\text{Wallet.balance}) = 0$.
  - Không có bút toán thừa trong `LedgerEntry`.
  - Hủy thanh toán thử nghiệm: `heldBalance` trở về đúng ban đầu.
- **Vị trí lưu log**: `logs/k20/A2-<timestamp>.log`.
- **Tiêu chí**: PASS khi mọi assertion về `replayed: true`, 1 payment DB, 1 hold DB đều đạt.

---

### 2. Kịch Bản A9: Hạn Mức KYC Cấp 0 (chi@demo.vn) [K20-2]
- **Điều kiện đầu**:
  - Reset DB về trạng thái seed sạch.
  - Tài khoản `chi@demo.vn` (KYC Tier 0, hạn mức giao dịch: 200.000đ/lần, 500.000đ/ngày).
  - Nạp thêm 1.000.000đ vào ví chi@demo.vn qua Admin credit route để số dư ví lên 1.100.000đ.
- **Lệnh thực thi**:
  - `node scripts/k20-acceptance-runner.mjs A9`
- **Các bước thực hiện**:
  1. **Nhánh 1 (Vượt hạn mức lần - PER_TXN)**:
     - chi@demo.vn gửi `POST /api/payments/p2p/checkout` chuyển 600.000đ tới binh@demo.vn.
     - Kỳ vọng: Lỗi HTTP 422 `LIMIT_EXCEEDED`, `details.limitType = 'PER_TXN'`.
     - Kiểm tra DB: Số dư ví chi vẫn nguyên 1.100.000đ, `heldBalance = 0`, `UserDailyUsage` không đổi.
  2. **Nhánh 2 (Vượt hạn mức ngày - PER_DAY qua 3 x 200.000đ)**:
     - Giao dịch 1: Chuyển 200.000đ (checkout -> verify PIN -> confirm) -> Thành công. `spentDay = 200.000đ`.
     - Giao dịch 2: Chuyển 200.000đ (checkout -> verify PIN -> confirm) -> Thành công. `spentDay = 400.000đ`.
     - Giao dịch 3: Chuyển tiếp 200.000đ (checkout) -> Tổng ngày sẽ là 600.000đ > 500.000đ.
     - Kỳ vọng lần 3: Lỗi HTTP 422 `LIMIT_EXCEEDED`, `details.limitType = 'PER_DAY'`, `remaining = '100000.00'`.
     - Số dư và usage không thay đổi sau khi lần 3 bị từ chối.
- **Kiểm tra bảo toàn tiền**:
  - $\sum(\text{Wallet.balance}) = 0$ trước và sau.
  - Bút toán `LedgerEntry` ghi đúng 2 cặp giao dịch thành công (4 dòng).
- **Vị trí lưu log**: `logs/k20/A9-<timestamp>.log`.
- **Tiêu chí**: PASS khi bắt đúng lỗi PER_TXN và PER_DAY, số dư và usage bảo toàn nguyên vẹn.

---

### 3. Kịch Bản A1: Chuyển Tiền Song Song 20 Luồng Qua P2P [K20-3] [ĐIỂM DỪNG 1]
- **Điều kiện đầu**:
  - Chuẩn bị ví `an@demo.vn` có đúng 100.000đ (điều chỉnh số dư qua seed/admin credit sạch).
  - Ví `binh@demo.vn` ghi nhận số dư ban đầu $B_0$.
  - PIN của `an@demo.vn` đã được thiết lập sẵn.
- **Lệnh thực thi**:
  - `node scripts/k20-acceptance-runner.mjs A1`
- **Các bước thực hiện**:
  1. Phát đồng thời 20 luồng qua luồng P2P chuẩn:
     - Mỗi luồng tạo một `Idempotency-Key` UUID riêng.
     - Luồng gọi `POST /api/payments/p2p/checkout` với `amount: '60000'`, `destinationUserId: <binh.id>`.
  2. Thu thập kết quả 20 checkout:
     - Kỳ vọng: Đúng 1 checkout thành công (HTTP 201), 19 checkout bị từ chối (HTTP 422 `INSUFFICIENT_FUNDS` hoặc `LIMIT_EXCEEDED`).
  3. Với duy nhất 1 checkout thành công:
     - Gọi `POST /api/auth/pin/verify` lấy `transactionToken`.
     - Gọi `POST /api/payments/:id/confirm` hoàn tất giao dịch.
  4. Lặp lại 10 lần liên tiếp (reset seed trước mỗi lần) để loại trừ yếu tố may rủi.
- **Giá trị ĐÚNG (Kỳ vọng)**:
  - Đúng 1 request thành công, 19 request bị từ chối.
  - Số dư ví `an@demo.vn` còn đúng: 100.000 - 60.000 = 40.000đ.
  - Số dư ví `binh@demo.vn` tăng đúng: +60.000đ.
  - Không ví nào bị âm (`balance >= 0`).
  - Không có hold treo: `heldBalance = 0` trên cả 2 ví.
  - Đúng 1 cặp bút toán cho giao dịch thành công (1 DEBIT ví an, 1 CREDIT ví binh).
  - Đạt 10/10 lần lặp.
- **Kiểm tra bảo toàn tiền**:
  - $\sum(\text{Wallet.balance}) = 0$ trước và sau toàn bộ 10 lần lặp.
- **Vị trí lưu log**: `logs/k20/A1-iter-<1..10>-<timestamp>.log` và `logs/k20/A1-summary-<timestamp>.log`.
- **Tiêu chí**: PASS khi 10/10 lần chạy đều thỏa mãn chính xác các giá trị ĐÚNG.

---

### 4. Kịch Bản A8: Đối Soát Và Điều Chỉnh W4 [K20-4]
- **Điều kiện đầu**:
  - Yêu cầu K17 đã merge.
  - Thực hiện trên database TEST.
- **Lệnh thực thi**:
  - `node scripts/k20-acceptance-runner.mjs A8`
- **Các bước thực hiện**:
  1. Bước 1 - Baseline: Chạy đối soát trên seed sạch (`GET /api/wallets/admin/reconciliation?mode=full`).
     - Kỳ vọng: `isBalanced = true`, `anomalies = []` (0 bất thường).
  2. Bước 2 - Làm lệch số dư: Chọn ví của `binh@demo.vn`, dùng SQL trực tiếp sửa `Wallet.balance = balance + 50000.00` (KHÔNG qua code ứng dụng, không ghi LedgerEntry).
  3. Bước 3 - Quét đối soát: Chạy đối soát `mode=full`.
     - Kỳ vọng: `isBalanced = false`, phát hiện đúng 1 bất thường `type = 'BALANCE_DRIFT'` trên ví binh.
     - `expected = 300000.00`, `actual = 350000.00`, `difference = 50000.00`.
  4. Bước 4 - Điều chỉnh W4:
     - Gọi `POST /api/wallets/admin/reconciliation/anomalies/:id/adjust` không có reason -> Kỳ vọng HTTP 400 `REASON_REQUIRED`.
     - Gọi có reason hợp lệ (>= 10 ký tự): "Dieu chinh lech so du theo bien ban kiem toan k20" -> Kỳ vọng HTTP 200, `status = 'RESOLVED'`, `replayed = false`.
     - Gọi lặp lại điều chỉnh -> Kỳ vọng HTTP 200, `replayed = true` (không tác động thêm).
  5. Bước 5 - Hậu kiểm:
     - Quét đối soát lại `mode=full` -> Kỳ vọng `isBalanced = true`, 0 bất thường mới.
     - Kiểm tra `LedgerEntry`: Số lượng và checksum không đổi so với trước W4 (chứng minh W4 không can thiệp sổ cái).
     - $\sum(\text{Wallet.balance}) = 0$.
- **Vị trí lưu log**: `logs/k20/A8-<timestamp>.log`.
- **Tiêu chí**: PASS khi phát hiện đúng drift, W4 xử lý thành công và đối soát sạch.

---

### 5. Kịch Bản K12: Thử Nghiệm Rollback Migration SystemWalletCode Trên Bản Sao DB [K20-5] [ĐIỂM DỪNG 2]
- **Điều kiện đầu**:
  - Tạo BẢN SAO DB `wallet_service_k12_clone` từ DB đã có giao dịch (chạy A1/A2 trước để có dữ liệu phong phú).
  - Kiểm tra tuyệt đối không tác động lên DB chính.
- **Lệnh thực thi**:
  - `node scripts/k20-acceptance-runner.mjs ROLLBACK_K12`
- **Các bước thực hiện**:
  1. **Trước rollback**:
     - Chạy đối soát trên bản sao DB.
     - Lưu snapshot ví hệ thống: `SELECT id, "systemCode", balance FROM "Wallet" WHERE "ownerType"='SYSTEM'`.
     - Lưu COUNT và checksum `LedgerEntry`.
     - Ghi nhận tổng số dư hệ thống = 0.
  2. **Thực thi script đảo (Down migration)**:
     - Chạy `scripts/rollback/down_k12_system_wallet_codes.sql` trên `wallet_service_k12_clone`.
     - Ánh xạ đảo: `CLEARING_TOPUP -> TOPUP_POOL`, `SETTLEMENT -> MAIN`, `FEE -> FEE`.
  3. **Kiểm tra trạng thái sau Down migration**:
     - Enum `SystemWalletCode` đã chuyển về giá trị cũ `TOPUP_POOL` và `MAIN`.
     - Toàn bộ ví hệ thống giữ nguyên ID và balance, chỉ khác systemCode.
     - `LedgerEntry` nguyên vẹn 100% (cùng COUNT và checksum).
     - Tổng số dư hệ thống vẫn = 0.
  4. **Áp lại migration (Up migration)**:
     - Áp lại migration `20261104103000_rename_system_wallet_codes/migration.sql`.
     - Trạng thái quay trở lại `CLEARING_TOPUP` và `SETTLEMENT`.
     - Chạy lại kiểm tra bất biến và đối soát.
  5. **Dọn dẹp**: Xóa database bản sao `wallet_service_k12_clone`.
- **Vị trí lưu log**: `logs/k20/ROLLBACK-K12-<timestamp>.log`.
- **Tiêu chí**: PASS khi script đảo thực thi thành công, dữ liệu tiền và sổ cái bảo toàn nguyên vẹn.

---

## Danh Mục Lệnh Thực Hiện Toàn Bộ
- Chạy từng kịch bản riêng:
  - `node scripts/k20-acceptance-runner.mjs A1`
  - `node scripts/k20-acceptance-runner.mjs A2`
  - `node scripts/k20-acceptance-runner.mjs A9`
  - `node scripts/k20-acceptance-runner.mjs A8`
  - `node scripts/k20-acceptance-runner.mjs ROLLBACK_K12`
- Chạy tất cả:
  - `node scripts/k20-acceptance-runner.mjs all`
