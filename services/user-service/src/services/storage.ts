import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '../config/env'
import { HttpError } from '../utils/errors'

function config(forSigning = false) {
  const { bucket, accessKeyId, secretAccessKey, publicEndpoint, ...options } = env.s3
  if (!bucket || !accessKeyId || !secretAccessKey) throw new HttpError(503, 'STORAGE_UNAVAILABLE', 'KYC storage is not configured')
  return { bucket, client: new S3Client({ ...options,
    endpoint: forSigning ? (publicEndpoint || options.endpoint) : options.endpoint,
    credentials: { accessKeyId, secretAccessKey }, maxAttempts: 2 }) }
}
export const storage = {
  async assertExists(key: string) {
    const { bucket, client } = config()
    try { await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(15000) }) }
    finally { client.destroy() }
  },
  async *listKyc(): AsyncGenerator<{ key: string; lastModified?: Date }> {
    const { bucket, client } = config()
    try {
      let token: string | undefined
      do {
        const page = await client.send(new ListObjectsV2Command({
          Bucket: bucket, Prefix: 'kyc/', MaxKeys: 1000, ContinuationToken: token
        }), { abortSignal: AbortSignal.timeout(15000) })
        for (const object of page.Contents || []) {
          if (object.Key) yield { key: object.Key, lastModified: object.LastModified }
        }
        const next = page.IsTruncated ? page.NextContinuationToken : undefined
        if (page.IsTruncated && (!next || next === token)) throw new Error('Invalid storage continuation token')
        token = next
      } while (token)
    } finally { client.destroy() }
  },
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
  async url(key: string, expiresIn = env.kycUrlTtlSeconds) {
    const { bucket, client } = config(true)
    try { return await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseCacheControl: 'no-store' }), { expiresIn }) }
    finally { client.destroy() }
  }
}
