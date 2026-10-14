# User Service

**Rà soát 14/10/2026:** đã sửa ưu tiên Gateway Token và kiểm tra lại quyền; kết quả test/build và phần cấu hình cần bàn giao có trong [báo cáo xác thực](docs/auth-review-2026-10-14.md).

**Cập nhật 11/10/2026:** auth dùng `finvault-internal-auth`; xem [trạng thái](docs/week1-status.md), [OpenAPI](docs/openapi.json) và [hướng dẫn runtime](../../docs/User_Merchant_Runtime.md).

Quản lý hồ sơ, KYC riêng tư và consumer `user.registered`. API mặc định `http://localhost:3002/api/users`.

## Chạy local

Dùng Node.js 22 trở lên, PostgreSQL và file `.env` sao chép từ `.env.example`.

```powershell
rtk npm ci --prefix ../../packages/finvault-internal-auth
rtk npm ci
npm run db:generate
npm run db:migrate
npm run build
npm start
```

Migration mới bổ sung metadata KYC, version hồ sơ, inbox `consumed_events` và hàng đợi `storage_cleanup`. Không cần reset database. Database cũ được tạo bằng `db push` cần được baseline migration trước khi dùng `migrate deploy`; không đánh dấu migration đã chạy khi chưa đối chiếu schema.

Cấu hình service: `DATABASE_URL`, `INTERNAL_KEY` (ít nhất 32 ký tự), `PORT`, `CLIENT_URL`. Production cần `GATEWAY_PUBLIC_KEY_FILE` hoặc `GATEWAY_PUBLIC_KEY`. User/Merchant không đọc access-token secret.

## Xác thực và quyền

Request người dùng gửi Bearer token tới Gateway. Gateway chuyển `x-gateway-token` ES256; service xác thực qua package chung và đọc `req.auth`. Thiếu/sai token trả 401; thiếu quyền trả 403.

- Khi có `X-Gateway-Token`, service luôn kiểm tra token và quyền trong claims, kể cả khi Gateway gắn thêm `X-Internal-Key`. Token rỗng/sai/hết hạn trả 401 `INVALID_GATEWAY_TOKEN`; không chuyển sang xác thực nội bộ.
- `req.auth.userId` là Auth ID; role và tier lấy từ claims đã kiểm chứng. Header ID/role/marker do client gửi không nâng quyền.
- Lời gọi Auth/Admin không có `X-Gateway-Token` dùng `X-Internal-Key` hợp lệ. Có thể gửi `X-User-Id` dạng UUID nếu cần ngữ cảnh. Cơ chế này vẫn tin cậy khóa dùng chung; service phải nằm trong mạng nội bộ.
- ADMIN và internal call được quản trị hồ sơ; USER chỉ xem/sửa/KYC chính mình.
- `X-Request-Id` được nhận nếu hợp lệ hoặc tự sinh; trả lại trong header và lỗi. Lỗi server không trả chi tiết database.


## API

Các đường dẫn dưới đây nối sau `/api/users`.

| Method | Đường dẫn | Quyền | Dữ liệu |
|---|---|---|---|
| POST | `/` | Internal | `authUserId`, `email`; thành công 201, trùng 409 |
| GET | `/` | ADMIN/internal | `page`, `limit`, `search`, `status` hoặc `kycStatus` |
| GET | `/:id` | Chính chủ/ADMIN/internal | Nhận profile ID hoặc Auth ID |
| GET | `/by-auth/:authUserId` | Chính chủ/ADMIN/internal | Chỉ nhận Auth ID |
| PUT | `/:id` hoặc `/by-auth/:authUserId` | Chính chủ/ADMIN/internal | Ít nhất một trong `fullName`, `phone`, `address` |
| POST | `/:id/kyc` hoặc `/by-auth/:authUserId/kyc` | Chính chủ/ADMIN/internal | Multipart: `idNumber`, file `document` |
| GET | `/:id/kyc/document` hoặc `/by-auth/:authUserId/kyc/document` | Chính chủ/ADMIN/internal | URL đọc ảnh, hiệu lực 60 giây |
| PATCH | `/:id/kyc-status` | ADMIN/internal | `kycStatus` |
| GET | `/health` | Công khai | Liveness; không truy vấn database mỗi lần |

