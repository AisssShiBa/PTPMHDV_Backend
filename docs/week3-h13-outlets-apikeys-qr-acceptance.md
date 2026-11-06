# H13 — Outlet, Merchant API Key, QR HMAC: biên bản xác thực

**Ngày chạy:** 2026-11-05 (mục 1–5) · 2026-11-06 (mục 6, re-run sau K12)
**Nhánh:** `feat/week3-huu-vnpay`
**Phạm vi:** kế hoạch Tuần 3 §8 (H13-A Outlet + QR, H13-B API key).
**Nguyên tắc:** mọi kết quả dưới đây lấy từ **lần chạy thật**. Mục 1–5 chạy trên database test cô lập (`finvault_test?schema=merchant_test`, PostgreSQL 16 tại `127.0.0.1:25432`); mục 6 chạy lại M01–M08 trên Compose cô lập đầy đủ qua HTTP. Không suy ra PASS từ việc đã viết code.

## 1. Lệnh chạy và kết quả

Hạ tầng test dùng chung: `docker compose -f services/user-service/tests/compose.yml up -d --wait` (project `finvault-user-merchant-tests`).

```powershell
cd services/merchant-service
npm run test:db          # 3 migration, không còn pending
npm run typecheck        # tsc --noEmit: sạch
npm test                 # 33/33 pass
npm run test:integration # 18/18 pass
```

Contract OpenAPI (validator thật, không phải đọc bằng mắt):

```powershell
cd services/user-service
npx tsx --test --test-concurrency=1 tests/contracts.test.ts  # 1/1 pass
```

| Lệnh | Kết quả |
|---|---|
| `npm run typecheck` | PASS (không lỗi) |
| `npm test` (unit/API, stub Prisma) | PASS 33 / FAIL 0 |
| `npm run test:integration` (PostgreSQL thật) | PASS 18 / FAIL 0 (2 lần chạy liên tiếp) |
| `tests/contracts.test.ts` (SwaggerParser.validate) | PASS 1 / FAIL 0 |
| `docker compose config --quiet` | PASS (exit 0) |

## 2. M01–M08

| Mã | Kịch bản | Chạy ở đâu | Kết quả | Bằng chứng |
|---|---|---|---|---|
| `M01` | APPROVED + đúng owner tạo Outlet; list đúng merchant | `tests/outlets.test.ts`, `tests/integration/outlets.test.ts` | **PASS** | POST 201; list `totalElements=1`, `where.merchantId` = merchant trong path. Integration: outbox tăng **đúng 1** `merchant.profile_updated`, `aggregateVersion` = `Merchant.version` sau khi tăng |
| `M02` | Merchant PENDING/REJECTED tạo Outlet hoặc key → 409 | `tests/outlets.test.ts` | **PASS** | Cả `POST /outlets`, `POST /api-keys`, `GET /qr` trả 409 `MERCHANT_NOT_APPROVED` cho cả hai trạng thái |
| `M03` | User khác owner: list/create/revoke/key → 403; ADMIN được phép | `tests/outlets.test.ts`, `tests/api-keys.test.ts`, `tests/integration/outlets.test.ts` | **PASS** | POST/GET outlet và DELETE key → 403; ADMIN → 200; internal call → 200 |
| `M04` | `code` trùng → 409 an toàn, không lộ constraint | `tests/integration/outlets.test.ts` | **PASS** | Trùng cùng merchant và trùng từ merchant khác đều 409 `DUPLICATE_RESOURCE`; `outlet.count()` vẫn = 1 (không có 500, không lộ tên constraint) |
| `M05` | Sửa 1 byte QR → HMAC invalid; QR của B không dùng cho A | `tests/outlets.test.ts`, `tests/integration/outlets.test.ts` | **PASS** | Sửa body → `verifyOutletQr` = null; khác `merchantId`, khác `outletId`, bị cắt đuôi → null. Canonical = `['1', merchantId, outletId, 'Q1-COUNTER']`. Merchant B gọi path outlet của A → 404 |
| `M06 (M1)` | Secret chỉ có lúc tạo; DB chỉ lưu hash; không API đọc lại | `tests/api-keys.test.ts`, `tests/integration/outlets.test.ts` | **PASS** | `Cache-Control: no-store`; secret 32 byte; `secretHash` = SHA-256(secret) đúng; response không chứa hash; GET/revoke không trả secret lại; `lastUsedAt` chỉ đổi sau lần verify khớp |
| `M07` | Revoke lần đầu và lặp không lộ secret; key revoked không verify | `tests/api-keys.test.ts`, `tests/integration/outlets.test.ts` | **PASS** | Revoke 2 lần giữ nguyên `revokedAt` lần đầu; `verifyApiKey(raw)` sau revoke = null; response không chứa hash/secret; key không tồn tại → 404 `NOT_FOUND` |
| `M08` | Migration giữ nguyên Merchant/Outbox cũ; event không trùng | `tests/integration/outlets.test.ts` | **PASS** | Merchant cũ còn nguyên sau migration; 2 event cũ (`registered`, `status_updated`) có `aggregateVersion` duy nhất; tạo outlet thêm đúng 1 event, vẫn duy nhất theo version |

