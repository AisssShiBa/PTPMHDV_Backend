const amqp = require('amqplib')
async function main() {
  const connection = await amqp.connect(process.env.RABBITMQ_URL)
  try {
    const channel = await connection.createChannel()
    const exchange = process.env.EVENT_EXCHANGE || 'finvault.events'
    // Durable observation queue for local/demo deployment; not a business consumer.
    const queue = process.env.MERCHANT_EVENT_QUEUE || 'finvault.demo.merchant-events.v1'
    await channel.assertExchange(exchange, 'topic', { durable: true })
    await channel.assertQueue(queue, { durable: true })
    for (const key of ['merchant.registered', 'merchant.status_updated', 'merchant.profile_updated'])
      await channel.bindQueue(queue, exchange, key)
    await channel.close()
    console.log('Merchant event bindings ready')
  } finally { await connection.close() }
}
main().catch(() => { console.error('BROKER_INIT_FAILED'); process.exitCode = 1 })
