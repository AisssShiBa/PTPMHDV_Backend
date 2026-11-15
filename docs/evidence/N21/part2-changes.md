# N21 Phần 2 — Đối chiếu thay đổi tài liệu kỹ thuật v2

## Phạm vi và quyết định

- Chỉ cập nhật 7 điểm N21 trong `TaiLieu/FinVault_Tai_Lieu_Ky_Thuat_v2.docx`.
- Giữ nguyên chủ sở hữu `Nguyên` trong dòng đối soát theo chỉ thị; ghi khác biệt phân công thành câu hỏi mở.
- Ghi Access Token HS256 dùng chung là hạn chế hiện tại, theo lựa chọn của người dùng.
- Trước khi sửa, sao lưu DOCX ngoài repository tại `C:\Users\Nguyen\AppData\Local\Temp\FinVault_Tai_Lieu_Ky_Thuat_v2.pre-N21.docx`.
- Base sau khi người dùng duyệt merge `origin/main`: `aa34e7ebfe28bd35bbe675284c6f98798675aedc`.

## Bảng đối chiếu 7 điểm

| Điểm | Vị trí trong DOCX | Nội dung cũ | Nội dung mới | Bằng chứng mã |
|---|---|---|---|---|
| 1. Số service và vị trí funding | Mục 1, đoạn kiến trúc; Bảng 3, các dòng `funding` và `utilities` | “10 service nghiệp vụ”; `funding (mới)` có `funding_db`; `utilities (mới)` | Ghi 8 service trong `services/`, 1 API Gateway và 2 package chung; funding là module của `payment-service`, port 3005 và dùng `payment_db`; đổi tên thành `utilities-service` độc lập, port nội bộ 3008. Giữ chủ sở hữu Hữu của dòng funding. | `Get-ChildItem services -Directory` cho 8 thư mục; `Get-ChildItem packages -Directory` cho 2 thư mục. `gateway/src/app.ts:91-92`; `services/payment-service/src/app.ts:35-37`; `services/payment-service/src/routes/payment.routes.ts:14`; `docker-compose.yml:347-367`. |
| 2. Route funding | Bảng API | Chỉ có `/api/funding/vnpay/create`, `/api/funding/vnpay/ipn`, `POST /api/funding/cash-out` | Thêm các route `POST/GET /api/payments/topups`, `GET /api/payments/topups/:id`; alias VNPAY POST base/`create`, GET `ipn`/`return` trên cả hai prefix; cash-out POST, POST `/:id/confirm`, GET `/:id`. | `gateway/src/app.ts:91-92`; `gateway/src/middlewares/authenticate.ts:29-43`; `services/payment-service/src/app.ts:35-37`; `src/routes/topup.routes.ts:15-22`; `src/funding/routes/vnpay.routes.ts:17-21`; `src/funding/routes/cashout.routes.ts:11-24`. |
| 3. Tên ví SYSTEM | Mục 2.3, mục 4.4 và bảng tổng kết systemCode | Có `SYSTEM_CLEARING_TOPUP`/`SYSTEM_SETTLEMENT`, rồi lại dùng tên không tiền tố | Thống nhất hai tên trong nội dung thành `CLEARING_TOPUP` và `SETTLEMENT`; ghi `FEE` có trong enum. Ghi rõ enum còn `MAIN` nhưng vai trò chưa xác nhận, không khẳng định nó là luồng đang hoạt động. | `services/wallet-service/prisma/schema.prisma:42-46`; migration `20261023170000_add_system_wallet_codes_and_composite_unique/migration.sql:2,34-35`; migration `20261106120000_rename_topup_pool_add_settlement/migration.sql:12,19`; `src/services/ledger.service.ts:18-25,44-46`; comment cần xác nhận tại `src/services/wallet-hold.service.ts:192-193`. |
| 4. Access Token và Gateway Token | Mục 1.1, Bảng 4 token, mục lục vị trí mã ở Phụ lục | Mục 1.1 nói mã còn dùng cờ `x-gateway-verified`; bảng ghi Access Token ký private key và Gateway Token có thể ES256 hoặc RS256 | Ghi Access Token hiện ký HS256 bằng `ACCESS_TOKEN_SECRET` dùng chung giữa Auth và Gateway; đánh dấu là hạn chế hiện tại. Gateway Token được mô tả là ES256/60 giây, ký bằng private key Gateway và verify bằng public key; `kycTier` hiện mặc định 0. Cập nhật dòng Phụ lục trỏ tới middleware để mô tả hành vi hiện tại. | `services/auth-service/src/services/authService.ts:109-113,218-221`; `services/auth-service/src/config/env.ts:4,27`; `gateway/src/config/services.ts:5,27`; `gateway/src/middlewares/authenticate.ts:88-93`; `gateway/src/utils/gatewayToken.ts:64,78-80`; `docker-compose.yml:401,456`. `jwt.sign` không truyền option `algorithm`; HS256 là mặc định của jsonwebtoken khi ký bằng secret đối xứng. |
| 5. Trạng thái sự kiện | Bảng 9 | Tên payment không khớp schema; `funding.topup_succeeded` được ghi như đã phát; thiếu trạng thái publisher/schema/binding | Sửa payment thành `payment.succeeded/failed/expired`; cập nhật publisher/schema/binding cho các event hiện có; thêm cashout success/failure, `payment.refunded`, `utility.order_*`, `user.kyc_reviewed`. Phân biệt “mapping notification tồn tại” với event có schema, publisher và binding. `payment.refunded` có outbox row nhưng publisher bỏ qua event `payment.refund*`; không ghi là đã publish. | `packages/finvault-events/src/schemas.ts:75-85`; `services/payment-service/src/events/finvault.publisher.ts:29-41`; `src/jobs/refund.worker.ts:119-120,176-177`; `services/notification-service/src/services/financeEventsConsumer.ts:21-29,181-182`; `services/notification-service/EVENTS.md:25-26,67-72`; `services/user-service/tests/integration/kyc-reject.test.ts:140-161`; `docs/evidence/N19/inventory.md:35-39`. `rg` không tìm thấy publisher `utility.order_*`, `user.kyc_reviewed` hoặc `funding.topup_succeeded` trong các service tương ứng. |
| 6. Đối soát | Bảng API | Chỉ ghi `POST /api/admin/reconciliation/run`, không có mode và các route đọc/điều chỉnh | Ghi `mode=quick|full` (mặc định `quick`) và đủ POST run, GET reports, GET report detail, POST anomaly adjust. Giữ owner “Nguyên”. | `services/admin-service/src/routes/adminRoute.ts:28-31`; `src/controllers/reconciliationController.ts:33-54`; `src/validations/reconciliation.ts:6-14`. |
| 7. TTL URL KYC | Bảng 3, dòng `user-service` | Không nêu TTL | Ghi mặc định `KYC_URL_TTL_SECONDS=900` giây (15 phút). | `services/user-service/src/config/env.ts:17,41`; `services/user-service/.env.example:13`; `docker-compose.yml:91`. |

