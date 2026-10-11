// Full acceptance: production UI -> real Gateway/services -> PostgreSQL + private MinIO.
// No fixture responses or mocked persistence. Only one outgoing header is changed
// to exercise an expired JWT; the 401 and refresh responses come from real services.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runtime, config, serviceDir, serviceEnv } from './config.mjs'
import { call, login, evidence } from './live-client.mjs'
import { openBrowser, until } from './browser.mjs'

const accounts = JSON.parse(readFileSync(resolve(runtime, 'accounts.json'), 'utf8'))
const checks = []
const started = new Date().toISOString()
let browser
let secondBrowser
let subject
let admin
let outsider
let profile
let merchant
let signedDocument
let documentIssuedAt
let database
async function check(name, fn) {
  const time = Date.now()
  await fn()
  checks.push({ name, result: 'PASS', durationMs: Date.now() - time })
  console.log('PASS ' + name)
}
async function signInUi(target) {
  await until(() => target.has('#username'), 'signin form')
  await target.fill('#username', accounts.user.username)
  await target.fill('#password', accounts.user.password)
  await target.evaluate('document.querySelector("form").requestSubmit()')
  await until(() => target.evaluate('location.pathname !== "/signin"'), 'signin succeeds')
}
function uploadBody(idNumber = 'BTEST1234567', file = new File([readFileSync(resolve(runtime, 'test-document.png'))], 'acceptance.png', { type: 'image/png' })) {
  const body = new FormData()
  body.append('idNumber', idNumber)
  body.append('document', file)
  return body
}
try {
  browser = await openBrowser(runtime, 'primary')
  await check('UI signup creates Auth account and User Profile in PostgreSQL', async () => {
    await browser.go('/signup')
    await until(() => browser.has('#email'), 'signup form')
    for (const name of ['username', 'password', 'email', 'firstName', 'lastName']) await browser.fill('#' + name, accounts.user[name])
    await browser.evaluate('document.querySelector("form").requestSubmit()')
    await until(() => browser.evaluate('location.pathname === "/signin"'), 'signup redirect', 25000)
    subject = await login(accounts.user)
    accounts.user.id = subject.user.id
    writeFileSync(resolve(runtime, 'accounts.json'), JSON.stringify(accounts, null, 2))
    profile = (await call('/users/by-auth/' + subject.user.id, { token: subject.token })).data
    assert.equal(profile.authUserId, subject.user.id)
    assert.equal(profile.email, accounts.user.email)
    assert.equal(profile.kycStatus, 'NONE')
    admin = await login(accounts.admin)
    outsider = await login(accounts.outside || accounts.outsider)
    assert.equal(admin.user.role, 'ADMIN')
  })
  await check('UI login, protected profile, HttpOnly refresh cookie and reload', async () => {
    await signInUi(browser)
    await browser.go('/profile')
    await until(() => browser.has('#profile-email'), 'profile data')
    assert.equal(await browser.evaluate('document.querySelector("#profile-email").readOnly'), true)
    const cookies = await browser.cdp('Network.getCookies', { urls: ['http://localhost:5173/api/auth/refresh'] })
    assert.ok(cookies.cookies.some((cookie) => cookie.name === 'refreshToken' && cookie.httpOnly && cookie.path === '/api/auth'))
    await browser.go('/profile')
    await until(() => browser.has('#profile-email'), 'reload restored session')
  })
  await check('Profile edit persists after reload; email mutation is rejected', async () => {
    await browser.fill('#profile-fullName', 'Hữu nghiệm thu thật')
    await browser.fill('#profile-phone', '+84 912 345 678')
    await browser.fill('#profile-address', 'Địa chỉ thử nghiệm FinVault')
    await browser.click('Lưu thông tin', 2)
    await until(() => browser.text('Đã cập nhật hồ sơ'), 'profile saved')
    await browser.go('/profile')
    await until(() => browser.evaluate('document.querySelector("#profile-phone")?.value === "+84 912 345 678"'), 'phone persisted')
    profile = (await call('/users/by-auth/' + subject.user.id, { token: subject.token })).data
    assert.equal(profile.fullName, 'Hữu nghiệm thu thật')
    await call('/users/by-auth/' + subject.user.id, { method: 'PUT', token: subject.token, body: { email: 'changed@example.test' }, expected: 400 })
    await call('/users/by-auth/' + subject.user.id, { method: 'PUT', token: subject.token, body: { phone: 'x'.repeat(31) }, expected: 400 })
  })
  await check('Backend rejects missing, invalid and oversized KYC files', async () => {
    const path = '/users/by-auth/' + subject.user.id + '/kyc'
    const missing = new FormData()
    missing.append('idNumber', 'BTEST')
    await call(path, { method: 'POST', token: subject.token, body: missing, expected: 400 })
    await call(path, { method: 'POST', token: subject.token, body: uploadBody('BTEST', new File(['not an image'], 'invalid.png', { type: 'image/png' })), expected: 400 })
    await call(path, { method: 'POST', token: subject.token, body: uploadBody('BTEST', new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })), expected: 413 })
  })
  await check('UI uploads real multipart KYC to private MinIO, locks pending form', async () => {
    await browser.fill('#kyc-number', 'BTEST1234567')
    await browser.upload('#kyc-file', resolve(runtime, 'test-document.png'))
    await until(() => browser.has('img[alt="Xem trước giấy tờ đã chọn"]'), 'KYC preview')
    await browser.fill('#profile-fullName', 'Bản nháp chưa lưu')
    await browser.click('Gửi xác thực', 2)
    await until(() => browser.text('Đang chờ duyệt'), 'KYC pending', 25000)
    assert.equal(await browser.has('#kyc-file'), false)
    assert.equal(await browser.evaluate('document.querySelector("#profile-fullName").value'), 'Bản nháp chưa lưu')
    assert.equal(browser.network.filter((item) => item.method === 'POST' && item.path.endsWith('/kyc') && item.status === 200).length, 1)
    await browser.click('Xem giấy tờ đã gửi')
    await until(() => browser.evaluate('(() => { const img = document.querySelector(' + JSON.stringify('img[alt="Giấy tờ xác thực đã gửi"]') + '); return img && img.complete && img.naturalWidth > 0 })()'), 'real stored image')
    const document = await call('/users/by-auth/' + subject.user.id + '/kyc/document', { token: subject.token })
    signedDocument = document.data.url
    documentIssuedAt = Date.now()
    assert.equal(document.data.expiresIn, 60)
    const stored = await fetch(signedDocument)
    assert.equal(stored.status, 200)
    assert.ok(stored.headers.get('content-type').includes('image/jpeg'))
    const privateUrl = new URL(signedDocument); privateUrl.search = ''
    assert.equal((await fetch(privateUrl)).status, 403)
    await browser.screenshot('live-kyc-pending')
  })
  await check('Real Admin rejects KYC; UI reloads rejected state and resubmits', async () => {
    const result = await call('/admin/kyc/' + profile.id + '/review', { method: 'POST', token: admin.token, body: { status: 'REJECTED', detail: 'Acceptance rejection/resubmission check' } })
    assert.ok(result.body.auditLog)
    await browser.click('Tải lại trạng thái')
    await until(() => browser.has('#kyc-file'), 'rejected form')
    assert.ok(await browser.text('Bị từ chối'))
    await browser.fill('#kyc-number', '012345678901')
    await browser.upload('#kyc-file', resolve(runtime, 'test-document.png'))
    await browser.click('Gửi xác thực')
    await until(() => browser.text('Đang chờ duyệt'), 'KYC resubmitted')
  })
  await check('Real Admin approves KYC; UI reflects it and backend rejects resubmission', async () => {
    const result = await call('/admin/kyc/' + profile.id + '/review', { method: 'POST', token: admin.token, body: { status: 'APPROVED', detail: 'Acceptance approval' } })
    assert.ok(result.body.auditLog)
    await browser.click('Tải lại trạng thái')
    await until(() => browser.text('Đã xác thực'), 'KYC approved')
    assert.equal(await browser.has('#kyc-file'), false)
    await call('/users/by-auth/' + subject.user.id + '/kyc', { method: 'POST', token: subject.token, body: uploadBody(), expected: 409 })
    await browser.screenshot('live-profile-desktop')
  })
  await check('Expired access token produces real 401, refresh and successful replay', async () => {
    const require = createRequire(serviceDir('auth') + '/package.json')
    const jwt = require('jsonwebtoken')
    const expired = jwt.sign({ userId: subject.user.id, role: 'USER' }, config().jwtSecret, { expiresIn: -1 })
    const initial = browser.network.length
    let injected = false
    let injectionError
    browser.on('Fetch.requestPaused', async (event) => {
      try {
        if (!injected && event.request.url.includes('/api/users/by-auth/')) {
          injected = true
          const headers = Object.entries(event.request.headers).filter(([key]) => key.toLowerCase() !== 'authorization').map(([name, value]) => ({ name, value: String(value) }))
          headers.push({ name: 'Authorization', value: 'Bearer ' + expired })
          await browser.cdp('Fetch.continueRequest', { requestId: event.requestId, headers })
        } else await browser.cdp('Fetch.continueRequest', { requestId: event.requestId })
      } catch (error) { injectionError = error }
    })
    await browser.cdp('Fetch.enable', { patterns: [{ urlPattern: '*api/users/by-auth/*', requestStage: 'Request' }] })
    await browser.click('Tải lại trạng thái')
    await until(() => browser.has('#profile-email'), '401 refresh and retry')
    await browser.cdp('Fetch.disable')
    if (injectionError) throw injectionError
    const trace = browser.network.slice(initial)
    assert.ok(injected)
    assert.ok(trace.some((item) => item.path.includes('/users/by-auth/') && item.status === 401))
    assert.ok(trace.some((item) => item.path === '/api/auth/refresh' && item.status === 200))
    assert.ok(trace.some((item) => item.path.includes('/users/by-auth/') && item.status === 200))
  })
  await check('Merchant UI registers once; data persists after reload', async () => {
    await browser.go('/merchant-register')
    await until(() => browser.has('#merchant-businessName'), 'merchant empty state')
    await browser.fill('#merchant-businessName', 'Đối tác nghiệm thu ' + accounts.user.username)
    await browser.click('Gửi đăng ký đối tác', 2)
    await until(() => browser.text('Đang chờ duyệt'), 'merchant registered')
    await browser.go('/merchant-register')
    await until(() => browser.text('Đang chờ duyệt'), 'merchant reload')
    assert.equal(await browser.has('#merchant-businessName'), false)
    merchant = (await call('/merchants/me', { token: subject.token })).data
    assert.equal(merchant.ownerId, subject.user.id)
    assert.equal(merchant.status, 'PENDING')
    assert.equal(browser.network.filter((item) => item.path === '/api/merchants/register' && item.method === 'POST').length, 1)
    await call('/merchants/register', { method: 'POST', token: subject.token, body: { businessName: 'Duplicate' }, expected: 409 })
  })
  await check('Real Admin approves/rejects Merchant; UI reloads both states', async () => {
    for (const [status, label] of [['APPROVED', 'Đã được phê duyệt'], ['REJECTED', 'Đăng ký bị từ chối']]) {
      const result = await call('/admin/merchants/' + merchant.id + '/review', { method: 'POST', token: admin.token, body: { status, detail: 'Acceptance merchant status' } })
      assert.ok(result.body.auditLog)
      await browser.click('Tải lại trạng thái')
      await until(() => browser.text(label), 'merchant ' + status)
    }
    // Return the test merchant to approved using the documented transition.
    await call('/merchants/' + merchant.id + '/status', { method: 'PATCH', token: admin.token, body: { status: 'PENDING' } })
    await call('/admin/merchants/' + merchant.id + '/review', { method: 'POST', token: admin.token, body: { status: 'APPROVED' } })
    await browser.click('Tải lại trạng thái')
    await until(() => browser.text('Đã được phê duyệt'), 'merchant final approval')
  })
  await check('Ownership and Admin authorization enforced by real Gateway/services', async () => {
    await call('/users/by-auth/' + subject.user.id, { token: outsider.token, expected: 403 })
    await call('/users/by-auth/' + subject.user.id + '/kyc/document', { token: outsider.token, expected: 403 })
    await call('/merchants/' + merchant.id, { token: outsider.token, expected: 403 })
    const mine = await call('/merchants/me?ownerId=' + subject.user.id, { token: outsider.token })
    assert.equal(mine.data, null)
    await call('/admin/kyc/' + profile.id + '/review', { method: 'POST', token: subject.token, body: { status: 'REJECTED' }, expected: 403 })
    await call('/merchants/' + merchant.id + '/status', { method: 'PATCH', token: subject.token, body: { status: 'REJECTED' }, expected: 403 })
  })
  await check('Mobile layout and real network error/retry keep Merchant state correct', async () => {
    await browser.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
    await browser.screenshot('live-merchant-mobile')
    await browser.cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await browser.click('Tải lại trạng thái')
    await until(() => browser.text('Thử tải lại'), 'offline error')
    assert.equal(await browser.has('#merchant-businessName'), false)
    await browser.cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await browser.click('Thử tải lại')
    await until(() => browser.text('Đã được phê duyệt'), 'network recovery')
  })
  await check('Independent browser profile sees persisted Profile/KYC/Merchant after login', async () => {
    secondBrowser = await openBrowser(runtime, 'independent')
    await secondBrowser.go('/profile')
    await until(() => secondBrowser.evaluate('location.pathname === "/signin"'), 'independent browser requires login')
    await signInUi(secondBrowser)
    await until(() => secondBrowser.has('#profile-email'), 'return to profile')
    assert.equal(await secondBrowser.evaluate('document.querySelector("#profile-phone").value'), '+84 912 345 678')
    assert.ok(await secondBrowser.text('Đã xác thực'))
    await secondBrowser.go('/merchant-register')
    await until(() => secondBrowser.text('Đã được phê duyệt'), 'independent merchant')
    assert.ok(await secondBrowser.text(merchant.businessName))
    await secondBrowser.screenshot('live-merchant-independent-browser')
  })
  await check('Refresh rotates real cookie, rejects replay, logout revokes session', async () => {
    const fresh = await login(accounts.user)
    const refreshed = await call('/auth/refresh', { method: 'POST', body: {}, cookie: fresh.cookie })
    assert.notEqual(refreshed.cookie, fresh.cookie)
    await call('/auth/refresh', { method: 'POST', body: {}, cookie: fresh.cookie, expected: 401 })
    await call('/auth/signout', { method: 'POST', body: {}, cookie: refreshed.cookie })
    await call('/auth/refresh', { method: 'POST', body: {}, cookie: refreshed.cookie, expected: 401 })
    await secondBrowser.evaluate('document.querySelector(' + JSON.stringify('button[aria-label="Tài khoản người dùng"]') + ').click()')
    await secondBrowser.click('Đăng xuất')
    await until(() => secondBrowser.evaluate('location.pathname === "/signin"'), 'UI logout redirects')
    await secondBrowser.go('/merchant-register')
    await until(() => secondBrowser.evaluate('location.pathname === "/signin"'), 'logout persists after reload')
  })
  await check('Private signed KYC URL actually expires in MinIO', async () => {
    const remaining = documentIssuedAt + 65000 - Date.now()
    if (remaining > 0) { console.log('Waiting ' + Math.ceil(remaining / 1000) + 's for real signed URL expiration'); await delay(remaining) }
    assert.equal((await fetch(signedDocument)).status, 403)
  })
  await check('Direct DB verification: profile, KYC metadata, merchant uniqueness and Admin audit logs', async () => {
    const clients = []
    const client = (service) => {
      const require = createRequire(serviceDir(service) + '/package.json')
      const { PrismaClient } = require('@prisma/client')
      const instance = new PrismaClient({ datasources: { db: { url: serviceEnv(service).DATABASE_URL } } })
      clients.push(instance)
      return instance
    }
    try {
      const userDb = client('user'), merchantDb = client('merchant'), adminDb = client('admin'), walletDb = client('wallet')
      const stored = await userDb.user.findUnique({ where: { authUserId: subject.user.id } })
      assert.equal(stored.phone, '+84 912 345 678')
      assert.equal(stored.kycStatus, 'APPROVED')
      assert.equal(stored.idNumber, '012345678901')
      assert.ok(stored.kycObjectKey)
      assert.equal(stored.kycMimeType, 'image/jpeg')
      assert.ok(stored.kycFileSize > 0)
      assert.equal(await merchantDb.merchant.count({ where: { ownerId: subject.user.id } }), 1)
      const storedMerchant = await merchantDb.merchant.findUnique({ where: { ownerId: subject.user.id } })
      assert.equal(storedMerchant.status, 'APPROVED')
      const audits = await adminDb.adminAuditLog.findMany({ where: { adminId: admin.user.id, targetId: { in: [stored.id, merchant.id] } } })
      for (const action of ['REJECT_KYC', 'APPROVE_KYC', 'APPROVE_MERCHANT', 'REJECT_MERCHANT']) assert.ok(audits.some((log) => log.action === action))
      const wallets = await walletDb.wallet.count({ where: { userId: subject.user.id } })
      assert.equal(wallets, 1)
      database = { profileId: stored.id, authUserId: stored.authUserId, kycStatus: stored.kycStatus,
        merchantId: storedMerchant.id, merchantStatus: storedMerchant.status, merchantCount: 1, walletCount: wallets, auditActions: audits.map((log) => log.action) }
    } finally { await Promise.all(clients.map((value) => value.$disconnect())) }
  })
  await check('No JavaScript runtime exceptions in either real browser session', async () => {
    assert.deepEqual(browser.errors, [])
    assert.deepEqual(secondBrowser.errors, [])
  })
  writeFileSync(resolve(runtime, 'live-result.json'), JSON.stringify({ started, completed: new Date().toISOString(),
    result: 'PASS', checks, database, api: evidence, browserNetwork: browser.network, independentBrowserNetwork: secondBrowser.network }, null, 2))
  console.log('REAL BACKEND ACCEPTANCE PASSED: ' + checks.length + ' checks. Evidence: .cache/acceptance/live-result.json')
} catch (error) {
  writeFileSync(resolve(runtime, 'live-result.json'), JSON.stringify({ started, result: 'FAIL', checks,
    error: error.message, api: evidence, browserNetwork: browser?.network }, null, 2))
  if (browser) await browser.screenshot('live-failure').catch(() => {})
  throw error
} finally {
  if (secondBrowser) await secondBrowser.close()
  if (browser) await browser.close()
}
