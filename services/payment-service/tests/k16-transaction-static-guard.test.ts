import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import path from 'path';

const { analyzeFile } = require(path.resolve(__dirname, '../../../scripts/guard-p2p-transactions.cjs'));

const p2pFile = path.resolve(__dirname, '../src/services/p2p.service.ts');

describe('K16-6: Automated AST Guard & Regression Blocker Suite', () => {

  test('Quét mã nguồn thực tế: p2p.service.ts có 9 khối transaction và 0 vi phạm', () => {
    const report = analyzeFile(p2pFile);

    assert.strictEqual(report.transactionBlockCount, 9, 'P2pService phải có đúng 9 khối transaction ngắn');
    assert.strictEqual(report.violations.length, 0, `Không được có vi phạm nào (thực tế phát hiện: ${report.violations.length})`);
  });

  test('Bẫy vi phạm 1: Phát hiện và chặn nếu ai đó gọi this.wallet.createHold trong transaction', () => {
    const maliciousCode = `
      export class MaliciousService {
        async badMethod() {
          await prisma.$transaction(async (tx) => {
            const p = await tx.payment.findUnique({ where: { id: '1' } });
            await this.wallet.createHold('u1', '1000', 'ref-1', new Date().toISOString());
            await tx.payment.update({ where: { id: '1' }, data: { status: 'SUCCESS' } });
          });
        }
      }
    `;

    const report = analyzeFile('dummy.ts', maliciousCode);
    assert.strictEqual(report.transactionBlockCount, 1);
    assert.strictEqual(report.violations.length, 1);
    assert.strictEqual(report.violations[0].type, 'WALLET_CALL_INSIDE_TRANSACTION');
    assert.match(report.violations[0].message, /Gọi ví trong active transaction bị cấm/);
  });

  test('Bẫy vi phạm 2: Phát hiện và chặn nếu ai đó gọi fetch() mạng trong transaction', () => {
    const maliciousCode = `
      export class MaliciousService {
        async badMethod() {
          await prisma.$transaction(async (tx) => {
            const res = await fetch('http://wallet-service:3004/api/hold');
            return res.json();
          });
        }
      }
    `;

    const report = analyzeFile('dummy.ts', maliciousCode);
    assert.strictEqual(report.transactionBlockCount, 1);
    assert.strictEqual(report.violations.length, 1);
    assert.strictEqual(report.violations[0].type, 'NETWORK_IO_INSIDE_TRANSACTION');
  });

  test('Bẫy vi phạm 3: Phát hiện và chặn nếu ai đó dùng setTimeout / sleep giữ lock DB trong transaction', () => {
    const maliciousCode = `
      export class MaliciousService {
        async badMethod() {
          await prisma.$transaction(async (tx) => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            await tx.payment.update({ where: { id: '1' }, data: { status: 'SUCCESS' } });
          });
        }
      }
    `;

    const report = analyzeFile('dummy.ts', maliciousCode);
    assert.strictEqual(report.transactionBlockCount, 1);
    assert.strictEqual(report.violations.length, 1);
    assert.strictEqual(report.violations[0].type, 'SLEEP_TIMER_INSIDE_TRANSACTION');
  });

});
