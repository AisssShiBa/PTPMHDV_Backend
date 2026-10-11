# Kế hoạch hoàn thiện User Service và Merchant Service

Ngày lập: 11/10/2026. Đối chiếu `D:\HDV\Tasks\FinVault_Plan_Huu_Tuan1.md` với workspace hiện tại, bao gồm thay đổi chưa commit.

## Trạng thái thực hiện 11/10/2026

Đã thực hiện P1–P3 và nghiệm thu kỹ thuật P4: package/auth, caller integration, Docker/worker/storage, DTO/OpenAPI, regression và 17 nhóm browser acceptance. [Báo cáo kết quả](User_Merchant_Completion_Report.md) phân biệt rõ bằng chứng đã chạy và việc còn chờ nhóm.

Chưa đóng các mục phối hợp/review bên dưới. Full frontend build còn lỗi TS6133 có sẵn tại AdminTopups.tsx; bundle Vite dùng cho browser test đã build thành công. Chưa triển khai production, commit/push hoặc tạo PR; đã chuẩn bị mô tả PR để review worktree.

## 1. Mục tiêu và baseline

Hoàn tất phần còn thiếu của H1–H6, chạy được qua Gateway với database, broker và storage thật; có bằng chứng nghiệm thu cho từng luồng.

| Hạng mục | Baseline | Việc còn lại |
|---|---|---|
| H1: User auth | Vẫn kiểm tra marker cũ và access JWT HS256 | Tích hợp package chung, context, internal caller và test |
| H2: Registration Inbox | Có consumer, transaction, replay/retry/DLQ và integration test | Chạy lại regression và kiểm tra runtime worker |
| H3: KYC tier/Outbox | Có migration, default 0, transaction và test | Kiểm chứng migration ở môi trường nghiệm thu, xác nhận event contract |
| H4: Cleanup | Có scanner, dry-run, grace period và khóa bảo vệ upload | Cấp storage/config đúng và chạy nghiệm thu |
| H5: Merchant | Profile update + Outbox đã có; auth vẫn cũ | Chuyển auth, chạy publisher và regression |
| H6: Contract | Có route `/me`, `/me/kyc` và OpenAPI | Đồng bộ DTO/auth errors, kiểm chứng response, bàn giao frontend |

Bằng chứng đã chạy trong lượt rà soát 11/10: User 26/26 test, Merchant 17/17 test; typecheck cả hai pass. Chưa chạy lại integration DB/RabbitMQ/MinIO trong lượt này. Đã tái hiện tại middleware của cả hai service: token do Gateway hiện tại ký bị từ chối vì thiếu `x-gateway-verified`.

Không đánh dấu H1 hoàn thành dựa trên unit test cũ: fixture hiện tự gắn marker mà Gateway đã bỏ.

## 2. Phạm vi và nguyên tắc thực hiện

- Phần chính: hai service, package `packages/finvault-internal-auth`, cấu hình Docker/compose và test tích hợp liên quan.
- Gateway/Auth/Admin chỉ sửa các điểm cần để luồng hai service hoạt động; phối hợp chủ sở hữu khi thay interface dùng chung.
- Giữ consumer/Inbox, User Outbox, Merchant Outbox/publisher, route và cleanup đã có. Không xây lại các phần này.
- Bảo toàn thay đổi chưa commit; ghi baseline và phân biệt thay đổi cũ/mới trước khi triển khai.
- Giữ policy hiện được ghi nhận trong `week1-status.md`: tier độc lập với trạng thái KYC, profile cũ/mới mặc định tier 0, kể cả APPROVED.
- Chưa thêm UI/API Admin nâng tier hoặc User publisher. DoD H3 vẫn là ghi Outbox atomic. Publisher registration phía Auth nằm ngoài phạm vi.
- Chỉ reset dữ liệu trong DB/schema/bucket/exchange test đã kiểm tra. Không chạy reset trên DB ứng dụng.

## 3. Thứ tự và ước lượng

