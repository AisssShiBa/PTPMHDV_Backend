// Phase 4 imports this seed into its isolated Compose lifecycle.
export { seed } from './week2/seed.mjs'

// Preserve the existing browser acceptance CLI.
import { pathToFileURL } from 'node:url'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await import('./seed-browser.mjs')