Ngoài ra có `GET /health`. Phân trang: page 1–100000, limit 1–100; mặc định 1/10. ID phải là UUID. Chuỗi được trim và giới hạn độ dài. Hồ sơ có `deletedAt` được ẩn; email/Auth ID của hồ sơ đã xóa vẫn được giữ để tránh tái gán danh tính.

Nếu một identifier khớp profile ID và Auth ID của hai hồ sơ khác nhau, API trả 409 `AMBIGUOUS_IDENTIFIER`; dùng endpoint `/by-auth/...` để chỉ rõ. Kiểm tra quyền luôn dùng `user.authUserId`.

Response nghiệp vụ thành công: `{ success: true, data: ..., message: "Success" }`. Lỗi: `{ success: false, error: { code, message }, requestId }`. Health giữ `{ status: "ok", service: "user-service" }`. Danh sách có `content, page, limit, totalElements, totalPages`. Hồ sơ trả `hasKycDocument`, không trả object key hoặc URL KYC cũ.

Lọc danh sách theo trạng thái KYC bằng `status` hoặc `kycStatus`: `NONE`, `PENDING`, `APPROVED`, `REJECTED` (không phân biệt hoa/thường, bỏ khoảng trắng). Giá trị rỗng không lọc; nếu gửi cả hai thì ưu tiên `status` không rỗng. Trạng thái không hợp lệ trả 400.

## Upload KYC bằng S3/MinIO

Cấu hình bucket riêng tư, không bật anonymous/public read:

```dotenv
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_BUCKET=finvault-kyc
S3_ACCESS_KEY_ID=<access-key>
S3_SECRET_ACCESS_KEY=<secret-key>
S3_FORCE_PATH_STYLE=true
```

Với AWS S3, có thể bỏ `S3_ENDPOINT` và đặt `S3_FORCE_PATH_STYLE=false`. Tạo bucket trước; service không tự cấp bucket/public policy. Tài khoản cần PutObject, GetObject, DeleteObject trên prefix KYC.

Ví dụ gọi qua cổng vào đã cấu hình, trong đó `$token` và `$authUserId` là giá trị của người dùng:

```powershell
curl.exe -X POST "http://localhost:3000/api/users/$authUserId/kyc" -H "Authorization: Bearer $token" -F "idNumber=012345678901" -F "document=@identity.png"
```

- Chỉ nhận PNG/JPEG tối đa 5 MiB, giới hạn 25 triệu pixel; giải mã thật và ghi lại thành JPEG, bỏ metadata gốc. Không dùng filename từ client làm object key.
- Kiểm tra quyền trước khi buffer file. URL đọc có hiệu lực 60 giây; response dùng `Cache-Control: no-store`.
- Nộp mới/từ chối/nộp lại khi đang chờ: chuyển thành `PENDING`. `APPROVED` phải bị từ chối trước khi nộp lại.
- Duyệt: `PENDING → APPROVED/REJECTED`; thu hồi: `APPROVED → REJECTED`. Gửi lại cùng trạng thái là no-op. Chưa có tài liệu upload hợp lệ thì không thể duyệt.
- Optimistic version chặn cập nhật KYC trên snapshot cũ (409 `CONCURRENT_UPDATE`).
- Intent dọn tệp được lưu trước upload. Tệp mới bị bỏ dở được dọn sau 24 giờ; tệp thay thế cũ được đưa vào hàng đợi ngay. Job chạy mỗi 60 giây khi API đang chạy, thử lại sau một giờ nếu storage lỗi và luôn kiểm tra tham chiếu trước khi xóa.
- Nếu API dừng, cleanup tiếp tục khi khởi động lại; dữ liệu công việc nằm trong PostgreSQL.

**Thay đổi API:** POST KYC không còn nhận URL tùy ý trong JSON. Client phải gửi multipart; các hồ sơ legacy dùng URL cần upload lại để có tài liệu riêng tư và được duyệt theo quy tắc mới.

## Consumer đăng ký

Thêm `RABBITMQ_URL=amqp://guest:guest@localhost:5672`, sau đó chạy tiến trình riêng:

