import express from 'express'
import cors from 'cors'
import { requireGateway } from 'finvault-internal-auth'
import { env } from './config/env'
import { attachRequestId } from './middlewares/requestId'
import { errorHandler } from './middlewares/errorHandler'
import { notFound } from './middlewares/notFound'
import { HttpError } from './utils/errors'
import { createUtilityRouter } from './routes/utilityRoute'
import { createMockProviderRouter } from './routes/mockProviderRoute'
import { HttpPaymentClient } from './services/paymentClient'
import { HttpProviderClient } from './services/providerClient'
import { MockProviderEngine } from './services/mockProviderEngine'
import type { PaymentClient, ProviderClient } from './types/utility'

export type UtilityAppOptions = {
  paymentClient: PaymentClient
  providerClient: ProviderClient
  mockProviderEngine: MockProviderEngine
  mockProviderEnabled: boolean
}

export function createDefaultAppOptions(): UtilityAppOptions {
  return {
    paymentClient: new HttpPaymentClient(),
    providerClient: new HttpProviderClient(),
    mockProviderEngine: new MockProviderEngine(),
    mockProviderEnabled: env.mockProviderEnabled
  }
}

export function createUtilityApp(options: UtilityAppOptions): express.Express {
  const app = express()

  app.use(attachRequestId)
  app.use(express.json({ limit: '100kb' }))

  const allowedOrigins = [env.clientUrl, 'http://localhost:5173', 'http://localhost:5174'].filter(
    Boolean
  )

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || /^http:\/\/localhost:\d+$/.test(origin)) {
          return callback(null, true)
        }
        return callback(new HttpError(403, 'FORBIDDEN', 'Origin is not allowed'))
      },
      credentials: true
    })
  )

  app.get('/health', (_req, res) =>
    res.status(200).json({ status: 'ok', service: 'utilities-service' })
  )
  app.get('/api/utilities/health', (_req, res) =>
    res.status(200).json({ status: 'ok', service: 'utilities-service' })
  )

  app.use('/api/utilities', requireGateway, createUtilityRouter(options.paymentClient))

  if (options.mockProviderEnabled) {
    // Sandbox callback only; never mounted with real money.
    app.use('/internal/mock-provider', createMockProviderRouter(options.mockProviderEngine))
  }

  app.use(notFound)
  app.use(errorHandler)
  return app
}
