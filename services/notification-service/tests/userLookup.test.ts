import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUserLookupClient, shortenDisplayName } from '../src/services/userLookup'

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('user lookup sends the existing internal-key contract and reads only fullName', async () => {
  let requestedUrl = ''
  let internalKey = ''
  const client = createUserLookupClient({
    baseUrl: 'http://user-service:3002/api/users/by-auth',
    internalKey: 'test-internal-key',
    fetchImpl: async (input, init) => {
      requestedUrl = String(input)
      internalKey = new Headers(init?.headers).get('x-internal-key') ?? ''
      return response({
        success: true,
        data: { fullName: 'Nguyễn Văn An', idNumber: 'sensitive-unused-field' }
      })
    }
  })

  assert.equal(await client.getFullName('00000000-0000-4000-8000-000000000001'), 'Nguyễn Văn An')
  assert.equal(
    requestedUrl,
    'http://user-service:3002/api/users/by-auth/00000000-0000-4000-8000-000000000001'
  )
  assert.equal(internalKey, 'test-internal-key')
})

test('user lookup degrades absent names to null', async () => {
  const client = createUserLookupClient({
    baseUrl: 'http://user-service/api/users/by-auth',
    internalKey: 'test-key',
    fetchImpl: async () => response({ success: true, data: { fullName: null } })
  })

  assert.equal(await client.getFullName('user-without-name'), null)
})

test('user lookup timeout degrades to a generic result', async () => {
  const failures: string[] = []
  const client = createUserLookupClient({
    baseUrl: 'http://user-service/api/users/by-auth',
    internalKey: 'test-key',
    timeoutMs: 5,
    fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }),
    logFailure: code => failures.push(code)
  })

  assert.equal(await client.getFullName('slow-user'), null)
  assert.deepEqual(failures, ['timeout'])
})

test('user lookup HTTP errors degrade without logging response bodies or names', async () => {
  const logs: string[] = []
  const client = createUserLookupClient({
    baseUrl: 'http://user-service/api/users/by-auth',
    internalKey: 'test-key',
    fetchImpl: async () => new Response('Nguyễn Văn An private response detail', { status: 503 }),
    logFailure: (code, userId) => logs.push(`${code}:${userId}`)
  })

  assert.equal(await client.getFullName('unavailable-user'), null)
  assert.deepEqual(logs, ['http_503:unavailable-user'])
  assert.equal(logs.join(' ').includes('Nguyễn Văn An'), false)
})

test('user lookup caches hits and misses for the configured TTL', async () => {
  let requests = 0
  const client = createUserLookupClient({
    baseUrl: 'http://user-service/api/users/by-auth',
    internalKey: 'test-key',
    cacheTtlMs: 20,
    fetchImpl: async () => {
      requests += 1
      return response({ success: true, data: { fullName: 'Nguyễn An' } })
    }
  })

  assert.equal(await client.getFullName('cached-user'), 'Nguyễn An')
  assert.equal(await client.getFullName('cached-user'), 'Nguyễn An')
  assert.equal(requests, 1)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(await client.getFullName('cached-user'), 'Nguyễn An')
  assert.equal(requests, 2)
})

test('display names use the surname and the final-name initial', () => {
  assert.equal(shortenDisplayName(' Nguyễn   Văn An '), 'Nguyễn A.')
  assert.equal(shortenDisplayName(null), 'một người dùng')
  assert.equal(shortenDisplayName('SingleName'), 'một người dùng')
})
