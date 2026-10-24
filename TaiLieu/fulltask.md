TÀI LIỆU KỸ THUẬT VÀ KẾ HOẠCH TRIỂN KHAI
HỆ THỐNG VÍ ĐIỆN TỬ FINVAULT
Kiến trúc Microservices · Event-Driven · Sổ cái kép
Phiên bản 2.0 – bản rà soát và bổ sung (thay thế v1)
Hạng mục Nội dung Hạng mục Nội dung
Tên dự án FinVault – Digital Wallet Thời gian 4 tuần (Sprint 1–4), 20 ngày làm việc
Nhóm 4 thành viên: Đạt, Khoa, Hữu, Nguyên Nền tảng Mobile (React Native/Expo) + Web (React/Vite)
Kiến trúc Microservices, Event-Driven, Ledger Hạ tầng Docker Compose, PostgreSQL, Redis, RabbitMQ, MinIO

Cách đọc tài liệu này
Chữ đỏ trong sơ đồ và mục "Mới (v2)" là chỗ đã bổ sung hoặc sửa so với v1. Danh sách đầy đủ các lỗi đã sửa nằm ở Phụ lục A. Mọi con số về hạn mức, ngày công và dữ liệu mẫu là giá trị minh họa cần cả nhóm xác nhận.

Mục lục 0. Tổng quan, phạm vi và ranh giới Thật/Mô phỏng

1. Kiến trúc tổng thể
2. Khái niệm kỹ thuật cốt lõi (kèm ví dụ dữ liệu)
3. Mô hình dữ liệu (ERD)
4. Luồng nghiệp vụ và máy trạng thái
5. Use case và wireframe
6. Hợp đồng API và danh mục sự kiện
7. Phân công công việc theo thành viên
8. Lộ trình 4 tuần, Gantt và tải công việc
9. Kiểm thử và tiêu chí nghiệm thu
10. Rủi ro và phương án giảm thiểu
11. Quy ước chung (secrets, môi trường, API, git)
12. Bảng đối chiếu nguồn mã
    Phụ lục A – Danh sách chỉnh sửa v1 → v2
    Phụ lục B – Dữ liệu mẫu để demo
13. Tổng quan, phạm vi và ranh giới Thật/Mô phỏng
    FinVault là ví điện tử mô phỏng mô hình của một tổ chức trung gian thanh toán: người dùng nạp tiền, chuyển tiền P2P, thanh toán QR cho cửa hàng, rút tiền và trả hóa đơn. Điểm nhấn kỹ thuật của đồ án là tính đúng đắn của dòng tiền (sổ cái kép, chống race condition, lũy đẳng, outbox) chứ không phải số lượng tính năng.
    Mục tiêu
    • Không bao giờ để số dư âm hoặc tiền “bốc hơi”: tổng Debit = tổng Credit trong mọi giao dịch.
    • Mọi lệnh chuyển tiền đều có bước xác thực thứ hai (PIN) và chạy lũy đẳng.
    • Hệ thống chạy được bằng một lệnh docker compose up, chỉ mở một cổng ra ngoài (Gateway).
    • Có đủ Web và Mobile, mỗi nền tảng phục vụ đúng nhu cầu của mình (xem Phần 5).
    Ngoài phạm vi
    Kết nối ngân hàng thật, thẻ quốc tế, eKYC sinh trắc học thật, hoàn tiền chargeback, đa tiền tệ. Những thứ này chỉ được mô phỏng như bảng dưới để hội đồng không hiểu nhầm.
    Bảng 2. Ranh giới Thật / Sandbox / Mô phỏng
    Thành phần Trạng thái Ghi chú khi bảo vệ
    Sổ cái kép, Hold/Capture, khóa hàng Thật Chạy trên PostgreSQL thật, có test song song.
    Outbox/Inbox, RabbitMQ, Saga hoàn tiền Thật Có DLQ và retry.
    PIN, transactionToken, Gateway token Thật Ký khóa bất đối xứng, token dùng một lần.
    Nạp tiền VNPAY Sandbox Dùng thẻ test của VNPAY; IPN gọi GET, có kiểm checksum.
    Rút tiền về ngân hàng Mô phỏng Container Mock Payout Bank trả thành công/thất bại/timeout theo kịch bản.
    Nạp ĐT, hóa đơn điện/nước Mô phỏng Mock Telco/Bill Provider; chiết khấu 3% là số giả lập.
    Push notification Mô phỏng Socket.IO là thật; FCM chỉ ghi log hoặc dùng Expo Push nếu kịp.
    KYC cấp 1/2 Mô phỏng Admin duyệt thủ công; không đối chiếu dữ liệu quốc gia.
    Hạn mức theo cấp KYC Minh họa Các con số trong 2.7 là giả định học tập, không phải quy định pháp lý.

14. Kiến trúc tổng thể
    Hệ thống gồm 10 service nghiệp vụ, mỗi service có cơ sở dữ liệu và role riêng. Chỉ Gateway nằm trên mạng public. Màu viền trong sơ đồ là người phụ trách.

