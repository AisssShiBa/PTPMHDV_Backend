# Tích hợp Gateway Token và hoàn thiện runtime User/Merchant

Gateway đã chuyển sang `x-gateway-token`, nhưng User/Merchant vẫn yêu cầu marker cũ nên request hợp lệ bị 403. Hai service nay xác thực bằng package chung và lấy owner/role từ `req.auth`; Auth provision và Admin review tiếp tục dùng internal credential đã xác thực. Gateway loại bỏ internal key do client gửi; Admin xác minh token mới và Auth bỏ yêu cầu marker trên các endpoint đăng nhập công khai.

Package xuất JavaScript cho runtime Docker và kiểm tra key/claims/TTL. Compose bổ sung migration job, consumer/publisher, private storage và endpoint ký URL đọc được từ trình duyệt. DTO/OpenAPI phản ánh auth mới. Hạ tầng nghiệm thu dùng project/database riêng.

Validation: package 3, User unit/API/contract 27 + integration 26, Merchant unit/API 17 + integration 12 đều pass; hai service typecheck/build pass; smoke production images và 17 nhóm browser acceptance pass. Chi tiết ở `docs/User_Merchant_Completion_Report.md`.

Giới hạn: full frontend build còn lỗi TS6133 có sẵn tại AdminTopups; browser chạy bundle Vite từ source hiện tại. User publisher và UI/API nâng tier ngoài phạm vi. Cần key/credential và consumer binding thật khi triển khai.

Lưu ý khi tạo PR: worktree đã có các thay đổi H2–H6 và Auth/signup trước lượt này; phân nhóm diff theo baseline trước khi commit. Đây là mô tả chuẩn bị review, chưa phải PR đã được tạo hoặc phê duyệt.
