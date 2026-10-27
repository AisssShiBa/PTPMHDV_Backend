import { z } from 'zod'
import { prisma } from '../config/prisma'
import { replayFailed } from './outbox'
async function main() {
  const id = z.string().uuid().parse(process.argv[2])
  const result = await replayFailed(id)
  console.log(JSON.stringify({ eventId: id, replayed: result.count }))
}
main().catch(() => { console.error('Replay failed; supply a FAILED outbox event UUID'); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