Hình 1. Kiến trúc tổng thể và ranh giới mạng
Bảng 3. Danh mục service
Service Cổng Phụ trách Trách nhiệm Cơ sở dữ liệu / ghi chú
gateway 3000 Đạt Xác thực access token, ký Gateway Token, rate limit, proxy WebSocket, whitelist IPN Redis (rate limit)
auth-service 3001 Đạt Đăng ký/đăng nhập, refresh token family, PIN và transactionToken, QR login auth_db
user-service 3002 Hữu Hồ sơ, KYC, kycTier user_db + MinIO
merchant-service 3003 Hữu Cửa hàng, QR điểm bán, API key merchant_db
wallet-service 3004 Khoa Ví, sổ cái, hold, hạn mức, đối soát wallet_db (append-only)
payment-service 3005 Khoa Checkout, confirm, Saga hoàn tiền payment_db
notification-service 3006 Nguyên Inbox, socket, thiết bị, push notification_db
admin-service 3007 Nguyên Dashboard tổng hợp từ sự kiện, duyệt KYC/nạp thủ công admin_db
funding (mới) nội bộ Hữu VNPAY create/IPN, cash-out funding_db
utilities (mới) nội bộ Nguyên Nạp ĐT, hóa đơn, gọi payment để trừ tiền utilities_db

1.1. Chuỗi tin cậy giữa các token (Mới v2)
Hiện mã nguồn dùng cờ tĩnh x-gateway-verified: true; bất kỳ container nào trong mạng cũng giả được. Thiết kế mới: Gateway ký một JWT nội bộ sống 60 giây, các service chỉ cần public key để kiểm tra, không giữ khóa ký.

Hình 2. Chuỗi token: Access Token → Gateway Token → transactionToken
Bảng 4. Ba loại token
Token Thời hạn Nội dung và quy tắc
Access Token 15 phút Auth ký bằng private key riêng. Gateway verify bằng public key. Refresh token xoay vòng theo “family”.
Gateway Token (x-gateway-token) 60 giây Claims: iss, aud, sub (userId), role, kycTier, jti. Thuật toán ES256 hoặc RS256 qua thư viện jsonwebtoken. Gateway giữ private key.
transactionToken 60 giây Sinh sau khi PIN đúng. Gắn userId + paymentId + amount + jti. Payment lưu jti vào bảng có UNIQUE nên chỉ dùng được một lần.

1.2. Mạng, bí mật và biến môi trường (Mới v2)
• Hai mạng Docker: public (chỉ Gateway) và internal (mọi service, DB, Redis, RabbitMQ). Các service con không publish cổng ra host.
• Không để bí mật trong repo hay trong docker-compose.yml. Dùng Docker secrets và đọc theo quy ước <TÊN>\_FILE. Repo chỉ chứa .env.example với giá trị giả.
• Mỗi service có DB role riêng, chỉ quyền trên database của nó. Role của wallet-service không có UPDATE/DELETE trên bảng LedgerEntry.
• Khóa ký (private key) của Auth và Gateway là hai khóa khác nhau. Xoay khóa bằng kid trong header JWT.
• Nếu đưa lên môi trường thật, bí mật phải nằm ở secret manager của nền tảng; Docker secrets chỉ là mức tối thiểu cho đồ án. 2. Khái niệm kỹ thuật cốt lõi
Mỗi mục có bốn phần: khái niệm, cơ chế, lý do bắt buộc và ví dụ dữ liệu để thành viên mới đọc là hình dung được.
2.1. Sổ cái kép (Double-Entry Ledger)
Khái niệm. Mỗi lần tiền dịch chuyển sinh ít nhất hai bút toán đối ứng cùng một transactionId: một DEBIT và một CREDIT cùng giá trị, bảo đảm ∑Debit − ∑Credit = 0.
Ví dụ. A chuyển 100.000đ cho B (A: 1.250.000đ, B: 300.000đ):
Bảng 5. Hai bút toán của một lần chuyển P2P
transactionId walletId direction amount balanceAfter referenceId
tx_01 wallet_A DEBIT 100.000 1.150.000 pay_7f3c:debit
tx_01 wallet_B CREDIT 100.000 400.000 pay_7f3c:credit

Lý do. Nếu chỉ UPDATE balance, khi có sự cố bạn mất dấu vết: ai chuyển, lúc nào, số dư trước đó. Bảng LedgerEntry có trigger prevent_ledger_mutation() từ chối UPDATE/DELETE ở tầng PostgreSQL, nên sổ cái là chỉ-ghi-thêm với mọi tài khoản ứng dụng. (Chỉ superuser hoặc chủ bảng mới gỡ được trigger, vì vậy cần thêm DB role không có quyền đó.)
Sửa so với v1
v1 viết “không một dòng code hay câu lệnh SQL nào có thể sửa”. Câu này quá tuyệt đối: người có quyền sở hữu bảng vẫn gỡ được trigger. v2 gắn thêm biện pháp phân quyền role.

