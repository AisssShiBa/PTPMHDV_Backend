const defaultPassword = process.env.POSTGRES_PASSWORD || '404897ba313a20d9a166a1db0625276a77186fc0160c690a5e6e93ee09e06720';
const paymentDbUrl = process.env.PAYMENT_DATABASE_URL || `postgresql://postgres:${defaultPassword}@localhost:5432/payment_service?schema=public`;
const walletDbUrl = process.env.WALLET_DATABASE_URL || `postgresql://postgres:${defaultPassword}@localhost:5432/wallet_service?schema=public`;

process.env.PAYMENT_DATABASE_URL = paymentDbUrl;
process.env.DATABASE_URL = walletDbUrl;
process.env.RABBITMQ_URL = '';

import assert from 'node:assert/strict';
import { test, before, after, describe } from 'node:test';
import http from 'node:http';
import { randomUUID } from 'crypto';
import { PrismaClient as PaymentPrisma, PaymentType, PaymentStatus, IdempotencyStatus, Prisma } from '@prisma/client';
const { PrismaClient: WalletPrisma } = require('../../wallet-service/node_modules/@prisma/client');
const OwnerType = { USER: 'USER', SYSTEM: 'SYSTEM', MERCHANT: 'MERCHANT' } as const;
import walletApp from '../../wallet-service/src/app';
import { seedLimitPolicies } from '../../wallet-service/prisma/seed';
import { P2pService } from '../src/services/p2p.service';
import { WalletClient } from '../src/clients/wallet.client';
import { DomainException } from '../src/utils/domain.exception';
import { GuardedWalletClient } from './helpers/transaction-guard.helper';

const pPrisma = new PaymentPrisma({ datasources: { db: { url: paymentDbUrl } } });
const wPrisma: any = new WalletPrisma({ datasources: { db: { url: walletDbUrl } } });

let walletServer: http.Server;
let walletClient: WalletClient;
let p2pService: P2pService;
let guardedWallet: GuardedWalletClient;
let guardedP2p: P2pService;

before(async () => {
  await seedLimitPolicies();
  walletServer = http.createServer(walletApp);
  await new Promise<void>((resolve) => walletServer.listen(0, resolve));
  const port = (walletServer.address() as any).port;
  process.env.WALLET_SERVICE_URL = `http://127.0.0.1:${port}`;
  process.env.INTERNAL_KEY = process.env.INTERNAL_KEY || 'e33caedf3f0c0417c80adfd683c06753a53c8f5c50ac1e8d6a3344685de9332f';

  walletClient = new WalletClient();
  p2pService = new P2pService(walletClient);

  guardedWallet = new GuardedWalletClient();
  guardedP2p = new P2pService(guardedWallet);
});

after(async () => {
  walletServer.close();
  await pPrisma.$disconnect();
  await wPrisma.$disconnect();
});

async function createWallet(balance: number, kycTier = 2) {
  const userId = randomUUID();
  const wallet = await wPrisma.wallet.create({
    data: {
      userId,
      ownerType: OwnerType.USER,
      balance,
      heldBalance: 0,
      currency: 'VND',
      status: 'ACTIVE',
      kycTier,
    }
  });
  return { userId, wallet };
}

