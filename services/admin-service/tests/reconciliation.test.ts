import './setup'
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import request from 'supertest'
import { createTestGatewayToken } from 'finvault-internal-auth'
import app from '../src/app'
import { prisma } from '../src/config/prisma'
import {
  setWalletReconciliationClient,
  WalletReconciliationClient
} from '../src/services/walletReconciliationClient'
import {
  startFakeWallet,
  walletError,
  walletOk,
  type FakeWallet,
  type FakeWalletHandler
} from './walletFake'

const ADMIN_ID = '33333333-3333-4333-8333-333333333333'
const adminToken = () => createTestGatewayToken(ADMIN_ID, 'ADMIN')
const userToken = () => createTestGatewayToken(ADMIN_ID, 'USER')

const report = (id: number, isFull = false) => ({
  id,
  runAt: '2026-11-06T10:00:00.000Z',
  totalWallets: isFull ? 10 : 3,
  anomaliesFound: 0,
  systemBalanceExpected: '0.00',
  systemBalanceActual: '0.00',
  isBalanced: true,
  anomalies: []
})

const defaultHandler: FakeWalletHandler = request => {
  if (request.path === '/api/wallets/admin/reconciliation') {
    return walletOk(report(7, request.query.get('isFull') === 'true'))
  }
  if (request.path === '/api/wallets/admin/reconciliation/reports') {
    return walletOk({
      items: [report(1)],
      page: Number(request.query.get('page')),
      limit: Number(request.query.get('limit')),
      total: 1
    })
  }
  const reportMatch = /^\/api\/wallets\/admin\/reconciliation\/reports\/(\d+)$/.exec(request.path)
  if (reportMatch) {
    const id = Number(reportMatch[1])
    return id === 999 ? walletError(404, 'REPORT_NOT_FOUND') : walletOk(report(id))
  }
  const adjustMatch = /^\/api\/wallets\/admin\/reconciliation\/anomalies\/\d+\/adjust$/.exec(
    request.path
  )
  if (adjustMatch) {
    return walletOk({ transactionId: 'tx-1', replayed: false })
  }
  return walletError(404, 'NOT_FOUND')
}

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

let fake: FakeWallet

before(async () => {
  fake = await startFakeWallet(defaultHandler)
  setWalletReconciliationClient(new WalletReconciliationClient(fake.url, 3000))
})

after(async () => {
  await fake.close()
  await prisma.$disconnect()
})

beforeEach(async () => {
  await prisma.anomalyAdjustment.deleteMany()
  await prisma.reconciliationRunLog.deleteMany()
  await prisma.adminAuditLog.deleteMany()
  fake.requests.length = 0
  fake.setHandler(defaultHandler)
})

const runRequest = (mode?: string, token = adminToken()) => {
  const path = mode === undefined ? '/api/admin/reconciliation/run' : `/api/admin/reconciliation/run?mode=${mode}`
  return request(app).post(path).set('x-gateway-token', token)
}

test('run defaults to quick, forwards the Gateway token and writes PENDING audit before the wallet call', async () => {
  let pendingBeforeCall = 0
  fake.setHandler(async () => {
    pendingBeforeCall = await prisma.adminAuditLog.count({
      where: { action: 'RUN_RECONCILIATION', detail: { contains: '"outcome":"PENDING"' } }
    })
    return walletOk(report(7))
  })
  const token = adminToken()

  const response = await runRequest(undefined, token)

  assert.equal(response.status, 200)
  assert.equal(response.body.data.id, 7)
  assert.equal(pendingBeforeCall, 1)
  assert.equal(fake.requests.length, 1)
  assert.equal(fake.requests[0].query.get('isFull'), 'false')
  assert.equal(fake.requests[0].headers['x-gateway-token'], token)
  assert.equal(fake.requests[0].headers['x-internal-key'], undefined)

  const runLog = await prisma.reconciliationRunLog.findFirstOrThrow()
  assert.equal(runLog.mode, 'QUICK')
  assert.equal(runLog.status, 'SUCCEEDED')
  assert.equal(runLog.walletReportId, '7')
  assert.equal(runLog.adminId, ADMIN_ID)
  assert.equal(runLog.isBalanced, true)

  const audit = await prisma.adminAuditLog.findFirstOrThrow({
    where: { action: 'RUN_RECONCILIATION' }
  })
  const detail = JSON.parse(audit.detail ?? '{}')
  assert.equal(detail.outcome, 'SUCCEEDED')
  assert.equal(detail.mode, 'quick')
  assert.equal(JSON.stringify(detail).includes(token), false)
})

