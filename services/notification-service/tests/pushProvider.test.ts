import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LogPushProvider } from '../src/services/pushProvider'

test('LogPushProvider reports delivery without ever logging the push token', async () => {
  const lines: string[] = []
  const provider = new LogPushProvider({ log: message => lines.push(message) })
  const pushToken = 'SECRET-TOKEN-123'

  const result = await provider.send({
    userId: '00000000-0000-4000-8000-000000000001',
    deviceId: 'device-1',
    title: 'Nạp tiền',
    body: 'Giao dịch thành công'
  })

  assert.equal(result.delivered, true)
  assert.equal(lines.join('\n').includes(pushToken), false)
})

test('LogPushProvider rejects an empty identity instead of logging it', async () => {
  const provider = new LogPushProvider({ log: () => undefined })
  await assert.rejects(
    provider.send({ userId: '', deviceId: 'device-1', title: 'x', body: 'y' }),
    TypeError
  )
})
