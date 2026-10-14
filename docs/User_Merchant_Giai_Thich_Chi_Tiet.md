# Giải thích chi tiết User Service và Merchant Service trong FinVault

**Dành cho:** Hữu — người phụ trách hai service, muốn hiểu nghiệp vụ, đọc code và trình bày với nhóm.  
**Đối chiếu source:** 12/10/2026, workspace `PTPMHDV_Backend`, bao gồm thay đổi chưa commit và đợt làm rõ tên ID trong User/Merchant.  
**Cách đọc:** đọc mục 1–4 để nắm bức tranh chung; mục 5–11 để hiểu User; mục 12–15 để hiểu Merchant; các mục cuối phục vụ đọc code, chạy thử và thuyết trình.

Tài liệu này mô tả **code đang có**, phân biệt với chức năng chưa triển khai. Ví dụ dùng dữ liệu giả, không chứa tài khoản hoặc khóa thật. Mục 21 tách kết quả kiểm chứng đã lưu ngày 11/10/2026 khỏi lần chạy lại 44 test và typecheck ngày 12/10/2026 sau khi đổi tên nội bộ; chưa chạy lại toàn bộ kiểm thử tích hợp/acceptance trong đợt đổi tên này.

## 1. Hai service của bạn làm gì?

Hãy hình dung FinVault có một người dùng tên An. An đăng ký tài khoản, bổ sung thông tin cá nhân, gửi giấy tờ để xác minh danh tính và đăng ký cửa hàng “An Store”.

| Việc An làm | Thành phần chịu trách nhiệm chính |
|---|---|
| Đăng ký tài khoản, đăng nhập, đổi access token bằng refresh token | Auth Service |
| Gửi request vào hệ thống | Gateway tiếp nhận và xác thực access token |
| Xem/sửa họ tên, số điện thoại, địa chỉ | **User Service** |
| Gửi giấy tờ KYC, lưu kết quả duyệt KYC | **User Service** |
| Đăng ký cửa hàng, sửa hồ sơ cửa hàng, lưu trạng thái xét duyệt | **Merchant Service** |
| Thao tác xét duyệt từ giao diện quản trị, ghi audit phía quản trị | Admin Service gọi User/Merchant |
| Số dư, giữ tiền, thanh toán | Các service tài chính tương ứng; không do hai service này xử lý |

**User Service quản lý hồ sơ của một người. Merchant Service quản lý hồ sơ kinh doanh do một người sở hữu.** Hai hồ sơ có thể cùng tồn tại và có hai quy trình xét duyệt khác nhau.

Ví dụ:

- An có tài khoản Auth và hồ sơ User nhưng chưa đăng ký Merchant: hoàn toàn bình thường.
- An có KYC `APPROVED`, Merchant vẫn `PENDING`: hai kết quả độc lập.
- Merchant được `APPROVED` không có nghĩa số dư tăng hoặc giao dịch thanh toán đã được tạo.
- Code đăng ký Merchant hiện không gọi User Service để bắt buộc KYC phải được duyệt trước. Không nên trình bày điều kiện này như một tính năng đã có.

## 2. Kiến trúc tổng thể và cách hai service liên hệ với hệ thống

```mermaid
flowchart TD
    FE[Frontend] --> GW[Gateway]
    GW --> AUTH[Auth Service]
    GW --> USER[User HTTP Service]
    GW --> MERCHANT[Merchant HTTP Service]
    GW --> ADMIN[Admin Service]
    AUTH -->|HTTP nội bộ tạo profile| USER
    ADMIN -->|HTTP nội bộ review KYC| USER
    ADMIN -->|HTTP nội bộ review Merchant| MERCHANT
    USER --> UDB[(Dữ liệu User)]
    USER --> S3[(MinIO / S3 private)]
    MERCHANT --> MDB[(Dữ liệu Merchant và Outbox)]
    MQ[(RabbitMQ)] -->|user.registered| UC[User consumer]
    UC --> UDB
    MP[Merchant publisher] -->|Đọc Outbox| MDB
    MP -->|merchant events| MQ
```

Trong sơ đồ, “Dữ liệu User” và “Dữ liệu Merchant” thể hiện quyền sở hữu dữ liệu của từng service; không khẳng định chúng bắt buộc nằm trên hai máy PostgreSQL riêng. Môi trường test dùng các schema riêng trong cùng một database.

Có hai kiểu giao tiếp:

| Kiểu | Ví dụ trong code | Đặc điểm |
|---|---|---|
| HTTP đồng bộ | Admin gọi User để duyệt KYC | Caller chờ kết quả request |
| Message bất đồng bộ | Merchant publisher gửi event lên RabbitMQ | HTTP có thể hoàn tất trước khi event được gửi/xử lý |

Hiện signup của Auth **tạo profile qua HTTP**. User consumer đã sẵn sàng nhận `user.registered`, nhưng không vì thế mà kết luận Auth đang phát event đăng ký. Publisher registration phía Auth không nằm trong phần triển khai này.

User và Merchant không cần gọi trực tiếp nhau cho các thao tác hồ sơ hiện tại. Điểm liên kết chính là **cùng dùng Auth ID để nhận diện người sở hữu**.

## 3. Những thuật ngữ cần hiểu trước khi đọc code

| Thuật ngữ | Hiểu đơn giản | Ví dụ ở dự án |
|---|---|---|
| Service | Một ứng dụng phụ trách nhóm nghiệp vụ riêng | User, Merchant |
| Endpoint/route | Method và đường dẫn API | `GET /api/users/me` |
| Middleware | Bước kiểm tra/xử lý trước hoặc sau handler | Xác thực, validate, xử lý lỗi |
| Controller | Nhận HTTP input, gọi nghiệp vụ, tạo HTTP response | `updateMerchant` |
| Domain/service function | Hàm xử lý quy tắc nghiệp vụ | `updateProfile`, `updateKycTier` |
| DTO | Dữ liệu được trả ra API hoặc trao đổi giữa các lớp | `userResponse(profile)` |
| Prisma | Lớp truy cập PostgreSQL theo schema/model | `prisma.user.findMany(...)` |
| Migration | File thay đổi cấu trúc DB có lịch sử | Thêm `kyc_tier`, bảng Outbox |
| Transaction | Nhóm thao tác DB cùng thành công hoặc cùng rollback | Update tier + insert Outbox |
| Atomic | Không có trạng thái DB chỉ hoàn thành một nửa thao tác | Không đổi tier nếu ghi Outbox thất bại |
| Event | Thông báo một sự việc đã xảy ra | `merchant.profile_updated` |
| Consumer | Tiến trình nhận và xử lý event | User consumer nhận registration |
| Publisher | Tiến trình gửi event | Merchant publisher đọc Outbox |
| Inbox | Sổ ghi event đã xử lý để chống xử lý lặp | `ConsumedEvent` |
| Outbox | Sổ event cần gửi, ghi cùng transaction nghiệp vụ | `MerchantOutboxEvent` |
| Idempotent | Thực hiện lại vẫn giữ kết quả nghiệp vụ mong muốn | Nhận cùng registration không tạo User thứ hai |
| ACK | Báo với broker rằng message gốc đã xử lý xong | ACK sau commit Inbox/profile |
| DLQ | Queue giữ message không xử lý được | Registration sai schema |
| Retry/backoff | Thử lại và tăng khoảng chờ giữa các lần | Gửi lại event khi broker lỗi |
| No-op | Request hợp lệ nhưng không thay đổi dữ liệu | Gửi tên Merchant giống tên hiện có |
| Soft delete | Đánh dấu `deletedAt`, chưa xóa hẳn dòng DB | Hồ sơ bị loại khỏi API thông thường |
| Aggregate | Một thực thể nghiệp vụ cần giữ thứ tự thay đổi | Một Merchant và các event của nó |
| Lease | Quyền xử lý có thời hạn của worker | Claim Outbox trong 30 giây |

## 4. Danh tính và xác thực: phần dễ nhầm nhất

### 4.1. Ba ID khác nhau

Ví dụ minh họa:

| ID | Giá trị ví dụ | Ý nghĩa |
|---|---|---|
| Auth ID | `11111111-1111-4111-8111-111111111111` | Tài khoản đăng nhập của An |
| User profile ID | `22222222-2222-4222-8222-222222222222` | Dòng hồ sơ User của An |
| Merchant ID | `33333333-3333-4333-8333-333333333333` | Dòng hồ sơ An Store |

Quan hệ trong dữ liệu:

```text
auth-service.User.id         = Auth ID
user-service.User.id         = User profile ID
user-service.User.authUserId = Auth ID
Merchant.id                  = Merchant ID
Merchant.ownerId             = Auth ID
req.auth.userId              = Auth ID
```

Trong tài liệu này, `User.id` ở phần hồ sơ là `user-service.User.id`. Auth Service cũng có model tên `User`, nhưng `auth-service.User.id` là ID tài khoản đăng nhập. Cần chỉ rõ service khi nói về `User.id`.

Vì vậy `Merchant.ownerId` **không phải** User profile ID; nó liên kết tới tài khoản Auth. Đây là quan hệ logic qua định danh, không phải Prisma relation/foreign key xuyên service trong hai schema hiện tại.

Các trường trên biểu diễn **ba ID thực thể**, không phải sáu ID độc lập: tài khoản, hồ sơ cá nhân và merchant. `authUserId`, `ownerId` và `req.auth.userId` cùng mang Auth ID khi nói về cùng một chủ sở hữu. Mỗi thực thể có ID riêng là lựa chọn thiết kế hiện tại; đợt làm rõ tên không gộp Profile ID với Auth ID.

`GET /api/users/me` lấy Auth ID từ context rồi tìm theo `authUserId`. Client không cần biết profile ID để gọi endpoint này.

Các route User `/:id` có logic tương thích cũ: tìm theo profile ID **hoặc** Auth ID. Nếu cùng chuỗi khớp hai hồ sơ khác nhau, trả `409 AMBIGUOUS_IDENTIFIER`; không tự chọn một người. Route `/by-auth/:authUserId` chỉ rõ loại ID và tránh nhập nhằng. Hàm domain `updateKycTier(profileId, ...)` yêu cầu **profile ID**.

### 4.2. Access token và Gateway Token

```mermaid
sequenceDiagram
    participant F as Frontend
    participant G as Gateway
    participant S as User hoặc Merchant
    F->>G: Authorization: Bearer access-token
    G->>G: Xóa header nội bộ client tự gửi
    G->>G: Verify access token và ký Gateway Token
    G->>S: x-gateway-token: ES256 JWT
    S->>S: Package verify token, tạo req.auth
    S->>S: Kiểm tra owner/admin và nghiệp vụ
    S-->>F: Response qua Gateway
```

Frontend đăng nhập qua Auth để lấy access token. Gateway xác minh access token rồi tạo token nội bộ ngắn hạn. User/Merchant xác minh token nội bộ bằng package [finvault-internal-auth](../packages/finvault-internal-auth/src/index.ts).

| Thuộc tính Gateway Token | Quy tắc hiện tại |
|---|---|
| Header | `x-gateway-token` |
| Chữ ký | ES256, khóa EC P-256 |
| Issuer `iss` | `finvault-gateway` |
| Audience `aud` | `finvault-internal-services` |
| `sub` | Auth ID dạng UUID |
| `role` | `USER`, `ADMIN` hoặc `MERCHANT` |
| `kycTier` | Số nguyên 0, 1 hoặc 2 |
| `iat`, `exp` | Thời điểm phát hành/hết hạn; tuổi và thời lượng tối đa 60 giây |
| `jti` | ID token không rỗng; chưa có kho lưu chống replay từng `jti` |

