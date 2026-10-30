import { createSingleFlight } from 'finvault-events'

export function shouldPublishLegacyWalletEvent(payload: Record<string, unknown>): boolean {
  return payload.transferType !== 'P2P_TRANSFER' &&
    payload.transferType !== 'PAYMENT' &&
    payload.isPeerTransfer !== true
}

export function isPeerWalletPayment(
  transferType: string,
  sourceOwnerType: string,
  destinationOwnerType: string
): boolean {
  return transferType === 'PAYMENT' &&
    sourceOwnerType === 'USER' &&
    destinationOwnerType === 'USER'
}

export class InvalidWalletOutboxDataError extends TypeError {}

export const createWalletOutboxDrain = (drain: () => Promise<void>): (() => Promise<void>) =>
  createSingleFlight(drain)

export function validateWalletOutboxPayload(
  topic: string,
  payload: Record<string, unknown>
): void {
  if (topic !== 'wallet.balance_added' && topic !== 'wallet.balance_deducted') {
    throw new InvalidWalletOutboxDataError('Unsupported wallet outbox topic')
  }
  for (const field of ['userId', 'amount', 'balanceAfter', 'transferType']) {
    const value = payload[field]
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new InvalidWalletOutboxDataError(`Invalid wallet outbox ${field}`)
    }
  }
}
