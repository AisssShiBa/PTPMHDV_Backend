import { DomainException } from '../utils/domain.exception';
import { internalKey } from '../config/secrets';

export class WalletClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.WALLET_SERVICE_URL || 'http://wallet-service:3004';
  }

  private async request(userId: string, action: string, body: unknown) {
    let response: Response;
    try {
      response = await fetch(this.baseUrl + '/api/wallets/' + userId + '/' + action, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': internalKey! },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
      });
    } catch { throw new DomainException(503, 'WALLET_UNAVAILABLE', 'Wallet temporarily unavailable'); }
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const { code, message, details, ...metadata } = json.error || {};
      throw new DomainException(response.status, code || 'WALLET_ERROR', message || 'Wallet rejected operation',
        details ?? (Object.keys(metadata).length ? metadata : undefined));
    }
    return json.data;
  }
  async createHold(userId: string, amount: string, referenceId: string, expiresAt: string, destinationUserId?: string) {
    return this.request(userId, 'hold', { amount, referenceId, expiresAt, destinationUserId });
  }
  async captureHold(userId: string, referenceId: string) {
    return this.request(userId, 'capture', { referenceId });
  }
  async releaseHold(userId: string, referenceId: string) {
    return this.request(userId, 'release', { referenceId });
  }

  async credit(userId: string, amount: string, referenceId: string) {
    try {
      const response = await fetch(`${this.baseUrl}/api/wallets/${userId}/credit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': internalKey!
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
        'x-internal-key': internalKey!
      },
      body: JSON.stringify({ amount, referenceId })
    });

    if (!response.ok) {
      throw new Error('Credit failed');
    }
  }

  async topupCredit(userId: string, amount: string, referenceId: string) {
    const response = await fetch(`${this.baseUrl}/api/wallets/${userId}/credit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': internalKey!
      },
      body: JSON.stringify({ amount, referenceId, transferType: 'TOPUP' })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return { success: false, status: response.status, errorData };
    }
    const data = await response.json();
    return { success: true, data };
  }
}
