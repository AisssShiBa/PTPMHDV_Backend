import 'dotenv/config'

export const env = {
  port: process.env.PORT ?? 3006,
  // INTERNAL_KEY — ĐỒNG BỘ với Gateway + Payment + Wallet (header: x-internal-key)
  internalKey: process.env.INTERNAL_KEY ?? process.env.INTERNAL_API_KEY
}