2.2. Giữ tiền – Ghi nhận – Giải tỏa (Hold – Capture – Release)
Khái niệm. Mô hình Authorization–Capture của thanh toán thẻ: tách thành Hold (tạm giữ hạn mức) và Capture (trừ thật). Đây không phải two-phase commit giữa các dịch vụ; nó là hai bước nghiệp vụ trong cùng wallet-service.

Hình 3. Trạng thái của một WalletHold
Cơ chế.
• Hold: tính available = balance − heldBalance; đủ tiền thì tăng heldBalance. Tiền vẫn ở trong ví nhưng không tiêu được lần khác.
• Capture: trong một transaction DB: hai bút toán DEBIT/CREDIT, giảm cả balance và heldBalance, ghi dòng Outbox.
• Release: hold hết hạn (TTL 5 phút), bị hủy hoặc PIN sai quá số lần: giảm heldBalance, không có bút toán.
Mới v2 – điểm đến của Capture. Hold phải ghi destinationOwner (ví người nhận, ví merchant hoặc ví SYSTEM), nếu không Capture không biết CREDIT vào đâu.
2.3. Khóa bi quan (SELECT … FOR UPDATE)
Khái niệm. FOR UPDATE khóa dòng ví cho đến khi transaction kết thúc; transaction khác muốn khóa hoặc ghi dòng đó phải chờ. (Truy vấn đọc thường vẫn không bị chặn nhờ MVCC; v1 diễn đạt chưa chính xác chỗ này.)
SELECT \* FROM "Wallet" WHERE id = :walletId FOR UPDATE;

Hình 4. Race condition: không khóa so với có khóa
Chống deadlock. Khi khóa hai ví, luôn khóa theo thứ tự walletId tăng dần (chuyển từ ví 5 sang ví 2 thì khóa ví 2 trước). Lớp phòng thủ thứ hai: ràng buộc CHECK (balance >= 0 AND heldBalance <= balance) để dù code sai cũng không ghi được số dư âm.
Lỗi logic đã phát hiện trong v1
Đối soát yêu cầu “tổng số dư mong đợi = 0” nhưng ví SYSTEM_CLEARING_TOPUP phải âm khi người dùng nạp tiền. Vì vậy CHECK balance >= 0 chỉ áp dụng cho ví USER/MERCHANT: CHECK (ownerType = 'SYSTEM' OR balance >= 0). Khi đó ∑ balance của tất cả ví (kể cả SYSTEM) luôn bằng 0.

2.4. Tính lũy đẳng (Idempotency)
Khái niệm. Gọi lại một thao tác N lần với cùng tham số thì dữ liệu chỉ đổi một lần; các lần sau trả lại kết quả lần đầu. (v1 viết nhầm là “lũy quyền”; thuật ngữ đúng là lũy đẳng.)
Cơ chế hai lớp.
• Lớp API: header Idempotency-Key, ràng buộc @@unique([userId, idempotencyKey]) trên bảng Payment. Gọi lại trả replayed: true. (Mã hiện tại đang để @unique toàn cục trên idempotencyKey — hai user trùng key sẽ va nhau.)
• Lớp ví: UNIQUE(walletId, referenceId) trên LedgerEntry và WalletHold, nên dù Payment lỗi thì ví vẫn không ghi hai lần.
Bảng 6. Ví dụ lũy đẳng
Lần gọi Dữ liệu Kết quả
1 Key=k1, user=A, 100.000 201 Created, paymentId=pay_7f3c
2 (bấm lại) Key=k1, user=A, 100.000 200, replayed: true, cùng pay_7f3c
3 (user khác) Key=k1, user=B 201, paymentId khác (sau khi sửa khóa)
4 (đổi số tiền) Key=k1, user=A, 200.000 409 IDEMPOTENCY_KEY_REUSED

Lý do. Trong mạng phân tán, timeout không đồng nghĩa thất bại: tiền có thể đã bị trừ mà gói trả lời rớt. Khi timeout, client hỏi lại bằng cùng key chứ không tạo đơn mới.
2.5. Transactional Outbox và Inbox

Hình 5. Outbox ở bên gửi, Inbox ở bên nhận
Cơ chế. Ghi nghiệp vụ và dòng Outbox trong cùng transaction. Worker quét dòng PENDING, publish lên RabbitMQ (topic exchange), chỉ đổi sang PUBLISHED khi nhận publishConfirmed. Bên nhận lưu eventId vào Inbox với ràng buộc UNIQUE; trùng thì ACK rồi bỏ qua. Message lỗi nhiều lần vào DLQ.
Lưu ý. Mã hiện tại dùng tên trạng thái Outbox khác nhau ở từng service (PENDING/PUBLISHED so với publishedAt IS NULL). Chốt một quy ước chung ở Phần 11.
2.6. Xác thực phân tầng (Step-up) và Saga
Đăng nhập chỉ đủ xem số dư. Chuyển tiền cần PIN 6 số; sai 5 lần khóa 30 phút. PIN đúng thì Auth-Txn cấp transactionToken gắn userId + paymentId + amount + jti, hiệu lực 60 giây, dùng một lần. Gắn paymentId và amount là bắt buộc: nếu chỉ gắn userId (như mô tả v1), token có thể bị dùng cho giao dịch khác.
Hoàn tiền theo Saga. Không gọi HTTP sang ví bên trong transaction của Payment. Payment chuyển sang REFUNDING, ghi Outbox, worker xử lý với ví rồi chuyển REFUNDED. Nguyên tắc “timeout ≠ thất bại”: khi chưa chắc, giữ trạng thái chờ và tra cứu lại bằng referenceId, không tự hoàn.