Sau xác thực, request có dạng context:

```ts
req.auth = {
  userId: "11111111-1111-4111-8111-111111111111",
  role: "USER",
  kycTier: 0,
  jti: "token-id"
}
```

Gateway giữ private key để ký; User/Merchant chỉ cần public key để kiểm tra. Production phải cấu hình key riêng, không được fallback sang key development. Hai service không còn cần `ACCESS_TOKEN_SECRET` để tự verify access token của client.

Tự gửi `x-user-role: ADMIN` hoặc `x-gateway-verified: true` không biến client thành admin. Gateway xóa header do client cung cấp; User/Merchant lấy danh tính từ token đã verify.

### 4.3. Đường gọi nội bộ của Auth/Admin

Auth cần tạo profile; Admin cần review. Các caller này hiện còn dùng `x-internal-key` khi gọi trực tiếp service.

Middleware `authenticateServiceRequest` xử lý:

1. Xóa context cũ trên request.
2. Không có `x-internal-key`: dùng `requireGateway` của package.
3. Có key: so sánh với cấu hình bằng `timingSafeEqual`; sai trả 401.
4. Nếu caller có gửi `x-user-id`, phải là UUID hợp lệ; biến cục bộ tên `callerAuthUserId`, lưu vào context `internalUserId`. Giá trị này là Auth ID, không phải Profile ID.
5. Đánh dấu `isInternalCall = true`, không giả lập `req.auth.role = ADMIN`.

Nhánh internal được helper quyền cho phép thực hiện các thao tác nội bộ. Đây là credential có phạm vi quyền rộng trong cơ chế hiện tại, chưa phải mô hình phân quyền chi tiết riêng cho từng service principal. Frontend không sử dụng key này; Gateway loại bỏ key từ request client.

Nếu request có internal key sai, middleware từ chối ngay; không thử “cứu” request bằng token ở nhánh còn lại.

### 4.4. Xác thực khác với phân quyền

| Kiểm tra | Câu hỏi được trả lời |
|---|---|
| Xác thực | Caller là ai? Token/key có thật không? |
| Phân quyền | Caller được xem/sửa hồ sơ này không? |

`requireOwner(req, ownerAuthUserId)` cho phép đúng chủ, ADMIN hoặc caller internal hợp lệ. Helper so sánh Auth ID của chủ với `req.auth.userId`; không so sánh Profile ID hoặc Merchant ID với token. `requireAdmin(req)` cho phép ADMIN hoặc internal hợp lệ. Token đúng nhưng sửa hồ sơ người khác vẫn nhận 403.

Một số endpoint có quy tắc riêng: tạo User chỉ dành cho internal, đăng ký Merchant bằng request người dùng luôn gắn chủ theo context, còn kiểm tra Merchant active dành cho caller đã xác thực.

### 4.5. Quy ước tên nội bộ sau cập nhật ngày 12/10/2026

Đợt sửa này chỉ thay đổi code và chú thích trong **User Service và Merchant Service**. Tên field Prisma, bảng/cột DB, đường dẫn API, field request/response, payload event và giá trị ID được giữ nguyên. Không có migration hoặc bước chuyển đổi dữ liệu.

| Tên trong code nội bộ | Ý nghĩa | Field/nguồn dữ liệu giữ nguyên |
|---|---|---|
| `profile`, `UserProfile` | Hồ sơ cá nhân; `UserProfile` là alias TypeScript của Prisma `User` | Model vẫn là `User`, truy vấn vẫn dùng `prisma.user` |
| `profileId` | ID hồ sơ cá nhân | `profile.id` / API `id` |
| `authUserId` | ID tài khoản gắn với hồ sơ | `profile.authUserId` / API `authUserId` |
| `merchantId` | ID hồ sơ kinh doanh | `merchant.id` / API `id` |
| `ownerAuthUserId` | Auth ID của người sở hữu | `merchant.ownerId` / API và event `ownerId` |
| `callerAuthUserId` | Auth ID của người đang gọi | `req.auth.userId` hoặc `req.internalUserId` |
| `eventId` | ID của event, độc lập với ID thực thể | Outbox `id` / payload `eventId` |

Các hàm tra cứu hiện tại:

| Hàm | Loại ID nhận vào | Nơi dùng |
|---|---|---|
| `findProfileByAuthUserId(authUserId)` | Chỉ Auth ID | `/users/me`, `/users/me/kyc`, các route `/users/by-auth/:authUserId` |
| `resolveProfileByIdOrAuthUserId(profileIdOrAuthUserId)` | Profile ID hoặc Auth ID | Các route User `/:id` cũ; giữ lỗi `409 AMBIGUOUS_IDENTIFIER` nếu khớp hai hồ sơ |
| `findMerchantById(merchantId)` | Chỉ Merchant ID | Đọc/sửa hồ sơ Merchant, kiểm tra `/active` |

`resolveUser(identifier, byAuth)` đã được thay bằng hai hàm User rõ nghĩa ở trên; `findMerchant(id)` đổi thành `findMerchantById(merchantId)`. Không thêm hàm chỉ nhận Profile ID khi chưa có caller cần dùng. Helper riêng `findProfile(where)` dùng chung truy vấn và kiểm tra hồ sơ không tồn tại/đã xóa mềm/ID nhập nhằng.

Ví dụ cách đọc luồng User hiện tại:

```ts
// Context do middleware cung cấp vẫn giữ tên userId.
const callerAuthUserId = req.auth?.userId ?? req.internalUserId
if (!callerAuthUserId) throw new HttpError(401, 'UNAUTHORIZED', 'Authenticated user required')
const profile = await findProfileByAuthUserId(callerAuthUserId)

// Quyền sở hữu dùng Auth ID; định vị dòng DB dùng Profile ID.
requireOwner(req, profile.authUserId)
const profileId = profile.id
```

Trong Merchant controller, `ownerAuthUserId` được truyền vào `register` dưới field cũ `ownerId`. Do đó client, Auth, Admin và consumer event không cần đổi tên field theo tên biến nội bộ. `req.auth.userId` vẫn do package `finvault-internal-auth` cung cấp; không đổi package hoặc token contract.

Trong luồng KYC, controller truyền hồ sơ giữa các middleware qua `res.locals.profile`; `currentProfile(req)` lấy hồ sơ bằng Auth ID. Đường dẫn object KYC vẫn dùng Profile ID. User Outbox vẫn có `aggregateId = profile.id`, còn `data.authUserId` là Auth ID; Merchant Outbox vẫn dùng Merchant ID làm `aggregateId` và Auth ID làm `data.ownerId`.

Để giữ tương thích về sau, không tự đổi `id`, `authUserId`, `ownerId` trong JSON chỉ vì tên biến nội bộ đã rõ hơn. Auth đang gửi `{ authUserId, email }` để tạo hồ sơ; Admin đang dùng các ID/field hiện tại để đọc và duyệt. Việc đổi giá trị ID hoặc bỏ field cũ là thay đổi khác, cần xử lý caller và dữ liệu đang tồn tại.

## 5. User Service sở hữu những dữ liệu nào?

Source: [schema.prisma của User](../services/user-service/prisma/schema.prisma).

### 5.1. Bảng `users`

| Field trong Prisma | Mục đích/quy tắc |
|---|---|
| `id` | UUID profile, khóa chính |
| `authUserId` | Auth ID, unique; dùng khi kiểm tra chính chủ |
| `email` | Email profile, unique; không sửa qua API cập nhật profile hiện tại |
| `fullName` | Họ tên, nullable |
| `phone` | Điện thoại, nullable |
| `address` | Địa chỉ, nullable |
| `kycStatus` | `NONE/PENDING/APPROVED/REJECTED`, mặc định `NONE` |
| `kycTier` | Cấp 0/1/2, mặc định 0 |
| `idNumber` | Số giấy tờ KYC |
| `idImageUrl` | Cột legacy còn trong DB; không trả qua `userResponse`; upload mới đặt null |
| `kycObjectKey` | Khóa object trong storage, không trả trong profile API |
| `kycMimeType`, `kycFileSize` | Loại và dung lượng ảnh sau xử lý |
| `version` | Số phiên bản profile, mặc định 0; hỗ trợ kiểm soát cập nhật cạnh tranh |
| `createdAt`, `updatedAt` | Thời điểm tạo/cập nhật |
| `deletedAt` | Mốc soft delete; có giá trị thì các API nghiệp vụ không coi là profile đang hoạt động |

Tên field TypeScript dùng camelCase; một số cột DB dùng snake_case nhờ `@map`, ví dụ `authUserId` ↔ `auth_user_id`.

**Response hiện tại không chỉ có các field hiển thị trên UI.** `userResponse` loại `kycObjectKey`, `idImageUrl`, giữ các field còn lại và thêm `hasKycDocument`. Vì vậy response profile được cấp quyền vẫn có thể chứa `idNumber`, thông tin file, version và timestamps. Không nên nói code đã che toàn bộ dữ liệu giấy tờ.

### 5.2. Các bảng hỗ trợ

| Bảng | Nội dung | Vì sao cần? |
|---|---|---|
| `consumed_events` | `id`, `payloadHash`, `processedAt` | Biết registration nào đã xử lý, phát hiện event ID bị dùng lại khác nội dung |
| `storage_cleanup` | `objectKey`, `attempts`, `nextAttemptAt`, `createdAt` | Ghi ý định dọn file trước upload và giữ công việc dọn qua restart |
| `user_outbox_events` | ID, aggregate ID/version, type, JSON payload, status, timestamps | Lưu event đổi tier cùng transaction với User |

Inbox chỉ lưu hash và metadata, không lưu nguyên payload registration chứa email. User Outbox hiện đơn giản hơn Merchant Outbox: chưa có publisher, retry/lease fields hoặc luồng chuyển trạng thái gửi hoàn chỉnh.

## 6. Profile User được tạo như thế nào?

### 6.1. Luồng signup đang dùng: HTTP

```text
Frontend signup
  → Gateway → Auth tạo tài khoản đăng nhập
  → Auth gọi POST /api/users bằng internal key
  → User tạo profile với authUserId và email
  → Profile mặc định kycStatus=NONE, kycTier=0
```

Auth còn provision Wallet bằng một request khác. Các bước ở các service **không nằm trong một transaction PostgreSQL chung**.

Trong source Auth hiện tại, lỗi gọi User/Wallet được ghi log cảnh báo; tài khoản Auth đã tạo không bị rollback tự động. Do đó có thể xảy ra tài khoản đăng nhập tồn tại nhưng `GET /api/users/me` trả 404 vì chưa provision profile. Consumer có khả năng xử lý registration, nhưng chưa có Auth publisher tự động phát event để khẳng định tình huống này tự hồi phục.

`POST /api/users` trực tiếp dùng `prisma.user.create`; gửi trùng identity/email có thể trả `409 DUPLICATE_RESOURCE`. Không nhầm với cơ chế idempotent của consumer.

### 6.2. Luồng nhận event registration đã có

Payload ví dụ được consumer chấp nhận:

```json
{
  "eventId": "44444444-4444-4444-8444-444444444444",
  "eventType": "user.registered",
  "eventVersion": 1,
  "occurredAt": "2026-10-11T08:00:00.000Z",
  "data": {
    "authUserId": "11111111-1111-4111-8111-111111111111",
    "email": "an@example.com"
  }
}
```

`consumeRegistration` thực hiện trong transaction:

