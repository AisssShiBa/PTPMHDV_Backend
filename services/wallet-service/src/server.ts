import app from './app'
import { env } from './config/env'
import { prisma } from './config/prisma'

async function startServer() {
  await prisma.$connect()

  const server = app.listen(env.port, () => {
    console.log(`Wallet service is running on port ${env.port}`)
  })

  const shutdown = async () => {
    server.close(async () => {
      await prisma.$disconnect()
      process.exit(0)
    })
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

startServer().catch(async (error) => {
  console.error('Could not start wallet service:', error)
  await prisma.$disconnect()
  process.exit(1)
})
