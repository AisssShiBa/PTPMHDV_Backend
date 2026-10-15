# Sửa cấu hình và nghiệm thu Docker — 14/10/2026

Các lỗi cấu hình chung từng ghi là “cần Đạt xử lý” đã được sửa. Cụm từ `docker-compose.yml` chính đã build và chạy thành công trên project riêng `finvault-full-check`, không xóa volume hay reset database của các project có sẵn.

## Thay đổi

- Compose: bỏ khóa `secrets` trùng ở Gateway; sửa build context User/Notification; đưa migration, worker và service vào cùng mạng; bổ sung public key, URL database, S3 và healthcheck. Gateway chờ các API healthy.
- PostgreSQL chờ sẵn sàng; RabbitMQ kiểm tra cả listener để tránh broker-init chạy trước khi cổng AMQP mở. Wallet/Payment có endpoint `/health`.
- MinIO chạy đúng server, dùng volume riêng; `storage-init` tạo bucket private và account giới hạn prefix `kyc/`. Script shell giữ LF trên Windows.
- `init-secrets.js` tạo credentials ngẫu nhiên và cặp ES256 P-256, giữ cấu hình hợp lệ khi chạy lại, phát hiện mật khẩu/cặp khóa mâu thuẫn và sao lưu khóa dev mẫu trước khi thay thế. Secret được loại khỏi Git/build context.
- Admin Dockerfile cài đủ dependency để build thư viện chung; Docker ignore của Auth tránh đưa node_modules trên host vào image.
- Gateway không gắn khóa nội bộ vào request của client. Notification xác thực token ES256 qua thư viện chung thay cho marker tĩnh; route nội bộ vẫn dùng khóa service. Đã bỏ guard cũ khiến request Gateway hợp lệ bị trả 401.
- README dùng script nghiệm thu có thật; tài liệu đợt đầu đã được đánh dấu là lịch sử.

## Bằng chứng

| Kiểm tra | Kết quả |
|---|---|
| Compose chính và Compose runtime biệt lập: `config --quiet` | Đạt |
| Build image và khởi động Compose chính với `--wait` | Đạt |
| User unit/API tests, typecheck, build | 32/32 test đạt; typecheck/build đạt |
| Merchant unit/API tests, typecheck, build | 21/21 test đạt; typecheck/build đạt |
| Notification middleware và HTTP tests, typecheck | 4/4 test đạt; typecheck đạt |
| Regression script tạo secrets | 3/3 test đạt |
| `node tests/deployment/full-smoke.mjs` | Đạt với hạ tầng thật |

Smoke test kiểm chứng health của cả 8 API; đăng ký và provision User/Wallet; đăng nhập/refresh Web và Mobile; truy cập Wallet/Payment/Notification; chặn header giả mạo, truy cập trái quyền và gọi endpoint nội bộ từ client; upload/đọc KYC private; Admin duyệt KYC; tạo/sửa/duyệt Merchant; 3 Merchant outbox event được publish; User consumer nhận sự kiện đăng ký trùng nhưng chỉ ghi một lần.

Trạng thái sau nghiệm thu: 11 container healthy (8 API + PostgreSQL/RabbitMQ/MinIO), 2 worker chạy, 4 job migration/khởi tạo exit 0. Gateway tại `http://localhost:3000`. Bằng chứng từng request nằm trong `.cache/deployment/full-smoke-result.json`, không chứa token hoặc mật khẩu.

## Chạy lại và giới hạn

Làm theo [README mục 7](../README.md#7-kiểm-thử-nghiệm-thu-hệ-thống-dod-tuần-1). Test chỉ thêm fixture tổng hợp trong project `finvault-full-check`; mỗi lần chạy tạo dữ liệu mới và giữ lại để kiểm tra. Các project dùng chung cổng host không thể khởi động đồng thời. Có thể dừng riêng project bằng `docker compose -p finvault-full-check stop`, giữ nguyên volume.

Nghiệm thu này chứng minh cấu hình cụm và các luồng nêu trên. Chưa kiểm chứng thanh toán VNPAY bên ngoài (cần credentials Sandbox của nhóm), WebSocket, toàn bộ nghiệp vụ Wallet/Payment hay tải đồng thời. User outbox publisher và đồng bộ tier vào access token vẫn là phần nghiệp vụ chưa triển khai, đã nêu trong [tài liệu User/Merchant](User_Merchant_Runtime.md); không thuộc lỗi cấu hình Docker vừa xử lý.
