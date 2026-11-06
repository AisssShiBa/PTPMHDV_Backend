const paymentDbUrl = process.env.PAYMENT_DATABASE_URL || 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/payment_service?schema=public';
const walletDbUrl = process.env.WALLET_DATABASE_URL || 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/wallet_service?schema=public';

process.env.PAYMENT_DATABASE_URL = paymentDbUrl;
process.env.DATABASE_URL = walletDbUrl;
process.env.RABBITMQ_URL = '';

import assert from 'node:assert/strict';
import { test, before, after, describe } from 'node:test';
import http from 'node:http';
import { randomUUID } from 'crypto';
import { PrismaClient as PaymentPrisma, PaymentStatus } from '@prisma/client';
import { PrismaClient as WalletPrisma, OwnerType } from '../../wallet-service/node_modules/@prisma/client';
import walletApp from '../../wallet-service/src/app';
import { LedgerService } from '../../wallet-service/src/services/ledger.service';
import { seedLimitPolicies } from '../../wallet-service/prisma/seed';
import { P2pService } from '../src/services/p2p.service';
import { WalletClient } from '../src/clients/wallet.client';
import { prisma as paymentPrismaClient } from '../src/utils/prisma';
import { Prisma } from '@prisma/client';
import path from 'path';

const { getFinancialSnapshot, verifyDeltaConservation } = require(path.resolve(__dirname, '../../../scripts/check-k16-invariants.cjs'));

const pPrisma = new PaymentPrisma({ datasources: { db: { url: paymentDbUrl } } });
const wPrisma = new WalletPrisma({ datasources: { db: { url: walletDbUrl } } });
const ledgerService = new LedgerService();

let walletServer: http.Server;
let walletClient: WalletClient;
let p2pService: P2pService;

import { GuardedWalletClient } from './helpers/transaction-guard.helper';

let guardedWalletClient: GuardedWalletClient;
let guardedP2pService: P2pService;

