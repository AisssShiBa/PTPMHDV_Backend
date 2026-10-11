import assert from 'node:assert/strict'
export const evidence = []
export async function call(path, { method = 'GET', body, token, cookie, expected = 200 } = {}) {
  const form = body instanceof FormData
  const headers = {}
  if (body && !form) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = 'Bearer ' + token
  if (cookie) headers.Cookie = cookie
  const res = await fetch('http://localhost:3000/api' + path, {
    method, headers, body: body ? (form ? body : JSON.stringify(body)) : undefined, signal: AbortSignal.timeout(20000)
  })
  const value = await res.json()
  evidence.push({ method, path, status: res.status, code: value.error?.code, requestId: res.headers.get('x-request-id') })
  assert.equal(res.status, expected, method + ' ' + path + ': ' + JSON.stringify(value))
  return { data: value.data, body: value, cookie: res.headers.get('set-cookie')?.split(';')[0], headers: res.headers }
}
export async function login(account) {
  const result = await call('/auth/signin', { method: 'POST', body: { username: account.username, password: account.password } })
  assert.ok(result.cookie?.startsWith('refreshToken='))
  assert.ok(result.data.accessToken)
  return { token: result.data.accessToken, cookie: result.cookie, user: result.data.user }
}
