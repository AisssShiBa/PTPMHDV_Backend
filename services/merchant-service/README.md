# Merchant Service

**Rà soát 14/10/2026:** đã sửa ưu tiên Gateway Token và kiểm tra lại quyền; kết quả test/build và phần cấu hình cần bàn giao có trong [báo cáo xác thực](../user-service/docs/auth-review-2026-10-14.md).

**Cập nhật 11/10/2026:** auth dùng `finvault-internal-auth`; xem [trạng thái](docs/week1-status.md), [OpenAPI](docs/openapi.json) và [hướng dẫn runtime](../../docs/User_Merchant_Runtime.md).

Quản lý đăng ký, duyệt Merchant và phát event qua transactional outbox. API mặc định `http://localhost:3003/api/merchants`.

## Chạy local

Dùng Node.js 22 trở lên, PostgreSQL, và file `.env` sao chép từ `.env.example`.

```powershell
rtk npm ci --prefix ../../packages/finvault-internal-auth
rtk npm ci
npm run db:generate
npm run db:migrate
npm run build
npm start
```

Cấu hình service: `DATABASE_URL`, `INTERNAL_KEY` (ít nhất 32 ký tự), `MERCHANT_QR_SECRET` (ít nhất 32 ký tự, khóa HMAC riêng của hệ thống để ký QR outlet), `PORT`, `CLIENT_URL`. Production cần `GATEWAY_PUBLIC_KEY_FILE` hoặc `GATEWAY_PUBLIC_KEY`, và `MERCHANT_QR_SECRET_FILE` thay vì giá trị inline. User/Merchant không đọc access-token secret. Sinh secret bằng `node ../../scripts/init-secrets.js` (ghi `.env` và `secrets/merchant_qr_secret.txt`, quyền 0600); thiếu file secret thì service dừng khi khởi động.

Migration thêm unique `ownerId`, `version`, bảng `merchant_outbox_events`. Một chủ chỉ có một merchant, kể cả hồ sơ đã soft delete. Migration dừng và báo lỗi khi có owner trùng; không tự xóa/ghép dữ liệu. Kiểm tra trước khi áp dụng:

```sql
SELECT owner_id, COUNT(*) FROM merchants
GROUP BY owner_id HAVING COUNT(*) > 1;
```

Nếu database cũ được tạo bằng db push, cần baseline migration phù hợp trước khi chạy deploy. Không reset database hoặc đánh dấu migration đã chạy khi chưa đối chiếu schema.

## Xác thực và API

Request người dùng gửi Bearer token tới Gateway. Gateway chuyển `x-gateway-token` ES256; service xác thực qua package chung và đọc `req.auth`. Thiếu/sai token trả 401; thiếu quyền trả 403.

- Khi có `X-Gateway-Token`, service luôn kiểm tra token và quyền trong claims, kể cả khi Gateway gắn thêm `X-Internal-Key`. Token rỗng/sai/hết hạn trả 401 `INVALID_GATEWAY_TOKEN`; không chuyển sang xác thực nội bộ.
- Lời gọi Auth/Admin không có `X-Gateway-Token` dùng `X-Internal-Key` hợp lệ; `X-User-Id` nếu có phải là UUID. Cơ chế này vẫn tin cậy khóa dùng chung; service phải nằm trong mạng nội bộ.

| Method | Đường dẫn | Quyền | Nội dung |
|---|---|---|---|
| POST | `/register` | Người dùng đã xác thực/internal | `businessName`, tùy chọn `taxId`, `bankAccount`; internal có thể cung cấp `ownerId` |
| GET | `/` | ADMIN/internal | Phân trang, tìm tên, lọc trạng thái |
| GET | `/:id` | Chính chủ/ADMIN/internal | Hồ sơ Merchant |
| PUT | `/:id` | Chính chủ/ADMIN/internal | Ít nhất một trường `businessName`, `taxId`, `bankAccount` |
| PATCH | `/:id/status` | ADMIN/internal | `status` |
| GET | `/:id/active` | Caller đã xác thực/internal | Trạng thái hoạt động, không trả tài khoản ngân hàng |
| POST | `/:id/outlets` | Chính chủ/ADMIN/internal | `name`, `code`; merchant phải APPROVED |
| GET | `/:id/outlets` | Chính chủ/ADMIN/internal | Phân trang, tìm theo tên hoặc code |
| GET | `/:id/outlets/:outletId/qr` | Chính chủ/ADMIN/internal | Payload QR đã ký; merchant phải APPROVED |
| POST | `/:id/api-keys` | Chính chủ/ADMIN/internal | Cấp API key; merchant phải APPROVED |
| DELETE | `/:id/api-keys/:keyId` | Chính chủ/ADMIN/internal | Thu hồi API key (idempotent) |
| GET | `/health` | Công khai | Liveness |

