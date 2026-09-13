# Kế hoạch công việc (bản FINAL — chuyển stack) — Hữu
## user-service (Port 3002) + merchant-service (Port 3003)
### Stack: Node.js (Express) + Prisma + PostgreSQL

> Cập nhật từ bản Spring Boot trước đó — nhóm yêu cầu đổi sang Node.js để đồng nhất với 3 service còn lại (Đạt, Khoa, Nguyên). Toàn bộ logic nghiệp vụ, mã lỗi, chuẩn ID/datetime giữ nguyên như đã chốt trong `FinalWork.docx` — chỉ đổi công cụ hiện thực.

---

## 0. Thông tin nhanh

| | |
|---|---|
| Service | `user-service`, `merchant-service` |
| Port | `3002`, `3003` |
| Framework | Express.js |
| ORM | Prisma |
| Validation | Zod (hoặc Joi, thống nhất với nhóm) |
| Database | PostgreSQL 15+ (chung 1 instance vật lý toàn nhóm) |
| Test | Jest + Supertest |

**Điều nhẹ nhõm nhất khi đổi stack**: giờ bạn dùng **chung ngôn ngữ + chung ORM (Prisma)** với Đạt/Khoa/Nguyên — rất nhiều vấn đề "polyglot" đã bàn trước đây (serialize UUID lớn, lệch định dạng `Instant` vs `Date`, phải viết 2 loại Dockerfile, ai cũng phải cài JDK để test chéo...) **tự nhiên biến mất**, không cần xử lý nữa. Có thể copy gần như nguyên cấu trúc code của Đạt/Khoa để tiết kiệm thời gian setup.

---

## 1. Chuẩn chung BẮT BUỘC — không đổi so với bản trước, chỉ đổi cách hiện thực

### 1.1 Chuẩn ID (mục III.a)
- UUID v4 dạng string cho mọi khoá chính — Node.js dùng `crypto.randomUUID()` (built-in từ Node 14.17+, không cần cài thêm) hoặc để Prisma tự sinh qua `@default(uuid())`.

### 1.2 Correlation ID — X-Request-Id (mục III.c)
- Đọc lại header `X-Request-Id` từ api-gateway, không tự sinh mới nếu đã có. Middleware dùng chung:
```js
// middlewares/requestId.js
const { randomUUID } = require('crypto');

function requestIdMiddleware(req, res, next) {
  const requestId = req.headers['x-request-id'] || randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
}

module.exports = requestIdMiddleware;
```
- Dùng logger có hỗ trợ context (vd `pino` với `pino-http`, hoặc tự nối `requestId` vào mọi log tay):
```js
console.log(`[${req.requestId}] Fetching merchant ${id}`);
```

### 1.3 Bảng mã lỗi chuẩn hoá (mục II) — giữ nguyên, không đổi

| Error Code | HTTP | Khi nào bạn dùng |
|---|---|---|
| `VALIDATION_ERROR` | 400 | thiếu field bắt buộc / sai định dạng |
| `UNAUTHORIZED` | 401 | thiếu/sai JWT hoặc `X-Internal-Key` |
| `FORBIDDEN` | 403 | không phải chính chủ/admin |
| `NOT_FOUND` | 404 | user/merchant không tồn tại |
| `DUPLICATE_RESOURCE` | 409 | `authUserId`/email trùng, merchant trùng |
| `MERCHANT_INACTIVE` | 422 | dùng ở phía payment-service khi map từ `/active` |
| `INTERNAL_ERROR` | 500 | lỗi hệ thống/DB không xác định |

### 1.4 Response chuẩn `{ success, data, error }`
```js
// utils/apiResponse.js
function ok(data, message) {
  return { success: true, data, ...(message && { message }) };
}
function fail(code, message) {
  return { success: false, error: { code, message } };
}
module.exports = { ok, fail };
```

### 1.5 Error handler tập trung — thay cho `@RestControllerAdvice`
```js
// middlewares/errorHandler.js
const { fail } = require('../utils/apiResponse');

class AppError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function errorHandler(err, req, res, next) {
  console.error(`[${req.requestId}]`, err);

  if (err instanceof AppError) {
    return res.status(err.statusCode).json(fail(err.code, err.message));
  }
  if (err.code === 'P2025') { // Prisma: record not found
    return res.status(404).json(fail('NOT_FOUND', 'Resource not found'));
  }
  if (err.code === 'P2002') { // Prisma: unique constraint violation
    return res.status(409).json(fail('DUPLICATE_RESOURCE', 'Resource already exists'));
  }
  return res.status(500).json(fail('INTERNAL_ERROR', 'Unexpected error'));
}

module.exports = { errorHandler, AppError };
```

### 1.6 Datetime — Prisma tự xử lý đúng chuẩn
- Prisma `DateTime @default(now())` khi serialize qua `res.json()` tự ra đúng ISO-8601 với 3 chữ số mili-giây (`Date.toISOString()`) — **không cần xử lý gì thêm**, đây chính là điểm bạn từng phải làm thủ công (`@JsonFormat`, `truncatedTo`) bên Spring Boot mà giờ không cần nữa.

