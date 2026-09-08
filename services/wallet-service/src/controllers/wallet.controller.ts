import { NextFunction, Request, Response } from 'express'
import {
  decimalToNumber,
  parseAmount,
  parseIdempotencyKey,
  parsePagination,
  parsePositiveId,
  parseRefId
} from '../validation'
import {
  createWallet,
  getWalletBalance,
  getWalletHistory,
  mutateWallet,
  WalletOperation
} from '../services/wallet.service'

export async function createWalletHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = parsePositiveId(String(req.body?.userId ?? ''), 'userId')
    const { wallet, created } = await createWallet(userId)

    return res.status(created ? 201 : 200).json({
      id: wallet.id,
      balance: decimalToNumber(wallet.balance)
    })
  } catch (error) {
    return next(error)
  }
}

export async function getBalanceHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = parsePositiveId(req.params.userId)
    const wallet = await getWalletBalance(userId)

    return res.json({
      balance: decimalToNumber(wallet.balance),
      currency: wallet.currency
    })
  } catch (error) {
    return next(error)
  }
}

async function mutateHandler(
  operation: WalletOperation,
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = parsePositiveId(req.params.userId)
    const amount = parseAmount(req.body?.amount)
    const refId = parseRefId(req.body?.refId)
    const idempotencyKey = parseIdempotencyKey(req.header('Idempotency-Key'))
    const result = await mutateWallet({
      userId,
      operation,
      amount,
      refId,
      idempotencyKey
    })

    return res.json({ balance: decimalToNumber(result.balance) })
  } catch (error) {
    return next(error)
  }
}

export function creditHandler(req: Request, res: Response, next: NextFunction) {
  return mutateHandler('credit', req, res, next)
}

export function debitHandler(req: Request, res: Response, next: NextFunction) {
  return mutateHandler('debit', req, res, next)
}

export async function historyHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = parsePositiveId(req.params.userId)
    const { page, limit } = parsePagination(
      typeof req.query.page === 'string' ? req.query.page : undefined,
      typeof req.query.limit === 'string' ? req.query.limit : undefined
    )
    const { transactions, total } = await getWalletHistory(userId, page, limit)

    return res.json({
      items: transactions.map((transaction) => ({
        id: transaction.id,
        type: transaction.type,
        amount: decimalToNumber(transaction.amount),
        balance: decimalToNumber(transaction.balanceAfter),
        refId: transaction.refId,
        createdAt: transaction.createdAt.toISOString()
      })),
      total
    })
  } catch (error) {
    return next(error)
  }
}
