import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { sanitizeHeaders } from './middlewares/sanitizeHeaders'
import { attachRequestId } from './middlewares/requestId'
import { authenticate } from './middlewares/authenticate'
import { requireRole } from './middlewares/requireRole'
import { errorHandler } from './middlewares/errorHandler'
import { services } from './config/services'

const app = express()

// 1. Security & Logging
app.use(helmet())
app.use(morgan('[:date[iso]] :method :url :status :response-time ms - ReqId: :req[x-request-id]'))

// 2. CORS
const allowedOrigins = [process.env.CLIENT_URL, 'http://localhost:5173', 'http://localhost:5174'].filter(Boolean) as string[]
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || /^http:\/\/localhost:\d+$/.test(origin)) {
            return callback(null, true)
        }
        return callback(new Error('Blocked by CORS policy'))
    },
    credentials: true,
}))

// 3. Middlewares cốt lõi (Thứ tự: Sanitize -> RequestId -> Auth)
app.use(sanitizeHeaders) // Chặn mạo danh header
app.use(attachRequestId) // Gắn correlation ID
app.use(authenticate)    // Xác thực JWT

// 4. Health Check của Gateway
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'api-gateway' }))

// 5. Phân quyền cấp Route (RBAC)
app.use('/api/admin', requireRole('ADMIN'))

// Helper tạo proxy middleware có kèm timeout và error handler
const createServiceProxy = (pathFilter: string, target: string) => {
    return createProxyMiddleware({
        target,
        pathFilter,
        changeOrigin: true,
        timeout: 10000,      // Timeout kết nối tới service (10s)
        proxyTimeout: 10000, // Timeout chờ service xử lý và phản hồi (10s)
        on: {
            proxyReq: (proxyReq, req) => {
                // Đảm bảo các header do Gateway inject được chuyển tiếp đầy đủ
                if (req.headers['x-user-id']) {
                    proxyReq.setHeader('x-user-id', req.headers['x-user-id'] as string)
                }
                if (req.headers['x-user-role']) {
                    proxyReq.setHeader('x-user-role', req.headers['x-user-role'] as string)
                }
                if (req.headers['x-request-id']) {
                    proxyReq.setHeader('x-request-id', req.headers['x-request-id'] as string)
                }
                if (req.headers['x-gateway-verified']) {
                    proxyReq.setHeader('x-gateway-verified', 'true')
                }
            },
            error: (err, req, res) => {
                errorHandler(err, req as any, res as any, () => { })
            }
        }
    })
}

// 6. Reverse Proxy phân luồng tới từng microservice
app.use(createServiceProxy('/api/auth', services.auth))
app.use(createServiceProxy('/api/users', services.user))
app.use(createServiceProxy('/api/merchants', services.merchant))
app.use(createServiceProxy('/api/wallets', services.wallet))
app.use(createServiceProxy('/api/payments', services.payment))
app.use(createServiceProxy('/api/notifications', services.notification))
app.use(createServiceProxy('/api/admin', services.admin))

// 7. Route 404 cho các endpoint không tồn tại
app.use((_req, res) => {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Endpoint không tồn tại' } })
})

// 8. Global Error Handler
app.use(errorHandler)

export default app
