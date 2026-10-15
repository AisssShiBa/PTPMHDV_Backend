# FinVault Internal Auth (`finvault-internal-auth`)
> **Thư viện xác thực nội bộ dùng chung cho toàn bộ Microservices của FinVault**  
> *Phiên bản: 1.0.0 — tích hợp runtime User/Merchant ngày 11/10/2026; giữ API middleware/helper đã bàn giao.*

## Cập nhật runtime

- Package xuất `dist/index.js` và declaration; `npm ci` tại thư mục package chạy build qua `prepare`. Cài/build package trước khi cài service dùng dependency `file:`.
- Từ root backend: `rtk npm ci --prefix packages/finvault-internal-auth`, sau đó `rtk npm ci --prefix services/user-service` (tương tự Merchant/Admin).
- Test package: `rtk npm test --prefix packages/finvault-internal-auth`. Test dùng assertion, trả exit code lỗi khi không đạt.
- Production cần `GATEWAY_PUBLIC_KEY_FILE` hoặc `GATEWAY_PUBLIC_KEY` ES256. Thiếu key, file sai, key sai curve hoặc public key dev đều bị từ chối. HTTP/worker User/Merchant kiểm tra key ngay khi khởi động.
- Claims bắt buộc: UUID `sub`, role `USER/ADMIN/MERCHANT`, tier nguyên 0–2, `jti` không rỗng, `iat`/`exp` hợp lệ; TTL tối đa 60 giây; issuer/audience như mô tả bên dưới.
- `jti` dùng định danh token; package chưa lưu replay cache, không tuyên bố tự chặn mọi lần phát lại trong TTL.
- Lỗi middleware giữ `requestId` do middleware correlation gắn trước đó.
- User/Merchant dùng adapter internal-key đã xác thực cho Auth provision/Admin review; nhánh người dùng gọi `requireGateway` của package. Gateway loại bỏ internal key do client gửi. Không còn bypass marker ở hai service.
- Private key fixture chỉ dùng helper test, bị vô hiệu khi `NODE_ENV=production`; không phải credential triển khai. Gateway production giữ private key riêng, service chỉ được cấp public key.
- Dockerfile có package local phải build từ root backend. Xem [hướng dẫn runtime](../../docs/User_Merchant_Runtime.md).

---

