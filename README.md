# FinVault E-Wallet Backend — Cẩm nang Tích hợp & Vận hành (Tuần 1 - Tuần 3)
> **Tác giả:** Đạt (Lead Security, Gateway & Database Infrastructure)  
> **Dự án:** Ví điện tử FinVault (Kiến trúc Microservices Bảo mật Zero-Trust)  
> **Phiên bản:** Tuần 3 — Hoàn thiện Hạ tầng Redis, QR Login, Rate Limiter, Token Family & Tích hợp Gateway

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
6. [Quy ước Chuẩn hóa Lỗi & Định dạng API (M1 - M7 & M17)](#6-quy-ước-chuẩn-hóa-lỗi--định-dạng-api)
7. [Kiểm thử Nghiệm thu Hệ thống (DoD Tuần 1)](#7-kiểm-thử-nghiệm-thu-hệ-thống-dod-tuần-1)
8. [Hạ tầng Redis & Bộ nhớ Phân tán (Nhiệm vụ Đ12)](#8-hạ-tầng-redis--bộ-nhớ-phân-tán)
9. [Cơ chế Đăng nhập bằng mã QR (QR Login - Nhiệm vụ Đ13)](#9-cơ-chế-đăng-nhập-bằng-mã-qr-qr-login)
10. [Bộ đếm Giới hạn Tần suất Redis tại Gateway (Nhiệm vụ Đ14)](#10-bộ-đếm-giới-hạn-tần-suất-redis-tại-gateway)
11. [Refresh Token Family & Bẫy Tái sử dụng Token (Nhiệm vụ Đ15b)](#11-refresh-token-family--bẫy-tái-sử-dụng-token)
12. [Thu hẹp Whitelist Gateway & Proxy Tiện ích (Nhiệm vụ Đ16)](#12-thu-hẹp-whitelist-gateway--proxy-tiện-ích)

---

## 1. Khởi động nhanh trong 2 bước

Dùng Node.js 22 trở lên và Docker Compose. Cụm gồm 8 API (Gateway và 7 service), PostgreSQL, Redis 7, RabbitMQ, MinIO, 2 worker và 4 job migration/khởi tạo.

### 🔹 Bước 1: Khởi tạo Bí mật & Biến môi trường
Mở Terminal tại thư mục `Backend/` và chạy lệnh:
```bash
node scripts/init-secrets.js
```
Script tạo `.env`, mật khẩu ngẫu nhiên cho Postgres/RabbitMQ/Redis và cặp khóa ES256 mới trong `secrets/`. Chạy lại giữ nguyên credentials và kiểm tra cặp khóa. Mật khẩu Redis được ghi vào `secrets/redis_password.txt` và export thành `REDIS_URL`.

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

User/Merchant chờ migration; storage-init tạo bucket KYC riêng tư; worker chờ RabbitMQ mở cổng AMQP. Gateway chờ Redis và các API healthy.

---

## 2. Kiến trúc Mạng Zero-Trust & Single Entrypoint

* **Mạng công khai (`public_net`):** **API Gateway** mở cổng ứng dụng `0.0.0.0:3000 -> 3000`.
* **Mạng nội bộ (`internal_net`):** Toàn bộ 7 Microservices con (`auth`, `user`, `wallet`, `payment`, `merchant`, `notification`, `admin`), Database PostgreSQL, Redis 7 và Message Broker RabbitMQ nằm hoàn toàn trong mạng cô lập. Không service con nào mở cổng trực tiếp ra ngoài Internet.
* **Cơ sở dữ liệu PostgreSQL:** Bind `127.0.0.1:5432` để lập trình viên dùng DBeaver/TablePlus. Các service kết nối nội bộ qua `postgres:5432`.
* **Redis In-Memory Database:** Chạy trên `redis:6379` trong `internal_net`, mount secret `/run/secrets/redis_password`, lưu trữ persistent volume `redis_data`.
* **MinIO:** Bind `127.0.0.1:19002` để browser đọc URL KYC có chữ ký; bucket không cho đọc ẩn danh.

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
2. **Cập nhật `Dockerfile` của Service:**  
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

   export const getMyBalance = (req: Request, res: Response) => {
       const userId = req.auth?.userId  // Đã verify chữ ký ES256
       const role = req.auth?.role      // 'USER' | 'ADMIN'
   }
   ```

---

### 👨‍💻 Dành cho Hữu (`user-service` & `merchant-service`)

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

1. **Backend `notification-service` (Socket.IO handshake):**
   ```typescript
   import { randomBytes, randomUUID } from 'node:crypto'
   import { verifyGatewayToken } from 'finvault-internal-auth'

   const issuedTickets = new Map<string, { jti: string; userId: string; expiresAt: number }>()
   const usedTickets = new Map<string, number>()

   function issueSocketTicket(userId: string) {
     const ticket = randomBytes(32).toString('base64url')
     const expiresAt = Date.now() + 60_000
     issuedTickets.set(ticket, { jti: randomUUID(), userId, expiresAt })
     return { ticket, expiresAt: new Date(expiresAt).toISOString() }
   }
   ```
2. **Frontend Developer (Client Web & Mobile):**
   * **Base URL:** Luôn luôn gọi qua `http://localhost:3000`.
   * **Kết nối WebSocket qua Gateway:** Gọi `GET /api/notifications/socket-ticket` bằng HTTP client đang xác thực; lấy `data.ticket` trong response. Dùng hàm `auth` để xin ticket mới mỗi lần Socket.IO kết nối hoặc reconnect.
   * **Webhook / IPN VNPAY:**  
     Route `GET /api/payments/topups/vnpay/*` và `/api/funding/vnpay/*` đã được whitelist tại Gateway. VNPAY Sandbox có thể gọi trực tiếp callback mà không bị chặn `401`.

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
   * Trigger mức database `prevent_ledger_modification()` chặn đứng mọi thao tác `UPDATE` hoặc `DELETE` trên bảng `LedgerEntry`.

---

## 5. Cơ chế Phân luồng Xác thực Web vs Mobile App (Nhiệm vụ Đ4)

Tại `auth-service`, cơ chế trả và xoay vòng Refresh Token (RTR) đã được phân luồng tự động:

| Nền tảng | Cách gửi định danh | Vị trí lưu Refresh Token | Mục đích bảo mật |
| :--- | :--- | :--- | :--- |
| **Web Browser** | Mặc định (hoặc `platform: "web"`) | **HTTP-Only Cookie** (`path: /api/auth`, `SameSite: lax`) | Chống hoàn toàn tấn công XSS đọc cắp token từ `localStorage`. |
| **Mobile App** | Header `x-client-platform: mobile` | **JSON Response Body** (`res.data.refreshToken`) | Cho phép app React Native / Flutter lưu vào **iOS Keychain** hoặc **Android Keystore**. |

---

## 6. Quy ước Chuẩn hóa Lỗi & Định dạng API (M1 - M7 & M17)

### Chữ ký Token Mật mã Gateway (M1 & M17)
* **Thuật toán:** `ES256` (ECDSA với đường cong NIST P-256).
* **Thời hạn sống (TTL):** Đúng `60 giây` (giảm thiểu rủi ro replay attack).
* **Quyết định kiến trúc M17:** Bỏ claim `kycTier` khỏi Gateway Token. Cơ sở dữ liệu của `wallet-service` (`Wallet.kycTier`) là Nguồn sự thật duy nhất (Single Source of Truth).
* **Claims bắt buộc:**
  ```json
  {
    "iss": "finvault-gateway",
    "aud": "finvault-internal-services",
    "sub": "<userId_uuid>",
    "role": "USER" | "ADMIN",
    "jti": "<crypto_random_uuid>"
  }
  ```

### Thống nhất Mã lỗi Token Giao dịch (Transaction Token)
* Hết hạn 60s: Trả HTTP 401 với mã `TXN_TOKEN_EXPIRED`.
* Sai binding paymentId / số tiền: Trả HTTP 403 với mã `TXN_TOKEN_MISMATCH`.
* Đã sử dụng (Replay Attack): Trả HTTP 409 với mã `TXN_TOKEN_REUSED`.

---

## 7. Kiểm thử Nghiệm thu Hệ thống (DoD Tuần 1)

Kịch bản `tests/deployment/full-smoke.mjs` kiểm chứng cụm thật từ Compose chính. Chạy tại root với Node.js 22 trở lên:
```bash
npm ci --prefix packages/finvault-internal-auth
npm ci --prefix services/user-service
node scripts/init-secrets.js
docker compose -p finvault-full-check up -d --build --wait --wait-timeout 180
node tests/deployment/full-smoke.mjs
```

---

## 8. Hạ tầng Redis & Bộ nhớ Phân tán (Nhiệm vụ Đ12)

Redis 7 Alpine đóng vai trò bộ nhớ đệm (cache), khóa phân tán (distributed lock), lưu trữ phiên QR tạm thời và bộ đếm giới hạn tần suất (rate limiter) cho toàn bộ hệ thống FinVault.

### Cấu hình Docker & Kết nối:
* **Container:** `redis:7-alpine` trên mạng nội bộ `internal_net`.
* **Cơ chế Secret:** Mật khẩu Redis nạp tự động qua Docker secret `/run/secrets/redis_password`.
* **Client ioredis Singleton:**
  ```typescript
  export const redisClient = new Redis(env.redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy: (times) => (times > 10 ? null : Math.min(times * 100, 2000))
  })
  export let isRedisReady = false
  ```

---

## 9. Cơ chế Đăng nhập bằng mã QR (QR Login - Nhiệm vụ Đ13)

Cho phép người dùng đăng nhập trên trình duyệt Web bằng cách dùng ứng dụng Mobile đã đăng nhập để quét mã QR:

```
[Web Browser]               [API Gateway]             [Auth Service / Redis]            [Mobile App]
      |                           |                            |                              |
      |-- 1. POST /qr-login/init ->|--------------------------->|                              |
      |<- 2. qrId, pollSecret, QR -|<---------------------------|                              |
      |                           |                            |                              |
      |                           |                            |<-- 3. Quét QR + Confirm -----|
      |                           |                            |   (Atomic Lua Script)        |
      |                           |                            |                              |
      |-- 4. GET /:id/status ---->|--------------------------->|                              |
      |   (Polling chu kỳ 2s)     |                            | (APPROVED -> Trả Token &     |
      |<- 5. AccessToken + Cookie-|<---------------------------|  Xóa sạch Redis key)         |
```

1. **Khởi tạo (`POST /api/auth/qr-login/init`):** Sinh `qrId`, `nonce`, `pollSecret`, lưu hash vào Redis key `qr:<qrId>` với TTL đúng **120 giây**.
2. **Xác nhận từ Mobile (`POST /api/auth/qr-login/confirm`):** Mobile gửi Bearer Token kèm `qrId` và `nonce`. Thực thi bằng **Lua Script nguyên tử**: kiểm tra nonce, cập nhật trạng thái `APPROVED` và gắn `userId`.
3. **Thăm dò trạng thái (`GET /api/auth/qr-login/:id/status`):** Web gửi `pollSecret` định kỳ mỗi 2s. Khi trạng thái là `APPROVED`, Server cấp Access Token + Set HttpOnly Cookie và **xóa ngay key khỏi Redis** (chỉ trả phiên 1 lần duy nhất, gọi lần 2 trả 410 `QR_EXPIRED`).

---

## 10. Bộ đếm Giới hạn Tần suất Redis tại Gateway (Nhiệm vụ Đ14)

Triển khai middleware `rateLimiter.ts` bảo vệ toàn diện hệ sinh thái FinVault khỏi các đợt tấn công DDoS, Brute-Force mã PIN và spam API.

### Đặc điểm kỹ thuật:
* **Cửa sổ cố định (Fixed Window) bằng Lua Script:**
  Tăng biến đếm và gán thời gian hết hạn (`INCR` + `PEXPIRE` + `PTTL`) trong **1 round-trip nguyên tử duy nhất**, loại bỏ hoàn toàn race condition và lỗi treo khóa vĩnh viễn.
* **Chống giả mạo IP:**
  Sử dụng `req.ip` kết hợp cấu hình `app.set('trust proxy', 1)`. Loại bỏ việc đọc thô header `X-Forwarded-For` của client.
* **Bảo vệ 2 tầng:**
  - **Tầng IP (Toàn hệ thống):** Giới hạn tối đa **120 requests/phút** trên từng IP (key: `rl:ip:<ip>`).
  - **Tầng User (Route nhạy cảm):** Giới hạn **10 requests/phút** cho các tác vụ tiền tệ: `pin/verify`, `payments/:id/confirm`, `funding/cash-out` (key: `rl:user:<userId>:<action>`).
* **Chiến lược chịu lỗi Fail-Closed & Fail-Open:**
  - Khi Redis gặp sự cố: Các endpoint Auth/PIN áp dụng **Fail-Closed (HTTP 503)** để ngăn chặn kẻ xấu lợi dụng đánh sập Redis hòng dò mật khẩu/PIN.
  - Các endpoint đọc thông thường áp dụng **Fail-Open (Next + Log)** để tránh tê liệt hệ thống.
* **Headers chuẩn RFC:** Luôn trả về `X-RateLimit-Limit`, `X-RateLimit-Remaining`, và `Retry-After`.

---

## 11. Refresh Token Family & Bẫy Tái sử dụng Token (Nhiệm vụ Đ15b)

Triển khai tiêu chuẩn OAuth 2.0 Token Rotation (RFC 6749 & RFC 6819) bảo vệ tài khoản người dùng khỏi các cuộc tấn công đánh cắp phiên:

* **Mã gia đình phiên (`familyId`):** Khi đăng nhập, một `familyId` duy nhất được sinh ra. Khi token được xoay vòng, token mới vẫn kế thừa cùng `familyId`.
* **Cờ thu hồi (`revokedAt`):** Thay vì xóa token cũ khi xoay vòng, hệ thống giữ lại dòng phiên và đánh dấu `revokedAt = now()`.
* **Bẫy phát hiện tái sử dụng (Token Reuse Detection - Nghiệm thu S1):**
  Nếu một token đã bị thu hồi (`revokedAt !== null`) mà lại xuất hiện trong request gửi lên `/api/auth/refresh`:
  1. Server lập tức phát hiện hành vi tái sử dụng token bị trộm.
  2. Thu hồi tức thì **TOÀN BỘ** các token con cháu trong cùng `familyId` (`UPDATE Session SET revokedAt = now() WHERE familyId = ...`).
  3. Trả về mã lỗi HTTP 401 với mã lỗi `TOKEN_REUSE_DETECTED`.

---

## 12. Thu hẹp Whitelist Gateway & Proxy Tiện ích (Nhiệm vụ Đ16)

* **Vá lỗ hổng Whitelist:** Loại bỏ hoàn toàn regex quét diện rộng `/^\/api\/funding(\/.*)?$/`. Thu hẹp danh sách trắng công khai về đúng endpoint IPN/Return của VNPAY (`/api/payments/topups/vnpay/*`, `/api/funding/vnpay/*`). Tuyệt đối không cho phép route rút tiền `/api/funding/cash-out` lọt qua xác thực.
* **Định tuyến Reverse Proxy Tiện ích:** Thêm proxy `/api/utilities` chuyển tiếp an toàn các dịch vụ nạp tiền điện thoại và thanh toán hóa đơn sang `payment-service`.
* **Loại bỏ claim `kycTier` khỏi Gateway Token (M17):** Đồng bộ quyết định kiến trúc, tránh xung đột trạng thái giữa token tạm và Database ví.

---
*Tài liệu được cập nhật và bảo chứng hoàn tất Tuần 3 bởi Đạt — FinVault Lead Security.*
