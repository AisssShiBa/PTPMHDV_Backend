import { DomainException } from '../utils/domain.exception';
import { internalKey } from '../config/secrets';

function getInternalKey(): string {
  return internalKey || process.env.INTERNAL_KEY?.trim() || '';
}

export type TopupCreditResult =
  | { outcome: 'success'; transactionId: string | null; replayed: boolean }
  | { outcome: 'rejected'; status: number; code: string; message: string }
  | { outcome: 'unknown'; status: number | null; code: string | null };

export class WalletClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.WALLET_SERVICE_URL || 'http://wallet-service:3004';
  }

  // Gọi HTTP POST với định tuyến động và Header bảo mật:
  // - action: 
  //    + hold -> /api/wallets/{userId}/hold.
  //    + capture -> /api/wallets/{userId}/capture.
  //    + release -> /api/wallets/{userId}/release.
  // - header x-internal-key để xác thực.
  // - giới hạn thời gian chờ: 5s, tránh trường hợp bị treo mạng.
  private async request(userId: string, action: string, body: unknown) {
    let response: Response;
    try {
      response = await fetch(this.baseUrl + '/api/wallets/' + userId + '/' + action, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': getInternalKey() },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
      });
    } catch { 
      // Báo lỗi không gọi được wallet-service để P2pSerive có thể gọi lại (retry)
      throw new DomainException(503, 'WALLET_UNAVAILABLE', 'Wallet temporarily unavailable'); 
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const { code, message, details, ...metadata } = json.error || {};
      throw new DomainException(response.status, code || 'WALLET_ERROR', message || 'Wallet rejected operation',
        details ?? (Object.keys(metadata).length ? metadata : undefined));
    }
    return json.data;
  }
  async createHold(userId: string, amount: string, referenceId: string, expiresAt: string, destinationUserId?: string, destinationOwnerType?: string) {
    return this.request(userId, 'hold', { amount, referenceId, expiresAt, destinationUserId, destinationOwnerType });
  }
  async extendHold(userId: string, referenceId: string, expiresAt: string) {
    return this.request(userId, 'hold/extend', { referenceId, expiresAt });
  }
  async captureHold(userId: string, referenceId: string) {
    return this.request(userId, 'capture', { referenceId });
  }
  async releaseHold(userId: string, referenceId: string) {
    return this.request(userId, 'release', { referenceId });
  }

  async refundCapture(userId: string, originalReferenceId: string, referenceId: string, amount: string) {
    return this.request(userId, 'refund', { originalReferenceId, referenceId, amount });
  }

  async lookupTransaction(referenceId: string) {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/wallets/transactions/lookup?referenceId=${encodeURIComponent(referenceId)}`, {
        method: 'GET',
        headers: { 'x-internal-key': getInternalKey() },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new DomainException(503, 'WALLET_UNAVAILABLE', 'Wallet temporarily unavailable');
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const { code, message, details, ...metadata } = json.error || {};
      throw new DomainException(response.status, code || 'WALLET_ERROR', message || 'Wallet rejected operation',
        details ?? (Object.keys(metadata).length ? metadata : undefined));
    }
    return json.data;
  }

  async refundCredit(userId: string, amount: string, referenceId: string) {
    const response = await fetch(`${this.baseUrl}/api/wallets/${userId}/credit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': getInternalKey()
      },
      body: JSON.stringify({ amount, referenceId })
    });

    if (!response.ok) {
      throw new Error('Credit failed');
    }
  }

  /**
   * Cộng tiền vào ví người dùng.
   *
   * Có 3 kết quả trả về:
   *  - success  : Ví đã cộng tiền thành công (hoặc phát hiện giao dịch đã được cộng 
   *              trước đó và trả lại kết quả cũ); tiền chỉ được chuyển đúng một lần duy nhất.
   *  - rejected : Ví đã từ chối một cách chắc chắn/ dứt khoát; có thể an toàn giữ đơn 
   *              nạp tiền ở trạng thái mở để đối soát, nhưng không tự động gọi cộng tiền lại.
   *  - unknown  : Lỗi đường truyền, quá thời gian chờ(timeout), lỗi 5xx từ server hoặc body 
   *              phản hồi sai định dạng => lúc này không được đánh dấu đơn nạp tiền là thất bại.
   * Các mã lỗi 408/ 429 được xem là unknown: chúng báo hiệu "hãy tth lại", chứ không phải "bị từ chối".
   */
  async topupCredit(userId: string, amount: string, referenceId: string): Promise<TopupCreditResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/wallets/${userId}/credit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': getInternalKey()
        },
        body: JSON.stringify({ amount, referenceId, transferType: 'TOPUP' }),
        signal: AbortSignal.timeout(5000)
      });
    } catch {
      return { outcome: 'unknown', status: null, code: null };
    }

    let json: any = null;
    try {
      json = await response.json();
    } catch {
      // Một phản hồi c HTTP status 2xx nhưng phần body không parse được JSON vẫn có nghĩa là ví có thể đã côjng tiền rồi.
      return response.ok
        ? { outcome: 'unknown', status: response.status, code: 'INVALID_WALLET_RESPONSE' }
        : this.classifyRejection(response.status, null);
    }

    if (response.ok) {
      const transactionId = json?.data?.transactionId;
      if (typeof transactionId !== 'string' || transactionId.length === 0) {
        return { outcome: 'unknown', status: response.status, code: 'INVALID_WALLET_RESPONSE' };
      }
      return { outcome: 'success', transactionId, replayed: json?.data?.replayed === true };
    }

    return this.classifyRejection(response.status, json?.error);
  }

  private classifyRejection(status: number, error: any): TopupCreditResult {
    const code = typeof error?.code === 'string' ? error.code : null;

    // 401/403 means our internal key or role wiring is broken, not that the
    // wallet refused this credit. Treating it as a business rejection would
    // strand money the customer already paid.
    if (status === 401 || status === 403) {
      console.error('[Wallet] Credit rejected by internal auth — check INTERNAL_KEY/role configuration', { status, code });
      return { outcome: 'unknown', status, code };
    }

    // 408/429 and 5xx are retryable; 404 may be a wallet that has not been
    // provisioned yet, so it must also stay recoverable rather than terminal.
    if (status === 404 || status === 408 || status === 429 || status >= 500) {
      return { outcome: 'unknown', status, code };
    }

    return {
      outcome: 'rejected',
      status,
      code: code ?? 'WALLET_REJECTED',
      message: typeof error?.message === 'string' ? error.message : 'Wallet rejected credit',
    };
  }

  // Lấy số dư người dùng trước khi thực hiện giao dịch như:
  //  - Người dùng chuyển tiền cho một người khác.
  async getBalance(userId: string) {
    try {
      const response = await fetch(`${this.baseUrl}/api/wallets/${userId}/balance`, {
        method: 'GET',
        headers: {
          'x-internal-key': getInternalKey()
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
