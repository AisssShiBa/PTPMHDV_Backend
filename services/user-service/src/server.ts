import app from './app'
import { env } from './config/env'
import { prisma } from './config/prisma'
import { cleanupStorage } from './services/kyc.service'

async function startServer() {
  await prisma.$connect()
  const server = app.listen(env.port, () => console.log('user-service listening on ' + env.port))
  let cleanup: Promise<void> | undefined
  const timer = setInterval(() => {
    if (!cleanup && env.s3.bucket) cleanup = cleanupStorage().catch(() => {
      console.error(JSON.stringify({ code: 'STORAGE_CLEANUP_FAILED' }))
    }).finally(() => { cleanup = undefined })
  }, 60000)
  timer.unref()
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    clearInterval(timer)
    server.close(async () => {
      await cleanup
      await prisma.$disconnect()
    })
    setTimeout(() => process.exit(1), 15000).unref()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
startServer().catch(() => { console.error(JSON.stringify({ code: 'STARTUP_FAILED' })); process.exitCode = 1 })
