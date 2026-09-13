import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { fail } from '../utils/response'

interface JwtPayload {
    userId: string
    role: string
}

// Cấu hình rõ ràng: Method + Đường dẫn nào là PUBLIC
const PUBLIC_ROUTES: Array<{ method: string; path: RegExp | string }> = [
    { method: 'POST', path: '/api/auth/signup' },
    { method: 'POST', path: '/api/auth/signin' },
    { method: 'POST', path: '/api/auth/refresh' },
    { method: 'POST', path: '/api/auth/signout' },
    { method: 'GET', path: '/health' },
]

const isPublicRoute = (req: Request): boolean => {
    const currentPath = req.path.toLowerCase()
    const currentMethod = req.method.toUpperCase()

    return PUBLIC_ROUTES.some(route => {
        const methodMatch = route.method.toUpperCase() === currentMethod || route.method === '*'
        const pathMatch = typeof route.path === 'string'
            ? currentPath === route.path.toLowerCase()
            : route.path.test(req.path)
        return methodMatch && pathMatch
    })
}

export const authenticate = (req: Request, res: Response, next: NextFunction) => {
    // 1. Cho qua nếu là route public
    if (isPublicRoute(req)) {
        return next()
    }

    // 2. Kiểm tra Bearer Token
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return fail(res, 401, 'UNAUTHORIZED', 'Bạn cần đăng nhập để truy cập tài nguyên này')
    }

    const token = authHeader.substring(7) // Lấy phần chuỗi sau 'Bearer '

    try {
        const secret = process.env.ACCESS_TOKEN_SECRET
        if (!secret) {
            throw new Error('Chưa cấu hình ACCESS_TOKEN_SECRET trên Gateway')
        }

        const decoded = jwt.verify(token, secret) as JwtPayload

        // 3. Inject thông tin đã xác thực vào headers để chuyển tiếp cho downstream service
        req.headers['x-user-id'] = decoded.userId
        req.headers['x-user-role'] = decoded.role
        req.headers['x-gateway-verified'] = 'true'

        next()
    } catch (error) {
        return fail(res, 401, 'INVALID_TOKEN', 'Token không hợp lệ hoặc đã hết hạn')
    }
}
