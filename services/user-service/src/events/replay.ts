import amqp from 'amqplib'
import { env } from '../config/env'
import { USER_QUEUE, USER_DLQ } from './consumer'
import { registeredEvent } from './registration'
import { publishConfirmed } from './amqp'
import { prisma } from '../config/prisma'

async function main() {
  if (!env.rabbitmqUrl) throw new Error('Broker configuration required')
  const connection = await amqp.connect(env.rabbitmqUrl, { timeout: 10000 })
  connection.on('error', () => {})
  try {
    const channel = await connection.createConfirmChannel()
    channel.on('error', () => {})
    await channel.assertQueue(USER_QUEUE, { durable: true })
    await channel.assertQueue(USER_DLQ, { durable: true })
    const message = await channel.get(USER_DLQ, { noAck: false })
    if (!message) { console.log('DLQ is empty'); return }
    const event = registeredEvent.parse(JSON.parse(message.content.toString('utf8')))
    await publishConfirmed(channel, '', USER_QUEUE, Buffer.from(JSON.stringify(event)), {
      contentType: 'application/json', messageId: event.eventId, headers: { 'x-retry-count': 0 }
    })
    channel.ack(message)
    await channel.close()
    console.log('Requeued event: ' + event.eventId)
  } finally { await connection.close().catch(() => {}) }
}
main().catch(() => {
  console.error('Replay failed. The original remains in the DLQ; correct the payload or resolve the conflict before retrying.')
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
