import { randomBytes, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runtime, config } from './config.mjs'
mkdirSync(runtime, { recursive: true })
const path = resolve(runtime, 'config.json')
if (!existsSync(path)) {
  writeFileSync(path, JSON.stringify({
    dbPassword: randomBytes(24).toString('hex'),
    storagePassword: randomBytes(24).toString('hex'),
    jwtSecret: randomBytes(48).toString('hex'),
    internalKey: randomBytes(32).toString('hex')
  }, null, 2))
}
const value = config()
writeFileSync(resolve(runtime, 'infra.env'),
  'ACCEPTANCE_DB_PASSWORD=' + value.dbPassword + '\nACCEPTANCE_STORAGE_PASSWORD=' + value.storagePassword + '\n')
console.log('Acceptance config prepared in ignored .cache/acceptance; no existing .env modified.')

const privateKey = resolve(runtime, 'gateway-private.pem')
const publicKey = resolve(runtime, 'gateway-public.pem')
if (existsSync(privateKey) !== existsSync(publicKey)) throw new Error('Incomplete acceptance key pair')
if (!existsSync(privateKey)) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  writeFileSync(privateKey, pair.privateKey, { mode: 0o600, flag: 'wx' })
  writeFileSync(publicKey, pair.publicKey, { flag: 'wx' })
}
