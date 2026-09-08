import { Prisma } from '@prisma/client'
import { prisma } from '../config/prisma'
import { HttpError } from '../errors'

export type WalletOperation = 'credit' | 'debit'

type MutationInput = {
  userId: number
  operation: WalletOperation
  amount: Prisma.Decimal
  refId: string
  idempotencyKey: string
}

type MutationResult = {
  balance: Prisma.Decimal
  replayed: boolean
}

function isUniqueConstraintError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  )
}

function assertSameIdempotentRequest(
  existing: {
    walletId: number
    operation: string
    amount: Prisma.Decimal
    refId: string
    balance: Prisma.Decimal
  },
  input: MutationInput
) {
  if (
    existing.walletId !== input.userId ||
    existing.operation !== input.operation ||
    !existing.amount.eq(input.amount) ||
    existing.refId !== input.refId
  ) {
    throw new HttpError(
      409,
      'Idempotency-Key was already used with a different request',
      'IDEMPOTENCY_KEY_REUSED'
    )
  }
}

export async function createWallet(userId: number) {
  const existing = await prisma.wallet.findUnique({ where: { userId } })
  if (existing) {
    return { wallet: existing, created: false }
  }

  try {
    const wallet = await prisma.wallet.create({ data: { userId } })
    return { wallet, created: true }
  } catch (error) {
    // A user-creation retry can race with another wallet-creation request.
    if (!isUniqueConstraintError(error)) {
      throw error
    }

    const wallet = await prisma.wallet.findUnique({ where: { userId } })
    if (!wallet) {
      throw error
    }

    return { wallet, created: false }
  }
}

export async function getWalletBalance(userId: number) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } })
  if (!wallet) {
    throw new HttpError(404, 'Wallet not found', 'WALLET_NOT_FOUND')
  }

  return wallet
}

async function mutateWalletOnce(input: MutationInput): Promise<MutationResult> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.walletIdempotency.findUnique({
      where: { key: input.idempotencyKey }
    })

    if (existing) {
      assertSameIdempotentRequest(existing, input)
      return { balance: existing.balance, replayed: true }
    }

    const wallet = await tx.wallet.findUnique({ where: { userId: input.userId } })
    if (!wallet) {
      throw new HttpError(404, 'Wallet not found', 'WALLET_NOT_FOUND')
    }

    const update =
      input.operation === 'credit'
        ? await tx.wallet.updateMany({
            where: { id: wallet.id },
            data: { balance: { increment: input.amount } }
          })
        : await tx.wallet.updateMany({
            where: { id: wallet.id, balance: { gte: input.amount } },
            data: { balance: { decrement: input.amount } }
          })

    if (update.count !== 1) {
      throw new HttpError(400, 'Insufficient wallet balance', 'INSUFFICIENT_BALANCE')
    }

    const updatedWallet = await tx.wallet.findUnique({
      where: { id: wallet.id },
      select: { balance: true }
    })

    if (!updatedWallet) {
      throw new HttpError(404, 'Wallet not found', 'WALLET_NOT_FOUND')
    }

    const transaction = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: input.operation,
        amount: input.amount,
        balanceAfter: updatedWallet.balance,
        refId: input.refId
      }
    })

    await tx.walletIdempotency.create({
      data: {
        key: input.idempotencyKey,
        walletId: wallet.id,
        operation: input.operation,
        amount: input.amount,
        refId: input.refId,
        balance: updatedWallet.balance,
        transactionId: transaction.id
      }
    })

    return { balance: updatedWallet.balance, replayed: false }
  })
}

export async function mutateWallet(input: MutationInput): Promise<MutationResult> {
  try {
    return await mutateWalletOnce(input)
  } catch (error) {
    // Concurrent retries can both observe no idempotency row. The unique key
    // makes only one commit; the other request re-reads the committed result.
    if (!isUniqueConstraintError(error)) {
      throw error
    }

    const existing = await prisma.walletIdempotency.findUnique({
      where: { key: input.idempotencyKey }
    })

    if (!existing) {
      throw error
    }

    assertSameIdempotentRequest(existing, input)
    return { balance: existing.balance, replayed: true }
  }
}

export async function getWalletHistory(userId: number, page: number, limit: number) {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    select: { id: true }
  })

  if (!wallet) {
    throw new HttpError(404, 'Wallet not found', 'WALLET_NOT_FOUND')
  }

  const [transactions, total] = await prisma.$transaction([
    prisma.walletTransaction.findMany({
      where: { walletId: wallet.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.walletTransaction.count({ where: { walletId: wallet.id } })
  ])

  return { transactions, total }
}
