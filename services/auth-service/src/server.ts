import app from './app'
import { env } from './config/env'
import { prisma } from './config/prisma'

async function startServer() {
  try {
    await prisma.$connect()
    console.log('[AUTH] Kết nối PostgreSQL thành công')
  } catch (error) {
    console.warn('[AUTH WARNING] Không thể kết nối tới PostgreSQL (vui lòng kiểm tra Docker DB):', (error as any)?.message || error)
  }

  const server = app.listen(env.port, () => {
    console.log(`[AUTH] Auth Service đang lắng nghe tại cổng ${env.port}`)
  })

  // Đóng kết nối an toàn khi nhận tín hiệu dừng (Graceful Shutdown)
  const shutdown = (signal: string) => {
    console.log(`[AUTH] Nhận tín hiệu ${signal}, đang tiến hành đóng dịch vụ...`)
    server.close(async () => {
      await prisma.$disconnect().catch(() => {})
      console.log('[AUTH] Đã đóng HTTP server và ngắt kết nối Database an toàn.')
      process.exit(0)
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

startServer()
