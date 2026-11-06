import { Prisma, TopupStatus } from '@prisma/client';
import * as crypto from 'crypto';
import { DomainException } from '../utils/domain.exception';
import { WalletClient } from '../clients/wallet.client';
import { prisma } from '../utils/prisma';

const defaultWalletClient = new WalletClient();

type VnpayParams = Record<string, string>;

type SignatureResult = { ok: true; params: VnpayParams } | { ok: false; reason: string };

type CreditOutcome = 'approved' | 'rejected' | 'unknown';

// Minimal surface of the Prisma client this service touches. Keeping it
// structural lets tests drive every IPN branch with a fake store, which is
// required to prove the money-safety paths without a live database.
export interface TopupStore {
  topupRequest: any;
  topupAuditLog: any;
  $executeRaw: any;
}

export interface TopupServiceDeps {
  store?: TopupStore;
  walletClient?: Pick<WalletClient, 'topupCredit'>;
}

// VNPAY terminates the IPN flow on 00/02 and retries on 99.
const RSP = {
  SUCCESS: '00',
  ORDER_NOT_FOUND: '01',
  ALREADY_CONFIRMED: '02',
  INVALID_AMOUNT: '04',
  INVALID_SIGNATURE: '97',
  UNKNOWN_ERROR: '99',
} as const;

// A PROCESSING record may be re-claimed only after this lease window.
const PROCESSING_LEASE_MS = 2 * 60 * 1000;

export class TopupService {
  private readonly store: TopupStore;
  private readonly walletClient: Pick<WalletClient, 'topupCredit'>;

  constructor(deps: TopupServiceDeps = {}) {
    this.store = deps.store ?? (prisma as unknown as TopupStore);
    this.walletClient = deps.walletClient ?? defaultWalletClient;
  }

  async createTopup(userId: string, amount: number, ipAddr: string) {
    const tmnCode = this.requireConfig('VNP_TMN_CODE');
    const secretKey = this.requireConfig('VNP_HASH_SECRET');
    const vnpUrl = this.requireConfig('VNP_URL');
    const returnUrl = this.requireConfig('VNP_RETURN_URL');

    const amountDecimal = new Prisma.Decimal(amount);
    if (!amountDecimal.isInteger() || amountDecimal.lte(0)) {
      throw new DomainException(400, 'INVALID_AMOUNT', 'Amount must be a positive integer VND value');
    }

    const code = 'NAP' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    const createDate = this.formatDate(new Date());
    const expireDate = this.formatDate(expiresAt);

    const topup = await this.store.topupRequest.create({
      data: {
        userId,
        amount: amountDecimal,
        code,
        expiresAt,
        status: TopupStatus.PENDING,
        auditLogs: {
          create: {
            actorId: userId,
            action: 'CREATE',
            toStatus: TopupStatus.PENDING,
          }
        }
      }
    });

    const vnpParams: Record<string, string> = {
      vnp_Version: '2.1.0',
      vnp_Command: 'pay',
      vnp_TmnCode: tmnCode,
      vnp_Locale: 'vn',
      vnp_CurrCode: 'VND',
      vnp_TxnRef: code,
      vnp_OrderInfo: 'Nap tien vao vi ' + code,
      vnp_OrderType: 'other',
      vnp_Amount: amountDecimal.mul(100).toFixed(0),
      vnp_ReturnUrl: returnUrl,
      vnp_IpAddr: ipAddr,
      vnp_CreateDate: createDate,
      vnp_ExpireDate: expireDate,
    };

    const sorted = this.sortObject(vnpParams);
    const signed = this.sign(sorted, secretKey);
    const paymentUrl = vnpUrl + '?' + new URLSearchParams({ ...sorted, vnp_SecureHash: signed }).toString();

    await this.store.topupRequest.update({
      where: { id: topup.id },
      data: { paymentUrl }
    });

    return { topupId: topup.id, paymentUrl };
  }

