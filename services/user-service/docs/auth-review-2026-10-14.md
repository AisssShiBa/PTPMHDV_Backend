# Rà soát xác thực User/Merchant — 14/10/2026

Phạm vi đợt đầu: `services/user-service` và `services/merchant-service`.

**Cập nhật sau khi mở rộng phạm vi:** các lỗi cấu hình chung bên dưới đã được sửa và cụm Docker chính đã qua smoke test với PostgreSQL/RabbitMQ/MinIO thật. Xem [báo cáo nghiệm thu toàn cụm](../../../docs/Docker_Runtime_Review_2026-10-14.md). Nội dung bên dưới ghi lại kết quả của đợt chỉ sửa hai service.

## Hành vi sau sửa

- Request có `X-Gateway-Token` luôn đi qua `requireGateway` của `finvault-internal-auth`. Vai trò và chủ sở hữu lấy từ `req.auth`, kể cả khi proxy gắn thêm `X-Internal-Key`.
- Token rỗng, sai hoặc hết hạn trả `401 INVALID_GATEWAY_TOKEN`. Khóa nội bộ hợp lệ không thay thế được token bị từ chối.
- USER không được dùng khóa đi kèm request Gateway để liệt kê toàn bộ hồ sơ, duyệt KYC/merchant, tạo hồ sơ User nội bộ, đăng ký merchant cho người khác hoặc truy cập/sửa hồ sơ của người khác.
- Lời gọi không có Gateway Token vẫn có thể xác thực bằng khóa nội bộ để giữ giao tiếp Auth/Admin hiện tại. Đây là cơ chế tin cậy khóa dùng chung, không phân biệt danh tính từng service. Yêu cầu triển khai trong mạng nội bộ vẫn còn hiệu lực.
- Response nghiệp vụ thành công có `success`, `data`, `message`; lỗi có `success`, `error`, `requestId`. Health giữ định dạng `status`/`service`. OpenAPI và README riêng đã được đồng bộ.

## Kiểm chứng

Chạy tại thư mục từng service:

| Lệnh | User | Merchant |
|---|---|---|
| `rtk npm test` | 32/32 đạt | 21/21 đạt |
| `rtk npm run typecheck` | Đạt | Đạt |
| `rtk npm run build` | Đạt | Đạt |

Test bao phủ token kèm khóa nội bộ, header giả mạo, kiểm tra chủ sở hữu trên đọc/sửa/upload/đọc tài liệu KYC, chặn duyệt KYC/merchant trái quyền, tạo hồ sơ từ Auth và duyệt từ ADMIN hoặc lời gọi nội bộ. User suite còn chạy proxy Gateway thật tới hai Express app và kiểm tra OpenAPI của cả hai service.

Các test API này giả lập thao tác Prisma; test duyệt Merchant cũng giả lập ghi outbox. Không chạy lại bộ `test:integration` với PostgreSQL/RabbitMQ/MinIO, không migration database ứng dụng và không nghiệm thu toàn cụm Docker trong lần sửa này.

## Lỗi cấu hình chung ghi nhận ở đợt đầu — đã xử lý ở đợt tiếp theo

Các vấn đề đã ghi nhận trong lần rà soát README, nằm ngoài phạm vi chỉnh sửa:

- `docker-compose.yml` trùng khóa `secrets` tại Gateway, khiến `docker compose config --quiet` không qua.
- Build context của User chưa khớp Dockerfile; cấu hình public key và S3 của User cần đồng bộ.
- Merchant, migration và worker cần cùng mạng với Postgres/RabbitMQ; Postgres cần healthcheck cho các dependency `service_healthy`.
- `storage-init` chưa được định nghĩa; cấu hình `minio` đang trỏ tới Merchant và phụ thuộc chính nó.
- Quick Start tạo khóa mẫu, trong khi thư viện từ chối khóa mẫu khi `NODE_ENV=production`; cần thống nhất script sinh khóa và đường dẫn mount.

Gateway, Compose, script tạo khóa và các service khác chưa được chỉnh sửa ở đợt đầu; đợt tiếp theo đã xử lý theo phạm vi được mở rộng.