test('run with mode=full sends isFull=true', async () => {
  const response = await runRequest('full')

  assert.equal(response.status, 200)
  assert.equal(fake.requests[0].query.get('isFull'), 'true')
  const runLog = await prisma.reconciliationRunLog.findFirstOrThrow()
  assert.equal(runLog.mode, 'FULL')
})

test('run with an unknown mode is rejected without calling the wallet', async () => {
  const response = await runRequest('abc')

  assert.equal(response.status, 400)
  assert.equal(response.body.error.code, 'INVALID_MODE')
  assert.equal(fake.requests.length, 0)
  assert.equal(await prisma.reconciliationRunLog.count(), 0)
})

test('a wallet 5xx returns 502, leaves the audit UNKNOWN and never logs the token', async () => {
  fake.setHandler(() => walletError(500, 'WALLET_DOWN'))
  const token = adminToken()
  const logs: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    logs.push(args.map(value => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '))
  }
  let response
  try {
    response = await runRequest('quick', token)
  } finally {
    console.error = original
  }

  assert.equal(response.status, 502)
  assert.equal(response.body.error.code, 'WALLET_UNAVAILABLE')
  assert.equal(logs.join('\n').includes(token), false)

  const audit = await prisma.adminAuditLog.findFirstOrThrow()
  assert.equal(JSON.parse(audit.detail ?? '{}').outcome, 'UNKNOWN')
  const runLog = await prisma.reconciliationRunLog.findFirstOrThrow()
  assert.equal(runLog.status, 'UNKNOWN')
  assert.equal(runLog.walletReportId, null)
})

test('a wallet 403 is returned as a generic 403 without leaking wallet details', async () => {
  fake.setHandler(() => walletError(403, 'ADMIN_ONLY'))

  const response = await runRequest()

  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'FORBIDDEN')
  assert.equal(response.body.error.message, 'Wallet service denied the request')
  const audit = await prisma.adminAuditLog.findFirstOrThrow()
  assert.equal(JSON.parse(audit.detail ?? '{}').outcome, 'REJECTED')
})

test('two concurrent runs for the same mode allow only one wallet call', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  fake.setHandler(async () => {
    await gate
    return walletOk(report(8))
  })

  const first = runRequest('quick')
  const firstPromise = first.then(response => response)

  let second: Awaited<ReturnType<typeof runRequest>>
  try {
    await waitFor(() => fake.requests.length === 1)
    second = await runRequest('quick')
  } finally {
    release()
  }
  const firstResponse = await firstPromise

  assert.equal(firstResponse.status, 200)
  assert.equal(second.status, 409)
  assert.equal(second.body.error.code, 'RECONCILIATION_IN_PROGRESS')
  assert.equal(fake.requests.length, 1)
  assert.equal(await prisma.reconciliationRunLog.count({ where: { status: 'SUCCEEDED' } }), 1)
})

test('reconciliation routes require a Gateway token and the ADMIN role', async () => {
  const missing = await request(app).post('/api/admin/reconciliation/run')
  assert.equal(missing.status, 401)

  const forbidden = await runRequest(undefined, userToken())
  assert.equal(forbidden.status, 403)
  assert.equal(fake.requests.length, 0)
})

test('reports pagination clamps limit to 100 and forwards page', async () => {
  const response = await request(app)
    .get('/api/admin/reconciliation/reports?page=2&limit=500')
    .set('x-gateway-token', adminToken())

  assert.equal(response.status, 200)
  assert.equal(fake.requests[0].query.get('page'), '2')
  assert.equal(fake.requests[0].query.get('limit'), '100')
  assert.equal(response.body.data.limit, 100)
})