describe('K16-3: completeHold Decoupled 3-Phase Execution Suite', () => {

  test('Đường thành công: completeHold chạy 3 pha ngoài transaction, hoàn tất IDLE và COMPLETED', async () => {
    const { userId: senderId } = await createWallet(100000);
    const dest = await createWallet(0);

    const res = await guardedP2p.checkout({
      userId: senderId,
      destinationUserId: dest.userId,
      amount: '40000',
      type: 'WALLET_TRANSFER',
      idempotencyKey: `succ-${randomUUID()}`,
    });

    assert.equal(res.payment.workflow, 'IDLE');
    assert.equal(res.payment.idempotencyStatus, 'COMPLETED');
    assert.equal(res.payment.status, 'PENDING');

    const paymentInDb = await pPrisma.payment.findUniqueOrThrow({ where: { id: res.payment.id } });
    assert.equal(paymentInDb.workflow, 'IDLE');
    assert.equal(paymentInDb.workerLeaseUntil, null);
  });

  test('4xx xác định: Ví không đủ tiền -> FAILED, lưu failureReason và PaymentHistory', async () => {
    const { userId: senderId } = await createWallet(10000); // Chỉ có 10.000đ
    const dest = await createWallet(0);

    let errorCaught: DomainException | null = null;
    try {
      await guardedP2p.checkout({
        userId: senderId,
        destinationUserId: dest.userId,
        amount: '80000', // Đòi giữ 80.000đ
        type: 'WALLET_TRANSFER',
        idempotencyKey: `fail-4xx-${randomUUID()}`,
      });
    } catch (err: any) {
      errorCaught = err;
    }

    assert.ok(errorCaught !== null);
    assert.equal(errorCaught.status, 409);
    assert.equal(errorCaught.code, 'INSUFFICIENT_BALANCE');

    // Kiểm tra payment trong DB đã chuyển FAILED
    const payment = await pPrisma.payment.findFirstOrThrow({
      where: { userId: senderId, amount: new Prisma.Decimal('80000') }
    });
    assert.equal(payment.status, 'FAILED');
    assert.equal(payment.idempotencyStatus, 'FAILED');
    assert.equal(payment.failureReason, 'INSUFFICIENT_BALANCE');

    const history = await pPrisma.paymentHistory.findFirst({
      where: { paymentId: payment.id, toStatus: 'FAILED' }
    });
    assert.ok(history !== null, 'Phải có bản ghi PaymentHistory toStatus=FAILED');
  });

  test('Timeout / 5xx không xác định: Giữ nguyên HOLD_CALLING, KHÔNG tự chuyển FAILED, nhả lease', async () => {
    const { userId: senderId } = await createWallet(100000);
    const dest = await createWallet(0);

    // Mock wallet ném 503 WALLET_UNAVAILABLE
    class FailingWalletClient extends WalletClient {
      override async createHold() {
        throw new DomainException(503, 'WALLET_UNAVAILABLE', 'Network timeout to wallet service');
      }
    }

    const failingP2p = new P2pService(new FailingWalletClient());
    let errorCaught: any = null;
    try {
      await failingP2p.checkout({
        userId: senderId,
        destinationUserId: dest.userId,
        amount: '30000',
        type: 'WALLET_TRANSFER',
        idempotencyKey: `indet-${randomUUID()}`,
      });
    } catch (err) {
      errorCaught = err;
    }

    assert.ok(errorCaught !== null);
    assert.equal(errorCaught.status, 503);

    // Kiểm tra payment trong DB: KHÔNG được là FAILED, phải ở trạng thái PENDING với workflow=HOLD_CALLING
    const payment = await pPrisma.payment.findFirstOrThrow({
      where: { userId: senderId, amount: new Prisma.Decimal('30000') }
    });
    assert.equal(payment.status, 'PENDING', 'Payment tuyệt đối KHÔNG được chuyển FAILED khi lỗi không xác định');
    assert.equal(payment.workflow, 'HOLD_CALLING', 'Workflow phải giữ HOLD_CALLING để worker recover');
    assert.equal(payment.workerLeaseUntil, null, 'Lease phải được nhả để worker sau tiếp quản');
  });

  test('Hai request song song gọi completeHold cùng payment -> đúng 1 tác động ở ví', async () => {
    const { userId: senderId } = await createWallet(100000);
    const dest = await createWallet(0);

    // Tạo payment thủ công ở trạng thái HOLDING
    const paymentId = randomUUID();
    const holdId = randomUUID();
    await pPrisma.payment.create({
      data: {
        id: paymentId,
        userId: senderId,
        destinationUserId: dest.userId,
        amount: '35000',
        type: 'WALLET_TRANSFER',
        referenceId: `ref-${paymentId}`,
        callbackTopic: 'finvault.events',
        idempotencyKey: `conc-hold-${paymentId}`,
        requestHash: 'hash',
        idempotencyStatus: 'PROCESSING',
        idempotencyExpiresAt: new Date(Date.now() + 86400000),
        holdId,
        holdExpiresAt: new Date(Date.now() + 300000),
        workflow: 'HOLDING',
        status: 'PENDING'
      }
    });

    // 2 request song song cùng gọi completeHold
    const [res1, res2] = await Promise.all([
      p2pService.completeHold(paymentId),
      p2pService.completeHold(paymentId)
    ]);

    // Ít nhất 1 cái hoàn tất thành công, cái kia nhận ALREADY_COMPLETED hoặc BUSY
    const finalPayment = await pPrisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    assert.equal(finalPayment.workflow, 'IDLE');
    assert.equal(finalPayment.idempotencyStatus, 'COMPLETED');

    // Kiểm tra số dư held chỉ đúng 35.000đ (không bị nhân đôi)
    const sender = await wPrisma.wallet.findFirstOrThrow({ where: { userId: senderId } });
    assert.equal(Number(sender.heldBalance), 35000, 'Ví người gửi chỉ được giữ đúng 35.000đ 1 lần');
  });

  test('A4 Hồi quy: Transaction token tái sử dụng (jti duplicate) -> 409 TXN_TOKEN_REUSED', async () => {
    const { userId: senderId } = await createWallet(100000);
    const dest = await createWallet(0);

    const checkout = await p2pService.checkout({
      userId: senderId,
      destinationUserId: dest.userId,
      amount: '20000',
      type: 'WALLET_TRANSFER',
      idempotencyKey: `a4-${randomUUID()}`,
    });

    const jti = randomUUID();
    const token = {
      iss: 'auth-service',
      aud: 'payment-service',
      sub: senderId,
      paymentId: checkout.payment.id,
      amount: '20000',
      jti,
      exp: Math.floor(Date.now() / 1000) + 60,
      iat: Math.floor(Date.now() / 1000)
    };

    // Lần 1 confirm thành công
    const confirm1 = await p2pService.confirm(checkout.payment.id, senderId, token);
    assert.equal(confirm1.status, 'SUCCESS');

    // Lần 2 confirm cùng token (cùng jti) -> 409 TXN_TOKEN_REUSED
    let errorCaught: any = null;
    try {
      await p2pService.confirm(checkout.payment.id, senderId, token);
    } catch (err) {
      errorCaught = err;
    }

    assert.ok(errorCaught !== null);
    assert.equal(errorCaught.status, 409);
    assert.equal(errorCaught.code, 'TXN_TOKEN_REUSED');
  });

  test('S15 Hồi quy: Idempotency-Key trùng -> cùng paymentId, đúng một hold', async () => {
    const { userId: senderId } = await createWallet(100000);
    const dest = await createWallet(0);
    const idempotencyKey = `s15-${randomUUID()}`;

    const r1 = await p2pService.checkout({
      userId: senderId,
      destinationUserId: dest.userId,
      amount: '15000',
      type: 'WALLET_TRANSFER',
      idempotencyKey
    });

    const r2 = await p2pService.checkout({
      userId: senderId,
      destinationUserId: dest.userId,
      amount: '15000',
      type: 'WALLET_TRANSFER',
      idempotencyKey
    });

    assert.equal(r1.payment.id, r2.payment.id);
    assert.equal(r2.replayed, true);

    const holds = await wPrisma.walletHold.findMany({
      where: { referenceId: r1.payment.holdId! }
    });
    assert.equal(holds.length, 1, 'Đúng duy nhất một hold được tạo ở ví');
  });

});
