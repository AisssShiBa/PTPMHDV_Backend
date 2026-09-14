// D:\PTPMHDV\Backend\gateway\src\config\env.ts
import 'dotenv/config'

function required(key: string): string {
    const value = process.env[key]
    if (!value) {
        throw new Error(`[LỖI CẤU HÌNH] Thiếu biến môi trường bắt buộc: ${key}`)
    }
    return value
}

export const env = {
    port: Number(process.env.PORT) || 3000,
    clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
    // ACCESS_TOKEN_SECRET bắt buộc phải có, nếu thiếu Gateway sẽ tự tắt để báo động
    accessTokenSecret: required('ACCESS_TOKEN_SECRET'),

    // Danh bạ định tuyến tới các Microservices nội bộ
    services: {
        auth: process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
        user: process.env.USER_SERVICE_URL || 'http://localhost:3002',
        merchant: process.env.MERCHANT_SERVICE_URL || 'http://localhost:3003',
        wallet: process.env.WALLET_SERVICE_URL || 'http://localhost:3004',
        payment: process.env.PAYMENT_SERVICE_URL || 'http://localhost:3005',
        notification: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3006',
        admin: process.env.ADMIN_SERVICE_URL || 'http://localhost:3007',
    }
}

export const services = env.services
