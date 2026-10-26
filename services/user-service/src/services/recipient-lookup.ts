import { prisma } from '../config/prisma'
import { HttpError } from '../utils/errors'

// A rolling minute, shared by all instances. The conflicting row is locked by
// PostgreSQL, so concurrent requests cannot each spend the same remaining slot.
export async function consumeLookupAttempt(authUserId: string) {
  const accepted = await prisma.$queryRaw<Array<{ auth_user_id: string }>>`
    INSERT INTO recipient_lookup_limits (auth_user_id, attempts)
    VALUES (${authUserId}, ARRAY[statement_timestamp()])
    ON CONFLICT (auth_user_id) DO UPDATE SET attempts = array_append(
      ARRAY(SELECT attempt FROM unnest(recipient_lookup_limits.attempts) AS attempt
        WHERE attempt > statement_timestamp() - INTERVAL '1 minute'), statement_timestamp())
    WHERE cardinality(ARRAY(SELECT attempt FROM unnest(recipient_lookup_limits.attempts) AS attempt
      WHERE attempt > statement_timestamp() - INTERVAL '1 minute')) < 10
    RETURNING auth_user_id
  `
  if (!accepted.length) throw new HttpError(429, 'RATE_LIMIT_EXCEEDED', 'Too many recipient lookups; retry later')
}

export function maskName(name: string | null) {
  const parts = name?.trim().split(/\s+/).filter(Boolean) || []
  if (!parts.length) return '***'
  if (parts.length === 1) return Array.from(parts[0])[0] + '***'
  return [parts[0], ...parts.slice(1).map(part => Array.from(part)[0] + '.')].join(' ')
}

export async function lookupRecipient(query: string, callerAuthUserId: string) {
  // Count ambiguous matches before visibility filtering; never expose a list.
  type Recipient = { authUserId: string; fullName: string | null; deletedAt: Date | null }
  const matches = query.includes('@')
    ? await prisma.$queryRaw<Recipient[]>`SELECT auth_user_id AS "authUserId", full_name AS "fullName", deleted_at AS "deletedAt"
        FROM users WHERE LOWER(email) = LOWER(${query}) LIMIT 2`
    : await prisma.$queryRaw<Recipient[]>`SELECT auth_user_id AS "authUserId", full_name AS "fullName", deleted_at AS "deletedAt"
        FROM users WHERE phone = ${query} LIMIT 2`
  const recipient = matches[0]
  if (matches.length !== 1 || recipient.deletedAt || recipient.authUserId === callerAuthUserId)
    throw new HttpError(404, 'RECIPIENT_NOT_FOUND', 'Recipient not found')
  return { authUserId: recipient.authUserId, maskedName: maskName(recipient.fullName) }
}
