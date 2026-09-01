import 'dotenv/config'
function required(key: string): string {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Thiếu biến môi trường: ${key}`)
  }
  return value
}
export const env = {
  port: process.env.PORT ?? 4001,
  databaseUrl: required('DATABASE_URL')
}