| Bước | Công việc | Ước lượng | Phụ thuộc |
|---|---|---:|---|
| P0 | Baseline và quyết định tích hợp | 0.25 ngày | Không |
| P1 | Package runtime + auth hai service | 1–1.5 ngày | P0 |
| P2 | Docker, broker, worker, storage | 0.75–1 ngày | Interface và đóng gói từ P1 |
| P3 | DTO, OpenAPI và regression nghiệp vụ | 0.5 ngày | P1; integration cần P2 |
| P4 | Smoke/E2E, sửa lỗi, bằng chứng và bàn giao | 0.75–1 ngày | P1–P3 |

Tổng dự kiến 3.25–4.25 ngày công cho phần còn lại; không phải cam kết hoàn thành toàn bộ kế hoạch gốc trong thời gian này. Chưa tính thời gian chờ chủ sở hữu package/frontend hoặc xử lý lỗi hạ tầng bên ngoài. Đánh giá lại sau P1 nếu ảnh hưởng service khác lớn hơn dự kiến.

## 4. P0 — Chốt baseline và phương án tích hợp

### Công việc

- [x] Ghi `rtk git status --short`, danh sách thay đổi có sẵn và kết quả test baseline.
- [x] Đọc package, consumer của package hiện có và cấu hình deployment trước khi thay API chung.
- [x] Chốt cách cài package local và build trong Docker; ưu tiên package xuất JavaScript đã compile, chạy được với `node dist/server.js`.
- [x] Chốt claim: Auth ID trong `sub`/`req.auth.userId`, role hợp lệ, tier 0/1/2, issuer, audience, ES256 và thời hạn token.
- [x] Phương án internal đề xuất: giữ `x-internal-key` được kiểm chứng cho Auth/Admin trong đợt chuyển đổi; không cho request từ Gateway mang credential nội bộ do client cung cấp.
- [ ] Ghi owner dependency: Hữu phụ trách hai service; phối hợp Đạt cho package/Gateway; Nguyên cho frontend; chỉ định người triển khai compose và caller Auth/Admin.

### Exit

Có quyết định ngắn về package/claims/keys/internal caller và danh sách file cần sửa. Nếu hợp đồng chưa thống nhất, vẫn làm DTO và chuẩn bị test/hạ tầng độc lập; không dùng auth stub cho nghiệm thu.

## 5. P1 — Hoàn thiện auth và package runtime

### 5.1. Package và Gateway

- [x] Sửa đóng gói nếu cần: package hiện có `main: src/index.ts`; thêm build/output JavaScript, declaration và dependency chạy build/test cần thiết. Xác minh consumer chạy bằng Node trong image production, không chỉ bằng tsx ở dev.
- [x] Kiểm tra chữ ký ES256, issuer/audience, claim bắt buộc và kiểu/giá trị của identity, role, tier; yêu cầu token có hạn sử dụng đúng contract.
- [x] Thiếu khóa ở production phải báo lỗi rõ ràng; không âm thầm fallback về khóa dev. Test dùng khóa riêng của môi trường test; private key chỉ cấp cho Gateway.
- [x] Gateway xóa header nội bộ do client gửi, bao gồm `x-internal-key`, trước khi xác thực và proxy. Giữ đường gọi trực tiếp đã xác thực của Auth/Admin.
- [x] Giữ error envelope có `requestId`. Package hiện tự trả lỗi không có field này; chọn thay API error của package theo cách tương thích hoặc adapter được thống nhất, không sao chép bộ verify JWT.

### 5.2. User và Merchant

- [x] Thêm dependency package và cập nhật lockfile.
- [x] Thay middleware verify access JWT/marker bằng package chung; chuyển `RequestWithContext`, controller và helper quyền sang context đã xác thực.
- [x] Nếu cần context riêng cho caller nội bộ, phân biệt rõ service principal và user principal; không tự gán role ADMIN cho mọi request.
- [x] `/me`, owner check và Merchant registration lấy Auth ID từ context; body/header bên ngoài không thay được identity.
- [x] Giữ provision profile của Auth và review KYC/Merchant của Admin hoạt động với internal policy đã chọn.
- [x] Bỏ dependency cấu hình access-token secret và cờ bypass cũ khỏi hai service khi không còn dùng. Health tiếp tục public.
- [x] Đổi fixture sang Gateway Token; không tiếp tục dựa vào `x-gateway-verified`.

### Test/Exit

