# BÁO CÁO REVIEW CHÉO K16 VÀ SỬA LỖI TÍCH HỢP (K21)

> **Mã nhiệm vụ:** K21 – Review chéo K16 và sửa lỗi tích hợp Payment / Wallet  
> **Nhánh thực hiện:** `feat/k21-k16-review`  
> **Thời điểm bắt đầu:** 2026-11-11  
> **Reviewer:** Antigravity Independent Reviewer  

---

## 1. Mốc Kiểm Thử Ban Đầu Trước Khi Sửa (Baseline Measurements)

| Kịch bản / Bộ kiểm thử | Lệnh thực thi | Kết quả ban đầu | Chi tiết & Log tóm tắt |
|---|---|---|---|
| **wallet-service test:concurrency** | `npm run test:concurrency` (wallet-service) | **PASS (3/3)** | Race condition 20 req -> 1 OK 19 FAIL (ví A: 40.000đ); Deadlock cross-transfers -> PASS; Parallel hold -> 1 OK 1 FAIL. |
| **k16-transaction-static-guard** | `tsx --test tests/k16-transaction-static-guard.test.ts` | **PASS (4/4)** | 9 khối transaction trong `p2p.service.ts` đạt 0 vi phạm; 3 trap tests (wallet call, fetch, setTimeout) đều phát hiện chuẩn. |
| **A1: Chuyển tiền song song (10 lần)** | `node scripts/k20-acceptance-runner.mjs A1` | **PASS (10/10)** | 10/10 lần lặp: Đúng 1 luồng thành công (201/SUCCESS), 19 luồng bị từ chối (409 INSUFFICIENT_BALANCE). Số dư An: 40k, Binh: 360k. Delta bảo toàn = 0. |
| **A2: Checkout 2 lần (Bấm hai lần)** | `node scripts/k20-acceptance-runner.mjs A2` | **PASS (2/2 nhánh)** | Cả tuần tự và song song: Đúng 1 payment được tạo, lần 2 trả `replayed: true`. Ví tạo đúng 1 hold. Bảo toàn tài chính tuyệt đối. |
| **A4: Transaction token tái sử dụng** | `tests/acceptance/week2/p2p-scenarios.mjs:a4` | **PASS** | Gửi lại token nhận HTTP 409 `TXN_TOKEN_REUSED`, đúng 2 bút toán sổ cái. |
| **S8: Capture lỗi gián đoạn ví** | `tests/acceptance/week2/p2p-scenarios.mjs:s8` | **PASS** | Wallet chết trả 503 `PAYMENT_PROCESSING`, khi ví sống lại recover chốt `FAILED`, hold được giải phóng (`RELEASED`). |
| **S15: Trùng Idempotency-Key** | `tests/acceptance/week2/p2p-scenarios.mjs:s15` | **PASS** | Cùng paymentId, đúng 1 WalletHold, đổi payload trả 422 `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`. |
| **k16-crash-slow-wallet.test.ts** | `tsx --test tests/k16-crash-slow-wallet.test.ts` | **FAIL (Đỏ trước)** | `PrismaClientInitializationError: Authentication failed against database server for postgres`. Nguyên nhân: Hardcode mật khẩu cũ `8932ce4c...` thay vì `404897ba...`. |
| **k16-transaction-guard.test.ts** | `tsx --test tests/k16-transaction-guard.test.ts` | **FAIL (Đỏ trước)** | `PrismaClientInitializationError` (sai mật khẩu DB) và `POST /api/wallets/.../hold 401 UNAUTHORIZED` (do gán đè `INTERNAL_KEY` trong `before()` lệch với module `secrets.ts`). |
| **k16-complete-hold-decoupled.test.ts** | `tsx --test tests/k16-complete-hold-decoupled.test.ts` | **FAIL (Đỏ trước)** | `PrismaClientInitializationError: Authentication failed against database server for postgres`. |
| **k16-resume-decoupled.test.ts** | `tsx --test tests/k16-resume-decoupled.test.ts` | **FAIL (Đỏ trước)** | `PrismaClientInitializationError: Authentication failed against database server for postgres`. |
| **k16-workflow-schema.test.ts** | `tsx --test tests/k16-workflow-schema.test.ts` | **FAIL (Đỏ trước)** | `PrismaClientInitializationError: Authentication failed against database server for postgres`. |

---

## 2. Kiểm Kê Toàn Bộ Vị Trí Gọi Ví Trong `payment-service`

