# `merchant-service` — Hướng Dẫn Phát Triển, Chạy & Kiểm Thử Độc Lập

Dịch vụ `merchant-service` quản lý thông tin cửa hàng/đối tác (Merchant Profile), quy trình đăng ký, xét duyệt và cung cấp API xác minh trạng thái hoạt động cho dịch vụ thanh toán (`payment-service`).

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
| `PORT` | `3003` | Cổng HTTP Server cho `merchant-service` |
| `DB_HOST` | `localhost` | Địa chỉ PostgreSQL Database |
| `DB_PORT` | `5432` | Cổng PostgreSQL Database |
| `DB_NAME` | `merchant_service_db` | Tên cơ sở dữ liệu |
| `DB_USER` | `postgres` | Tài khoản kết nối Database |
| `DB_PASSWORD` | `postgres` | Mật khẩu kết nối Database |
| `INTERNAL_KEY` | `default_internal_secret_key_123456` | Secret Key xác thực request giữa các microservices |
| `JWT_SECRET` | `your_default_jwt_secret_key_must_be_at_least_32_bytes_long` | Chuỗi secret để verify JWT Token |

### Lệnh khởi chạy dịch vụ

Mở terminal tại thư mục `merchant-service` và gõ:

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
> $env:PORT="3003"; $env:DB_USER="postgres"; $env:DB_PASSWORD="your_password"; .\mvnw spring-boot:run
> ```

---

## 🗄️ 2. Quy Trình Chạy Migration (Flyway)

> [!NOTE]
> **Khác biệt quan trọng so với các Node.js Service (Prisma) của Đạt/Khoa/Nguyên:**
> - Bên Node.js sử dụng Prisma CLI và phải gõ lệnh thủ công (`npx prisma migrate dev`).
> - **Trong Spring Boot của Hữu**: Dùng **Flyway Migration** được tích hợp thẳng vào luồng khởi động ứng dụng.

### Cách thức Flyway hoạt động:
1. Mỗi khi ứng dụng `merchant-service` khởi động (`spring-boot:run` hoặc `java -jar`), Flyway sẽ **tự động kết nối tới PostgreSQL**.
2. Flyway quét các file SQL chứa trong thư mục `src/main/resources/db/migration/` (ví dụ `V1__init.sql`).
3. Nếu phát hiện script migration mới chưa được chạy, Flyway sẽ **tự động thực thi SQL** để tạo/cập nhật bảng mà bạn không cần gõ thêm bất kỳ lệnh nào.

### Khi muốn tạo thêm Migration mới:
Tạo file SQL mới trong `src/main/resources/db/migration/` tuân thủ quy tắc đặt tên của Flyway:
- `V2__add_new_column_to_merchants.sql`
- `V3__create_merchant_indexes.sql`

---

## 📡 3. Danh Sách API Endpoints

Đặc tả chi tiết xem trong tài liệu `FinVault_Huu_UserMerchantService_API.docx` hoặc [Huu_KeHoach_Final.md](file:///d:/HDV/PTPMHDV_Backend/Huu_KeHoach_Final.md).

| Method | Endpoint | Yêu cầu Xác thực | Mô tả Chức năng |
|---|---|---|---|
| `POST` | `/api/merchants/register` | JWT User | Đăng ký hồ sơ merchant mới (Trạng thái mặc định `PENDING`) |
| `GET` | `/api/merchants/{id}` | Public / JWT | Lấy chi tiết hồ sơ merchant theo Merchant UUID (`id`) |
| `PUT` | `/api/merchants/{id}` | JWT (Chủ merchant / Admin) | Cập nhật thông tin merchant (`businessName`, `taxId`, `bankAccount`) |
| `PATCH` | `/api/merchants/{id}/status` | Admin JWT / `X-Internal-Key` | Duyệt / Từ chối merchant (`APPROVED` / `REJECTED`) — gọi từ `admin-service` |
| `GET` | `/api/merchants/{id}/active` | Header `X-Internal-Key` | Kiểm tra trạng thái active (`{ active: true/false }`) — gọi nội bộ từ `payment-service` |
| `GET` | `/api/merchants` | JWT (Chỉ Admin) | Xem danh sách merchant có lọc theo `status`, `search` và phân trang |
| `GET` | `/actuator/health` | Public | Health check trạng thái ứng dụng & DB |
| `GET` | `/swagger-ui.html` | Public | Giao diện Swagger UI tương tác API |

---

## 🧪 4. Cách Chạy Unit Test Riêng Lẻ

Dự án đã thiết lập cấu hình chạy test trên bộ nhớ tạm **H2 Database (In-Memory)** nên bạn có thể chạy test bất kỳ lúc nào mà **không cần bật PostgreSQL**.

Mở terminal tại thư mục `merchant-service` và thực hiện:

```bash
# Chạy toàn bộ bộ test
./mvnw test
```

### Kết quả mong đợi
Tất cả các bài test trong `MerchantServiceTest` và `MerchantServiceApplicationTests` sẽ thực thi thành công:
```text
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
[INFO] ------------------------------------------------------------------------
```