Hình 6. Máy trạng thái Payment
2.7. Phân cấp KYC và bộ máy hạn mức
Thống nhất đặt tên Cấp 0 / 1 / 2 (v1 lẫn “Cấp” và “Level”). Số liệu dưới đây là minh họa học tập:
Bảng 7. LimitPolicy minh họa (cấu hình trong DB, đổi không cần sửa code)
Cấp Điều kiện Tối đa/lần Tối đa/ngày Tối đa/tháng
0 Mới đăng ký 200.000 500.000 2.000.000
1 Nộp CCCD và Admin duyệt 10.000.000 20.000.000 100.000.000
2 Liên kết ngân hàng hoặc xác thực khuôn mặt (mô phỏng) 50.000.000 100.000.000 500.000.000

Hạn mức kiểm tra trong wallet-service ngay lúc Hold (bảng UserDailyUsage, ngày tính theo giờ Việt Nam), không kiểm ở Gateway vì Gateway không có sổ cái.
Lưu ý quy định (cần kiểm chứng)
Theo Quyết định 2345/QĐ-NHNN, từ 01/07/2024 giao dịch chuyển tiền trực tuyến từ 10 triệu đồng/lần trở lên cần xác thực sinh trắc học. Đây là thông tin từ trí nhớ; nhóm cần kiểm tra lại văn bản gốc trước khi đưa vào báo cáo. Đồ án mô phỏng bằng PIN và nêu rõ hạn chế này.

3. Mô hình dữ liệu (ERD)
   Chỉ vẽ các bảng quan trọng nhất của wallet-service và payment-service. Phần đỏ là bảng/ràng buộc mới so với mã hiện tại.

Hình 7. wallet-service: Wallet, LedgerEntry, WalletHold, WalletOutboxEvent

Hình 8. wallet-service: hạn mức và đối soát

Hình 9. payment-service: Payment và các bảng liên quan

4. Luồng nghiệp vụ và máy trạng thái
   4.1. Chuyển tiền P2P có PIN
   Luồng quan trọng nhất; mỗi bước đều nối với một khái niệm ở Phần 2. Lưu ý bước 3 ghi destination và bước 8 chỉ chạy sau khi transactionToken hợp lệ.

Hình 10. Tuần tự chuyển tiền P2P
4.2. Nạp tiền VNPAY (Sandbox)
IPN là webhook do VNPAY gọi bằng GET, không có JWT nên Gateway phải whitelist đường dẫn. Bảo vệ bằng kiểm HMAC-SHA512 của tham số, so khớp số tiền với lệnh nạp và lũy đẳng theo mã giao dịch. Trả RspCode: 00 thành công, 02 đã xử lý trước đó, 97 sai chữ ký.

Hình 11. Tuần tự nạp tiền VNPAY

Hình 12. Trạng thái lệnh nạp tiền
4.3. Thanh toán QR cho merchant

Hình 13. Tuần tự quét QR thanh toán
4.4. Rút tiền về ngân hàng (mô phỏng)
Hold tiền → gọi Mock Payout → thành công thì Capture (về ví SYSTEM_SETTLEMENT), thất bại thì Release, timeout thì giữ trạng thái chờ và tra cứu lại (không tự Release vì ngân hàng có thể đã chuyển).

Hình 14. Trạng thái lệnh rút tiền 5. Use case và wireframe
Tại sao cả Web và Mobile? Mobile là nơi diễn ra hành động tiền bạc (quét QR, PIN, sinh trắc, push). Web phục vụ việc cần màn hình lớn và công việc quản trị: merchant xem doanh thu, admin duyệt KYC và đối soát, người dùng xem sao kê dài. Hai nền tảng gặp nhau ở QR login: Web hiện mã, điện thoại xác nhận.

Hình 15. Use case theo tác nhân
5.1. Wireframe Mobile

Hình 16. M-01 Trang chủ, M-02 Xác nhận + PIN, M-03 Kết quả
5.2. Wireframe Web
Mã QR hết hạn sau 120 giây (v1 ghi 54 giây trên mockup nhưng 2 phút ở API; đã thống nhất theo API).

Hình 17. W-01 QR login, W-02 Đối soát, W-03 Duyệt KYC
Sửa so với v1
Màn hình đối soát v1 hiển thị “Lịch sử chạy tự động mỗi giờ”. Mã hiện tại chỉ chạy theo yêu cầu và chỉ báo cáo (không tự sửa). Wireframe v2 có nút “Chạy đối soát” và danh sách bất thường; việc điều chỉnh do Admin thực hiện bằng bút toán đảo, không sửa sổ cái.

