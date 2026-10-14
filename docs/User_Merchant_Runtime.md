# Chạy và kiểm chứng User/Merchant

## Auth và policy hiện tại

Frontend gửi access token tới Gateway. Gateway ký ES256, issuer `finvault-gateway`, audience `finvault-internal-services`, TTL 60 giây. User/Merchant lấy Auth ID, role và tier từ `req.auth` qua package chung; không còn đọc `ACCESS_TOKEN_SECRET` hoặc marker `x-gateway-verified`.

Auth provision và Admin review tiếp tục dùng internal key được kiểm chứng. Gateway loại bỏ internal key do client gửi. Admin có adapter lấy identity từ Gateway Token đã xác thực để giữ controller/review hiện tại. Không bật cờ bypass để nghiệm thu.

Tier trong User DB vẫn độc lập với trạng thái KYC. User Outbox chỉ ghi atomic, chưa có publisher; chưa có cơ chế đồng bộ tier mới vào access token. Không dùng thay đổi này để tuyên bố hạn mức Wallet đã phản ánh tier mới.

## Cài local

Từ root backend:

```powershell
rtk npm ci --prefix packages/finvault-internal-auth
rtk npm ci --prefix services/user-service
rtk npm ci --prefix services/merchant-service
rtk npm ci --prefix services/admin-service
```

Package build ra JavaScript/declaration trong `dist`; dependency local cần package đã build. Production yêu cầu public key ES256; Gateway giữ private key tương ứng. Key dev và key file thiếu/sai không được dùng trong production. Các file key không commit.

## Compose chính

```powershell
rtk proxy node scripts/prepare-deployment.mjs
rtk proxy docker compose --env-file .cache/deployment/runtime.env config --quiet
rtk proxy docker compose --env-file .cache/deployment/runtime.env up -d --build
```

Script tạo key/credential cục bộ khi chưa tồn tại, không ghi đè credential đã có. Với môi trường đang dùng volume RabbitMQ/MinIO cũ, cấu hình credential phù hợp với volume hiện tại trước khi chạy; không xóa volume để xử lý lỗi xác thực. Môi trường thật dùng secret manager và quy trình triển khai của nhóm.

User/Merchant migration là job riêng; HTTP và worker chờ migration thành công. Consumer/publisher là container riêng. Bucket private; account S3 của User chỉ có ListBucket prefix `kyc/` và Get/Put/DeleteObject trong prefix này. `S3_ENDPOINT` phục vụ truy cập nội bộ; `S3_PUBLIC_ENDPOINT` dùng lúc ký URL để browser đọc được (mặc định `http://localhost:19002`). Không thay hostname sau khi ký.

`broker-init` tạo queue **quan sát demo** `finvault.demo.merchant-events.v1` nhận ba loại Merchant event. Queue này giúp kiểm chứng publish, không thay thế consumer nghiệp vụ; khi triển khai với consumer thật cần owner và binding riêng.

Các Dockerfile User/Merchant/Admin cần build context là root backend. MinIO server/client được build từ source; client dùng release cố định vì image registry không có sẵn trong lần kiểm chứng này.

## Integration test biệt lập

```powershell
rtk proxy docker compose -f services/user-service/tests/compose.yml up -d --build --wait
rtk npm run test:db --prefix services/user-service
rtk npm run test:db --prefix services/merchant-service
rtk npm test --prefix services/user-service
rtk npm test --prefix services/merchant-service
rtk npm run test:integration --prefix services/user-service
rtk npm run test:integration --prefix services/merchant-service
```

DB `finvault_test` dùng cổng **25432**, schema `user_test`/`merchant_test`; RabbitMQ 5673; MinIO 19000/bucket `finvault-kyc-test`. Cổng 55432 trước đây bị Windows giữ trên máy kiểm thử. Test integration có reset dữ liệu trong schema/bucket test; không thay URL sang DB ứng dụng.

## Kiểm chứng image production mà không đụng DB ứng dụng

```powershell
rtk proxy node scripts/prepare-deployment.mjs
rtk proxy docker compose -f tests/deployment/compose.yml --env-file .cache/deployment/runtime.env up -d --build --wait
rtk proxy node tests/deployment/smoke.mjs
```

Project `finvault-runtime-check` có volume riêng. PostgreSQL 25434, RabbitMQ 25673, MinIO 19003, Gateway 13000 và hai service 13002/13003 chỉ bind localhost. Service chạy `node dist/server.js` với `NODE_ENV=production` và khóa riêng; fixture test chỉ được tạo trong môi trường này.

Smoke kiểm tra Gateway identity, provision/review nội bộ, KYC/URL private, cấm ghi ngoài prefix, consumer idempotency và Merchant Outbox được publisher đẩy tới broker. Kết quả không chứa secret nằm ở `.cache/deployment/smoke-result.json`.

Cleanup mặc định dry-run; timer HTTP đã tắt trong compose nghiệm thu:

```powershell
rtk proxy docker compose -f tests/deployment/compose.yml --env-file .cache/deployment/runtime.env exec -T user-service node dist/jobs/cleanup-kyc.js --dry-run
```

Chỉ dùng `--delete` khi chủ động muốn xóa orphan đã đủ điều kiện. Không chạy cleanup xóa thật đồng thời với demo dry-run.

## Gateway/Auth/Admin và frontend

Xem `tests/acceptance/README.md`. DB acceptance dùng cổng **25433**, key riêng được `prepare.mjs` tạo; không dùng key dev. Test browser và test worker là hai lớp bằng chứng khác nhau.

Sau kiểm thử có thể dừng riêng project tương ứng bằng `docker compose ... stop`; giữ volume để xem bằng chứng. Không dùng `down -v` hoặc reset DB ứng dụng.
