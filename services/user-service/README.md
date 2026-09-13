# `user-service` — Hướng Dẫn Phát Triển & Khởi Chạy (Node.js / Express / Prisma)

Dịch vụ `user-service` quản lý thông tin hồ sơ người dùng (User Profile) và quy trình nộp/duyệt xác minh danh tính (KYC).

---

## 🚀 1. Cách Khởi Chạy Dịch Vụ (Local Development)

### Yêu cầu môi trường
- **Node.js 18+** (Khuyên dùng Node.js 20 LTS)
- **PostgreSQL 15+** (Mặc định Port `5432`)
- File cấu hình môi trường `.env`

### Biến Môi Trường (`.env`)

Tạo tệp `.env` tại thư mục gốc `user-service`:

```env
PORT=3002
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/user_service
JWT_SECRET=your_default_jwt_secret_key_must_be_at_least_32_bytes_long
INTERNAL_KEY=default_internal_secret_key_123456
CLIENT_URL=http://localhost:5173
```

### Lệnh khởi chạy dịch vụ

```bash
# Cài đặt dependencies
npm install

# Chạy chế độ phát triển (Dev with Nodemon & tsx)
npm run dev

# Kiểm tra biên dịch TypeScript
npx tsc --noEmit

# Chạy sản phẩm (Build & Start)
npm run build
npm start
```

---

## 🗄️ 2. Quy Trình Database & Migration (Prisma ORM)

Dịch vụ sử dụng **Prisma ORM** để tương tác cơ sở dữ liệu PostgreSQL.

```bash
# Phát sinh Prisma Client
npx prisma generate

# Đồng bộ Schema với DB (Development)
npx prisma db push

# Tạo và chạy Migration
npx prisma migrate dev --name init
```

---

## 📡 3. Danh Sách API Endpoints

| Method | Endpoint | Yêu cầu Xác thực | Mô tả Chức năng |
|---|---|---|---|
| `POST` | `/api/users` | Header `X-Internal-Key` | Khởi tạo user profile (gọi nội bộ từ `auth-service`) |
| `GET` | `/api/users/:id` | Public / JWT | Lấy chi tiết hồ sơ user theo User UUID (`id`) |
| `GET` | `/api/users/by-auth/:authUserId` | Public / JWT | Lấy chi tiết hồ sơ user theo `authUserId` |
| `PUT` | `/api/users/:id` | JWT (Chính chủ / Admin) | Cập nhật thông tin profile (`fullName`, `phone`, `address`) |
| `POST` | `/api/users/:id/kyc` | JWT (Chính chủ / Admin) | Nộp hồ sơ KYC (`idNumber`, `idImageUrl`) |
| `PATCH` | `/api/users/:id/kyc-status` | Header `X-Internal-Key` / Admin | Duyệt KYC (`APPROVED` / `REJECTED`) |
| `GET` | `/api/users` | JWT (Chỉ Admin) | Xem danh sách user có phân trang (`page`, `limit`, `search`) |

