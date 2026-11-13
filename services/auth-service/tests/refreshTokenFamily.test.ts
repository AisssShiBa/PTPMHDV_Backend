import './setup'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import bcrypt from 'bcrypt'
import crypto from 'crypto'
import app from '../src/app'
import { prisma } from '../src/config/prisma'

const mockUserId = '11111111-2222-3333-4444-555555555555'
const mockPasswordHash = bcrypt.hashSync('Password123!', 10)
const mockUser = {
  id: mockUserId,
  username: 'dat_security_test',
  email: 'dat.sec@finvault.local',
  firstName: 'Dat',
  lastName: 'Tran',
  password: mockPasswordHash,
  role: 'USER',
  createdAt: new Date()
}

interface MockSession {
  id: string
  refreshToken: string
  familyId: string
  revokedAt: Date | null
  expiresAt: Date
  userId: string
  createdAt: Date
}

test('Kịch bản nghiệm thu S1: Refresh Token Family và Phát hiện Tái sử dụng Token (Nhiệm vụ Đ15b)', async (t) => {
  // Kho lưu trữ phiên giả lập trong RAM
  const sessionDb: MockSession[] = []

  // Lưu lại các hàm gốc của Prisma
  const originalUserFindUnique = prisma.user.findUnique
  const originalSessionCreate = (prisma.session as any).create
  const originalSessionFindUnique = (prisma.session as any).findUnique
  const originalSessionUpdate = (prisma.session as any).update
  const originalSessionUpdateMany = (prisma.session as any).updateMany
  const originalTransaction = prisma.$transaction

  // Mock Prisma User
  prisma.user.findUnique = (async (args: any) => {
    if (args.where?.username === mockUser.username || args.where?.id === mockUser.id) {
      return mockUser
    }
    return null
  }) as any

  // Mock Prisma Session Create
  ;(prisma.session as any).create = (async (args: any) => {
    const session: MockSession = {
      id: crypto.randomUUID(),
      refreshToken: args.data.refreshToken,
      familyId: args.data.familyId || crypto.randomUUID(),
      revokedAt: args.data.revokedAt ?? null,
      expiresAt: args.data.expiresAt,
      userId: args.data.userId,
      createdAt: new Date()
    }
    sessionDb.push(session)
    return { ...session, user: mockUser }
  }) as any

  // Mock Prisma Session FindUnique
  ;(prisma.session as any).findUnique = (async (args: any) => {
    const session = sessionDb.find((s) => s.refreshToken === args.where.refreshToken)
    if (!session) return null
    return { ...session, user: mockUser }
  }) as any

  // Mock Prisma Session Update
  ;(prisma.session as any).update = (async (args: any) => {
    const session = sessionDb.find((s) => s.id === args.where.id)
    if (session) {
      if (args.data.revokedAt !== undefined) {
        session.revokedAt = args.data.revokedAt
      }
    }
    return session
  }) as any

  // Mock Prisma Session UpdateMany
  ;(prisma.session as any).updateMany = (async (args: any) => {
    let count = 0
    for (const session of sessionDb) {
      if (args.where.familyId && session.familyId === args.where.familyId) {
        if (args.data.revokedAt !== undefined) {
          session.revokedAt = args.data.revokedAt
        }
        count++
      }
    }
    return { count }
  }) as any

  // Mock Prisma Transaction
  ;(prisma as any).$transaction = (async (fn: any) => {
    const tx = {
      session: {
        create: (prisma.session as any).create,
        update: (prisma.session as any).update,
        updateMany: (prisma.session as any).updateMany,
        findUnique: (prisma.session as any).findUnique
      }
    }
    return fn(tx)
  }) as any

  t.after(() => {
    prisma.user.findUnique = originalUserFindUnique
    ;(prisma.session as any).create = originalSessionCreate
    ;(prisma.session as any).findUnique = originalSessionFindUnique
    ;(prisma.session as any).update = originalSessionUpdate
    ;(prisma.session as any).updateMany = originalSessionUpdateMany
    ;(prisma as any).$transaction = originalTransaction
  })

  let token1: string = ''
  let familyId: string = ''
  let token2: string = ''
  let token3: string = ''

  await t.test('1. Đăng nhập thành công: Khởi tạo Token Family mới và cấp Refresh Token 1', async () => {
    const res = await request(app)
      .post('/api/auth/signin')
      .set('x-client-platform', 'mobile')
      .send({
        username: mockUser.username,
        password: 'Password123!',
        platform: 'mobile'
      })

    assert.equal(res.status, 200)
    assert.equal(res.body.success, true)
    assert.ok(res.body.data.accessToken)
    assert.ok(res.body.data.refreshToken)

    token1 = res.body.data.refreshToken

    // Kiểm tra trong Database
    assert.equal(sessionDb.length, 1)
    const initialSession = sessionDb[0]
    assert.ok(initialSession.familyId, 'Phiên đăng nhập phải có familyId')
    assert.equal(initialSession.revokedAt, null, 'Phiên mới khởi tạo phải có revokedAt = null')
    familyId = initialSession.familyId
  })

  await t.test('2. Xoay vòng token hợp lệ lần 1 (Token 1 -> Token 2): Giữ nguyên familyId, đánh dấu token 1 đã thu hồi', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('x-client-platform', 'mobile')
      .send({ refreshToken: token1, platform: 'mobile' })

    assert.equal(res.status, 200)
    assert.equal(res.body.success, true)
    assert.ok(res.body.data.accessToken)
    assert.ok(res.body.data.refreshToken)

    token2 = res.body.data.refreshToken
    assert.notEqual(token2, token1, 'Token 2 phải khác Token 1 (đã xoay vòng)')

    // Kiểm tra tính toàn vẹn trong Database
    assert.equal(sessionDb.length, 2)
    const session1 = sessionDb[0]
    const session2 = sessionDb[1]

    assert.ok(session1.revokedAt !== null, 'Session 1 phải có revokedAt != null (đã xoay vòng)')
    assert.equal(session2.revokedAt, null, 'Session 2 mới phải có revokedAt = null')
    assert.equal(session2.familyId, familyId, 'Session 2 phải có CÙNG familyId với Session 1')
  })

  await t.test('3. Xoay vòng token hợp lệ lần 2 (Token 2 -> Token 3): Tiếp tục duy trì chuỗi gia đình', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('x-client-platform', 'mobile')
      .send({ refreshToken: token2, platform: 'mobile' })

    assert.equal(res.status, 200)
    assert.equal(res.body.success, true)

    token3 = res.body.data.refreshToken
    assert.notEqual(token3, token2)

    assert.equal(sessionDb.length, 3)
    const session2 = sessionDb[1]
    const session3 = sessionDb[2]

    assert.ok(session2.revokedAt !== null, 'Session 2 phải được đánh dấu revokedAt')
    assert.equal(session3.revokedAt, null, 'Session 3 đang hoạt động')
    assert.equal(session3.familyId, familyId, 'Session 3 vẫn thuộc cùng familyId')
  })

  await t.test('4. TẤN CÔNG TÁI SỬ DỤNG (S1): Kẻ gian dùng lại Token 1 cũ đã bị xoay vòng', async () => {
    // Kẻ gian cố gắng gửi Token 1 (đã được xoay vòng từ bước 2)
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('x-client-platform', 'mobile')
      .send({ refreshToken: token1, platform: 'mobile' })

    // Phải bị từ chối với HTTP 401 và mã lỗi TOKEN_REUSE_DETECTED
    assert.equal(res.status, 401)
    assert.equal(res.body.success, false)
    assert.equal(res.body.error?.code, 'TOKEN_REUSE_DETECTED')

    // BÁO ĐỘNG ĐỎ: Toàn bộ các phiên trong gia đình (kể cả Token 3 hợp lệ) đều phải bị thu hồi!
    for (const session of sessionDb) {
      if (session.familyId === familyId) {
        assert.ok(
          session.revokedAt !== null,
          `Session ${session.id} trong gia đình phải bị thu hồi revokedAt`
        )
      }
    }
  })

  await t.test('5. Kiểm tra nạn nhân bị khóa phiên: Dùng Token 3 (hợp lệ trước đó) cũng bị từ chối', async () => {
    // Nạn nhân cố gắng làm mới bằng Token 3
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('x-client-platform', 'mobile')
      .send({ refreshToken: token3, platform: 'mobile' })

    // Vì gia đình phiên đã bị thu hồi ở bước 4, Token 3 cũng không thể dùng được nữa
    assert.equal(res.status, 401)
    assert.equal(res.body.error?.code, 'TOKEN_REUSE_DETECTED')
  })

  await t.test('6. Đăng xuất (SignOut): Thu hồi toàn bộ familyId của phiên', async () => {
    // Tạo một phiên mới độc lập cho user
    const resLogin = await request(app)
      .post('/api/auth/signin')
      .set('x-client-platform', 'mobile')
      .send({
        username: mockUser.username,
        password: 'Password123!',
        platform: 'mobile'
      })

    const newRefreshToken = resLogin.body.data.refreshToken
    const newSession = sessionDb[sessionDb.length - 1]
    const newFamilyId = newSession.familyId
    assert.equal(newSession.revokedAt, null)

    // Đăng xuất bằng token mới này
    const resSignOut = await request(app)
      .post('/api/auth/signout')
      .set('x-client-platform', 'mobile')
      .send({ refreshToken: newRefreshToken, platform: 'mobile' })

    assert.equal(resSignOut.status, 200)

    // Toàn bộ session thuộc newFamilyId phải bị đánh dấu revokedAt
    const loggedOutSessions = sessionDb.filter((s) => s.familyId === newFamilyId)
    for (const s of loggedOutSessions) {
      assert.ok(s.revokedAt !== null, 'Session phải bị thu hồi sau khi signOut')
    }
  })
})
