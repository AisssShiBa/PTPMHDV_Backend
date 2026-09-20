// D:\PTPMHDV\Backend\gateway\src\middlewares\authenticate.ts
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { fail } from '../utils/response'
import { env } from '../config/services'

interface JwtPayload {
    userId: string
    role: string
}

// Danh sách các API công khai không cần đăng nhập (khớp Method + Path)
const PUBLIC_ROUTES: Array<{ method: string; path: RegExp | string }> = [
    { method: 'POST', path: '/api/auth/signup' },
    { method: 'POST', path: '/api/auth/signin' },
    { method: 'POST', path: '/api/auth/refresh' },
    { method: 'POST', path: '/api/auth/signout' }
]

const isPublicRoute = (req: Request): boolean => {
    // Chuẩn hóa path: loại bỏ dấu gạch chéo ở đuôi (ví dụ /api/auth/signin/ -> /api/auth/signin)
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

export const authenticate = (req: Request, res: Response, next: NextFunction) => {
    // 1. Cho qua nếu là route công khai và đóng dấu đã qua Gateway
    if (isPublicRoute(req)) {
        req.headers['x-gateway-verified'] = 'true'
        return next()
    }

    // 2. Kiểm tra định dạng Authorization Header: "Bearer <token>"
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return fail(res, 401, 'UNAUTHORIZED', 'Bạn cần đăng nhập để truy cập tài nguyên này')
    }

    const token = authHeader.substring(7)

    try {
        // 3. Giải mã và kiểm tra chữ ký số của Token
        const decoded = jwt.verify(token, env.accessTokenSecret) as JwtPayload

        // 4. Đóng dấu danh tính vào headers để service phía sau sử dụng
        req.headers['x-user-id'] = decoded.userId
        req.headers['x-user-role'] = decoded.role
        req.headers['x-gateway-verified'] = 'true'

        next()
    } catch (error) {
        return fail(res, 401, 'INVALID_TOKEN', 'Token không hợp lệ hoặc đã hết hạn')
    }
}
