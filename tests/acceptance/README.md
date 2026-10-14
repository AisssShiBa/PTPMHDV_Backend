# Nghiệm thu User / KYC / Merchant với backend thật

Bộ kiểm tra chạy production frontend qua Gateway → Auth/User/Merchant/Admin/Wallet → PostgreSQL và MinIO. Không giả lập response API hoặc persistence. Admin duyệt bằng API thật; giao diện Admin nằm ngoài phạm vi này.

## Chuẩn bị

- Cài/build package chung trước: `rtk npm ci --prefix packages/finvault-internal-auth` từ root backend. User/Merchant/Admin phụ thuộc package local này.

- Node 24, Docker Desktop đang chạy, Chrome hoặc Edge; đặt `BROWSER_PATH` nếu executable không ở đường dẫn mặc định Windows.
- Cài dependencies bằng `rtk npm ci` tại frontend, gateway và từng service: user, merchant, auth, admin, wallet.
- Tại frontend chạy `rtk npm run build`, dùng base URL production `/api` (không đặt `VITE_API_BASE_URL` khác cho bản build nghiệm thu).
- Cổng cần trống: 3000–3004, 3007, 5173, 25433, 19001. Script từ chối thay thế service đang chiếm cổng.
- MinIO dùng image sẵn của bộ integration User Service. Nếu chưa có, tại backend chạy `rtk proxy docker compose -f services/user-service/tests/compose.yml build minio`.

## Chạy từ thư mục backend

```powershell
rtk proxy node tests/acceptance/prepare.mjs
rtk proxy docker compose -f tests/acceptance/compose.yml --env-file .cache/acceptance/infra.env up -d --wait
rtk proxy node tests/acceptance/migrate.mjs
rtk proxy node tests/acceptance/start.mjs
```

Mở terminal riêng để phục vụ frontend và proxy `/api` đến Gateway thật:

```powershell
rtk proxy node tests/acceptance/frontend.mjs
```

Sau đó tại terminal backend:

```powershell
rtk proxy node tests/acceptance/seed.mjs
rtk proxy node tests/acceptance/run.mjs
```

Mỗi lần chạy lại phải chạy `seed.mjs` trước để tạo tài khoản mới. Admin/outsider đăng ký qua Gateway; chỉ tài khoản Admin thử nghiệm mới tạo được nâng role trực tiếp trong database cô lập. Tài khoản người dùng chính đăng ký qua UI. Ảnh KYC là ảnh tổng hợp ghi rõ mục đích thử nghiệm, không phải giấy tờ cá nhân thật.

17 nhóm kiểm tra bao gồm signup/provisioning, login/refresh/logout, Profile, validation/upload KYC, signed URL riêng tư và hết hạn, Admin reject/resubmit/approve, Merchant đăng ký/trùng/trạng thái, quyền sở hữu, offline/retry, mobile, trình duyệt độc lập, truy vấn DB và runtime exception. Một request được thay access token bằng JWT đã hết hạn để buộc backend trả 401 thật; không thay response.

## Kết quả và môi trường

Lượt kiểm chứng 11/10/2026: **17/17 nhóm pass** qua Gateway/Auth/User/Merchant/Admin thật, PostgreSQL và private MinIO. `prepare.mjs` tạo key ES256 riêng cho acceptance; User/Merchant không dùng access-token secret. Chi tiết tại `docs/User_Merchant_Completion_Report.md`.

Giới hạn build frontend trong lượt này: `npm run build` dừng bởi TS6133 ở `src/pages/admin/AdminTopups.tsx` (`actionLoading`, `handleApprove`, `handleReject`). Bundle dùng kiểm thử được tạo bằng `rtk npx vite build` từ source hiện tại; browser pass không đồng nghĩa typecheck frontend đã pass. Không sửa source frontend trong công việc backend này.

- UI: `http://localhost:5173`; Gateway: `http://localhost:3000`.
- `.cache/acceptance/live-result.json`: kết quả, request/status và đối chiếu database; không chứa mật khẩu, cookie, token hoặc query chữ ký ảnh.
- `.cache/acceptance/live-*.png`: ảnh chụp các trạng thái thật.
- `.cache/acceptance/accounts.json`: thông tin đăng nhập tài khoản demo sinh tự động; giữ cục bộ, không commit.
- `.cache/acceptance/config.json` và `infra.env`: secret ngẫu nhiên cho môi trường cô lập; không sửa `.env` dự án.
- `.cache/acceptance/processes.json` và từng `<service>.log`: PID/log service do script khởi chạy. Dừng frontend bằng Ctrl+C; kiểm tra PID service còn đúng tiến trình trước khi dừng. Script không tự dừng các service sau test để có thể xem lại UI.
- Dừng hạ tầng bằng `rtk proxy docker compose -f tests/acceptance/compose.yml --env-file .cache/acceptance/infra.env stop`. Volume được giữ để xem lại dữ liệu. Không xóa file cấu hình secret nếu vẫn dùng các volume này.

`migrate.mjs` mặc định generate Prisma rồi migrate deploy trước khi khởi động service. Nếu chỉ cần deploy SQL khi service đang chạy, dùng `rtk proxy node tests/acceptance/migrate.mjs admin --deploy-only` để không ghi đè Prisma DLL đang được sử dụng.

## Migration Admin cần triển khai kèm

Lần nghiệm thu 26/09/2026 phát hiện schema Admin có model `AdminAuditLog` nhưng chưa có migration tạo bảng. API review vẫn đổi trạng thái khi ghi audit bị lỗi. Migration `202609260002_init_admin_audit` bổ sung bảng và hai index đúng schema; sau deploy đã xác minh trực tiếp đủ audit action.

Database mới dùng `prisma migrate deploy` bình thường. Với môi trường đã từng dùng `prisma db push` tạo sẵn bảng này, cần kiểm tra cấu trúc bảng/index và baseline migration theo quy trình của dự án trước khi deploy; không chạy lại CREATE TABLE lên bảng có sẵn. Bộ nghiệm thu chỉ migrate database `finvault_acceptance` trên cổng 25433.

Phạm vi kết quả là môi trường local có backend/database/storage thật. Không bao gồm production, giao diện Admin, Payment hoặc các RabbitMQ worker.
