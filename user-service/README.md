# `user-service` — Hướng Dẫn Phát Triển, Chạy & Kiểm Thử Độc Lập

Dịch vụ `user-service` quản lý thông tin hồ sơ người dùng (User Profile) và quy trình nộp/duyệt xác minh danh tính (KYC).

---

## 🚀 1. Cách Chạy Riêng Lẻ Dịch Vụ (Không Cần Docker)

### Yêu cầu môi trường
- **Java 17+** (Khuyên dùng OpenJDK 21)
- **PostgreSQL 15+** đang chạy trên máy cục bộ (mặc định Port `5432`)
- Cấu hình biến môi trường hoặc file `.env`

### Khai báo các Biến Môi Trường (Environment Variables)

Bạn có thể tạo file `.env` hoặc export biến môi trường trong Terminal trước khi chạy:

| Tên biến môi trường | Giá trị mặc định | Mô tả |
|---|---|---|
| `PORT` | `3002` | Cổng HTTP Server cho `user-service` |
| `DB_HOST` | `localhost` | Địa chỉ PostgreSQL Database |
| `DB_PORT` | `5432` | Cổng PostgreSQL Database |
| `DB_NAME` | `user_service_db` | Tên cơ sở dữ liệu |
| `DB_USER` | `postgres` | Tài khoản kết nối Database |
| `DB_PASSWORD` | `postgres` | Mật khẩu kết nối Database |
| `INTERNAL_KEY` | `default_internal_secret_key_123456` | Secret Key xác thực request giữa các microservices |
| `JWT_SECRET` | `your_default_jwt_secret_key_must_be_at_least_32_bytes_long` | Chuỗi secret để verify JWT Token |

### Lệnh khởi chạy dịch vụ

Mở terminal tại thư mục `user-service` và gõ:

- **Trên Windows (PowerShell/CMD)**:
  ```powershell
  .\mvnw spring-boot:run
  ```
- **Trên Linux/macOS**:
  ```bash
  ./mvnw spring-boot:run
  ```

> [!TIP]
> Bạn cũng có thể truyền trực tiếp biến môi trường khi chạy:
> ```powershell
> $env:PORT="3002"; $env:DB_USER="postgres"; $env:DB_PASSWORD="your_password"; .\mvnw spring-boot:run
> ```

---

## 🗄️ 2. Quy Trình Chạy Migration (Flyway)

> [!NOTE]
> **Khác biệt quan trọng so với các Node.js Service (Prisma) của Đạt/Khoa/Nguyên:**
> - Bên Node.js sử dụng Prisma CLI và phải gõ lệnh thủ công (`npx prisma migrate dev`).
> - **Trong Spring Boot của Hữu**: Dùng **Flyway Migration** được tích hợp thẳng vào luồng khởi động ứng dụng.

### Cách thức Flyway hoạt động:
1. Mỗi khi ứng dụng `user-service` khởi động (`spring-boot:run` hoặc `java -jar`), Flyway sẽ **tự động kết nối tới PostgreSQL**.
2. Flyway quét các file SQL chứa trong thư mục `src/main/resources/db/migration/` (ví dụ `V1__init.sql`).
3. Nếu phát hiện script migration mới chưa được chạy, Flyway sẽ **tự động thực thi SQL** để tạo/cập nhật bảng mà bạn không cần gõ thêm bất kỳ lệnh nào.

### Khi muốn tạo thêm Migration mới:
Tạo file SQL mới trong `src/main/resources/db/migration/` tuân thủ quy tắc đặt tên của Flyway:
- `V2__add_new_column_to_users.sql`
- `V3__create_new_index.sql`

---

## 📡 3. Danh Sách API Endpoints

Đặc tả chi tiết xem trong tài liệu `FinVault_Huu_UserMerchantService_API.docx` hoặc [Huu_KeHoach_Final.md](file:///d:/HDV/PTPMHDV_Backend/Huu_KeHoach_Final.md).

| Method | Endpoint | Yêu cầu Xác thực | Mô tả Chức năng |
|---|---|---|---|
| `POST` | `/api/users` | Header `X-Internal-Key` | Khởi tạo user profile (được gọi nội bộ từ `auth-service` sau khi đăng ký) |
| `GET` | `/api/users/{id}` | Public / JWT | Lấy chi tiết hồ sơ user theo User UUID (`id`) |
| `GET` | `/api/users/by-auth/{authUserId}` | Public / JWT | Lấy chi tiết hồ sơ user theo `authUserId` |
| `PUT` | `/api/users/{id}` | JWT (Chính chủ / Admin) | Cập nhật thông tin profile (`fullName`, `phone`, `address`) |
| `POST` | `/api/users/{id}/kyc` | JWT (Chính chủ / Admin) | Nộp hồ sơ KYC (`idNumber`, `idImageUrl`) |
| `PATCH` | `/api/users/{id}/kyc-status` | Header `X-Internal-Key` | Duyệt KYC (`APPROVED` / `REJECTED`) — gọi nội bộ từ `admin-service` |
| `GET` | `/api/users` | JWT (Chỉ Admin) | Xem danh sách user có phân trang và tìm kiếm |
| `GET` | `/actuator/health` | Public | Health check trạng thái ứng dụng & DB |
| `GET` | `/swagger-ui.html` | Public | Giao diện Swagger UI tương tác API |

---

## 🧪 4. Cách Chạy Unit Test Riêng Lẻ

Dự án đã thiết lập cấu hình chạy test trên bộ nhớ tạm **H2 Database (In-Memory)** nên bạn có thể chạy test bất kỳ lúc nào mà **không cần bật PostgreSQL**.

Mở terminal tại thư mục `user-service` và thực hiện:

```bash
# Chạy toàn bộ bộ test
./mvnw test
```

### Kết quả mong đợi
Tất cả các bài test trong `UserServiceTest` và `UserServiceApplicationTests` sẽ thực thi thành công:
```text
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
[INFO] ------------------------------------------------------------------------
```
