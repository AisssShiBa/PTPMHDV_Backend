import Redis from 'ioredis'
import { env } from './services'

/**
 * Khởi tạo kết nối Redis duy nhất (Singleton) cho API Gateway bằng export const
 * Phục vụ cho bộ đếm Rate Limiting tập trung và phân tán trên toàn hệ thống.
 */
export const redisClient = new Redis(env.redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: process.env.NODE_ENV === 'test', // Chỉ lazyConnect khi chạy unit test, khi chạy server thật sẽ kết nối ngay lập tức
  retryStrategy: (times) => {
    if (times > 10) return null // Dừng thử lại sau 10 lần nếu Redis gặp sự cố
    return Math.min(times * 100, 2000)
  }
})

// Biến cờ theo dõi trạng thái sống/chết của Redis (phục vụ chính sách Fail-Closed / Fail-Open)
export let isRedisReady = false

// Chủ động kết nối ngay khi khởi động nếu đang ở trạng thái wait
if (process.env.NODE_ENV !== 'test' && redisClient.status === 'wait') {
  redisClient.connect().catch((err) => {
    if (process.env.NODE_ENV !== 'test') {
      console.error('[Redis Gateway] Lỗi khởi động kết nối Redis:', err.message)
    }
  })
}

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