6. Hợp đồng API và danh mục sự kiện
   Làm contract trước: hai thành viên cùng đặt tên endpoint trong Tuần 1, frontend dùng mock (MSW hoặc Prism) rồi mới nối thật. Tất cả đi qua Gateway tại /api/....
   Bảng 8. Các endpoint chính
   Phương thức Đường dẫn Chủ Ghi chú
   POST /api/auth/sign-up · sign-in · refresh Đạt Mobile gửi x-client-platform: mobile để nhận refreshToken trong body
   POST /api/auth/qr-login/init · confirm Đạt Web init (TTL 120s); Mobile confirm
   POST /api/auth-txn/pin/setup · verify Đạt verify trả transactionToken
   GET /api/users/me · PATCH /api/users/me Hữu Hồ sơ
   POST /api/users/me/kyc Hữu Nộp ảnh CCCD (upload lên MinIO)
   POST /api/merchants · GET /api/merchants/:id/qr Hữu QR bàn/điểm bán
   POST /api/funding/vnpay/create Hữu Trả URL VNPAY
   GET /api/funding/vnpay/ipn Hữu Public, không JWT
   POST /api/funding/cash-out Hữu Cần Idempotency-Key
   GET /api/wallets/me · /me/ledger Khoa Số dư, sổ cái phân trang
   POST /api/payments/checkout Khoa Header Idempotency-Key bắt buộc
   POST /api/payments/:id/confirm Khoa Kèm transactionToken
   POST /api/admin/reconciliation/run Nguyên Chỉ ADMIN; trả báo cáo
   GET /api/notifications/me Nguyên Thay cho /:userId để chống xem trộm
   POST /api/utilities/topup · bills/pay Nguyên Gọi payment-service

Định dạng lỗi chung: { "code": "INSUFFICIENT_FUNDS", "message": "...", "traceId": "..." }. Tiền tệ lưu số nguyên VND hoặc decimal(20,2), gửi qua JSON dưới dạng chuỗi.
Bảng 9. Danh mục sự kiện (_: cần xác nhận với mã hiện có ai tạo ví)
Sự kiện Phát Nhận Dùng để
user.registered auth user, wallet_ Tạo hồ sơ rỗng và ví
user.kyc_updated user wallet, notification, admin Đổi hạn mức, báo người dùng
wallet.balance_added / deducted wallet notification, admin Thông báo biến động, số liệu dashboard
payment.success / expired / refund_requested payment notification, wallet, admin PAYMENT_EXPIRED hiện thiếu trong enum notification
funding.topup_succeeded funding notification, admin Thông báo nạp tiền
merchant.profile_updated merchant admin Cập nhật dashboard

7. Phân công công việc theo thành viên
   Nguyên tắc: mỗi người sở hữu một trục dọc từ backend đến giao diện của mảng mình, để không ai phải chờ ai quá lâu và không ai bị dồn việc.
   Đạt — Biên, bảo mật danh tính, xác thực cấp 2
   Hạng mục Nội dung và tiêu chí xong
   Gateway token Xóa x-gateway-verified. Ký JWT nội bộ ES256/RS256, 60 giây. Viết thư viện finvault-internal-auth để Khoa, Hữu, Nguyên dùng chung. Xong khi: gọi thẳng vào service không kèm token hợp lệ bị 401.
   Mạng và secrets Đóng cổng service con, chỉ mở 3000. Docker secrets \_FILE, .env.example, DB role riêng. Proxy WebSocket /socket.io, whitelist GET /api/funding/vnpay/ipn.
   Auth Refresh token family + phát hiện dùng lại (thu hồi cả family). Mobile nhận refresh qua body. signUp ghi Outbox user.registered, không gọi HTTP đồng bộ.
   PIN (Auth-Txn) Bảng UserPin (pinHash Argon2/bcrypt, failedAttempts, lockedUntil). Sai 5 lần khóa 30 phút. Cấp transactionToken gắn userId+paymentId+amount+jti.
   QR login init (Redis TTL 120s, nonce một lần) và confirm từ Mobile.
   Giao diện Đăng nhập/đăng ký, modal PIN, Web QR login, khung monorepo (apps/web, apps/mobile, packages/api-client).

Khoa — Lõi kế toán, chống race condition, thanh toán
Hạng mục Nội dung và tiêu chí xong
Race condition (P0) SELECT … FOR UPDATE trong wallet-hold.service.ts và ledger.service.ts; khóa theo thứ tự walletId; thêm CHECK. Xong khi: test 20 request song song không làm số dư âm.
Ví SYSTEM Tách CLEARING_TOPUP / SETTLEMENT / FEE bằng systemCode; migration chuyển số dư cũ; CHECK có ngoại lệ cho SYSTEM.
Idempotency và Saga Đổi thành @@unique([userId, idempotencyKey]). refund() không gọi HTTP trong transaction: dùng REFUNDING + Outbox. Job quét PENDING quá hạn để Release.
Limit Engine LimitPolicy + UserDailyUsage, kiểm nguyên tử ngay lúc Hold.
Đối soát Báo cáo theo yêu cầu, chỉ báo cáo; kiểm tra: số dư âm, lệch so với tổng sổ cái, giao dịch không cân.
Giao diện Chuyển tiền P2P, xác nhận giao dịch, lịch sử sổ cái.

