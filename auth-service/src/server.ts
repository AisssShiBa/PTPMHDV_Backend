import app from './app'
import { env } from './config/env'
import { prisma } from './config/prisma'
async function startServer() {
  try {
    await prisma.$connect()
    console.log('Kết nối DB thành công')
    app.listen(env.port, () => {
      console.log(`Server chạy tại port ${env.port}`)
    })
  } catch (error) {
    console.error('Lỗi kết nối DB:', error)
    process.exit(1)
  }
}
startServer()
