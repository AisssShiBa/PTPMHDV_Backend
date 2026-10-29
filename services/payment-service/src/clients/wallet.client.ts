import { DomainException } from '../utils/domain.exception';
import { internalKey } from '../config/secrets';

export class WalletClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.WALLET_SERVICE_URL || 'http://wallet-service:3004';
  }

  async createHold(userId: string, amount: string, referenceId: string, expiresAt: string, destinationUserId?: string, destinationOwnerType?: string) {
    const body: any = { amount, referenceId, expiresAt };
    if (destinationUserId) {
      body.destinationUserId = destinationUserId;
    }
    if (destinationOwnerType) {
      body.destinationOwnerType = destinationOwnerType;
    }
    const response = await fetch(`${this.baseUrl}/api/wallets/${userId}/hold`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': internalKey!
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData.error?.message || errorData.message || 'Failed to hold amount in wallet';
      throw new DomainException(400, 'HOLD_FAILED', errorMsg);
    }
  }

  async captureHold(userId: string, referenceId: string) {
    const response = await fetch(`${this.baseUrl}/api/wallets/${userId}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': internalKey!
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
          'x-internal-key': internalKey!
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

  // Lấy số dư người dùng trước khi thực hiện giao dịch như:
  //  - Người dùng chuyển tiền cho một người khác.
  async getBalance(userId: string) {
    try {
      const response = await fetch(`${this.baseUrl}/api/wallets/${userId}/balance`, {
        method: 'GET',
        headers: {
          'x-internal-key': internalKey!
        }
      });

      if (!response.ok) {
        return null;
      }
      const resData = await response.json();
      return resData.data;
    } catch (err: any) {
      console.error(`[Wallet getBalance] Error fetching balance for ${userId}:`, err.message);
      return null;
    }
  }
}