Hữu — Người dùng, KYC, merchant, nạp/rút
Hạng mục Nội dung và tiêu chí xong
User Bỏ middleware tự verify JWT; dùng finvault-internal-auth. Consumer user.registered tạo hồ sơ rỗng.
KYC kycTier 0/1/2; phát user.kyc_updated khi Admin duyệt; worker dọn ảnh KYC mồ côi trên MinIO.
Merchant Outbox cho merchant.profile_updated; QR bàn/điểm bán; MerchantApiKey: chỉ lưu hash của secret và hiện một lần (v1 ghi mã hóa AES-256 để đọc lại, kém an toàn hơn).
Funding VNPAY create (HMAC-SHA512) và IPN (GET, kiểm chữ ký + số tiền, lũy đẳng, nguồn CLEARING_TOPUP). Cash-out: Hold → Mock Payout → Capture/Release.
Giao diện Hồ sơ, chụp/tải CCCD, nạp/rút, Web Portal Merchant (đơn hàng, xuất PDF QR).

Nguyên — Sự kiện, tiện ích, quản trị, nền tảng giao diện
Hạng mục Nội dung và tiêu chí xong
Notification Đồng bộ enum NotificationType; bảng NotificationInbox (eventId UNIQUE); route /me; Socket.IO nhận token trong auth, không để trong query string.
Thiết bị và push UserDevice; vừa bắn socket vừa mô phỏng push.
Admin AdminDashboardCache cộng dồn từ sự kiện; API đối soát; duyệt KYC; duyệt nạp thủ công.
Utilities Nạp ĐT (chiết khấu giả lập 3%), hóa đơn điện/nước/Internet qua Mock Provider; trừ tiền bằng payment-service.
Giao diện Chuông thông báo + badge, nạp ĐT/hóa đơn, Admin Portal, FE foundation chung (design token, component).

8. Lộ trình 4 tuần, Gantt và tải công việc
   Ước lượng theo ngày công, mỗi người có quỹ 20 ngày. Việc Must của mỗi người cộng lại 18–20 ngày; Should và Could vượt quỹ nên bị cắt nếu chậm. Đường găng đi qua Khoa (lõi ví → payment → mọi luồng thanh toán khác). Đây là ước lượng thô, cả nhóm cần chốt lại ở buổi lập kế hoạch Tuần 1.

Hình 18. Gantt 4 tuần theo từng thành viên (Must / Should / Could)

Hình 19. Ma trận phụ thuộc giữa các hạng mục

Hình 20. Khối lượng việc so với quỹ 20 ngày
8.1. Mục tiêu và tiêu chí hoàn thành đo được (DoD)
v1 viết DoD bằng lời (“mượt mà”, “chính xác 100%”). v2 đổi sang tiêu chí kiểm được bằng lệnh hoặc quan sát.
Bảng 14. DoD theo tuần
Tuần Mục tiêu DoD đo được
1 Lõi ví an toàn, Gateway kiểm soát mạng, khung FE gọi được API Test 20 request song song trên 1 ví: 0 lần số dư âm, tổng số dư trước/sau khớp. Gọi thẳng service (không qua Gateway) trả 401. Web và App đăng ký/đăng nhập qua Gateway. Contract API đã chốt, FE chạy với mock.
2 P2P có PIN, KYC theo cấp, thông báo realtime Chuyển P2P bắt buộc PIN; sai 5 lần bị khóa 30 phút; chuyển vượt hạn mức cấp 0 bị từ chối LIMIT_EXCEEDED; máy người nhận nhận socket trong ≤ 3 giây.
3 Tiền vào/ra và tiện ích, cổng quản trị Nạp 100.000đ bằng thẻ test VNPAY sandbox, IPN gửi lặp 2 lần chỉ cộng 1 lần; dùng số tiền đó nạp ĐT; Admin duyệt KYC và chạy đối soát trên Web.
4 Tích hợp, kiểm thử tải, diễn tập Đủ 9 kịch bản nghiệm thu ở Phần 9 đều đạt; demo 15 phút trên cả Web và Mobile; có video dự phòng; dữ liệu seed đủ như Phụ lục B.

8.2. Việc theo tuần
Bảng 15. Nhiệm vụ cụ thể theo tuần
Tuần Đạt Khoa Hữu Nguyên
1 Gateway token, đóng cổng, secrets, refresh mobile, khung monorepo FE FOR UPDATE + CHECK, test song song, sửa khóa idempotency Bỏ verify cũ, dùng thư viện chung, dọn ảnh KYC Enum notification, Inbox, Socket qua Gateway, FE foundation
2 PIN + transactionToken, modal PIN Ví SYSTEM, Limit Engine, màn P2P kycTier, chụp CCCD, QR merchant Thiết bị, socket/push, chuông thông báo
3 QR login Web, rate limit Redis Saga hoàn tiền, job hold quá hạn VNPAY create + IPN, cash-out, Web Merchant Utilities, Admin Portal
4 Load test, video demo, slide kiến trúc Kịch bản đối soát Seed dữ liệu, sửa lỗi tích hợp Seed dữ liệu, sửa lỗi tích hợp

