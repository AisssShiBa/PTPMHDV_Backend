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
  $transaction?: <T>(work: (tx: TopupStore) => Promise<T>) => Promise<T>;
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

  // Khởi tạo giao dịch nạp tiền và đường link thanh toán VNPAY trả về 
  async createTopup(userId: string, amount: string | number, ipAddr: string, idempotencyKey?: string) {
    const tmnCode = this.requireConfig('VNP_TMN_CODE');
    const secretKey = this.requireConfig('VNP_HASH_SECRET');
    const vnpUrl = this.requireConfig('VNP_URL');
    const returnUrl = this.requireConfig('VNP_RETURN_URL');

    // B1: Kiểm tra hợp lệ số tiền.
    const amountDecimal = new Prisma.Decimal(amount);
    if (!amountDecimal.isInteger() || amountDecimal.lte(0)) {
      throw new DomainException(400, 'INVALID_AMOUNT', 'Amount must be a positive integer VND value');
    }

    // B2: Tham số & Sinh URL thanh toán VNPAY
    const code = 'NAP' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    const createDate = this.formatDate(new Date());
    const expireDate = this.formatDate(expiresAt);

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

    // Lưu trữ đồng thời (ngay trong cùng một lần ghi vào Database) cả đường link URL
    // đã ký và ý định nạp tiền (intent): một phản hồi bị mất kết nối trên đường truyền
    // mạng sẽ không thể tạo ra đơn hàng thứ hai, và các request gửi đến đồng thời sẽ 
    // không bao giờ nhìn thấy một URL mới chỉ được tạo một nửa (chưa hoàn thiện).
    const replay = async () => {
      const existing = await this.store.topupRequest.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
      });
      if (!existing) return null;
      if (!existing.amount.eq(amountDecimal)) {
        throw new DomainException(422, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'Idempotency key has a different payload');
      }
      if (!existing.paymentUrl) {
        throw new DomainException(409, 'TOPUP_CREATION_IN_PROGRESS', 'Topup creation is still pending');
      }
      return { topupId: existing.id, paymentUrl: existing.paymentUrl };
    };
    // B3: Cơ chế chống tạo trùng lặp 
    if (idempotencyKey) {
      const previous = await replay();
      if (previous) return previous;
    }
    try {
      // B4: Lưu và Database & Ghi nhật ký. (Audit log)
      const topup = await this.store.topupRequest.create({
        data: {
          userId, amount: amountDecimal, code, expiresAt, paymentUrl,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          status: TopupStatus.PENDING,
          auditLogs: { create: { actorId: userId, action: 'CREATE', toStatus: TopupStatus.PENDING } },
        },
      });
      return { topupId: topup.id, paymentUrl: topup.paymentUrl };
    } catch (error) {
      if (idempotencyKey && (error as { code?: string }).code === 'P2002') {
        const previous = await replay();
        if (previous) return previous;
      }
      throw error;
    }
  }

  /* 
  Webhook gọi ngầm giữa hai server do VNPAY bắn về khi người dùng hoàn tất (hoặc hủy) thanh toán. (nhận request từ VNPAY)
    - Giai đoạn 1: Bảo mật và tính toàn vẹn.
    - Giai đoạn 2: Chống lặp và đơn đã đóng.
    - Giai đoạn 3: Phân loại kết quả VNPAY.
    - Giai đoạn 4: Tranh chấp khóa 
    - Giai đoạn 5: Gọi cộng ví tiền.
  */ 
  async handleVnpayIpn(queryArgs: unknown) {
    //1. Xác thực chữ kí số.
    const verification = this.verifySignature(queryArgs);
    if (!verification.ok) {
      return { RspCode: RSP.INVALID_SIGNATURE, Message: 'Invalid signature' };
    }

    const params = verification.params;
    const orderId = params['vnp_TxnRef'];
    const responseCode = params['vnp_ResponseCode'];
    const transactionStatus = params['vnp_TransactionStatus'];

    // 2. Kiểm tra đơn hàng và số tiền.
    const topup = await this.store.topupRequest.findUnique({ where: { code: orderId } });
    if (!topup) {
      return { RspCode: RSP.ORDER_NOT_FOUND, Message: 'Order not found' };
    }

    if (!this.amountMatches(topup.amount, params['vnp_Amount'])) {
      return { RspCode: RSP.INVALID_AMOUNT, Message: 'Invalid amount' };
    }

    // 4. Chống lặp và bảo vệ trạng thái cuối.
    // Một đơn hàng đã ở trạng thái APPROVED hoặc FAILED hoặc REJECTED hoặc EXPIRED thì không thể thay đổi nữa
    if (
      topup.status === TopupStatus.APPROVED ||
      topup.status === TopupStatus.FAILED ||
      topup.status === TopupStatus.REJECTED ||
      topup.status === TopupStatus.EXPIRED
    ) {
      return { RspCode: RSP.ALREADY_CONFIRMED, Message: 'Order already confirmed' };
    }

    /*
    - Chỉ khi ngân hàng thực sự xác nhận thành công thì mới được tính là đã thanh toán (paid)
    - Nếu responseCode là 00 nhưng transactionStatus khác 00 thì có nghĩa là tiền chưa hề rời khỏi tài khoản ngân hàng. 
    */
    const paid = responseCode === '00' && transactionStatus === '00';

    /*
    "Not paid" là một giao dịch được coi là 'Thất bại' khi VNPAY thực sư tuyên bố như vậy. 
    Nếu responseCode là 00 mà không có transactionStatus, thì đầy chỉ là một gói tin chưa được trọn vẹn chứ không phải là thanh toán thất bại.
    Nếu vội vàng lưu trạng thái FAILED vào Database thì có thể làm 'treo' tiền cảu khách hàng trang khi thực tế tiền của họ đã bị trừ ở ngân hàng.
    */
    const clearlyNotPaid = responseCode !== '00' || (transactionStatus !== undefined && transactionStatus !== '00');

    if (!paid && !clearlyNotPaid) {
      return { RspCode: RSP.UNKNOWN_ERROR, Message: 'Incomplete VNPAY result' };
    }

    if (!paid) {
      // Không hạ cấp (down grade) một bản ghi mà một worker/ tiến trình khác đang giành quyền xử lý là PROCESSING (bời vì tiền đã vào ví rồi).
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

    // Thực hiện tranh quyền xử lý.
    const claimed = await this.claimForProcessing(topup.id, topup.status, params);
    if (!claimed) {
      const current = await this.store.topupRequest.findUnique({ where: { id: topup.id }, select: { status: true } });
      if (
        current?.status === TopupStatus.APPROVED ||
        current?.status === TopupStatus.FAILED ||
        current?.status === TopupStatus.REJECTED ||
        current?.status === TopupStatus.EXPIRED
      ) {
        return { RspCode: RSP.ALREADY_CONFIRMED, Message: 'Order already confirmed' };
      }
      // Một tiến trình khác đang giữ quyền xử lý. VNPAY sẽ retry sau, thay vì thừa nhận/ báo thành công một kết quả mà
      // hệ thống chún ta thực tế vẫn chưa xác nhận xong.
      return { RspCode: RSP.UNKNOWN_ERROR, Message: 'Processing in progress' };
    }

    const outcome = await this.creditAndApprove(topup.id, topup.userId, topup.amount.toFixed(2), topup.code, Boolean(claimed.fromPending), topup.approvedBy || 'VNPAY_SYSTEM');

    if (outcome === 'approved') {
      return { RspCode: RSP.SUCCESS, Message: 'Confirm Success' };
    }
    // Tuyệt đối không báo giờ báo thành công (acknowledge success) cho VNPAY khi trạng thía thực tế của ví tiền vẫn chưa
    // rõ ràng (unknown). Hãy trả về mã 99 để VNPAY tiếp tục gửi lại (retry), và tiền trình phục hồi ngầm sẽ tự động đối soát
    // dựa trên cùng mã topup.code
    return { RspCode: RSP.UNKNOWN_ERROR, Message: outcome === 'rejected' ? 'Wallet rejected credit; pending reconciliation' : 'Unknown error' };
  }

  // Thanh toán xong trên cổng VNPAY và trình duyệt sẽ chuyển hướng quay về website qua đường dẫn trang web
  async handleVnpayReturn(queryArgs: unknown) {
    const verification = this.verifySignature(queryArgs);
    if (!verification.ok) {
      throw new DomainException(400, 'INVALID_SIGNATURE', 'Chữ ký VNPAY không hợp lệ');
    }
    // Read-only: Return URL tuyệt dối không bao giờ được phép cộng tiền vào tài khoản.
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
        OR: [{ vnpResponseCode: '00' }, { approvedBy: { not: null } }],
        updatedAt: { lt: cutoff },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { id: true, userId: true, amount: true, code: true, approvedBy: true },
    });

    let approved = 0;
    let retried = 0;
    for (const row of rows) {
      const claimed = await this.store.$executeRaw`
        UPDATE "TopupRequest"
        SET "updatedAt" = NOW()
        WHERE id = ${row.id}::uuid
          AND status = 'PROCESSING'
          AND ("vnpResponseCode" = '00' OR "approvedBy" IS NOT NULL)
          AND "updatedAt" < ${cutoff}
      `;
      if (claimed !== 1) continue;

      const outcome = await this.creditAndApprove(row.id, row.userId, row.amount.toFixed(2), row.code, false, row.approvedBy || 'VNPAY_SYSTEM');
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
    // Mở transaction trong Database để kiểm tra và khóa đơn cần duyệt.
    const topup = await this.manualDecision(id, adminId, 'APPROVE');
    // Đơn đã thành công thì trả luôn
    if (topup.status === TopupStatus.APPROVED) return topup;
    // Cả luồng VNPay IPN tự động và luồng Admin duyệt thủ công đều luôn truyền cùng một mã tham chuết referenceId = topup.code khi gọi sang wallet-service
    // Gọi cộng tiền.
    const result = await this.creditAndApprove(topup.id, topup.userId, topup.amount.toFixed(2), topup.code, true, adminId);
    if (result !== 'approved') {
      throw new DomainException(503, 'TOPUP_OUTCOME_UNKNOWN', 'Approval is being reconciled; read the existing request status');
    }
    return this.store.topupRequest.findUnique({ where: { id } });
  }

  async rejectTopup(id: string, adminId: string, reason: string) {
    if (typeof reason !== 'string' || reason.trim().length < 1 || reason.trim().length > 500) {
      throw new DomainException(400, 'INVALID_REASON', 'Rejection reason must contain 1 to 500 characters');
    }
    return this.manualDecision(id, adminId, 'REJECT', reason.trim());
  }

  // Chuyển trạng thái đơn nạp tiền một cách nguyên tử trong database transaction trước khi làm bước tiếp theo
  // Mục đích: chống race condition (nhiều admin bấm cùng lúc) và đảm bảo có audit log trước khi động tới tiền.
  // Dùng chung cho cả approve và reject.
  private async manualDecision(id: string, adminId: string, action: 'APPROVE' | 'REJECT', reason?: string) {
    if (!this.store.$transaction) {
      throw new DomainException(503, 'TOPUP_OUTCOME_UNKNOWN', 'Atomic manual decision storage is unavailable');
    }
    return this.store.$transaction(async tx => {
      const topup = await tx.topupRequest.findUnique({ where: { id } });
      if (!topup) throw new DomainException(404, 'NOT_FOUND', 'Topup request not found');
      if (action === 'APPROVE' && topup.status === TopupStatus.APPROVED) return topup;
      if (action === 'REJECT' && topup.status === TopupStatus.REJECTED) return topup;
      if (topup.status !== TopupStatus.PENDING) {
        throw new DomainException(409, topup.status === TopupStatus.PROCESSING ? 'TOPUP_PROCESSING' : 'INVALID_TRANSITION', 'Topup is no longer pending');
      }
      const now = new Date();
      const status = action === 'APPROVE' ? TopupStatus.PROCESSING : TopupStatus.REJECTED;
      const changed = await tx.topupRequest.updateMany({
        where: { id, status: TopupStatus.PENDING, ...(action === 'APPROVE' ? { expiresAt: { gt: now } } : {}) },
        data: action === 'APPROVE' ? { status, approvedBy: adminId }
          : { status, rejectReason: reason },
      });
      if (changed.count !== 1) {
        throw new DomainException(409, 'INVALID_TRANSITION', 'Topup expired or another decision already won');
      }
      // Nếu ghi audit log thất bại thì bước giành quyềnh xử lý đơn (claim) sẽ bị hoàn tác (rollback) trước khi bất kỳ request nào được gửi sang Wallet.
      await tx.topupAuditLog.create({ data: {
        topupRequestId: id, actorId: adminId, action: action === 'APPROVE' ? 'MANUAL_APPROVE_REQUESTED' : 'MANUAL_REJECT',
        fromStatus: TopupStatus.PENDING, toStatus: status, ...(reason ? { reason } : {}),
      } });
      return { ...topup, status, approvedBy: action === 'APPROVE' ? adminId : topup.approvedBy };
    });
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

  // Gọi cộng tiền.
  private async creditAndApprove(
    topupId: string,
    userId: string,
    amount: string,
    code: string,
    fromPending: boolean,
    actorId = 'VNPAY_SYSTEM'
  ): Promise<CreditOutcome> {
    let result;
    try {
      // Gọi đồng bộ API sang wallet
      result = await this.walletClient.topupCredit(userId, amount, code);
    } catch (error) {
      // Lỗi tầng Transport: kết quả không thể xác định (outcome unknown), bản ghi bắt buộc phải được giữ ngueyen ở trạng thái PROCESSING.
      console.error('[Topup] Wallet credit transport failure', { topupId, code, error: (error as Error)?.message });
      return 'unknown';
    }

    // Phân loại phải hồi từ Wallet.
    if (result.outcome === 'success') {
      // Chỉ nhận các trường đơn lẻ (scalar only): hàm updateMany từ chối các thao tác ghi quan hệ lồng nhau (nested relation writes).
      const updated = await this.store.topupRequest.updateMany({
        where: { id: topupId, status: TopupStatus.PROCESSING },
        data: {
          status: TopupStatus.APPROVED,
          walletTransactionId: result.transactionId ?? null,
          approvedAt: new Date(),
          approvedBy: actorId,
        }
      });
      if (updated.count !== 1 && !result.replayed) return 'unknown';
      await this.recordAudit(topupId, {
        actorId,
        action: actorId === 'VNPAY_SYSTEM' ? 'VNPAY_IPN_SUCCESS' : 'MANUAL_APPROVE_SUCCESS',
        fromStatus: TopupStatus.PROCESSING,
        toStatus: TopupStatus.APPROVED,
        reason: result.replayed ? 'wallet credit replayed (already applied)' : undefined,
      });
      return 'approved';
    }

    if (result.outcome === 'rejected') {
      // Tiền đã thành toán (Paid) nhưng Ví lại từ chối cộng tiền: đây là lỗi vận hành nghiệp vụ
      // chứ không phải là thanh toán thất bại. Bắt buộc phải GIỮ NGUYÊN trạng thái PROCESSING để
      // tiền không bao giờ bị thất lạc và tiếng trình cứu hộ tiếp tục đối soát; ghi log một lần để
      // kích hoạt cảnh báo.
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

  // Xác minh request gửi đến thực sự từ VNPAY.
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
      // Chống tấn công chèn tham số.
      if (!key.startsWith('vnp_')) return { ok: false, reason: `unexpected parameter ${key}` };
      if (typeof value !== 'string') return { ok: false, reason: `non-string parameter ${key}` };
      params[key] = value;
    }

    const required = ['vnp_TxnRef', 'vnp_Amount', 'vnp_ResponseCode', 'vnp_TmnCode'];
    if (required.some(key => !params[key])) {
      return { ok: false, reason: 'missing required parameters' };
    }

    // Kiểm tra định dang do VNPAY cấp.
    if (params['vnp_TmnCode'] !== this.requireConfig('VNP_TMN_CODE')) {
      return { ok: false, reason: 'unknown terminal' };
    }

    const expected = this.sign(this.sortObject(params), secretKey);
    const expectedBuf = Buffer.from(expected, 'utf8');
    const providedBuf = Buffer.from(secureHash.toLowerCase(), 'utf8');
    // Tính năng chống tấn công Timing Attack.
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

  // Thuật toán chuẩn VNPAY,quy định các tham số phải được sắp xếp trước khi băm SHA-512s
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
