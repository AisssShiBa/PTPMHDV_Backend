export function shouldPublishLegacyWalletEvent(payload: Record<string, unknown>): boolean {
  return payload.transferType !== 'P2P_TRANSFER' && payload.isPeerTransfer !== true
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