### 1.7 Database vật lý dùng chung (mục III.e)
- Prisma connection pool mặc định khá nhỏ, nhưng vẫn nên set rõ trong connection string nếu dùng chung instance nhỏ với 6 service khác:
```
DATABASE_URL="postgresql://user:pass@host:5432/user_db?connection_limit=3"
```

### 1.8 `.env` (mục V)
- Không commit `.env`, chỉ commit `.env.example`:
```
DATABASE_URL=
INTERNAL_KEY=
PORT=3002
```

---

## 2. `user-service` (Port 3002)

### Bước 1 — Mock API & Skeleton
- [ ] `npm init`, cài `express prisma @prisma/client zod dotenv`.
- [ ] Route trả JSON cứng khớp field name + status code với spec, để Nguyên (FE) test ngay:
```js
// routes/users.js — MOCK tạm, sẽ thay bằng logic thật ở Bước 3
router.get('/:id', (req, res) => {
  res.json(ok({ id: req.params.id, email: 'mock@finvault.dev', kycStatus: 'APPROVED' }));
});
```

### Bước 2 — Schema & Migration (Prisma)
```prisma
// user-service/prisma/schema.prisma
enum KycStatus {
  NONE
  PENDING
  APPROVED
  REJECTED
}

model User {
  id          String     @id @default(uuid())
  authUserId  String     @unique          // logical reference -> auth-service
  email       String
  fullName    String?
  phone       String?
  address     String?
  kycStatus   KycStatus  @default(NONE)
  idNumber    String?
  idImageUrl  String?
  deletedAt   DateTime?                    // soft-delete, không có FK vật lý
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt

  @@index([authUserId])
}
```
- [ ] `npx prisma migrate dev --name init`.
- [ ] Seed data cố định (đúng cách đã chốt trước — **không dùng mock fallback ẩn trong code**, dùng seed thật qua Prisma):
```js
// prisma/seed.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  await prisma.user.upsert({
    where: { id: '11111111-1111-1111-1111-111111111111' },
    update: {},
    create: {
      id: '11111111-1111-1111-1111-111111111111',
      authUserId: 'a0000000-0000-0000-0000-000000000001',
      email: 'test-user1@finvault.dev',
      fullName: 'Nguyen Van A',
      kycStatus: 'APPROVED',
    },
  });
}
main().finally(() => prisma.$disconnect());
```
Chạy `npx prisma db seed`, ghi ID này vào `TEST_DATA_IDS.md` chung của nhóm.

### Bước 3 — Business Logic, Validation
- [ ] `POST /api/users` — nội bộ (`X-Internal-Key`), auth-service gọi sau signup:
```js
router.post('/', internalKeyMiddleware, async (req, res, next) => {
  try {
    const { authUserId, email } = schema.parse(req.body); // Zod validate
    const user = await prisma.user.create({ data: { authUserId, email } });
    res.status(201).json(ok(user));
  } catch (err) { next(err); }
});
```
- [ ] `GET /api/users/:id` — **không mock nữa**, để Prisma tự throw `P2025` khi không tìm thấy → error handler map sang `404 NOT_FOUND` đúng chuẩn.
```js
router.get('/:id', async (req, res, next) => {
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.params.id } });
    res.json(ok(user));
  } catch (err) { next(err); }
});
```
- [ ] `PUT /api/users/:id` — check `req.headers['x-user-id']` (header gateway gắn — **chốt tên chính xác với Đạt**) khớp `:id`, hoặc role admin.
- [ ] `POST /api/users/:id/kyc` — set `kycStatus: 'PENDING'`.
- [ ] **[Bổ sung — bắt buộc, đã xác định từ trước]**:
```
PATCH /api/users/:id/kyc-status   (nội bộ, X-Internal-Key)
Body: { "kycStatus": "APPROVED" | "REJECTED" }
```
admin-service gọi endpoint này để duyệt KYC thật — chốt tên/format với Đạt.
- [ ] Validate bằng Zod: `z.object({ authUserId: z.string().uuid(), email: z.string().email() })`.

### Bước 4 — Tích hợp & Testing
- [ ] Jest + Supertest: test `POST /api/users` trả `409 DUPLICATE_RESOURCE` khi `authUserId` trùng, `GET /api/users/:id` trả `404 NOT_FOUND` khi id không tồn tại.
- [ ] Test thật với Đạt (signup → tạo hồ sơ) và (duyệt KYC → đổi status).

---

## 3. `merchant-service` (Port 3003)

### Bước 1 — Mock API & Skeleton
- [ ] Ưu tiên mock `GET /:id/active` sớm nhất cho Khoa.

### Bước 2 — Schema & Migration
```prisma
// merchant-service/prisma/schema.prisma
enum MerchantStatus {
  PENDING
  APPROVED
  REJECTED
}

model Merchant {
  id            String          @id @default(uuid())
  ownerId       String                          // logical reference -> user-service
  businessName  String
  taxId         String?
  bankAccount   String?
  status        MerchantStatus  @default(PENDING)
  deletedAt     DateTime?
  createdAt     DateTime        @default(now())
  updatedAt     DateTime        @updatedAt

  @@index([status])
}
```
- [ ] Seed 1 merchant cố định (`22222222-2222-2222-2222-222222222222`, `status: APPROVED`, `ownerId` trỏ đúng user seed ở trên) — ghi vào `TEST_DATA_IDS.md`.

