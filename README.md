# FinVault E-Wallet Backend — Cẩm nang Tích hợp & Vận hành (Tuần 1)
> **Tác giả:** Đạt (Lead Security, Gateway & Database Infrastructure)  
> **Dự án:** Ví điện tử FinVault (Kiến trúc Microservices Bảo mật Zero-Trust)  
> **Phiên bản:** Tuần 1 — Khởi tạo Lõi Ví & Chuẩn hóa Bảo mật

---

## 📌 MỤC LỤC
1. [Khởi động nhanh trong 2 bước (Quick Start cho cả nhóm)](#1-khởi-động-nhanh-trong-2-bước)
2. [Kiến trúc Mạng Zero-Trust & Single Entrypoint](#2-kiến-trúc-mạng-zero-trust--single-entrypoint)
3. [Hướng dẫn tích hợp Thư viện Chung `finvault-internal-auth`](#3-hướng-dẫn-tích-hợp-thư-viện-chung-finvault-internal-auth)
   - [👨‍💻 Dành cho Khoa (`wallet-service` & `payment-service`)](#-dành-cho-khoa-wallet-service--payment-service)
   - [👨‍💻 Dành cho Hữu (`user-service` & `merchant-service`)](#-dành-cho-hữu-user-service--merchant-service)
   - [👨‍💻 Dành cho Nguyên (`notification-service` & `Frontend Web/Mobile`)](#-dành-cho-nguyên-notification-service--frontend-webmobile)
4. [Bảo vệ Sổ cái Bất biến (Immutable Ledger)](#4-bảo-vệ-sổ-cái-bất-biến-immutable-ledger)
5. [Cơ chế Phân luồng Xác thực Web vs Mobile App (Nhiệm vụ Đ4)](#5-cơ-chế-phân-luồng-xác-thực-web-vs-mobile-app)
6. [Quy ước Chuẩn hóa Lỗi & Định dạng API (M1 - M7)](#6-quy-ước-chuẩn-hóa-lỗi--định-dạng-api)
7. [Kiểm thử Nghiệm thu Hệ thống (DoD Tuần 1)](#7-kiểm-thử-nghiệm-thu-hệ-thống-dod-tuần-1)

---

## 1. Khởi động nhanh trong 2 bước

Để các thành viên (Khoa, Hữu, Nguyên) khi kéo nhánh `dat` hoặc `main` về máy sạch có thể chạy ngay toàn bộ cụm 10 Microservices mà không gặp bất kỳ lỗi thiếu file môi trường hay secrets:

### 🔹 Bước 1: Khởi tạo Bí mật & Biến môi trường
Mở Terminal tại thư mục `Backend/` và chạy lệnh:
```bash
node scripts/init-secrets.js
```
*Script sẽ tự động tạo thư mục `Backend/secrets/` với các cặp khóa mật mã ECDSA ES256 (`.pem`), file mật khẩu Docker Secrets (`.txt`) và tạo file `.env` chuẩn từ `.env.example`.*

### 🔹 Bước 2: Khởi chạy cụm Docker 10 Containers
```bash
docker compose up -d --build
```
Kiểm tra sức khỏe hệ thống:
```bash
curl http://localhost:3000/health
# Kết quả mong đợi: {"status":"ok","service":"api-gateway"}
```

---

## 2. Kiến trúc Mạng Zero-Trust & Single Entrypoint

* **Mạng công khai (`public_net`):** Chỉ duy nhất **API Gateway** được cấp quyền mở cổng ra máy chủ thật (`0.0.0.0:3000 -> 3000`).
* **Mạng nội bộ (`internal_net`):** Toàn bộ 7 Microservices con (`auth`, `user`, `wallet`, `payment`, `merchant`, `notification`, `admin`) và Message Broker RabbitMQ nằm hoàn toàn trong mạng cô lập. Không service con nào mở cổng ra ngoài Internet.
* **Cơ sở dữ liệu PostgreSQL:** Expose cổng `5432` cục bộ để phục vụ lập trình viên kết nối qua DBeaver / TablePlus. Trong `docker-compose.yml`, các service kết nối qua hostname nội bộ `postgres:5432`.

> ⚠️ **LƯU Ý BẢO MẬT:**
> Client bên ngoài **tuyệt đối không thể gọi thẳng** vào các cổng `3001` - `3007`. Mọi yêu cầu bắt buộc phải đi qua API Gateway cổng `3000`. Cờ tĩnh cũ `x-gateway-verified: true` đã bị **xóa bỏ hoàn toàn** tại Gateway bằng middleware `sanitizeHeaders` để chống tấn công giả mạo header.

---

## 3. Hướng dẫn tích hợp Thư viện Chung `finvault-internal-auth`

Gói thư viện: `packages/finvault-internal-auth` (Đã hoàn thiện bởi Đạt).

### 👨‍💻 Dành cho Khoa (`wallet-service` & `payment-service`)
*(Nhiệm vụ K6 — Thay thế xác thực cũ bằng thư viện dùng chung)*

1. **Khai báo dependency:**  
   Trong `services/wallet-service/package.json` và `services/payment-service/package.json`:
   ```json
   "dependencies": {
     "finvault-internal-auth": "file:../../packages/finvault-internal-auth"
   }
   ```
2. **Cập nhật `Dockerfile` của Service (Để Docker build được monorepo package):**  
   Đổi `context` trong `docker-compose.yml` thành thư mục gốc:
   ```yaml
   wallet-service:
     build:
       context: .
       dockerfile: ./services/wallet-service/Dockerfile
   ```
   Trong `services/wallet-service/Dockerfile`:
   ```dockerfile
   COPY packages/finvault-internal-auth ./packages/finvault-internal-auth
   RUN cd packages/finvault-internal-auth && npm install --omit=dev
   COPY services/wallet-service/package*.json ./services/wallet-service/
   RUN cd services/wallet-service && npm install
   COPY services/wallet-service ./services/wallet-service
   WORKDIR /app/services/wallet-service
   ```
3. **Sử dụng trong Express App:**
   ```typescript
   import { requireGateway } from 'finvault-internal-auth'

   // Bảo vệ toàn bộ router của wallet/payment
   app.use('/api/wallets', requireGateway)

   // Trong controller, lấy trực tiếp danh tính người dùng đã được bảo chứng:
   export const getMyBalance = (req: Request, res: Response) => {
       const userId = req.auth?.userId  // Đã verify chữ ký ES256
       const role = req.auth?.role      // 'USER' | 'ADMIN'
       const kycTier = req.auth?.kycTier // 0 | 1 | 2
       // ...
   }
   ```

---

### 👨‍💻 Dành cho Hữu (`user-service` & `merchant-service`)
*(Nhiệm vụ H1, H5 — Loại bỏ verify token bằng secret riêng)*

1. **Loại bỏ Secret phụ thuộc:**  
   Xóa bỏ việc đọc `process.env.ACCESS_TOKEN_SECRET` để tự verify JWT. Service của bạn không cần giữ Private Key hay Token Secret của Gateway nữa.
2. **Khai báo middleware:**
   ```typescript
   import { requireGateway } from 'finvault-internal-auth'

   app.use('/api/users', requireGateway)
   app.use('/api/merchants', requireGateway)
   ```
3. **Lấy danh tính User:**  
   Dùng `req.auth.userId` thay vì tin tưởng header `x-user-id` không có kiểm chứng.

---

### 👨‍💻 Dành cho Nguyên (`notification-service` & `Frontend Web/Mobile`)
*(Nhiệm vụ N4, N5, N6)*

1. **Backend `notification-service` (HTTP & Socket.IO Handshake):**
   ```typescript
   import { requireGateway, verifyGatewayToken } from 'finvault-internal-auth'

   // 1. Với HTTP API
   app.use('/api/notifications', requireGateway)

   // 2. Với WebSocket / Socket.IO Handshake:
   io.use((socket, next) => {
       const token = socket.handshake.auth.token
       if (!token) return next(new Error('AUTHENTICATION_ERROR'))
       try {
           const decoded = verifyGatewayToken(token)
           socket.data.userId = decoded.userId
           next()
       } catch (err) {
           next(new Error('INVALID_TOKEN'))
       }
   })
   ```
2. **Frontend Developer (Client Web & Mobile):**
   * **Base URL:** Luôn luôn gọi qua `http://localhost:3000`.
   * **Kết nối WebSocket qua Gateway:**
     ```javascript
     import { io } from 'socket.io-client'

     const socket = io('http://localhost:3000', {
       path: '/socket.io',
       auth: { token: userAccessToken } // Access Token lấy sau khi đăng nhập
     })
     ```
   * **Webhook / IPN VNPAY:**  
     Route `GET /api/funding/vnpay/ipn` và `/api/payments/topups/vnpay/*` đã được whitelist tại Gateway. VNPAY Sandbox có thể gọi trực tiếp callback mà không bị chặn `401`.

---

## 4. Bảo vệ Sổ cái Bất biến (Immutable Ledger)

Dự án áp dụng nguyên tắc **Append-Only Immutable Ledger** cho bảng `LedgerEntry` trong cơ sở dữ liệu `wallet_service`:

1. **DB Role Separation:**
   * User DB của `wallet-service` là `wallet_user`.
   * Đã thực thi lệnh phân quyền:
     ```sql
     GRANT SELECT, INSERT ON TABLE "LedgerEntry" TO wallet_user;
     REVOKE UPDATE, DELETE ON TABLE "LedgerEntry" FROM wallet_user;
     ```
2. **Kernel Trigger PL/pgSQL:**
   * Một Trigger mức database `prevent_ledger_modification()` được cài đặt trên bảng `LedgerEntry`.
   * Bất kỳ câu lệnh `UPDATE` hoặc `DELETE` nào tác động vào bảng này (kể cả từ tài khoản root Postgres) đều sẽ bị văng lỗi:
     ```text
     ERROR: LedgerEntry is append-only. Modification and deletion are strictly prohibited.
     ```
   * 👉 **Quy tắc cho Khoa (Wallet Dev):** Mọi giao dịch biến động số dư chỉ được thực hiện bằng cách tạo mới dòng giao dịch (`INSERT`), tuyệt đối không viết lệnh `UPDATE` số tiền cũ của Ledger.

---

## 5. Cơ chế Phân luồng Xác thực Web vs Mobile App

Tại `auth-service`, cơ chế trả và xoay vòng Refresh Token (RTR) đã được phân luồng tự động:

| Nền tảng | Cách gửi định danh | Vị trí lưu Refresh Token | Mục đích bảo mật |
| :--- | :--- | :--- | :--- |
| **Web Browser** | Mặc định (hoặc `platform: "web"`) | **HTTP-Only Cookie** (`path: /api/auth`, `SameSite: lax`) | Chống hoàn toàn tấn công XSS đọc cắp token từ `localStorage`. |
| **Mobile App** | Header `x-client-platform: mobile` | **JSON Response Body** (`res.data.refreshToken`) | Cho phép app React Native / Flutter lưu vào **iOS Keychain** hoặc **Android Keystore**. |

### Endpoint Refresh Token:
* **Web:** Gửi `POST http://localhost:3000/api/auth/refresh` (Trình duyệt tự đính kèm cookie).
* **Mobile:** Gửi `POST http://localhost:3000/api/auth/refresh` với header `x-client-platform: mobile` và body:
  ```json
  { "refreshToken": "chuỗi_refresh_token_đã_lưu_trong_keystore" }
  ```

---

## 6. Quy ước Chuẩn hóa Lỗi & Định dạng API

### Chữ ký Token Mật mã Gateway (M1)
* **Thuật toán:** `ES256` (ECDSA với đường cong NIST P-256).
* **Thời hạn sống (TTL):** Đúng `60 giây` (giảm thiểu rủi ro replay attack).
* **Claims bắt buộc:**
  ```json
  {
    "iss": "finvault-gateway",
    "aud": "finvault-internal-services",
    "sub": "<userId_uuid>",
    "role": "USER" | "ADMIN",
    "kycTier": 0 | 1 | 2,
    "jti": "<crypto_random_uuid>"
  }
  ```

### Định dạng Response thống nhất
* **Thành công (Success):**
  ```json
  {
    "success": true,
    "data": { ... },
    "message": "Thông báo thành công"
  }
  ```
* **Thất bại (Error):**
  ```json
  {
    "success": false,
    "error": {
      "code": "UNAUTHORIZED | INVALID_GATEWAY_TOKEN | FORBIDDEN | NOT_FOUND | VALIDATION_ERROR",
      "message": "Mô tả chi tiết nguyên nhân lỗi"
    },
    "requestId": "uuid-v4-để-truy-vết-log"
  }
  ```

---

## 7. Kiểm thử Nghiệm thu Hệ thống (DoD Tuần 1)

Đạt đã xây dựng sẵn kịch bản kiểm thử toàn diện E2E. Sau khi khởi động Docker, chạy lệnh sau để nghiệm thu:

```bash
node scratch/test_system.mjs
```

### Kết quả nghiệm thu thực tế:
* `[PASS]` 1. Health Check Gateway (`200 OK`)
* `[PASS]` 2. Chặn đứng Header giả mạo `x-gateway-verified` (`401 UNAUTHORIZED`)
* `[PASS]` 3. Đăng ký tài khoản mới qua Gateway (`201 Created`)
* `[PASS]` 4. Đăng nhập Web qua HTTP-Only Cookie (`200 OK`)
* `[PASS]` 5. Đăng nhập Mobile nhận Refresh Token qua Body (`200 OK`)
* `[PASS]` 6. Xoay vòng Refresh Token Rotation cho Mobile (`200 OK`)
* `[PASS]` 7. Gọi `user-service` có bảo vệ với Bearer Token (`200 OK`)
* `[PASS]` 8. Chặn User thường truy cập vào route Admin (`403 FORBIDDEN`)
* `[PASS]` 9. Whitelist IPN VNPAY bypass Gateway Auth không bị chặn (`Status 404 upstream`)
* `[PASS]` 10. Handshake và Upgrade WebSocket Socket.IO qua Gateway (`101 Switching Protocols`)

---
*Tài liệu được biên soạn và bảo chứng bởi Đạt — FinVault Lead Security.*
