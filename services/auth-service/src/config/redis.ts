import Redis from 'ioredis'
import { env } from './env'

/**
 * Khởi tạo kết nối Redis duy nhất (Singleton) cho auth-service bằng export const
 * Node.js sẽ tự động cache biến này, đảm bảo toàn bộ hệ thống chỉ dùng chung 1 kết nối.
 */
export const redisClient = new Redis(env.redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true, // Chỉ thực sự kết nối khi có lệnh gọi (giúp chạy test không bị lỗi)
  retryStrategy: (times) => {
    if (times > 10) return null // Thử lại tối đa 10 lần nếu mất mạng
    return Math.min(times * 100, 2000)
  }
})

// Lắng nghe sự kiện để log thông báo và chống crash server
redisClient.on('connect', () => {
  if (process.env.NODE_ENV !== 'test') {
    console.log('[Redis Auth] Đã kết nối thành công tới Redis')
  }
})

redisClient.on('error', (err) => {
  if (process.env.NODE_ENV !== 'test') {
    console.error('[Redis Auth] Lỗi kết nối Redis:', err.message)
  }
})