```text
Validate event và tính hash
  → Tìm ConsumedEvent bằng eventId
  → Nếu chưa có: tạo hoặc dùng lại profile phù hợp
  → Ghi ConsumedEvent
  → Commit
  → Handler ACK message
```

| Tình huống | Hành vi |
|---|---|
| Event mới, identity mới | Tạo profile + một Inbox |
| Cùng event ID, cùng nội dung đã parse | No-op, ACK |
| Cùng event ID, khác nội dung | `EVENT_CONFLICT`, đưa vào DLQ |
| Event ID khác, cùng Auth ID/email hợp lệ | Dùng lại profile, ghi thêm Inbox cho event mới |
| Profile đã được tạo qua HTTP | Dùng lại nếu identity/email khớp; không ghi đè tên/địa chỉ đã bổ sung |
| Email thuộc Auth ID khác hoặc profile đã soft delete | Conflict; không tự gộp/phục hồi |
| Tạo profile thành công nhưng insert Inbox lỗi | Transaction rollback cả profile vừa tạo |

Đây là cách đạt “xử lý nghiệp vụ một lần có hiệu lực” dù broker có thể giao message nhiều lần. Không phải cam kết RabbitMQ chỉ giao đúng một lần.

### 6.3. Queue, retry và DLQ

| Cấu hình | Giá trị mặc định |
|---|---|
| Exchange | `finvault.events`, topic, durable |
| Routing key | `user.registered` |
| Queue chính | `user-service.user-registered.v1` |
| DLQ | `user-service.user-registered.v1.dlq` |
| Prefetch | 1 message |
| Kích thước event tối đa | 64 KiB |
| Retry | Tối đa 5 lần retry sau lần xử lý ban đầu |
| Khoảng chờ | 2, 4, 8, 16, 32 giây mặc định; cap 60 giây |

Sai JSON/schema, xung đột identity/event được coi là lỗi không nên retry tự động. Lỗi tạm thời như DB chưa sẵn sàng được retry. Consumer publish bản retry hoặc DLQ và **đợi broker confirm trước khi ACK bản gốc**, tránh mất message khi chuyển queue thất bại.

Retry hiện chờ trong consumer và prefetch là 1, nên một message đang chờ có thể làm chậm message sau. Replay CLI chỉ xử lý một event đầu DLQ, giữ `eventId`, reset retry; payload vẫn sai thì không bị coi là đã sửa thành công.

## 7. API của User Service

Base path: `/api/users`. Qua Gateway mặc định: `http://localhost:3000/api/users`. Cổng HTTP riêng mặc định: `3002`.

Trong bảng, “chủ/admin/internal” nghĩa là đúng chủ theo Auth ID, ADMIN hoặc caller internal hợp lệ. “Đã xác thực” không có nghĩa được bỏ qua quy tắc riêng của endpoint.

| Method | Path đầy đủ | Quyền | Kết quả chính |
|---|---|---|---|
| GET | `/health` | Public tại service | Liveness |
| GET | `/api/users/health` | Public tại service | Liveness |
| POST | `/api/users` | Chỉ internal | Tạo profile; 201 |
| GET | `/api/users` | Admin/internal | Danh sách phân trang |
| GET | `/api/users/me` | Caller có user identity đã xác thực | Profile hiện tại; chưa có → 404 |
| GET | `/api/users/me/kyc` | Caller có user identity đã xác thực | Trạng thái, tier, có tài liệu hay chưa |
| POST | `/api/users/me/kyc` | Caller có user identity đã xác thực | Upload KYC của mình |
| GET | `/api/users/by-auth/:authUserId` | Chủ/admin/internal | Profile theo Auth ID |
| PUT | `/api/users/by-auth/:authUserId` | Chủ/admin/internal | Sửa thông tin profile |
| POST | `/api/users/by-auth/:authUserId/kyc` | Chủ/admin/internal | Upload KYC |
| GET | `/api/users/by-auth/:authUserId/kyc/document` | Chủ/admin/internal | URL đọc ảnh được ký |
| GET | `/api/users/:id` | Chủ/admin/internal | Resolve profile theo identifier tương thích |
| PUT | `/api/users/:id` | Chủ/admin/internal | Sửa profile |
| POST | `/api/users/:id/kyc` | Chủ/admin/internal | Upload KYC |
| GET | `/api/users/:id/kyc/document` | Chủ/admin/internal | URL đọc ảnh được ký |
| PATCH | `/api/users/:id/kyc-status` | Admin/internal | Đổi trạng thái KYC theo transition hợp lệ |

Health public ở service không có nghĩa mọi path health được miễn xác thực tại Gateway. Gateway hiện whitelist `/health`; nếu gọi `/api/users/health` qua Gateway, vẫn chịu middleware Gateway.

Chưa có `PUT /api/users/me`, `GET /api/users/me/kyc/document`, endpoint đổi tier hoặc endpoint xóa User trong route hiện tại. Muốn sửa profile/lấy URL ảnh, dùng route ID/by-auth đã có. Các route `/me` được đặt trước `/:id` để tránh hiểu `me` là UUID.

### 7.1. Body sửa profile

```json
{
  "fullName": "Nguyễn Văn An",
  "phone": "0900000000",
  "address": "TP. Hồ Chí Minh"
}
```

Ít nhất một field. Họ tên 1–200 ký tự, điện thoại 1–30, địa chỉ 1–500 sau trim. Body strict: không tự thêm `email`, `authUserId`, `kycStatus`, `kycTier` hoặc `version`. Không nhận null để xóa các field profile qua schema hiện tại.

Sửa profile User thông thường tăng `version`; chưa có so sánh no-op giống `updateProfile` của Merchant và chưa phát event cho thao tác này. Không suy rộng bảo đảm no-op của tier/Merchant sang mọi endpoint.

### 7.2. Response KYC của người dùng hiện tại

```json
{
  "success": true,
  "data": {
    "kycStatus": "PENDING",
    "kycTier": 0,
    "hasKycDocument": true
  }
}
```

`hasKycDocument` được tính từ việc DB có `kycObjectKey`, không phải mỗi lần GET đều kiểm tra object còn tồn tại trên storage.

### 7.3. Danh sách và phân trang

Ví dụ: `GET /api/users?page=1&limit=10&search=An&kycStatus=PENDING`.

- `page`: 1–100000, mặc định 1; `limit`: 1–100, mặc định 10.
- `search`: tối đa 200 ký tự; tìm trong email hoặc fullName, không phân biệt hoa/thường.
- Có thể dùng `status` hoặc `kycStatus`; nếu cả hai có giá trị thì ưu tiên `status`.
- Bộ lọc KYC chấp nhận trim/chuẩn hóa chữ hoa; trạng thái không hợp lệ → 400.
- Chỉ lấy hồ sơ chưa soft delete, sắp theo `createdAt` giảm dần.

Envelope danh sách dùng `content`, `page`, `limit`, `totalElements`, `totalPages`. Code giữ `totalPages` tối thiểu là 1 kể cả chưa có phần tử.

## 8. KYC: từ upload đến duyệt

KYC trong phạm vi này là tiếp nhận và quản lý hồ sơ xác minh. Code không có OCR hoặc tự kết luận giấy tờ hợp pháp; quyết định duyệt/từ chối đi qua thao tác quản trị.

### 8.1. Quy tắc upload

| Nội dung | Quy tắc |
|---|---|
| Content type request | `multipart/form-data` |
| Field text | `idNumber`, sau trim dài 1–50 ký tự |
| Field file | `document`, đúng một file |
| Ảnh đầu vào | JPEG hoặc PNG, tối đa 5 MiB |
| Giải mã ảnh | Sharp kiểm tra nội dung thật, tối đa 25 triệu pixel, không nhận ảnh nhiều trang |
| Ảnh đầu ra | JPEG đã rotate theo metadata, quality 90; không giữ metadata gốc |
| Object key | Service sinh `kyc/<profile-id>/<uuid>.jpg` |
| Trạng thái sau upload | `PENDING` |

Đổi đuôi file thành `.jpg` không làm dữ liệu bất kỳ trở thành ảnh hợp lệ. Code so sánh MIME với định dạng ảnh giải mã được. `idNumber` hiện chỉ kiểm tra chuỗi và độ dài; không có tra cứu cơ sở dữ liệu giấy tờ hay kiểm tra chuyên biệt số căn cước.

### 8.2. Tại sao upload cần nhiều bước?

PostgreSQL và S3/MinIO không dùng chung một transaction. Upload ảnh thành công nhưng ghi DB lỗi có thể tạo file rác; DB trỏ đến ảnh chưa upload xong có thể tạo liên kết hỏng. Code xử lý bằng durable cleanup intent, version và khóa theo object key.

```text
1. Resolve profile, kiểm tra quyền trước khi Multer buffer file.
2. Không cho nộp lại nếu KYC đang APPROVED.
3. Validate và chuẩn hóa ảnh.
4. Ghi StorageCleanup cho object mới trước khi upload.
5. Upload ảnh lên storage.
6. Trong transaction DB:
   - Khóa theo object key.
   - Kiểm tra object thật sự tồn tại.
   - Update profile nếu version chưa đổi và chưa soft delete.
   - Lưu idNumber, object key, MIME, size; chuyển PENDING, tăng version.
   - Xóa cleanup intent của ảnh mới vì ảnh đã được sử dụng.
   - Nếu thay ảnh cũ: lên lịch dọn ảnh cũ.
7. Commit và trả profile.
```

Nếu bước ghi DB thất bại sau upload, không xóa ảnh mới ngay trong catch: kết quả commit có thể không rõ ràng do lỗi kết nối. Job cleanup sẽ kiểm tra DB trước khi quyết định xóa, tránh xóa ảnh thực tế đã được profile sử dụng.

### 8.3. Trạng thái KYC

```mermaid
stateDiagram-v2
    [*] --> NONE
    NONE --> PENDING: Upload hợp lệ
    PENDING --> PENDING: Nộp lại ảnh
    PENDING --> APPROVED: Admin duyệt
    PENDING --> REJECTED: Admin từ chối
    APPROVED --> REJECTED: Admin thu hồi
    REJECTED --> PENDING: Upload lại
```

Đây là sơ đồ tổng hợp cả upload và review. Riêng API đổi trạng thái không cho Admin tùy ý đặt `NONE → PENDING` hoặc `REJECTED → PENDING`; hai đường đó do upload hợp lệ thực hiện.

| Tình huống | Kết quả |
|---|---|
| Duyệt `PENDING → APPROVED` có object key và idNumber | Thành công nếu version còn đúng |
| Duyệt khi chưa có thông tin upload cần thiết | `409 KYC_DOCUMENT_REQUIRED` |
| Upload khi đang APPROVED | `409 INVALID_TRANSITION`; cần thu hồi trước |
| Hai thao tác cùng dùng snapshot profile cũ | Thao tác không còn khớp version có thể nhận `409 CONCURRENT_UPDATE` |
| Gửi trạng thái bằng trạng thái hiện có | No-op trong `setKycStatus` |

### 8.4. Đọc ảnh riêng tư

1. Caller gọi endpoint `/kyc/document` được cấp quyền.
2. User Service ký URL đọc đúng object.
3. Response `{ url, expiresIn: 60 }` kèm `Cache-Control: no-store`.
4. Browser dùng URL đọc trực tiếp từ storage trong thời hạn 60 giây.

Bucket không public. URL ký là quyền truy cập tạm thời: ai có URL trong thời hạn có thể dùng nó, nên không đưa URL thật vào báo cáo/log chia sẻ.

