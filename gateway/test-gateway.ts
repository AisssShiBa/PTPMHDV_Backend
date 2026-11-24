import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'
import express from 'express'
import jwt from 'jsonwebtoken'

test('Gateway signing and authentication use isolated test credentials', async t => {
    const keys = generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' }
    })
    const testEnvironment: Record<string, string | undefined> = {
        NODE_ENV: 'test',
        GATEWAY_PRIVATE_KEY: keys.privateKey,
        GATEWAY_PUBLIC_KEY: keys.publicKey,
        ACCESS_TOKEN_SECRET: randomBytes(32).toString('hex'),
        INTERNAL_KEY: 'synthetic-gateway-test-key',
        GATEWAY_PRIVATE_KEY_FILE: undefined,
        GATEWAY_PUBLIC_KEY_FILE: undefined,
        ACCESS_TOKEN_SECRET_FILE: undefined,
        INTERNAL_KEY_FILE: undefined,
        REDIS_URL_FILE: undefined
    }
    const previousEnvironment = new Map(Object.keys(testEnvironment).map(key => [key, process.env[key]]))
    t.after(() => {
        for (const [key, value] of previousEnvironment) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    })
    for (const [key, value] of Object.entries(testEnvironment)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }

    // Load configuration after replacing deployment credentials with fixtures.
    const { signGatewayToken, verifyGatewayToken } = await import('./src/utils/gatewayToken')
    const { authenticate } = await import('./src/middlewares/authenticate')
    const { sanitizeHeaders } = await import('./src/middlewares/sanitizeHeaders')
    const { env } = await import('./src/config/services')
    const userId = '11111111-2222-4333-8444-555555555555'
    const role = 'ADMIN'

    await t.test('ES256 identity, audience, unique ID and 60-second TTL', () => {
        const token = signGatewayToken(userId, role)
        const claims = verifyGatewayToken(token)
        assert.equal(jwt.decode(token, { complete: true })?.header.alg, 'ES256')
        assert.equal(claims.sub, userId)
        assert.equal(claims.role, role)
        assert.equal(claims.iss, 'finvault-gateway')
        assert.equal(claims.aud, 'finvault-internal-services')
        assert.equal(typeof claims.iat, 'number')
        assert.equal(typeof claims.exp, 'number')
        assert.equal(claims.exp! - claims.iat!, 60)
        assert.ok(claims.jti)
        assert.notEqual(verifyGatewayToken(signGatewayToken(userId, role)).jti, claims.jti)
    })

    const app = express()
    app.use(sanitizeHeaders)
    app.use(authenticate)
    app.use((req, res) => {
        const token = req.headers['x-gateway-token']
        res.json({
            claims: typeof token === 'string' ? verifyGatewayToken(token) : null,
            userId: req.headers['x-user-id'],
            role: req.headers['x-user-role'],
            legacyHeader: req.headers['x-gateway-verified'],
            internalKey: req.headers['x-internal-key']
        })
    })
    const server = app.listen(0, '127.0.0.1')
    t.after(() => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
    }))
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const baseUrl = 'http://127.0.0.1:' + address.port

    await t.test('public health strips forged service headers without minting identity', async () => {
        const response = await fetch(baseUrl + '/health', {
            headers: { 'x-gateway-verified': 'true', 'x-internal-key': 'forged-key' }
        })
        assert.equal(response.status, 200)
        const body = await response.json()
        assert.equal(body.claims, null)
        assert.equal(body.legacyHeader, undefined)
        assert.equal(body.internalKey, undefined)
    })

    await t.test('protected route without Bearer returns UNAUTHORIZED', async () => {
        const response = await fetch(baseUrl + '/api/wallets/me')
        assert.equal(response.status, 401)
        assert.equal((await response.json()).error.code, 'UNAUTHORIZED')
    })

    await t.test('invalid and expired Bearer tokens return INVALID_TOKEN', async () => {
        const expired = jwt.sign({ userId, role }, env.accessTokenSecret, { expiresIn: -1 })
        for (const token of ['invalid-token', expired]) {
            const response = await fetch(baseUrl + '/api/wallets/me', {
                headers: { authorization: 'Bearer ' + token }
            })
            assert.equal(response.status, 401)
            assert.equal((await response.json()).error.code, 'INVALID_TOKEN')
        }
    })

    await t.test('valid Bearer supplies identity but cannot set authoritative Wallet KYC', async () => {
        const token = jwt.sign({ userId, role, kycTier: 2 }, env.accessTokenSecret, { expiresIn: '60s' })
        const response = await fetch(baseUrl + '/api/wallets/me', {
            headers: {
                authorization: 'Bearer ' + token,
                'x-user-id': 'forged-user',
                'x-user-role': 'USER',
                'x-gateway-token': 'forged-token',
                'x-gateway-verified': 'true',
                'x-internal-key': 'forged-key'
            }
        })
        assert.equal(response.status, 200)
        const body = await response.json()
        assert.equal(body.claims.sub, userId)
        assert.equal(body.claims.role, role)
        // Compatibility defaults to zero; Wallet owns the actual KYC tier.
        assert.equal(body.claims.kycTier, 0)
        assert.equal(body.claims.exp - body.claims.iat, 60)
        assert.equal(body.userId, userId)
        assert.equal(body.role, role)
        assert.equal(body.legacyHeader, undefined)
        assert.equal(body.internalKey, undefined)
    })
})
