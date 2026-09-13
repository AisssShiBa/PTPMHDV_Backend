# `merchant-service` — Hướng Dẫn Phát Triển & Khởi Chạy (Node.js / Express / Prisma)

Dịch vụ `merchant-service` quản lý thông tin cửa hàng/đối tác (Merchant Profile), quy trình đăng ký, xét duyệt và cung cấp API xác minh trạng thái hoạt động cho dịch vụ thanh toán (`payment-service`).

---

## 🚀 1. Cách Khởi Chạy Dịch Vụ (Local Development)

### Yêu cầu môi trường
- **Node.js 18+** (Khuyên dùng Node.js 20 LTS)
- **PostgreSQL 15+** (Mặc định Port `5432`)
- File cấu hình môi trường `.env`

### Biến Môi Trường (`.env`)

Tạo tệp `.env` tại thư mục gốc `merchant-service`:

```env
PORT=3003
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/merchant_service
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
| `POST` | `/api/merchants/register` | JWT User / `X-User-Id` | Đăng ký hồ sơ merchant mới (Trạng thái mặc định `PENDING`) |
| `GET` | `/api/merchants/:id` | Public / JWT | Lấy chi tiết hồ sơ merchant theo Merchant UUID (`id`) |
| `PUT` | `/api/merchants/:id` | JWT (Chủ merchant / Admin) | Cập nhật thông tin merchant (`businessName`, `taxId`, `bankAccount`) |
| `PATCH` | `/api/merchants/:id/status` | Admin JWT / `X-Internal-Key` | Duyệt / Từ chối merchant (`APPROVED` / `REJECTED`) |
| `GET` | `/api/merchants/:id/active` | Public / Header `X-Internal-Key` | Kiểm tra trạng thái active (`{ active: true/false }`) — dùng nội bộ |
| `GET` | `/api/merchants` | JWT (Chỉ Admin) | Xem danh sách merchant có lọc theo `status`, `search` và phân trang |

