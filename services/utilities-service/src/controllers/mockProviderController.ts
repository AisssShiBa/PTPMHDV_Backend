import { Request, Response, NextFunction } from 'express'
import { HttpError } from '../utils/errors'
import { MockProviderEngine } from '../services/mockProviderEngine'
import { parseMockTopupBody } from '../validations/utility.validation'

export const createMockTopupHandler =
  (engine: MockProviderEngine) =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId, phone } = parseMockTopupBody(req.body)
      const outcome = engine.execute({ orderId, key: phone })
      if (outcome.status === 'SUCCESS') {
        return res.status(200).json({ success: true, data: outcome })
      }
      if (outcome.status === 'FAILED') {
        return res.status(422).json({
          success: false,
          error: { code: outcome.reason, message: 'Nhà cung cấp từ chối giao dịch.' }
        })
      }
      return res.status(504).json({
        success: false,
        error: { code: 'PROVIDER_TIMEOUT', message: 'Nhà cung cấp không phản hồi.' }
      })
    } catch (error) {
      return next(error)
    }
  }

export const createMockOrderStatusHandler =
  (engine: MockProviderEngine) =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = String(req.params.orderId ?? '')
      if (!/^[A-Za-z0-9-]{1,100}$/.test(orderId)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'orderId không hợp lệ.')
      }
      const outcome = engine.query(orderId)
      if (outcome.status === 'SUCCESS') {
        return res.status(200).json({ success: true, data: outcome })
      }
      if (outcome.status === 'FAILED') {
        return res.status(422).json({
          success: false,
          error: { code: outcome.reason, message: 'Nhà cung cấp từ chối giao dịch.' }
        })
      }
      return res.status(504).json({
        success: false,
        error: { code: 'PROVIDER_TIMEOUT', message: 'Chưa xác định được kết quả.' }
      })
    } catch (error) {
      return next(error)
    }
  }
