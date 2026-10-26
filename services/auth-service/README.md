# 🔐 FINVAULT AUTH SERVICE — TÀI LIỆU BÀN GIAO AUTH-TXN (TUẦN 2)

> **Người thực hiện:** Đạt  
> **Người nhận bàn giao:** Khoa (`payment-service`), Nguyên, Hữu  
> **Nội dung:** Đặc tả API mã PIN, Hợp đồng chữ ký số `transactionToken` (ES256), Public Key và Hướng dẫn kiểm thực chống Replay Attack (Mốc Cuối Ngày 2 - Quyết định M8).

---

## 1. THÔNG SỐ KỸ THUẬT CỦA `transactionToken` (QUYẾT ĐỊNH M8)

| Thuộc tính | Giá trị chuẩn mực |
| :--- | :--- |
| **Thuật toán ký** | **ES256** (ECDSA qua đường cong NIST P-256 / `prime256v1`) |
| **Thời hạn sống (TTL)** | **60 giây** (`expiresIn: '60s'`) |
| **Issuer (`iss`)** | `finvault-auth-service` |
| **Audience (`aud`)** | `finvault-payment-service` |
| **Cơ chế chống Replay Attack** | Trường `jti` (UUID v4 ngẫu nhiên), chỉ được dùng **đúng 1 lần** |

### Mẫu Payload Claims trong JWT:
```json
{
  "iss": "finvault-auth-service",
  "aud": "finvault-payment-service",
  "sub": "b2c1d0a5-8123-4f90-a3bc-112233445566",
  "paymentId": "pay_98765432-1234-5678-90ab-cdef12345678",
  "amount": "100000",
  "jti": "e4f8d2a1-7788-9900-aabb-ccddeeff0011",
  "iat": 1718000000,
  "exp": 1718000060
}
```

---

## 2. KHÓA CÔNG KHAI (PUBLIC KEY) DÀNH CHO KHOA (`payment-service`)

Khoa lưu Public Key này vào biến môi trường `AUTH_TXN_PUBLIC_KEY` hoặc dùng trực tiếp để verify chữ ký `transactionToken`:

```text
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEc0Zn3u+YxvL3UVOxNFYovMRcuD4u
DTQNSXJm0cUp0o4NQEj/At3JoZMk3avIRwC02kFj1SdeXKwy202ltsZcAg==
-----END PUBLIC KEY-----
```

### Mẫu hàm kiểm tra Token phía `payment-service`:
```typescript
import jwt from 'jsonwebtoken'

export interface TransactionTokenPayload {
  iss: string
  aud: string
  sub: string
  paymentId: string
  amount: string
  jti: string
  exp: number
}

export const verifyTransactionToken = (token: string, publicKey: string): TransactionTokenPayload => {
  return jwt.verify(token, publicKey, {
    algorithms: ['ES256'],
    issuer: 'finvault-auth-service',
    audience: 'finvault-payment-service'
  }) as TransactionTokenPayload
}
```

### Quy tắc kiểm tra chống gian lận tại API `POST /api/payments/:id/confirm`:
1. **Kiểm tra chữ ký & Hết hạn**: Dùng hàm trên, nếu quá 60s sẽ ném lỗi 401.
2. **Kiểm tra toàn vẹn**: 
   * `payload.sub === req.user.id` (Người xác nhận phải đúng là người chuyển).
   * `payload.paymentId === payment.id` (Token không được dùng cho đơn hàng khác).
   * `payload.amount === String(payment.amount)` (Số tiền không bị tráo đổi).
3. **Chống Replay Attack (Test Case A4)**:
   * Lưu `payload.jti` vào cơ sở dữ liệu với ràng buộc `UNIQUE` (hoặc `SETNX` trên Redis với TTL 65s).
   * Nếu gọi lần 2 cùng `transactionToken`, database sẽ báo lỗi trùng khóa ➔ Khoa trả lỗi `409 Conflict`.

---

## 3. DANH SÁCH BỘ API MÃ PIN (AUTH-TXN) ĐÃ SẴN SÀNG

Tất cả các API dưới đây đều yêu cầu Header: `Authorization: Bearer <accessToken>`

