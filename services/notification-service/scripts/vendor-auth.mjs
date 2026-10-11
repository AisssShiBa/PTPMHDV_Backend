import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const serviceDirectory = path.resolve(scriptDirectory, '..')
const packageDirectory = path.resolve(serviceDirectory, '..', '..', 'packages', 'finvault-internal-auth')
const vendorDirectory = path.join(serviceDirectory, 'vendor')
const npmCli = process.env.npm_execpath

if (!npmCli) {
  console.error('Chạy script này bằng `npm run vendor:auth` để tìm thấy npm CLI.')
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  [npmCli, 'pack', '--pack-destination', vendorDirectory],
  {
    cwd: packageDirectory,
    stdio: 'inherit'
  }
)

if (result.error) {
  console.error('Không thể đóng gói finvault-internal-auth:', result.error)
  process.exitCode = 1
} else if (result.status !== 0) {
  process.exitCode = result.status ?? 1
}
