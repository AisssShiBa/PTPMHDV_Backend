import { z } from 'zod'
import { createHash } from 'node:crypto'
import { transaction } from '../utils/transaction'
import { provisionProfile } from '../services/user.service'
import { HttpError } from '../utils/errors'

export const registeredEvent = z.object({
  eventId: z.string().uuid(), eventType: z.literal('user.registered'),
  eventVersion: z.literal(1), occurredAt: z.string().datetime(),
  data: z.object({ authUserId: z.string().uuid(), email: z.string().trim().email().max(254) })
})
export async function consumeRegistration(input: unknown) {
  const event = registeredEvent.parse(input)
  const payloadHash = createHash('sha256').update(JSON.stringify(event)).digest('hex')
  for (let attempt = 0; ; attempt++) {
    try {
      return await transaction(async tx => {
        const processed = await tx.consumedEvent.findUnique({ where: { id: event.eventId } })
        if (processed) {
          if (processed.payloadHash !== payloadHash) throw new HttpError(409, 'EVENT_CONFLICT', 'Event ID was reused with different data')
          return
        }
        await provisionProfile(tx, event.data.authUserId, event.data.email)
        await tx.consumedEvent.create({ data: { id: event.eventId, payloadHash } })
      })
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002' && attempt < 3) continue
      throw error
    }
  }
}
