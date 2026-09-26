import { z } from 'zod'
import { replayFailed } from './outbox'
import { prisma } from '../config/prisma'
async function main() {
  const id = z.string().uuid().parse(process.argv[2])
  const result = await replayFailed(id)
  if (!result.count) throw new Error('Event not found or not FAILED')
  console.log('Event scheduled for retry: ' + id)
}
main().catch(() => { console.error('Usage: npm run events:replay -- <FAILED-event-uuid>'); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
