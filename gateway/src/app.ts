// D:\PTPMHDV\Backend\gateway\src\app.ts
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { env } from './config/services'
import { rateLimiter } from './middlewares/rateLimiter'
import { sanitizeHeaders } from './middlewares/sanitizeHeaders'
import { attachRequestId } from './middlewares/requestId'
import { authenticate } from './middlewares/authenticate'
import { requireRole } from './middlewares/requireRole'
import { errorHandler } from './middlewares/errorHandler'

const app = express()

// 1. Bảo mật Header HTTP & Ghi nhật ký Log
app.use(helmet())
app.use(morgan('[:date[iso]] :method :url :status :response-time ms - ReqId: :req[x-request-id]'))

// 2. Cấu hình CORS
app.use(
    cors({
        origin: 'http://localhost:5173',
        credentials: true,
    })
)

// 3. Endpoint kiểm tra sức khỏe Gateway (Công khai, không yêu cầu Token)
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'api-gateway' }))

// 4. Rate Limiter chặn spam & DDoS toàn hệ thống (120 req/phút mỗi IP)
app.use(rateLimiter(60 * 1000, 120))

// 5. Chuỗi Middleware cốt lõi (Thứ tự: Sanitize -> RequestId -> Auth)
app.use(sanitizeHeaders)
app.use(attachRequestId)
app.use(authenticate)

// 6. Phân quyền tầng Route (Chặn trước khi request chạm vào proxy)
app.use('/api/admin', requireRole('ADMIN'))
app.use('/api/wallets/admin', requireRole('ADMIN'))

// Helper tạo Proxy Middleware chuẩn (Hỗ trợ forward x-gateway-token và WebSocket)
const createServiceProxy = (pathFilter: string, target: string, ws: boolean = false) => {
    return createProxyMiddleware({
        target,
        pathFilter,
        changeOrigin: true,
        ws,                  // Hỗ trợ WebSocket (Upgrade connection)
        timeout: 10000,      // Timeout kết nối tới service (10s)
        proxyTimeout: 10000, // Timeout chờ service con xử lý xong (10s)
        on: {
            proxyReq: (proxyReq, req) => {
                // 1. CHUYỂN TIẾP GATEWAY TOKEN MẬT MÃ (ES256)
                if (req.headers['x-gateway-token']) {
                    proxyReq.setHeader('x-gateway-token', req.headers['x-gateway-token'] as string)
                }

                // 2. Chuyển tiếp các header định danh & truy vết
                if (req.headers['x-user-id']) proxyReq.setHeader('x-user-id', req.headers['x-user-id'] as string)
                if (req.headers['x-user-role']) proxyReq.setHeader('x-user-role', req.headers['x-user-role'] as string)
                if (req.headers['x-request-id']) proxyReq.setHeader('x-request-id', req.headers['x-request-id'] as string)

                // LƯU Ý BẢO MẬT: ĐÃ XÓA BỎ HOÀN TOÀN cờ tĩnh cũ proxyReq.setHeader('x-gateway-verified', 'true')
            },
            error: (err, req, res) => {
                errorHandler(err, req as any, res as any, () => { })
            }
        }
    })
}

// 7. Phân luồng Reverse Proxy tới các Microservices nội bộ
app.use(createServiceProxy('/api/auth', env.services.auth))
app.use(createServiceProxy('/api/users', env.services.user))
app.use(createServiceProxy('/api/merchants', env.services.merchant))
app.use(createServiceProxy('/api/wallets/admin', env.services.wallet))
app.use(createServiceProxy('/api/wallets', env.services.wallet))
app.use(createServiceProxy('/api/payments', env.services.payment))
app.use(createServiceProxy('/api/funding', env.services.payment)) // Whitelist Webhook VNPAY
app.use(createServiceProxy('/api/notifications', env.services.notification))
app.use(createServiceProxy('/socket.io', env.services.notification, true)) // Proxy WebSocket sang notification-service
app.use(createServiceProxy('/api/admin', env.services.admin))

// 8. Bắt các Route không tồn tại (404)
app.use((_req, res) => {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Endpoint không tồn tại' } })
})

// 9. Bắt lỗi toàn cục
app.use(errorHandler)

export default app
