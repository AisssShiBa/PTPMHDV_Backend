# Tuần 2 — tích hợp Auth, Wallet, Payment và Notification

## Hợp đồng HTTP

`POST /api/payments/checkout` nhận người dùng đã xác thực qua Gateway, header
`Idempotency-Key` (1–255 ký tự), và body:

```json
{
  "type": "WALLET_TRANSFER",
  "destinationUserId": "<Auth user UUID người nhận>",
  "amount": "50000"
}
```

Số tiền là chuỗi số nguyên VND dương. `idempotencyKey` trong body vẫn được hỗ trợ;
nếu gửi cả hai thì phải giống nhau. Replay cùng payload trả cùng Payment/hold.
Lỗi Wallet `LIMIT_EXCEEDED` giữ HTTP 422 và thông tin `error.details.limitType`.

Sau checkout, gọi `/api/auth/pin/verify` với `{pin, paymentId, amount}` để nhận
`transactionToken`. Gửi token vào `POST /api/payments/:id/confirm`:

```json
{ "transactionToken": "<token từ Auth>" }
```

Confirm cần danh tính Gateway; internal key không thay thế xác nhận PIN.
Payment kiểm ES256, issuer/audience, thời hạn tối đa 60 giây, `sub`, `paymentId`,
`amount`, `jti`. Sai binding trả 403 `TXN_TOKEN_MISMATCH`, hết hạn trả 401
`TXN_TOKEN_EXPIRED`, dùng lại trả 409 `TXN_TOKEN_REUSED`.

## Khôi phục khi service gặp sự cố

- Auth ghi User và Outbox cùng transaction; publisher dùng lease, broker confirm
  và retry có backoff. Broker init tạo trước hai queue provisioning.
- Wallet nhận `user.registered` để tạo ví USER, `merchant.status_updated` APPROVED
  để tạo ví MERCHANT, và `user.kyc_updated` để cập nhật tier. Inbox và thay đổi ví
  commit cùng transaction; trùng eventId không chạy handler lại.
- Payment lưu workflow và token đã dùng trước khi capture. Cùng holdId được giữ
  qua retry/restart. Worker xử lý lại HOLDING/CONFIRMING/RELEASING.
- Khi kết quả capture chưa chắc chắn, Payment thử release: nếu hold đã captured,
  đọc lại bằng capture idempotent và hoàn tất SUCCESS; nếu release thành công,
  hoàn tất FAILED. Không cộng tiền bù bằng một bút toán credit riêng.
- Payment thành công/thất bại/hết hạn ghi Outbox cùng transaction trạng thái;
  publisher phát envelope v1 lên `finvault.events`. Notification xử lý Inbox và
  thông báo người gửi/người nhận; mất broker không chặn giao dịch.
- P2P refund qua endpoint refund cũ bị từ chối: hoàn tiền P2P cần một giao dịch
  ngược có đối ứng. Endpoint nạp tiền riêng không thay đổi.

## Migration và triển khai

Các migration mới: Auth Outbox; Wallet Inbox; Payment baseline và P2P/token.
Docker Payment chuyển từ `db push` sang `migrate deploy`.

DB sạch dùng trực tiếp `migrate deploy`. Với DB Payment cũ đã tạo bằng `db push`,
cần sao lưu và đối chiếu schema với migration trước khi baseline migration history;
không chạy reset hoặc đánh dấu migration đã áp dụng nếu schema chưa khớp.
Lượt triển khai này chỉ dùng các DB nghiệm thu mới, không baseline DB đang có dữ liệu.

Auth cần `RABBITMQ_URL`; Payment cần `AUTH_TXN_PUBLIC_KEY_FILE`. Compose đã mount
public key giao dịch vào Payment; private key chỉ ở Auth.

## Kiểm chứng

Chạy `rtk proxy node tests/acceptance/phase5.mjs` từ backend. Mỗi lượt tạo project,
credentials, port và volume riêng; cuối lượt gỡ container/network của project,
giữ volume và evidence dưới
`.cache/acceptance-week2/<project>/`.

Runner kiểm chứng chuyển tiền thật, PIN/token, limits, lỗi capture, broker recovery,
KYC hai mặt, lookup, audit, Inbox concurrency/rollback/restart và bảo toàn số dư.
R1 tự động đo HTTP confirm → socket người nhận; phần hiển thị popup trong trình
duyệt vẫn được báo riêng là `R1-UI: MANUAL_PENDING`. B6-8 review/demo cũng cần
xác nhận con người. H9/H10 chưa nằm trong đợt tích hợp Must này.
