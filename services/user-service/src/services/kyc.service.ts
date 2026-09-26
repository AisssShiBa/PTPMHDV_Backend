import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { User } from '@prisma/client'
import { prisma } from '../config/prisma'
import { transaction } from '../utils/transaction'
import { HttpError } from '../utils/errors'
import { storage } from './storage'

export async function normalizeImage(file: { buffer: Buffer; mimetype: string }) {
  if (!['image/jpeg', 'image/png'].includes(file.mimetype)) throw new HttpError(400, 'INVALID_IMAGE', 'Only JPEG and PNG images are supported')
  if (file.buffer.length > 5 * 1024 * 1024) throw new HttpError(413, 'FILE_TOO_LARGE', 'Maximum upload size is 5 MiB')
  try {
    const pipeline = sharp(file.buffer, { limitInputPixels: 25000000, failOn: 'warning' })
    const metadata = await pipeline.metadata()
    if (!['jpeg', 'png'].includes(metadata.format || '') || (metadata.pages || 1) > 1 ||
      'image/' + metadata.format !== file.mimetype) throw new Error('Invalid image')
    return await pipeline.rotate().jpeg({ quality: 90 }).toBuffer()
  } catch { throw new HttpError(400, 'INVALID_IMAGE', 'Image is invalid, truncated or too large') }
}

export async function submitDocument(user: User, idNumber: string, file: { buffer: Buffer; mimetype: string }) {
  if (user.kycStatus === 'APPROVED') throw new HttpError(409, 'INVALID_TRANSITION', 'Approved KYC must be rejected before resubmission')
  const image = await normalizeImage(file)
  const key = 'kyc/' + user.id + '/' + randomUUID() + '.jpg'
  // Persist cleanup intent BEFORE upload: a process crash cannot leave an untracked object.
  await prisma.storageCleanup.create({ data: { objectKey: key, nextAttemptAt: new Date(Date.now() + 86400000) } })
  try {
    await storage.put(key, image)
    return await transaction(async tx => {
      const result = await tx.user.updateMany({
        where: { id: user.id, deletedAt: null, version: user.version },
        data: { idNumber, idImageUrl: null, kycObjectKey: key, kycMimeType: 'image/jpeg',
          kycFileSize: image.length, kycStatus: 'PENDING', version: { increment: 1 } }
      })
      if (result.count !== 1) throw new HttpError(409, 'CONCURRENT_UPDATE', 'Profile changed; reload and retry')
      await tx.storageCleanup.delete({ where: { objectKey: key } })
      if (user.kycObjectKey) await tx.storageCleanup.upsert({
        where: { objectKey: user.kycObjectKey },
        create: { objectKey: user.kycObjectKey }, update: { nextAttemptAt: new Date() }
      })
      return tx.user.findUniqueOrThrow({ where: { id: user.id } })
    })
  } catch (error) {
    // A failed commit response may be ambiguous. The durable cleanup job checks references
    // before deleting, so never delete the newly uploaded object directly here.
    if (error instanceof HttpError) throw error
    throw new HttpError(503, 'KYC_SUBMISSION_FAILED', 'Could not save KYC; retry after reloading the profile')
  }
}
export async function documentUrl(user: User) {
  if (!user.kycObjectKey) throw new HttpError(404, 'NOT_FOUND', 'No uploaded KYC document')
  return { url: await storage.url(user.kycObjectKey), expiresIn: 60 }
}
export async function cleanupStorage() {
  const jobs = await prisma.storageCleanup.findMany({ where: { nextAttemptAt: { lte: new Date() } }, take: 20 })
  for (const job of jobs) {
    try {
      const referenced = await prisma.user.findFirst({ where: { kycObjectKey: job.objectKey } })
      if (!referenced) await storage.remove(job.objectKey)
      await prisma.storageCleanup.deleteMany({ where: { objectKey: job.objectKey } })
    } catch {
      await prisma.storageCleanup.updateMany({ where: { objectKey: job.objectKey },
        data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 3600000) } })
      console.error(JSON.stringify({ code: 'STORAGE_CLEANUP_RETRY' }))
    }
  }
}
