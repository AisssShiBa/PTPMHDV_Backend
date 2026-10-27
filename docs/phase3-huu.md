# Bàn giao H8/H11 — 25/10/2026

## H11 — tra cứu người nhận

`GET /api/users/lookup?q=<email hoặc SĐT>` qua Gateway, quyền USER.

```json
{"success":true,"data":{"authUserId":"<UUID>","maskedName":"Nguyễn V. B."}}
```

- Email so sánh toàn bộ, không phân biệt hoa/thường; SĐT so sánh nguyên chuỗi.
  Không tìm gần đúng; `%` và `_` không được hiểu là wildcard.
- Không tồn tại, đã xóa, chính người gọi hoặc có nhiều hồ sơ khớp đều trả
  `404` với `error: {code: "RECIPIENT_NOT_FOUND", message: "Recipient not found"}`.
  Mỗi response vẫn có `requestId` riêng theo envelope hiện tại của repo.
- Chỉ trả Auth ID và tên đã che; không trả email, SĐT, số CCCD hoặc tier.
  Tên một từ chỉ lộ ký tự đầu; tên rỗng trả `***`.
- PostgreSQL lưu tối đa 10 thời điểm gần nhất cho mỗi Auth ID trong cửa sổ
  trượt 60 giây. UPSERT khóa dòng nên nhiều instance/request đồng thời cùng
  dùng một hạn mức. Lần 11 trả `429 RATE_LIMIT_EXCEEDED`, `Retry-After: 60`.
  Request sai/không tìm thấy cũng tính lượt; đổi IP hoặc header ID không reset.
- Response dùng `Cache-Control: no-store`.

Migration `20261025_user_recipient_lookup` thêm bảng `recipient_lookup_limits`,
index SĐT và index LOWER(email). Chạy migrate deploy trước khi phục vụ route.
Giới hạn không phụ thuộc RAM; không bị mất khi restart service.

Quyền hiển thị người nhận hiện dựa trên `deletedAt` và quy tắc không tra chính
mình. User profile chưa có trạng thái khóa tài khoản từ Auth; tích hợp trạng
thái khóa cần hợp đồng đồng bộ riêng nếu nhóm bổ sung sau này.

## H8 — nộp hai mặt CCCD

`POST /api/users/kyc/documents`, multipart `front`, `back`, `idNumber`.
Thành công `202`, profile có `kycStatus: PENDING`; thiếu mặt trả
`400 KYC_DOCUMENTS_REQUIRED`. Mỗi ảnh JPEG/PNG tối đa 5 MiB, được giải mã và
chuẩn hóa JPEG bằng sharp. `kycFileSize` là tổng dung lượng hai ảnh sau chuẩn hóa.

Mọi alias cũ (`/me/kyc`, `/:id/kyc`, `/by-auth/:authUserId/kyc`) cũng bắt buộc
hai mặt và trả 202. Có thể dùng `document` thay cho `front` để chuyển đổi client,
nhưng vẫn phải gửi `back`. Client đang gửi một ảnh phải được cập nhật.

Hai ảnh được kiểm tra trước khi ghi storage. Hai cleanup intent được lưu trước
upload; DB chỉ chuyển PENDING khi cả hai object tồn tại. Lỗi upload/commit giữ
nguyên hồ sơ cũ và để cleanup xử lý an toàn. Khi nộp lại, cả hai ảnh cũ được
đưa vào hàng đợi dọn. Cleanup không xóa object đang được tham chiếu.

Duyệt PENDING yêu cầu đủ hai object key và idNumber. Hồ sơ legacy thiếu mặt sau
cần nộp lại; hồ sơ APPROVED cũ không bị tự hạ tier. Không thêm log chứa CCCD.

`GET /api/admin/kyc/:userId/documents` trả
`{success:true,data:{frontUrl,backUrl,expiresAt},auditLog}`. TTL mặc định 300 giây,
đọc `KYC_URL_TTL_SECONDS` cả khi chạy Compose. URL/bucket private và response
`Cache-Control: no-store`. Admin đọc ảnh qua endpoint này để ghi audit mỗi lần.
Signed ADMIN không lấy URL trực tiếp qua các route User; endpoint User hai URL
chỉ nhận lời gọi nội bộ từ Admin. USER vẫn có thể đọc URL mặt trước của mình.

## Kiểm chứng

Tại `services/user-service`:

```powershell
rtk npm run test:db
rtk npm test
rtk npm run test:integration
rtk npm run typecheck
```

- Baseline Phase 2: 32/32 integration pass trước khi thay đổi H8/H11.
- Sau H8/H11: 32/32 API/unit/OpenAPI và 41/41 integration pass.
- S11: Admin → User HTTP, audit PostgreSQL và hai publisher RabbitMQ thật;
  kiểm tra thứ tự tier 0 → 1 → 2 → 0, rollback/retry/lease/migration cũ.
- S12: USER bị chặn, hai URL đọc được trước hạn và cùng trả 403 sau hạn với
  TTL 2 giây trên MinIO thật; route Admin audit từng lần xem.
- S13: lần 11 bị chặn; 20 request song song chỉ 10 thành công; kết nối lại DB
  không reset; lượt cũ hết hạn nhưng lượt mới vẫn được tính.
- TypeScript build trong Docker và typecheck local pass.

Từ root, kiểm tra project `finvault-full-check` chạy từ Compose chính:

```powershell
rtk proxy node scripts/init-secrets.js
rtk proxy docker compose -p finvault-full-check up -d --build --wait --wait-timeout 180
rtk proxy node tests/deployment/huu-smoke.mjs
```

Smoke tạo tài khoản/ảnh tổng hợp mới, không reset DB hoặc xóa volume. Kiểm tra
8 API healthy, mount secret/key, lookup qua Gateway, upload hai mặt, URL private,
hai audit xem ảnh, ba audit đổi tier và ba sự kiện được broker confirm.
Bằng chứng cục bộ: `.cache/deployment/huu-smoke-result.json`, không chứa secret
hoặc URL có chữ ký. Script này không thay thế bộ T1 toàn hệ thống.

Đã kiểm chứng thêm khởi tạo sạch ngày 25/10/2026 bằng project
`finvault-huu-check`, ba volume mới và cổng riêng 3008/25435/19003. Dùng Compose
chính và override image đã build, `S3_PUBLIC_ENDPOINT=http://localhost:19003`.
Tất cả 8 API healthy, bốn job khởi tạo/migration exit 0; smoke H7/H8/H11 pass,
bao gồm chặn signed ADMIN lấy URL qua User để bỏ qua audit. Cụm mới đã được
stop sau test, giữ volume; không xóa/reset cụm cũ. Evidence hiện ghi lượt này.
`finvault-full-check` và hạ tầng integration vẫn đang chạy.

## Phần chưa thuộc kết quả này

- `tests/deployment/full-smoke.mjs` cũ dừng ở
  `GET /api/notifications/:userId` trả 404; cần đối chiếu lại hợp đồng Notification.
  Phần upload KYC của script đã cập nhật hai mặt/202.
- Chưa có consumer tier của Wallet trong checkout này. Broker nhận sự kiện đã
  được kiểm chứng; chưa chứng minh K1 chuyển tiền theo hạn mức mới.
- Frontend và bộ browser acceptance Tuần 1 cần cập nhật upload hai ảnh trước
  khi chạy lại. Lượt này kiểm chứng API/backend, không xác nhận giao diện.
- T1 đầy đủ, H9/H10, rà toàn repo secret cũ và DB role riêng vẫn theo kế hoạch
  các phase tiếp theo; không đánh dấu toàn bộ Tuần 2 hoàn thành.
