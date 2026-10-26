import { readFileSync } from 'node:fs'

// Explicit *_FILE settings take precedence and fail closed. Do not expose the
// file path, filesystem error or secret contents in startup errors.
export function loadSecretEnvironment(names: string[]) {
  for (const name of names) {
    const file = process.env[`${name}_FILE`]
    if (file === undefined) continue
    let value: string
    try { value = readFileSync(file, 'utf8').trim() }
    catch { throw new Error(`Cannot read required secret: ${name}_FILE`) }
    if (!value) throw new Error(`Empty required secret: ${name}_FILE`)
    process.env[name] = value
  }
}
