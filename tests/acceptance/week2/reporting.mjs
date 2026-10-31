// Process errors may contain CLI arguments, credentials or HTTP bodies.
// Keep only diagnostic identifiers, never the full error/cause/stack.
export function executionFailure(error) {
  const identifiers = [error?.code, error?.cause?.code]
    .filter(value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value))
  const codes = [...new Set(identifiers)]
  return 'Execution error' + (codes.length ? ' (' + codes.join(', ') + ')' : '') +
    '; inspect the local run logs'
}
