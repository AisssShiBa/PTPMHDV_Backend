import { prisma } from '../config/prisma'
import { startOutboxPublisher } from './publisher'
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
startOutboxPublisher(controller.signal).catch(() => {
  console.error(JSON.stringify({ code: 'PUBLISHER_STOPPED' }))
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
