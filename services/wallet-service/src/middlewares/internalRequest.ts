import { NextFunction, Request, Response } from 'express'
import { env } from '../config/env'

/**
 * Internal routes are protected when INTERNAL_API_KEY is configured. Keeping
 * the local-development fallback makes the service easy to run in isolation;
 * production refuses to expose those routes without a key.
 */
export function requireInternalRequest(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (!env.internalApiKey) {
    if (env.nodeEnv === 'production') {
      return res.status(503).json({
        code: 'INTERNAL_AUTH_NOT_CONFIGURED',
        message: 'Internal API authentication is not configured'
      })
    }

    return next()
  }

  const providedKey = req.header('X-Internal-Key')
  if (!providedKey || providedKey !== env.internalApiKey) {
    return res.status(401).json({
      code: 'INTERNAL_AUTH_REQUIRED',
      message: 'A valid internal API key is required'
    })
  }

  return next()
}
