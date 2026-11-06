import { NextFunction, Request, Response } from 'express'
import { timingSafeEqual } from 'node:crypto'
import { env } from '../config/env'
import { HttpError } from '../utils/errors'

// The mock provider is an internal callback surface, never public. It accepts
// only the shared service key and never reads a Gateway token.
export function requireInternalKey(req: Request, _res: Response, next: NextFunction) {
  const supplied = req.get('x-internal-key')
  if (supplied === undefined) {
    return next(new HttpError(401, 'UNAUTHORIZED', 'Missing internal credentials'))
  }
  const actual = Buffer.from(supplied)
  const expected = Buffer.from(env.internalKey)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return next(new HttpError(401, 'UNAUTHORIZED', 'Invalid internal credentials'))
  }
  return next()
}
