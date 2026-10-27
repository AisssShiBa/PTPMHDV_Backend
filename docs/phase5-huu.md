# Bàn giao Phase 5 — 26/10/2026

**Cập nhật sau pull `285c87c`:** đã tích hợp Wallet mới và sửa hai lỗi hold.
Lượt mới: **28 PASS, 1 FAIL (S10), 10 BLOCKED**. Xem
[kết quả tích hợp T1 Wallet](t1-wallet-integration.md) cho bằng chứng và điểm
bàn giao hiện tại. Nội dung bên dưới giữ mốc trước khi nhận PR #47.

## Trạng thái hiện tại

Phần API B1/B3, H7, H8, H11 đã có mã nguồn và bằng chứng kiểm thử.
B2 đã qua kiểm tra secret và khởi tạo Compose mới; phạm vi scan và nợ DB role
vẫn theo [Phase 4](phase4-huu.md). **T1/Tuần 2 chưa hoàn thành** vì còn 12 bài
BLOCKED và B6-8 cần demo/review. H9/H10 tiếp tục hoãn theo kế hoạch đóng băng.

Kế hoạch gốc còn các checkbox bàn giao/merge/review chưa được xác nhận;
kết quả test không tự xác nhận những công việc đó.

## Kết quả nghiệm thu mới nhất

Lệnh từ root backend:

```powershell
rtk proxy node tests/acceptance/phase5.mjs
```

Project `finvault-acceptance-4501f150b2e6` dùng Compose chính, volume mới,
credential và cổng riêng. Lượt chạy đang hoạt động khi khôi phục session đã
được theo dõi tới khi ghi báo cáo và dừng cụm thử thành công.

- **23 PASS, 0 FAIL, 12 BLOCKED, 1 MANUAL_PENDING, 2 DEFERRED**.
- **A3, S1, S2, S3, S9, S11, S12, S13, S14 PASS**.
- Hồi quy B6-1 đến B6-6: **106/106 test PASS**.
- Auth security/Gateway/rate limit: **15/15 test PASS**; chạy riêng hai test
  rate limit cũng PASS.
- B2: **6/6 test PASS**; khóa transaction token: **1/1 test PASS**.
- `checkSystemConservation` và SQL SUM(balance) đều bằng **0**.
- `automatedAcceptanceComplete = false`, `acceptanceComplete = false`;
  lệnh vẫn phải exit 1 khi có BLOCKED. Không đổi BLOCKED thành PASS.
- Cụm thử đã stop; giữ volume và evidence để điều tra.

Bằng chứng cục bộ (không chứa credential trong report):

- `.cache/acceptance-week2/finvault-acceptance-4501f150b2e6/result.json`
- `.cache/acceptance-week2/finvault-acceptance-4501f150b2e6/issues.md`
- `auth-regression-auth.log`, `b6-*.log`, `b2.log`, `transaction-keys.log`
  trong cùng thư mục.

`accounts.json`, `regression.json`, `.env` và `secrets/` chứa credential thử,
chỉ giữ cục bộ, không dùng làm tài liệu bàn giao công khai.

## Lỗi A3 đã được xử lý

Lượt `finvault-acceptance-31ff6b4dac09` trả 429 ngay khi setup PIN vì các
middleware Auth dùng chung Map với khóa IP, làm lượt signup/signin tiêu thụ
hạn mức PIN. Khóa bộ đếm hiện gồm ID riêng của limiter và danh tính user đã
xác thực (IP cho request chưa có danh tính). Hai alias PIN dùng cùng router
nên vẫn dùng chung hạn mức cho cùng thao tác.

Test `services/auth-service/tests/rateLimiter.test.ts` xác nhận:

- Login và PIN không tiêu thụ hạn mức của nhau trên cùng IP.
- Hai user có hạn mức PIN độc lập.
- Đổi alias hoặc giả header user không đặt lại hạn mức đã dùng.

A3 trên cụm thật đã kiểm tra setup, năm lần sai, lần thứ sáu dùng PIN đúng
vẫn bị khóa, rồi mở khóa sau 30 phút bằng đồng hồ giả trong tiến trình riêng
gọi PinService và DB thật. Không sửa timestamp khóa trong database.

## Các phụ thuộc còn thiếu

| Bài | Chủ phụ trách | Việc cần bàn giao |
|---|---|---|
| A4, S4, S5 | Đạt/Khoa | Payment confirm cho USER; kiểm tra ràng buộc user/payment/amount, token hết hạn và lưu chống dùng lại nguyên tử. Hiện route chỉ nhận INTERNAL_KEY. |
| A9, S6, S7 | Khoa/Đạt | Wallet tier và usage theo ngày, kiểm tra đồng thời, hoàn usage khi release/hết hạn. Schema hiện chưa có kycTier. |
| K1, S10 | Đạt/Khoa; Hữu tích hợp | Consumer user.kyc_updated, Inbox chống trùng và cập nhật Wallet tier; sau đó kiểm chứng chuyển 1.000.000 VND theo tier. Phần duyệt/phát event K1 đã chạy. |
| S8, S15 | Khoa | Hợp đồng checkout truyền người nhận sang Wallet hold. Probe thật hiện trả 400 HOLD_FAILED; chưa có hold thành công để kiểm tra lỗi capture/idempotency. |
| R1, S16 | Nguyên/Khoa | Luồng P2P hoàn chỉnh và notification từ giao dịch; sau đó kiểm tra độ trễ 9/10 lần và phục hồi sau khi RabbitMQ trở lại. |

Các mục này đã được đối chiếu với schema/routes/validation hiện có và probe
runtime. Các hàm `requireTokens`, `requireLimits`, `requireCheckout`,
`requireP2p`, `s10` trong `week2/phase5-scenarios.mjs` hiện phát hiện phụ thuộc
và báo BLOCKED; **chưa phải các assertion nghiệp vụ đầy đủ**. Khi chủ service
bàn giao phải tích hợp test thực sự, không chỉ bỏ guard BLOCKED rồi coi PASS.
R1 còn cần bằng chứng popup trên Web; socket ticket S14 không thay thế R1.

`issues.md` là bản nháp issue cục bộ theo từng bài/owner. Chưa gửi tin nhóm,
đăng issue, tạo PR hay xác nhận review thay cho người phụ trách.

## Điểm tiếp tục

1. Nhận hợp đồng và implementation Wallet/Payment từ các chủ phụ trách ở bảng trên.
2. Tích hợp các assertion còn thiếu vào bộ Phase 5, giữ kiểm chứng ledger và usage.
3. Chạy lại một lượt trên volume mới; yêu cầu mọi bài Must PASS cùng lượt,
   bảo toàn số dư bằng 0, sau đó bổ sung demo/review B6-8.

Không mở thêm H9/H10 trong giai đoạn đóng băng. Các thay đổi hiện nằm trong
working tree (có cả staged và unstaged), chưa được coi là đã commit/merge.
