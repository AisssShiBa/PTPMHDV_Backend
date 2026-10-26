# Phase 4 — T1/B6 và nợ B2

**Cập nhật 26/10/2026:** xem [bàn giao Phase 5](phase5-huu.md) cho trạng thái
mới nhất: 23 PASS, 0 FAIL, 12 BLOCKED. A3 và hồi quy Auth đã PASS; các mục
Phase 5 NOT_IMPLEMENTED bên dưới mô tả mốc Phase 4 lịch sử.

## Phạm vi

Triển khai theo `D:\HDV\Tasks\KeHoach_Tuan2_Huu.md`, ưu tiên T1/B2 trước H9.
B6 đối chiếu mục 8.2 của `FinVault_Plan_Huu_Tuan1.md` do người dùng cung cấp.
Không sửa nghiệp vụ hạn mức/P2P của Wallet/Payment để giả lập hoàn tất K1.

## Bộ chạy và seed

```powershell
rtk proxy node tests/acceptance/phase4.mjs
```

- Mỗi lần tạo project Compose, volume, credential và cổng riêng. Build từ source,
  migrate database ứng dụng và khởi động 8 API cùng các worker bằng Compose chính.
- `tests/acceptance/seed.mjs` xuất seed Tuần 2; chạy file này trực tiếp vẫn giữ
  workflow browser cũ qua `seed-browser.mjs`.
- Seed đúng email an/binh/chi/highlands/admin `@demo.vn`. Mật khẩu ngẫu nhiên;
  chỉ tài khoản Admin vừa đăng ký trong database mới được nâng role bằng SQL.
- An/Bình duyệt KYC qua API thật, An lên tier 2 qua route Admin; Chi giữ tier 0.
  Số dư 1.250.000/300.000/100.000 VND được credit qua ledger API, có debit ví hệ thống.
- Highlands đăng ký và duyệt merchant thật; xác nhận `merchant.status_updated`
  được publisher confirm. Auth hiện chỉ có USER/ADMIN; quyền chủ merchant dựa trên
  `ownerId`. Không chèn role MERCHANT, ví hoặc QR giả để che phần còn thiếu.
- S11–S13 gọi qua Gateway, kiểm tra DB, RabbitMQ và MinIO thật. S12 dùng TTL 2 giây
  trong môi trường thử; cấu hình mặc định vẫn 300 giây. K1 chạy phần nộp/duyệt/phát
  event và báo BLOCKED tại phụ thuộc thiếu, không đánh dấu pass toàn bộ.
- Cuối luồng gọi `checkSystemConservation` thật và đối chiếu SUM(balance) = 0.

Mặc định stop riêng project thử sau khi chạy, giữ volume và evidence. `--keep`
giữ cụm để debug. Không chạy `down -v`, không reset hay thay credential cụm cũ.
Kết quả JSON chỉ lưu route/status/code và trạng thái bài; không lưu token, password,
số CCCD hay URL chữ ký. Credential demo ở `accounts.json` trong `.cache` bị Git bỏ qua.

## B6

| Mục 8.2 Tuần 1 | Nhóm chạy | Bằng chứng |
|---|---|---|
| H1 | B6-1 | User/Gateway/Merchant auth negative tests |
| H2 | B6-2 | Inbox replay, concurrency, rollback, retry, DLQ, restart |
| H3 | B6-3 | Tier + Outbox atomic, no-op, migration, publisher, audit |
| H4 | B6-4 | Cleanup dry-run, orphan scan, grace/reference/intent, storage |
| H5 | B6-5 | Merchant ownership, profile transaction/Outbox, publisher |
| H6 | B6-6 | OpenAPI, User/Merchant routes/envelopes, lookup regression |
| Compose | B6-7 | 8 API health và worker; seed/HTTP kiểm chứng caller thật |
| Checkpoint/demo/review | B6-8 | MANUAL_PENDING, cần bằng chứng demo và Khoa review |

Test hồi quy dùng DB `finvault_test` và schema test riêng trong PostgreSQL của
project mới, bucket test riêng và RabbitMQ vhost riêng (queue service có tên cố
định nên chỉ tách exchange không đủ). Adapter
`tests/acceptance/week2/test-env.cjs` chỉ nhận DB localhost đúng tên test; không cho
test reset chạy lên DB ứng dụng. Cách chạy test cũ không có biến
`FINVAULT_ACCEPTANCE_CONFIG` giữ nguyên.

