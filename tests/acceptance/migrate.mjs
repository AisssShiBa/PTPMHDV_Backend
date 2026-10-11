import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { services, serviceDir, serviceEnv } from './config.mjs'

const names = process.argv.slice(2).filter((arg) => arg !== '--deploy-only')
for (const name of (names.length ? names : services)) {
  if (!services.includes(name)) throw new Error('Unknown service')
  const cwd = serviceDir(name)
  for (const args of (process.argv.includes('--deploy-only') ? [['migrate', 'deploy']] : [['generate'], ['migrate', 'deploy']])) {
    console.log(name + ': prisma ' + args.join(' '))
    const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', ...args], {
      cwd, env: serviceEnv(name), stdio: 'pipe', windowsHide: true, encoding: 'utf8'
    })
    if (result.status !== 0) {
      console.error(result.error?.message, result.stdout, result.stderr)
      process.exit(result.status || 1)
    }
    console.log('OK')
  }
}
const require = createRequire(serviceDir('user') + '/package.json')
const { S3Client, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3')
const env = serviceEnv('user')
const client = new S3Client({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION, forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } })
try {
  await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }))
} catch (error) {
  if (error.$metadata?.httpStatusCode !== 404) throw error
  await client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }))
}
client.destroy()
console.log('Private KYC bucket ready.')
