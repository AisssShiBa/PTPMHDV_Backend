export const services = {
    auth: process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
    user: process.env.USER_SERVICE_URL || 'http://localhost:3002',
    merchant: process.env.MERCHANT_SERVICE_URL || 'http://localhost:3003',
    wallet: process.env.WALLET_SERVICE_URL || 'http://localhost:3004',
    payment: process.env.PAYMENT_SERVICE_URL || 'http://localhost:3005',
    notification: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3006',
    admin: process.env.ADMIN_SERVICE_URL || 'http://localhost:3007',
}