## B2

- Bỏ fallback khóa nội bộ trong WalletClient và NotificationClient của Payment.
  Cả hai đọc config chung đã xử lý `_FILE`; thiếu khóa làm startup thất bại.
- Compose không còn fallback mật khẩu DB `postgres`; bắt buộc giá trị URL encoded
  do `init-secrets.js` sinh. Không đổi credential của volume đang tồn tại.
  Env file cũ (kể cả harness deployment cũ) thiếu biến này cần bổ sung
  `POSTGRES_PASSWORD_URLENCODED` từ mật khẩu DB đang dùng trước khi chạy; không
  sinh mật khẩu mới cho volume cũ. Bộ Phase 4 tự sinh cấu hình cho volume mới.
- Giá trị VNP hash dự phòng khi khởi tạo mới được sinh ngẫu nhiên. Credential cũ
  được giữ theo chính sách initializer; tích hợp VNPAY vẫn cần credential thật.
- Test kiểm tra file ưu tiên, file thiếu/rỗng từ chối, Payment gửi đúng khóa file,
  thiếu khóa không phát request, và source runtime không có fallback cũ.

Giới hạn rà soát: scan bao phủ source runtime và Compose chính. Fixture local/test,
tài liệu lịch sử và bản tổng hợp `repomix-output.xml` vẫn có chuỗi mẫu/khóa mặc định
cũ; chưa tuyên bố `git grep` toàn repository sạch. Dọn bản tổng hợp lịch sử và role
DB riêng vẫn được ghi nợ; role DB riêng theo kế hoạch chuyển Tuần 3.

## Việc còn thiếu / quyết định H9

- **K1 / Đ12 / Khoa:** Wallet hiện chưa có `kycTier` và consumer cập nhật tier;
  Payment chưa có hợp đồng P2P/PIN Tuần 2 để kiểm chứng chuyển 1.000.000 VND sau duyệt.
  K1 BLOCKED làm lệnh exit 1, dù S11–S13 đạt.
- **B6-8:** checkpoint/demo/review là xác nhận thủ công, chưa có bằng chứng mới.
- **Phase 5:** A3/A4/A9/R1, S1–S10/S14–S16 có slot và owner trong report nhưng chưa
  có implementation trong bộ chạy này; không tính là pass hoặc bỏ qua âm thầm.
- **H9:** hoãn theo thứ tự Must trước Should. Chưa thêm Outlet/QrCode/ApiKey;
  Highlands chưa có QR/ví MERCHANT tự tạo. Event merchant duyệt vẫn được giữ và test.
- Browser/frontend Tuần 1 chưa được nghiệm thu lại theo upload hai mặt. Backend
  pass không thay thế kết quả UI hoặc review PR. Không gửi tin nhóm/mở PR tự động.

## Kết quả kiểm chứng

Ngày 26/10/2026, project mới `finvault-acceptance-0b612662439c`:

- Build/khởi động Compose chính và seed thành công trên volume mới.
- **S11, S12, S13 PASS** qua Gateway/DB/RabbitMQ/MinIO thật.
- **106/106 test hồi quy H1–H6 PASS**, không skip/cancel; **6/6 test B2 PASS**.
- `checkSystemConservation.actual = 0`, `isBalanced = true`; SQL đối chiếu = 0.
- Report: **16 nhóm PASS, 0 FAIL, 1 BLOCKED (K1)**; B6-8 MANUAL_PENDING,
  17 bài Phase 5 NOT_IMPLEMENTED, H9 DEFERRED. Lệnh exit 1 đúng vì K1 chưa đạt.
- Cụm test đã stop, giữ volume. Không dừng/reset cụm `finvault-full-check`.

Evidence cục bộ:
`.cache/acceptance-week2/finvault-acceptance-0b612662439c/result.json` và
`b6-*.log`, `b2.log`, `seed-result.json` cùng thư mục. `accounts.json` là credential
cục bộ, không chia sẻ/commit. Chưa đánh dấu toàn bộ Phase 4/Tuần 2 hoàn thành.

Hai điều chỉnh để hồi quy chạy cùng stack thật: tách RabbitMQ vhost để consumer
ứng dụng không lấy message test; test scanner chờ theo LastModified thực của
object thay vì sleep 20ms. Gateway proxy test có ngân sách khởi động 90 giây
khi chạy acceptance; mọi assertion bảo mật vẫn giữ nguyên.