`S3_ENDPOINT` là địa chỉ service dùng để upload/delete/list; `S3_PUBLIC_ENDPOINT` là địa chỉ dùng lúc ký để browser truy cập được. Ví dụ container hiểu hostname `minio`, nhưng browser trên máy người dùng cần `localhost:19002` hoặc hostname phù hợp. Không đổi hostname trong URL sau khi đã ký.

## 9. `kycStatus` khác `kycTier` ra sao?

| Thuộc tính | Trả lời câu hỏi nào? | Hiện trạng |
|---|---|---|
| `kycStatus` | Hồ sơ giấy tờ đang ở bước xét duyệt nào? | NONE/PENDING/APPROVED/REJECTED |
| `kycTier` | Mức KYC số mấy đang được lưu? | 0/1/2 |

**Policy đang áp dụng là độc lập.** Duyệt ảnh không tự đổi tier; từ chối/nộp lại không tự đổi tier. Profile cũ và mới mặc định tier 0, kể cả hồ sơ đã APPROVED khi migration thêm cột.

Code hiện chưa định nghĩa đầy đủ “tier 1 được hạn mức bao nhiêu”, chưa có API/UI Admin nâng tier và chưa đồng bộ tier mới sang Wallet/access token. Không gán thêm ý nghĩa hạn mức khi trình bày.

### 9.1. Hàm đổi tier đã triển khai

Source: [kyc-tier.service.ts](../services/user-service/src/services/kyc-tier.service.ts).

```ts
updateKycTier(profileId, nextTier)
```

Đây là hàm domain dành cho caller tin cậy trong backend, **chưa được expose thành route HTTP**. Hàm không tự nhận token/request để kiểm tra ADMIN; ranh giới quyền hiện tại là không mở cho client gọi qua profile/upload API.

Trong transaction Serializable:

1. Validate profile ID và tier nguyên 0–2.
2. Tìm profile chưa soft delete.
3. Tier mới bằng hiện tại → trả lại, không tăng version/ghi event.
4. Khác tier → update tier và tăng version với điều kiện version đang đọc.
5. Insert `user.kyc_updated` vào User Outbox.
6. Một bước lỗi → rollback toàn bộ transaction.

Ví dụ payload lưu trong Outbox:

```json
{
  "eventId": "55555555-5555-4555-8555-555555555555",
  "eventType": "user.kyc_updated",
  "eventVersion": 1,
  "occurredAt": "2026-10-11T08:10:00.000Z",
  "data": {
    "authUserId": "11111111-1111-4111-8111-111111111111",
    "kycTier": 1
  }
}
```

Ở cột Outbox, `aggregateId` là **User profile ID**, `aggregateVersion` là version profile sau cập nhật; còn `data.authUserId` phục vụ nhận diện xuyên service. Không có ảnh/số giấy tờ trong event này.

### 9.2. Tại sao token có thể khác tier trong User DB?

Gateway lấy tier từ access token, nếu thiếu thì dùng 0. Auth hiện phát access token với userId/role, chưa lấy tier mới từ User để cập nhật token. Vì vậy có tier trong `req.auth` không đồng nghĩa hệ thống đã đồng bộ tier xuyên service.

`GET /api/users/me/kyc` đọc tier từ User DB. Đây là nguồn trả trạng thái profile hiện tại trong hai service này. Event đổi tier vẫn ở Outbox `PENDING` vì User **chưa có publisher**; chạy User `npm run worker` chỉ chạy registration consumer.

## 10. Cleanup KYC: dọn file rác mà không xóa nhầm

### 10.1. Hai cơ chế bổ sung nhau

| Cơ chế | Đọc từ đâu? | Khi nào chạy? | Mục đích |
|---|---|---|---|
| Cleanup theo job | `storage_cleanup` | Timer HTTP mỗi 60 giây nếu bật | Dọn file upload dang dở hoặc ảnh đã bị thay |
| Orphan scanner | Danh sách object ở prefix `kyc/` | CLI bảo trì chạy riêng | Phát hiện file rác kể cả không có cleanup job |

Timer lấy tối đa 20 job đến hạn/lượt. Lỗi dọn job thì tăng attempts và đặt lần thử tiếp sau một giờ. Không có scanner định kỳ tự chạy thêm ngoài timer này.

`KYC_CLEANUP_GRACE_MS` mặc định 24 giờ, áp dụng cho intent upload mới và tuổi object khi scan. Ảnh cũ bị thay được lên lịch dọn ngay; không bắt buộc chờ lại 24 giờ theo quy tắc của scanner.

### 10.2. Điều kiện trước khi xóa

Scanner chỉ xét object thuộc `kyc/`, có metadata tuổi hợp lệ, đủ già, không được bất kỳ User nào tham chiếu và không có intent được bảo vệ đến thời điểm tương lai.

Trước delete thật, `removeUnreferenced` lấy PostgreSQL advisory lock theo object key rồi kiểm tra reference/intent lần nữa. Upload commit lấy cùng loại khóa, giúp tránh tình huống scan thấy “chưa ai dùng”, ngay sau đó upload gắn file vào profile rồi scanner xóa mất.

Lookup DB lỗi → không xóa. Profile soft delete vẫn còn tham chiếu cũng giữ file. Xóa storage không rollback cùng DB được, nên upload commit còn kiểm tra object tồn tại sau khi lấy khóa. Không thể giải quyết tình huống này chỉ bằng một transaction DB thông thường.

### 10.3. Bảng tình huống để nhớ

| Object | Dry-run | Delete thực tế |
|---|---|---|
| A: đang được profile tham chiếu | Giữ | Giữ |
| B: orphan cũ có cleanup job đến hạn | Candidate | Có thể xóa |
| C: orphan mới | Bỏ qua vì grace period | Giữ |
| D: orphan cũ không có cleanup job | Scanner phát hiện candidate | Có thể xóa |
| E: upload intent chưa đến hạn | Bỏ qua | Giữ |
| F: ngoài prefix/không biết tuổi/lookup lỗi | Skip hoặc lỗi | Không xóa |

Dry-run chỉ đọc/list/log: không delete object, không thêm/xóa/sửa cleanup job, không tăng retry counter. Summary có mode, scanned, referenced, orphan, tooYoung, protected, skipped, deleted, failed, durationMs.

Chạy `storage:cleanup` không truyền tham số mặc định là dry-run. `STORAGE_CLEANUP_ENABLED=false` chỉ tắt **timer HTTP**; không vô hiệu hóa một CLI `--delete` do người vận hành chủ động chạy. Khi demo dry-run, cần tắt các tiến trình đang xóa thật để số liệu trước/sau phản ánh đúng.

## 11. Những giới hạn cần nhớ của User Service

- Không quản lý password, refresh token hoặc đăng nhập.
- Không tự xác minh tính pháp lý của giấy tờ; không có OCR trong luồng này.
- Không cho client sửa email, KYC status hoặc tier qua API profile.
- Không có API/UI nâng tier, User publisher hoặc đồng bộ hạn mức ví trong phạm vi hiện tại.
- Không có endpoint delete User dù model đã có `deletedAt`.
- HTTP signup provisioning và registration consumer là hai đường khác nhau; có consumer không chứng minh Auth đã phát event.
- Chưa có transaction xuyên Auth/User/Wallet; signup có thể cần xử lý lại nếu provisioning lỗi.
- Health chỉ là liveness đơn giản, không kiểm tra đầy đủ broker/storage/mọi dependency trong mỗi request.

## 12. Merchant Service sở hữu những dữ liệu nào?

Source: [schema.prisma của Merchant](../services/merchant-service/prisma/schema.prisma).

### 12.1. Bảng `merchants`

| Field | Mục đích/quy tắc |
|---|---|
| `id` | UUID Merchant |
| `ownerId` | Auth ID của chủ, unique |
| `businessName` | Tên kinh doanh |
| `taxId` | Mã số thuế, nullable |
| `bankAccount` | Thông tin tài khoản ngân hàng dạng chuỗi, nullable |
| `status` | `PENDING/APPROVED/REJECTED`, mặc định `PENDING` |
| `version` | Phiên bản Merchant, bắt đầu từ 1 |
| `createdAt`, `updatedAt` | Thời gian tạo/cập nhật |
| `deletedAt` | Soft delete |

Unique `ownerId` nghĩa là một Auth ID chỉ có một dòng Merchant, **kể cả dòng đã soft delete**. `/me` lọc soft delete nên có thể trả null nhưng đăng ký mới vẫn đụng unique nếu owner đã có hồ sơ bị xóa mềm. Chưa có API khôi phục/xóa Merchant trong router này.

`taxId` và `bankAccount` là thông tin hồ sơ; validation hiện kiểm tra chuỗi/độ dài, không chứng minh tài khoản ngân hàng tồn tại hay mã số thuế hợp lệ với cơ quan bên ngoài.

Các endpoint hồ sơ được cấp quyền hiện trả record Merchant, gồm `taxId`, `bankAccount`. Endpoint `/active` và payload event chỉ trả nhóm field giới hạn, không có hai field đó.

### 12.2. Bảng `merchant_outbox_events`

| Field | Ý nghĩa |
|---|---|
| `id` | ID ổn định của event, cũng được đưa vào payload/messageId |
| `aggregateId` | Merchant ID |
| `aggregateVersion` | Phiên bản Merchant tương ứng thay đổi |
| `eventType` | Loại event/routing key |
| `payload` | Envelope event dạng JSON |
| `status` | PENDING/PROCESSING/PUBLISHED/FAILED do code quản lý |
| `attempts` | Số lần claim/thử xử lý |
| `nextAttemptAt` | Khi nào được thử tiếp |
| `lockedUntil` | Thời điểm hết lease |
| `lockToken` | Token xác định lần worker đang sở hữu event |
| `lastError` | Mã lỗi gần nhất, ví dụ `PUBLISH_FAILED` |
| `createdAt`, `publishedAt` | Mốc tạo và gửi thành công |

Unique `(aggregateId, aggregateVersion)` ngăn hai dòng Outbox cùng đại diện một version của Merchant. `eventVersion` trong JSON là phiên bản **schema event**, không phải version Merchant.

## 13. API và quy tắc nghiệp vụ Merchant

Base path: `/api/merchants`. Qua Gateway mặc định: `http://localhost:3000/api/merchants`. Cổng HTTP riêng mặc định: `3003`.

| Method | Path đầy đủ | Quyền | Kết quả chính |
|---|---|---|---|
| GET | `/health` | Public tại service | Liveness |
| GET | `/api/merchants/health` | Public tại service | Liveness |
| POST | `/api/merchants/register` | Đã xác thực/internal | Tạo Merchant + Outbox; 201 |
| GET | `/api/merchants/me` | Caller có user identity đã xác thực | Merchant của caller hoặc `data: null` |
| GET | `/api/merchants` | Admin/internal | Danh sách phân trang |
| GET | `/api/merchants/:id` | Chủ/admin/internal | Hồ sơ đầy đủ |
| PUT | `/api/merchants/:id` | Chủ/admin/internal | Sửa hồ sơ + Outbox nếu có thay đổi |
| PATCH | `/api/merchants/:id/status` | Admin/internal | Đổi trạng thái + Outbox nếu có thay đổi |
| GET | `/api/merchants/:id/active` | Đã xác thực/internal | Trạng thái hoạt động tối thiểu |

Quy tắc health qua Gateway tương tự User: public ở service không tự làm Gateway bỏ xác thực cho mọi đường dẫn có chữ `health`.