- [x] Thiếu token, sai chữ ký, hết hạn, sai issuer/audience, thiếu claim bắt buộc → 401.
- [x] Header marker/ID/role/internal-key giả từ client không xác thực hoặc nâng quyền.
- [x] USER truy cập dữ liệu người khác hoặc thao tác admin → 403; owner/admin hợp lệ dùng được.
- [x] `/me` resolve đúng Auth ID; health → 200; lỗi auth có `requestId`.
- [x] Auth provision và Admin review pass theo internal policy.
- [x] Regression case qua Gateway thật: token hợp lệ tới được hai service và không còn lỗi thiếu marker.
- [x] Package và hai service typecheck/build pass; package import được trong runtime Node của Docker.

File chính: package chung; `gateway/src/middlewares/{authenticate,sanitizeHeaders}.ts`, `gateway/src/utils/gatewayToken.ts`; middleware/config/access/controllers và package manifests của hai service.

## 6. P2 — Hạ tầng chạy thực tế

### Công việc

- [x] Điều chỉnh build context/COPY/.dockerignore để User/Merchant cài được package local. Không COPY `.env`, khóa hay dữ liệu test vào image.
- [x] Cấp `RABBITMQ_URL`, exchange và cấu hình retry cho hai service/worker bằng env của môi trường.
- [x] Khai báo User consumer và Merchant publisher thành process/container riêng, có restart policy và shutdown phù hợp.
- [x] Đảm bảo migration thành công trước HTTP service và worker; ưu tiên migration job có dependency rõ ràng. Broker phải healthy trước worker.
- [x] Tạo queue/binding bền vững cho Merchant events, gồm `merchant.profile_updated`; xác nhận nơi nhận thuộc consumer nào hoặc queue quan sát của demo.
- [x] Thêm MinIO/S3, volume bền vững, bucket private và credential của môi trường. Cấp ListBucket theo prefix `kyc/` và quyền object cần thiết.
- [x] Xử lý endpoint storage nội bộ và endpoint ký URL truy cập được từ frontend. Không sửa hostname sau khi ký URL.
- [x] Cấu hình grace period và quyền tắt cleanup timer; chạy scanner như tác vụ bảo trì riêng theo thiết kế hiện có.
- [x] Cấp khóa Gateway/service tương ứng qua env/secret file; không dùng khóa dev mặc định để nghiệm thu production config.
- [x] Cập nhật hướng dẫn start/stop/migrate/worker/replay/cleanup và biến môi trường mẫu.

### Test/Exit

- [x] Build sạch từ lockfile; không phụ thuộc `node_modules`/`dist` trên máy host.
- [x] Compose khởi động HTTP, consumer, publisher và storage; migration tier đã áp dụng trong DB nghiệm thu.
- [x] Registration event được tiêu thụ; Merchant event được confirm và chuyển PUBLISHED.
- [x] Restart worker tiếp tục xử lý backlog; broker lỗi không làm mất Outbox/Inbox.
- [x] Upload thật thành công, URL ký sẵn đọc được ngoài mạng container; truy cập object không ký bị từ chối.

## 7. P3 — DTO, contract và regression

### Công việc

- [x] Đồng bộ `UserResponse`: thêm `kycTier`, `hasKycDocument`; bỏ field `idImageUrl` cũ nếu không còn trong response. Kiểm tra type consumer liên quan.
- [x] Rà OpenAPI của hai service theo response thật sau thay auth: method/path, security, multipart, nullable data, status và error envelope.
- [x] Giữ User thiếu profile → 404; Merchant `/me` chưa đăng ký → `data: null`; DB lỗi phải là lỗi.
- [x] Bổ sung kiểm tra response thực tế với schema/fixture cho các endpoint bàn giao; validation cú pháp OpenAPI không thay thế kiểm chứng response.
- [ ] Ghi event contract `eventVersion`, profile ID/aggregate ID và `data.authUserId`; xác nhận với consumer trước khi tích hợp.
- [x] Chạy lại integration sẵn có cho H2/H3/H4/H5, chỉ bổ sung test khi còn thiếu tình huống nghiệp vụ hoặc do auth mới phát sinh.

### Ma trận nghiệm thu tối thiểu