```powershell
npm run worker
```

Exchange topic durable: `EVENT_EXCHANGE` (mặc định `finvault.events`).
Routing key: `user.registered`.
Queue durable: `user-service.user-registered.v1`.
DLQ: `user-service.user-registered.v1.dlq`.

```json
{
  "eventId": "10000000-0000-4000-8000-000000000001",
  "eventType": "user.registered",
  "eventVersion": 1,
  "occurredAt": "2026-09-26T00:00:00.000Z",
  "data": {
    "authUserId": "20000000-0000-4000-8000-000000000001",
    "email": "user@example.com"
  }
}
```

Consumer validate schema, tạo profile và inbox trong cùng transaction Serializable; unique constraint và retry serialization bảo vệ xử lý đồng thời. Event ID dùng lại với payload khác, email xung đột hoặc profile đã xóa là lỗi không thể tự thử lại. Inbox lưu hash, không lưu payload chứa email.

ACK sau commit. Lỗi tạm thời được publish lại vào queue với retry count/thời điểm xử lý, chờ broker confirm rồi mới ACK bản gốc. Mặc định 5 lần retry, 2/4/8/16/32 giây; tối đa delay 60 giây. Prefetch 1; retry chờ tại consumer nên có thể trì hoãn message kế tiếp, phù hợp tải hiện tại. Message sai schema/xung đột hoặc hết retry được chuyển DLQ bằng publish-confirm; không retry vô hạn. Worker tự reconnect sau lỗi broker. Kích thước event tối đa 64 KiB.

Để replay **một event đầu DLQ** sau khi xử lý nguyên nhân:

```powershell
npm run events:replay
```

Lệnh validate lại payload, giữ event ID, reset retry count, chỉ ACK DLQ sau khi publish được confirm. Payload không hợp lệ vẫn ở DLQ để điều tra/sửa bằng công cụ quản trị. API POST tạo profile nội bộ tiếp tục tồn tại; duplicate HTTP trả 409, còn replay consumer hợp lệ thành công idempotent.

## Kiểm thử

```powershell
npm test
npm run build
# Tại thư mục user-service; Docker đang chạy:
docker compose -f tests/compose.yml up -d --build --wait
npm run test:db
npm run test:integration
```

Trên Windows có thể dùng `powershell -File tests/start-infra.ps1` để khởi động Docker Desktop và bộ test. PostgreSQL test: `127.0.0.1:25432/finvault_test`, schema `user_test`; RabbitMQ: 5673; S3: 19000, bucket `finvault-kyc-test`. Tests chỉ dọn dữ liệu tại các vị trí test cố định này. Không thay URL test bằng database thật.

MinIO test được build từ mã nguồn vì image legacy không tải được từ registry. Đây là hạ tầng test local, không phải manifest triển khai production. Hướng dẫn nguồn: [MinIO](https://github.com/minio/minio), [amqplib confirm channel](https://amqp-node.github.io/amqplib/channel_api.html), [AWS S3 SDK](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html).

Đã chạy thành công: 19 test API/unit, 13 test integration với PostgreSQL/RabbitMQ/MinIO và build TypeScript. Tests gồm đăng ký đồng thời, replay, restart consumer, DLQ, rollback khi upload không lưu được DB, ảnh private và URL đọc có xác thực. Sau khi merge bộ lọc KYC, đã chạy lại 19 test API/unit và build; bộ integration chưa chạy lại trong lần merge này.

Dockerfile dùng migration deploy thay cho tự đồng bộ schema bằng db push; build tạo mã tại `dist`. Worker trong container có thể chạy bằng `node dist/events/worker.js` sau migration.

## Lưu ý triển khai

Cần cấu hình broker/storage thật trước khi bật các chức năng tương ứng; file mẫu giữ các endpoint/credentials này ở dạng chú thích. Migration mới đã được thử trong database test, chưa áp dụng vào database ứng dụng. `npm audit` hiện báo 3 mục high trong chuỗi dependency Prisma CLI → @prisma/config → deepmerge-ts; chưa tự hạ/nâng major Prisma để xử lý vì ngoài thay đổi nghiệp vụ này.
