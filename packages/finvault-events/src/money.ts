const integerAmount = /^\d+$/

function assertAmount(value: string): void {
  if (!integerAmount.test(value) || value !== value.trim()) {
    throw new TypeError('Amount must be a non-negative decimal integer string')
  }
}

export function addAmounts(left: string, right: string): string {
  assertAmount(left)
  assertAmount(right)
  return (BigInt(left) + BigInt(right)).toString()
}

export function compareAmounts(left: string, right: string): -1 | 0 | 1 {
  assertAmount(left)
  assertAmount(right)
  const a = BigInt(left)
  const b = BigInt(right)
  return a < b ? -1 : a > b ? 1 : 0
}