test('a non-numeric report id is a 400 and a missing report is a 404', async () => {
  const invalid = await request(app)
    .get('/api/admin/reconciliation/reports/abc')
    .set('x-gateway-token', adminToken())
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'INVALID_REPORT_ID')
  assert.equal(fake.requests.length, 0)

  const missing = await request(app)
    .get('/api/admin/reconciliation/reports/999')
    .set('x-gateway-token', adminToken())
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'NOT_FOUND')
})

test('a valid report id proxies the wallet report', async () => {
  const response = await request(app)
    .get('/api/admin/reconciliation/reports/12')
    .set('x-gateway-token', adminToken())

  assert.equal(response.status, 200)
  assert.equal(response.body.data.id, 12)
})

const adjustRequest = (body: unknown, id = 123) =>
  request(app)
    .post(`/api/admin/reconciliation/anomalies/${id}/adjust`)
    .set('x-gateway-token', adminToken())
    .send(body as object)

test('adjust rejects a missing, blank or too-short reason before calling the wallet', async () => {
  const bodies = [
    { direction: 'CREDIT', amount: '50000' },
    { direction: 'CREDIT', amount: '50000', reason: '' },
    { direction: 'CREDIT', amount: '50000', reason: '    ' },
    { direction: 'CREDIT', amount: '50000', reason: 'abcd' }
  ]

  for (const body of bodies) {
    const response = await adjustRequest(body)
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal(response.body.error.code, 'REASON_REQUIRED')
  }

  assert.equal(fake.requests.length, 0)
  assert.equal(await prisma.anomalyAdjustment.count(), 0)
})

test('adjust rejects an invalid amount or direction without calling the wallet', async () => {
  for (const body of [
    { direction: 'CREDIT', amount: 50000, reason: 'valid reason' },
    { direction: 'CREDIT', amount: '0', reason: 'valid reason' },
    { direction: 'CREDIT', amount: '-1', reason: 'valid reason' },
    { direction: 'CREDIT', amount: '10.5', reason: 'valid reason' },
    { direction: 'UP', amount: '50000', reason: 'valid reason' }
  ]) {
    const response = await adjustRequest(body)
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.ok(['INVALID_AMOUNT', 'INVALID_DIRECTION'].includes(response.body.error.code))
  }
  assert.equal(fake.requests.length, 0)
})

test('a successful adjust persists SUCCEEDED, the fixed referenceId and the wallet transaction', async () => {
  let pendingBeforeCall = 0
  fake.setHandler(async request => {
    if (request.path === '/api/wallets/admin/reconciliation/anomalies/123/adjust') {
      pendingBeforeCall = await prisma.adminAuditLog.count({
        where: { action: 'ADJUST_ANOMALY', detail: { contains: '"outcome":"PENDING"' } }
      })
      return walletOk({ transactionId: 'tx-42', replayed: false })
    }
    return walletError(404, 'NOT_FOUND')
  })

  const response = await adjustRequest({
    direction: 'CREDIT',
    amount: '50000',
    reason: 'Correcting a negative balance'
  })

  assert.equal(response.status, 200)
  assert.equal(response.body.data.status, 'SUCCEEDED')
  assert.equal(response.body.data.referenceId, 'adjust-anomaly-123')
  assert.equal(response.body.data.transactionId, 'tx-42')
  assert.equal(pendingBeforeCall, 1)

  assert.equal(fake.requests.length, 1)
  assert.equal(fake.requests[0].headers['x-internal-key'], undefined)
  assert.deepEqual(fake.requests[0].body, {
    direction: 'CREDIT',
    amount: '50000',
    reason: 'Correcting a negative balance',
    referenceId: 'adjust-anomaly-123'
  })

  const adjustment = await prisma.anomalyAdjustment.findUniqueOrThrow({
    where: { anomalyId: '123' }
  })
  assert.equal(adjustment.status, 'SUCCEEDED')
  assert.equal(adjustment.referenceId, 'adjust-anomaly-123')
  assert.equal(adjustment.walletTransactionId, 'tx-42')
  assert.equal(adjustment.adminId, ADMIN_ID)

  const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'ADJUST_ANOMALY' } })
  const detail = JSON.parse(audit.detail ?? '{}')
  assert.equal(detail.outcome, 'SUCCEEDED')
  assert.equal(detail.reason, 'Correcting a negative balance')
  assert.equal(detail.transactionId, 'tx-42')
})

