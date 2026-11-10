import Redis from 'ioredis'
import { env } from './services'

/**
 * Khởi tạo kết nối Redis duy nhất (Singleton) cho API Gateway bằng export const
 * Phục vụ cho bộ đếm Rate Limiting tập trung và phân tán trên toàn hệ thống.
 */
export const redisClient = new Redis(env.redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true, // Chỉ kết nối khi có request thực tế, giúp chạy test nhẹ và không crash
  retryStrategy: (times) => {
    if (times > 10) return null // Dừng thử lại sau 10 lần nếu Redis gặp sự cố
    return Math.min(times * 100, 2000)
  }
})

// Biến cờ theo dõi trạng thái sống/chết của Redis (phục vụ chính sách Fail-Closed / Fail-Open)
export let isRedisReady = false

redisClient.on('connect', () => {
  if (process.env.NODE_ENV !== 'test') {
    console.log('[Redis Gateway] Đã kết nối thành công tới Redis')
  }
})

redisClient.on('ready', () => {
  isRedisReady = true
})

redisClient.on('close', () => {
  isRedisReady = false
})

redisClient.on('error', (err) => {
  isRedisReady = false
  if (process.env.NODE_ENV !== 'test') {
    console.error('[Redis Gateway] Lỗi kết nối Redis:', err.message)
  }
})

if (process.env.NODE_ENV !== 'test') {
  redisClient.connect().catch((err) => {
    if (process.env.NODE_ENV !== 'test') {
      console.error('[Redis Gateway] Không thể kết nối ban đầu tới Redis:', err.message)
    }
  })
}

