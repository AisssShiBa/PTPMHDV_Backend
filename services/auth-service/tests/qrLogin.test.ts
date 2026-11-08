import './setup'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import app from '../src/app'
import { redisClient } from '../src/config/redis'
import { prisma } from '../src/config/prisma'

const mockUserId = '11111111-2222-3333-4444-555555555555'
const mockUser = {
  id: mockUserId,
  username: 'test_dat',
  email: 'dat@finvault.local',
  firstName: 'Dat',
  lastName: 'Tran',
  role: 'USER'
}

test('Kịch bản nghiệm thu Q1: Toàn bộ vòng đời QR Login và kiểm soát bảo mật', async (t) => {
  // Bộ nhớ RAM giả lập cho Redis trong quá trình chạy test độc lập
  const memoryStore = new Map<string, string>()

  // Mock các thao tác cơ bản của Redis
  t.mock.method(redisClient, 'set', async (key: string, value: string) => {
    memoryStore.set(key, value)
    return 'OK'
  })

  t.mock.method(redisClient, 'get', async (key: string) => {
    return memoryStore.get(key) || null
  })

  t.mock.method(redisClient, 'del', async (key: string) => {
    const existed = memoryStore.has(key) ? 1 : 0
    memoryStore.delete(key)
    return existed
  })

  // Mock Lua script nguyên tử của confirmQr
  t.mock.method(redisClient, 'eval', async (_script: string, _numKeys: number, key: string, nonce: string, userId: string) => {
    const raw = memoryStore.get(key)
    if (!raw) return -1 // Hết hạn hoặc không tồn tại (410)
    const data = JSON.parse(raw)
    if (data.status !== 'PENDING') return -2 // Đã được xử lý trước đó (409)
    if (data.nonce !== nonce) return -3 // Nonce không khớp (403)
    data.status = 'APPROVED'
    data.userId = userId
    memoryStore.set(key, JSON.stringify(data))
    return 1 // Thành công
  })

  // Mock Database Prisma trực tiếp
  const originalFindUnique = prisma.user.findUnique
  const originalSessionCreate = (prisma as any).session.create

  prisma.user.findUnique = (async () => mockUser) as any
  ;(prisma as any).session.create = (async (args: any) => ({ id: 'mock-session-id', ...args.data })) as any

  t.after(() => {
    prisma.user.findUnique = originalFindUnique
    ;(prisma as any).session.create = originalSessionCreate
  })

  // Tạo token đăng nhập giả lập cho Mobile User
  const mobileToken = 'Bearer ' + jwt.sign(
    { userId: mockUserId, role: 'USER' },
    process.env.ACCESS_TOKEN_SECRET!,
    { expiresIn: '15m' }
  )

  // --------------------------------------------------------------------------
  // BƯỚC 1: Web khởi tạo mã QR mới (POST /api/auth/qr-login/init)
  // --------------------------------------------------------------------------
  const initRes = await request(app)
    .post('/api/auth/qr-login/init')
    .expect(201)

  assert.equal(initRes.body.success, true)
  assert.ok(initRes.body.data.qrId, 'Phải có qrId')
  assert.ok(initRes.body.data.nonce, 'Phải có nonce')
  assert.ok(initRes.body.data.pollSecret, 'Phải có pollSecret')
  assert.ok(initRes.body.data.expiresAt, 'Phải có expiresAt')

  const { qrId, nonce, pollSecret } = initRes.body.data

  // --------------------------------------------------------------------------
  // BƯỚC 2: Web thăm dò trạng thái khi đang chờ (Polling PENDING)
  // --------------------------------------------------------------------------
  // 2.1. Thử gọi mà thiếu pollSecret -> phải trả về 400 Bad Request
  await request(app)
    .get(`/api/auth/qr-login/${qrId}/status`)
    .expect(400)

  // 2.2. Thử gọi với pollSecret sai -> phải trả về 403 Forbidden
  await request(app)
    .get(`/api/auth/qr-login/${qrId}/status`)
    .set({ 'x-poll-secret': 'wrong-poll-secret' })
    .expect(403)

  // 2.3. Gọi đúng pollSecret khi Mobile chưa quét -> trả về 200 PENDING
  const pendingRes = await request(app)
    .get(`/api/auth/qr-login/${qrId}/status`)
    .set({ 'x-poll-secret': pollSecret })
    .expect(200)

  assert.equal(pendingRes.body.data.status, 'PENDING')

  // --------------------------------------------------------------------------
  // BƯỚC 3: Mobile xác nhận với Nonce sai -> Phải trả về 403
  // --------------------------------------------------------------------------
  const wrongNonceRes = await request(app)
    .post('/api/auth/qr-login/confirm')
    .set({ authorization: mobileToken })
    .send({ qrId, nonce: 'wrong-nonce-123' })
    .expect(403)

  assert.equal(wrongNonceRes.body.error.code, 'INVALID_NONCE')

  // --------------------------------------------------------------------------
  // BƯỚC 4: Mobile xác nhận hợp lệ thành công (POST /api/auth/qr-login/confirm)
  // --------------------------------------------------------------------------
  const confirmRes = await request(app)
    .post('/api/auth/qr-login/confirm')
    .set({ authorization: mobileToken })
    .send({ qrId, nonce })
    .expect(200)

  assert.equal(confirmRes.body.success, true)

  // --------------------------------------------------------------------------
  // BƯỚC 5: Hai mobile cùng bấm xác nhận 1 mã QR -> Mobile thứ 2 phải bị 409
  // --------------------------------------------------------------------------
  const duplicateConfirmRes = await request(app)
    .post('/api/auth/qr-login/confirm')
    .set({ authorization: mobileToken })
    .send({ qrId, nonce })
    .expect(409)

  assert.equal(duplicateConfirmRes.body.error.code, 'QR_ALREADY_PROCESSED')

  // --------------------------------------------------------------------------
  // BƯỚC 6: Web thăm dò nhận phiên đăng nhập thành công (Lần 1)
  // --------------------------------------------------------------------------
  const approvedRes = await request(app)
    .get(`/api/auth/qr-login/${qrId}/status`)
    .set({ 'x-poll-secret': pollSecret })
    .expect(200)

  assert.equal(approvedRes.body.data.status, 'APPROVED')
  assert.ok(approvedRes.body.data.accessToken, 'Phải có Access Token')
  assert.equal(approvedRes.body.data.user.id, mockUserId)

  // Kiểm tra cookie refreshToken đã được gắn đúng HTTP-Only
  const cookies = approvedRes.headers['set-cookie']
  assert.ok(cookies, 'Phải có Set-Cookie')
  assert.ok(cookies[0].includes('refreshToken='), 'Cookie phải chứa refreshToken')
  assert.ok(cookies[0].includes('HttpOnly'), 'Cookie phải có cờ HttpOnly chống XSS')

  // --------------------------------------------------------------------------
  // BƯỚC 7: Web cố tình dùng lại mã QR đã cấp phiên (Lần 2) -> Bị 410 QR_EXPIRED
  // --------------------------------------------------------------------------
  const reuseRes = await request(app)
    .get(`/api/auth/qr-login/${qrId}/status`)
    .set({ 'x-poll-secret': pollSecret })
    .expect(410)

  assert.equal(reuseRes.body.error.code, 'QR_EXPIRED')

  // --------------------------------------------------------------------------
  // BƯỚC 8: Kiểm tra mã QR không tồn tại hoặc hết hạn 120s -> Trả về 410
  // --------------------------------------------------------------------------
  const expiredRes = await request(app)
    .get('/api/auth/qr-login/non-existent-qr-id/status')
    .set({ 'x-poll-secret': 'any-secret' })
    .expect(410)

  assert.equal(expiredRes.body.error.code, 'QR_EXPIRED')
})
