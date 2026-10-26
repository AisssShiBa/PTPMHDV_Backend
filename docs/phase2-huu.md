# Bàn giao Phase 2 — KYC, Outbox và Docker secrets

**Cập nhật 25/10/2026:** Phase 2 đã qua 32/32 integration test và Compose đã
khởi động thành công. H8/H11 tiếp tục được hoàn thiện trong
[bàn giao Phase 3](phase3-huu.md); phần H8 khởi động bên dưới là mốc lịch sử.

## H7

- Duyệt `PENDING -> APPROVED` đặt tier 1; từ chối đặt tier 0. Status, tier, version
  và Outbox được commit trong cùng transaction. Gửi lại cùng trạng thái/tier
  không tạo thêm sự kiện. Các hồ sơ APPROVED cũ không bị tự nâng tier hàng loạt.
- `PATCH /api/admin/kyc/:userId/tier` nhận `{ "tier": 1|2, "reason": "..." }`.
  Chỉ ADMIN; UUID có thể là profile ID hoặc Auth ID như route review hiện có.
  Chỉ đổi tier khi hồ sơ APPROVED; sai dữ liệu 400, chưa duyệt 409.
- Admin ghi `APPROVE_KYC`, `REJECT_KYC`, `UPDATE_KYC_TIER` vào AdminAuditLog.
  Audit lưu intent trước lời gọi User Service; DB audit lỗi thì không gọi User.
  Vì hai service dùng DB riêng, không có transaction phân tán: timeout/lỗi lưu
  kết quả để lại `PENDING`/`UNKNOWN`, phải đối chiếu profile trước khi retry.

Publisher riêng: `npm run publisher` trong user-service, hoặc service
`user-publisher` của Docker Compose. Exchange topic `finvault.events`, routing
key `user.kyc_updated`, publisher confirm và mandatory routing.

```json
{
  "eventId": "<UUID cố định của bản ghi Outbox>",
  "eventType": "user.kyc_updated",
  "eventVersion": 1,
  "occurredAt": "2026-10-24T00:00:00.000Z",
  "data": { "authUserId": "<Auth ID>", "kycTier": 1, "previousTier": 0 }
}
```

Outbox giữ thứ tự `aggregateVersion` từng profile. Claim dùng lease 60 giây,
`SKIP LOCKED` và lock token; chỉ đánh dấu PUBLISHED sau confirm. Retry có backoff,
hết số lần chuyển FAILED và chặn sự kiện mới hơn của cùng profile. Sau khi sửa
nguyên nhân, chạy `npm run outbox:replay -- <eventId>`. Không tạo lại eventId.
Migration bổ sung previousTier cho payload PENDING cũ từ lịch sử tier, giữ nguyên
ID và các dòng đã PUBLISHED.

Đảm bảo giao nhận là **at least once**: mất kết nối sau broker confirm nhưng
trước DB commit vẫn có thể phát lại. Consumer phải deduplicate bằng eventId.
Wallet hiện chưa có consumer Đ12 trong checkout này; S11 sử dụng consumer thử
trên RabbitMQ thật. Không tuyên bố đã cập nhật tier của Wallet.

## B2

`node scripts/init-secrets.js` giữ nguyên credential hiện có, tạo thêm
`secrets/internal_key.txt`, `secrets/access_token_secret.txt` và SQL khởi tạo
`secrets/init-db.sql` từ template `init-db.sql`. Password trong SQL lấy từ mật
khẩu đã sinh, escape dấu nháy; file có credential nằm trong thư mục bị Git bỏ qua.
Chạy lại script trước khi dùng Compose mới. Không reset volume để áp dụng SQL
khởi tạo: SQL này chỉ chạy khi PostgreSQL tạo data directory mới.

Các service nhận `INTERNAL_KEY_FILE`; Auth/Gateway/Notification nhận thêm
`ACCESS_TOKEN_SECRET_FILE`. File được ưu tiên hơn biến trực tiếp; file thiếu/rỗng
làm startup thất bại. Biến trực tiếp vẫn dùng được khi chạy local/test. Auth tiếp
tục mount khóa Gateway. Không xoay khóa hoặc sửa password trên DB đang chạy.

Nợ kỹ thuật theo kế hoạch: chuyển từng service sang DB role riêng và hoàn thiện
quyền riêng ở tuần 3; rà soát toàn repository để loại bỏ fixture/fallback secret
cũ của các phần khác trong phase 4–5. Không coi toàn repository đã sạch secret.

## H8 — phần khởi động

Migration thêm `kycBackObjectKey`; `idNumber` đã tồn tại nên không tạo cột trùng.
`GET /api/admin/kyc/:userId/documents` trả envelope
`{success:true,data:{frontUrl,backUrl,expiresAt},auditLog}` và `Cache-Control: no-store`.
TTL mặc định 300 giây, cấu hình `KYC_URL_TTL_SECONDS`. Chỉ ADMIN; mọi lần gọi
đã qua validation đều có audit `VIEW_KYC_DOCUMENTS`, không lưu URL đã ký vào audit.
Hồ sơ thiếu một mặt trả 404 `KYC_DOCUMENTS_INCOMPLETE`. Job cleanup bảo vệ cả hai
object key; API profile không lộ key mặt sau.

Upload hai mặt và bắt buộc đủ hai ảnh khi nộp thuộc phase 3. Luồng upload một mặt
hiện tại vẫn giữ nguyên; chưa đánh dấu H8 hoàn thành.

## Kiểm thử và chạy

Từ root: `docker compose -f services/user-service/tests/compose.yml up -d --wait`.
Trong `services/user-service`: `npm run test:db`, `npm test`, `npm run test:integration`.
`test:db` chỉ dùng database test `finvault_test`, schema `user_test` và `admin_test`.
S11 gọi Admin HTTP -> User HTTP thật, dùng hai schema PostgreSQL và hai publisher
đồng thời, kiểm tra audit và payload RabbitMQ. Có kiểm thử rollback, retry/FAILED,
lease recovery, migration payload cũ, phân quyền và response documents.

Khởi chạy bản mới trên môi trường đã cấu hình: build các image bị đổi, chạy
migration User, rồi khởi động `user-publisher` cùng các service. Cần ít nhất một
queue bind `user.kyc_updated`; khi chưa có consumer/queue, mandatory publish sẽ
retry thay vì ghi nhận gửi thành công giả.
