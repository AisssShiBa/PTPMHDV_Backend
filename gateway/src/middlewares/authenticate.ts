// D:\PTPMHDV\Backend\gateway\src\middlewares\authenticate.ts
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../config/services'
import { fail } from '../utils/response'
import { signGatewayToken } from '../utils/gatewayToken'

/* ==========================================================================
   1. ĐỊNH NGHĨA KIỂU DỮ LIỆU (INTERFACE)
   Mô tả cấu trúc payload của Access Token do Client gửi lên.
   Theo quyết định M17: Bỏ claim kycTier khỏi Gateway token.
   ========================================================================== */
interface ClientJwtPayload {
    userId: string
    role: string
}

interface PublicRoute {
    method: string
    path: RegExp | string
}

/* ==========================================================================
   2. DANH SÁCH ROUTE CÔNG KHAI (PUBLIC ROUTES) - NHIỆM VỤ Đ16
   Thu hẹp Whitelist:
   - LOẠI BỎ hoàn toàn whitelist cả nhánh /api/funding.* (chống lỗ hổng lộ lọt /api/funding/cash-out)
   - CHỈ giữ lại đúng các webhook/return IPN thực tế của VNPAY và QR Login/Auth công khai
   ========================================================================== */
const PUBLIC_ROUTES: PublicRoute[] = [
    { method: 'POST', path: '/api/auth/signup' },
    { method: 'POST', path: '/api/auth/signin' },
    { method: 'POST', path: '/api/auth/refresh' },
    { method: 'POST', path: '/api/auth/signout' },
    // Route khởi tạo và polling kiểm tra trạng thái QR Login (Web chưa đăng nhập)
    { method: 'POST', path: '/api/auth/qr-login/init' },
    { method: 'GET', path: /^\/api\/auth\/qr-login\/[a-zA-Z0-9_-]+\/status$/ },
    { method: '*', path: '/health' },
    // Thu hẹp Whitelist: Chỉ mở công khai đúng IPN / Return URL của cổng thanh toán VNPAY
    { method: '*', path: /^\/api\/payments\/topups\/vnpay\/.*/ },
    { method: '*', path: /^\/api\/funding\/vnpay\/.*/ },
    { method: '*', path: /^\/socket\.io(\/.*)?$/ },    // Whitelist WebSocket handshake (notification-service tự xác thực)
]

/* ==========================================================================
   3. HÀM KIỂM TRA ROUTE CÔNG KHAI (HELPER)
   ========================================================================== */
const isPublicRoute = (req: Request): boolean => {
    const currentPath = (req.path.replace(/\/+$/, '') || '/').toLowerCase()
    const currentMethod = req.method.toUpperCase()

    return PUBLIC_ROUTES.some(route => {
        const methodMatch = route.method.toUpperCase() === currentMethod || route.method === '*'
        if (!methodMatch) return false

        if (route.path instanceof RegExp) {
            return route.path.test(req.path) || route.path.test(currentPath)
        }

        const routePath = (route.path.replace(/\/+$/, '') || '/').toLowerCase()
        return currentPath === routePath
    })
}

/* ==========================================================================
   4. MIDDLEWARE XÁC THỰC & ĐÓNG DẤU GATEWAY TOKEN (NHIỆM VỤ Đ1 & Đ16)
   Cơ chế:
   - Cho qua nếu là route công khai hợp lệ.
   - Kiểm tra Access Token của người dùng (Bearer JWT).
   - Ký số Gateway Token mới (ES256, TTL 60s) chứa danh tính sub, role (Bỏ claim kycTier theo M17).
   - Gắn Gateway Token vào header 'x-gateway-token' trước khi chuyển tiếp.
   ========================================================================== */
export const authenticate = (req: Request, res: Response, next: NextFunction): void | Response => {
    // 1. Nếu là Route công khai thì cho qua trực tiếp
    if (isPublicRoute(req)) {
        return next()
    }

    // 2. Bắt buộc phải có Authorization Header dạng "Bearer <token>"
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return fail(res, 401, 'UNAUTHORIZED', 'Bạn cần đăng nhập để truy cập tài nguyên này')
    }

    const token = authHeader.substring(7)

    try {
        // 3. Giải mã và xác thực chữ ký của Client Access Token
        const decoded = jwt.verify(token, env.accessTokenSecret) as ClientJwtPayload

        // 4. KÝ GATEWAY TOKEN BẰNG THUẬT TOÁN ES256 (Khóa riêng của Gateway)
        // Quyết định M17: Nguồn sự thật duy nhất của kycTier là Wallet.kycTier.
        // Bỏ claim kycTier khỏi Gateway token để tránh hiểu nhầm và tránh lệch đồng bộ.
        const gatewayToken = signGatewayToken(
            decoded.userId,
            decoded.role
        )

        // 5. Gắn Gateway Token mật mã vào header để proxy chuyển tiếp cho các service con
        req.headers['x-gateway-token'] = gatewayToken
        req.headers['x-user-id'] = decoded.userId
        req.headers['x-user-role'] = decoded.role

        return next()
    } catch (error) {
        return fail(res, 401, 'INVALID_TOKEN', 'Token không hợp lệ hoặc đã hết hạn')
    }
}
