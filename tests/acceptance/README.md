# Nghiệm thu User / KYC / Merchant với backend thật

## Bổ sung 24/11/2026 — chốt A8 và đo tải Đ23

Đạt đã chọn W4 **sửa cache cho A8, chưa thêm đảo giao dịch gốc**. Mô tả tạm
hoãn W4 trong mốc 23/11 bên dưới là lịch sử, không phải trạng thái hiện tại.

- Wallet W4 build PASS; 8/8 test PostgreSQL trên DB thử riêng PASS. Có chặn
  `409 REPAIR_CONFLICTS_WITH_HOLDS` trước khi ghi; giữ nguyên ledger/heldBalance,
  anomaly OPEN và chưa tạo adjustment nếu không an toàn. Reference cố định
  `adjust-anomaly-<id>`. Không tắt trigger append-only khi dọn test.
  Quick/full dùng LEFT JOIN và số dư ledger 0 cho ví chưa có bút toán: ca cache
  +5000 không bị mất anomaly nữa. Đã ghi nhận test FAIL trước sửa, PASS sau sửa.
- FE đối soát 10/10 test PASS, bao gồm bấm đúp và thông báo tiếng Việt. `npm run
  check` PASS. OpenAPI Wallet 1/1 PASS; contract FE lint PASS.
- A8/RC1 live qua Web/Gateway/Admin/Wallet/PostgreSQL PASS: baseline cân bằng;
  tạo hold thật 50000; fixture chỉ sửa cache +5000; UI khôi phục đúng một lần,
  ledger/hold bất biến, audit SUCCEEDED; replay Admin 409; RC1 cuối không còn
  anomaly. Evidence: `Frontend/node_modules/.tmp/week4-a8-live/result.json`.
- Sau build Wallet cuối: thêm 4 live edge checks PASS qua Gateway/Admin/Wallet:
  hold thật 25000 > ledger 20000 bị từ chối 409, claim FAILED/anomaly OPEN;
  hủy đúng hold rồi retry an toàn cùng reference, audit REJECTED → SUCCEEDED;
  full scan/repair ví chưa có ledger; quick RC1 cuối cân bằng. Artifact:
  `.cache/acceptance-week2/finvault-acceptance-32c7acf589e5/w4-live-edges-result.json`.

### Đ23 — kết quả tải thật

Project `finvault-acceptance-e5b7b35cfdd2`, k6 image digest được ghi trong
`.cache/acceptance-week2/<project>/load-result.json`. **PASS**, 50 VU/5 phút,
390 HTTP requests, 130 giao dịch thành công. Đã down đúng cụm tải và volumes;
report được giữ riêng. Không phải phép đo thông lượng tối đa của hệ thống.

| Metric | Mẫu | p95 | Tỷ lệ lỗi |
| --- | --- | --- | --- |
| POST checkout | 130 | 69,35 ms | 0% |
| POST confirm | 130 | 97,58 ms | 0% |

