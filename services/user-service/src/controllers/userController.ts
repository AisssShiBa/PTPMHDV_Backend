import { Response } from 'express'
import { prisma } from '../config/prisma'
import { RequestWithContext } from '../middlewares/requestId'
import { ApiResponse, UserResponse, PageResponse } from '../types/user'

export async function createUser(req: RequestWithContext, res: Response) {
  try {
    if (!req.isInternalCall) {
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Unauthorized: POST /api/users is restricted to internal service calls with valid X-Internal-Key'
        }
      }
      return res.status(401).json(response)
    }

    const { authUserId, email } = req.body
    if (!authUserId || !email) {
      const response: ApiResponse<null> = {
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'authUserId and email are required' }
      }
      return res.status(400).json(response)
    }

    // Check duplicate
    const existing = await prisma.user.findFirst({
      where: { OR: [{ authUserId }, { email }] }
    })
    if (existing) {
      const response: ApiResponse<null> = {
        success: false,
        error: { code: 'DUPLICATE_RESOURCE', message: 'User with authUserId or email already exists' }
      }
      return res.status(409).json(response)
    }

    const newUser = await prisma.user.create({
      data: {
        authUserId,
        email,
        kycStatus: 'NONE'
      }
    })

    const response: ApiResponse<UserResponse> = {
      success: true,
      data: newUser,
      message: 'User profile created successfully'
    }
    return res.status(201).json(response)
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: err.message || 'Internal server error' }
    })
  }
}

export async function getUserById(req: RequestWithContext, res: Response) {
  const id = String(req.params.id)
  try {
    const user = await prisma.user.findUnique({ where: { id } })
    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found' }
      })
    }
    return res.json({ success: true, data: user })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: err.message || 'Internal server error' }
    })
  }
}

export async function getUserByAuthUserId(req: RequestWithContext, res: Response) {
  const authUserId = String(req.params.authUserId)
  try {
    const user = await prisma.user.findUnique({ where: { authUserId } })
    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User profile not found' }
      })
    }
    return res.json({ success: true, data: user })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: err.message || 'Internal server error' }
    })
  }
}

export async function updateUser(req: RequestWithContext, res: Response) {
  const id = String(req.params.id)
  const { fullName, phone, address } = req.body

  try {
    const existing = await prisma.user.findUnique({ where: { id } })
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found' }
      })
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(fullName !== undefined && { fullName: String(fullName).trim() }),
        ...(phone !== undefined && { phone: String(phone).trim() }),
        ...(address !== undefined && { address: String(address).trim() })
      }
    })
    return res.json({
      success: true,
      data: updated,
      message: 'User profile updated successfully'
    })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: err.message || 'Internal server error' }
    })
  }
}

export async function submitKyc(req: RequestWithContext, res: Response) {
  const id = String(req.params.id)
  const { idNumber, idImageUrl } = req.body

  if (!idNumber || !idImageUrl) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'idNumber and idImageUrl are required' }
    })
  }

  try {
    const existing = await prisma.user.findUnique({ where: { id } })
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found' }
      })
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        idNumber: String(idNumber).trim(),
        idImageUrl: String(idImageUrl).trim(),
        kycStatus: 'PENDING'
      }
    })
    return res.json({
      success: true,
      data: updated,
      message: 'KYC information submitted successfully'
    })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: err.message || 'Internal server error' }
    })
  }
}

export async function updateKycStatus(req: RequestWithContext, res: Response) {
  const id = String(req.params.id)
  const { kycStatus } = req.body

  if (!req.isInternalCall && req.userRole !== 'ADMIN') {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Forbidden: Only ADMIN or internal service calls can update KYC status' }
    })
  }

  if (!['NONE', 'PENDING', 'APPROVED', 'REJECTED'].includes(kycStatus)) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid kycStatus value' }
    })
  }

  try {
    const existing = await prisma.user.findUnique({ where: { id } })
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found' }
      })
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { kycStatus }
    })
    return res.json({
      success: true,
      data: updated,
      message: `User KYC status updated to ${kycStatus}`
    })
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: err.message || 'Internal server error' }
    })
  }
}

export async function getUsers(req: RequestWithContext, res: Response) {
  if (req.userRole !== 'ADMIN') {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Forbidden: Only ADMIN users can view user directory' }
    })
  }

  const page = parseInt(req.query.page as string || '1', 10)
  const limit = parseInt(req.query.limit as string || '10', 10)
  const search = (req.query.search as string || '').trim()
  const rawStatus = ((req.query.status || req.query.kycStatus) as string || '').trim().toUpperCase()

  try {
    const whereClause: any = {}

    if (search) {
      whereClause.OR = [
        { email: { contains: search, mode: 'insensitive' as const } },
        { fullName: { contains: search, mode: 'insensitive' as const } }
      ]
    }

    if (rawStatus && ['NONE', 'PENDING', 'APPROVED', 'REJECTED'].includes(rawStatus)) {
      whereClause.kycStatus = rawStatus
    }

    const [users, totalElements] = await Promise.all([
      prisma.user.findMany({
        where: whereClause,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.user.count({ where: whereClause })
    ])

    const totalPages = Math.ceil(totalElements / limit) || 1
    const pageResponse: PageResponse<UserResponse> = {
      content: users,
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