| Luồng | Bằng chứng |
|---|---|
| Inbox | Duplicate/concurrent replay, conflict, insert lỗi rollback, retry/DLQ/restart |
| Tier | Migration profile cũ/APPROVED, default 0, tier hợp lệ, no-op, concurrency, rollback Outbox |
| Cleanup | A–F theo plan gốc, dry-run không mutation, pagination, upload/delete race, lookup lỗi không xóa |
| Merchant | Update tạo đúng một event, no-op/rollback, thứ tự xen kẽ status/profile, confirm/retry/lease/replay |
| Contract | Danh tính `/me`, upload fields/errors, private document URL, envelope thực tế |

### Lệnh kiểm tra

Chạy trong từng thư mục service sau khi kiểm tra đích test: `finvault_test`, schema `user_test`/`merchant_test`, bucket `finvault-kyc-test`, exchange test. Hạ tầng integration dùng `services/user-service/tests/compose.yml`.

```powershell
rtk npm test
rtk npm run typecheck
rtk npm run build
rtk npm run test:db
rtk npm run test:integration
```

Regenerate Prisma client khi schema/client yêu cầu. Không chạy migration/reset trên DB ứng dụng để thay thế việc chuẩn bị test biệt lập.

## 8. P4 — Nghiệm thu xuyên service và bàn giao

- [x] Cập nhật harness `tests/acceptance` theo keys/package/auth mới; không dùng bypass để làm test pass.
- [x] Signup → Auth provision → signin → Gateway → User `/me` và Merchant `/me`.
- [x] KYC upload → URL private → Admin reject/resubmit/approve; tier vẫn theo policy độc lập.
- [x] Merchant register → Admin review → owner sửa profile → Outbox → broker nhận event.
- [x] Request thiếu credential/header giả/khác owner bị từ chối; health hoạt động.
- [x] Chạy consumer replay và publisher restart trong kiểm tra riêng: bộ acceptance hiện tại chưa bao phủ RabbitMQ workers.
- [x] Demo cleanup dry-run khi timer xóa thật đã tắt; đối chiếu storage và cleanup table trước/sau.
- [x] Kiểm tra frontend với API thật: 17 nhóm browser acceptance pass; đã lưu bằng chứng. Full frontend build còn lỗi TS6133 được ghi trong báo cáo.
- [ ] Nguyên review OpenAPI/mock và xác nhận bàn giao.
- [x] Ghi lệnh, môi trường, commit/worktree, pass/fail và log đã loại secret cho từng DoD. Không ghi token/URL ký đầy đủ vào báo cáo.
- [x] Cập nhật hai `week1-status.md`, README, kế hoạch trong repo và báo cáo bằng chứng. Bản kế hoạch ngày 07/10 ngoài workspace được giữ làm baseline lịch sử.
- [x] Chuẩn bị mô tả PR trong `docs/User_Merchant_PR_Description.md`; chưa commit/push worktree chứa thay đổi có trước.
- [ ] Khoa review diff/PR theo phân công. Không coi chuẩn bị mô tả là PR đã được tạo hoặc phê duyệt.

### Tiêu chí hoàn thành cuối cùng

H1/H5 auth dùng package chạy được trong image thật; Gateway/Auth/Admin tương thích; H2–H5 regression pass; storage/worker có runtime; H6 contract khớp API và có bằng chứng bàn giao. Mọi mục chưa chạy phải ghi lý do, người phụ trách và bước tiếp theo.

## 9. Chia thay đổi và thứ tự triển khai

1. Package build/validation/key/error contract tương thích, sau đó User/Merchant auth + Gateway sanitization + test. Có thể tách PR package nhưng không triển khai auth dở dang giữa Gateway và service.
2. Docker/compose, migration dependency, storage và worker runtime.
3. DTO/OpenAPI/acceptance và tài liệu bằng chứng cuối cùng.

Khi triển khai, phân phối khóa và package trước, chạy migration rồi đưa bộ Gateway/service tương thích lên cùng đợt. Nếu lỗi auth, rollback theo bộ tương thích đã xác nhận; không bật bypass hoặc chấp nhận header giả. Migration tier là bổ sung: ưu tiên giữ dữ liệu/cột khi rollback ứng dụng, không tự drop schema hoặc xóa volume.
