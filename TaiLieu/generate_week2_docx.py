# -*- coding: utf-8 -*-
import docx
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn

def set_cell_background(cell, fill_hex):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{fill_hex}"/>')
    tcPr.append(shd)

def set_cell_margins(cell, top=100, bottom=100, left=150, right=150):
    tcPr = cell._tc.get_or_add_tcPr()
    tcMar = parse_xml(f'''
        <w:tcMar {nsdecls("w")}>
            <w:top w:w="{top}" w:type="dxa"/>
            <w:bottom w:w="{bottom}" w:type="dxa"/>
            <w:left w:w="{left}" w:type="dxa"/>
            <w:right w:w="{right}" w:type="dxa"/>
        </w:tcMar>
    ''')
    tcPr.append(tcMar)

def set_table_borders(table, color="CBD5E1", sz="4", val="single"):
    tblPr = table._tbl.tblPr
    borders = parse_xml(f'''
        <w:tblBorders {nsdecls("w")}>
            <w:top w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>
            <w:bottom w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>
            <w:left w:val="none"/>
            <w:right w:val="none"/>
            <w:insideH w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>
            <w:insideV w:val="none"/>
        </w:tblBorders>
    ''')
    tblPr.append(borders)

def format_table(table, col_widths, headers, data, header_bg="1E3A8A"):
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(table)
    
    # Header Row
    hdr_cells = table.rows[0].cells
    for i, header_text in enumerate(headers):
        hdr_cells[i].text = header_text
        set_cell_background(hdr_cells[i], header_bg)
        set_cell_margins(hdr_cells[i], top=120, bottom=120, left=150, right=150)
        p = hdr_cells[i].paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        for run in p.runs:
            run.font.bold = True
            run.font.color.rgb = RGBColor(255, 255, 255)
            run.font.size = Pt(9.5)
            run.font.name = "Arial"

    # Data Rows
    for row_idx, row_data in enumerate(data):
        row_cells = table.add_row().cells
        bg_color = "F8FAFC" if row_idx % 2 == 1 else "FFFFFF"
        for col_idx, cell_value in enumerate(row_data):
            row_cells[col_idx].text = str(cell_value)
            set_cell_background(row_cells[col_idx], bg_color)
            set_cell_margins(row_cells[col_idx], top=100, bottom=100, left=150, right=150)
            p = row_cells[col_idx].paragraphs[0]
            # Alignment: column 0 or specific short columns centered
            if col_idx in [0, 3] and len(row_data) > 3 and len(str(cell_value)) <= 6:
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            else:
                p.alignment = WD_ALIGN_PARAGRAPH.LEFT
            for run in p.runs:
                run.font.size = Pt(9.5)
                run.font.name = "Arial"
                run.font.color.rgb = RGBColor(15, 23, 42)

    # Set column widths
    for row in table.rows:
        for idx, width in enumerate(col_widths):
            row.cells[idx].width = Inches(width)