### 13.1. Đăng ký Merchant

Với client qua Gateway, luồng hiện tại là `POST /api/auth/signup` → `POST /api/auth/signin` lấy access token → `POST /api/merchants/register` kèm Bearer token. Người đã có tài khoản không cần signup lại. Endpoint đăng ký Merchant không thuộc danh sách public của Gateway; thiếu token trả 401.

Điều kiện này yêu cầu danh tính đăng nhập hợp lệ, **không đồng nghĩa profile bên User Service phải được tạo thành công**. Merchant không gọi User/Auth để kiểm tra owner tồn tại tại thời điểm tạo, không có khóa ngoại xuyên service và không kiểm tra KYC trước đăng ký. Internal caller có key hợp lệ cũng có thể truyền `ownerId` dạng UUID mà Merchant chưa xác minh có tài khoản tương ứng. Vì vậy cần phân biệt yêu cầu xác thực của client với kiểm tra tồn tại hồ sơ trong DB.

Body ví dụ:

```json
{
  "businessName": "An Store",
  "taxId": "DEMO-TAX-001",
  "bankAccount": "DEMO-ACCOUNT-001"
}
```

- `businessName`: bắt buộc, sau trim dài 1–200.
- `taxId`: tùy chọn/null, nếu chuỗi thì 1–50.
- `bankAccount`: tùy chọn/null, nếu chuỗi thì 1–100.
- Body strict, không tự truyền `status`, `version` hay field lạ.
- Với request người dùng, owner lấy từ `req.auth.userId`.
- Body có `ownerId` khác danh tính đăng nhập → 403, kể cả role ADMIN ở nhánh request người dùng.
- Caller internal hợp lệ có thể cung cấp `ownerId`; nếu không thì dùng internal identity khi có.
- Không có owner để tạo hồ sơ → `400 OWNER_REQUIRED`.

Trong `register`, transaction tạo Merchant `PENDING`, version 1 và insert `merchant.registered`. Ghi Outbox lỗi thì Merchant vừa tạo bị rollback. Hai request đăng ký cùng owner được unique constraint bảo vệ; không tạo hai Merchant.

Đăng ký/duyệt Merchant hiện **không cập nhật role trong Auth**. Không cần caller đã có role MERCHANT mới được đăng ký; người dùng có danh tính hợp lệ có thể tạo hồ sơ cho chính mình.

### 13.2. `/me` và khác biệt với User `/me`

Chưa đăng ký Merchant là trạng thái hợp lệ:

```json
{
  "success": true,
  "data": null
}
```

Frontend có thể hiển thị form đăng ký khi nhận null. Nếu DB lỗi thì trả lỗi qua error handler, không biến mọi lỗi thành null.

User `/me` chưa có profile trả 404 vì đó là thiếu profile cần được provision. Merchant `/me` chưa có trả 200/null vì người dùng chưa chắc muốn kinh doanh.

### 13.3. Sửa hồ sơ Merchant

`PUT /api/merchants/:id` nhận ít nhất một trong `businessName`, `taxId`, `bankAccount`. Dù method là PUT, implementation hiện hỗ trợ cập nhật một phần; không bắt gửi lại toàn bộ hồ sơ. `taxId`/`bankAccount` có thể đặt null, tên doanh nghiệp thì không.

Luồng:

```text
Controller resolve Merchant và kiểm tra owner/admin/internal
  → updateProfile đọc lại Merchant trong transaction
  → Whitelist các field được sửa và so sánh với giá trị hiện tại
  → Không khác gì: trả record cũ
  → Có thay đổi: update + tăng version + enqueue merchant.profile_updated
  → Commit
```

Không có điều kiện bắt Merchant phải APPROVED mới được sửa profile. Sửa profile không tự đưa status về PENDING. Chỉ đổi `taxId`/`bankAccount` vẫn phát event profile, nhưng payload event không chứa hai giá trị nhạy cảm này.

### 13.4. Trạng thái Merchant

```mermaid
stateDiagram-v2
    [*] --> PENDING: Đăng ký
    PENDING --> APPROVED: Duyệt
    PENDING --> REJECTED: Từ chối
    APPROVED --> REJECTED: Thu hồi
    REJECTED --> PENDING: Xét duyệt lại
```

`changeStatus` đọc Merchant trong transaction và kiểm tra bảng transition. Gửi lại cùng status → no-op. Ví dụ `REJECTED → APPROVED` trực tiếp không được phép; cần quay về PENDING trước. Transition sai trả `409 INVALID_TRANSITION`.

Điểm khác KYC: Merchant có thể được đưa `REJECTED → PENDING` bằng API status dành cho admin/internal; KYC dùng upload lại để chuyển về PENDING.

### 13.5. Kiểm tra active

```json
{
  "success": true,
  "data": {
    "id": "33333333-3333-4333-8333-333333333333",
    "ownerId": "11111111-1111-4111-8111-111111111111",
    "businessName": "An Store",
    "status": "APPROVED",
    "active": true
  }
}
```

`active` chỉ là kết quả tính `status === 'APPROVED'` sau khi tìm Merchant chưa soft delete. Endpoint không cần caller là owner, nhưng phải qua xác thực. Nó không trừ tiền, không kiểm tra balance và không tự tạo quyền thanh toán cho một giao dịch.

### 13.6. Danh sách Merchant

`GET /api/merchants?page=1&limit=10&search=Store&status=PENDING` dành cho admin/internal. Tìm theo businessName không phân biệt hoa/thường, lọc Merchant chưa soft delete, sắp mới nhất trước. `status` nhận enum chữ hoa hợp lệ; không áp dụng preprocessing status của User sang Merchant.

## 14. Merchant Outbox và publisher hoạt động thế nào?

### 14.1. Vì sao không vừa update DB vừa gọi RabbitMQ ngay trong controller?

Nếu update DB xong rồi broker lỗi, dữ liệu đổi nhưng không có event. Nếu gửi event trước rồi DB rollback, consumer có thể tin một thay đổi chưa tồn tại.

Outbox giải quyết phần ghi nhận ý định gửi bằng transaction DB:

```text
Transaction PostgreSQL:
    thay đổi Merchant
    + ghi event vào merchant_outbox_events
    → cùng commit hoặc cùng rollback

Tiến trình riêng:
    đọc Outbox
    → gửi RabbitMQ
    → broker confirm
    → đánh dấu PUBLISHED
```

API có thể trả thành công khi event vẫn PENDING. Đây là hành vi bình thường: thay đổi nghiệp vụ đã commit, việc phân phối event diễn ra sau. HTTP server vẫn ghi Outbox được khi broker tạm thời không chạy, miễn database và các bước HTTP còn hoạt động.

### 14.2. Ba event hiện có

| Nghiệp vụ | Routing key/eventType |
|---|---|
| Đăng ký Merchant | `merchant.registered` |
| Đổi trạng thái | `merchant.status_updated` |
| Sửa hồ sơ có thay đổi | `merchant.profile_updated` |

Ví dụ event sửa tên:

```json
{
  "eventId": "66666666-6666-4666-8666-666666666666",
  "eventType": "merchant.profile_updated",
  "eventVersion": 1,
  "occurredAt": "2026-10-11T08:20:00.000Z",
  "data": {
    "merchantId": "33333333-3333-4333-8333-333333333333",
    "ownerId": "11111111-1111-4111-8111-111111111111",
    "businessName": "An Store Plus",
    "status": "APPROVED",
    "version": 3
  }
}
```

Cả ba dùng chung cấu trúc data này. Không có `taxId`, `bankAccount` hoặc `changedFields`. `version=3` biểu diễn phiên bản Merchant; `eventVersion=1` vẫn giữ nguyên vì schema event chưa đổi.

Ví dụ chuỗi version:

```text
Đăng ký                 → version 1 → merchant.registered
Duyệt APPROVED          → version 2 → merchant.status_updated
Đổi tên                 → version 3 → merchant.profile_updated
Gửi lại tên giống hệt    → version 3 → không có event mới
```

### 14.3. Worker claim event

`claimEvent` dùng truy vấn SQL trong transaction:

- Chọn event PENDING đến hạn hoặc PROCESSING đã hết lease.
- Không lấy event nếu còn event version nhỏ hơn của cùng Merchant chưa PUBLISHED.
- Dùng `FOR UPDATE ... SKIP LOCKED` để các worker không cùng chờ/claim một dòng đang bị khóa.
- Chuyển sang PROCESSING, tăng attempts, tạo lockToken mới, đặt lease 30 giây.
- Dùng `NOW()` của PostgreSQL cho lịch claim/retry để giảm ảnh hưởng lệch đồng hồ máy ứng dụng.

`lockToken` ngăn worker cũ cập nhật trạng thái một event đã được worker khác claim lại sau lease. Lease hỗ trợ phục hồi sau crash, không biến cả quá trình thành giao hàng đúng một lần tuyệt đối.

### 14.4. State machine gửi event

```mermaid
stateDiagram-v2
    [*] --> PENDING
    PENDING --> PROCESSING: Worker claim
    PROCESSING --> PUBLISHED: Broker confirm và ghi DB thành công
    PROCESSING --> PENDING: Gửi lỗi, còn lượt thử
    PROCESSING --> FAILED: Đủ giới hạn thử
    PROCESSING --> PROCESSING: Lease hết hạn, claim lại
    FAILED --> PENDING: Replay thủ công
```

Mặc định polling 1 giây khi không có việc; tối đa 5 lần thử gửi theo cấu hình retry; khoảng chờ 2/4/8/16 giây cho các lần retry bình thường, cap 60 giây. Nếu process crash, trạng thái/lease lưu trong DB cho phép worker khác hoặc worker sau restart tiếp tục.

Event FAILED không bị xóa. Nó chặn event version sau **của cùng Merchant** để giữ thứ tự, còn Merchant khác vẫn có thể được xử lý. Replay chỉ chuyển FAILED về PENDING, giữ eventId/payload, reset attempts/lịch thử.

### 14.5. Broker confirm chứng minh điều gì?

Publisher dùng persistent message, mandatory routing và confirm channel. Nếu không có queue binding nhận routing key, message bị return và lần gửi được xem là thất bại dù broker đã tiếp nhận publish.

**PUBLISHED nghĩa là đã có xác nhận từ broker và lưu trạng thái gửi; không chứng minh consumer nghiệp vụ đã xử lý xong.** Consumer có ACK/transaction riêng.

Có cửa sổ gửi lặp:

```text
Broker nhận event và confirm
  → Publisher crash trước khi ghi PUBLISHED
  → Lease hết hạn, worker gửi lại cùng eventId
```

Vì vậy consumer của Merchant events vẫn cần deduplicate theo eventId và xử lý version. Outbox bảo đảm lưu thay đổi và ý định gửi cùng nhau; không loại bỏ mọi khả năng nhận event lặp ở downstream.

Queue `finvault.demo.merchant-events.v1` trong compose hiện là queue quan sát demo cho cả ba event. Nó chứng minh routing hoạt động, không thay thế consumer nghiệp vụ của team.

## 15. So sánh nhanh hai service

