import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '../config/env'
import { HttpError } from '../utils/errors'

function config() {
  const { bucket, accessKeyId, secretAccessKey, ...options } = env.s3
  if (!bucket || !accessKeyId || !secretAccessKey) throw new HttpError(503, 'STORAGE_UNAVAILABLE', 'KYC storage is not configured')
  return { bucket, client: new S3Client({ ...options, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 2 }) }
}
export const storage = {
  async put(key: string, body: Buffer) {
    const { bucket, client } = config()
    try { await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'image/jpeg' }), { abortSignal: AbortSignal.timeout(15000) }) }
    finally { client.destroy() }
  },
  async remove(key: string) {
    const { bucket, client } = config()
    try { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(15000) }) }
    finally { client.destroy() }
  },
  async url(key: string) {
    const { bucket, client } = config()
    try { return await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseCacheControl: 'no-store' }), { expiresIn: 60 }) }
    finally { client.destroy() }
  }
}
