import { DomainException } from '../utils/domain.exception';

export class WalletClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.WALLET_SERVICE_URL || 'http://wallet-service:3004';
  }

  async createHold(userId: string, amount: string, referenceId: string, expiresAt: string) {
    const response = await fetch(`${this.baseUrl}/api/wallets/${userId}/hold`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': process.env.INTERNAL_KEY || 'default_internal_secret_key_123456'
      },
      body: JSON.stringify({ amount, referenceId, expiresAt })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new DomainException(400, 'HOLD_FAILED', errorData.message || 'Failed to hold amount in wallet');
    }
  }

  async captureHold(userId: string, referenceId: string) {
    const response = await fetch(`${this.baseUrl}/api/wallets/${userId}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': process.env.INTERNAL_KEY || 'default_internal_secret_key_123456'
      },
      body: JSON.stringify({ referenceId })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || 'Capture failed');
    }
  }

  async releaseHold(userId: string, holdId: string) {
    try {
      const response = await fetch(`${this.baseUrl}/api/wallets/${userId}/release`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': process.env.INTERNAL_KEY || 'default_internal_secret_key_123456'
        },
        body: JSON.stringify({ referenceId: holdId })
      });

      if (!response.ok) {
        console.error(`[Wallet Release] Failed to release hold ${holdId} for user ${userId}. Wallet returned non-OK.`);
      } else {
        console.log(`[Wallet Release] Successfully released hold ${holdId} for user ${userId}.`);
      }
    } catch (error: any) {
      console.error(`[Wallet Release] Network/System Error releasing hold ${holdId} for user ${userId}:`, error.message);
    }
  }

  async credit(userId: string, amount: string, referenceId: string) {
    try {
      const response = await fetch(`${this.baseUrl}/api/wallets/${userId}/credit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': process.env.INTERNAL_KEY || 'default_internal_secret_key_123456'
        },
        body: JSON.stringify({ amount, referenceId })
      });

      if (!response.ok) {
        console.error(`[Wallet Credit] Failed to refund (compensate) ${amount} for user ${userId}. Wallet returned non-OK.`);
      } else {
        console.log(`[Wallet Credit] Successfully refunded (compensated) ${amount} for user ${userId}.`);
      }
    } catch (error: any) {
      console.error(`[Wallet Credit] Network/System Error refunding user ${userId}:`, error.message);
    }
  }

  async refundCredit(userId: string, amount: string, referenceId: string) {
    const response = await fetch(`${this.baseUrl}/api/wallets/${userId}/credit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': process.env.INTERNAL_KEY || 'default_internal_secret_key_123456'
      },
      body: JSON.stringify({ amount, referenceId })
    });

    if (!response.ok) {
      throw new Error('Credit failed');
    }
  }
}