  async handleVnpayIpn(queryArgs: unknown) {
    const verification = this.verifySignature(queryArgs);
    if (!verification.ok) {
      return { RspCode: RSP.INVALID_SIGNATURE, Message: 'Invalid signature' };
    }

    const params = verification.params;
    const orderId = params['vnp_TxnRef'];
    const responseCode = params['vnp_ResponseCode'];
    const transactionStatus = params['vnp_TransactionStatus'];

    const topup = await this.store.topupRequest.findUnique({ where: { code: orderId } });
    if (!topup) {
      return { RspCode: RSP.ORDER_NOT_FOUND, Message: 'Order not found' };
    }

    if (!this.amountMatches(topup.amount, params['vnp_Amount'])) {
      return { RspCode: RSP.INVALID_AMOUNT, Message: 'Invalid amount' };
    }

    // A terminal order can never be flipped by a late or replayed callback.
    if (topup.status === TopupStatus.APPROVED) {
      return { RspCode: RSP.ALREADY_CONFIRMED, Message: 'Order already confirmed' };
    }
    if (topup.status === TopupStatus.FAILED || topup.status === TopupStatus.REJECTED || topup.status === TopupStatus.EXPIRED) {
      return { RspCode: RSP.ALREADY_CONFIRMED, Message: 'Order already confirmed' };
    }

    // Only a bank-confirmed payment counts as paid. responseCode 00 with a
    // non-zero transactionStatus means the money did not move.
    const paid = responseCode === '00' && transactionStatus === '00';

    // "Not paid" is only a fact when VNPAY actually said so. responseCode 00
    // without a transactionStatus is an incomplete message, not a failure:
    // persisting FAILED there could strand money that did move.
    const clearlyNotPaid = responseCode !== '00' || (transactionStatus !== undefined && transactionStatus !== '00');

    if (!paid && !clearlyNotPaid) {
      return { RspCode: RSP.UNKNOWN_ERROR, Message: 'Incomplete VNPAY result' };
    }

    if (!paid) {
      // Do not downgrade a record that another worker already claimed as
      // PROCESSING (that path may have credited the wallet).
      // updateMany takes scalars only: nested relation writes are unsupported,
      // so the audit row is appended after the conditional status change wins.
      const failed = await this.store.topupRequest.updateMany({
        where: { id: topup.id, status: TopupStatus.PENDING },
        data: {
          status: TopupStatus.FAILED,
          vnpTransactionNo: params['vnp_TransactionNo'] ?? null,
          vnpBankCode: params['vnp_BankCode'] ?? null,
          vnpPayDate: params['vnp_PayDate'] ?? null,
          vnpResponseCode: responseCode ?? null,
        }
      });
      if (failed.count === 0) {
        return { RspCode: RSP.ALREADY_CONFIRMED, Message: 'Order already confirmed' };
      }
      await this.recordAudit(topup.id, {
        actorId: 'SYSTEM',
        action: 'VNPAY_IPN_FAILED',
        fromStatus: TopupStatus.PENDING,
        toStatus: TopupStatus.FAILED,
        reason: `VNPAY reported responseCode=${responseCode ?? 'null'} transactionStatus=${transactionStatus ?? 'null'}`
      });
      return { RspCode: RSP.SUCCESS, Message: 'Confirm Success' };
    }

    const claimed = await this.claimForProcessing(topup.id, topup.status, params);
    if (!claimed) {
      const current = await this.store.topupRequest.findUnique({ where: { id: topup.id }, select: { status: true } });
      if (current?.status === TopupStatus.APPROVED) {
        return { RspCode: RSP.ALREADY_CONFIRMED, Message: 'Order already confirmed' };
      }
      if (current?.status === TopupStatus.FAILED || current?.status === TopupStatus.REJECTED || current?.status === TopupStatus.EXPIRED) {
        return { RspCode: RSP.ALREADY_CONFIRMED, Message: 'Order already confirmed' };
      }
      // Another worker holds an active lease. Let VNPAY retry instead of
      // acknowledging an outcome we have not confirmed yet.
      return { RspCode: RSP.UNKNOWN_ERROR, Message: 'Processing in progress' };
    }

    const outcome = await this.creditAndApprove(topup.id, topup.userId, topup.amount.toFixed(2), topup.code, Boolean(claimed.fromPending));

    if (outcome === 'approved') {
      return { RspCode: RSP.SUCCESS, Message: 'Confirm Success' };
    }
    // Never acknowledge success when the wallet state is unknown. VNPAY keeps
    // retrying (99) and the recovery worker reconciles the same topup.code.
    return { RspCode: RSP.UNKNOWN_ERROR, Message: outcome === 'rejected' ? 'Wallet rejected credit; pending reconciliation' : 'Unknown error' };
  }