before(async () => {
  await seedLimitPolicies();
  walletServer = http.createServer(walletApp);
  await new Promise<void>((resolve) => walletServer.listen(0, resolve));
  const port = (walletServer.address() as any).port;
  process.env.WALLET_SERVICE_URL = `http://127.0.0.1:${port}`;
  process.env.INTERNAL_KEY = 'f6f2f278e1bddbc7d16c19851cc828ce455015504709b35d232383543d6c1e68';

  walletClient = new WalletClient();
  p2pService = new P2pService(walletClient);

  guardedWalletClient = new GuardedWalletClient();
  guardedP2pService = new P2pService(guardedWalletClient);
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

describe('K16-1: Transaction Guard & Acceptance Baseline Suite', () => {

  test('Guard Verification: Bắt lỗi nếu gọi walletClient trong active transaction', async () => {
    let errorCaught: Error | null = null;
    try {
      await paymentPrismaClient.$transaction(async () => {
        // Cố tình gọi walletClient khi đang trong transaction
        await guardedWalletClient.createHold('fake-user', '1000', 'ref-1', new Date().toISOString());
      });
    } catch (err: any) {
      errorCaught = err;
    }

    assert.ok(errorCaught !== null, 'Phải bắt được lỗi khi gọi walletClient trong transaction');
    assert.match(errorCaught.message, /VIOLATION: walletClient\.createHold was called inside an active prisma\.\$transaction!/);
  });

  test('completeHold không gọi walletClient trong transaction', async () => {
    const { userId } = await createWallet(100000);
    const dest = await createWallet(0);

    const checkoutResult = await guardedP2pService.checkout({
      userId,
      destinationUserId: dest.userId,
      amount: '50000',
      type: 'WALLET_TRANSFER',
      idempotencyKey: `idemp-guard-ch-${randomUUID()}`,
    });

    assert.equal(checkoutResult.payment.workflow, 'IDLE');
    assert.equal(checkoutResult.payment.idempotencyStatus, 'COMPLETED');
  });

  test('resume không gọi walletClient trong transaction', {
    skip: 'K16-1: Bật ở Commit 4 khi resume đã tách 3 pha'
  }, async () => {
    const { userId } = await createWallet(100000);
    const dest = await createWallet(0);

    const checkoutResult = await guardedP2pService.checkout({
      userId,
      destinationUserId: dest.userId,
      amount: '50000',
      type: 'WALLET_TRANSFER',
      idempotencyKey: `idemp-guard-res-${randomUUID()}`,
    });

    const token = {
      sub: userId,
      paymentId: checkoutResult.payment.id,
      amount: new Prisma.Decimal('50000'),
      jti: randomUUID(),
      exp: Math.floor(Date.now() / 1000) + 60,
      iat: Math.floor(Date.now() / 1000),
    };

    const confirmResult = await guardedP2pService.confirm(checkoutResult.payment.id, userId, token);
    assert.equal(confirmResult.status, 'SUCCESS');
  });

  test('Mốc A1: Chuyển tiền song song 20 request x 60k trên ví 100k -> 1 thành công, 19 từ chối, số dư 40.000đ', async () => {
    const { userId: senderId, wallet: senderWallet } = await createWallet(100000);
    const { userId: receiverId } = await createWallet(0);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        ledgerService.transfer({
          fromUserId: senderId,
          toUserId: receiverId,
          amount: '60000',
          referenceId: `k16-a1-tx-${i}-${randomUUID()}`,
          transferType: 'P2P_TRANSFER' as any,
          note: `A1 parallel transfer ${i}`
        })
      )
    );

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Đúng 1 request phải thành công');
    assert.equal(rejected.length, 19, '19 request phải bị từ chối');

    const updatedSender = await wPrisma.wallet.findUniqueOrThrow({ where: { id: senderWallet.id } });
    assert.equal(Number(updatedSender.balance), 40000, 'Số dư người gửi phải còn đúng 40.000đ');
  });

  test('Mốc A2: Bấm 2 lần cùng Idempotency-Key -> 1 payment, lần 2 trả replayed: true', async () => {
    const { userId: senderId } = await createWallet(200000);
    const dest = await createWallet(0);
    const idempotencyKey = `k16-a2-key-${randomUUID()}`;

    const res1 = await p2pService.checkout({
      userId: senderId,
      destinationUserId: dest.userId,
      amount: '50000',
      type: 'WALLET_TRANSFER',
      idempotencyKey,
    });

    assert.equal(res1.replayed, false, 'Lần 1 phải replayed: false');
    assert.ok(res1.payment.id);

    const res2 = await p2pService.checkout({
      userId: senderId,
      destinationUserId: dest.userId,
      amount: '50000',
      type: 'WALLET_TRANSFER',
      idempotencyKey,
    });

    assert.equal(res2.replayed, true, 'Lần 2 phải replayed: true');
    assert.equal(res2.payment.id, res1.payment.id, 'Phải trả về cùng 1 paymentId');

    const paymentCount = await pPrisma.payment.count({
      where: { userId: senderId, idempotencyKey }
    });
    assert.equal(paymentCount, 1, 'Chỉ có đúng 1 payment được tạo trong cơ sở dữ liệu');
  });

  test('Mốc A1-P2P (Bổ sung): 20 checkout song song x 60k trên ví 100k qua P2pService -> tối đa 1 thành công, số dư bảo toàn', async () => {
    const { userId: senderId, wallet: senderWallet } = await createWallet(100000);
    const destUsers = await Promise.all(Array.from({ length: 20 }, () => createWallet(0)));

    const beforeSnap = await getFinancialSnapshot(wPrisma);

    // Bắn 20 checkout song song
    const checkoutResults = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        p2pService.checkout({
          userId: senderId,
          destinationUserId: destUsers[i].userId,
          amount: '60000',
          type: 'WALLET_TRANSFER',
          idempotencyKey: `a1-p2p-check-${i}-${randomUUID()}`,
        })
      )
    );

    const successfulCheckouts = checkoutResults.filter(
      r => r.status === 'fulfilled' && (r.value as any).payment?.workflow === 'IDLE'
    );
    const failedCheckouts = checkoutResults.filter(r => r.status === 'rejected');

    assert.equal(successfulCheckouts.length, 1, 'Tối đa đúng 1 checkout thành công giữ tiền');
    assert.equal(failedCheckouts.length, 19, '19 checkout phải bị từ chối');

    // Tiến hành confirm lệnh thành công duy nhất
    const successfulPayment = (successfulCheckouts[0] as PromiseFulfilledResult<any>).value.payment;
    const token = {
      sub: senderId,
      paymentId: successfulPayment.id,
      amount: new Prisma.Decimal('60000'),
      jti: randomUUID(),
      exp: Math.floor(Date.now() / 1000) + 60,
      iat: Math.floor(Date.now() / 1000),
    };

    const confirmRes = await p2pService.confirm(successfulPayment.id, senderId, token);
    assert.equal(confirmRes.status, 'SUCCESS', 'Payment phải chuyển SUCCESS');

    // Kiểm tra số dư người gửi
    const finalSender = await wPrisma.wallet.findUniqueOrThrow({ where: { id: senderWallet.id } });
    assert.equal(Number(finalSender.balance), 40000, 'Số dư người gửi phải còn 40.000đ');
    assert.equal(Number(finalSender.heldBalance), 0, 'Held balance người gửi phải = 0');

    // Kiểm tra không ví nào bị âm
    const negativeWallets = await wPrisma.wallet.findMany({
      where: {
        userId: { in: [senderId, ...destUsers.map(u => u.userId)] },
        balance: { lt: 0 }
      }
    });
    assert.equal(negativeWallets.length, 0, 'Không có ví nào bị âm');

    // Kiểm tra bất biến số dư
    const afterSnap = await getFinancialSnapshot(wPrisma);
    const deltaVerification = verifyDeltaConservation(beforeSnap, afterSnap);
    assert.ok(deltaVerification.isBalanceConserved, 'Tổng số dư toàn hệ thống phải được bảo toàn');
  });

});
