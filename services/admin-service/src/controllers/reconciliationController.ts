import { Request, Response } from 'express'
import { createError } from '../middlewares/errorHandler'
import {
  parseAdjustment,
  parseAnomalyId,
  parsePagination,
  parseReportId,
  parseRunMode
} from '../validations/reconciliation'
import {
  adjustAnomaly,
  getReport,
  listReports,
  runReconciliation
} from '../services/reconciliationService'

type AdminContext = {
  adminId: string
  requestId: string
  gatewayToken: string
}

function context(req: Request): AdminContext {
  // /api/admin already runs requireGateway + requireRole('ADMIN'); re-check
  // here so a future route reordering can never expose this controller.
  if (!req.auth || req.auth.role !== 'ADMIN') {
    throw createError(403, 'FORBIDDEN', 'Administrator access required')
  }
  const gatewayToken = req.get('x-gateway-token')
  if (!gatewayToken) {
    throw createError(401, 'INVALID_GATEWAY_TOKEN', 'Gateway token required')
  }
  const requestId = (req as Request & { requestId?: string }).requestId || 'unknown'
  return { adminId: req.auth.userId, requestId, gatewayToken }
}

export async function run(req: Request, res: Response) {
  const admin = context(req)
  const mode = parseRunMode(req.query.mode)
  const report = await runReconciliation({ mode, ...admin })
  return res.json({ success: true, data: report })
}

export async function reports(req: Request, res: Response) {
  const admin = context(req)
  const { page, limit } = parsePagination(req.query)
  const data = await listReports({ page, limit, ...admin })
  return res.json({ success: true, data })
}

export async function report(req: Request, res: Response) {
  const admin = context(req)
  const id = parseReportId(req.params.id)
  const data = await getReport({ id, ...admin })
  return res.json({ success: true, data })
}

export async function adjust(req: Request, res: Response) {
  const admin = context(req)
  const anomalyId = parseAnomalyId(req.params.id)
  const { direction, amount, reason } = parseAdjustment(req.body)
  const data = await adjustAnomaly({ anomalyId, direction, amount, reason, ...admin })
  return res.json({ success: true, data })
}
