# Nghiệm thu User / KYC / Merchant với backend thật

## Phase 5 / Tuần 2 — trạng thái mới nhất

Từ root backend, dùng cùng điều kiện môi trường như Phase 4 bên dưới,
cài thêm dependencies local của Auth và Gateway cho nhóm hồi quy Auth:

```powershell
rtk proxy node tests/acceptance/phase5.mjs
```

Lượt sau pull `285c87c`, project `finvault-acceptance-66fc3598232e`:
**28 PASS, 1 FAIL (S10), 10 BLOCKED, 1 MANUAL_PENDING, 2 DEFERRED**.
A3/S1/S2/S3/S7/S9/S11/S12/S13/S14 PASS; 106 test B6 và 15 test Auth PASS;
bảo toàn số dư bằng 0. Cụm thử đã stop và giữ volume/evidence.

Wallet đã có tier/usage/consumer; S10 phát hiện cùng eventId cập nhật DB hai lần.
WALLET-A9/WALLET-S6 kiểm tra riêng hạn mức Wallet qua ADMIN, không thay cho
A9/S6 toàn luồng Payment/PIN. S7 kiểm tra release và scheduler thật;
WALLET-S7-INLINE kiểm tra capture hết hạn với đồng hồ giả và DB thật.
`wallet-t1.json` lưu bằng chứng DB của các bài mới; WALLET-TIMEZONE kiểm tra
biên ngày/tháng/năm giờ Việt Nam. Xem [tích hợp T1 Wallet](../../docs/t1-wallet-integration.md).

Lệnh vẫn exit 1 vì lỗi S10 và các phụ thuộc Payment P2P/token/hold.
Các bài BLOCKED cần bổ sung assertion sau khi nhận implementation; chưa được
coi là nghiệm thu đầy đủ. Báo cáo và bản nháp issue cục bộ nằm ở
`.cache/acceptance-week2/<project>/result.json` và `issues.md`.
`--keep` giữ cụm để debug; `--strict` yêu cầu cả mục xác nhận thủ công PASS.
Chi tiết và điểm tiếp tục: [bàn giao Phase 5](../../docs/phase5-huu.md).

## Phase 4 / Tuần 2

Từ root backend, Node 22+, Docker Desktop và dependencies local của packages,
User, Merchant, Admin, Payment đã được cài:

```powershell
rtk proxy node tests/acceptance/phase4.mjs
```

Lệnh tạo project `finvault-acceptance-<random>` với credential, cổng và volume mới,
build/chạy Compose chính, gọi `seed.mjs`, kiểm tra S11–S13/K1, rồi chạy hồi quy B6.
Không reset/xóa volume hay thay `.env` của project đang dùng. Mặc định stop cụm
thử sau chạy; `--keep` giữ chạy để debug. Docker cache vẫn được dùng khi build.

Kết quả ở `.cache/acceptance-week2/<project>/result.json`; mỗi nhóm test có log
riêng. `accounts.json` chứa credential demo sinh ngẫu nhiên, chỉ giữ cục bộ.
Seed tạo an/binh/chi/highlands/admin `@demo.vn`, tier 2/1/0 và số dư
1.250.000/300.000/100.000 VND. Credit đi qua ledger API có bút toán đối ứng;
`checkSystemConservation` phải bằng 0. Highlands có merchant được duyệt và event
thật; ví MERCHANT/QR còn phụ thuộc Đ12/H9, được ghi thiếu trong seed-result.

S12 dùng TTL 2 giây trên cụm thử và xác nhận hai URL trả 403 sau hạn. Cấu hình
production vẫn mặc định 300 giây. B6 dùng database `finvault_test`, schema
`user_test`/`merchant_test`/`admin_test` riêng và RabbitMQ vhost riêng; không
chạy test xóa fixture lên database ứng dụng. `FINVAULT_ACCEPTANCE_CONFIG` là
adapter tùy chọn cho test cũ; bỏ biến này thì cách chạy integration cũ giữ nguyên.

B6 ánh xạ mục 8.2 của `FinVault_Plan_Huu_Tuan1.md`: H1 auth, H2 Inbox,
H3 tier/Outbox, H4 cleanup, H5 Merchant, H6 contract, Compose và demo/review.
Mục cuối là `MANUAL_PENDING`, không được tính pass tự động. K1 chỉ được coi đạt
khi chuyển P2P 1.000.000 VND theo hạn mức tier mới; duyệt KYC/phát event riêng
không đủ. Hiện thiếu Wallet tier/consumer và hợp đồng Payment P2P nên K1 báo
`BLOCKED` và exit 1. Các bài Phase 5 có owner và trạng thái `NOT_IMPLEMENTED`.
`--strict` yêu cầu mọi mục phải PASS; không có tùy chọn biến BLOCKED thành xanh.

H9 được hoãn theo thứ tự ưu tiên Must trong kế hoạch. Xem
[bàn giao phase 4](../../docs/phase4-huu.md) để biết kết quả và việc còn thiếu.

## Bộ browser Tuần 1 (lịch sử)

Các lệnh bên dưới giữ nguyên workflow cũ; `seed.mjs` chạy trực tiếp sẽ gọi
`seed-browser.mjs`. Kết quả lịch sử không thay thế kết quả Phase 4; frontend và
browser upload cũ cần cập nhật hai mặt trước khi nghiệm thu lại giao diện.

Bộ kiểm tra chạy production frontend qua Gateway → Auth/User/Merchant/Admin/Wallet → PostgreSQL và MinIO. Không giả lập response API hoặc persistence. Admin duyệt bằng API thật; giao diện Admin nằm ngoài phạm vi này.

## Chuẩn bị