| Khía cạnh | User | Merchant |
|---|---|---|
| Thực thể chính | Profile cá nhân | Hồ sơ kinh doanh |
| Identity liên kết Auth | `authUserId` | `ownerId` |
| ID cục bộ | `User.id` | `Merchant.id` |
| Version ban đầu | 0 | 1 |
| State machine | KYC NONE/PENDING/APPROVED/REJECTED | PENDING/APPROVED/REJECTED |
| Chưa có `/me` | 404 | 200, data null |
| Tạo hồ sơ | Internal HTTP hoặc registration consumer | Đăng ký bằng identity đã xác thực/internal |
| Inbox | Có `ConsumedEvent` | Chưa có consumer/Inbox trong service này |
| Outbox | Có cho đổi tier | Có cho register/status/profile |
| Publisher | Chưa có | Có, tiến trình riêng |
| `npm run worker` | Nhận `user.registered` | Gửi Merchant Outbox |
| Storage ảnh | Có MinIO/S3, KYC private | Không có luồng upload ảnh Merchant |
| Cleanup | Job timer + orphan scanner CLI | Không có cleanup storage tương ứng |
| Sửa profile cùng giá trị | Vẫn update/tăng version ở controller hiện tại | No-op, không tăng version/event |
| Tác động tài chính | Không xử lý số dư | Không xử lý số dư |

Merchant config có một số field S3 dùng chung mẫu cấu hình, nhưng service hiện không có luồng upload/document tương ứng. Có biến môi trường không tự chứng minh một chức năng đã được triển khai.

## 16. Đọc code theo đường nào để không bị rối?

### 16.1. Pipeline HTTP chung

```text
server.ts
  → connect DB, listen HTTP, xử lý shutdown
app.ts
  → requestId, JSON/cookie/CORS, health
  → authenticateServiceRequest
routes
  → validate params/query/body
controller
  → resolve resource, kiểm tra quyền
  → gọi nghiệp vụ hoặc Prisma tùy endpoint
service function
  → quy tắc domain, transaction, storage/event
response hoặc errorHandler
```

Không phải mọi controller đều mỏng hoàn toàn. Ví dụ User update profile và các truy vấn danh sách còn dùng Prisma trực tiếp trong controller. Merchant update profile đã chuyển transaction/Outbox xuống service function.

### 16.2. Bản đồ file User

| File | Đọc để hiểu |
|---|---|
| [app.ts](../services/user-service/src/app.ts) | Thứ tự middleware, route mount, health |
| [userRoute.ts](../services/user-service/src/routes/userRoute.ts) | Danh sách endpoint và authorize-before-upload |
| [userController.ts](../services/user-service/src/controllers/userController.ts) | Lấy identity, kiểm tra quyền, DTO và query |
| [user.validation.ts](../services/user-service/src/validations/user.validation.ts) | Field nào được phép gửi, strict body, filter |
| [authenticateServiceRequest.ts](../services/user-service/src/middlewares/authenticateServiceRequest.ts) | Token/internal key |
| [access.ts](../services/user-service/src/utils/access.ts) | Quyền owner/admin/internal |
| [user.service.ts](../services/user-service/src/services/user.service.ts) | `findProfileByAuthUserId`, `resolveProfileByIdOrAuthUserId`, provision, DTO, review KYC |
| [kyc.service.ts](../services/user-service/src/services/kyc.service.ts) | Chuẩn hóa ảnh, intent, transaction upload, signed URL |
| [kyc-tier.service.ts](../services/user-service/src/services/kyc-tier.service.ts) | Tier và User Outbox |
| [storage.ts](../services/user-service/src/services/storage.ts) | S3 SDK, list pagination, URL signing |
| [storage-cleanup.ts](../services/user-service/src/services/storage-cleanup.ts) | Scan orphan, per-key lock, reference check |
| [cleanup-kyc.ts](../services/user-service/src/jobs/cleanup-kyc.ts) | CLI dry-run/delete |
| [registration.ts](../services/user-service/src/events/registration.ts) | Inbox/idempotency/transaction |
| [consumer.ts](../services/user-service/src/events/consumer.ts) | ACK/retry/DLQ/queue |
| [worker.ts](../services/user-service/src/events/worker.ts) | Entry point consumer |
| [transaction.ts](../services/user-service/src/utils/transaction.ts) | Serializable và retry lỗi P2034 |

### 16.3. Bản đồ file Merchant

| File | Đọc để hiểu |
|---|---|
| [merchantRoute.ts](../services/merchant-service/src/routes/merchantRoute.ts) | Endpoint |
| [merchantController.ts](../services/merchant-service/src/controllers/merchantController.ts) | Owner, `/me`, list, active |
| [merchant.validation.ts](../services/merchant-service/src/validations/merchant.validation.ts) | Body register/update/status |
| [merchant.service.ts](../services/merchant-service/src/services/merchant.service.ts) | `findMerchantById`, register, changeStatus, updateProfile, enqueue |
| [outbox.ts](../services/merchant-service/src/events/outbox.ts) | Claim/lease/ordering/retry/replay |
| [amqp.ts](../services/merchant-service/src/events/amqp.ts) | Broker confirm, mandatory, reconnect |
| [worker.ts](../services/merchant-service/src/events/worker.ts) | Vòng lặp publisher |
| [replay.ts](../services/merchant-service/src/events/replay.ts) | CLI replay FAILED event |
| [transaction.ts](../services/merchant-service/src/utils/transaction.ts) | Transaction Serializable, retry serialization |

### 16.4. Một bài tập lần theo code

Muốn hiểu “đổi tên Merchant có phát event không”, đọc theo thứ tự:

1. `merchantRoute.ts`: PUT `/:id` gọi validate rồi `controller.updateMerchant`.
2. `merchant.validation.ts`: chỉ cho sửa ba field, body không rỗng.
3. `merchantController.ts`: lấy `merchantId`, gọi `findMerchantById(merchantId)` rồi `requireOwner(req, merchant.ownerId)` bằng Auth ID của chủ.
4. `merchant.service.ts`: `updateProfile` so sánh field, update và enqueue trong transaction.
5. `outbox.ts`: publisher claim event theo thứ tự aggregate.
6. `worker.ts` + `amqp.ts`: gửi JSON payload và chờ broker confirm.

Đọc một luồng xuyên các lớp như vậy thường dễ hiểu hơn đọc hết thư mục theo alphabet.

## 17. Transaction, version và các tình huống cạnh tranh

### 17.1. Transaction Serializable

Helper của hai service dùng mức isolation `Serializable`. Khi PostgreSQL/Prisma báo `P2034`, helper thử lại transaction, tối đa 5 lượt tổng cộng theo vòng lặp hiện tại. Không phải mọi lỗi đều được tự retry: unique, validation, transition hoặc lỗi storage có xử lý riêng.

Ý nghĩa thực tế: hai transaction cập nhật cùng thực thể phải cho kết quả nhất quán như một thứ tự thực thi hợp lệ; một transaction có thể bị hủy và chạy lại. Cần đọc lại dữ liệu bên trong transaction nếu muốn quyết định dựa trên giá trị mới.

### 17.2. Version không phải client tự gửi

Các body HTTP không cho client đặt version. Code tự đọc và tăng version.

- KYC upload/review giữ snapshot đã resolve và điều kiện version; nếu profile đổi trong lúc đang xử lý có thể trả 409 để caller reload.
- Đổi tier đọc trong transaction, no-op hoặc update theo version.
- Merchant update/status đọc trong transaction Serializable, tính thay đổi, tăng version và enqueue cùng transaction.
- User update profile thông thường chưa có điều kiện version từ snapshot như KYC; không nên quảng bá tất cả endpoint cùng một kiểu chống lost update.

### 17.3. Điều gì rollback được?

| Tình huống | Cơ chế |
|---|---|
| Ghi Merchant thành công nhưng insert Outbox lỗi | DB transaction rollback Merchant/version |
| Đổi tier thành công nhưng insert User Outbox lỗi | DB transaction rollback tier/version |
| Tạo profile từ event nhưng insert Inbox lỗi | DB transaction rollback profile |
| Upload S3 xong nhưng DB lỗi | S3 không tự rollback; cleanup intent xử lý file thừa |
| Publish RabbitMQ xong nhưng update PUBLISHED lỗi | Broker không tự thu hồi message; có thể gửi lặp cùng eventId |

Hai hàng cuối giải thích vì sao hệ thống cần thêm cleanup/idempotency ngoài transaction DB.

## 18. Response, lỗi và cách tự tìm nguyên nhân

### 18.1. Envelope

Thành công nghiệp vụ:

```json
{
  "success": true,
  "data": {}
}
```

Lỗi do User/Merchant trả:

```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "You cannot access this resource"
  },
  "requestId": "request-id"
}
```

Health là ngoại lệ: trả `{ "status": "ok", "service": "user-service" }` hoặc tên Merchant. Gateway/Auth/Admin có handler riêng; không mặc định mọi response trong cả platform dùng đúng envelope của hai service.

### 18.2. Các lỗi thường gặp

| HTTP/code | Ý nghĩa | Nên kiểm tra |
|---|---|---|
| 400 `VALIDATION_ERROR` | Sai UUID/body/query | Field thừa, chuỗi rỗng, enum sai |
| 400 `INVALID_UPLOAD` | Sai cấu trúc multipart | Tên `document`, số file/field |
| 400 `INVALID_IMAGE` | Ảnh không hợp lệ | JPEG/PNG thật, MIME, kích thước pixel |
| 400 `KYC_DOCUMENT_REQUIRED` | Upload không có file | Có gửi field file `document` không |
| 401 `INVALID_GATEWAY_TOKEN` | Service không nhận token nội bộ hợp lệ | Có đi qua Gateway không, key/claims/TTL |
| 401 `UNAUTHORIZED` | Credential internal sai/thiếu identity hoặc gọi create User sai quyền | Nhánh middleware và endpoint đang gọi |
| 403 `FORBIDDEN` | Đã nhận diện nhưng không đủ quyền; cũng có thể do CORS ở app | Owner/Auth ID, role, origin |
| 404 `NOT_FOUND` | Profile/Merchant/tài liệu không tồn tại hoặc bị soft delete | Loại ID, provisioning, dữ liệu |
| 409 `DUPLICATE_RESOURCE` | Unique constraint | Email/Auth ID/owner đã có chưa |
| 409 `AMBIGUOUS_IDENTIFIER` | ID khớp hai profile theo hai loại identity | Dùng route by-auth rõ ràng |
| 409 `INVALID_TRANSITION` | Đổi trạng thái không hợp lệ | State machine |
| 409 `CONCURRENT_UPDATE` | Profile đổi khi KYC đang xử lý | Reload rồi thử lại với trạng thái mới |
| 413 `FILE_TOO_LARGE` | File upload quá 5 MiB | Dung lượng file |
| 503 `STORAGE_UNAVAILABLE` | Thiếu cấu hình storage tại thao tác yêu cầu storage | Bucket/credential/env |
| 503 `KYC_SUBMISSION_FAILED` | Không hoàn tất lưu KYC | Log tương ứng, DB và storage |
| 500 `INTERNAL_SERVER_ERROR` | Lỗi không được map cụ thể | Dùng requestId đối chiếu log, không đoán là “chưa có dữ liệu” |

`KYC_DOCUMENT_REQUIRED` còn được dùng với 409 khi duyệt thiếu thông tin upload. Cùng code có thể xuất hiện ở các thao tác/status khác nhau; xem cả HTTP status và endpoint.

### 18.3. Khi có lỗi, lần theo dependency