## Câu hỏi mở / nội dung ngoài phạm vi

- Bảng phân công trong DOCX vẫn ghi `Nguyên` cho admin-service; prompt nêu phân công thực tế là `Đạt`. Không đổi owner theo yêu cầu.
- Enum còn `MAIN`; một comment trong `wallet-hold.service.ts` nói MAIN dành cho admin adjustment, nhưng `ledger.service.ts` hiện ánh xạ `ADJUSTMENT` và mặc định sang `SETTLEMENT`, không có tham chiếu `SystemWalletCode.MAIN` trực tiếp trong service. Vai trò MAIN cần xác nhận.
- `services/user-service/docs/openapi.json` vẫn ghi TTL mặc định 300 giây ở các mô tả KYC URL (ví dụ dòng 496, 510, 1024); cấu hình và compose là 900. Tài liệu lộ trình Tuần 3 cũng có đoạn “TTL mặc định 300s” dù các đoạn khác ghi 15 phút/900. Không sửa các file ngoài danh sách được phép.
- Các đoạn kế hoạch/kiểm thử khác trong DOCX còn nhắc `x-gateway-verified` hoặc `ES256/RS256`; chỉ sửa vị trí thuộc điểm 4 đã duyệt, không sửa các phần roadmap/kịch bản ngoài phạm vi.
- Không chạy test tự động cho DOCX. Việc xác minh được thực hiện thủ công bằng cách mở ZIP/XML, trích xuất văn bản và so sánh trước/sau.

## Preflight trước commit

Các kiểm tra dưới đây là preflight để chuẩn bị commit; sẽ chạy lại trên commit DOCX và ghi kết quả cuối vào `part2-result.log`.

- DOCX gốc và bản sao lưu có cùng SHA-256: `5ABA80ADD03A213957875ED75A3007C250657D26EB96E7732A638722E84442B4`.
- Bản DOCX đã sửa mở được qua `ZipArchive`/XML parser; 29 bảng và 20 hình giữ nguyên.
- Số đoạn trích xuất tăng từ 783 lên 839 do các dòng route và event được thêm vào bảng hiện có.
- So sánh văn bản theo LCS cho thấy 24 nhóm thay đổi; tất cả nằm tại 7 điểm trong bảng đối chiếu.
- SHA-256 DOCX sau sửa: `7071ED5179C8984165B9CED16C53C814C9EB702BF522FF06647B2B9A44A1CE2D`.
- Chưa có test tự động nào chạy hoặc được gọi là PASS.