def build_week2_document(output_path):
    doc = Document()
    
    # Set Margins (1 inch)
    sections = doc.sections
    for section in sections:
        section.top_margin = Inches(1.0)
        section.bottom_margin = Inches(1.0)
        section.left_margin = Inches(1.0)
        section.right_margin = Inches(1.0)

    # Title
    p_title = doc.add_paragraph()
    p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r_title = p_title.add_run("FINVAULT – KẾ HOẠCH CHI TIẾT TUẦN 2\n")
    r_title.font.name = "Arial"
    r_title.font.size = Pt(20)
    r_title.font.bold = True
    r_title.font.color.rgb = RGBColor(30, 58, 138) # Deep Navy

    r_sub = p_title.add_run("Xác thực cấp 2 (PIN) · Chuyển tiền P2P · Phân cấp KYC & Hạn mức · Thông báo Realtime")
    r_sub.font.name = "Arial"
    r_sub.font.size = Pt(11)
    r_sub.font.italic = True
    r_sub.font.color.rgb = RGBColor(100, 116, 139) # Slate

    doc.add_paragraph() # Spacing

    # Section: Overview Box
    tbl_overview = doc.add_table(rows=1, cols=4)
    format_table(
        tbl_overview,
        col_widths=[1.5, 2.0, 1.2, 1.8],
        headers=["Hạng mục", "Nội dung", "Thời gian", "Phạm vi chính"],
        data=[
            ["Sprint", "Sprint 2 (Ngày 6 – 10)", "5 ngày công", "4 thành viên (20 mandays)"],
            ["Đạt", "auth-service (PIN/Auth-Txn), Modal PIN, QR Login", "5.0 ngày", "Bảo mật danh tính & Xác thực cấp 2"],
            ["Khoa", "wallet-service (Limit Engine, Ví System), payment-service (P2P)", "5.0 ngày", "Lõi chuyển tiền & Hạn mức"],
            ["Hữu", "user-service (kycTier, MinIO CCCD), merchant-service (QR điểm bán)", "5.0 ngày", "KYC nâng cao & Mạng lưới Cửa hàng"],
            ["Nguyên", "notification-service (Socket.IO realtime, Device), Admin Portal", "5.0 ngày", "Hạ tầng sự kiện Realtime & Quản trị"]
        ],
        header_bg="1E40AF"
    )

    doc.add_paragraph()

    # Section 1: Mục tiêu và DoD Tuần 2
    h1 = doc.add_heading("1. Mục tiêu và Điều kiện Hoàn thành Tuần 2 (DoD)", level=1)
    h1.runs[0].font.name = "Arial"
    h1.runs[0].font.color.rgb = RGBColor(30, 58, 138)

    p_dod = doc.add_paragraph()
    bullets = [
        "Chuyển tiền P2P hoàn chỉnh: Yêu cầu mã PIN giao dịch 6 số; sai 5 lần khóa 30 phút; lần thứ 6 từ chối PIN_LOCKED.",
        "Token giao dịch an toàn (transactionToken): Cấp sau khi PIN đúng, có hiệu lực 60 giây, gắn userId + paymentId + amount + jti; chống dùng lại 100%.",
        "Bộ máy hạn mức (Limit Engine): Chuyển tiền vượt hạn mức Cấp 0 (200.000đ/lần, 500.000đ/ngày) bị từ chối LIMIT_EXCEEDED ngay tại bước Hold.",
        "Tách ví hệ thống (SYSTEM): Tách rõ ràng CLEARING_TOPUP, SETTLEMENT, FEE bằng systemCode; tổng số dư toàn hệ thống luôn cân bằng 0đ.",
        "Hồ sơ CCCD & Nâng cấp Tier: Người dùng upload ảnh CCCD lên MinIO private; Admin duyệt trên Web -> nâng kycTier và kích hoạt hạn mức mới.",
        "Thông báo Realtime siêu tốc: Bắn socket vào room user:<id> ngay khi biến động số dư, đảm bảo người nhận nhận được thông báo trong ≤ 3 giây.",
        "QR Điểm bán Merchant: Cửa hàng tạo được QR bàn/quầy; sinh MerchantApiKey (lưu hash an toàn, hiện 1 lần duy nhất)."
    ]
    for b in bullets:
        doc.add_paragraph(b, style="List Bullet")

    # Section 2: Quyết định kỹ thuật ngày đầu Tuần 2
    h2 = doc.add_heading("2. Ngày 1 – Cuộc họp chốt kỹ thuật đầu tuần (30 phút)", level=1)
    h2.runs[0].font.name = "Arial"
    h2.runs[0].font.color.rgb = RGBColor(30, 58, 138)

    tbl_decisions = doc.add_table(rows=1, cols=4)
    format_table(
        tbl_decisions,
        col_widths=[0.6, 2.4, 1.2, 2.3],
        headers=["#", "Vấn đề cần thống nhất", "Người quyết", "Sản phẩm đầu ra"],
        data=[
            ["M8", "Định dạng và thời gian sống của transactionToken (ES256, 60s, jti)", "Đạt + Khoa", "Mẫu Claims JWT trong README"],
            ["M9", "Bảng chính sách hạn mức LimitPolicy (ngưỡng Cấp 0, 1, 2 và múi giờ reset theo GMT+7)", "Khoa + Hữu", "Migration bảng LimitPolicy"],
            ["M10", "Payload sự kiện user.kyc_updated và format thông báo realtime", "Nguyên + Hữu", "Enum và Interface sự kiện chung"],
            ["M11", "Kịch bản giao diện chuyển P2P: Luồng mở Modal PIN -> gọi Confirm Payment", "Khoa + Đạt", "Component Modal PIN & Flow Web"]
        ],
        header_bg="334155"
    )

    doc.add_paragraph()

    # Section 3: Nhiệm vụ chi tiết từng thành viên
    h3 = doc.add_heading("3. Nhiệm vụ chi tiết theo thành viên", level=1)
    h3.runs[0].font.name = "Arial"
    h3.runs[0].font.color.rgb = RGBColor(30, 58, 138)

    # ĐẠT
    p_dat = doc.add_paragraph()
    r = p_dat.add_run("3.1. ĐẠT — Xác thực giao dịch (Auth-Txn), Mã PIN & Khung QR Login")
    r.bold = True
    r.font.size = Pt(12)
    r.font.color.rgb = RGBColor(29, 78, 216)

    tbl_dat = doc.add_table(rows=1, cols=4)
    format_table(
        tbl_dat,
        col_widths=[0.7, 2.8, 2.2, 0.8],
        headers=["Mã", "Nhiệm vụ & Vị trí code", "Xong khi (Tiêu chí kiểm thử)", "Ngày"],
        data=[
            ["Đ7", "Bảng UserPin & API PIN. auth-service: migration UserPin (pinHash bcrypt/argon2, failedAttempts, lockedUntil); API /api/auth-txn/pin/setup & verify.", "Nhập đúng -> thành công; sai 5 lần liên tiếp -> khóa 30 phút, lần 6 trả lỗi PIN_LOCKED.", "1.5"],
            ["Đ8", "Cấp transactionToken. verify PIN thành công cấp JWT 60s (ký ES256) chứa claims: sub, paymentId, amount, jti. Payment kiểm tra jti chống dùng lại.", "Token dùng lại lần 2 bị từ chối; sửa paymentId/amount trong request bị từ chối 403.", "1.0"],
            ["Đ9", "Transactional Outbox cho signUp. Chuyển authService.signUp sang ghi bảng Outbox sự kiện user.registered, worker publish RabbitMQ (bỏ gọi HTTP).", "Đăng ký tài khoản mới tự động sinh 1 dòng Outbox; message đẩy sang RabbitMQ cho user/wallet.", "1.0"],
            ["Đ10", "Modal PIN trên Frontend. Component 6 ô số tự nhảy focus, che ký tự bullet, đếm số lần sai và đồng hồ đếm ngược 30 phút khi bị khóa.", "Nhập đủ 6 số tự gọi verify, nhận transactionToken và gọi tiếp confirm payment.", "1.0"],
            ["Đ11", "Khởi tạo QR Login. Endpoint /api/auth/qr-login/init sinh mã nonce lưu Redis TTL 120s; Web hiển thị mã QR có đồng hồ đếm ngược.", "Web lấy được mã QR, đếm lùi 120s và cho phép refresh mã mới.", "0.5"]
        ],
        header_bg="1E40AF"
    )

    doc.add_paragraph()

    # KHOA
    p_khoa = doc.add_paragraph()
    r = p_khoa.add_run("3.2. KHOA — Lõi ví chuyển tiền P2P, Bộ máy hạn mức & Ví SYSTEM")
    r.bold = True
    r.font.size = Pt(12)
    r.font.color.rgb = RGBColor(29, 78, 216)

    tbl_khoa = doc.add_table(rows=1, cols=4)
    format_table(
        tbl_khoa,
        col_widths=[0.7, 2.8, 2.2, 0.8],
        headers=["Mã", "Nhiệm vụ & Vị trí code", "Xong khi (Tiêu chí kiểm thử)", "Ngày"],
        data=[
            ["K7", "Tách các ví SYSTEM. wallet-service: Thêm systemCode (CLEARING_TOPUP, SETTLEMENT, FEE); migration cập nhật dữ liệu ví cũ an toàn.", "Ví nạp và ví thanh toán phân tách rõ ràng; tổng số dư toàn hệ thống (kể cả SYSTEM) luôn bằng 0.", "1.0"],
            ["K8", "Bộ máy hạn mức (Limit Engine). Bảng LimitPolicy và UserDailyUsage; kiểm tra hạn mức theo kycTier nguyên tử ngay lúc Hold ví (giờ VN).", "Tài khoản Cấp 0 chuyển > 200.000đ/lần hoặc > 500.000đ/ngày bị từ chối LIMIT_EXCEEDED.", "1.5"],
            ["K9", "Hoàn thiện P2P Checkout & Confirm. payment-service: checkout tạo Hold -> confirm yêu cầu transactionToken hợp lệ -> Capture chuyển tiền.", "Chuyển tiền A -> B thành công khi có token; thiếu/sai token thì tiền trong ví A được Release.", "1.0"],
            ["K10", "Giao diện Chuyển tiền P2P Web. Màn hình chọn ví nhận (tìm theo email/SĐT), nhập số tiền, xem trước phí và kích hoạt Modal PIN.", "Thực hiện trọn vẹn luồng chuyển tiền trên giao diện, cập nhật số dư tức thì.", "1.0"],
            ["K11", "Outbox cho Saga hoàn tiền & Auto-Release. Job tự động quét các giao dịch PENDING quá hạn (hold TTL 5 phút) để Release ví nguồn.", "Giao dịch bị bỏ quên 5 phút tự động nhả heldBalance về số dư khả dụng.", "0.5"]
        ],
        header_bg="0D9488" # Teal
    )

    doc.add_paragraph()

    # HỮU
    p_huu = doc.add_paragraph()
    r = p_huu.add_run("3.3. HỮU — Quản lý KYC Tier, Upload CCCD MinIO & QR Cửa hàng Merchant")
    r.bold = True
    r.font.size = Pt(12)
    r.font.color.rgb = RGBColor(29, 78, 216)

    tbl_huu = doc.add_table(rows=1, cols=4)
    format_table(
        tbl_huu,
        col_widths=[0.7, 2.8, 2.2, 0.8],
        headers=["Mã", "Nhiệm vụ & Vị trí code", "Xong khi (Tiêu chí kiểm thử)", "Ngày"],
        data=[
            ["H7", "Cập nhật Tier & phát Outbox. user-service: Hoàn thiện API nâng kycTier (0 -> 1 -> 2) khi duyệt; phát sự kiện user.kyc_updated qua Outbox.", "Admin duyệt -> phát sự kiện -> Wallet cập nhật hạn mức mới ngay lập tức.", "1.0"],
            ["H8", "Luồng nộp CCCD lên MinIO. Upload 2 mặt CCCD, validate file ảnh (JPEG/PNG <= 5MB); sinh presigned GET URL có hạn (15 phút) cho Admin xem.", "URL công khai không xem được; URL có chữ ký hết hạn sau 15 phút trả 403.", "1.5"],
            ["H9", "QR Điểm bán & MerchantApiKey. merchant-service: API tạo điểm bán, mã QR quầy thu ngân; sinh API Key (chỉ lưu hash, hiện secret 1 lần duy nhất).", "Merchant lấy được mã QR quầy; mất secret phải sinh mới, không đọc lại được.", "1.0"],
            ["H10", "Web Merchant Portal. Giao diện Cổng cửa hàng: Thống kê doanh thu, danh sách đơn nhận tiền realtime, tải ảnh QR để in tại quầy.", "Cửa hàng xem được đơn thanh toán thành công và tải file mã QR tiêu chuẩn.", "1.5"]
        ],
        header_bg="D97706" # Amber
    )

    doc.add_paragraph()

    # NGUYÊN
    p_nguyen = doc.add_paragraph()
    r = p_nguyen.add_run("3.4. NGUYÊN — Thông báo Realtime Socket.IO, Quản lý thiết bị & Admin Portal")
    r.bold = True
    r.font.size = Pt(12)
    r.font.color.rgb = RGBColor(29, 78, 216)

    tbl_nguyen = doc.add_table(rows=1, cols=4)
    format_table(
        tbl_nguyen,
        col_widths=[0.7, 2.8, 2.2, 0.8],
        headers=["Mã", "Nhiệm vụ & Vị trí code", "Xong khi (Tiêu chí kiểm thử)", "Ngày"],
        data=[
            ["N7", "Quản lý thiết bị (UserDevice). notification-service: Bảng UserDevice lưu token thiết bị, trạng thái kết nối và thời điểm online.", "Đăng nhập trên thiết bị mới ghi nhận đúng Device; đăng xuất thu hồi kết nối.", "1.0"],
            ["N8", "Realtime Notification Engine. Bắn Socket.IO vào room user:<id> khi nhận sự kiện từ RabbitMQ; cam kết độ trễ <= 3 giây.", "Bắn tiền xong, phía người nhận nhảy popup thông báo và âm thanh trong 3 giây.", "1.5"],
            ["N9", "Admin Duyệt KYC trên Web. Màn hình W-03: Xem danh sách chờ duyệt, zoom ảnh CCCD 2 mặt, nút Duyệt / Từ chối (nhập lý do).", "Admin bấm Duyệt -> gọi API đổi trạng thái và ghi nhận AdminAuditLog.", "1.5"],
            ["N10", "Chuông thông báo & Unread Badge. Component chuông trên Header Web: Hiện số thông báo chưa đọc, dropdown xem nhanh, nút 'Đọc tất cả'.", "Bấm 'Đọc tất cả' gọi /api/notifications/me/read-all, badge về 0 tức thì.", "1.0"]
        ],
        header_bg="7C3AED" # Purple
    )

    doc.add_paragraph()

    # Section 4: Lịch làm việc 5 ngày
    h4 = doc.add_heading("4. Lịch trình 5 ngày làm việc (Ngày 6 – 10)", level=1)
    h4.runs[0].font.name = "Arial"
    h4.runs[0].font.color.rgb = RGBColor(30, 58, 138)

    tbl_schedule = doc.add_table(rows=1, cols=5)
    format_table(
        tbl_schedule,
        col_widths=[0.8, 1.4, 1.4, 1.4, 1.5],
        headers=["Ngày", "Đạt", "Khoa", "Hữu", "Nguyên"],
        data=[
            ["Ngày 1 (N6)", "Họp M8-M11; Đ7 (UserPin DB/API)", "Họp; K7 (Ví SYSTEM)", "Họp; H7 (Outbox kyc_updated)", "Họp; N7 (UserDevice)"],
            ["Ngày 2 (N7)", "Đ7 xong; Đ8 (transactionToken)", "K8 (Limit Engine DB & Rule)", "H8 (Upload CCCD MinIO)", "N8 (Realtime Socket.IO)"],
            ["Ngày 3 (N8)", "Đ8 xong; Bàn giao token; Đ9", "K8 xong; K9 (P2P Checkout/PIN)", "H8 xong; presigned URL", "N8 xong; N10 (Chuông/Badge)"],
            ["Ngày 4 (N9)", "Đ10 (Modal PIN FE); Đ11 (QR init)", "K9 xong; K10 (Màn P2P FE)", "H9 (QR Merchant); H10", "N9 (Admin Duyệt KYC FE)"],
            ["Ngày 5 (N10)", "Tích hợp Modal PIN & Test A3/A4", "K11; Tích hợp luồng P2P; Test A9", "H10 xong; Demo QR Merchant", "N9 xong; Demo Duyệt KYC & Socket"]
        ],
        header_bg="1E3A8A"
    )

    doc.add_paragraph()

    # Section 5: Điểm bàn giao giữa tuần
    h5 = doc.add_heading("5. Điểm bàn giao & Ràng buộc chéo giữa các thành viên", level=1)
    h5.runs[0].font.name = "Arial"
    h5.runs[0].font.color.rgb = RGBColor(30, 58, 138)

    tbl_handoff = doc.add_table(rows=1, cols=4)
    format_table(
        tbl_handoff,
        col_widths=[1.2, 1.8, 1.5, 2.0],
        headers=["Thời hạn", "Nội dung bàn giao", "Từ -> Tới", "Xử lý nếu trễ"],
        data=[
            ["Cuối Ngày 2", "Chữ ký transactionToken & API verify PIN", "Đạt -> Khoa", "Khoa dùng token test cố định để code trước phần Confirm"],
            ["Cuối Ngày 3", "Bộ máy hạn mức (Limit Engine) xong", "Khoa -> Hữu, Nguyên", "Hữu test nâng tier trước trên DB bằng script SQL tay"],
            ["Giữa Ngày 4", "Modal PIN & Màn hình P2P ghép nối", "Đạt <-> Khoa", "Ghép API trước bằng Postman/Curl"],
            ["Cuối Ngày 4", "Upload ảnh CCCD & API Duyệt KYC", "Hữu -> Nguyên", "Nguyên dùng ảnh mẫu tĩnh trên giao diện Admin"],
            ["Chiều Ngày 5", "Diễn tập Demo Tuần 2 toàn bộ kịch bản", "Cả nhóm (Đạt chủ trì)", "Ghi nhận lỗi, fix khẩn cấp trước giờ nộp"]
        ],
        header_bg="475569"
    )

    doc.add_paragraph()

    # Section 6: Kịch bản nghiệm thu cuối tuần (DoD Tuần 2)
    h6 = doc.add_heading("6. Kịch bản kiểm thử nghiệm thu cuối Tuần 2 (DoD)", level=1)
    h6.runs[0].font.name = "Arial"
    h6.runs[0].font.color.rgb = RGBColor(30, 58, 138)

    tbl_tests = doc.add_table(rows=1, cols=4)
    format_table(
        tbl_tests,
        col_widths=[0.6, 1.8, 2.1, 2.0],
        headers=["Mã", "Kịch bản kiểm thử", "Các bước thực hiện", "Kết quả mong đợi (Pass khi)"],
        data=[
            ["A3", "Khóa mã PIN khi nhập sai", "Cố tình nhập sai mã PIN 5 lần liên tiếp trên Modal PIN.", "Bị khóa 30 phút; lần thứ 6 gửi lên bị từ chối với mã lỗi PIN_LOCKED."],
            ["A4", "transactionToken chống dùng lại", "Lấy 1 transactionToken hợp lệ rồi gọi Confirm 2 lần, hoặc đợi 65 giây mới gọi.", "Lần 1 thành công; lần 2 bị từ chối 409; token hết hạn bị từ chối 401."],
            ["A9", "Chặn vượt hạn mức theo Cấp KYC", "Dùng tài khoản Cấp 0 chuyển 600.000đ trong ngày (vượt trần 500.000đ/ngày).", "Hệ thống từ chối ngay tại bước Hold với mã lỗi LIMIT_EXCEEDED."],
            ["R1", "Thông báo Realtime siêu tốc", "Tài khoản A chuyển 50.000đ cho B. Quan sát màn hình điện thoại/web của B.", "Máy B nhận popup thông báo và ting ting âm thanh trong vòng <= 3 giây."],
            ["K1", "Duyệt CCCD & Nâng cấp Hạn mức", "User nộp ảnh CCCD -> Admin mở Web zoom ảnh và bấm Duyệt -> User thử chuyển 1.000.000đ.", "Duyệt thành công, tier lên Cấp 1, chuyển 1 triệu thành công không bị chặn."]
        ],
        header_bg="047857" # Green
    )

    doc.add_paragraph()

    # Section 7: Nghi thức & Quy định làm việc
    h7 = doc.add_heading("7. Nghi thức & Kỷ luật phối hợp", level=1)
    h7.runs[0].font.name = "Arial"
    h7.runs[0].font.color.rgb = RGBColor(30, 58, 138)

    p_rules = doc.add_paragraph()
    rules = [
        "Họp đứng (Daily Standup): 10 phút đầu mỗi buổi sáng: (1) Hôm qua xong gì? (2) Hôm nay làm gì? (3) Đang bị ai chặn?",
        "Review chéo Pull Request (Cross-PR Review): Mọi commit vào nhánh chính phải tạo PR và được thành viên trục đối ứng approve (Đạt <-> Khoa, Hữu <-> Nguyên) trong 24 giờ.",
        "Quy chuẩn commit Git: type(scope): mô tả ngắn (Ví dụ: feat(auth): add UserPin and verify PIN endpoint).",
        "Tự động chạy setup sau khi pull: Sau mỗi lần git pull, phải click chạy file setup.bat để đồng bộ môi trường và Prisma Client."
    ]
    for r in rules:
        doc.add_paragraph(r, style="List Bullet")

    doc.save(output_path)
    print(f"Successfully generated: {output_path}")

if __name__ == "__main__":
    out_file = r"D:\PTPMHDV\Backend\TaiLieu\FinVault_Ke_Hoach_Tuan_2.docx"
    build_week2_document(out_file)
