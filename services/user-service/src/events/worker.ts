import { runWorker } from './amqp'
import { consumeSession } from './consumer'
import { prisma } from '../config/prisma'
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
runWorker(consumeSession, controller.signal).catch(() => {
  console.error(JSON.stringify({ code: 'CONSUMER_STOPPED' }))
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
