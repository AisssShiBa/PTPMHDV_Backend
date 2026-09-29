import amqp, { type ConsumeMessage } from 'amqplib'
import { env } from '../config/env'
import { notificationIO } from '../socket'
import { createNotificationRecord, isNotificationType } from './notificationService'

const exchanges = ['wallet.events', 'payment.events', 'kyc.events']

interface NotificationEvent {
  userId?: unknown
  type?: unknown
  message?: unknown
}

const handleMessage = async (message: ConsumeMessage) => {
  const event = JSON.parse(message.content.toString()) as { data?: NotificationEvent; payload?: NotificationEvent } & NotificationEvent
  const payload = event.data ?? event.payload ?? event

  if (
    typeof payload.userId !== 'string' ||
    !isNotificationType(payload.type) ||
    typeof payload.message !== 'string'
  ) {
    throw new Error('Invalid notification event payload')
  }

  const notification = await createNotificationRecord(payload.userId, payload.type, payload.message)
  notificationIO?.to(`user:${payload.userId}`).emit('notification:new', notification)
}

export const startRabbitMqConsumer = async () => {
  if (!env.rabbitmqUrl) {
    console.log('RabbitMQ consumer disabled: RABBITMQ_URL chưa được cấu hình')
    return
  }

  try {
    const connection = await amqp.connect(env.rabbitmqUrl)
    const channel = await connection.createChannel()

    for (const exchange of exchanges) {
      await channel.assertExchange(exchange, 'topic', { durable: true })
      const queue = await channel.assertQueue(`${env.rabbitmqQueue}.${exchange}`, { durable: true })
      await channel.bindQueue(queue.queue, exchange, '#')
      await channel.consume(queue.queue, async (message) => {
        if (!message) return
        try {
          await handleMessage(message)
          channel.ack(message)
        } catch (error) {
          console.error(`[RabbitMQ] Bỏ qua message không hợp lệ từ ${exchange}:`, error)
          channel.nack(message, false, false)
        }
      })
    }

    console.log(`RabbitMQ consumer started for: ${exchanges.join(', ')}`)
  } catch (error) {
    console.error('[RabbitMQ] Không thể khởi động consumer:', error)
  }
}