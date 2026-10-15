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

Dùng Node.js 22 trở lên và Docker Compose. Cụm gồm 8 API (Gateway và 7 service), PostgreSQL, RabbitMQ, MinIO, 2 worker và 4 job migration/khởi tạo.

### 🔹 Bước 1: Khởi tạo Bí mật & Biến môi trường
Mở Terminal tại thư mục `Backend/` và chạy lệnh:
```bash
node scripts/init-secrets.js
```
Script tạo `.env`, mật khẩu ngẫu nhiên và cặp khóa ES256 mới trong `secrets/`. Chạy lại giữ nguyên credentials và kiểm tra cặp khóa. Khóa dev mẫu cũ được sao lưu rồi thay bằng cặp khóa mới; cấu hình mật khẩu mâu thuẫn giữa `.env` và secret file sẽ báo lỗi để tránh kết nối sai volume đang dùng.

### 🔹 Bước 2: Khởi chạy cụm Docker
```bash
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 180
```
Kiểm tra sức khỏe hệ thống:
```bash
curl http://localhost:3000/health
# Kết quả mong đợi: {"status":"ok","service":"api-gateway"}
```

User/Merchant chờ migration; storage-init tạo bucket KYC riêng tư và account chỉ truy cập prefix `kyc/`; worker chờ RabbitMQ mở cổng AMQP. Gateway chờ các API healthy. Không xóa volume cũ để xử lý lỗi mật khẩu. Cần điền credentials VNPAY Sandbox của nhóm trước khi thử thanh toán bên ngoài; giá trị khởi tạo chỉ phục vụ chạy local.

---

## 2. Kiến trúc Mạng Zero-Trust & Single Entrypoint

* **Mạng công khai (`public_net`):** **API Gateway** mở cổng ứng dụng `0.0.0.0:3000 -> 3000`.
* **Mạng nội bộ (`internal_net`):** Toàn bộ 7 Microservices con (`auth`, `user`, `wallet`, `payment`, `merchant`, `notification`, `admin`) và Message Broker RabbitMQ nằm hoàn toàn trong mạng cô lập. Không service con nào mở cổng ra ngoài Internet.
* **Cơ sở dữ liệu PostgreSQL:** Bind `127.0.0.1:5432` để lập trình viên dùng DBeaver/TablePlus. Các service kết nối nội bộ qua `postgres:5432`. Có thể đổi cổng host bằng `POSTGRES_HOST_PORT`.
* **MinIO:** Bind `127.0.0.1:19002` để browser đọc URL KYC có chữ ký; bucket không cho đọc ẩn danh. Nếu đổi `MINIO_HOST_PORT`, đặt `S3_PUBLIC_ENDPOINT` tương ứng. User truy cập storage nội bộ qua `http://minio:9000`.

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

Kịch bản `tests/deployment/full-smoke.mjs` kiểm chứng cụm thật từ Compose chính. Chạy tại root với Node.js 22 trở lên; cài dependency User để script tạo ảnh KYC tổng hợp bằng `sharp`:

```bash
npm ci --prefix packages/finvault-internal-auth
npm ci --prefix services/user-service
node scripts/init-secrets.js
docker compose -p finvault-full-check up -d --build --wait --wait-timeout 180
node tests/deployment/full-smoke.mjs
```

Project `finvault-full-check` dùng volume riêng nhưng dùng cùng cổng host trong `.env`; không chạy đồng thời với project Quick Start trên cùng các cổng. Script chỉ thêm tài khoản/hồ sơ tổng hợp, cấp ADMIN cho tài khoản vừa tạo và giữ lại dữ liệu để kiểm tra; không reset DB hoặc xóa volume.

### Kết quả đã kiểm chứng ngày 14/10/2026

- Health của Gateway và cả 7 API đạt; 3 thành phần hạ tầng healthy, 2 worker đang chạy, 4 job hoàn tất với exit code 0.
- Đăng ký, đăng nhập Web bằng HttpOnly cookie, refresh Web và xoay refresh token Mobile đạt.
- Truy cập User, Wallet, Payment, Notification qua Gateway đạt; truy cập Notification của người khác bị chặn.
- Header giả mạo không vượt qua xác thực/phân quyền; client không gọi được endpoint nội bộ Notification/Payment qua Gateway.
- Upload KYC lên MinIO, đọc bằng URL có chữ ký, chặn URL không chữ ký và Admin duyệt KYC đạt.
- Đăng ký, sửa, duyệt Merchant đạt; publisher xuất bản 3 sự kiện; User consumer xử lý sự kiện đăng ký gửi trùng đúng một lần.

Bằng chứng không chứa secret được ghi vào `.cache/deployment/full-smoke-result.json`. Báo cáo sửa cấu hình và giới hạn nghiệm thu: [Docker Runtime Review](docs/Docker_Runtime_Review_2026-10-14.md). Bài này không nghiệm thu giao dịch VNPAY bên ngoài, WebSocket hoặc toàn bộ nghiệp vụ Wallet/Payment.

---
*Tài liệu được biên soạn và bảo chứng bởi Đạt — FinVault Lead Security.*
