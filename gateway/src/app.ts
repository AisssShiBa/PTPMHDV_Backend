// D:\PTPMHDV\Backend\gateway\src\app.ts
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { env } from './config/services'
import { sanitizeHeaders } from './middlewares/sanitizeHeaders'
import { attachRequestId } from './middlewares/requestId'
import { authenticate } from './middlewares/authenticate'
import { requireRole } from './middlewares/requireRole'
import { errorHandler } from './middlewares/errorHandler'

const app = express()

// 1. Bảo mật Header HTTP & Ghi nhật ký Log
app.use(helmet()) //giúp hạn chế một số kiểu tấn công liên quan đến browser/security headers
app.use(morgan('[:date[iso]] :method :url :status :response-time ms - ReqId: :req[x-request-id]'))

// 2. Cấu hình CORS
const allowedOrigins = [env.clientUrl, 'http://localhost:5173', 'http://localhost:5174'].filter(Boolean)
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || /^http:\/\/localhost:\d+$/.test(origin)) {
            return callback(null, true)
        }
        return callback(new Error('Chặn bởi chính sách CORS'))
    },
    credentials: true,
}))

// 3. Endpoint kiểm tra sức khỏe Gateway (Công khai, không yêu cầu Token)
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'api-gateway' }))

// 4. Chuỗi Middleware cốt lõi (Thứ tự: Sanitize -> RequestId -> Auth)
app.use(sanitizeHeaders)
app.use(attachRequestId)
app.use(authenticate)

// 5. Phân quyền tầng Route (Chặn trước khi request chạm vào proxy)
app.use('/api/admin', requireRole('ADMIN'))

// Helper tạo Proxy Middleware chuẩn (Giữ nguyên path, có timeout 10s và error handler)
const createServiceProxy = (pathFilter: string, target: string) => {
    return createProxyMiddleware({
        target,
        pathFilter,
        changeOrigin: true,
        timeout: 10000,      // Timeout kết nối tới service (10s)
        proxyTimeout: 10000, // Timeout chờ service con xử lý xong (10s)
        on: {
            proxyReq: (proxyReq, req) => {
                // Đảm bảo các header do Gateway đóng dấu được chuyển tiếp đầy đủ
                if (req.headers['x-user-id']) proxyReq.setHeader('x-user-id', req.headers['x-user-id'] as string)
                if (req.headers['x-user-role']) proxyReq.setHeader('x-user-role', req.headers['x-user-role'] as string)
                if (req.headers['x-request-id']) proxyReq.setHeader('x-request-id', req.headers['x-request-id'] as string)
                if (req.headers['x-gateway-verified']) proxyReq.setHeader('x-gateway-verified', 'true')
            },
            error: (err, req, res) => {
                errorHandler(err, req as any, res as any, () => { })
            }
        }
    })
}

// 6. Phân luồng Reverse Proxy tới 7 Microservices
app.use(createServiceProxy('/api/auth', env.services.auth))
app.use(createServiceProxy('/api/users', env.services.user))
app.use(createServiceProxy('/api/merchants', env.services.merchant))
app.use(createServiceProxy('/api/wallets', env.services.wallet))
app.use(createServiceProxy('/api/payments', env.services.payment))
app.use(createServiceProxy('/api/notifications', env.services.notification))
app.use(createServiceProxy('/api/admin', env.services.admin))

// 7. Bắt các Route không tồn tại (404)
app.use((_req, res) => {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Endpoint không tồn tại' } })
})

// 8. Bắt lỗi toàn cục
app.use(errorHandler)

export default app