Không có 429. Tài khoản có số dư hợp lệ trước khi đo. Sau chạy, người nhận có
130000.00, số debit và số dư từng người gửi khớp; không còn held của sender;
tổng số dư hệ thống giữ nguyên. Seed Auth dùng **service ứng dụng thật** trong
cụm riêng (bcrypt/session/outbox), nằm ngoài thời gian đo. Load checkout/PIN/
confirm đi qua Gateway thật; không dùng JWT tự ký và không sửa rate limit.
50 người dùng có nhịp 120 giây/lượt, lệch pha 2 giây để phù hợp quota IP 120/phút.
Thiết kế constant-vus và p95 dùng [tài liệu k6](https://grafana.com/docs/k6/latest/using-k6/scenarios/).

Hai lỗi chuẩn bị đã được tìm và sửa: bulk HTTP signup vượt quota 30/15 phút;
seed lại dùng cùng reference nạp cho tài khoản mới nên bị idempotency giữ lệnh
cũ. Runner hiện seed qua Auth service, dùng reference mới và bắt buộc kiểm đủ
100000 trước khi đo; không đổi logic sản phẩm để ép kết quả PASS.

Chạy từ Backend khi Docker Desktop đang chạy:

```powershell
node tests/acceptance/week4/load.mjs --fresh --keep
# Lệnh in project và evidence directory. --keep giữ để kiểm thêm, không tự xóa DB nhóm.
# Bỏ --keep: runner tự dọn đúng project thử cả khi test thất bại.
```

Để dùng lại một cụm thử đã chuẩn bị, bỏ `--fresh` và đặt
`LIVE_ACCEPTANCE_RUN_FILE` vào đúng run.json của cụm đó. Runner không tự xóa
cụm có sẵn do người gọi cung cấp.
Chỉ cụm do `--fresh` tạo mới được runner dọn mặc định. Cần dependencies của
các service và Docker network/image; lần dựng đầu có thể cần tải image/build.
Không chia sẻ `.env`, secrets, credential fixture hoặc browser profiles.

### Đ24 và H20

Slide kiến trúc và runbook 15 phút ở Frontend `TaiLieu/week4-demo` và
`docs/handover/huu-fe-demo-runbook.md`. Hai video kỹ thuật dùng thời gian chạy
thật; xem kết quả/thời lượng ở `rehearsal-summary.json`, không quy video ngắn
thành hai buổi trình bày 15 phút. Bản quay lỗi đổi tài khoản của harness vẫn
được giữ FAIL; đã thêm logout trước khi mở Admin ở cuối full scope.

Hai lượt liên tiếp `week4-demo-release-1` và `week4-demo-release-2` đã PASS
16/16 mỗi lượt, mỗi video 310 giây; phát lại Chromium 1280×1040 và kiểm hình
ảnh thực PASS. Hai kết quả không có Wallet 401 trong API trực tiếp hoặc browser
network. Video bàn giao: `Frontend/TaiLieu/week4-demo/rehearsal-1.webm` và
`rehearsal-2.webm`; summary có SHA-256 và đường dẫn nguồn. Đây là diễn tập kỹ
thuật tự động, chưa thay hai lượt thuyết trình 15 phút. Nhánh ví chưa có ledger
được kiểm thêm trên image Wallet cuối sau hai lượt này qua 4 live edge checks.

Full scope chờ 61 giây thật trước setup và giữa các lượt dùng chung IP, không
flush Redis. Một lượt lặp từng nhận 401 INVALID_GATEWAY_TOKEN; 500 mẫu chữ ký
riêng chưa tái hiện lỗi, chưa xác định nguyên nhân. Cụm riêng có observer chỉ
ghi lý do từ chối nếu xảy ra, không đổi quyết định xác thực hoặc retry. Không
ghi sự cố này thành đã sửa bằng cách nới TTL/clock tolerance. Recorder dùng
screencast và decode JPEG trước khi vẽ canvas để tránh tranh chụp/frame đen;
đã kiểm video phát lại có hình ảnh thực.

H20 thuộc **Hữu**. Đã kiểm `.env`, tài liệu text và Word: terminal/secret có sẵn,
payment host là sandbox.vnpayment.vn, nhưng IPN/return đều localhost; không tìm
thấy URL công khai. Đang chờ chủ terminal chốt/cấu hình IPN; không ghi sandbox
thật PASS từ các callback tổng hợp. Không sửa cấu hình nhóm.


## Nghiệm thu bổ sung 23/11/2026 — Web tuần 4

Các mốc bên dưới là kết quả mới trên working tree nhánh fix/week4-integration,
không thay cho main hoặc xóa lịch sử Phase 2/5 bên dưới. Chỉ chạy harness trên
manifest `finvault-acceptance-<12 hex>` trong `.cache/acceptance-week2`.

- FE `npm run check`: lint/typecheck/68 Node tests/build PASS; 16 warning hiện có.
- FE Vitest: 262/262 PASS, 30 file. Contract lint: hợp lệ, 189 warning.
- Browser fixture smoke PASS; live scope all kiểm login/F5/P2P/logout, KYC,
  A3/PIN lock, A4 (natural expiry qua UI, replay qua API), Q1 script confirm và
  expiry 120 giây, manual Admin topup và Utilities/A7. Scope cashout kiểm riêng
  ba trạng thái SUCCEEDED/FAILED/PAYOUT_PENDING qua UI; scope utilities kiểm cả
  owner WebSocket, với hai mẫu latency 372ms/90ms (không phải p95).
- A1/A2/A9/A5 đã kiểm Gateway/DB thật: một trong 20 checkout 60000 trên số dư
  100000; một Payment khi replay; chặn hạn mức với ví đủ tiền; forged header
  không thay Bearer. Tổng Wallet.balance bằng 0.
- Payment topup: 19 test gồm PostgreSQL concurrency, audit rollback và recovery.
  Notification: 98 PASS/1 SKIP; Utilities: 42/42 PASS trên PostgreSQL thật.
- Gateway security: 41/41 PASS. GET status polling không tiêu hao quota ghi của
  cashout; POST vẫn giới hạn. Không tắt xác thực hoặc giới hạn IP để lấy PASS.
- K12 clone DOWN/UP PASS, checksum và số dòng ví/ledger giữ nguyên. Script mới
  không dùng container nhóm hoặc sửa DB nguồn.

### Chuẩn bị và chạy lại

Dùng quy trình `demo-seed.mjs fresh` bên dưới để có stack riêng, migration và
terminal `SYNTH_TMN_CODE`. Không dùng `.env` hoặc terminal thật của nhóm để seed.
Full scope còn yêu cầu stand-in payout được bật **chỉ trong compose.json riêng**:

```json
{
  "services": {
    "payment-service": {
      "environment": { "NODE_ENV": "test", "MOCK_PAYOUT_ENABLED": "true" }
    }
  }
}
```

Ghép phần services này vào compose.json do prepare tạo, giữ nguyên services và
secrets khác; recreate payment-service bằng đúng project/env-file/compose override
của run. Không sửa NODE_ENV hoặc MOCK_PAYOUT_ENABLED trong Compose sản phẩm.
Nếu thiếu cấu hình này, harness trả BLOCKED_SETUP trước khi tạo account.

Tại Frontend:

```powershell
$env:VITE_API_BASE_URL='/api'
$env:VITE_USE_MOCK='false'
npm run build
$env:LIVE_ACCEPTANCE_RUN_FILE='D:\PTPMHDV\Backend\.cache\acceptance-week2\finvault-acceptance-<id>\run.json'
$env:LIVE_PHASE3_SCOPE='all'
npm run test:phase3:live
```

Các scope `admin-topup`, `utilities`, `cashout` dùng để kiểm riêng; kết quả PASS
của scope nhỏ không thay PASS all. Full run mất vài phút do chờ token và QR hết
hạn tự nhiên và tuân thủ cửa sổ rate limit. Proxy của harness hỗ trợ cả HTTP API,
Socket.IO polling và WebSocket upgrade; dữ liệu bí mật không ghi vào evidence.
Artifact mặc định ở Frontend/node_modules/.tmp/phase3-live. Các script live cũ
đã sửa đường dẫn Backend và gọi npm.cmd đúng trên Windows.

K20 legacy đã bỏ fallback tự ký token khi 429, buộc manifest riêng và chặn API
ngoài manifest; không dùng credential/container mặc định. K12 không import helper
reset seed cũ.

K12, từ Backend:

```powershell
node tests/acceptance/k20/k12-rollback-scenario.mjs
```

Dùng cùng LIVE_ACCEPTANCE_RUN_FILE. Script clone qua pg_dump trong RAM, chạy
rollback rồi migration trên DB clone có tên ngẫu nhiên, kiểm checksum và xóa
đúng clone vừa tạo trong finally. Manifest thiếu/sai bị từ chối.

Utilities deploy: consumer/schema trước, migration 202611230001_utility_outbox
rồi image Utilities mới. Không backfill sự kiện giả cho đơn cũ. Tiền tệ dùng
string/Decimal; retry giữ eventId/referenceId. Manual topup giữ PROCESSING nếu
Wallet chưa rõ kết quả, không reset để cộng lại.

W4 tạm giữ theo lựa chọn của Đạt để phân biệt sửa cache và đảo giao dịch gốc;
không kết luận đã có bút toán đảo. VNPAY thật chưa nghiệm thu: IPN/return trong
cấu hình nhóm vẫn là loopback. Đ23 tải 50 VU/5 phút và Đ24 video/diễn tập chưa
có bằng chứng mới; các hạng mục tùy chọn không được ghi PASS.


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
production vẫn mặc định 900 giây. B6 dùng database `finvault_test`, schema
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

## Tuần 4 / N20 — seed bổ sung (Nguyên)

Module `tests/acceptance/week4/seed-nguyen.mjs` export `seedNguyen(ctx)` và
`seedNguyenDrift(ctx)`. `demo-seed.mjs` ghép H15 và N20 thành quy trình chung.
`seed.mjs` vẫn phục vụ acceptance cơ bản; không thay thế bộ demo đầy đủ H15.

Phần seed tạo thêm, chạy trên cụm acceptance đã có seed gốc:

- **5 hồ sơ KYC chờ duyệt** (`week4.kyc01@demo.vn` … `week4.kyc05@demo.vn`): đăng ký qua
  `POST /api/auth/signup`, upload hai mặt qua `POST /api/users/kyc/documents` (ảnh PNG tổng
  hợp 900×560 sinh bằng `sharp`, có dòng "SYNTHETIC IMAGE - NOT AN ID DOCUMENT", mỗi mặt
  upload đúng một lần). Không ghi thẳng DB, không bỏ qua kiểm định JPEG/PNG ≤ 5 MB.
- **5 thông báo mẫu** `WALLET_CREDITED`, tạo qua route nội bộ
  `POST /api/notifications` của notification-service với `x-internal-key` đọc từ secret
  mount. `eventId` cố định (`week4-seed-<slot>-wallet-credited`) nên Inbox khử trùng khi chạy
  lại. Nội dung tiếng Việt, không có dữ liệu nhạy cảm.
- **Đúng 1 ví lệch** `week4.drift@demo.vn`: nạp thật 200.000 ₫ qua ledger API, sau đó
  `UPDATE "Wallet".balance` cộng thêm 5.000 ₫ — **không** sửa/xóa bút toán nào.

Mặc định N20 chỉ tạo KYC/thông báo, không làm lệch ví. Bước gây lệch yêu cầu
`SEED_ALLOW_DRIFT=1` và từ chối `NODE_ENV=production` trước khi truy cập dữ liệu.
Đối với demo, dùng chế độ `a8` riêng bên dưới để kiểm RC1 trước khi gây lệch.

Chạy lại (idempotent): email/slot cố định, tài khoản đã có thì bỏ qua; KYC chỉ upload khi
chưa có hồ sơ hoặc trạng thái `NONE`; credit dùng `referenceId` cố định nên ledger replay;
thông báo khử trùng theo `eventId`; ví lệch phân loại `apply`/`skip` bằng BigInt
(`classifyDrift`). Chạy lần 2 không nhân đôi hồ sơ, thông báo hay khoản nạp.

Thứ tự: H15 → KYC/thông báo N20 → xác minh dữ liệu và RC1 sạch → bước drift riêng
→ phát hiện anomaly → nghiệm thu điều chỉnh A8. Trước drift, tổng số dư mọi ví
kể cả SYSTEM bằng 0. Sau drift, tổng bằng 5.000 ₫; trừ riêng 5.000 ₫ lệch thì
vẫn bằng 0. Không loại cả ví có vốn gốc 200.000 ₫ khỏi phép kiểm bảo toàn.

Chạy từ thư mục Backend, trên project acceptance mới và dữ liệu riêng:

```powershell
node tests/acceptance/demo-seed.mjs fresh
node tests/acceptance/demo-seed.mjs verify-only <run-directory>
$env:SEED_ALLOW_DRIFT = '1'
node tests/acceptance/demo-seed.mjs a8 <run-directory>
node tests/acceptance/demo-seed.mjs verify-only <run-directory> --drift
Remove-Item Env:SEED_ALLOW_DRIFT
```

`fresh` yêu cầu Auth DB trống và tạo stack riêng; không chạy lại fresh trên dữ
liệu đã seed. 50 giao dịch lịch sử là 25 cặp chuyển đi/về luân phiên An–Bình,
Bình–Chi, Chi–An: mỗi người xác minh PIN tối đa 17 lần, dưới giới hạn Auth
20 lần/15 phút. Script chờ khi gần giới hạn PIN theo phút của Gateway, không
tắt rate limit. `verify-only` chỉ đọc DB và cập nhật summary, không tạo/credit/upload
lại dữ liệu. Nó kiểm đúng 5 hồ sơ KYC PENDING với hai ảnh, 5 thông báo mẫu đúng
owner/type, dữ liệu H15 và invariant tiền. Vì vậy sau khi demo đã duyệt hồ sơ
hoặc chi tiền, verify baseline có thể từ chối đúng do dữ liệu đã thay đổi.

`a8` kiểm baseline và RC1, chỉ gây lệch ví N20, rồi xác nhận báo cáo có anomaly
đúng ví. Chạy lại khi fixture vẫn lệch 5.000 ₫ không cộng thêm. Chế độ này chỉ
chuẩn bị/phát hiện fixture, không tự điều chỉnh anomaly và không thay toàn bộ
bài nghiệm thu K17/N18/A8. `verify-only --drift` kiểm trạng thái cố ý lệch; không
gọi đó là RC1 sạch. Topup trong seed vẫn là IPN synthetic có chữ ký, không phải
giao dịch VNPAY sandbox thật.

Lệnh (sau khi cụm acceptance đang chạy và đã có `accounts.json` của seed gốc):

```powershell
$env:SEED_ALLOW_DRIFT = '1'
node tests/acceptance/week4/seed-nguyen.mjs --project finvault-acceptance-<id>
```

Khi tích hợp module với một seed khác, truyền Admin token và tắt drift rõ ràng:

```js
import { seedNguyen } from './week4/seed-nguyen.mjs'
// Sau base seed; không gọi lại seed gốc trên database demo đã có dữ liệu.
await seedNguyen(ctx, { adminToken, includeDrift: false })
```

Kết quả seed ghi tại `.cache/acceptance-week2/<project>/week4-seed.json` (mã ví lệch, trạng
thái KYC, thông báo, tổng số dư thực và tổng đã trừ delta có chủ ý). Credential demo nằm trong `week4-accounts.json`
cùng thư mục, chỉ giữ cục bộ và không commit.

Kiểm thử thuần, không cần Docker:

```powershell
node --test tests/acceptance/week4/seed-nguyen.test.mjs
```

16 test: slot/ảnh tổng hợp, lịch sử giữ nguyên số dư và ngân sách PIN, contract anomaly Admin/Wallet, chốt chặn drift, planner và upload idempotent,
eventId ổn định, project hợp lệ; verifier từ chối thiếu ảnh, sai owner, thông
báo trùng, lệch ví ngoài dự kiến hoặc tiền không giải thích được. Unit dùng
inventory giả, không chứng minh toàn bộ seed qua Gateway/Compose. Nghiệm thu
fresh/rerun trên stack thật phải được ghi riêng theo đúng revision đã chạy;
không lấy kết quả lịch sử trong `docs/evidence/N20/result.log` làm kết quả mới.

### Kiểm tra live ngày 22/11/2026 — H15/N20

Đã build các service từ working tree Backend `bfbbf74` cùng các thay đổi chưa
commit của phiên sửa tuần 4, rồi chạy `seedDemo` qua Gateway thật trên database
trống trong project riêng `finvault-acceptance-01d3f7c3ee46`. Không seed/reset
database của nhóm. Lượt build đầu bị `ECONNRESET` khi tải npm; build lại đạt.

| Kiểm tra | Kết quả |
| --- | --- |
| Dữ liệu H15 | 5 tài khoản gốc, 10 merchant, 3 outlet Highlands, 50 payment SUCCESS, 3 topup APPROVED |
| Số dư đích | An 1.250.000đ; Bình 300.000đ; Chi 100.000đ |
| Dữ liệu N20 | 5 hồ sơ PENDING có hai ảnh tổng hợp; 5 thông báo mẫu đúng owner/type |
| Baseline | Tổng số dư mọi ví kể cả SYSTEM = 0; ledger cân bằng; RC1 full report 1: isBalanced=true, 0 anomaly |
| N20 rerun thật | Không thêm account/profile, upload, credit/ledger; 5 thông báo trả duplicate; số dư và held không đổi |
| CLI verify-only | PASS sau seed/rerun |
| CLI a8 và verify-only --drift | PASS; ví 37 lệch đúng +5.000đ, báo cáo full phát hiện anomaly |
| A8 rerun thật | Không thêm account/credit/ledger/drift; delta vẫn +5.000đ; clean verifier từ chối đúng dữ liệu đang cố ý lệch |
| Unit | 16/16 PASS |

Chạy live đã phát hiện và sửa các lỗi script mà unit trước đó chưa bắt được:
lịch sử hai người vượt ngân sách PIN; credit ngay sau signup khi ví chưa được
provision; đọc anomaly từ response run tóm tắt thay vì GET report detail.
Admin hiện chuẩn hóa type thành `BALANCE_DRIFT` kèm `detail.mode=FULL|QUICK`;
script nhận cả dạng này và enum gốc của Wallet, vẫn bắt buộc đúng ví fixture.
Không thay rate limit hoặc code nghiệp vụ service để làm test vượt qua.

Bằng chứng riêng của lượt chạy nằm trong
`.cache/acceptance-week2/finvault-acceptance-01d3f7c3ee46/seed-live-verification.json`.
Các file credential cùng thư mục chỉ dùng cục bộ, không commit/chia sẻ. Kết
thúc kiểm tra đã dọn container/network/volume của đúng project test này; chỉ
giữ bằng chứng cục bộ. Muốn tái lập, chạy `fresh` tạo project mới;
`verify-only` cần stack tương ứng vẫn còn hoạt động. Kết
quả này đóng phần chuẩn bị/verify seed H15/N20; chưa chứng minh thao tác điều
chỉnh anomaly K17/N18/A8, toàn bộ UI hay VNPAY sandbox thật. Topup seed dùng
IPN synthetic có chữ ký. Không quy đổi các kết quả này thành toàn bộ tuần 4 PASS.
