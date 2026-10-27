import { Prisma } from '@prisma/client'
import { prisma } from '../config/prisma'
import { env } from '../config/env'
import { storage } from './storage'

// Serialize final upload commit and deletion for the same immutable object key.
export async function lockKycObject(tx: Prisma.TransactionClient, key: string) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}

export async function removeUnreferenced(key: string, requireJob = false) {
  // ReadCommitted sees a submission that committed while we waited for its lock.
  // Never automatically retry a transaction containing a storage delete.
  return prisma.$transaction(async tx => {
    await lockKycObject(tx, key)
    const job = await tx.storageCleanup.findUnique({ where: { objectKey: key } })
    if (requireJob && !job) return 'skipped' as const
    if (job && job.nextAttemptAt.getTime() > Date.now()) return 'protected' as const
    const referenced = await tx.user.findFirst({ where: { OR: [{ kycObjectKey: key }, { kycBackObjectKey: key }] }, select: { id: true } })
    if (!referenced) await storage.remove(key)
    await tx.storageCleanup.deleteMany({ where: { objectKey: key } })
    return referenced ? 'referenced' as const : 'deleted' as const
  }, { isolationLevel: 'ReadCommitted', timeout: 25000 })
}

export async function scanKycOrphans(options: {
  dryRun?: boolean; graceMs?: number; log?: (entry: Record<string, unknown>) => void
} = {}) {
  const dryRun = options.dryRun ?? true
  const graceMs = options.graceMs ?? env.cleanupGraceMs
  if (!Number.isSafeInteger(graceMs) || graceMs <= 0) throw new Error('Cleanup grace period must be positive')
  const log = options.log ?? (entry => console.log(JSON.stringify(entry)))
  const startedAt = Date.now()
  const summary = { mode: dryRun ? 'dry-run' : 'delete', scanned: 0, referenced: 0, orphan: 0,
    tooYoung: 0, protected: 0, skipped: 0, deleted: 0, failed: 0, durationMs: 0 }
  for await (const object of storage.listKyc()) {
    summary.scanned++
    if (!object.key.startsWith('kyc/') || !object.lastModified || !Number.isFinite(object.lastModified.getTime())) {
      summary.skipped++; continue
    }
    if (startedAt - object.lastModified.getTime() < graceMs) { summary.tooYoung++; continue }
    try {
      // A reference lookup error fails closed; tombstones still protect their documents.
      const referenced = await prisma.user.findFirst({ where: { OR: [{ kycObjectKey: object.key }, { kycBackObjectKey: object.key }] }, select: { id: true } })
      if (referenced) { summary.referenced++; continue }
      const job = await prisma.storageCleanup.findUnique({ where: { objectKey: object.key } })
      if (job && job.nextAttemptAt.getTime() > Date.now()) { summary.protected++; continue }
      summary.orphan++
      if (dryRun) { log({ code: 'KYC_ORPHAN_CANDIDATE', objectKey: object.key }); continue }
      // Recheck inside the same per-key lock used by upload commit and queued cleanup.
      const outcome = await removeUnreferenced(object.key)
      if (outcome === 'deleted') summary.deleted++
      else if (outcome === 'referenced') summary.referenced++
      else if (outcome === 'protected') summary.protected++
      else summary.skipped++
    } catch {
      summary.failed++
      log({ code: 'KYC_ORPHAN_CLEANUP_FAILED', objectKey: object.key })
    }
  }
  summary.durationMs = Date.now() - startedAt
  log({ code: 'KYC_ORPHAN_CLEANUP_SUMMARY', ...summary })
  return summary
}