Client gọi qua API Gateway; Gateway xác thực access token rồi ký `x-gateway-token`
để Auth kiểm tra bằng `finvault-internal-auth`. Auth lấy danh tính từ token đã xác
thực, không tin header `x-user-id` do client gửi. Cả `/api/auth-txn/pin` và alias
`/api/auth/pin` dùng cùng cơ chế này. Lời gọi trực tiếp giữa các service phải có
`x-internal-key` hợp lệ và `x-user-id` dạng UUID. Signup/signin/refresh/signout vẫn
là các endpoint công khai.

Auth bắt buộc cấu hình `INTERNAL_KEY` (hoặc alias cũ `INTERNAL_API_KEY`), không có
khóa mặc định. Docker Compose mount khóa Gateway tại
`GATEWAY_PUBLIC_KEY_FILE=/run/secrets/gateway_public_key`.
Build image từ thư mục gốc repository để có package dùng chung:
`docker build -f services/auth-service/Dockerfile .`.

### 3.1. Cài đặt mã PIN lần đầu (Setup PIN)
* **Endpoint:** `POST /api/auth-txn/pin/setup`
* **Request Body:**
  ```json
  {
    "pin": "123456",
    "confirmPin": "123456"
  }
  ```
* **Response Thành công (201 Created):**
  ```json
  {
    "success": true,
    "data": {
      "message": "Thiết lập mã PIN giao dịch thành công"
    },
    "message": "Thiết lập mã PIN giao dịch thành công"
  }
  ```

---

### 3.2. Xác thực PIN nhận `transactionToken` (Verify PIN - Nhiệm vụ Đ7 & Đ8)
* **Endpoint:** `POST /api/auth-txn/pin/verify`
* **Request Body:**
  ```json
  {
    "pin": "123456",
    "paymentId": "pay_98765432-1234-5678-90ab-cdef12345678",
    "amount": "100000"
  }
  ```
* **Response Thành công (200 OK):**
  ```json
  {
    "success": true,
    "data": {
      "transactionToken": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9...",
      "expiresIn": 60,
      "message": "Xác thực mã PIN thành công"
    },
    "message": "Xác thực mã PIN thành công"
  }
  ```

* **Trường hợp sai mã PIN (400 Bad Request):**
  ```json
  {
    "success": false,
    "error": {
      "code": "INVALID_PIN",
      "message": "Mã PIN không chính xác. Bạn còn 4 lần thử."
    }
  }
  ```

* **Trường hợp bị khóa do sai 5 lần (423 Locked - Test Case A3):**
  ```json
  {
    "success": false,
    "error": {
      "code": "PIN_LOCKED",
      "message": "Bạn đã nhập sai mã PIN 5 lần liên tiếp. Chức năng giao dịch bị tạm khóa 30 phút."
    }
  }
  ```

---

### 3.3. Đổi mã PIN (Change PIN)
* **Endpoint:** `POST /api/auth-txn/pin/change`
* **Request Body:**
  ```json
  {
    "oldPin": "123456",
    "newPin": "654321",
    "confirmNewPin": "654321"
  }
  ```

---

### 3.4. Kiểm tra trạng thái mã PIN của tài khoản
* **Endpoint:** `GET /api/auth-txn/pin/status`
* **Response (200 OK):**
  ```json
  {
    "success": true,
    "data": {
      "hasPin": true,
      "isLocked": false,
      "remainingLockSeconds": 0
    },
    "message": "Lấy trạng thái mã PIN thành công"
  }
  ```

---

## 4. HƯỚNG DẪN TEST NHANH BẰNG CURL

```bash
# 1. Cài đặt PIN
curl -X POST http://localhost:3001/api/auth-txn/pin/setup \
  -H "Authorization: Bearer <TOKEN_DANG_NHAP>" \
  -H "Content-Type: application/json" \
  -d '{"pin":"123456","confirmPin":"123456"}'

# 2. Verify lấy transactionToken
curl -X POST http://localhost:3001/api/auth-txn/pin/verify \
  -H "Authorization: Bearer <TOKEN_DANG_NHAP>" \
  -H "Content-Type: application/json" \
  -d '{"pin":"123456","paymentId":"test-pay-01","amount":"50000"}'
```
