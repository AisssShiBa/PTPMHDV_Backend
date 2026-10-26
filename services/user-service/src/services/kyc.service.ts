import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { User as UserProfile } from '@prisma/client'
import { prisma } from '../config/prisma'
import { transaction } from '../utils/transaction'
import { HttpError } from '../utils/errors'
import { storage } from './storage'
import { env } from '../config/env'
import { lockKycObject, removeUnreferenced } from './storage-cleanup'

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

type ImageUpload = { buffer: Buffer; mimetype: string }
export async function submitDocuments(profile: UserProfile, idNumber: string, front: ImageUpload, back: ImageUpload) {
  if (!front || !back) throw new HttpError(400, 'KYC_DOCUMENTS_REQUIRED', 'Upload both front and back images')
  if (profile.kycStatus === 'APPROVED') throw new HttpError(409, 'INVALID_TRANSITION', 'Approved KYC must be rejected before resubmission')
  const profileId = profile.id
  const images = [await normalizeImage(front), await normalizeImage(back)]
  const keys = images.map(() => 'kyc/' + profileId + '/' + randomUUID() + '.jpg')
  // Persist cleanup intent BEFORE upload: a process crash cannot leave an untracked object.
  await prisma.storageCleanup.createMany({ data: keys.map(objectKey => ({ objectKey,
    nextAttemptAt: new Date(Date.now() + env.cleanupGraceMs) })) })
  try {
    for (let i = 0; i < keys.length; i++) await storage.put(keys[i], images[i])
    return await transaction(async tx => {
      for (const key of [...keys].sort()) await lockKycObject(tx, key)
      // Storage deletion cannot roll back with PostgreSQL. If deletion succeeded
      // but its DB commit failed, an old intent can survive for a missing object.
      for (const key of keys) await storage.assertExists(key)
      const result = await tx.user.updateMany({
        where: { id: profileId, deletedAt: null, version: profile.version },
        data: { idNumber, idImageUrl: null, kycObjectKey: keys[0], kycBackObjectKey: keys[1], kycMimeType: 'image/jpeg',
          kycFileSize: images.reduce((total, image) => total + image.length, 0), kycStatus: 'PENDING', version: { increment: 1 } }
      })
      if (result.count !== 1) throw new HttpError(409, 'CONCURRENT_UPDATE', 'Profile changed; reload and retry')
      await tx.storageCleanup.deleteMany({ where: { objectKey: { in: keys } } })
      for (const key of [profile.kycObjectKey, profile.kycBackObjectKey]) {
        if (key) await tx.storageCleanup.upsert({ where: { objectKey: key },
          create: { objectKey: key }, update: { nextAttemptAt: new Date() } })
      }
      return tx.user.findUniqueOrThrow({ where: { id: profileId } })
    })
  } catch (error) {
    // A failed commit response may be ambiguous. The durable cleanup job checks references
    // before deleting, so never delete the newly uploaded object directly here.
    if (error instanceof HttpError) throw error
    throw new HttpError(503, 'KYC_SUBMISSION_FAILED', 'Could not save KYC; retry after reloading the profile')
  }
}
export async function documentUrl(profile: UserProfile) {
  if (!profile.kycObjectKey) throw new HttpError(404, 'NOT_FOUND', 'No uploaded KYC document')
  return { url: await storage.url(profile.kycObjectKey), expiresIn: env.kycUrlTtlSeconds }
}
export async function documentUrls(profile: UserProfile) {
  if (!profile.kycObjectKey || !profile.kycBackObjectKey)
    throw new HttpError(404, 'KYC_DOCUMENTS_INCOMPLETE', 'Both KYC documents are required')
  const expiresAt = new Date(Date.now() + env.kycUrlTtlSeconds * 1000).toISOString()
  const [frontUrl, backUrl] = await Promise.all([storage.url(profile.kycObjectKey), storage.url(profile.kycBackObjectKey)])
  return { frontUrl, backUrl, expiresAt }
}
export async function cleanupStorage() {
  const jobs = await prisma.storageCleanup.findMany({ where: { nextAttemptAt: { lte: new Date() } }, take: 20 })
  for (const job of jobs) {
    try {
      await removeUnreferenced(job.objectKey, true)
    } catch {
      await prisma.storageCleanup.updateMany({ where: { objectKey: job.objectKey },
        data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 3600000) } })
      console.error(JSON.stringify({ code: 'STORAGE_CLEANUP_RETRY' }))
    }
  }
}
