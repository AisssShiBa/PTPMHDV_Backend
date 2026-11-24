import { env } from './config/env'
import { prisma } from './config/prisma'
import { createDefaultAppOptions, createUtilityApp } from './app'
import { startUtilityEventsConsumer } from './services/utilityEventsConsumer'
import { createRecoveryJob } from './services/recoveryService'
import { startUtilityOutboxPublisher } from './services/utilityOutbox'

const dependencies = createDefaultAppOptions()
const app = createUtilityApp(dependencies)

async function start() {
  await prisma.$connect()
  const server = app.listen(env.port, () => {
    console.log(`utilities-service listening on ${env.port}`)
  })

  const consumer = startUtilityEventsConsumer({
    paymentClient: dependencies.paymentClient,
    providerClient: dependencies.providerClient
  })
  const publisherStop = new AbortController()
  const publisher = env.rabbitmqUrl ? startUtilityOutboxPublisher(env.rabbitmqUrl, publisherStop.signal) : Promise.resolve()
  const recovery = createRecoveryJob(
    {
      paymentClient: dependencies.paymentClient,
      providerClient: dependencies.providerClient
    },
    {
      enabled: env.recoveryEnabled,
      intervalMs: env.recoveryIntervalMs,
      staleMs: env.recoveryStaleMs
    }
  )

  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    recovery?.stop()
    publisherStop.abort()
    server.close(async () => {
      await consumer?.stop()
      await publisher
      await prisma.$disconnect()
    })
    setTimeout(() => process.exit(1), 15000).unref()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

start().catch(error => {
  console.error(JSON.stringify({ code: 'STARTUP_FAILED', message: String(error?.message ?? '') }))
  process.exitCode = 1
})