test('adjusting the same anomaly twice returns ALREADY_ADJUSTED and calls the wallet once', async () => {
  const body = { direction: 'DEBIT', amount: '10000', reason: 'Duplicate debit correction' }

  const first = await adjustRequest(body)
  const second = await adjustRequest(body)

  assert.equal(first.status, 200)
  assert.equal(second.status, 409)
  assert.equal(second.body.error.code, 'ALREADY_ADJUSTED')
  assert.equal(fake.requests.length, 1)
})

test('ten concurrent adjustments for one anomaly call the wallet exactly once', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  fake.setHandler(async () => {
    await gate
    return walletOk({ transactionId: 'tx-concurrent', replayed: false })
  })

  const body = { direction: 'CREDIT', amount: '7000', reason: 'Concurrent anomaly correction' }
  const pending = Array.from({ length: 10 }, () => adjustRequest(body).then(response => response))
  try {
    await waitFor(() => fake.requests.length === 1)
  } finally {
    release()
  }
  const responses = await Promise.all(pending)

  assert.equal(responses.filter(response => response.status === 200).length, 1)
  assert.ok(responses.filter(response => response.status === 409).length === 9)
  assert.equal(fake.requests.length, 1)
})

test('adjust returns AUDIT_UNAVAILABLE and never calls the wallet when the audit cannot be written', async () => {
  const original = prisma.adminAuditLog.create
  ;(prisma.adminAuditLog as unknown as { create: unknown }).create = async () => {
    throw new Error('audit database unavailable')
  }
  let response
  try {
    response = await adjustRequest({
      direction: 'CREDIT',
      amount: '50000',
      reason: 'Audit failure test'
    })
  } finally {
    ;(prisma.adminAuditLog as unknown as { create: unknown }).create = original
  }

  assert.equal(response.status, 503)
  assert.equal(response.body.error.code, 'AUDIT_UNAVAILABLE')
  assert.equal(fake.requests.length, 0)
  assert.equal(await prisma.anomalyAdjustment.count(), 0)
})

test('a wallet 5xx leaves the adjustment UNKNOWN, returns 503 and does not retry automatically', async () => {
  fake.setHandler(() => walletError(500, 'WALLET_DOWN'))
  const token = adminToken()
  const logs: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    logs.push(args.map(value => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '))
  }
  let first
  let second
  try {
    first = await request(app)
      .post('/api/admin/reconciliation/anomalies/456/adjust')
      .set('x-gateway-token', token)
      .send({ direction: 'CREDIT', amount: '50000', reason: 'Wallet failure test' })
    second = await request(app)
      .post('/api/admin/reconciliation/anomalies/456/adjust')
      .set('x-gateway-token', token)
      .send({ direction: 'CREDIT', amount: '50000', reason: 'Wallet failure test' })
  } finally {
    console.error = original
  }

  assert.equal(first.status, 503)
  assert.equal(first.body.error.code, 'ADJUST_OUTCOME_UNKNOWN')
  assert.equal(second.status, 409)
  assert.equal(second.body.error.code, 'ADJUSTMENT_OUTCOME_UNKNOWN')
  assert.equal(fake.requests.length, 1)
  assert.equal(logs.join('\n').includes(token), false)

  const adjustment = await prisma.anomalyAdjustment.findUniqueOrThrow({
    where: { anomalyId: '456' }
  })
  assert.equal(adjustment.status, 'UNKNOWN')
  const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'ADJUST_ANOMALY' } })
  assert.equal(JSON.parse(audit.detail ?? '{}').outcome, 'UNKNOWN')
})
