import { Prisma } from '@prisma/client'
import { prisma } from '../config/prisma'

// Retry serialization failures. Unique conflicts are handled by the caller.
export async function transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await prisma.$transaction(work, { isolationLevel: 'Serializable' }) }
    catch (error) {
      if ((error as { code?: string }).code !== 'P2034' || attempt >= 4) throw error
    }
  }
}
