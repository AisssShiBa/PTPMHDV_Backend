# T1 sau bàn giao Wallet — 26/10/2026

Tích hợp trên nhánh Huu sau khi fast-forward tới `285c87c` (PR #47), giữ các
thay đổi Tuần 2 local. Bộ chạy vẫn là:

```powershell
rtk proxy node tests/acceptance/phase5.mjs
```

## Kết quả trên Compose mới

Project `finvault-acceptance-66fc3598232e`: **28 PASS, 1 FAIL, 10 BLOCKED**,
1 MANUAL_PENDING (B6-8), 2 DEFERRED (H9/H10). Exit 1 đúng vì T1 chưa hoàn tất.
Cụm đã stop, giữ volume/evidence. Không reset dữ liệu cụm khác.

- A3, S1–S3, S7, S9, S11–S14 PASS.
- WALLET-A9, WALLET-S6, WALLET-S7-INLINE và WALLET-TIMEZONE PASS.
- B6: 106/106 test PASS; Auth: 15/15; B2: 6/6; transaction keys: 1/1.
- `checkSystemConservation.actual = 0`, `isBalanced = true`; SQL SUM(balance) = 0.
- Wallet `npm run build` trong image đã generate Prisma mới: PASS.
- `git diff --check`: PASS. Chưa commit/push.

Report chính: `.cache/acceptance-week2/finvault-acceptance-66fc3598232e/result.json`.
`wallet-t1.json` lưu số dư/usage/trạng thái hold và số lần UPDATE quan sát được;
`issues.md` là bản nháp issue cục bộ, chưa gửi tracker hay tin nhóm.

## Phạm vi test vừa tích hợp

Implementation nằm ở `tests/acceptance/week2/wallet-scenarios.mjs`:

| Bài | Kiểm chứng |
|---|---|
| WALLET-A9 | Chi được nạp thêm 1.000.000đ qua ledger API; 600.000đ bị PER_TXN; hai lần 200.000đ thành công, lần thứ ba bị PER_DAY. Request bị từ chối không đổi số dư, usage, số dòng usage, hold hoặc ledger. |
| WALLET-S6 | 10 hold 100.000đ đồng thời: đúng 5 HTTP 200, 5 HTTP 422/PER_DAY; usage và heldBalance đúng 500.000đ; chỉ 5 hold tồn tại; release hoàn về 0. Người nhận thiếu/sai UUID không tạo side effect. |
| S7 | Giữ 50.000đ usage đã capture; release và scheduler hết hạn đều hoàn đúng phần reserve, không xóa usage đã chi. Replay release không hoàn hai lần; ledger và số dư giữ nguyên. |
| WALLET-S7-INLINE | Đồng hồ giả trong tiến trình riêng gọi service và DB thật: capture hold hết hạn trả 409/HOLD_EXPIRED, DB đã EXPIRED, heldBalance/usage được hoàn. Retry không hoàn thêm. |
| S10 | Phát hai message cùng eventId qua RabbitMQ thật, chờ queue hết cả ready/unacked, đếm UPDATE bằng audit trigger chỉ dành cho user tổng hợp trong DB nghiệm thu. Trigger/schema kiểm thử được dọn sau bài. |
| WALLET-TIMEZONE | Chạy test biên ngày/tháng/năm giờ Việt Nam do chủ Wallet bàn giao. |

WALLET-A9/WALLET-S6 gọi Wallet qua Gateway bằng ADMIN và được báo riêng như
kiểm chứng component. Chúng **không thay thế A9/S6 toàn luồng Payment/PIN**.
K1 đã kiểm chứng thêm Wallet thật nhận tier 1 sau duyệt KYC; chưa chứng minh
chuyển 1.000.000đ qua Payment/PIN nên vẫn BLOCKED.

Không chạy `limit-engine.test.ts` cũ lên DB ứng dụng nghiệm thu vì file đó tạo
ví có số dư trực tiếp, không có bút toán đối ứng. Các test mới nạp qua ledger API.

## Hai lỗi đã sửa khi tích hợp

1. `holdSchema` thiếu `destinationUserId` trong khi middleware thay req.body
   bằng kết quả Zod. Trường người nhận hợp lệ bị loại bỏ nên mọi hold HTTP trả
   400. Đã khai báo UUID người nhận và loại ví đích trong schema.
2. `captureHold` throw HOLD_EXPIRED ngay bên trong transaction, rollback cả
   cập nhật EXPIRED và hoàn usage. Đã trả kết quả hết hạn để commit transaction,
   rồi mới throw 409 ở ngoài; không thay đổi quy tắc hạn mức.

Lượt trước sửa `finvault-acceptance-ef2057a232d6`: 24 PASS, 4 FAIL, 10 BLOCKED.
Probe `inline-expiry-before-fix.json` trong thư mục lượt này ghi rõ:
`HOLD_EXPIRED`, nhưng hold vẫn `PENDING`, heldBalance = usage = 100.000đ.
Lượt sau sửa đã qua S7, WALLET-S6 và WALLET-S7-INLINE trên cụm mới.

## S10 còn FAIL — bàn giao Đạt

Quan sát: `deliveries=2`, `distinctEventIds=1`, **`updates=2`**.
`src/events/kyc.consumer.ts` hiện updateMany mỗi lần nhận message, không lưu
eventId. Cùng tier cuối bằng 1 không chứng minh chống xử lý trùng.

Chủ Wallet cần bổ sung cơ chế Inbox/dedup bền vững: ghi nhận eventId và cập nhật
tier cùng transaction, chịu được hai consumer/instance và restart, ACK sau
commit. Không dùng Map trong RAM hoặc chỉ so sánh tier hiện tại để thay dedup.
Sau bàn giao, chạy lại S10 hiện có và bổ sung hồi quy concurrency/restart phù
hợp với schema chính thức. Chưa sửa schema/migration Wallet thay chủ service.

## Mười bài còn BLOCKED

| Bài | Phụ thuộc tiếp theo |
|---|---|
| A4, S4, S5 | Đạt/Khoa: Payment confirm bằng transaction token; binding, expiry, single use. |
| A9, S6 | Khoa/Đạt: nối Payment checkout/PIN vào Wallet limits để kiểm chứng end-to-end. |
| K1 | Khoa/Đạt: Payment/PIN cho giao dịch 1.000.000đ sau khi Wallet nhận tier. |
| S8, S15 | Khoa: checkout truyền người nhận vào hold; sau đó test capture failure/idempotency. |
| R1, S16 | Nguyên/Khoa: P2P và thông báo từ giao dịch, UI popup/độ trễ/phục hồi broker. |

H7/H8/H11 và các nhóm bảo mật đã PASS vẫn được chạy lại trong cùng lượt.
T1 chỉ hoàn tất khi sửa S10, có các nghiệp vụ Payment còn thiếu, tích hợp đủ
assertion rồi toàn bộ Must PASS cùng lượt; B6-8 vẫn cần demo/review thật.
