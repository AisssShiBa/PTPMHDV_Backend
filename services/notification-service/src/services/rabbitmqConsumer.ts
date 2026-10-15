import amqp, { type ConfirmChannel, type ConsumeMessage } from 'amqplib'
import { env } from '../config/env'
import { notificationIO } from '../socket'
import {
  ingestNotification,
  isNotificationType,
  NotificationIngestError,
  type NotificationTypeValue
} from './notificationService'

const exchanges = ['wallet.events', 'payment.events', 'kyc.events']
const deadLetterQueue = 'notification-service.dlq'
const maxRetries = 3

export type ParsedNotificationEvent = {
  eventId?: string
  userId: string
  type: NotificationTypeValue
  message: string
}

export type NotificationAmqpMessage = {
  content: Buffer
  properties: {
    messageId?: string
  }
}

export class InvalidNotificationEventError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidNotificationEventError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const parseEvent = (message: NotificationAmqpMessage): ParsedNotificationEvent => {
  let body: unknown
  try {
    body = JSON.parse(message.content.toString()) as unknown
  } catch {
    throw new InvalidNotificationEventError('Invalid JSON notification event')
  }

  if (!isRecord(body)) {
    throw new InvalidNotificationEventError('Notification event must be an object')
  }

  const payload = isRecord(body.data)
    ? body.data
    : isRecord(body.payload)
      ? body.payload
      : body
  const eventId = body.eventId ?? message.properties.messageId
  const type = payload.type ?? body.eventType

  if (
    typeof payload.userId !== 'string' ||
    payload.userId.trim().length === 0 ||
    !isNotificationType(type) ||
    typeof payload.message !== 'string' ||
    (eventId !== undefined && (typeof eventId !== 'string' || eventId.trim().length === 0))
  ) {
    throw new InvalidNotificationEventError('Invalid notification event payload')
  }

  return {
    ...(eventId !== undefined ? { eventId } : {}),
    userId: payload.userId,
    type,
    message: payload.message
  }
}

const retryCountFrom = (message: ConsumeMessage): number => {
  const value = message.properties.headers?.['x-retry-count']
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return 0
}

const republishForRetry = (
  channel: ConfirmChannel,
  queueName: string,
  message: ConsumeMessage,
  retryCount: number
) =>
  new Promise<void>((resolve, reject) => {
    channel.publish(
      '',
      queueName,
      message.content,
      {
        ...message.properties,
        headers: { ...message.properties.headers, 'x-retry-count': retryCount + 1 },
        persistent: true
      },
      (error) => (error ? reject(error) : resolve())
    )
  })

const deadLetter = async (channel: ConfirmChannel, message: ConsumeMessage, reason: string) => {
  console.error(`[RabbitMQ] Đưa message từ ${message.fields.exchange} vào DLQ: ${reason}`)
  try {
    await new Promise<void>((resolve, reject) => {
      channel.sendToQueue(
        deadLetterQueue,
        message.content,
        {
          ...message.properties,
          headers: { ...message.properties.headers, 'x-dead-letter-reason': reason },
          persistent: true
        },
        (error) => (error ? reject(error) : resolve())
      )
    })
    channel.ack(message)
  } catch (error) {
    console.error('[RabbitMQ] Không thể ghi message vào DLQ:', error)
    channel.nack(message, false, true)
  }
}

const handleMessage = async (
  channel: ConfirmChannel,
  queueName: string,
  message: ConsumeMessage
) => {
  let event: ParsedNotificationEvent
  try {
    event = parseEvent(message)
  } catch (error) {
    await deadLetter(
      channel,
      message,
      error instanceof Error ? error.message : 'Invalid notification event'
    )
    return
  }

  try {
    const result = await ingestNotification({
      ...event,
      source: message.fields.exchange
    })
    if (!result.duplicate && result.notification) {
      notificationIO?.to(`user:${event.userId}`).emit('notification:new', result.notification)
    }
    channel.ack(message)
  } catch (error) {
    if (
      error instanceof NotificationIngestError &&
      (error.code === 'EVENT_CONFLICT' || error.code === 'INVALID_NOTIFICATION')
    ) {
      await deadLetter(channel, message, error.code)
      return
    }

    const retryCount = retryCountFrom(message)
    if (retryCount >= maxRetries) {
      await deadLetter(channel, message, 'Maximum retry count exceeded')
      return
    }

    try {
      await republishForRetry(channel, queueName, message, retryCount)
      channel.ack(message)
    } catch (retryError) {
      console.error('[RabbitMQ] Không thể phát lại message để retry:', retryError)
      channel.nack(message, false, true)
    }
  }
}

export const startRabbitMqConsumer = async () => {
  if (!env.rabbitmqUrl) {
    console.log('RabbitMQ consumer disabled: RABBITMQ_URL chưa được cấu hình')
    return
  }

  try {
    const connection = await amqp.connect(env.rabbitmqUrl)
    const channel = await connection.createConfirmChannel()

    await channel.assertQueue(deadLetterQueue, { durable: true })

    for (const exchange of exchanges) {
      await channel.assertExchange(exchange, 'topic', { durable: true })
      const queue = await channel.assertQueue(`${env.rabbitmqQueue}.${exchange}`, { durable: true })
      await channel.bindQueue(queue.queue, exchange, '#')
      await channel.consume(queue.queue, async (message) => {
        if (!message) return
        try {
          await handleMessage(channel, queue.queue, message)
        } catch (error) {
          console.error('[RabbitMQ] Lỗi không mong đợi khi xử lý message:', error)
          channel.nack(message, false, true)
        }
      })
    }

    console.log(`RabbitMQ consumer started for: ${exchanges.join(', ')}`)
  } catch (error) {
    console.error('[RabbitMQ] Không thể khởi động consumer:', error)
  }
}