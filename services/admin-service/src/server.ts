import app from './app'
import { env } from './config/env'
import { prisma } from './config/prisma'

async function startServer() {
  try {
    await prisma.$connect()
    console.log('✅ Admin service: Kết nối cơ sở dữ liệu PostgreSQL (admin_service) thành công!')
  } catch (err: any) {
    console.warn(
      '⚠️ Admin service: Không thể kết nối Database PostgreSQL (Vui lòng kiểm tra lại dịch vụ database):',
      err?.message || err
    )
  }

  const server = app.listen(env.port, () => {
    console.log(`🚀 Admin service đang chạy tại Port: ${env.port} [NODE_ENV: ${env.nodeEnv}]`)
    console.log(`📡 Sẵn sàng nhận request từ API Gateway tại: http://localhost:${env.port}/api/admin`)
  })

  // Đóng kết nối an toàn khi server nhận tín hiệu tắt (Graceful Shutdown)
  const shutdown = async (signal: string) => {
    console.log(`\n🛑 Nhận tín hiệu ${signal}. Đang đóng kết nối an toàn...`)
    server.close(async () => {
      await prisma.$disconnect()
      console.log('🏁 Admin service đã dừng an toàn.')
      process.exit(0)
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

startServer()