| STT | Vị trí (File:Dòng) | Phương thức gọi | Trạng thái (Trong / Ngoài Tx) | Cơ chế lũy đẳng (`referenceId`) | Rủi ro & Nhận xét |
|---|---|---|---|---|---|
| 1 | `p2p.service.ts:141` | `wallet.createHold` | **NGOÀI Tx** (Pha 2) | Lũy đẳng theo `payment.holdId` | An toàn. DB cập nhật trước sang `HOLD_CALLING`, timeout không làm mất hold. |
| 2 | `p2p.service.ts:337` | `wallet.lookupTransaction` | **NGOÀI Tx** (Pha 2) | GET tra cứu theo `payment.holdId` | Read-only an toàn. Tránh capture kép khi retry. |
| 3 | `p2p.service.ts:348, 396` | `wallet.captureHold` | **NGOÀI Tx** (Pha 2) | Lũy đẳng theo `payment.holdId` | An toàn. DB claim lease `CAPTURE_CALLING`, chỉ capture khi chưa `COMPLETED`. |
| 4 | `p2p.service.ts:360, 387, 502` | `wallet.releaseHold` | **NGOÀI Tx** (Pha 2) | Lũy đẳng theo `payment.holdId` | An toàn. Được gọi khi 4xx xác định hoặc hủy giao dịch. |
| 5 | `payment.service.ts:142` | `walletClient.createHold` | **NGOÀI Tx** | Lũy đẳng theo `payment.holdId` | Ghi DB trước `PROCESSING`, sau đó gọi ví ngoài Tx. |
| 6 | `payment.service.ts:203, 345, 385` | `walletClient.releaseHold` | **NGOÀI Tx** | Lũy đẳng theo `payment.holdId` | Nhả hold khi hết hạn / deterministic error ngoài Tx. |
| 7 | `payment.service.ts:294` | `walletClient.captureHold` | **NGOÀI Tx** | Lũy đẳng theo `payment.holdId` | Chuyển `PROCESSING` trước, capture ngoài Tx, sau đó Tx ngắn chốt `SUCCESS`. |
| 8 | `payment.service.ts:456, 552, 592` | `walletClient.releaseHold` | **NGOÀI Tx** | Lũy đẳng theo `payment.holdId` | Xử lý nội bộ (internalConfirm), hoàn toàn ngoài Tx. |
| 9 | `payment.service.ts:506` | `walletClient.captureHold` | **NGOÀI Tx** | Lũy đẳng theo `payment.holdId` | Xử lý nội bộ ngoài Tx. |
| 10 | `payment.service.ts:734` | `walletClient.releaseHold` | **NGOÀI Tx** | Lũy đẳng theo `payment.holdId` | Hủy thanh toán ngoài Tx. |
| 11 | `payment.service.ts:793, 799` | `walletClient.getBalance` | **NGOÀI Tx** | Read-only | Truy vấn số dư người gửi / nhận ngoài Tx. |
| 12 | `jobs/payment-expiry.job.ts:52` | `wallet.releaseHold` | **NGOÀI Tx** | Lũy đẳng theo `payment.holdId` | Nhả hold trước, sau đó Tx ngắn cập nhật `PENDING` -> `EXPIRED`. |
| 13 | `jobs/refund.worker.ts:95` | `wallet.lookupTransaction` | **NGOÀI Tx** | Lũy đẳng theo `referenceId` | Tra cứu trạng thái ví trước khi hoàn tiền ngoài Tx. |
| 14 | `jobs/refund.worker.ts:152` | `wallet.refundCapture` | **NGOÀI Tx** | Lũy đẳng theo `referenceId` | Bút toán hoàn tiền thực hiện ngoài Tx, sau đó Tx ngắn chốt `REFUNDED`. |
| 15 | `services/topup.service.ts:348` | `walletClient.topupCredit` | **NGOÀI Tx** | Lũy đẳng theo `code` (VNPAY IPN) | Topup credit thực hiện ngoài Tx, sau đó `updateMany` nguyên tử chốt `APPROVED`. |

**Đánh giá tổng quan:**
- 100% các lời gọi sang `wallet-service` trong toàn bộ `payment-service` đều đã nằm ngoài `prisma.$transaction`.
- Tuy nhiên, script tĩnh `guard-p2p-transactions.cjs` mới chỉ quét `p2p.service.ts`. Cần mở rộng bộ quét tĩnh tự động ra toàn bộ thư mục `services/payment-service/src` để ngăn ngừa hồi quy vĩnh viễn trên toàn bộ service.

---

## 3. Kế Hoạch Xử Lý Và Lộ Trình Commit K21

1. **Commit 0 [K21-0]**: Tài liệu kiểm kê phạm vi, baseline mốc ban đầu (`docs/k21-review-report.md`).
2. **Commit 1 [K21-1]**:
   - Sửa lỗi credentials (DB password & `INTERNAL_KEY` dynamic resolution) trong các file test K16.
   - Mở rộng script guard AST kiểm tra tĩnh ra toàn bộ `services/payment-service/src` (`guard-all-payment-transactions.cjs`).
   - Bổ sung test tự động kiểm tra tĩnh + động ngăn chặn gọi ví trong transaction.
3. **Commit 2 [K21-2]**: Đánh giá độc lập 5 tiêu chí đầu của checklist K16 (Tiêu chí 1–5), trả lời chi tiết 4 câu hỏi chuyên sâu (referenceId không timestamp, khe hở Pha 1-2, lease hết hạn khi Pha 2 chậm, rủi ro treo vĩnh viễn).
4. **Commit 3 [K21-3]**: Đánh giá 6 tiêu chí còn lại (Tiêu chí 6–11), chạy lại toàn bộ crash-test, mốc A1/A2/A4/S8/S15 và test concurrency.
5. **Commit 4 [K21-4]**: Khắc phục các lỗi tích hợp phát hiện (đảm bảo `WalletClient` phân giải `INTERNAL_KEY` động tại thời điểm gọi request, bảo vệ chống lệch auth).
6. **Commit n-1 [K21-5]**: Nghiệm thu toàn diện: Chạy toàn bộ test suites của 2 service, AST guard toàn bộ files, kiểm tra bảo toàn số dư hệ thống $\sum(\text{Wallet}) = 0$.
7. **Commit n [K21-6]**: Hoàn thiện báo cáo review `docs/k21-review-report.md` và cập nhật kết luận trong `docs/k16-review-checklist.md` (giữ nguyên trống phần chữ ký chuyên gia).