## 3. DoD Phase 5

| Yêu cầu DoD | Kết quả | Bằng chứng |
|---|---|---|
| **M1 PASS** | PASS | M06/M1 ở mục 2 |
| **Secret không thể đọc lại** | PASS | Chỉ response tạo key chứa secret; DB lưu SHA-256; assert response không chứa hash và không trả lại secret ở GET/DELETE |
| **QR có chữ ký được verify** | PASS | Verify end-to-end bằng `verifyOutletQr` trên token lấy từ HTTP; sửa dữ liệu → invalid |
| **Owner isolation rõ** | PASS | Owner khác → 403; ADMIN/internal theo contract → 200; outlet thuộc merchant khác → 404 (lọc theo `merchantId`) |
| **OpenAPI khớp route thực tế** | PASS | 12 route trong `merchantRoute.ts` ↔ 12 operation trong `docs/openapi.json`, 1:1 sau khi chuẩn hóa `:param`/`{param}`; 12 `operationId` duy nhất; `SwaggerParser.validate` pass |

Các route cũ trước đây chưa có contract cũng đã được bổ sung để thoả "khớp route thực tế": `GET /merchants/{id}`, `PATCH /merchants/{id}/status`, `GET /merchants/{id}/active` (kèm schema `MerchantActive`).

## 4. Ghi chú thiết kế đã chốt

- **Canonical QR** (pipe-delimited, có version): `1|<merchantId>|<outletId>|<outletCode>|<issuedAt>`; `token = base64url(canonical) + "." + base64url(HMAC-SHA256)`. Vì `code` bị ràng buộc `^[A-Za-z0-9_-]+$`, không field nào chứa `|` nên biên field luôn rõ ràng — không dựa vào escaping.
- **Khóa ký** là `MERCHANT_QR_SECRET` (secret hệ thống riêng, ≥32 ký tự) đi qua `*_FILE` Docker secret; **không** dùng API key merchant. Đã nối: `scripts/init-secrets.js` → `.env`/`secrets/merchant_qr_secret.txt` (0600) → `docker-compose.yml` (`*merchant-env`, `secrets:` của `merchant-service` và `merchant-publisher`, top-level `secrets:`) → `src/config/env.ts` → `tests/setup.ts` → `tests/acceptance/week2/runtime.mjs`.
- **Verify đặt tại** `src/services/qr.service.ts#verifyOutletQr(token, { merchantId, outletId })` — nơi checkout của Khoa phải gọi; hàm kiểm chữ ký constant-time **và** đối chiếu merchant/outlet mong đợi.
- **`issuedAt`** là thời điểm phát, không phải hạn dùng; chính sách hết hạn (nếu có) do bên verify áp đặt.
- **Outbox**: tạo outlet tái dùng event `merchant.profile_updated` đã được registry chấp nhận, tăng `Merchant.version` trong cùng transaction Serializable — giữ bất biến unique `(aggregateId, aggregateVersion)`. Không thêm `merchant.outlet_*` vì consumer registry chưa chấp nhận.

## 5. Vấn đề phát hiện và đã sửa trong quá trình chạy

- **Rò rỉ dữ liệu giữa các test file:** `tests/integration/merchant.test.ts` xoá `merchant` nhưng chưa xoá `merchant_api_keys`/`outlets`; FK `ON DELETE RESTRICT` khiến lần chạy liền sau fail với `merchant_api_keys_merchant_id_fkey`. Đã sửa hook dọn dẹp của `merchant.test.ts` để xoá api-key → outlet → outbox → merchant. Đây là lỗi cô lập test thật, không phải lỗi nghiệp vụ.
- **Secret thiếu trên máy:** `docker compose up` sẽ fail vì `secrets/merchant_qr_secret.txt` chưa tồn tại. Đã chạy `node scripts/init-secrets.js` (giữ nguyên mọi credential cũ, chỉ thêm secret mới); xác nhận file 64 hex, khớp giá trị trong `.env`, các secret cũ không đổi.

