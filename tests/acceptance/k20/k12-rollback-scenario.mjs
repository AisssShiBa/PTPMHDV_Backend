/**
 * Scenario ROLLBACK_K12: Thử nghiệm Rollback Migration SystemWalletCode trên bản sao DB
 * K20 / K21 Acceptance Verification (Mục G8)
 *
 * Specification:
 * 1. Khởi tạo bản sao DB: wallet_service_k12_clone qua pg_dump trực tiếp trong container postgres.
 *    Bảo đảm 100% không ảnh hưởng hoặc ngắt kết nối DB chính wallet_service.
 * 2. Lưu snapshot TRƯỚC rollback:
 *    - SystemWalletCode enum: CLEARING_TOPUP, SETTLEMENT, FEE.
 *    - System wallets: IDs, balances, heldBalances.
 *    - LedgerEntry count và checksum.
 *    - Tổng số dư sum(balance) = 0.
 * 3. Thực thi Down migration trên bản sao:
 *    - Chạy scripts/rollback/down_k12_system_wallet_codes.sql
 *    - CLEARING_TOPUP -> TOPUP_POOL, SETTLEMENT -> MAIN.
 * 4. Kiểm tra trạng thái SAU Down migration:
 *    - Enum chứa TOPUP_POOL và MAIN.
 *    - System wallets chuyển systemCode sang TOPUP_POOL và MAIN, giữ nguyên ID và balance.
 *    - LedgerEntry count và checksum không đổi.
 *    - Tổng số dư sum(balance) = 0.
 * 5. Áp lại Up migration trên bản sao:
 *    - Chạy migration 20261104103000_rename_system_wallet_codes/migration.sql
 *    - Trở lại CLEARING_TOPUP và SETTLEMENT.
 *    - Kiểm tra bảo toàn toàn diện.
 * 6. Dọn dẹp bản sao DB: DROP DATABASE IF EXISTS wallet_service_k12_clone.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createK20Logger,
  executeSql,
  getFinancialSnapshot,
  getWalletPrisma
} from './k20-shared.mjs';

const root = resolve(import.meta.dirname, '../../..');
const CLONE_DB_NAME = 'wallet_service_k12_clone';

export async function runRollbackK12() {
  const logger = createK20Logger('ROLLBACK_K12');
  logger.section('BẮT ĐẦU KỊCH BẢN NGHIỆM THU ROLLBACK_K12: ROLLBACK ENUM TRÊN BẢN SAO DB');

  const checks = [];
  const recordCheck = (name, pass, details = '') => {
    checks.push({ name, pass, details });
    if (pass) {
      logger.info(`  [PASS] ${name}${details ? ` (${details})` : ''}`);
    } else {
      logger.error(`  [FAIL] ${name}${details ? ` (${details})` : ''}`);
    }
  };

  const execCloneSql = (query) => {
    return execFileSync('docker', [
      'exec', '-i', 'ptpmhdv_backend-postgres-1',
      'psql', '-U', 'postgres', '-d', CLONE_DB_NAME,
      '-At', '-v', 'ON_ERROR_STOP=1', '-c', query
    ], { encoding: 'utf8', windowsHide: true }).trim();
  };

  try {
    // --------------------------------------------------------------------------
    // BƯỚC 1: Tạo bản sao DB biệt lập
    // --------------------------------------------------------------------------
    logger.section(`BƯỚC 1: Tạo bản sao DB ${CLONE_DB_NAME} từ wallet_service qua pg_dump`);
    logger.info('Thực thi tạo bản sao biệt lập...');

    execFileSync('docker', [
      'exec', 'ptpmhdv_backend-postgres-1',
      'sh', '-c',
      `dropdb -U postgres --if-exists ${CLONE_DB_NAME} && createdb -U postgres ${CLONE_DB_NAME} && pg_dump -U postgres wallet_service | psql -U postgres -d ${CLONE_DB_NAME} -q`
    ], { encoding: 'utf8', windowsHide: true });

    logger.info(`Tạo bản sao DB ${CLONE_DB_NAME} thành công.`);
    recordCheck('Tạo bản sao DB wallet_service_k12_clone thành công', true);

    // --------------------------------------------------------------------------
    // BƯỚC 2: Lưu Snapshot TRƯỚC Rollback trên bản sao
    // --------------------------------------------------------------------------
    logger.section('BƯỚC 2: Thu thập snapshot dữ liệu trước khi rollback trên bản sao');

    // 2.1. Đọc enum values hiện tại
    const preEnumStr = execCloneSql(`
      SELECT enumlabel FROM pg_enum
      JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
      WHERE pg_type.typname = 'SystemWalletCode'
      ORDER BY enumsortorder;
    `);
    const preEnums = preEnumStr.split('\n').map(s => s.trim()).filter(Boolean);
    logger.info(`Enum SystemWalletCode ban đầu: ${preEnums.join(', ')}`);
    recordCheck('Enum ban đầu chứa CLEARING_TOPUP', preEnums.includes('CLEARING_TOPUP'));
    recordCheck('Enum ban đầu chứa SETTLEMENT', preEnums.includes('SETTLEMENT'));

    // 2.2. Đọc System Wallets
    const preWalletsRaw = execCloneSql(`
      SELECT id || '|' || "systemCode" || '|' || balance || '|' || "heldBalance"
      FROM "Wallet"
      WHERE "ownerType" = 'SYSTEM'
      ORDER BY id ASC;
    `);
    const preWallets = preWalletsRaw.split('\n').filter(Boolean).map(line => {
      const [id, systemCode, balance, heldBalance] = line.split('|');
      return { id: Number(id), systemCode, balance: Number(balance), heldBalance: Number(heldBalance) };
    });
    logger.info(`System Wallets ban đầu (${preWallets.length} ví):`);
    for (const w of preWallets) {
      logger.info(`  [ID ${w.id}] Code: ${w.systemCode}, Balance: ${w.balance}, Held: ${w.heldBalance}`);
    }
    recordCheck('Tồn tại ví hệ thống ban đầu', preWallets.length >= 3, `Số lượng: ${preWallets.length}`);

    // 2.3. Đọc LedgerEntry count và checksum
    const preLedgerCount = execCloneSql(`SELECT count(*) FROM "LedgerEntry";`);
    const preLedgerChecksum = execCloneSql(`
      SELECT COALESCE(MD5(STRING_AGG(id::text || ':' || "transactionId" || ':' || "walletId"::text || ':' || direction || ':' || amount::text || ':' || "balanceAfter"::text, ',' ORDER BY id ASC)), 'empty')
      FROM "LedgerEntry";
    `);
    logger.info(`LedgerEntry trước rollback: Count=${preLedgerCount}, Checksum=${preLedgerChecksum}`);

    // 2.4. Đọc tổng số dư hệ thống
    const preTotalBalance = Number(execCloneSql(`SELECT COALESCE(SUM(balance), 0) FROM "Wallet";`));
    logger.info(`Tổng số dư sum(balance) trước rollback: ${preTotalBalance}`);
    recordCheck('Tổng số dư trước rollback = 0', Math.abs(preTotalBalance) < 0.01, `Total: ${preTotalBalance}`);

    // --------------------------------------------------------------------------
    // BƯỚC 3: Thực thi Down migration trên bản sao
    // --------------------------------------------------------------------------
    logger.section('BƯỚC 3: Thực thi Down migration (K12 Rollback script) trên bản sao');
    const downSqlPath = resolve(root, 'scripts/rollback/down_k12_system_wallet_codes.sql');
    const downSql = readFileSync(downSqlPath, 'utf8');
    logger.info(`Nội dung down script (${downSqlPath}):\n${downSql}`);

    execFileSync('docker', [
      'exec', '-i', 'ptpmhdv_backend-postgres-1',
      'psql', '-U', 'postgres', '-d', CLONE_DB_NAME,
      '-v', 'ON_ERROR_STOP=1'
    ], { input: downSql, encoding: 'utf8', windowsHide: true });

    logger.info('Thực thi Down migration trên bản sao hoàn tất.');
    recordCheck('Thực thi scripts/rollback/down_k12_system_wallet_codes.sql thành công', true);

    // --------------------------------------------------------------------------
    // BƯỚC 4: Kiểm tra trạng thái SAU Down migration
    // --------------------------------------------------------------------------
    logger.section('BƯỚC 4: Kiểm tra trạng thái sau Down migration trên bản sao');

    // 4.1. Enum values sau rollback
    const postDownEnumStr = execCloneSql(`
      SELECT enumlabel FROM pg_enum
      JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
      WHERE pg_type.typname = 'SystemWalletCode'
      ORDER BY enumsortorder;
    `);
    const postDownEnums = postDownEnumStr.split('\n').map(s => s.trim()).filter(Boolean);
    logger.info(`Enum SystemWalletCode sau rollback: ${postDownEnums.join(', ')}`);
    recordCheck('Enum sau rollback đã đổi CLEARING_TOPUP thành TOPUP_POOL', postDownEnums.includes('TOPUP_POOL') && !postDownEnums.includes('CLEARING_TOPUP'));
    recordCheck('Enum sau rollback đã đổi SETTLEMENT thành MAIN', postDownEnums.includes('MAIN') && !postDownEnums.includes('SETTLEMENT'));

    // 4.2. Kiểm tra System Wallets sau rollback
    const postDownWalletsRaw = execCloneSql(`
      SELECT id || '|' || "systemCode" || '|' || balance || '|' || "heldBalance"
      FROM "Wallet"
      WHERE "ownerType" = 'SYSTEM'
      ORDER BY id ASC;
    `);
    const postDownWallets = postDownWalletsRaw.split('\n').filter(Boolean).map(line => {
      const [id, systemCode, balance, heldBalance] = line.split('|');
      return { id: Number(id), systemCode, balance: Number(balance), heldBalance: Number(heldBalance) };
    });

    logger.info(`System Wallets sau rollback (${postDownWallets.length} ví):`);
    for (const w of postDownWallets) {
      logger.info(`  [ID ${w.id}] Code: ${w.systemCode}, Balance: ${w.balance}, Held: ${w.heldBalance}`);
    }

    // Xác minh ánh xạ đảo:
    // Ví CLEARING_TOPUP cũ -> TOPUP_POOL
    const clearingOld = preWallets.find(w => w.systemCode === 'CLEARING_TOPUP');
    const topupPoolNew = postDownWallets.find(w => w.id === clearingOld?.id);
    recordCheck('Ví CLEARING_TOPUP chuyển thành TOPUP_POOL và giữ nguyên ID/balance',
      topupPoolNew?.systemCode === 'TOPUP_POOL' && topupPoolNew?.balance === clearingOld?.balance,
      `ID: ${topupPoolNew?.id}, Code: ${topupPoolNew?.systemCode}, Bal: ${topupPoolNew?.balance}`
    );

    // Ví SETTLEMENT cũ -> MAIN
    const settlementOld = preWallets.find(w => w.systemCode === 'SETTLEMENT');
    const mainNew = postDownWallets.find(w => w.id === settlementOld?.id);
    recordCheck('Ví SETTLEMENT chuyển thành MAIN và giữ nguyên ID/balance',
      mainNew?.systemCode === 'MAIN' && mainNew?.balance === settlementOld?.balance,
      `ID: ${mainNew?.id}, Code: ${mainNew?.systemCode}, Bal: ${mainNew?.balance}`
    );

    // 4.3. Kiểm tra LedgerEntry sau rollback
    const postDownLedgerCount = execCloneSql(`SELECT count(*) FROM "LedgerEntry";`);
    const postDownLedgerChecksum = execCloneSql(`
      SELECT COALESCE(MD5(STRING_AGG(id::text || ':' || "transactionId" || ':' || "walletId"::text || ':' || direction || ':' || amount::text || ':' || "balanceAfter"::text, ',' ORDER BY id ASC)), 'empty')
      FROM "LedgerEntry";
    `);
    logger.info(`LedgerEntry sau rollback: Count=${postDownLedgerCount}, Checksum=${postDownLedgerChecksum}`);
    recordCheck('Số lượng LedgerEntry nguyên vẹn sau rollback', postDownLedgerCount === preLedgerCount, `Count: ${postDownLedgerCount}`);
    recordCheck('Checksum LedgerEntry nguyên vẹn 100% sau rollback', postDownLedgerChecksum === preLedgerChecksum, `Match: ${postDownLedgerChecksum === preLedgerChecksum}`);

    // 4.4. Kiểm tra tổng số dư hệ thống sau rollback
    const postDownTotalBalance = Number(execCloneSql(`SELECT COALESCE(SUM(balance), 0) FROM "Wallet";`));
    logger.info(`Tổng số dư sum(balance) sau rollback: ${postDownTotalBalance}`);
    recordCheck('Tổng số dư sau rollback vẫn bảo toàn = 0', Math.abs(postDownTotalBalance) < 0.01, `Total: ${postDownTotalBalance}`);

    // --------------------------------------------------------------------------
    // BƯỚC 5: Áp lại Up migration trên bản sao
    // --------------------------------------------------------------------------
    logger.section('BƯỚC 5: Áp lại Up migration để phục hồi trạng thái CLEARING_TOPUP / SETTLEMENT');
    const upSqlPath = resolve(root, 'services/wallet-service/prisma/migrations/20261104103000_rename_system_wallet_codes/migration.sql');
    const upSql = readFileSync(upSqlPath, 'utf8');
    logger.info(`Nội dung up script (${upSqlPath}):\n${upSql}`);

    execFileSync('docker', [
      'exec', '-i', 'ptpmhdv_backend-postgres-1',
      'psql', '-U', 'postgres', '-d', CLONE_DB_NAME,
      '-v', 'ON_ERROR_STOP=1'
    ], { input: upSql, encoding: 'utf8', windowsHide: true });

    logger.info('Áp lại Up migration thành công.');
    recordCheck('Áp lại Up migration thành công', true);

    // Kiểm tra enum sau khi Up lại
    const reUpEnumStr = execCloneSql(`
      SELECT enumlabel FROM pg_enum
      JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
      WHERE pg_type.typname = 'SystemWalletCode'
      ORDER BY enumsortorder;
    `);
    const reUpEnums = reUpEnumStr.split('\n').map(s => s.trim()).filter(Boolean);
    logger.info(`Enum SystemWalletCode sau khi Up lại: ${reUpEnums.join(', ')}`);
    recordCheck('Enum sau khi Up lại phục hồi CLEARING_TOPUP', reUpEnums.includes('CLEARING_TOPUP') && !reUpEnums.includes('TOPUP_POOL'));
    recordCheck('Enum sau khi Up lại phục hồi SETTLEMENT', reUpEnums.includes('SETTLEMENT') && !reUpEnums.includes('MAIN'));

    // Kiểm tra ví hệ thống sau khi Up lại
    const reUpWalletsRaw = execCloneSql(`
      SELECT id || '|' || "systemCode" || '|' || balance || '|' || "heldBalance"
      FROM "Wallet"
      WHERE "ownerType" = 'SYSTEM'
      ORDER BY id ASC;
    `);
    const reUpWallets = reUpWalletsRaw.split('\n').filter(Boolean).map(line => {
      const [id, systemCode, balance, heldBalance] = line.split('|');
      return { id: Number(id), systemCode, balance: Number(balance), heldBalance: Number(heldBalance) };
    });

    const clearingRestored = reUpWallets.find(w => w.id === clearingOld?.id);
    const settlementRestored = reUpWallets.find(w => w.id === settlementOld?.id);
    recordCheck('Ví CLEARING_TOPUP phục hồi hoàn hảo', clearingRestored?.systemCode === 'CLEARING_TOPUP' && clearingRestored?.balance === clearingOld?.balance);
    recordCheck('Ví SETTLEMENT phục hồi hoàn hảo', settlementRestored?.systemCode === 'SETTLEMENT' && settlementRestored?.balance === settlementOld?.balance);

    const reUpTotalBalance = Number(execCloneSql(`SELECT COALESCE(SUM(balance), 0) FROM "Wallet";`));
    recordCheck('Tổng số dư sau khi phục hồi = 0', Math.abs(reUpTotalBalance) < 0.01, `Total: ${reUpTotalBalance}`);

  } catch (err) {
    logger.error(`ROLLBACK_K12 gặp lỗi ngoại lệ: ${err.message}\n${err.stack}`);
    recordCheck('Thực thi ROLLBACK_K12 không ném lỗi ngoại lệ', false, err.message);
  } finally {
    // --------------------------------------------------------------------------
    // BƯỚC 6: Dọn dẹp bản sao DB
    // --------------------------------------------------------------------------
    logger.section('BƯỚC 6: Dọn dẹp bản sao DB sau thử nghiệm');
    try {
      execFileSync('docker', [
        'exec', '-i', 'ptpmhdv_backend-postgres-1',
        'psql', '-U', 'postgres',
        '-c', `DROP DATABASE IF EXISTS ${CLONE_DB_NAME};`
      ], { encoding: 'utf8', windowsHide: true });
      logger.info(`Đã xóa database bản sao ${CLONE_DB_NAME}. Môi trường sạch sẽ.`);
      recordCheck('Xóa database bản sao DB wallet_service_k12_clone thành công', true);
    } catch (cleanupErr) {
      logger.warn(`Lỗi dọn dẹp bản sao DB: ${cleanupErr.message}`);
    }
  }

  const allPassed = checks.every(c => c.pass);
  logger.section('TỔNG KẾT KỊCH BẢN ROLLBACK_K12');
  logger.result(
    allPassed,
    allPassed
      ? 'KỊCH BẢN ROLLBACK_K12 PASS TOÀN BỘ (Thực thi Down/Up migration trên bản sao an toàn, enum và dữ liệu tiền/sổ cái bảo toàn 100%)'
      : `KỊCH BẢN ROLLBACK_K12 FAIL (${checks.filter(c => !c.pass).length} kiểm tra không đạt)`
  );

  return {
    passed: allPassed,
    checks,
    logFile: logger.filePath
  };
}

if (process.argv[1] && process.argv[1].endsWith('k12-rollback-scenario.mjs')) {
  runRollbackK12()
    .then(res => process.exit(res.passed ? 0 : 1))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
