import { afterEach } from 'node:test'
const restorers: (() => void)[] = []
// Prisma delegates expose methods through a Proxy, without method descriptors.
export function stub(target: any, key: string, replacement: (...args: any[]) => any) {
  const previous = target[key]
  target[key] = replacement
  restorers.push(() => { target[key] = previous })
}
afterEach(() => { for (const restore of restorers.splice(0).reverse()) restore() })
