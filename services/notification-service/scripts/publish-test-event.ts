import 'dotenv/config'
import amqp from 'amqplib'
import { randomUUID } from 'node:crypto'

const publishTestEvent = async () => {
  const rabbitmqUrl = process.env.RABBITMQ_URL
  if (!rabbitmqUrl) throw new Error('RABBITMQ_URL is required')

  const connection = await amqp.connect(rabbitmqUrl)
  let channel: Awaited<ReturnType<typeof connection.createConfirmChannel>> | undefined
  try {
    const confirmChannel = await connection.createConfirmChannel()
    channel = confirmChannel
    await confirmChannel.assertExchange('wallet.events', 'topic', { durable: true })

    const eventId = process.env.NOTIFICATION_TEST_EVENT_ID ?? 'notification-inbox-manual-test-event'
    const userId =
      process.env.NOTIFICATION_TEST_USER_ID ?? '00000000-0000-4000-8000-000000000010'
    const body = Buffer.from(JSON.stringify({
      eventId,
      userId,
      type: 'WALLET_CREDITED',
      message: 'Notification inbox deduplication test'
    }))

    const publishOnce = () =>
      new Promise<void>((resolve, reject) => {
        confirmChannel.publish(
          'wallet.events',
          'wallet.notification',
          body,
          { messageId: eventId, persistent: true },
          (error) => (error ? reject(error) : resolve())
        )
      })

    await publishOnce()
    await publishOnce()
    await confirmChannel.waitForConfirms()
    console.log(`Published the same test event twice with messageId ${eventId} for user ${userId}`)
    console.log('Set NOTIFICATION_TEST_EVENT_ID to a new value to run an independent test again.')
  } finally {
    try {
      if (channel) await channel.close()
    } finally {
      await connection.close()
    }
  }
}

void publishTestEvent().catch((error: unknown) => {
  console.error('Failed to publish test event:', error)
  process.exitCode = 1
})