Ngoài ra có `GET /health`. `ownerId` là Auth ID trong token. Người dùng không được đăng ký hộ bằng cách thay `ownerId` trong body. UUID, chuỗi và query được validate; page 1–100000, limit 1–100 (mặc định 1/10); search tối đa 200 ký tự. Hồ sơ có `deletedAt` bị loại khỏi xem/sửa/danh sách/active.

Response nghiệp vụ thành công: `{ success: true, data: ..., message: "Success" }`. Lỗi: `{ success: false, error: { code, message }, requestId }`. Health giữ `{ status: "ok", service: "merchant-service" }`. Danh sách có `content, page, limit, totalElements, totalPages`.

### Trạng thái

- Đăng ký mới: `PENDING`.
- `PENDING → APPROVED/REJECTED`.
- `APPROVED → REJECTED` để thu hồi.
- `REJECTED → PENDING` để xét duyệt lại.
- Gửi lại cùng trạng thái là no-op, không tăng version hoặc tạo event mới.
- Chuyển trạng thái không hợp lệ trả 409 `INVALID_TRANSITION`.
- Chỉnh hồ sơ tăng version để các snapshot/event có thứ tự rõ ràng; chưa phát event riêng cho chỉnh hồ sơ.

### Kiểm tra hoạt động

`GET /api/merchants/:id/active` trả:

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "merchant-uuid",
    "ownerId": "owner-auth-uuid",
    "businessName": "Cửa hàng",
    "status": "APPROVED",
    "active": true
  }
}
```

`active` chỉ true cho APPROVED. PENDING/REJECTED trả false. Không tồn tại/soft delete trả 404. Sai định dạng ID trả 400, không đủ thông tin xác thực trả 401/403. Endpoint chỉ cung cấp kết quả trạng thái; không thực hiện chuyển tiền.

### Outlet, API key và QR

Chỉ merchant `APPROVED` mới tạo được outlet, đọc QR và cấp API key; trạng thái khác trả `409 MERCHANT_NOT_APPROVED`. Mọi endpoint lồng dưới `/:id` kiểm tra quyền chủ sở hữu trước khi xử lý (ADMIN và internal call được bỏ qua kiểm tra này).

**Outlet.** `code` là duy nhất toàn hệ thống vì QR đã quét phải phân giải được outlet mà không cần ngữ cảnh merchant; trùng code trả `409 DUPLICATE_RESOURCE`. `code` chỉ gồm chữ, số, `-` và `_` (3–64 ký tự) vì canonical form QR dùng `|` làm dấu phân cách. Tạo outlet, tăng `Merchant.version` và ghi outbox `merchant.profile_updated` trong **cùng một transaction Serializable**; mọi event của cùng merchant vì thế giữ cặp `aggregateId/aggregateVersion` duy nhất.

**QR.** Service ký HMAC-SHA256 trên canonical form có phiên bản:

```
1|<merchantId>|<outletId>|<outletCode>|<issuedAt>
```

`token` = `base64url(canonical) + "." + base64url(signature)` (chữ ký 32 byte). Response trả kèm `version, merchantId, outletId, outletCode, issuedAt, token, signature, algorithm` và header `Cache-Control: no-store` vì payload sinh theo từng request.

- Khóa ký là `MERCHANT_QR_SECRET` — secret hệ thống chuyên biệt đọc từ Docker secret. **Không** dùng API key của merchant làm signing key.
- Outlet được tra bằng cả `outletId` và `merchantId`, nên `outletId` của merchant khác trả `404`, không phải một QR hợp lệ khác chủ.
- `GET` QR không cấp quyền thanh toán; bên verify (checkout) phải gọi `verifyOutletQr(token, { merchantId, outletId })` từ `src/services/qr.service.ts` để kiểm chữ ký bằng constant-time compare **và** đối chiếu merchant/outlet mong đợi. QR của merchant B không bao giờ verify cho merchant A. `issuedAt` là thời điểm phát, không phải hạn dùng; chính sách hết hạn (nếu có) phải do bên verify áp đặt.

**API key.** Credential có dạng `<keyId>.<secret>`; `secret` là 32 byte ngẫu nhiên. Response tạo key (201, `Cache-Control: no-store`) là nơi **duy nhất** trả về secret thô. Database chỉ lưu `secret_hash` = SHA-256(secret), `key_id` duy nhất và `prefix` 8 ký tự để hiển thị/log. Verify dùng constant-time compare; key đã thu hồi không bao giờ xác thực; `lastUsedAt` chỉ được cập nhật khi secret trình bày khớp thật. Thu hồi lặp lại giữ nguyên `revokedAt` lần đầu và không làm lộ lại hash hay secret. `keyId` không tồn tại của merchant trả `404`.

## Outbox và publisher

Đăng ký và cập nhật trạng thái ghi Merchant + outbox trong cùng transaction Serializable. Mỗi event logic có UUID ổn định và unique cặp `aggregateId/aggregateVersion`.

Thêm `RABBITMQ_URL=amqp://guest:guest@localhost:5672`, rồi chạy tiến trình riêng:

