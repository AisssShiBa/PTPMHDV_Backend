import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { prisma } from '../config/prisma'
import { HttpError } from '../utils/errors'

// The raw secret is returned exactly once, at creation. Only its SHA-256 reaches the database.
const secretDigest = (secret: string) => createHash('sha256').update(secret, 'utf8').digest()

type ApiKeyRecord = {
  id: string; keyId: string; prefix: string; revokedAt: Date | null
  lastUsedAt: Date | null; createdAt: Date
}

function serialize(key: ApiKeyRecord) {
  return {
    id: key.id, keyId: key.keyId, prefix: key.prefix,
    revokedAt: key.revokedAt, lastUsedAt: key.lastUsedAt, createdAt: key.createdAt
  }
}

export async function issueApiKey(merchantId: string) {
  const keyId = randomUUID()
  const secret = randomBytes(32).toString('base64url')
  const key = await prisma.merchantApiKey.create({
    data: { merchantId, keyId, prefix: secret.slice(0, 8), secretHash: secretDigest(secret).toString('hex') }
  })
  return { ...serialize(key), key: keyId + '.' + secret }
}

export async function revokeApiKey(merchantId: string, keyId: string) {
  const existing = await prisma.merchantApiKey.findFirst({ where: { keyId, merchantId } })
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'API key not found')
  // Idempotent: a repeat keeps the first revocation time and never re-exposes the secret.
  if (existing.revokedAt) return serialize(existing)
  return serialize(await prisma.merchantApiKey.update({ where: { id: existing.id }, data: { revokedAt: new Date() } }))
}

// Verifies a `<keyId>.<secret>` credential. Revoked keys never authenticate, and
// lastUsedAt only moves when the presented secret actually matched.
export async function verifyApiKey(credential: string) {
  const separator = credential.indexOf('.')
  if (separator <= 0) return null
  const keyId = credential.slice(0, separator)
  const secret = credential.slice(separator + 1)
  if (!keyId || !secret) return null
  const record = await prisma.merchantApiKey.findFirst({ where: { keyId, revokedAt: null } })
  if (!record) return null
  const stored = Buffer.from(record.secretHash, 'hex')
  const presented = secretDigest(secret)
  if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) return null
  const used = await prisma.merchantApiKey.updateMany({
    where: { id: record.id, revokedAt: null }, data: { lastUsedAt: new Date() }
  })
  return used.count === 0 ? null : serialize(record)
}