## 6. Nghiệm thu trên Compose cô lập (kế hoạch §10)

Khoảng trống "chưa chạy trên runtime cô lập" đã được đóng. Bộ `tests/acceptance/week3/merchant-scenarios.mjs` + `phase-week3-h13.mjs` chạy M01–M08 qua HTTP thật (Gateway → merchant-service → PostgreSQL, Outbox publisher thật + broker thật), mỗi verdict là một response hoặc một row bền vững quan sát trong chính lần chạy đó. QR được kiểm bằng cách **tự tính lại HMAC** từ secret của lần chạy (`.cache/.../secrets/merchant_qr_secret.txt`), không gọi lại hàm verify của service.

```powershell
node tests/acceptance/week3/phase-week3-h13.mjs
```

| | |
|---|---|
| Project | `finvault-acceptance-671281c9a033` |
| Commit | `c7ab3f5` |
| Thời gian | 2026-11-06T06:03:42Z → 06:05:05Z |
| Tổng kết | **PASS=13, FAIL=0, BLOCKED=0** |

Bảng này được chạy lại từ đầu trên stack mới sau khi K12 đổi enum SYSTEM wallet
(`TOPUP_POOL` → `CLEARING_TOPUP`, thêm `SETTLEMENT`), để bản tổng hợp §10 chỉ
trích dẫn những lần chạy của đúng commit đang báo cáo. Lần ghi đầu tiên là
`finvault-acceptance-278a8a14758f` (2026-11-05T19:28:00Z → 19:29:05Z, cùng
`PASS=13`).

| Mã | Kết quả | Bằng chứng (lần chạy cô lập) |
|---|---|---|
| `COMPOSE` | PASS | stack mới, host port truy cập được |
| `B6-7` | PASS | 8 service health + `user-publisher`, `user-consumer`, `merchant-publisher` |
| `SEED` | PASS | ADMIN + 3 USER; merchant A/B APPROVED, PENDING 1 |
| `M01` | PASS (201) | list `totalElements=1`; outbox `registered/status_updated/profile_updated` tại version `1/2/3`, `merchants.version=3` |
| `M02` | PASS (409) | outlet/key/QR đều `MERCHANT_NOT_APPROVED`; `count(outlets)=0` |
| `M03` | PASS (403) | USER lạ: list/create/QR/revoke đều `FORBIDDEN`; ADMIN list + đọc 200 |
| `M04` | PASS (409) | trùng cùng merchant và khác merchant đều `DUPLICATE_RESOURCE`; 1 row; không lộ `outlets_code_key`/`unique constraint`/`P2002` |
| `M05` | PASS (200) | QR tự verify khớp payload; sửa `outletCode`, cắt token, bind merchant B đều invalid; outlet của A dưới B → 404 |
| `M06` | PASS (201) | secret chỉ ở response tạo; `no-store`; DB `secret_hash` = SHA-256(secret), `prefix` = 8 ký tự đầu; tìm raw secret → 0 row |
| `M07` | PASS (200) | revoke 2 lần giữ `revokedAt` đầu; không lộ secret; keyId lạ → 404 |
| `M08` | PASS | A/B còn nguyên; mỗi merchant 1 `registered`; 0 cặp `(aggregate_id, aggregate_version)` trùng; **6 row PUBLISHED** bởi publisher thật |
| `CONSERVATION` | PASS | `checkSystemConservation` actual 0, `SUM(Wallet.balance)=0` |
| `STOP` | PASS | `down --remove-orphans`, giữ evidence và volume |

Bằng chứng gốc: `.cache/acceptance-week2/finvault-acceptance-671281c9a033/result.json` và `report.md`.

## 7. Còn mở / không thuộc H13

- **STOP-1** (WalletHold phải sống qua cửa sổ payout UNKNOWN) đã đóng bằng API extend phía Wallet trước lần chạy này (xem `docs/week3-h12-cashout-acceptance.md`). Không ảnh hưởng H13.
- H13 **không** cấp quyền thanh toán và không chứng minh luồng checkout; chỉ chốt hợp đồng outlet/QR/key. Việc dùng key để gọi API thanh toán là phạm vi service khác.
- Chưa có HTTP surface production nào gọi `verifyApiKey` (hàm được export cho consumer checkout). Vì vậy mệnh đề "key đã revoke không thể xác thực" được chứng minh bằng unit/integration test, **không** phải bằng lần chạy HTTP này — M07 chỉ chứng minh revoke idempotent và không lộ secret.