### Bước 3 — Business Logic, Validation
- [ ] `POST /api/merchants/register` — `status` mặc định `PENDING`.
- [ ] `GET/PUT /api/merchants/:id` — chủ merchant sửa, không tự sửa `status`.
- [ ] `GET /api/merchants/:id/active` — **không mock fallback**, để Prisma throw khi không tìm thấy → `404`; nếu tìm thấy nhưng không APPROVED thì vẫn trả `200 success:true, active:false` (đã chốt với Khoa):
```js
router.get('/:id/active', internalKeyMiddleware, async (req, res, next) => {
  try {
    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { id: req.params.id } });
    res.json(ok({ id: merchant.id, active: merchant.status === 'APPROVED', status: merchant.status }));
  } catch (err) { next(err); } // không tồn tại -> 404 NOT_FOUND qua error handler
});
```
- [ ] **[Bổ sung — bắt buộc]**:
```
PATCH /api/merchants/:id/status   (nội bộ, X-Internal-Key)
Body: { "status": "APPROVED" | "REJECTED" }
```

### Bước 4 — Tích hợp & Testing
- [ ] Test thật với Khoa dùng ID seed cố định — xác nhận `404` khi gọi ID ngẫu nhiên không tồn tại (đúng behavior thật, không phải mock).
- [ ] Test thật với Đạt (duyệt merchant → đổi status).

---

## 4. Việc chung cho cả 2 service

- [ ] **Internal Key middleware** dùng chung:
```js
// middlewares/internalKey.js
function internalKeyMiddleware(req, res, next) {
  if (req.headers['x-internal-key'] !== process.env.INTERNAL_KEY) {
    return res.status(401).json(fail('UNAUTHORIZED', 'Invalid internal key'));
  }
  next();
}
```
- [ ] **Health check**: `GET /health` tự viết (Express không có Actuator built-in như Spring Boot):
```js
router.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: true });
  } catch {
    res.status(503).json({ status: 'error', db: false });
  }
});
```
- [ ] **Docker** — đơn giản hơn hẳn so với Java, không cần multi-stage build:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN npx prisma generate
EXPOSE 3002
CMD ["node", "index.js"]
```
Thêm entry vào `docker-compose.yml` gốc chung — vì cùng Node.js với các service khác, `healthcheck` khởi động nhanh hơn nhiều so với JVM trước đây, `start_period` có thể để ngắn hơn.

---

## 5. Việc dọn dẹp từ code Spring Boot cũ

- [ ] Archive lại code Java cũ (đừng xoá hẳn — có thể cần tham khảo lại logic nghiệp vụ đã viết, chỉ là đổi ngôn ngữ hiện thực).
- [ ] Đối chiếu lại toàn bộ endpoint đã liệt kê ở tài liệu đặc tả API (`FinVault_Huu_UserMerchantService_API.docx`) — nội dung nghiệp vụ, mã lỗi, field name **không đổi**, chỉ đổi cú pháp code, nên có thể dùng lại license nguyên spec đó khi review với nhóm.
- [ ] Cập nhật `docker-compose.yml` gốc: đổi Dockerfile path/build context của 2 service từ Java sang Node.js.
- [ ] Báo cho Đạt/Khoa/Nguyên biết việc đổi stack — vì các README/ghi chú trước đó có nhắc "2 service này viết Java" (vd phần polyglot đã bàn), cần cập nhật lại README gốc để không gây hiểu lầm khi người khác đọc tài liệu cũ.

---

## 6. Checklist trước khi báo "xong" 1 endpoint

- [ ] Trả đúng `{ success, data, error }`.
- [ ] Lỗi dùng đúng `error.code` theo bảng mục 1.3.
- [ ] Đúng HTTP status.
- [ ] Endpoint nội bộ có `internalKeyMiddleware`.
- [ ] Log kèm `req.requestId`.
- [ ] Không còn logic mock/fallback ẩn trong code thật — chỉ dùng seed data.
- [ ] Test qua Postman + Jest, cả trường hợp thành công lẫn `404`/`409`.

---

## 7. Thứ tự làm gợi ý

1. Setup Express project, Prisma, middleware chung (`requestId`, `internalKey`, `errorHandler`).
2. Mock API cả 2 service (Bước 1) — báo nhóm ngay.
3. `user-service`: schema + seed → `POST /api/users` thật → `GET/PUT/:id` → KYC submit → `kyc-status` nội bộ.
4. `merchant-service`: schema + seed → `register` + `GET/PUT/:id` → `GET /:id/active` thật → `status` nội bộ.
5. Test tích hợp thật với Đạt và Khoa bằng ID seed cố định.
6. Dockerfile Node.js + cập nhật `docker-compose.yml` gốc.
7. Frontend 2 trang (không đổi, vẫn gọi REST/JSON như cũ — FE không quan tâm backend đổi ngôn ngữ).
