import { prisma } from '../config/prisma'
import { scanKycOrphans } from '../services/storage-cleanup'

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || args.some(arg => !['--dry-run', '--delete'].includes(arg))) {
    throw new Error('Usage: npm run storage:cleanup -- [--dry-run|--delete]')
  }
  const result = await scanKycOrphans({ dryRun: args[0] !== '--delete' })
  if (result.failed) process.exitCode = 1
}
main().catch(() => {
  console.error(JSON.stringify({ code: 'KYC_CLEANUP_STOPPED' }))
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