```powershell
npm run worker
```

Exchange topic durable: `EVENT_EXCHANGE`, mặc định `finvault.events`. Routing keys:

- `merchant.registered`
- `merchant.status_updated`
- `merchant.profile_updated` (chỉnh hồ sơ và tạo outlet)

Ví dụ payload:

```json
{
  "eventId": "10000000-0000-4000-8000-000000000001",
  "eventType": "merchant.status_updated",
  "eventVersion": 1,
  "occurredAt": "2026-09-26T00:00:00.000Z",
  "data": {
    "merchantId": "20000000-0000-4000-8000-000000000001",
    "ownerId": "30000000-0000-4000-8000-000000000001",
    "businessName": "Cửa hàng",
    "status": "APPROVED",
    "version": 2
  }
}
```

`eventVersion` là version schema; `data.version` là version Merchant. Không đưa tax ID/tài khoản ngân hàng vào event.

Worker claim event bằng row lock SKIP LOCKED và lease 30 giây. Lịch retry và claim dùng cùng đồng hồ PostgreSQL; event mới/replay được đánh dấu có thể xử lý ngay để tránh lệch đồng hồ máy ứng dụng. Chỉ một worker sở hữu lease/token hiện hành; lease hết hạn được thu hồi sau restart. Event sau của cùng merchant phải chờ event trước PUBLISHED; event FAILED chặn thứ tự merchant đó đến khi được xử lý lại. Merchant khác tiếp tục hoạt động.

Publish dùng message persistent, mandatory routing và confirm; không có queue binding hoặc broker từ chối sẽ được coi là thất bại. Cần tạo queue durable/binding cho hai routing key trước khi chạy publisher. Sau confirm, đánh dấu PUBLISHED; crash trước khi lưu confirm có thể gửi lặp, vì vậy consumer cần deduplicate theo eventId và kiểm tra version.

Mặc định `OUTBOX_POLL_MS=1000`, `EVENT_MAX_RETRIES=5` (5 lần thử gửi), `EVENT_RETRY_MS=2000`; backoff 2/4/8/16 giây giữa lần thử, cap 60 giây. Quá giới hạn chuyển FAILED, không xóa event.

Chạy lại một event FAILED sau khi xử lý nguyên nhân:

```powershell
npm run events:replay -- <event-uuid>
```

Lệnh giữ nguyên eventId/payload, reset attempts và lịch thử lại. Không dùng lệnh này cho event PUBLISHED. Có thể xem backlog bằng SQL:

```sql
SELECT status, COUNT(*) FROM merchant_outbox_events GROUP BY status;
SELECT id, aggregate_id, aggregate_version, attempts, last_error
FROM merchant_outbox_events WHERE status = 'FAILED';
```

API vẫn ghi outbox khi broker chưa chạy; publisher sẽ gửi sau. Log lỗi worker chỉ ghi eventId, mã lỗi và số lần thử, không ghi secret/payload.

## Kiểm thử

```powershell
npm test
npm run build
# Hạ tầng test dùng chung với bộ test của User:
docker compose -f ../user-service/tests/compose.yml up -d --build --wait
npm run test:db
npm run test:integration
```

PostgreSQL test ở `127.0.0.1:25432/finvault_test`, schema `merchant_test`; RabbitMQ test ở 5673. Các test dọn dữ liệu schema test cố định, không dùng database ứng dụng.

Đã chạy thành công: 33 test API/unit, 18 test integration và build TypeScript. Bao phủ phân quyền, đăng ký đồng thời, rollback khi outbox lỗi, trạng thái/no-op, active, soft delete, worker lease và tiến trình publisher sau restart, retry/FAILED/replay, confirm RabbitMQ, event không có queue nhận và lệch đồng hồ ứng dụng 10 phút. Bộ test H13 bổ sung: outlet/outbox cùng transaction và unique version, code trùng toàn hệ thống trả 409, QR ký–verify và từ chối token bị sửa/khác merchant/khác outlet/bị cắt, gate `MERCHANT_NOT_APPROVED`, secret API key chỉ trả một lần với `Cache-Control: no-store`, hash không xuất hiện trong response, thu hồi idempotent và revoked key không verify được, cùng owner isolation 403.

Dockerfile chạy migration deploy và mã `dist/server.js`; có thể chạy publisher bằng `node dist/events/worker.js` sau migration. File `.dockerignore` loại credentials local và node_modules khỏi build context.

## Lưu ý triển khai

Migration mới đã thử trong database test, chưa áp dụng vào database ứng dụng. Cấu hình broker và queue binding trước khi chạy worker. Kiểm tra dữ liệu owner trùng trước migration unique. `npm audit` báo 3 mục high trong dependency Prisma CLI → @prisma/config → deepmerge-ts; chưa đổi major Prisma trong thay đổi này.

Tham khảo API publish-confirm: [amqplib](https://amqp-node.github.io/amqplib/channel_api.html).
