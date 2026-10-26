const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { parseEnv } = require('node:util')

const DEV_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEniLUK7gZ7ZSYyWBnm3SiPUedQHwt
aeFpVr9DWDOaA02OcsSGq1K+pmzspers77x41nFYSqe/bQgOL9XONKkRwQ==
-----END PUBLIC KEY-----`

function initialize(root = path.resolve(__dirname, '..')) {
  const secretDir = path.join(root, 'secrets')
  const envPath = path.join(root, '.env')
  const exists = fs.existsSync(envPath)
  let source = fs.readFileSync(exists ? envPath : path.join(root, '.env.example'), 'utf8')
  const config = parseEnv(source)
  fs.mkdirSync(secretDir, { recursive: true })
  const random = () => crypto.randomBytes(32).toString('hex')
  function set(key, value) {
    config[key] = value
    const line = key + "='" + value.replaceAll("'", "\\'") + "'"
    const pattern = new RegExp('^' + key + '=.*$', 'm')
    source = pattern.test(source) ? source.replace(pattern, () => line) : source.trimEnd() + '\n' + line + '\n'
  }
  function ensure(key, value) { if (!config[key]) set(key, value) }
  function secret(key, filename, fallback) {
    const file = path.join(secretDir, filename)
    const saved = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : undefined
    if (saved && config[key] && saved !== config[key])
      throw new Error(key + ' differs between .env and secrets/' + filename + '; reconcile existing credentials before starting Docker')
    ensure(key, saved || fallback)
    if (!saved) fs.writeFileSync(file, config[key] + '\n', { mode: 0o600, flag: 'wx' })
  }
  secret('POSTGRES_PASSWORD', 'postgres_password.txt', random())
  secret('RABBITMQ_PASS', 'rabbitmq_pass.txt', random())
  secret('VNP_HASH_SECRET', 'vnp_hash_secret.txt', random())
  ensure('POSTGRES_USER', 'postgres')
  ensure('RABBITMQ_USER', 'finvault')
  secret('ACCESS_TOKEN_SECRET', 'access_token_secret.txt', random())
  secret('INTERNAL_KEY', 'internal_key.txt', random())
  ensure('MINIO_ROOT_USER', 'finvault-admin')
  ensure('MINIO_ROOT_PASSWORD', random())
  ensure('S3_ACCESS_KEY_ID', 'finvault-kyc')
  ensure('S3_SECRET_ACCESS_KEY', random())
  ensure('S3_BUCKET', 'finvault-kyc')
  ensure('MINIO_HOST_PORT', '19002')
  ensure('S3_PUBLIC_ENDPOINT', 'http://localhost:' + config.MINIO_HOST_PORT)
  set('POSTGRES_PASSWORD_URLENCODED', encodeURIComponent(config.POSTGRES_PASSWORD))
  set('RABBITMQ_URL', 'amqp://' + encodeURIComponent(config.RABBITMQ_USER) + ':' +
    encodeURIComponent(config.RABBITMQ_PASS) + '@rabbitmq:5672')

  const privatePath = path.join(secretDir, 'gateway_private.pem')
  const publicPath = path.join(secretDir, 'gateway_public.pem')
  let regenerate = !fs.existsSync(privatePath)
  if (regenerate && fs.existsSync(publicPath)) throw new Error('Gateway private key is missing; restore the matching key pair')
  if (!regenerate) {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(privatePath))
    if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
      throw new Error('Gateway requires an ES256 P-256 private key')
    const derived = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
    if (fs.existsSync(publicPath)) {
      const publicKey = crypto.createPublicKey(fs.readFileSync(publicPath)).export({ type: 'spki', format: 'pem' }).toString()
      if (derived !== publicKey) throw new Error('Gateway public/private keys do not match; existing keys were preserved')
    } else fs.writeFileSync(publicPath, derived, { flag: 'wx' })
    if (derived.trim() === DEV_PUBLIC_KEY) {
      const suffix = '.legacy-dev-' + crypto.randomUUID() + '.pem'
      fs.copyFileSync(privatePath, privatePath + suffix, fs.constants.COPYFILE_EXCL)
      fs.copyFileSync(publicPath, publicPath + suffix, fs.constants.COPYFILE_EXCL)
      regenerate = true
      console.log('Backed up legacy development keys; generating a new Gateway pair.')
    }
  }
  if (regenerate) {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' } })
    fs.writeFileSync(privatePath, pair.privateKey, { mode: 0o600 })
    fs.writeFileSync(publicPath, pair.publicKey)
  }
  // Auth transaction signing uses its own key pair, never the Gateway key.
  const txnPrivate = path.join(secretDir, 'auth_txn_private.pem')
  const txnPublic = path.join(secretDir, 'auth_txn_public.pem')
  if (fs.existsSync(txnPrivate) !== fs.existsSync(txnPublic))
    throw new Error('Incomplete Auth-Txn key pair; restore matching keys')
  if (!fs.existsSync(txnPrivate)) {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    fs.writeFileSync(txnPrivate, pair.privateKey, { mode: 0o600, flag: 'wx' })
    fs.writeFileSync(txnPublic, pair.publicKey, { flag: 'wx' })
  }
  const txnKey = crypto.createPrivateKey(fs.readFileSync(txnPrivate))
  if (txnKey.asymmetricKeyType !== 'ec' || txnKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
      crypto.createPublicKey(txnKey).export({ type: 'spki', format: 'pem' }) !==
      crypto.createPublicKey(fs.readFileSync(txnPublic)).export({ type: 'spki', format: 'pem' }))
    throw new Error('Invalid or mismatched Auth-Txn key pair; existing keys were preserved')
  fs.writeFileSync(envPath, source.trimEnd() + '\n', { mode: 0o600 })
  // SQL is generated under ignored secrets/, never committed with credentials.
  const template = fs.readFileSync(path.join(root, 'init-db.sql'), 'utf8')
  const sql = template.replaceAll('{{DB_ROLE_PASSWORD}}', config.POSTGRES_PASSWORD.replaceAll("'", "''"))
  fs.writeFileSync(path.join(secretDir, 'init-db.sql'), sql, { mode: 0o600 })
  console.log('Local environment ready. Existing credentials preserved; Gateway keys validated.')
}

module.exports = { initialize }
if (require.main === module) {
  try { initialize(); console.log('Run: docker compose up -d --build --wait') }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
