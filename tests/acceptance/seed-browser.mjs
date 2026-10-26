import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runtime, serviceDir, serviceEnv } from './config.mjs'
import { call, evidence } from './live-client.mjs'

const suffix = Date.now().toString(36)
function account(label) {
  const username = 'accept_' + label + '_' + suffix
  return { username, password: randomBytes(18).toString('hex'), email: username + '@example.test', firstName: 'Acceptance', lastName: label }
}
const accounts = { user: account('user'), admin: account('admin'), outsider: account('other') }
for (const kind of ['admin', 'outsider']) {
  const result = await call('/auth/signup', { method: 'POST', body: accounts[kind], expected: 201 })
  accounts[kind].id = result.data.user.id
}
const authRequire = createRequire(serviceDir('auth') + '/package.json')
const { PrismaClient } = authRequire('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: serviceEnv('auth').DATABASE_URL } } })
try {
  // Only the newly registered acceptance admin in the isolated acceptance DB is promoted.
  await prisma.user.update({ where: { id: accounts.admin.id, username: accounts.admin.username }, data: { role: 'ADMIN' } })
} finally { await prisma.$disconnect() }
writeFileSync(resolve(runtime, 'accounts.json'), JSON.stringify(accounts, null, 2))
writeFileSync(resolve(runtime, 'seed-evidence.json'), JSON.stringify(evidence, null, 2))
const require = createRequire(serviceDir('user') + '/package.json')
const sharp = require('sharp')
const svg = '<svg width="800" height="480" xmlns="http://www.w3.org/2000/svg"><rect width="800" height="480" fill="#eeeeee"/><text x="50" y="100" font-size="32">FINVAULT ACCEPTANCE TEST</text><text x="50" y="180" font-size="24">SYNTHETIC IMAGE - NOT AN ID DOCUMENT</text><rect x="50" y="230" width="160" height="160" fill="#6666aa"/></svg>'
await sharp(Buffer.from(svg)).png().toFile(resolve(runtime, 'test-document.png'))
console.log('Acceptance admin and outsider registered via Gateway; subject account prepared for UI signup. Credentials stay in ignored .cache/acceptance/accounts.json.')
