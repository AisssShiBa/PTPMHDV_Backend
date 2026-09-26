import app from './app'
import { env } from './config/env'
import { prisma } from './config/prisma'

async function startServer() {
  await prisma.$connect()
  const server = app.listen(env.port, () => console.log('merchant-service listening on ' + env.port))
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    server.close(async () => {
      await prisma.$disconnect()
    })
    setTimeout(() => process.exit(1), 15000).unref()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
startServer().catch(() => { console.error(JSON.stringify({ code: 'STARTUP_FAILED' })); process.exitCode = 1 })