  async handleVnpayReturn(queryArgs: unknown) {
    const verification = this.verifySignature(queryArgs);
    if (!verification.ok) {
      throw new DomainException(400, 'INVALID_SIGNATURE', 'Chữ ký VNPAY không hợp lệ');
    }
    // Read-only: the return URL must never credit the wallet.
    return verification.params;
  }

  /**
   * Reconciles PROCESSING topups whose VNPAY payment was verified as paid.
   * Uses the stored referenceId (topup.code) so Wallet idempotency guarantees
   * that a retried credit never creates a second transaction.
   */
  async recoverStuckTopups(limit = 20) {
    const cutoff = new Date(Date.now() - PROCESSING_LEASE_MS);
    const rows = await this.store.topupRequest.findMany({
      where: {
        status: TopupStatus.PROCESSING,
        vnpResponseCode: '00',
        updatedAt: { lt: cutoff },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { id: true, userId: true, amount: true, code: true },
    });

    let approved = 0;
    let retried = 0;
    for (const row of rows) {
      const claimed = await this.store.$executeRaw`
        UPDATE "TopupRequest"
        SET "updatedAt" = NOW()
        WHERE id = ${row.id}::uuid
          AND status = 'PROCESSING'
          AND "vnpResponseCode" = '00'
          AND "updatedAt" < ${cutoff}
      `;
      if (claimed !== 1) continue;

      const outcome = await this.creditAndApprove(row.id, row.userId, row.amount.toFixed(2), row.code, false);
      if (outcome === 'approved') approved++;
      else retried++;
    }

    if (approved > 0 || retried > 0) {
      console.log(`[Job:recoverTopups] approved=${approved} retried=${retried}`);
    }
    return { scanned: rows.length, approved, retried };
  }

  async getTopup(id: string, userId: string) {
    const topup = await this.store.topupRequest.findUnique({ where: { id } });
    if (!topup) throw new DomainException(404, 'NOT_FOUND', 'Topup request not found');
    if (topup.userId !== userId) throw new DomainException(403, 'FORBIDDEN', 'Access denied');
    return topup;
  }

  async getMyTopups(userId: string) {
    return this.store.topupRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });
  }

  async getAdminTopups(status?: string) {
    const whereClause = status ? { status: status as TopupStatus } : {};
    return this.store.topupRequest.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' }
    });
  }

  async approveTopup(id: string, adminId: string) {
    throw new DomainException(400, 'NOT_ALLOWED', 'Manual approve is disabled for VNPAY integration. Use for resolving stuck orders only.');
  }

  async rejectTopup(id: string, adminId: string, reason: string) {
    throw new DomainException(400, 'NOT_ALLOWED', 'Manual reject is disabled for VNPAY integration.');
  }

  /**
   * Appends an audit row after a conditional update already won. Audit is
   * best-effort by design: failing it must never roll back a money decision.
   */
  private async recordAudit(topupRequestId: string, entry: {
    actorId: string;
    action: string;
    fromStatus: TopupStatus;
    toStatus: TopupStatus;
    reason?: string;
  }) {
    try {
      await this.store.topupAuditLog.create({ data: { topupRequestId, ...entry } });
    } catch (error) {
      console.error('[Topup] Audit write failed', { topupRequestId, action: entry.action,
        error: (error as Error)?.message });
    }
  }

  private async claimForProcessing(
    topupId: string,
    previousStatus: TopupStatus,
    params: VnpayParams
  ): Promise<{ fromPending: boolean } | null> {
    const leaseCutoff = new Date(Date.now() - PROCESSING_LEASE_MS);
    const updated = await this.store.$executeRaw`
      UPDATE "TopupRequest"
      SET status = 'PROCESSING',
          "updatedAt" = NOW(),
          "vnpTransactionNo" = ${params['vnp_TransactionNo'] ?? null},
          "vnpBankCode" = ${params['vnp_BankCode'] ?? null},
          "vnpPayDate" = ${params['vnp_PayDate'] ?? null},
          "vnpResponseCode" = ${params['vnp_ResponseCode'] ?? null}
      WHERE id = ${topupId}::uuid
        AND (status = 'PENDING' OR (status = 'PROCESSING' AND "updatedAt" < ${leaseCutoff}))
    `;
    if (updated !== 1) return null;

    if (previousStatus === TopupStatus.PENDING) {
      await this.store.topupAuditLog.create({
        data: {
          topupRequestId: topupId,
          actorId: 'VNPAY_SYSTEM',
          action: 'VNPAY_IPN_ACCEPTED',
          fromStatus: TopupStatus.PENDING,
          toStatus: TopupStatus.PROCESSING,
        }
      }).catch(() => undefined);
    }
    return { fromPending: previousStatus === TopupStatus.PENDING };
  }

  private async creditAndApprove(
    topupId: string,
    userId: string,
    amount: string,
    code: string,
    fromPending: boolean
  ): Promise<CreditOutcome> {
    let result;
    try {
      result = await this.walletClient.topupCredit(userId, amount, code);
    } catch (error) {
      // Transport failure: outcome unknown, the record stays PROCESSING.
      console.error('[Topup] Wallet credit transport failure', { topupId, code, error: (error as Error)?.message });
      return 'unknown';
    }

    if (result.outcome === 'success') {
      // Scalars only: updateMany rejects nested relation writes.
      const updated = await this.store.topupRequest.updateMany({
        where: { id: topupId, status: TopupStatus.PROCESSING },
        data: {
          status: TopupStatus.APPROVED,
          walletTransactionId: result.transactionId ?? null,
          approvedAt: new Date(),
          approvedBy: 'VNPAY_SYSTEM',
        }
      });
      if (updated.count !== 1 && !result.replayed) return 'unknown';
      await this.recordAudit(topupId, {
        actorId: 'SYSTEM',
        action: 'VNPAY_IPN_SUCCESS',
        fromStatus: TopupStatus.PROCESSING,
        toStatus: TopupStatus.APPROVED,
        reason: result.replayed ? 'wallet credit replayed (already applied)' : undefined,
      });
      return 'approved';
    }

    if (result.outcome === 'rejected') {
      // Paid but the wallet refused the credit: this is an operational error,
      // not a payment failure. Keep PROCESSING so the money is never lost and
      // the recovery worker keeps reconciling; log once for alerting.
      console.error('[Topup] Wallet definitively rejected credit', {
        topupId,
        code,
        walletStatus: result.status,
        walletCode: result.code,
      });
      await this.store.topupAuditLog.create({
        data: {
          topupRequestId: topupId,
          actorId: 'SYSTEM',
          action: 'WALLET_CREDIT_REJECTED',
          fromStatus: TopupStatus.PROCESSING,
          toStatus: TopupStatus.PROCESSING,
          reason: `${result.code}: ${result.message}`.slice(0, 500),
        }
      }).catch(() => undefined);
      return 'rejected';
    }

    console.error('[Topup] Wallet credit outcome unknown', {
      topupId,
      code,
      walletStatus: result.status,
      walletCode: result.code,
    });
    return 'unknown';
  }

  private verifySignature(queryArgs: unknown): SignatureResult {
    if (!queryArgs || typeof queryArgs !== 'object') {
      return { ok: false, reason: 'missing query' };
    }

    let secretKey: string;
    try {
      secretKey = this.requireConfig('VNP_HASH_SECRET');
    } catch {
      return { ok: false, reason: 'missing secret' };
    }

    const raw = { ...(queryArgs as Record<string, unknown>) };
    const secureHash = raw['vnp_SecureHash'];
    if (typeof secureHash !== 'string' || !/^[0-9a-fA-F]{128}$/.test(secureHash)) {
      return { ok: false, reason: 'missing secure hash' };
    }
    delete raw['vnp_SecureHash'];
    delete raw['vnp_SecureHashType'];

    const params: VnpayParams = {};
    for (const [key, value] of Object.entries(raw)) {
      // Only canonical single vnp_* string parameters are part of the checksum.
      // Arrays (duplicated query keys) and non-VNPAY keys are rejected outright.
      if (!key.startsWith('vnp_')) return { ok: false, reason: `unexpected parameter ${key}` };
      if (typeof value !== 'string') return { ok: false, reason: `non-string parameter ${key}` };
      params[key] = value;
    }

    const required = ['vnp_TxnRef', 'vnp_Amount', 'vnp_ResponseCode', 'vnp_TmnCode'];
    if (required.some(key => !params[key])) {
      return { ok: false, reason: 'missing required parameters' };
    }

    if (params['vnp_TmnCode'] !== this.requireConfig('VNP_TMN_CODE')) {
      return { ok: false, reason: 'unknown terminal' };
    }

    const expected = this.sign(this.sortObject(params), secretKey);
    const expectedBuf = Buffer.from(expected, 'utf8');
    const providedBuf = Buffer.from(secureHash.toLowerCase(), 'utf8');
    if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
      return { ok: false, reason: 'checksum mismatch' };
    }
    return { ok: true, params };
  }

  private amountMatches(topupAmount: Prisma.Decimal, rawAmount?: string): boolean {
    if (!rawAmount || !/^[0-9]+$/.test(rawAmount)) return false;
    const expected = topupAmount.mul(100);
    if (!expected.isInteger()) return false;
    try {
      return expected.equals(new Prisma.Decimal(rawAmount));
    } catch {
      return false;
    }
  }

  private requireConfig(key: string): string {
    const value = process.env[key]?.trim();
    if (!value) throw new DomainException(500, SERVER_ERROR, `${key} is not configured`);
    return value;
  }

  private sign(sortedParams: VnpayParams, secretKey: string): string {
    const signData = Object.entries(sortedParams)
      .map(([key, value]) => `${key}=${encodeURIComponent(value).replace(/%20/g, '+')}`)
      .join('&');
    return crypto.createHmac('sha512', secretKey).update(Buffer.from(signData, 'utf-8')).digest('hex');
  }

  private sortObject(obj: Record<string, string>): VnpayParams {
    const sorted: VnpayParams = {};
    for (const key of Object.keys(obj).sort()) sorted[key] = String(obj[key]);
    return sorted;
  }

  private formatDate(date: Date) {
    // VNPAY expects Asia/Ho_Chi_Minh (UTC+7) timestamps.
    const tzOffset = 7 * 60; // 7 hours in minutes
    const localTime = new Date(date.getTime() + tzOffset * 60000);

    const yyyy = localTime.getUTCFullYear().toString();
    const mm = (localTime.getUTCMonth() + 1).toString().padStart(2, '0');
    const dd = localTime.getUTCDate().toString().padStart(2, '0');
    const hh = localTime.getUTCHours().toString().padStart(2, '0');
    const min = localTime.getUTCMinutes().toString().padStart(2, '0');
    const ss = localTime.getUTCSeconds().toString().padStart(2, '0');
    return yyyy + mm + dd + hh + min + ss;
  }
}

const SERVER_ERROR = 'SERVER_ERROR';
