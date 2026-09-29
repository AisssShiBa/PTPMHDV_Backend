import { ConfirmChannel, ConsumeMessage } from 'amqplib'
import { ZodError } from 'zod'
import { env } from '../config/env'
import { HttpError } from '../utils/errors'
import { consumeRegistration } from './registration'
import { pause, publishConfirmed } from './amqp'

export const USER_QUEUE = 'user-service.user-registered.v1'
export const USER_DLQ = USER_QUEUE + '.dlq'
export async function handleRegistration(channel: ConfirmChannel, message: ConsumeMessage, signal: AbortSignal) {
  const rawRetry = message.properties.headers?.['x-retry-count']
  const retries = Number.isInteger(rawRetry) && rawRetry >= 0 ? Math.min(rawRetry, env.eventMaxRetries) : 0
  const retryAt = Number(message.properties.headers?.['x-retry-at'] || 0)
  if (Number.isFinite(retryAt) && retryAt > Date.now()) await pause(Math.min(retryAt - Date.now(), 60000), signal)
  try {
    if (message.content.length > 65536) throw new HttpError(400, 'INVALID_EVENT', 'Event too large')
    let payload
    try { payload = JSON.parse(message.content.toString('utf8')) }
    catch { throw new HttpError(400, 'INVALID_EVENT', 'Invalid JSON') }
    await consumeRegistration(payload)
    channel.ack(message)
  } catch (error) {
    if (signal.aborted) throw error
    const permanent = error instanceof ZodError || error instanceof HttpError && error.status < 500
    const dead = permanent || retries >= env.eventMaxRetries
    await publishConfirmed(channel, '', dead ? USER_DLQ : USER_QUEUE, message.content, {
      contentType: 'application/json', messageId: message.properties.messageId,
      headers: { 'x-retry-count': retries + 1,
        'x-retry-at': dead ? 0 : Date.now() + Math.min(60000, env.eventRetryMs * 2 ** retries),
        'x-failure-code': permanent ? 'INVALID_OR_CONFLICTING_EVENT' : 'PROCESSING_FAILED' }
    })
    // Publish-to-retry/DLQ must be confirmed before acknowledging the original.
    channel.ack(message)
    console.error(JSON.stringify({ code: dead ? 'EVENT_DEAD_LETTERED' : 'EVENT_RETRY', retryCount: retries + 1 }))
  }
}
export async function consumeSession(channel: ConfirmChannel, signal: AbortSignal) {
  await channel.assertQueue(USER_QUEUE, { durable: true })
  await channel.assertQueue(USER_DLQ, { durable: true })
  await channel.bindQueue(USER_QUEUE, env.eventExchange, 'user.registered')
  await channel.prefetch(1)
  await new Promise<void>((resolve, reject) => {
    const stop = () => resolve()
    signal.addEventListener('abort', stop, { once: true })
    channel.consume(USER_QUEUE, message => {
        if (!message) return reject(new Error('CONSUMER_CANCELLED'))
        void handleRegistration(channel, message, signal).catch(error => reject(error))
      }, { noAck: false }).then(() => {
        if (signal.aborted) resolve()
      }, reject)
  })
}
