// Phase 4 imports this seed into its isolated Compose lifecycle.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { seed as seedBase } from './week2/seed.mjs'
import { seedNguyen } from './week4/seed-nguyen.mjs'

export async function seed(ctx) {
  try {
    const accounts = await seedBase(ctx)
    await seedNguyen(ctx, { includeDrift: process.env.SEED_ALLOW_DRIFT === '1' })
    return accounts
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error)
    writeFileSync(resolve(ctx.directory, 'seed-error.log'), detail.replaceAll(/(token|cookie|secret|password)[^\n]*/gi, '$1=[redacted]') + '\n')
    throw error
  }
}

// Preserve the existing browser acceptance CLI.
import { pathToFileURL } from 'node:url'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await import('./seed-browser.mjs')
