# H15 — Demo seed Tuần 4

## Phạm vi và cách chạy

Tại thư mục backend, Node >=22, Docker Compose và dependencies user-service
(`npm ci` trong `services/user-service`, cần sharp để tạo ảnh PNG tổng hợp):

```bash
node tests/acceptance/demo-seed.mjs fresh
# Khi đã có images tương ứng source hiện tại:
node tests/acceptance/demo-seed.mjs fresh --no-build
node tests/acceptance/demo-seed.mjs verify-only <run-directory>
```

`fresh` luôn tạo project `finvault-acceptance-<12 hex>` mới, ports/secrets/volumes
riêng bằng runtime acceptance hiện hữu. Giữ cụm sau chạy để demo. Không gọi
`down -v`, không đổi secrets cụm cũ. `verify-only` chỉ đọc DB của project trong
`demo-context.json`; không signin, không tạo account, không gọi lại seed hoặc IPN.
Nếu fresh dừng giữa chừng, giữ evidence và tạo project mới; không tiếp tục seed
trên database dở dang. Namespace references là `demo-week4-v1`.

Giữ nguyên `tests/acceptance/seed.mjs` và seed browser/runner Tuần 2.

## Dữ liệu và contract

- 5 tài khoản nền: admin/an/binh/chi/highlands. Thêm 9 owner merchant, vì mỗi
  merchant yêu cầu owner riêng; tổng 14 principal, không phải chỉ 5.
- An/Bình/Chi có tier 2/1/0 và số dư cuối 1.250.000/300.000/100.000 VND.
- 10 merchant APPROVED; Highlands 3 outlet, merchant còn lại 1 outlet mỗi nơi.
  QR lấy từ API backend, không tạo token client hoặc tạo API key để seed.
- 3 topup 100.000 VND qua legacy POST `/api/payments/topups`, contract amount
  hiện tại là number. IPN synthetic ký HMAC gọi từ Node, kiểm tra replay `02`.
  Không gọi VNPAY sandbox thật. Route alias create vẫn thuộc blocker Gateway.
- 50 payment SUCCESS qua checkout/PIN/confirm thật, 25 lượt đi/về giữa An/Bình,
  amount string `1000`, idempotency key ổn định theo index. Không sửa timestamp
  hoặc balance bằng SQL; thời gian là thời điểm chạy, chưa có fixture trải nhiều
  ngày để demo bộ lọc lịch sử theo khoảng ngày.
- KYC dùng ảnh PNG tổng hợp từ helper acceptance, review/tier qua Admin API.
  Không thay policy K03 hoặc phát event K04 riêng.
- Admin role bootstrap dùng helper account hiện hữu trên Auth DB cô lập.

Verifier kiểm tra counts, balance/tier, SUM(balance)=0 gồm SYSTEM, balance và held
của USER/MERCHANT, từng balance khớp ledger, mỗi transaction cân đối, mỗi VNPAY
có đúng hai ledger entry và CLEARING_TOPUP debit 100.000 VND.

`seed-summary.json` chỉ chứa thống kê, không có credentials. File
`demo-accounts.json` trong `.cache` bị gitignore, mode 0600, chứa credentials ngẫu
nhiên để demo; chỉ bàn giao qua kênh an toàn. Không đưa file này vào PR/log.
`demo-context.json` và `.env` chỉ dùng trong run-directory do tool tạo; không
nhận file context từ nguồn không tin cậy.

## Kết quả phiên triển khai 11/11/2026

- Backend local HEAD: `1792e65f76cf175700900e21ccabea4c055c6aaf`.
- Frontend local HEAD: `ec9e7764224c61cb1421008352be5e07688d3e5e`.
- `node --check tests/acceptance/demo-seed.mjs`: exit 0.
- `node --check tests/acceptance/demo-seed.verify.mjs`: exit 0.
- `node tests/acceptance/demo-seed.mjs fresh`: exit 1, BLOCKED do Docker socket
  permission denied. Preflight dừng trước prepare(), không tạo cụm hoặc secrets.
- Fetch backend: exit 128, lỗi quyền `/etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf`.
  Chưa xác nhận remote HEAD.
- Dependency sharp chưa cài tại local. Cần cài trước khi chạy integration.
- SEED-01/SEED-02: BLOCKED, chưa có bằng chứng DB hoặc Compose PASS.
- Nguyên: 5 hồ sơ KYC PENDING và A8 snapshot/restore riêng chưa ghép.
- H16–H20 chưa triển khai trong thay đổi này; không thay trạng thái nghiệm thu cũ.

Chưa đạt DONE H15: cần chạy fresh rồi verify-only trên cùng cụm, kiểm tra summary
không đổi, bổ sung lịch sử trải nhiều ngày nếu nhóm yêu cầu và ghép seed Nguyên.