| Hiện tượng | Hướng kiểm tra |
|---|---|
| Đăng nhập được nhưng User `/me` 404 | Auth đã provision profile thành công chưa? Auth ID có khớp không? |
| Gọi thẳng port 3002 bằng access token bị 401 | User chờ Gateway Token hoặc internal key; gọi qua port Gateway |
| Upload được nhưng browser không mở ảnh | Hostname `S3_PUBLIC_ENDPOINT`, thời hạn URL, không đổi URL sau ký |
| Merchant update 200 nhưng chưa thấy event trên broker | Publisher có chạy không, Outbox status, RabbitMQ URL/binding |
| Merchant mới có event bị kẹt dù broker hoạt động | Event version trước cùng aggregate có FAILED/PROCESSING không? |
| User Outbox cứ PENDING | Hiện chưa có publisher User; không phải User consumer bị hỏng |
| Dry-run vẫn thấy số file giảm | Timer/CLI xóa thật khác có đang chạy không? |
| Service health 200 nhưng worker không chạy | HTTP và worker là hai process khác nhau |

## 19. Chạy service và các tiến trình liên quan

### 19.1. Những thành phần phải hiểu

| Thành phần | Vai trò |
|---|---|
| User HTTP | API profile/KYC; có timer cleanup job |
| User consumer | Nhận registration; chạy riêng |
| Merchant HTTP | API Merchant và ghi Outbox |
| Merchant publisher | Gửi Outbox; chạy riêng |
| User/Merchant migration jobs | Áp dụng schema trước khi HTTP/worker dùng dữ liệu |
| PostgreSQL | Dữ liệu nghiệp vụ, Inbox/Outbox/cleanup |
| RabbitMQ | Vận chuyển event |
| MinIO/S3 | Ảnh KYC private |
| Storage/broker init | Chuẩn bị bucket/quyền và queue demo |
| Gateway | Cửa vào và tạo token nội bộ |

Chỉ chạy `npm start` hai service thì chưa chạy consumer/publisher. Dockerfile hiện dùng root build context để cài/build package auth local; HTTP production chạy `node dist/server.js`.

### 19.2. Các biến môi trường quan trọng

| Biến | Service | Mục đích |
|---|---|---|
| `DATABASE_URL` | Cả hai | DB/schema riêng của service/môi trường |
| `PORT` | Cả hai | Mặc định User 3002, Merchant 3003 |
| `INTERNAL_KEY` | Cả hai | Credential gọi nội bộ, ít nhất 32 ký tự |
| `NODE_ENV` | Cả hai | Production yêu cầu key thật |
| `GATEWAY_PUBLIC_KEY_FILE` hoặc `GATEWAY_PUBLIC_KEY` | Cả hai | Verify ES256 Gateway Token |
| `CLIENT_URL` | Cả hai | Cấu hình origin frontend |
| `RABBITMQ_URL` | Worker | Kết nối broker; bắt buộc khi chạy worker |
| `EVENT_EXCHANGE` | Worker | Mặc định `finvault.events` |
| `EVENT_MAX_RETRIES`, `EVENT_RETRY_MS` | Worker | Giới hạn và khoảng retry |
| `OUTBOX_POLL_MS` | Merchant publisher | Chờ khi chưa có event |
| `S3_ENDPOINT` | User storage | Endpoint nội bộ |
| `S3_PUBLIC_ENDPOINT` | User storage | Endpoint để ký URL browser đọc được |
| `S3_REGION`, `S3_BUCKET` | User storage | Region/bucket |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | User storage | Credential storage |
| `S3_FORCE_PATH_STYLE` | User storage | Mặc định true, dùng cho cấu hình MinIO hiện tại |
| `KYC_CLEANUP_GRACE_MS` | User | Mặc định 86400000 ms |
| `STORAGE_CLEANUP_ENABLED` | User HTTP | Bật/tắt timer cleanup, mặc định true |

`GATEWAY_PRIVATE_KEY_FILE` thuộc Gateway, không cấp cho User/Merchant. File cấu hình không thay thế migration; client Prisma có field mới mà DB chưa migrate thì query vẫn có thể lỗi.

### 19.3. Lệnh đọc/test cơ bản

Chạy tại root backend, sau khi đã cài dependency/cấu hình theo [hướng dẫn runtime](User_Merchant_Runtime.md):

```powershell
rtk npm test --prefix services/user-service
rtk npm test --prefix services/merchant-service
rtk npm run typecheck --prefix services/user-service
rtk npm run typecheck --prefix services/merchant-service
rtk npm run build --prefix services/user-service
rtk npm run build --prefix services/merchant-service
```

Các lệnh chạy process dưới đây cần terminal riêng và env đúng:

```powershell
# HTTP User
rtk npm run dev --prefix services/user-service

# Consumer User
rtk npm run worker --prefix services/user-service

# HTTP Merchant
rtk npm run dev --prefix services/merchant-service

# Publisher Merchant
rtk npm run worker --prefix services/merchant-service
```

Để học/demo bằng image và hạ tầng riêng, dùng bộ runtime check đã chuẩn bị:

```powershell
rtk proxy node scripts/prepare-deployment.mjs
rtk proxy docker compose -f tests/deployment/compose.yml --env-file .cache/deployment/runtime.env up -d --build --wait
rtk proxy node tests/deployment/smoke.mjs
```

Môi trường này dùng Gateway `13000`, User `13002`, Merchant `13003`, PostgreSQL `25434`, MinIO `19003`; khác các cổng mặc định local. Đây là smoke kỹ thuật, không phải khởi động toàn bộ giao diện/Auth/Admin của acceptance.

Integration test dùng DB `finvault_test` tại `25432`, schema `user_test`/`merchant_test`; acceptance browser dùng DB riêng tại `25433`. Script integration có reset dữ liệu test, nên giữ đúng đích đã thiết kế. Chi tiết setup nằm trong runtime guide, không chạy reset trên database ứng dụng để học thử.

### 19.4. Cleanup và replay

Chạy từ root, với env của service tương ứng:

```powershell
# Chỉ xem orphan, mặc định không xóa
rtk npm run storage:cleanup --prefix services/user-service -- --dry-run

# Replay một message đầu DLQ User sau khi đã xử lý nguyên nhân
rtk npm run events:replay --prefix services/user-service

# Replay một Merchant event FAILED; thay UUID minh họa bằng event cần xử lý
rtk npm run events:replay --prefix services/merchant-service -- 66666666-6666-4666-8666-666666666666
```

Hai lệnh replay làm thay đổi trạng thái xử lý event; chúng không chỉ xem log. Với cleanup, chỉ truyền `--delete` khi chủ động muốn thực hiện xóa orphan đủ điều kiện. Không cần chạy delete thật để giải thích được thiết kế trong buổi demo.

## 20. Ví dụ gọi API để tự quan sát

Giả sử hệ thống local đầy đủ đã chạy tại Gateway port 3000 và bạn có access token từ đăng nhập. `ACCESS_TOKEN_CUA_BAN` là placeholder; không tự tạo Gateway Token ở frontend. Nếu dùng bộ runtime riêng, đổi base URL sang port tương ứng và lấy credential theo harness của môi trường đó.

### Xem hồ sơ hiện tại

```http
GET http://localhost:3000/api/users/me
Authorization: Bearer ACCESS_TOKEN_CUA_BAN
```

### Xem KYC

```http
GET http://localhost:3000/api/users/me/kyc
Authorization: Bearer ACCESS_TOKEN_CUA_BAN
```

### Sửa profile theo Auth ID

```http
PUT http://localhost:3000/api/users/by-auth/11111111-1111-4111-8111-111111111111
Authorization: Bearer ACCESS_TOKEN_CUA_BAN
Content-Type: application/json

{
  "fullName": "Nguyễn Văn An",
  "phone": "0900000000"
}
```

Thay Auth ID ví dụ bằng ID của chính tài khoản đăng nhập. Gửi ID của người khác bằng role USER sẽ bị từ chối.

### Upload KYC bằng Postman hoặc frontend

```text
Method: POST
URL: http://localhost:3000/api/users/me/kyc
Authorization: Bearer access token
Body: form-data
    idNumber: DEMO-ID-001      (Text)
    document: identity.png    (File)
```

Để công cụ tự tạo header multipart có boundary; không gửi JSON chứa đường dẫn file rồi kỳ vọng backend đọc file trên máy của bạn.

### Kiểm tra và đăng ký Merchant

```http
GET http://localhost:3000/api/merchants/me
Authorization: Bearer ACCESS_TOKEN_CUA_BAN
```

Nếu data null và chưa có hồ sơ owner bị soft delete, đăng ký:

```http
POST http://localhost:3000/api/merchants/register
Authorization: Bearer ACCESS_TOKEN_CUA_BAN
Content-Type: application/json

{
  "businessName": "An Store"
}
```

Lấy `data.id` từ response thực tế để gọi PUT/status/active. ID minh họa trong tài liệu không tự tồn tại trong DB.

### Sửa tên Merchant

```http
PUT http://localhost:3000/api/merchants/33333333-3333-4333-8333-333333333333
Authorization: Bearer ACCESS_TOKEN_CUA_BAN
Content-Type: application/json

{
  "businessName": "An Store Plus"
}
```

Quan sát version tăng một lần, có `merchant.profile_updated`; gửi lại cùng tên thì version không tăng và không có event mới. Nếu publisher đang chạy nhanh, Outbox có thể đã PUBLISHED khi bạn mở DB; không cần bắt nó phải luôn PENDING.

### Duyệt bằng quyền phù hợp

Admin UI thường đi qua Admin Service. Hai endpoint đích ở service nghiệp vụ là:

```text
PATCH /api/users/<profile-id>/kyc-status
Body: { "kycStatus": "APPROVED" }

PATCH /api/merchants/<merchant-id>/status
Body: { "status": "APPROVED" }
```

Để gọi trực tiếp các endpoint này qua Gateway cần access token ADMIN; token USER không đủ. Admin Service có luồng review/audit riêng, nên sửa trực tiếp bằng endpoint nghiệp vụ không được xem là đã chạy đầy đủ luồng audit của Admin.

## 21. Test đang chứng minh những gì?

### 21.1. Kiểm tra sau đợt đổi tên nội bộ — 12/10/2026

Các lệnh dưới đây đã chạy sau khi sửa code User/Merchant trong phiên làm việc này:

| Lệnh | Kết quả |
|---|---|
| `rtk npm test --prefix services/user-service` | 27/27 test đạt |
| `rtk npm test --prefix services/merchant-service` | 17/17 test đạt |
| `rtk npm run typecheck --prefix services/user-service` | Đạt |
| `rtk npm run typecheck --prefix services/merchant-service` | Đạt |
| `rtk git diff --check` | Không có lỗi whitespace |

Tổng cộng **44/44 test đạt**. Bộ test hiện có kiểm tra quyền sở hữu, phân biệt Auth ID/Profile ID, xử lý ID nhập nhằng, `/me`, OpenAPI và request đi qua Gateway thật tới hai app. Đây không phải xác nhận đã chạy lại luồng Auth/Admin với database thật: integration PostgreSQL/RabbitMQ/MinIO, browser acceptance, production-image smoke và build chưa được chạy lại trong đợt đổi tên. Không tạo migration và không thay dữ liệu DB.

### 21.2. Bằng chứng kiểm chứng trước đợt đổi tên — 11/10/2026

Các con số sau là kết quả kiểm chứng đã ghi ngày 11/10/2026; xem [báo cáo](User_Merchant_Completion_Report.md) để biết môi trường và giới hạn.

