import app from './app'
import { env } from './config/env'
import { prisma } from './config/prisma'

async function startServer() {
  try {
    await prisma.$connect()
    console.log('Merchant service: Connected to Postgres DB via Prisma successfully')
  } catch (err) {
    console.warn('Merchant service: DB connection warning (falling back to Mock mode):', err)
  }

  app.listen(env.port, () => {
    console.log(`Merchant service running at port ${env.port}`)
  })
}

startServer()
