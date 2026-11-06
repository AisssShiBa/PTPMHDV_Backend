const paymentDbUrl = process.env.PAYMENT_DATABASE_URL || 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/payment_service?schema=public';
const walletDbUrl = process.env.WALLET_DATABASE_URL || 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/wallet_service?schema=public';

process.env.PAYMENT_DATABASE_URL = paymentDbUrl;
process.env.DATABASE_URL = walletDbUrl;
process.env.RABBITMQ_URL = '';

import assert from 'node:assert/strict';
import { test, before, after, describe } from 'node:test';
import http from 'node:http';
import { randomUUID } from 'crypto';
import { PrismaClient as PaymentPrisma, PaymentType, PaymentStatus, IdempotencyStatus, Prisma } from '@prisma/client';
import { PrismaClient as WalletPrisma, OwnerType, HoldStatus } from '../../wallet-service/node_modules/@prisma/client';
import walletApp from '../../wallet-service/src/app';
import { seedLimitPolicies } from '../../wallet-service/prisma/seed';
import { P2pService } from '../src/services/p2p.service';
import { WalletClient } from '../src/clients/wallet.client';
import { DomainException } from '../src/utils/domain.exception';
import { GuardedWalletClient } from './helpers/transaction-guard.helper';

const pPrisma = new PaymentPrisma({ datasources: { db: { url: paymentDbUrl } } });
const wPrisma = new WalletPrisma({ datasources: { db: { url: walletDbUrl } } });

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
  process.env.INTERNAL_KEY = 'f6f2f278e1bddbc7d16c19851cc828ce455015504709b35d232383543d6c1e68';

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