| Nhóm | Kết quả đã lưu | Ý nghĩa |
|---|---|---|
| Package auth | 3/3 nhóm pass | Claims/chữ ký/key production/context/error |
| User unit/API/contract | 27/27 pass | Route, quyền, upload validation, cleanup, contract, Gateway proxy |
| User integration | 26/26 pass | PostgreSQL/RabbitMQ/MinIO thật, atomicity/idempotency/race |
| Merchant unit/API | 17/17 pass | Ownership, `/me`, status, validation, profile behavior |
| Merchant integration | 12/12 pass | Outbox rollback, ordering, retry/lease/replay, broker confirm |
| Browser acceptance | 17/17 nhóm pass | Signup/login/refresh, profile, KYC review, Merchant review, giao diện |
| Production-image smoke | PASS | Chạy compiled JS với key riêng, worker và private storage |

Đọc test theo nội dung cần học:

| Chủ đề | File gợi ý |
|---|---|
| Gateway thật proxy vào hai app | [gateway.test.ts](../services/user-service/tests/gateway.test.ts) |
| `/me`, KYC của mình | [me.test.ts](../services/user-service/tests/me.test.ts) |
| Kiểm tra OpenAPI hai service | [contracts.test.ts](../services/user-service/tests/contracts.test.ts) |
| Inbox/profile concurrency và rollback | [profile.test.ts](../services/user-service/tests/integration/profile.test.ts) |
| Tier/default/backfill/Outbox | [tier.test.ts](../services/user-service/tests/integration/tier.test.ts) |
| Storage và race upload/delete | [storage.test.ts](../services/user-service/tests/integration/storage.test.ts) |
| Consumer/DLQ/restart | [broker.test.ts](../services/user-service/tests/integration/broker.test.ts) |
| Merchant publisher/nghiệp vụ với hạ tầng thật | [merchant integration](../services/merchant-service/tests/integration/merchant.test.ts) |

Test pass không chứng minh đã triển khai production, đã có consumer nghiệp vụ của team hoặc đã được Khoa review. Full frontend build vẫn có lỗi TS6133 đã ghi ở `AdminTopups.tsx`; acceptance dùng bundle Vite build được. Đây là giới hạn của bằng chứng hiện có, không phải lỗi build của hai backend service.

## 22. Câu hỏi thường gặp khi bạn trình bày

**1. Có Auth Service rồi, tại sao còn User Service?**  
Auth quản lý tài khoản/credential/phiên đăng nhập. User quản lý hồ sơ và KYC. Tách trách nhiệm giúp không phải đặt mọi dữ liệu cá nhân, storage và xác thực vào cùng một service.

**2. Một người có thể có User mà không có Merchant không?**  
Có. User được provision khi đăng ký; Merchant chỉ có khi người dùng đăng ký kinh doanh. `/merchants/me` null là trường hợp bình thường.

**3. User ID và ownerId có giống nhau không?**  
Phải nói rõ loại ID: Merchant ownerId bằng Auth ID, không phải User profile ID. `req.auth.userId` cũng là Auth ID.

**4. Ai được đăng ký Merchant?**  
Client phải có tài khoản và đăng nhập lấy token để đăng ký cho chính mình. Internal caller hợp lệ có cơ chế chỉ định owner. Không cần có role MERCHANT trước khi đăng ký; code chưa kiểm tra profile User tồn tại hoặc bắt KYC APPROVED. Xem mục 13.1 để phân biệt yêu cầu đăng nhập với kiểm tra owner trong DB.

**5. Merchant được duyệt có đổi role tài khoản không?**  
Không trong code hiện tại. Merchant status và Auth role là hai dữ liệu khác nhau.

**6. User KYC APPROVED có thành tier 1 không?**  
Không tự động. Tier độc lập với trạng thái duyệt; hàm đổi tier riêng ghi Outbox atomic.

**7. User Outbox có gửi lên RabbitMQ chưa?**  
Chưa. User worker hiện là consumer registration. Merchant mới có publisher Outbox hoàn chỉnh.

**8. Vì sao cần Inbox?**  
Broker có thể giao lại message. Inbox lưu event ID/hash để không tạo profile trùng và phát hiện một event ID bị dùng sai nội dung.

**9. Vì sao cần Outbox?**  
Để lưu thay đổi nghiệp vụ và ý định gửi event trong cùng transaction, tránh update DB xong nhưng quên event khi broker lỗi.

**10. Có bảo đảm exactly-once không?**  
Không tuyên bố exactly-once delivery toàn hệ thống. Inbox làm registration idempotent; Merchant publisher vẫn có thể gửi lặp khi crash sau broker confirm. Consumer downstream phải chống trùng.

**11. Tại sao đã có Outbox còn cần version?**  
Event ID nhận diện từng event; version biểu diễn thứ tự thay đổi của một Merchant. Hai mục đích khác nhau.

**12. PUBLISHED nghĩa là bên nhận đã xử lý chưa?**  
Chưa chắc. Nó phản ánh gửi tới broker đã được xác nhận và ghi trạng thái; xử lý phía consumer là bước khác.

**13. Tại sao file private vẫn xem được trên trình duyệt?**  
Service cấp URL ký sẵn sau kiểm tra quyền. URL cho phép đọc tạm 60 giây; bucket vẫn không bật public read.

**14. Tại sao không xóa ngay ảnh khi upload bị lỗi?**  
Kết quả commit DB có thể không rõ khi kết nối lỗi. Cleanup intent/reference check giúp tránh xóa ảnh đã được dùng hoặc để file mồ côi mãi mãi.

**15. Broker tắt thì API Merchant có dùng được không?**  
Các thao tác ghi DB/Outbox có thể vẫn thành công. Publisher gửi sau khi broker phục hồi; lỗi gửi có retry/FAILED để xử lý. Không có nghĩa mọi chức năng toàn platform hoạt động bình thường khi broker tắt.

**16. Có soft delete rồi, gọi DELETE ở đâu?**  
Chưa có endpoint DELETE trong hai router. Model và truy vấn đã xét deletedAt, nhưng không được tự suy ra có API xóa/phục hồi.

**17. Health 200 có chứng minh toàn bộ service tốt không?**  
Không. Health hiện trả liveness đơn giản; vẫn cần kiểm tra API thực tế, DB, storage và worker.

**18. Đã hoàn thành phần code tuần 1 có nghĩa mọi tính năng tương lai đã có chưa?**  
Không. H3 tuần 1 yêu cầu ghi Outbox atomic, không yêu cầu User publisher/UI tier. Cần phân biệt DoD của kế hoạch với chức năng chưa nằm trong phạm vi.

**19. Đợt đổi tên ID có buộc các service khác phải sửa theo không?**  
Không đổi hợp đồng giao tiếp: tên biến/hàm nội bộ đã rõ hơn nhưng API, event, schema dữ liệu và giá trị ID giữ nguyên. Ví dụ code dùng `ownerAuthUserId` trong khi JSON vẫn là `ownerId`. Thay đổi chỉ nằm trong User/Merchant; kết quả kiểm tra và giới hạn được ghi ở mục 21.1.

**20. Sau cập nhật, User profile ID có bằng Auth ID không?**  
Không có thay đổi gộp ID. `UserProfile` chỉ là alias TypeScript cho model `User` ở User Service; Prisma vẫn tạo Profile ID riêng, và `authUserId` vẫn liên kết tới tài khoản Auth.

## 23. Gợi ý trình bày trong 5–7 phút

| Thời lượng | Bạn giải thích/thao tác | Điểm cần chứng minh |
|---|---|---|
| 0:00–0:45 | Giới thiệu phạm vi và ba loại ID | User là hồ sơ, Merchant là hồ sơ kinh doanh, Auth quản lý đăng nhập |
| 0:45–1:30 | Gọi `/users/me`, `/merchants/me`, thử thiếu token | Identity lấy từ Gateway Token, không tin header client |
| 1:30–2:30 | Upload KYC, xem status, mở URL ảnh và review | Private storage, transition, status độc lập tier |
| 2:30–3:15 | Cho xem test registration gửi lặp | Một profile/một Inbox cho cùng event, rollback khi ghi Inbox lỗi |
| 3:15–4:00 | Cho xem test tier đổi/no-op/rollback | Tier + User Outbox atomic; nói rõ chưa có publisher User |
| 4:00–4:45 | Chạy cleanup dry-run hoặc trình bày bằng chứng A–F | Chỉ candidate, không mutation; bảo vệ reference/intent |
| 4:45–5:45 | Sửa tên Merchant, gửi lại cùng giá trị, xem event | No-op, version, Outbox và publisher confirm |
| 5:45–6:30 | Mở OpenAPI và bảng kết quả test | Contract đã có, điểm chờ team xác nhận |

Demo tier bằng test/domain operation đã chuẩn bị; không trình bày như có một màn hình Admin nâng tier. Nếu mở Outbox khi publisher đang chạy, kiểm tra ID/type/count và PUBLISHED, không cố kết luận lỗi vì không thấy PENDING.

Một đoạn giới thiệu có thể dùng:

> Em phụ trách User và Merchant Service. User quản lý hồ sơ cá nhân, tiếp nhận KYC và giữ tài liệu trong private storage; consumer registration có Inbox để chống xử lý lặp. Merchant quản lý đăng ký, xét duyệt và cập nhật hồ sơ kinh doanh. Những thay đổi Merchant được ghi cùng Outbox trong transaction, rồi publisher gửi sang RabbitMQ theo thứ tự version. Hai service xác thực Gateway Token bằng package chung và giữ đường gọi internal đã kiểm chứng cho Auth/Admin.

## 24. Liên hệ với nhiệm vụ H1–H6 của bạn

| Mã | Bạn đã phụ trách nội dung gì? | Phần nên đọc trong tài liệu này |
|---|---|---|
| H1 | User auth/package/context và tích hợp caller | Mục 4, 7, 16 |
| H2 | Registration consumer/Inbox/retry/DLQ/rollback | Mục 6 |
| H3 | Tier, migration/default và User Outbox atomic | Mục 5, 9, 17 |
| H4 | Cleanup job, orphan scanner, grace period, dry-run | Mục 8, 10 |
| H5 | Merchant auth/profile transaction/event/publisher | Mục 12–14 |
| H6 | Route current-user, OpenAPI/DTO/contract | Mục 7, 13, 18, 20 |

Phần giao tiếp cần team xác nhận vẫn gồm contract event, policy, bàn giao frontend, review PR và demo. Tài liệu mô tả implementation không thay thế sự xác nhận của các thành viên.

## 25. Tài liệu và source để tra cứu tiếp

- [Kết quả triển khai và bằng chứng test](User_Merchant_Completion_Report.md).
- [Hướng dẫn chạy môi trường, worker, storage và kiểm chứng](User_Merchant_Runtime.md).
- [Checklist hoàn thiện trong repo](FinVault_User_Merchant_Completion_Plan.md).
- [Mô tả PR đã chuẩn bị](User_Merchant_PR_Description.md).
- [OpenAPI User](../services/user-service/docs/openapi.json).
- [OpenAPI Merchant](../services/merchant-service/docs/openapi.json).
- [Trạng thái tuần 1 User](../services/user-service/docs/week1-status.md).
- [Trạng thái tuần 1 Merchant](../services/merchant-service/docs/week1-status.md).
- [Package auth README](../packages/finvault-internal-auth/README.md).

Một số đoạn lịch sử trong README service có thể mô tả thời điểm trước cập nhật. Tài liệu này cập nhật cách đặt tên và tra cứu ID theo code ngày 12/10/2026; bằng chứng test được tách thành lần chạy sau đổi tên ở mục 21.1 và báo cáo kiểm chứng ngày 11/10/2026 ở mục 21.2. Khi sửa code về sau, cần cập nhật tài liệu tương ứng.

