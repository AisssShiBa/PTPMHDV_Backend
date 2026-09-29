import amqp, { ConfirmChannel, Options } from 'amqplib'
import { setTimeout as delay } from 'node:timers/promises'
import { env } from '../config/env'

// A returned (unroutable) message is a failure even if the broker confirms receipt.
export function publishConfirmed(channel: ConfirmChannel, exchange: string, key: string, body: Buffer, options: Options.Publish) {
  return new Promise<void>((resolve, reject) => {
    const onReturn = () => finish(new Error('UNROUTABLE_EVENT'))
    const onClose = () => finish(new Error('CHANNEL_CLOSED'))
    const timer = setTimeout(() => { finish(new Error('PUBLISH_TIMEOUT')); void channel.close().catch(() => {}) }, 10000)
    function finish(error?: Error | null) {
      clearTimeout(timer)
      channel.removeListener('return', onReturn)
      channel.removeListener('close', onClose)
      error ? reject(error) : resolve()
    }
    channel.once('return', onReturn)
    channel.once('close', onClose)
    try { channel.publish(exchange, key, body, { ...options, mandatory: true, persistent: true }, finish) }
    catch (error) { finish(error as Error) }
  })
}
export async function runWorker(session: (channel: ConfirmChannel, signal: AbortSignal) => Promise<void>, signal: AbortSignal) {
  if (!env.rabbitmqUrl) throw new Error('RABBITMQ_URL is required for the event worker')
  while (!signal.aborted) {
    let connection: Awaited<ReturnType<typeof amqp.connect>> | undefined
    const local = new AbortController()
    const stop = () => local.abort()
    signal.addEventListener('abort', stop, { once: true })
    try {
      connection = await amqp.connect(env.rabbitmqUrl, { timeout: 10000 })
      connection.on('error', () => console.error(JSON.stringify({ code: 'BROKER_CONNECTION_ERROR' })))
      connection.once('close', stop)
      const channel = await connection.createConfirmChannel()
      channel.on('error', () => console.error(JSON.stringify({ code: 'BROKER_CHANNEL_ERROR' })))
      channel.once('close', stop)
      await channel.assertExchange(env.eventExchange, 'topic', { durable: true })
      await session(channel, local.signal)
    } catch {
      if (!signal.aborted) console.error(JSON.stringify({ code: 'WORKER_RECONNECT' }))
    } finally {
      signal.removeEventListener('abort', stop)
      await connection?.close().catch(() => {})
    }
    if (!signal.aborted) await delay(2000, undefined, { signal }).catch(() => {})
  }
}
export async function pause(ms: number, signal: AbortSignal) {
  await delay(ms, undefined, { signal })
}