describe('K16-4: resume & cancel Decoupled 3-Phase Execution Suite', () => {

  test('Guarded Check: resume và cancel không gọi walletClient trong active transaction', async () => {
    const { userId: senderId } = await createWallet(100000);
    const dest = await createWallet(0);

    // 1. Kiểm tra resume qua guardedP2p
    const ch = await guardedP2p.checkout({
      userId: senderId,
      destinationUserId: dest.userId,
      amount: '30000',
      type: 'WALLET_TRANSFER',
      idempotencyKey: `guard-res-1-${randomUUID()}`,
    });

    const token = {
      sub: senderId,
      paymentId: ch.payment.id,
      amount: new Prisma.Decimal('30000'),
      jti: randomUUID(),
      exp: Math.floor(Date.now() / 1000) + 60,
      iat: Math.floor(Date.now() / 1000),
    };

    const confirmRes = await guardedP2p.confirm(ch.payment.id, senderId, token);
    assert.equal(confirmRes.status, 'SUCCESS');

    // 2. Kiểm tra cancel qua guardedP2p
    const chCancel = await guardedP2p.checkout({
      userId: senderId,
      destinationUserId: dest.userId,
      amount: '20000',
      type: 'WALLET_TRANSFER',
      idempotencyKey: `guard-can-1-${randomUUID()}`,
    });

    const cancelRes = await guardedP2p.cancel(chCancel.payment.id, senderId);
    assert.equal(cancelRes.status, 'CANCELLED');
  });

  test('Ví đã ghi nhưng payment chưa chốt: lookup trả COMPLETED -> chốt SUCCESS không gọi capture lần 2', async () => {
    const { userId: senderId } = await createWallet(100000);
    const dest = await createWallet(0);

    const ch = await p2pService.checkout({
      userId: senderId,
      destinationUserId: dest.userId,
      amount: '25000',
      type: 'WALLET_TRANSFER',
      idempotencyKey: `lookup-comp-${randomUUID()}`,
    });

    // Cố tình gọi capture trước ở ví (giả lập lần gọi trước đã tới ví thành công)
    await walletClient.captureHold(senderId, ch.payment.holdId!);

    // Cập nhật payment ở trạng thái dở dang CAPTURE_CALLING với attempt=2
    await pPrisma.payment.update({
      where: { id: ch.payment.id },
      data: {
        workflow: 'CAPTURE_CALLING',
        attempt: 2,
        workerLeaseUntil: null,
      }
    });

    // Gọi resume: phải tra cứu lookup, thấy đã COMPLETED và chốt SUCCESS
    let captureCallCount = 0;
    class SpyingWalletClient extends WalletClient {
      override async captureHold(userId: string, ref: string) {
        captureCallCount++;
        return super.captureHold(userId, ref);
      }
    }

    const spyingP2p = new P2pService(new SpyingWalletClient());
    const res = await spyingP2p.resume(ch.payment.id);

    assert.equal(res.status, 'SUCCESS');
    assert.equal(captureCallCount, 0, 'Tuyệt đối KHÔNG được gọi captureHold lần 2 khi lookup đã ghi nhận COMPLETED');

    const paymentInDb = await pPrisma.payment.findUniqueOrThrow({ where: { id: ch.payment.id } });
    assert.equal(paymentInDb.status, 'SUCCESS');
    assert.equal(paymentInDb.workflow, 'IDLE');
  });

  test('Recover từ từng bước workflow: HOLD_CALLING, CAPTURE_CALLING, RELEASE_CALLING', async () => {
    const { userId: senderId } = await createWallet(150000);
    const dest = await createWallet(0);

    // 1. Recover từ HOLD_CALLING (lease hết hạn)
    const holdPayId = randomUUID();
    const holdId = randomUUID();
    await pPrisma.payment.create({
      data: {
        id: holdPayId,
        userId: senderId,
        destinationUserId: dest.userId,
        amount: '20000',
        type: 'WALLET_TRANSFER',
        referenceId: `ref-${holdPayId}`,
        callbackTopic: 'finvault.events',
        idempotencyKey: `rec-hold-${holdPayId}`,
        requestHash: 'hash',
        idempotencyStatus: 'PROCESSING',
        idempotencyExpiresAt: new Date(Date.now() + 86400000),
        holdId,
        holdExpiresAt: new Date(Date.now() + 300000),
        workflow: 'HOLD_CALLING',
        workerLeaseUntil: new Date(Date.now() - 5000), // Lease đã hết hạn
        status: 'PENDING',
      }
    });

    await p2pService.recover();
    const recHold = await pPrisma.payment.findUniqueOrThrow({ where: { id: holdPayId } });
    assert.equal(recHold.workflow, 'IDLE', 'HOLD_CALLING phải được hoàn tất sang IDLE');
    assert.equal(recHold.idempotencyStatus, 'COMPLETED');

    // 2. Recover từ CAPTURE_CALLING (lease hết hạn)
    const capPayId = randomUUID();
    const capHoldId = randomUUID();
    // Tạo hold ở ví trước
    await walletClient.createHold(senderId, '30000', capHoldId, new Date(Date.now() + 300000).toISOString(), dest.userId, 'USER');

    await pPrisma.payment.create({
      data: {
        id: capPayId,
        userId: senderId,
        destinationUserId: dest.userId,
        amount: '30000',
        type: 'WALLET_TRANSFER',
        referenceId: `ref-${capPayId}`,
        callbackTopic: 'finvault.events',
        idempotencyKey: `rec-cap-${capPayId}`,
        requestHash: 'hash',
        idempotencyStatus: 'COMPLETED',
        idempotencyExpiresAt: new Date(Date.now() + 86400000),
        holdId: capHoldId,
        holdExpiresAt: new Date(Date.now() + 300000),
        workflow: 'CAPTURE_CALLING',
        workerLeaseUntil: new Date(Date.now() - 5000), // Lease đã hết hạn
        status: 'PENDING',
      }
    });

    await p2pService.recover();
    const recCap = await pPrisma.payment.findUniqueOrThrow({ where: { id: capPayId } });
    assert.equal(recCap.status, 'SUCCESS', 'CAPTURE_CALLING phải được chuyển SUCCESS');
    assert.equal(recCap.workflow, 'IDLE');

    // 3. Recover từ RELEASE_CALLING (lease hết hạn)
    const relPayId = randomUUID();
    const relHoldId = randomUUID();
    await walletClient.createHold(senderId, '20000', relHoldId, new Date(Date.now() + 300000).toISOString(), dest.userId, 'USER');

    await pPrisma.payment.create({
      data: {
        id: relPayId,
        userId: senderId,
        destinationUserId: dest.userId,
        amount: '20000',
        type: 'WALLET_TRANSFER',
        referenceId: `ref-${relPayId}`,
        callbackTopic: 'finvault.events',
        idempotencyKey: `rec-rel-${relPayId}`,
        requestHash: 'hash',
        idempotencyStatus: 'COMPLETED',
        idempotencyExpiresAt: new Date(Date.now() + 86400000),
        holdId: relHoldId,
        holdExpiresAt: new Date(Date.now() + 300000),
        workflow: 'RELEASE_CALLING',
        failureReason: 'CAPTURE_FAILED',
        workerLeaseUntil: new Date(Date.now() - 5000), // Lease đã hết hạn
        status: 'PENDING',
      }
    });

    await p2pService.recover();
    const recRel = await pPrisma.payment.findUniqueOrThrow({ where: { id: relPayId } });
    assert.equal(recRel.status, 'FAILED', 'RELEASE_CALLING phải được chuyển FAILED');
    assert.equal(recRel.workflow, 'IDLE');
  });

  test('Hai worker song song resume cùng 1 payment -> đúng 1 tác động ở ví', async () => {
    const { userId: senderId } = await createWallet(100000);
    const dest = await createWallet(0);

    const ch = await p2pService.checkout({
      userId: senderId,
      destinationUserId: dest.userId,
      amount: '40000',
      type: 'WALLET_TRANSFER',
      idempotencyKey: `two-worker-${randomUUID()}`,
    });

    // Chuyển sang CONFIRMING
    await pPrisma.payment.update({
      where: { id: ch.payment.id },
      data: { workflow: 'CONFIRMING' }
    });

    // 2 worker cùng lúc gọi resume
    const [res1, res2] = await Promise.all([
      p2pService.resume(ch.payment.id),
      p2pService.resume(ch.payment.id)
    ]);

    assert.equal(res1.status, 'SUCCESS');
    assert.equal(res2.status, 'SUCCESS');

    // Kiểm tra ví người nhận chỉ nhận đúng 40.000đ 1 lần duy nhất
    const destWallet = await wPrisma.wallet.findFirstOrThrow({ where: { userId: dest.userId } });
    assert.equal(Number(destWallet.balance), 40000);
  });

  test('4xx xác định khi capture: HOLD_EXPIRED -> chuyển EXPIRED và giải phóng hold', async () => {
    const { userId: senderId } = await createWallet(100000);
    const dest = await createWallet(0);

    const ch = await p2pService.checkout({
      userId: senderId,
      destinationUserId: dest.userId,
      amount: '35000',
      type: 'WALLET_TRANSFER',
      idempotencyKey: `exp-capture-${randomUUID()}`,
    });

    // Giả lập ví báo lỗi 409 HOLD_EXPIRED khi capture
    class ExpiredHoldWalletClient extends WalletClient {
      override async captureHold() {
        throw new DomainException(409, 'HOLD_EXPIRED', 'Hold has expired');
      }
    }

    const expP2p = new P2pService(new ExpiredHoldWalletClient());
    await pPrisma.payment.update({
      where: { id: ch.payment.id },
      data: { workflow: 'CONFIRMING' }
    });

    const result = await expP2p.resume(ch.payment.id);
    assert.equal(result.status, 'EXPIRED', 'Phải chuyển trạng thái sang EXPIRED');
    assert.equal(result.workflow, 'IDLE');

    const paymentInDb = await pPrisma.payment.findUniqueOrThrow({ where: { id: ch.payment.id } });
    assert.equal(paymentInDb.status, 'EXPIRED');
    assert.equal(paymentInDb.failureReason, 'HOLD_EXPIRED');
  });

  test('Lỗi không xác định khi capture: 503 / Timeout -> Giữ nguyên CAPTURE_CALLING và status PENDING', async () => {
    const { userId: senderId } = await createWallet(100000);
    const dest = await createWallet(0);

    const ch = await p2pService.checkout({
      userId: senderId,
      destinationUserId: dest.userId,
      amount: '35000',
      type: 'WALLET_TRANSFER',
      idempotencyKey: `timeout-cap-${randomUUID()}`,
    });

    class TimeoutWalletClient extends WalletClient {
      override async captureHold() {
        throw new DomainException(503, 'WALLET_UNAVAILABLE', 'Network timeout');
      }
    }

    const timeoutP2p = new P2pService(new TimeoutWalletClient());
    await pPrisma.payment.update({
      where: { id: ch.payment.id },
      data: { workflow: 'CONFIRMING' }
    });

    const res = await timeoutP2p.resume(ch.payment.id);
    assert.equal(res.status, 'PENDING', 'Payment phải giữ nguyên PENDING');

    const paymentInDb = await pPrisma.payment.findUniqueOrThrow({ where: { id: ch.payment.id } });
    assert.equal(paymentInDb.status, 'PENDING');
    assert.equal(paymentInDb.workflow, 'CAPTURE_CALLING');
    assert.equal(paymentInDb.workerLeaseUntil, null, 'Lease phải được nhả để worker sau thử lại');
  });

});