Kịch bản đối soát Tuần 4 (sửa so với v1)
v1 hứa “hệ thống tự động bù trừ cân bằng”. Thực tế module chỉ phát hiện và báo cáo. Kịch bản đúng: cố ý tạo một ví lệch số dư trong DB test, chạy đối soát, Admin thấy bất thường BALANCE_DRIFT và xử lý bằng bút toán điều chỉnh có lý do.

9. Kiểm thử và tiêu chí nghiệm thu
   Bảng 16. Kịch bản nghiệm thu
   Mã Kịch bản Cách làm Kết quả mong đợi
   A1 Chuyển tiền song song 20 request đồng thời, mỗi cái 60.000đ trên ví 100.000đ Đúng 1 thành công, 19 bị từ chối, số dư 40.000đ
   A2 Bấm hai lần Gửi checkout 2 lần cùng Idempotency-Key 1 payment, lần 2 replayed: true
   A3 Khóa PIN Nhập sai 5 lần Khóa 30 phút, lần 6 trả PIN_LOCKED
   A4 Token dùng lại Confirm hai lần cùng transactionToken, và token quá 60 giây Lần 2 bị từ chối; token hết hạn bị từ chối
   A5 Giả mạo header Gửi x-gateway-verified: true thẳng vào service 401 (không có Gateway Token ký hợp lệ)
   A6 IPN lặp Gọi IPN 2 lần, và 1 lần sai chữ ký Cộng 1 lần; lần sai trả RspCode 97
   A7 Mất RabbitMQ Tắt RabbitMQ, chuyển tiền, bật lại Sự kiện vẫn được publish sau đó, không trùng thông báo
   A8 Đối soát Sửa tay balance của 1 ví trong DB test Báo cáo có anomaly BALANCE_DRIFT
   A9 Hạn mức Cấp 0 chuyển 600.000đ trong ngày Bị từ chối LIMIT_EXCEEDED

Tải: một kịch bản k6 hoặc autocannon, 50 người dùng ảo, 5 phút, đo p95 độ trễ của checkout/confirm và tỷ lệ lỗi. Đây là nhiệm vụ Could của Đạt; nếu cắt, vẫn phải giữ A1. 10. Rủi ro và phương án giảm thiểu
Bảng 17. Rủi ro
Rủi ro Mức Giảm thiểu
Khoa là đường găng, trễ thì mọi luồng thanh toán trễ Cao Chốt interface ví (hold/capture/release) ngay Tuần 1 để người khác dùng mock; Đạt hỗ trợ review.
VNPAY sandbox lỗi hoặc không truy cập được ngày demo Trung bình Chế độ nạp mô phỏng bằng Admin duyệt thủ công; video dự phòng.
Lỗi tích hợp dồn vào Tuần 4 Cao Tích hợp liên tục từ Tuần 2; mock API từ Tuần 1; demo nội bộ cuối mỗi tuần.
Thư viện finvault-internal-auth đến muộn Trung bình Đạt ra bản dùng được trong 3 ngày đầu, các service chỉ cần một middleware.
Migration ví SYSTEM làm hỏng dữ liệu Trung bình Chạy thử trên bản sao DB; có script đảo; đối soát trước và sau.
Mạng phòng thi yếu Trung bình Chạy toàn bộ bằng Docker cục bộ; video demo.
Quá tải phạm vi Cao Bảng Must/Should/Could; cắt từ Could trước.

11. Quy ước chung
    • Nhánh git: main luôn chạy được; feat/<service>-<việc>; mọi PR cần 1 người khác review (chéo giữa các trục).
    • Commit: type(scope): mô tả, ví dụ fix(wallet): lock rows in id order.
    • Sự kiện: tên miền.hành_động (ví dụ user.kyc_updated), payload có eventId, occurredAt, version.
    • Outbox: một quy ước trạng thái duy nhất PENDING | PUBLISHED | FAILED cho mọi service.
    • Lỗi API: mã lỗi dạng chữ hoa, có traceId; Gateway sinh x-request-id và truyền xuống.
    • Thời gian: lưu UTC, hiển thị giờ Việt Nam; ngày hạn mức tính theo giờ Việt Nam.
    • Bí mật: tuyệt đối không commit; mỗi người chạy .env.example → .env cục bộ; khóa JWT cấp bằng Docker secrets.
    • Log: không ghi PIN, token, số thẻ; che số CCCD (chỉ giữ 4 số cuối).
