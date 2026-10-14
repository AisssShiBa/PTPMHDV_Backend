# Kết quả hoàn thiện User/Merchant — 11/10/2026

## Kết quả chính

Đã sửa lỗi Gateway Token bị hai service từ chối, hoàn thiện package runtime, cấu hình hạ tầng và kiểm chứng nghiệp vụ bằng DB/broker/storage thật. Bảo toàn phần KYC tier/Outbox/cleanup/routes và các thay đổi chưa commit đã có trước lượt triển khai này.

| Phần | Đã thực hiện |
|---|---|
| Auth User/Merchant | Dùng `finvault-internal-auth`, `req.auth`; bỏ marker/access JWT cũ và cờ bypass; giữ internal-key được kiểm chứng cho Auth/Admin |
| Package | Xuất JavaScript/declaration; xác minh claims/ES256/issuer/audience/TTL; fail khi production thiếu hoặc dùng key dev; giữ correlation ID |
| Gateway | Xóa internal key client gửi; validate key pair trước startup; cleanup timer không giữ process test sống sau khi server đóng |
| Caller Auth/Admin | Auth public endpoints không còn yêu cầu marker cũ; Admin lấy identity từ package rồi adapter sang controller hiện tại; provision/review nội bộ giữ nguyên |
| Runtime | Migration job riêng, consumer/publisher riêng, broker binding demo, private MinIO, S3 account giới hạn prefix; public endpoint riêng để ký URL |
| Docker | Build package local từ root context; User/Merchant chạy `node dist/server.js`; healthcheck PostgreSQL qua TCP tránh migration chạy trong bootstrap |
| Contract | Đồng bộ `UserResponse`, mô tả auth/errors trong OpenAPI và tài liệu vận hành |

Các thay đổi Caller chỉ để luồng User/Merchant chạy được qua Gateway mới. Không chuyển auth của Wallet/Payment/Notification trong công việc này.

## Bằng chứng kiểm chứng

| Kiểm tra | Kết quả |
|---|---|
| Package auth `rtk npm test` | 3/3 nhóm assertion pass; bao gồm claims sai, ES256 sai khóa, issuer/audience, TTL, production keys và middleware correlation |
| User unit/API/contract | 27/27 pass; gồm HTTP proxy Gateway thật sang hai app, chống giả internal key/identity |
| Merchant unit/API | 17/17 pass |
| User integration PostgreSQL/RabbitMQ/MinIO | 26/26 pass |
| Merchant integration PostgreSQL/RabbitMQ | 12/12 pass |
| TypeScript User/Merchant | Typecheck và build pass |
| TypeScript Gateway/Admin | Typecheck pass |
| Image Docker User/Merchant | Build từ lockfile thành công, package import được bằng Node trong container |
| Image Docker Admin | Build thành công với package local và Prisma client |
| Runtime smoke | PASS trên project biệt lập `finvault-runtime-check`, với `NODE_ENV=production` và khóa ES256 riêng |
| Scanner trong container | Dry-run pass: không xóa object; test A–F/race/rollback/no-mutation đã nằm trong unit/integration |
| Browser acceptance | 17/17 nhóm pass; gồm signup/provision, login/refresh/logout, profile, KYC upload/reject/resubmit/approve, Merchant register/review, owner/admin, reload/mobile, signed URL hết hạn thật và audit DB |
| Frontend `npm run build` | FAIL có sẵn ở AdminTopups.tsx: TS6133 cho ba biến/hàm không dùng |
| Frontend `rtk npx vite build` | PASS; bundle source hiện tại dùng cho 17 nhóm browser acceptance |

Runtime smoke kiểm chứng được internal provision/review, URL private đọc từ host, cấm ghi ngoài `kyc/`, hai lần registration event tạo một profile/Inbox và ba Merchant event được publisher confirm. Queue demo đã nhận message.

Artifact cục bộ (ignored, không commit credential):

- `.cache/deployment/smoke-result.json`: kết quả runtime và request statuses.
- `.cache/acceptance/live-result.json`: 17 checks PASS, thời gian 2026-10-11T05:30:48Z → 05:31:57Z, kết quả DB và request.
- `.cache/acceptance/live-*.png`: bằng chứng trình duyệt.
- `.cache/deployment/keys/` và `.cache/acceptance/gateway-*.pem`: key riêng của từng môi trường test, không đưa vào PR.

## Phạm vi dữ liệu và quyết định

- Test integration chỉ dùng `finvault_test`, schema `user_test`/`merchant_test`, bucket `finvault-kyc-test`, exchange test. PostgreSQL test chuyển từ 55432 sang 25432 do dải port Windows giữ.
- Browser acceptance dùng DB `finvault_acceptance` trên 25433. Runtime image test dùng project/volume Docker riêng và PostgreSQL trên 25434. Không chạy reset/migration vào DB ứng dụng hiện hữu.
- Tier độc lập với KYC approval. User Outbox chỉ ghi atomic; không thêm User publisher hoặc API/UI Admin nâng tier, không tuyên bố tier đã đồng bộ tới token/Wallet.
- Internal key được giữ trong giai đoạn chuyển tiếp; private key production chỉ cấp cho Gateway.
- Merchant queue `finvault.demo.merchant-events.v1` là queue quan sát demo, không phải consumer nghiệp vụ.

## Còn cần người phụ trách xử lý/review

1. Frontend: sửa lỗi TS6133 của `AdminTopups.tsx` để pipeline build đầy đủ pass. Source frontend không được sửa trong lượt này; không dùng browser pass để che lỗi build.
2. Nguyên review/bàn giao OpenAPI và fixture; M4/M5 xác nhận event contract với consumer nghiệp vụ. Hiện đã kiểm chứng kỹ thuật nhưng chưa có xác nhận của thành viên nhóm.
3. Khoa review diff/PR. Chưa commit, push hoặc tạo PR từ worktree đang chứa nhiều thay đổi có trước; đã chuẩn bị mô tả review riêng.
4. Khi triển khai môi trường thật: cấp key/credential riêng, kiểm tra tương thích volume hiện có, cấu hình hostname S3 public và consumer nghiệp vụ. Chưa triển khai production.

Hướng dẫn chạy lại: [User_Merchant_Runtime.md](User_Merchant_Runtime.md). Kế hoạch gốc bổ sung: [FinVault_User_Merchant_Completion_Plan.md](FinVault_User_Merchant_Completion_Plan.md).