## 📌 MỤC LỤC
1. [Tại sao toàn nhóm phải chuyển sang dùng thư viện này?](#1-tại-sao-toàn-nhóm-phải-chuyển-sang-dùng-thư-viện-này)
2. [Hướng dẫn cài đặt nhanh (2 bước - 3 phút)](#2-hướng-dẫn-cài-đặt-nhanh-2-bước---3-phút)
3. [Hướng dẫn tích hợp chi tiết theo từng thành viên](#3-hướng-dẫn-tích-hợp-chi-tiết-theo-từng-thành-viên)
   - [Khoa: wallet-service & payment-service (K6)](#-khoa-wallet-service--payment-service-nhiệm-vụ-k6)
   - [Nguyên: notification-service (HTTP & Socket.IO) (N4, N5)](#-nguyên-notification-service-nhiệm-vụ-n4-n5)
   - [Hữu: user-service & merchant-service (H1, H5)](#-hữu-user-service--merchant-service-nhiệm-vụ-h1-h5)
   - [Đạt: admin-service (Đ5)](#-đạt-admin-service-nhiệm-vụ-đ5)
4. [Hướng dẫn viết Unit / Integration Test (Không lo lỗi Token)](#4-hướng-dẫn-viết-unit--integration-test)
5. [Cấu trúc dữ liệu `req.auth` & Bảng mã lỗi HTTP](#5-cấu-trúc-dữ-liệu-reqauth--bảng-mã-lỗi-http)

---

## 1. Tại sao toàn nhóm phải chuyển sang dùng thư viện này?

### ❌ Cơ chế cũ (ĐÃ BỊ XÓA BỎ):
Trước đây, Gateway chỉ gán một cờ tĩnh dạng chữ: `req.headers['x-gateway-verified'] = 'true'`.
* **Lỗ hổng nguy hiểm:** Bất kỳ ai gọi thẳng vào service nội bộ mà tự chèn header `x-gateway-verified: true` đều có thể giả mạo Gateway và thao túng số dư ví.
* Các service con tự lưu `JWT_SECRET` riêng lẻ, gây phân mảnh và dễ rò rỉ mã bí mật.

### ✅ Cơ chế mới (Chuẩn Zero-Trust Cryptography):
* Gateway sử dụng **Khóa riêng (Private Key)** để ký ra một chuỗi JWT nội bộ siêu ngắn (**TTL = 60 giây**) bằng thuật toán **ES256 (NIST P-256)** gắn vào header `x-gateway-token`.
* Runtime service **chỉ được cấp Khóa công khai (Public Key)** của Gateway; helper test dùng cặp khóa fixture riêng.
* Các service con chỉ việc import middleware `requireGateway`, thư viện sẽ tự kiểm chứng chữ ký số, kiểm tra thời hạn 60s và tự động giải mã danh tính người dùng vào `req.auth`.

---

## 2. Hướng dẫn cài đặt nhanh (2 bước - 3 phút)

### Bước 1: Khai báo dependency vào `package.json` của service bạn
Mở file `package.json` trong service của bạn (ví dụ: `services/wallet-service/package.json`), thêm dòng sau vào mục `"dependencies"`:

```json
"dependencies": {
  "finvault-internal-auth": "file:../../packages/finvault-internal-auth"
}
```

### Bước 2: Cài đặt package
Mở Terminal tại thư mục của service đó và chạy:
```bash
npm install
```
*(Node.js sẽ tự động tạo liên kết symlink tới thư viện nội bộ).*

---

## 3. Hướng dẫn tích hợp chi tiết theo từng thành viên

### 👨‍💻 KHOA: `wallet-service` & `payment-service` (Nhiệm vụ K6)
**Mục tiêu:** Xóa bỏ hoàn toàn middleware tự verify cũ (`gatewayOrInternalAuth.ts` hoặc `requireGateway.ts`).

1. **Bảo vệ endpoint ví trong Express:**
   ```typescript
   import { requireGateway } from 'finvault-internal-auth'

   // Đặt middleware này trước các route cần bảo vệ:
   app.use('/api/wallets', requireGateway)
   ```

2. **Lấy danh tính & cấp độ KYC từ `req.auth`:**
   ```typescript
   // Xem số dư ví của chính mình:
   app.get('/api/wallets/me', (req, res) => {
       const userId = req.auth!.userId      // UUID người dùng
       const kycTier = req.auth!.kycTier    // 0: Chưa KYC, 1: Cơ bản, 2: Nâng cao

       // Dùng kycTier để kiểm tra ngay hạn mức chuyển tiền mà không cần gọi sang user-service!
       const wallet = await walletService.getByUserId(userId)
       return res.json({ success: true, data: wallet })
   })
   ```

---

### 👨‍💻 NGUYÊN: `notification-service` (Nhiệm vụ N4, N5)
**Mục tiêu:** Xác thực cả route HTTP `/me` (N3) và kết nối WebSocket Socket.IO (N4).

1. **Bảo vệ route HTTP xem thông báo cá nhân (`/api/notifications/me`):**
   ```typescript
   import { requireGateway } from 'finvault-internal-auth'

   app.get('/api/notifications/me', requireGateway, async (req, res) => {
       const userId = req.auth!.userId
       // Tuyệt đối không lấy userId từ req.params để chống User A xem trộm của User B
       const notifications = await notificationService.getByUserId(userId)
       return res.json({ success: true, data: notifications })
   })
   ```

2. **Xác thực kết nối Socket.IO qua `verifyGatewayToken` (N4):**
   ```typescript
   import { verifyGatewayToken } from 'finvault-internal-auth'

   io.use((socket, next) => {
       // Lấy token từ handshake.auth (không nhận qua query string url)
       const token = socket.handshake.auth.token
       if (!token) {
           return next(new Error('INVALID_GATEWAY_TOKEN'))
       }

       try {
           // Dùng hàm verifyGatewayToken giải mã trực tiếp:
           const auth = verifyGatewayToken(token)
           
           // Lưu thông tin vào socket session và join vào phòng riêng của user:
           socket.data.userId = auth.userId
           socket.join(`user:${auth.userId}`)
           return next()
       } catch (error) {
           return next(new Error('INVALID_GATEWAY_TOKEN'))
       }
   })
   ```

---

### 👨‍💻 HỮU: `user-service` & `merchant-service` (Nhiệm vụ H1, H5)
**Mục tiêu:** Bỏ verify access JWT/marker cũ và cấu hình `JWT_SECRET` / `ACCESS_TOKEN_SECRET` ở hai service. Giữ adapter internal đã xác thực để Auth/Admin tiếp tục gọi được.

1. **Bảo vệ route xem thông tin cá nhân `/api/users/me`:**
   ```typescript
   import { requireGateway } from 'finvault-internal-auth'

   app.get('/api/users/me', requireGateway, async (req, res) => {
       const userId = req.auth!.userId
       const profile = await userService.getProfile(userId)
       return res.json({ success: true, data: profile })
   })
   ```

2. **Dọn dẹp môi trường (DoD #8):**
   * Trong file `src/config/env.ts` của `user-service`: Xóa bỏ việc kiểm tra `JWT_SECRET` hoặc `ACCESS_TOKEN_SECRET`. Service của Hữu giờ đây hoàn toàn không cần giữ bất kỳ secret nào của Token!

---

### 👨‍💻 ĐẠT: `admin-service` (Nhiệm vụ Đ5)
**Mục tiêu:** Sử dụng kết hợp `requireGateway` và `requireRole('ADMIN')`.

```typescript
import { requireGateway, requireRole } from 'finvault-internal-auth'

// 1. Toàn bộ route admin bắt buộc phải đi qua Gateway:
app.use('/api/admin', requireGateway)

// 2. Chặn đứng người dùng thường (Role: USER) - Chỉ ADMIN mới được thực hiện:
app.use('/api/admin', requireRole('ADMIN'))

app.get('/api/admin/users', async (req, res) => {
    // Chỉ có ADMIN mới vào được đến đây, role USER sẽ tự động bị trả về 403 FORBIDDEN
    const users = await adminService.getAllUsers()
    return res.json({ success: true, data: users })
})
```

---

## 4. Hướng dẫn viết Unit / Integration Test

Khi viết integration test với `supertest` trong service của bạn, bạn không cần phải chạy Gateway thật. Thư viện đã cung cấp sẵn hàm helper **`createTestGatewayToken`** để sinh token test hợp lệ trong 1 dòng:

```typescript
import request from 'supertest'
import app from '../src/app'
import { createTestGatewayToken } from 'finvault-internal-auth'

test('User có thể xem số dư ví của chính mình', async () => {
    const testUserId = '11111111-2222-3333-4444-555555555555'

    // 1. Sinh nhanh token test giả lập từ Gateway:
    const testToken = createTestGatewayToken(testUserId, 'USER', 1)

    // 2. Bắn request kèm header x-gateway-token:
    const response = await request(app)
        .get('/api/wallets/me')
        .set('x-gateway-token', testToken)
        .expect(200)

    expect(response.body.data.userId).toBe(testUserId)
})

test('Gọi thẳng không qua Gateway thì bị chặn 401', async () => {
    // Không truyền x-gateway-token
    const response = await request(app)
        .get('/api/wallets/me')
        .expect(401)

    expect(response.body.error.code).toBe('INVALID_GATEWAY_TOKEN')
})
```

---

## 5. Cấu trúc dữ liệu `req.auth` & Bảng mã lỗi HTTP

### Cấu trúc Object `req.auth` (Đã được định nghĩa sẵn kiểu TypeScript):
| Thuộc tính | Kiểu dữ liệu | Ý nghĩa |
| :--- | :--- | :--- |
| `req.auth.userId` | `string` | UUID của chủ tài khoản đang gửi request. |
| `req.auth.role` | `string` | Vai trò trong hệ thống: `'USER'`, `'MERCHANT'`, `'ADMIN'`. |
| `req.auth.kycTier` | `number` | Cấp bậc ví: `0` (Chưa KYC), `1` (Cơ bản), `2` (Nâng cao). |
| `req.auth.jti` | `string` | Mã định danh token; không thay thế replay cache. |

### Bảng mã lỗi chuẩn HTTP:
| Mã HTTP | `error.code` | Tình huống xảy ra | Phản hồi JSON mẫu |
| :--- | :--- | :--- | :--- |
| **401 Unauthorized** | `INVALID_GATEWAY_TOKEN` | Gọi trực tiếp service, thiếu token, token quá 60s, hoặc sai chữ ký. | `{"success": false, "error": {"code": "INVALID_GATEWAY_TOKEN", "message": "Truy cập bị từ chối..."}}` |
| **403 Forbidden** | `FORBIDDEN` | Token là `USER` nhưng cố tình gọi vào route bắt buộc `ADMIN`. | `{"success": false, "error": {"code": "FORBIDDEN", "message": "Từ chối quyền truy cập: Bạn cần vai trò [ADMIN]..."}}` |

---


