// D:\PTPMHDV\Backend\gateway\src\middlewares\authenticate.ts
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../config/services'
import { fail } from '../utils/response'
import { signGatewayToken } from '../utils/gatewayToken'

/* ==========================================================================
   1. ĐỊNH NGHĨA KIỂU DỮ LIỆU (INTERFACE)
   Mô tả cấu trúc payload của Access Token do Client gửi lên.
   ========================================================================== */
interface ClientJwtPayload {
    userId: string
    role: string
    kycTier?: number
}

interface PublicRoute {
    method: string
    path: RegExp | string
}

/* ==========================================================================
   2. DANH SÁCH ROUTE CÔNG KHAI (PUBLIC ROUTES)
   Các endpoint này không yêu cầu Client phải gửi Bearer Token.
   ========================================================================== */
const PUBLIC_ROUTES: PublicRoute[] = [
    { method: 'POST', path: '/api/auth/signup' },
    { method: 'POST', path: '/api/auth/signin' },
    { method: 'POST', path: '/api/auth/refresh' },
    { method: 'POST', path: '/api/auth/signout' },
    { method: '*', path: '/health' },
    { method: 'GET', path: /^\/api\/payments\/topups\/vnpay\/.*/ },
    { method: 'GET', path: /^\/api\/funding\/vnpay\/.*/ }, // Whitelist webhook/IPN VNPAY
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
   4. MIDDLEWARE XÁC THỰC & ĐÓNG DẤU GATEWAY TOKEN (NHIỆM VỤ Đ1)
   Cơ chế:
   - Cho qua nếu là route công khai.
   - Kiểm tra Access Token của người dùng (Bearer JWT).
   - Ký số Gateway Token mới (ES256, TTL 60s) chứa danh tính & quyền hạn.
   - Gắn Gateway Token vào header 'x-gateway-token' trước khi chuyển tiếp.
   ========================================================================== */
export const authenticate = (req: Request, res: Response, next: NextFunction): void | Response => {
    // 1. Nếu là Route công khai thì cho qua trực tiếp, KHÔNG gắn cờ tĩnh giả
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
        // Token này có TTL 60s, định danh chính xác sub, role, kycTier và mã jti ngẫu nhiên
        const gatewayToken = signGatewayToken(
            decoded.userId,
            decoded.role,
            decoded.kycTier ?? 0
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
