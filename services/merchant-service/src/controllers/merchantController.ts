import { Response } from 'express'
import { prisma } from '../config/prisma'
import { RequestWithContext } from '../middlewares/requestId'
import { ApiResponse, MerchantResponse, MerchantActiveResponse, PageResponse } from '../types/merchant'

export async function registerMerchant(req: RequestWithContext, res: Response) {
  const ownerId = req.userId || (req.body.ownerId as string)

  if (!ownerId) {
    const response: ApiResponse<null> = {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized: Valid user authentication or x-user-id header required' }
    }
    return res.status(401).json(response)
  }

  const { businessName, taxId, bankAccount } = req.body
  if (!businessName || !String(businessName).trim()) {
    const response: ApiResponse<null> = {
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'businessName is required' }
    }
    return res.status(400).json(response)
  }

  try {
    const existing = await prisma.merchant.findFirst({
      where: { ownerId }
    })
    if (existing) {
      const response: ApiResponse<null> = {
        success: false,
        error: { code: 'DUPLICATE_RESOURCE', message: `User ${ownerId} already has a registered merchant profile` }
      }
      return res.status(409).json(response)
    }

    const merchant = await prisma.merchant.create({
      data: {
        ownerId,
        businessName: String(businessName).trim(),
        taxId: taxId ? String(taxId).trim() : null,
        bankAccount: bankAccount ? String(bankAccount).trim() : null,
        status: 'PENDING'
      }
    })

    return res.status(201).json({
      success: true,
      data: merchant,
      message: 'Merchant registration submitted successfully'
    })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: err.message || 'Internal server error' }
    })
  }
}

export async function getMerchantById(req: RequestWithContext, res: Response) {
  const id = String(req.params.id)
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id } })
    if (!merchant) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Merchant not found' }
      })
    }
    return res.json({ success: true, data: merchant })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: err.message || 'Internal server error' }
    })
  }
}

export async function updateMerchant(req: RequestWithContext, res: Response) {
  const id = String(req.params.id)
  const { businessName, taxId, bankAccount } = req.body

  try {
    const existing = await prisma.merchant.findUnique({ where: { id } })
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Merchant not found' }
      })
    }

    const updated = await prisma.merchant.update({
      where: { id },
      data: {
        ...(businessName !== undefined && { businessName: String(businessName).trim() }),
        ...(taxId !== undefined && { taxId: taxId ? String(taxId).trim() : null }),
        ...(bankAccount !== undefined && { bankAccount: bankAccount ? String(bankAccount).trim() : null })
      }
    })
    return res.json({
      success: true,
      data: updated,
      message: 'Merchant profile updated successfully'
    })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: err.message || 'Internal server error' }
    })
  }
}

export async function updateMerchantStatus(req: RequestWithContext, res: Response) {
  const id = String(req.params.id)
  const { status } = req.body

  if (!req.isInternalCall && req.userRole !== 'ADMIN') {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Forbidden: Only ADMIN or internal service calls can update merchant status' }
    })
  }

  if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid status value' }
    })
  }

  try {
    const existing = await prisma.merchant.findUnique({ where: { id } })
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Merchant not found' }
      })
    }

    const updated = await prisma.merchant.update({
      where: { id },
      data: { status }
    })
    return res.json({
      success: true,
      data: updated,
      message: `Merchant status updated to ${status}`
    })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: err.message || 'Internal server error' }
    })
  }
}

export async function checkMerchantActive(req: RequestWithContext, res: Response) {
  const id = String(req.params.id)
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id } })
    if (!merchant) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Merchant not found' }
      })
    }

    const activeResponse: MerchantActiveResponse = {
      id: merchant.id,
      ownerId: merchant.ownerId,
      businessName: merchant.businessName,
      status: merchant.status,
      active: merchant.status === 'APPROVED'
    }
    return res.json({ success: true, data: activeResponse })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: err.message || 'Internal server error' }
    })
  }
}

export async function getMerchants(req: RequestWithContext, res: Response) {
  if (req.userRole !== 'ADMIN') {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Forbidden: Only ADMIN can list/filter merchants' }
    })
  }

  const page = parseInt(req.query.page as string || '1', 10)
  const limit = parseInt(req.query.limit as string || '10', 10)
  const statusFilter = req.query.status as string | undefined
  const search = (req.query.search as string || '').trim()

  try {
    const whereClause: any = {}
    if (statusFilter && ['PENDING', 'APPROVED', 'REJECTED'].includes(statusFilter)) {
      whereClause.status = statusFilter
    }
    if (search) {
      whereClause.businessName = { contains: search, mode: 'insensitive' }
    }

    const [merchants, totalElements] = await Promise.all([
      prisma.merchant.findMany({
        where: whereClause,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.merchant.count({ where: whereClause })
    ])

    const totalPages = Math.ceil(totalElements / limit) || 1
    const pageResponse: PageResponse<MerchantResponse> = {
      content: merchants,
      page,
      limit,
      totalElements,
      totalPages
    }

    return res.json({ success: true, data: pageResponse })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: err.message || 'Internal server error' }
    })
  }
}
