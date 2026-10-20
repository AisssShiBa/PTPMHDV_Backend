import { createHash } from 'node:crypto'
import { z } from 'zod'

const nonEmptyString = z.string().min(1)
const tier = z.number().int().min(0).max(2)

export const finvaultEventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  eventType: nonEmptyString,
  eventVersion: z.number().int().positive(),
  occurredAt: z.iso.datetime({ offset: true }),
  data: z.unknown()
}).strict()

export const userRegisteredSchema = z.object({
  authUserId: nonEmptyString,
  email: z.email(),
  phone: z.string().optional()
}).passthrough()

export const userKycUpdatedSchema = z.object({
  authUserId: nonEmptyString,
  kycTier: tier,
  previousTier: tier
}).passthrough()

export const userKycUpdatedLegacySchema = z.object({
  authUserId: nonEmptyString,
  kycTier: tier
}).passthrough()

export const merchantStatusUpdatedSchema = z.object({
  merchantId: nonEmptyString,
  status: nonEmptyString
}).passthrough()

export const paymentSucceededSchema = z.object({
  paymentId: nonEmptyString,
  senderId: nonEmptyString,
  receiverId: nonEmptyString,
  amount: z.string().regex(/^\d+$/).refine(value => value === value.trim())
}).passthrough()

export const paymentFailedSchema = z.object({
  paymentId: nonEmptyString,
  senderId: nonEmptyString,
  reason: nonEmptyString
}).passthrough()

export const paymentExpiredSchema = z.object({
  paymentId: nonEmptyString,
  senderId: nonEmptyString
}).passthrough()

export const walletLimitExceededSchema = z.object({
  userId: nonEmptyString,
  limitType: nonEmptyString,
  kycTier: tier
}).passthrough()

export const eventSchemaRegistry = {
  'user.registered': { 1: userRegisteredSchema },
  'user.kyc_updated': { 1: userKycUpdatedSchema },
  'merchant.status_updated': { 1: merchantStatusUpdatedSchema },
  'payment.succeeded': { 1: paymentSucceededSchema },
  'payment.failed': { 1: paymentFailedSchema },
  'payment.expired': { 1: paymentExpiredSchema },
  'wallet.limit_exceeded': { 1: walletLimitExceededSchema }
} as const

export type RegisteredEventType = keyof typeof eventSchemaRegistry

export interface FinvaultEvent<T = unknown> {
  eventId: string
  eventType: string
  eventVersion: number
  occurredAt: string
  data: T
}

export class EventValidationError extends Error {
  constructor(
    message: string,
    public readonly reason: 'INVALID_ENVELOPE' | 'INVALID_PAYLOAD' | 'UNKNOWN_EVENT_TYPE' | 'UNSUPPORTED_EVENT_VERSION'
  ) {
    super(message)
    this.name = 'EventValidationError'
  }
}

export interface ParseEventOptions {
  allowLegacyKycUpdated?: boolean
}

export function parseFinvaultEvent(value: unknown, options: ParseEventOptions = {}): FinvaultEvent {
  const envelope = finvaultEventEnvelopeSchema.safeParse(value)
  if (!envelope.success) {
    throw new EventValidationError('Invalid FinVault event envelope', 'INVALID_ENVELOPE')
  }

  const event = envelope.data
  if (!Object.prototype.hasOwnProperty.call(eventSchemaRegistry, event.eventType)) {
    throw new EventValidationError(`Unregistered event type: ${event.eventType}`, 'UNKNOWN_EVENT_TYPE')
  }

  const versions = eventSchemaRegistry[event.eventType as RegisteredEventType] as Record<number, z.ZodType>
  const schema = versions[event.eventVersion]
  if (!schema) {
    throw new EventValidationError(
      `Unsupported version ${event.eventVersion} for ${event.eventType}`,
      'UNSUPPORTED_EVENT_VERSION'
    )
  }

  const parsedData = schema.safeParse(event.data)
  if (parsedData.success) return { ...event, data: parsedData.data }

  if (event.eventType === 'user.kyc_updated' && event.eventVersion === 1 &&
      options.allowLegacyKycUpdated && event.data !== null && typeof event.data === 'object' &&
      !Array.isArray(event.data) && !('previousTier' in event.data)) {
    const legacy = userKycUpdatedLegacySchema.safeParse(event.data)
    if (legacy.success) {
      return {
        ...event,
        data: { ...legacy.data, previousTier: undefined, legacy: true }
      }
    }
  }

  throw new EventValidationError(`Invalid payload for ${event.eventType} v${event.eventVersion}`, 'INVALID_PAYLOAD')
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalize(record[key])}`
    ).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError('Event payload contains a non-JSON value')
  return encoded
}

export function eventPayloadHash(event: Pick<FinvaultEvent, 'eventType' | 'eventVersion' | 'data'>): string {
  const data = event.eventType === 'user.kyc_updated' &&
      event.data !== null && typeof event.data === 'object' &&
      (event.data as Record<string, unknown>).legacy === true
    ? Object.fromEntries(Object.entries(event.data as Record<string, unknown>)
        .filter(([key]) => key !== 'legacy' && key !== 'previousTier'))
    : event.data
  const canonical = canonicalize({
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    data
  })
  return createHash('sha256').update(canonical).digest('hex')
}