12. Bảng đối chiếu nguồn mã
    Bảng 18. Đối chiếu nguồn
    Hạng mục Vị trí trong repomix-output.xml
    Trigger sổ cái chỉ-ghi-thêm Migration của wallet-service, hàm prevent_ledger_mutation()
    Hold / Capture / Release services/wallet-service/src/services/wallet-hold.service.ts, wallet-hold.scheduler.ts
    Bút toán đối ứng moveMoneyTxInternal trong ledger.service.ts
    Race condition Kiểm tra wallet.balance.sub(wallet.heldBalance).lt(amount) bằng find thường trong hai file trên
    Đối soát reconciliation.service.ts (theo yêu cầu, chỉ báo cáo)
    Giả mạo header gateway/src/middlewares/authenticate.ts gán cờ tĩnh x-gateway-verified
    Rate limiter RAM gateway/src/middlewares/rateLimiter.ts
    Xác thực JWT kép services/user-service/src/middlewares/requireGateway.ts
    Idempotency toàn cục @unique của idempotencyKey trong services/payment-service/prisma/schema.prisma
    Nuốt lỗi khi đăng ký AuthService.signUp trong authService.ts
    Lệch enum thông báo PAYMENT_EXPIRED thiếu trong NotificationType của notification-service

Phụ lục A – Danh sách chỉnh sửa v1 → v2
Bảng 19. Chỉnh sửa chính

# Vị trí v1 Vấn đề Sửa trong v2

1 1.4 “Lũy quyền” sai thuật ngữ Đổi thành “lũy đẳng”
2 1.2 Gọi là “Two-Phase Authorization” dễ nhầm với 2PC Authorization–Capture, giải thích không phải 2PC
3 1.1 “Không câu lệnh SQL nào sửa được” quá tuyệt đối Thêm DB role không có quyền gỡ trigger
4 1.3 Nói FOR UPDATE chặn mọi đọc Chặn khóa/ghi, đọc thường không bị chặn
5 1.3 / 3 / 2.3 CHECK balance ≥ 0 mâu thuẫn với “tổng mong đợi = 0” (ví CLEARING phải âm) CHECK ngoại lệ cho ví SYSTEM
6 1.4 vs 3 @@unique và @unique lẫn lộn; thiếu lớp unique ở ví Hai lớp: userId+key và walletId+referenceId
7 1.6 / 3 transactionToken thiếu paymentId, amount; không nói chống dùng lại Gắn paymentId+amount+jti, lưu jti UNIQUE
8 1.7 Lẫn “Cấp”/“Level”; hạn mức như thật Thống nhất Cấp, ghi rõ giá trị minh họa; thêm lưu ý quy định cần kiểm chứng
9 3 (Đạt) Chỉ nói RS256, chưa nêu claims, TTL, header Claims, 60s, x-gateway-token, ES256/RS256
10 3 (Hữu) API secret mã hóa AES-256 (đọc lại được) Lưu hash, hiện một lần
11 3 (Hữu) “SHA-512” cho VNPAY HMAC-SHA512; IPN là GET; RspCode 00/02/97
12 2.3 W-01 QR hết hạn 54s trên mockup, 2 phút ở API Thống nhất 120s
13 2.3 W-02, Tuần 4 Đối soát “tự động”, “tự bù trừ” Theo yêu cầu, chỉ báo cáo, sửa bằng bút toán đảo
14 Mô tả Hold Thiếu điểm đến của Capture Thêm destinationOwner
15 Tuần 3 DoD “Ngân hàng thật/sandbox” Chỉ sandbox; cash-out là mô phỏng
16 Tuần 1–4 DoD định tính DoD đo được, có kịch bản A1–A9
17 Phần 3 mở đầu Nhắc “6 vấn đề” nhưng không liệt kê Bỏ; thay bằng nguyên tắc trục dọc
18 Toàn tài liệu Sơ đồ chỉ là ASCII; thiếu kiến trúc, ERD, tuần tự, trạng thái, Gantt, API, sự kiện, rủi ro, quy ước, dữ liệu mẫu Thêm các phần 0–1, 3, 4, 6, 8–11 và Phụ lục B

Phụ lục B – Dữ liệu mẫu để demo
Dữ liệu seed dùng cho demo và cho các test A1–A9 (giá trị minh họa).
Bảng 20. Tài khoản seed
Tài khoản Vai trò KYC Số dư ban đầu và ghi chú
an@demo.vn Người dùng Cấp 2 1.250.000đ – người chuyển tiền chính
binh@demo.vn Người dùng Cấp 1 300.000đ – người nhận
chi@demo.vn Người dùng Cấp 0 100.000đ – dùng test hạn mức A9
highlands@demo.vn Merchant – 0đ – 3 điểm bán, mỗi nơi có QR
admin@demo.vn ADMIN – Duyệt KYC, chạy đối soát

Bảng 21. Khối lượng seed
Dữ liệu Số lượng Mục đích
Giao dịch lịch sử 50 Màn lịch sử và sao kê có dữ liệu thật
Cửa hàng đối tác 10 Màn merchant, QR
Hồ sơ KYC chờ duyệt 5 Demo Admin duyệt
Lần nạp VNPAY thành công 3 Chứng minh luồng nạp
Giao dịch lỗi cố ý (ví lệch) 1 Demo đối soát A8

Bất thường mẫu của đối soát:
Bảng 22. Một dòng ReconciliationAnomaly
type walletId detail Cách xử lý
BALANCE_DRIFT_QUICK w_8f3a… balance lệch +50.000 so với tổng sổ cái Admin tạo bút toán điều chỉnh có lý do, ghi audit