- Cài/build package chung trước: `rtk npm ci --prefix packages/finvault-internal-auth` từ root backend. User/Merchant/Admin phụ thuộc package local này.

- Node 24, Docker Desktop đang chạy, Chrome hoặc Edge; đặt `BROWSER_PATH` nếu executable không ở đường dẫn mặc định Windows.
- Cài dependencies bằng `rtk npm ci` tại frontend, gateway và từng service: user, merchant, auth, admin, wallet.
- Tại frontend chạy `rtk npm run build`, dùng base URL production `/api` (không đặt `VITE_API_BASE_URL` khác cho bản build nghiệm thu).
- Cổng cần trống: 3000–3004, 3007, 5173, 25433, 19001. Script từ chối thay thế service đang chiếm cổng.
- MinIO dùng image sẵn của bộ integration User Service. Nếu chưa có, tại backend chạy `rtk proxy docker compose -f services/user-service/tests/compose.yml build minio`.

## Chạy từ thư mục backend

```powershell
rtk proxy node tests/acceptance/prepare.mjs
rtk proxy docker compose -f tests/acceptance/compose.yml --env-file .cache/acceptance/infra.env up -d --wait
rtk proxy node tests/acceptance/migrate.mjs
rtk proxy node tests/acceptance/start.mjs
```

Mở terminal riêng để phục vụ frontend và proxy `/api` đến Gateway thật:

```powershell
rtk proxy node tests/acceptance/frontend.mjs
```

Sau đó tại terminal backend:

```powershell
rtk proxy node tests/acceptance/seed.mjs
rtk proxy node tests/acceptance/run.mjs
```

Mỗi lần chạy lại phải chạy `seed.mjs` trước để tạo tài khoản mới. Admin/outsider đăng ký qua Gateway; chỉ tài khoản Admin thử nghiệm mới tạo được nâng role trực tiếp trong database cô lập. Tài khoản người dùng chính đăng ký qua UI. Ảnh KYC là ảnh tổng hợp ghi rõ mục đích thử nghiệm, không phải giấy tờ cá nhân thật.

17 nhóm kiểm tra bao gồm signup/provisioning, login/refresh/logout, Profile, validation/upload KYC, signed URL riêng tư và hết hạn, Admin reject/resubmit/approve, Merchant đăng ký/trùng/trạng thái, quyền sở hữu, offline/retry, mobile, trình duyệt độc lập, truy vấn DB và runtime exception. Một request được thay access token bằng JWT đã hết hạn để buộc backend trả 401 thật; không thay response.

## Kết quả và môi trường

Lượt kiểm chứng 11/10/2026: **17/17 nhóm pass** qua Gateway/Auth/User/Merchant/Admin thật, PostgreSQL và private MinIO. `prepare.mjs` tạo key ES256 riêng cho acceptance; User/Merchant không dùng access-token secret. Chi tiết tại `docs/User_Merchant_Completion_Report.md`.

Giới hạn build frontend trong lượt này: `npm run build` dừng bởi TS6133 ở `src/pages/admin/AdminTopups.tsx` (`actionLoading`, `handleApprove`, `handleReject`). Bundle dùng kiểm thử được tạo bằng `rtk npx vite build` từ source hiện tại; browser pass không đồng nghĩa typecheck frontend đã pass. Không sửa source frontend trong công việc backend này.

- UI: `http://localhost:5173`; Gateway: `http://localhost:3000`.
- `.cache/acceptance/live-result.json`: kết quả, request/status và đối chiếu database; không chứa mật khẩu, cookie, token hoặc query chữ ký ảnh.
- `.cache/acceptance/live-*.png`: ảnh chụp các trạng thái thật.
- `.cache/acceptance/accounts.json`: thông tin đăng nhập tài khoản demo sinh tự động; giữ cục bộ, không commit.
- `.cache/acceptance/config.json` và `infra.env`: secret ngẫu nhiên cho môi trường cô lập; không sửa `.env` dự án.
- `.cache/acceptance/processes.json` và từng `<service>.log`: PID/log service do script khởi chạy. Dừng frontend bằng Ctrl+C; kiểm tra PID service còn đúng tiến trình trước khi dừng. Script không tự dừng các service sau test để có thể xem lại UI.
- Dừng hạ tầng bằng `rtk proxy docker compose -f tests/acceptance/compose.yml --env-file .cache/acceptance/infra.env stop`. Volume được giữ để xem lại dữ liệu. Không xóa file cấu hình secret nếu vẫn dùng các volume này.

`migrate.mjs` mặc định generate Prisma rồi migrate deploy trước khi khởi động service. Nếu chỉ cần deploy SQL khi service đang chạy, dùng `rtk proxy node tests/acceptance/migrate.mjs admin --deploy-only` để không ghi đè Prisma DLL đang được sử dụng.

## Migration Admin cần triển khai kèm

Lần nghiệm thu 26/09/2026 phát hiện schema Admin có model `AdminAuditLog` nhưng chưa có migration tạo bảng. API review vẫn đổi trạng thái khi ghi audit bị lỗi. Migration `202609260002_init_admin_audit` bổ sung bảng và hai index đúng schema; sau deploy đã xác minh trực tiếp đủ audit action.

Database mới dùng `prisma migrate deploy` bình thường. Với môi trường đã từng dùng `prisma db push` tạo sẵn bảng này, cần kiểm tra cấu trúc bảng/index và baseline migration theo quy trình của dự án trước khi deploy; không chạy lại CREATE TABLE lên bảng có sẵn. Bộ nghiệm thu chỉ migrate database `finvault_acceptance` trên cổng 25433.

Phạm vi kết quả là môi trường local có backend/database/storage thật. Không bao gồm production, giao diện Admin, Payment hoặc các RabbitMQ worker.
