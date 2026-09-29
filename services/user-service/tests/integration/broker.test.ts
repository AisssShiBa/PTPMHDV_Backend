import '../setup'
import { stub } from '../stub'
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import amqp, { ChannelModel, ConfirmChannel } from 'amqplib'
import { prisma } from '../../src/config/prisma'
import { env } from '../../src/config/env'
import { USER_QUEUE, USER_DLQ, handleRegistration } from '../../src/events/consumer'
import { publishConfirmed } from '../../src/events/amqp'
let connection: ChannelModel
let channel: ConfirmChannel
before(async () => {
  assert.ok(process.env.DATABASE_URL?.includes('/finvault_test?schema=user_test'))
  connection = await amqp.connect(env.rabbitmqUrl!)
  channel = await connection.createConfirmChannel()
  channel.on('error', () => {})
  await channel.assertExchange(env.eventExchange, 'topic', { durable: true })
  await channel.assertQueue(USER_QUEUE, { durable: true })
  await channel.assertQueue(USER_DLQ, { durable: true })
  await channel.bindQueue(USER_QUEUE, env.eventExchange, 'user.registered')
})
beforeEach(async () => {
  await channel.purgeQueue(USER_QUEUE); await channel.purgeQueue(USER_DLQ)
  await prisma.consumedEvent.deleteMany(); await prisma.user.deleteMany()
})
after(async () => { await connection.close(); await prisma.$disconnect() })
const event = () => ({ eventId: randomUUID(), eventType: 'user.registered', eventVersion: 1,
  occurredAt: new Date().toISOString(), data: { authUserId: randomUUID(), email: randomUUID() + '@example.com' } })
async function publish(body: unknown) {
  await publishConfirmed(channel, env.eventExchange, 'user.registered', Buffer.from(JSON.stringify(body)), {})
}
test('malformed event is confirmed to DLQ before original disappears', async () => {
  await publish({ invalid: true })
  const message = await channel.get(USER_QUEUE, { noAck: false })
  assert.ok(message)
  await handleRegistration(channel, message, new AbortController().signal)
  const dead = await channel.get(USER_DLQ, { noAck: true })
  assert.ok(dead)
  assert.equal(dead.properties.headers?.['x-failure-code'], 'INVALID_OR_CONFLICTING_EVENT')
  assert.equal(await prisma.user.count(), 0)
})
test('transient DB failure retries with delay and reaches DLQ at the configured limit', async () => {
  stub(prisma, '$transaction', async () => { throw new Error('DB down') })
  await publish(event())
  for (let attempt = 0; attempt <= env.eventMaxRetries; attempt++) {
    const message = await channel.get(USER_QUEUE, { noAck: false })
    assert.ok(message)
    await handleRegistration(channel, message, new AbortController().signal)
  }
  assert.ok(await channel.get(USER_DLQ, { noAck: true }))
  assert.equal((await channel.checkQueue(USER_QUEUE)).messageCount, 0)
})
async function waitUntil(check: () => Promise<boolean>) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) { if (await check()) return; await sleep(100) }
  throw new Error('Timed out waiting for worker')
}
function startWorker() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/events/worker.ts'], { cwd: process.cwd(), env: process.env, stdio: 'ignore', windowsHide: true })
  child.on('error', () => {})
  return child
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill()
  await exited
}
test('consumer process restart drains persisted messages and replay remains idempotent', async () => {
  const message = event()
  await publish(message) // Queue while worker is down.
  let worker = startWorker()
  try {
    await waitUntil(async () => await prisma.user.count() === 1)
    await stop(worker)
    await waitUntil(async () => (await channel.checkQueue(USER_QUEUE)).consumerCount === 0)
    await publish(message)
    worker = startWorker()
    await waitUntil(async () => (await channel.checkQueue(USER_QUEUE)).consumerCount === 1 && (await channel.checkQueue(USER_QUEUE)).messageCount === 0)
    await sleep(300)
    assert.equal(await prisma.user.count(), 1)
    assert.equal(await prisma.consumedEvent.count(), 1)
  } finally { await stop(worker) }
})
