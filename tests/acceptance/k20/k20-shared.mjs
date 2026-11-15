import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../../..');

const { PrismaClient } = require(resolve(root, 'services/wallet-service/node_modules/@prisma/client'));

export const GATEWAY_BASE_URL = process.env.GATEWAY_URL || 'http://localhost:3000';
export const WALLET_DB_URL = process.env.WALLET_DATABASE_URL ||
  'postgresql://postgres:404897ba313a20d9a166a1db0625276a77186fc0160c690a5e6e93ee09e06720@localhost:5432/wallet_service?schema=public';
export const REDIS_PASSWORD = process.env.REDIS_PASSWORD || '2e0bccb19255393af31732c39143d9ac47bdd997312b2c636872590ac7cdff4a';

let walletPrismaInstance = null;

export function getWalletPrisma() {
  if (!walletPrismaInstance) {
    walletPrismaInstance = new PrismaClient({
      datasources: { db: { url: WALLET_DB_URL } }
    });
  }
  return walletPrismaInstance;
}

/**
 * Execute psql query inside docker postgres container
 */
export async function executeSql(database, sqlQuery) {
  const { execFileSync } = await import('node:child_process');
  const result = execFileSync('docker', [
    'exec', '-i', 'ptpmhdv_backend-postgres-1',
    'psql', '-U', 'postgres', '-d', database,
    '-At', '-v', 'ON_ERROR_STOP=1', '-c', sqlQuery
  ], { encoding: 'utf8', windowsHide: true });
  return result.trim();
}

/**
 * Flush Redis rate limiter
 */
export async function flushRedis() {
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('docker', [
      'exec', 'ptpmhdv_backend-redis-1',
      'redis-cli', '-a', REDIS_PASSWORD, 'flushall'
    ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch (e) {
    // ignore
  }
}

/**
 * Redact sensitive fields (PIN, passwords, tokens, secrets, CCCD)
 */
export function sanitizeLog(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/(Bearer\s+)[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.?[A-Za-z0-9\-_=]*/gi, '$1[REDACTED_JWT]')
    .replace(/("?(?:pin|password|confirmPin|transactionToken)"?\s*[:=]\s*)"[^"]+"/gi, '$1"[REDACTED]"')
    .replace(/("?(?:idNumber|id_number)"?\s*[:=]\s*)"(\d{3})\d+(\d{3})"/gi, '$1"$2******$3"');
}

/**
 * Logger writing to console and to logs/k20/<mã>-<timestamp>.log
 */
export function createK20Logger(scenarioCode) {
  const logsDir = resolve(root, 'logs/k20');
  mkdirSync(logsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFilePath = resolve(logsDir, `${scenarioCode}-${timestamp}.log`);

  const write = (prefix, message) => {
    const now = new Date().toISOString();
    const cleanMsg = sanitizeLog(typeof message === 'object' ? JSON.stringify(message, null, 2) : String(message));
    const formatted = `[${now}] [${prefix}] ${cleanMsg}`;
    console.log(formatted);
    try {
      appendFileSync(logFilePath, formatted + '\n', 'utf8');
    } catch (e) {
      // ignore append error
    }
  };

  return {
    filePath: logFilePath,
    info: (msg) => write('INFO', msg),
    warn: (msg) => write('WARN', msg),
    error: (msg) => write('ERROR', msg),
    section: (title) => write('SECTION', `\n================== ${title} ==================`),
    raw: (msg) => write('RAW', msg),
    result: (passed, msg) => write(passed ? 'PASS' : 'FAIL', msg)
  };
}

/**
 * Universal API Client calling through Gateway
 */
export async function apiCall(path, options = {}) {
  const {
    method = 'GET',
    body,
    token,
    headers = {},
    expected = null
  } = options;

  const fullUrl = path.startsWith('http') ? path : `${GATEWAY_BASE_URL}/api${path.startsWith('/') ? path : '/' + path}`;
  const reqHeaders = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...headers
  };

  const fetchOptions = {
    method,
    headers: reqHeaders,
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(20000)
  };

  const response = await fetch(fullUrl, fetchOptions);
  let data = null;
  const text = await response.text();
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = text;
  }

  if (expected !== null && response.status !== expected) {
    const errMsg = `HTTP ${response.status} (expected ${expected}): ${typeof data === 'object' ? JSON.stringify(data) : data}`;
    const error = new Error(errMsg);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return {
    status: response.status,
    headers: response.headers,
    data
  };
}

/**
 * Get comprehensive financial snapshot
 */
export async function getFinancialSnapshot(prismaClient = getWalletPrisma()) {
  const userWallets = await prismaClient.wallet.aggregate({
    where: { ownerType: 'USER' },
    _sum: { balance: true, heldBalance: true },
    _count: true
  });

  const systemWallets = await prismaClient.wallet.aggregate({
    where: { ownerType: 'SYSTEM' },
    _sum: { balance: true, heldBalance: true },
    _count: true
  });

  const totalWallets = await prismaClient.wallet.aggregate({
    _sum: { balance: true, heldBalance: true },
    _count: true
  });

  const debitEntries = await prismaClient.ledgerEntry.aggregate({
    where: { direction: 'DEBIT' },
    _sum: { amount: true },
    _count: true
  });

  const creditEntries = await prismaClient.ledgerEntry.aggregate({
    where: { direction: 'CREDIT' },
    _sum: { amount: true },
    _count: true
  });

  const negativeWallets = await prismaClient.wallet.findMany({
    where: {
      ownerType: 'USER',
      balance: { lt: 0 }
    },
    select: { id: true, userId: true, balance: true }
  });

  // Calculate Checksum of Ledger Entries (SHA256 of sorted entries)
  const entries = await prismaClient.ledgerEntry.findMany({
    select: { id: true, walletId: true, amount: true, direction: true, balanceAfter: true, referenceId: true },
    orderBy: { id: 'asc' }
  });

  const hash = createHash('sha256');
  for (const e of entries) {
    hash.update(`${e.id}:${e.walletId}:${e.amount}:${e.direction}:${e.balanceAfter}:${e.referenceId};`);
  }
  const ledgerChecksum = hash.digest('hex');

  const userBalance = Number(userWallets._sum.balance || 0);
  const userHeld = Number(userWallets._sum.heldBalance || 0);
  const systemBalance = Number(systemWallets._sum.balance || 0);
  const systemHeld = Number(systemWallets._sum.heldBalance || 0);
  const totalBalance = Number(totalWallets._sum.balance || 0);
  const totalHeld = Number(totalWallets._sum.heldBalance || 0);
  const totalDebit = Number(debitEntries._sum.amount || 0);
  const totalCredit = Number(creditEntries._sum.amount || 0);

  return {
    userBalance,
    userHeld,
    userWalletCount: userWallets._count,
    systemBalance,
    systemHeld,
    systemWalletCount: systemWallets._count,
    totalBalance: Math.round(totalBalance * 100) / 100,
    totalHeld: Math.round(totalHeld * 100) / 100,
    totalWalletsCount: totalWallets._count,
    totalDebit: Math.round(totalDebit * 100) / 100,
    totalCredit: Math.round(totalCredit * 100) / 100,
    debitCount: debitEntries._count,
    creditCount: creditEntries._count,
    ledgerChecksum,
    negativeWallets,
    timestamp: new Date().toISOString()
  };
}

/**
 * Verify system conservation:
 * 1. totalBalance === 0 (sum of all user + system wallets)
 * 2. totalCredit === totalDebit (double-entry invariant)
 * 3. negativeWallets === 0 (no overdraft on user wallets)
 * 4. totalHeld >= 0
 */
export async function checkSystemConservation(prismaClient = getWalletPrisma()) {
  const snapshot = await getFinancialSnapshot(prismaClient);
  const errors = [];

  const isBalanceZero = Math.abs(snapshot.totalBalance) < 0.01;
  if (!isBalanceZero) {
    errors.push(`Tổng số dư hệ thống khác 0: ${snapshot.totalBalance} VND (User: ${snapshot.userBalance}, System: ${snapshot.systemBalance})`);
  }

  const isLedgerBalanced = Math.abs(snapshot.totalCredit - snapshot.totalDebit) < 0.01;
  if (!isLedgerBalanced) {
    errors.push(`Sổ cái không cân bằng: CREDIT (${snapshot.totalCredit}) != DEBIT (${snapshot.totalDebit})`);
  }

  if (snapshot.negativeWallets.length > 0) {
    errors.push(`Phát hiện ${snapshot.negativeWallets.length} ví người dùng bị âm: ${JSON.stringify(snapshot.negativeWallets)}`);
  }

  if (snapshot.totalHeld < 0) {
    errors.push(`heldBalance toàn hệ thống bị âm: ${snapshot.totalHeld}`);
  }

  const passed = errors.length === 0;
  return {
    passed,
    snapshot,
    errors
  };
}

export function verifyDeltaConservation(beforeSnap, afterSnap) {
  const deltaBalance = Math.round((afterSnap.totalBalance - beforeSnap.totalBalance) * 100) / 100;
  const deltaCredit = Math.round((afterSnap.totalCredit - beforeSnap.totalCredit) * 100) / 100;
  const deltaDebit = Math.round((afterSnap.totalDebit - beforeSnap.totalDebit) * 100) / 100;
  const deltaCreditDebit = Math.round((deltaCredit - deltaDebit) * 100) / 100;

  const isBalanceConserved = Math.abs(deltaBalance) < 0.01;
  const isLedgerConserved = Math.abs(deltaCreditDebit) < 0.01;
  const passed = isBalanceConserved && isLedgerConserved;

  return {
    passed,
    isBalanceConserved,
    isLedgerConserved,
    deltaBalance,
    deltaCredit,
    deltaDebit,
    deltaCreditDebit
  };
}

export const SEED_USERS = {
  admin: { email: 'admin@demo.vn', username: 'admin_demo', role: 'ADMIN', firstName: 'Admin', lastName: 'Demo', defaultBalance: 0, tier: 2 },
  an: { email: 'an@demo.vn', username: 'an_demo', role: 'USER', firstName: 'An', lastName: 'Nguyen', defaultBalance: 1250000, tier: 2 },
  binh: { email: 'binh@demo.vn', username: 'binh_demo', role: 'USER', firstName: 'Binh', lastName: 'Tran', defaultBalance: 300000, tier: 1 },
  chi: { email: 'chi@demo.vn', username: 'chi_demo', role: 'USER', firstName: 'Chi', lastName: 'Le', defaultBalance: 100000, tier: 0 },
  highlands: { email: 'highlands@demo.vn', username: 'highlands_demo', role: 'USER', firstName: 'Highlands', lastName: 'Demo', defaultBalance: 0, tier: 1, isMerchant: true }
};

export const SEED_PASSWORD = 'Password123!';
export const SEED_PIN = '123456';

let cachedAccounts = null;

/**
 * Generate authenticated JWT for test execution using the deployment ACCESS_TOKEN_SECRET
 */
export function createJwtToken(userId, role = 'USER') {
  const secretPath = resolve(root, 'secrets/access_token_secret.txt');
  const secret = existsSync(secretPath) ? readFileSync(secretPath, 'utf8').trim() : 'access_secret_finvault_local_development_only';
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    userId,
    role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600 * 24 // 24 hours
  })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/**
 * Register or ensure seed account exists
 */
export async function ensureSeedUser(key, userConfig) {
  // Check if exists in auth
  let userId = await executeSql('auth_service', `SELECT id FROM "User" WHERE email='${userConfig.email}';`);

  if (!userId) {
    // Signup via Gateway
    const signupRes = await apiCall('/auth/signup', {
      method: 'POST',
      body: {
        username: userConfig.username,
        email: userConfig.email,
        password: SEED_PASSWORD,
        firstName: userConfig.firstName,
        lastName: userConfig.lastName
      }
    });
    if (signupRes.status === 201) {
      userId = signupRes.data.data.userId;
    } else {
      userId = await executeSql('auth_service', `SELECT id FROM "User" WHERE email='${userConfig.email}';`);
    }
  }

  // Update role if admin
  if (userConfig.role === 'ADMIN') {
    await executeSql('auth_service', `UPDATE "User" SET role='ADMIN' WHERE id='${userId}';`);
  }

  // Generate authentic JWT token directly to avoid auth-service in-memory signin rate limit
  const token = createJwtToken(userId, userConfig.role);

  // Ensure KYC Tier in user_service
  await executeSql('user_service', `
    UPDATE users 
    SET kyc_tier=${userConfig.tier}, 
        kyc_status='${userConfig.tier > 0 ? 'APPROVED' : 'NONE'}' 
    WHERE auth_user_id='${userId}';
  `);

  // Ensure Wallet in wallet_service
  const prisma = getWalletPrisma();
  let wallet = await prisma.wallet.findUnique({
    where: { userId_ownerType: { userId, ownerType: 'USER' } }
  });

  if (!wallet) {
    wallet = await prisma.wallet.create({
      data: {
        userId,
        ownerType: 'USER',
        balance: 0,
        heldBalance: 0,
        kycTier: userConfig.tier,
        status: 'ACTIVE',
        currency: 'VND'
      }
    });
  } else if (wallet.kycTier !== userConfig.tier) {
    wallet = await prisma.wallet.update({
      where: { id: wallet.id },
      data: { kycTier: userConfig.tier }
    });
  }

  // Ensure PIN
  if (userConfig.role !== 'ADMIN') {
    const pinCheck = await executeSql('auth_service', `SELECT count(*) FROM "UserPin" WHERE "userId"='${userId}';`);
    if (pinCheck === '0') {
      await apiCall('/auth/pin/setup', {
        method: 'POST',
        token,
        body: { pin: SEED_PIN, confirmPin: SEED_PIN }
      });
    }
  }

  return {
    userId,
    token,
    walletId: wallet.id,
    email: userConfig.email,
    username: userConfig.username,
    role: userConfig.role,
    tier: userConfig.tier
  };
}

/**
 * Initialize all seed accounts once and cache their tokens
 */
export async function initSeedAccountsOnce() {
  if (cachedAccounts) return cachedAccounts;
  const accounts = {};
  for (const [key, config] of Object.entries(SEED_USERS)) {
    accounts[key] = await ensureSeedUser(key, config);
  }
  cachedAccounts = accounts;
  return cachedAccounts;
}

/**
 * Reset system wallets and seed accounts to pristine, fully conserved state
 */
export async function resetToSeed(options = {}) {
  const { forScenario = 'DEFAULT', anBalanceOverride = null, chiBalanceOverride = null } = options;
  const prisma = getWalletPrisma();

  // Flush Redis rate limiters so test runs have clean window
  await flushRedis();

  // Ensure system wallets exist: SETTLEMENT, CLEARING_TOPUP, FEE
  const systemWallets = ['SETTLEMENT', 'CLEARING_TOPUP', 'FEE'];
  for (const code of systemWallets) {
    const exists = await prisma.wallet.findUnique({
      where: { systemCode: code }
    });
    if (!exists) {
      await prisma.wallet.create({
        data: {
          ownerType: 'SYSTEM',
          systemCode: code,
          balance: 0,
          heldBalance: 0,
          currency: 'VND',
          status: 'ACTIVE',
          kycTier: 0
        }
      });
    }
  }

  // Ensure seed accounts
  const accounts = await initSeedAccountsOnce();
  const seedUserIds = Object.values(accounts).map(a => a.userId);

  // Clean out foreign test data from past test runs
  // Disable trigger on LedgerEntry for clean truncation
  await executeSql('wallet_service', `
    TRUNCATE TABLE "WalletHold", "AnomalyAdjustment", "ReconciliationAnomaly", "ReconciliationReport", "UserDailyUsage" CASCADE;
    ALTER TABLE "LedgerEntry" DISABLE TRIGGER "LedgerEntry_append_only";
    TRUNCATE TABLE "LedgerEntry" CASCADE;
    ALTER TABLE "LedgerEntry" ENABLE TRIGGER "LedgerEntry_append_only";
    DELETE FROM "Wallet" WHERE "ownerType" = 'USER' AND "userId" NOT IN (${seedUserIds.map(id => `'${id}'`).join(',')});
  `);

  // Also clean payments from payment_service for a clean state
  await executeSql('payment_service', `
    TRUNCATE TABLE "Payment", "PaymentHistory", "OutboxEvent", "UsedTransactionToken" CASCADE;
  `);

  // Calculate target balances
  let targetAn = SEED_USERS.an.defaultBalance; // 1,250,000
  if (forScenario === 'A1') targetAn = 100000;
  if (anBalanceOverride !== null) targetAn = anBalanceOverride;

  const targetBinh = SEED_USERS.binh.defaultBalance; // 300,000

  let targetChi = SEED_USERS.chi.defaultBalance; // 100,000
  if (forScenario === 'A9') targetChi = 1100000; // 100k seed + 1M topup
  if (chiBalanceOverride !== null) targetChi = chiBalanceOverride;

  // Set balances directly
  const targets = {
    [accounts.an.walletId]: targetAn,
    [accounts.binh.walletId]: targetBinh,
    [accounts.chi.walletId]: targetChi,
    [accounts.highlands.walletId]: 0,
    [accounts.admin.walletId]: 0
  };

  for (const [walletId, targetBal] of Object.entries(targets)) {
    await prisma.wallet.update({
      where: { id: Number(walletId) },
      data: { balance: targetBal, heldBalance: 0 }
    });
  }

  // System Wallets:
  const totalUserBalance = targetAn + targetBinh + targetChi;
  const clearingWallet = await prisma.wallet.findUniqueOrThrow({ where: { systemCode: 'CLEARING_TOPUP' } });
  const settlementWallet = await prisma.wallet.findUniqueOrThrow({ where: { systemCode: 'SETTLEMENT' } });
  const feeWallet = await prisma.wallet.findUniqueOrThrow({ where: { systemCode: 'FEE' } });

  await prisma.wallet.update({
    where: { id: clearingWallet.id },
    data: { balance: -totalUserBalance, heldBalance: 0 }
  });
  await prisma.wallet.update({
    where: { id: settlementWallet.id },
    data: { balance: 0, heldBalance: 0 }
  });
  await prisma.wallet.update({
    where: { id: feeWallet.id },
    data: { balance: 0, heldBalance: 0 }
  });

  // Create initial balanced seed LedgerEntry rows for users who have balance > 0
  // Each topup has a matching DEBIT on CLEARING_TOPUP and CREDIT on User Wallet
  let runningClearingBal = 0;
  const seedBalances = [
    { name: 'an', walletId: accounts.an.walletId, bal: targetAn },
    { name: 'binh', walletId: accounts.binh.walletId, bal: targetBinh },
    { name: 'chi', walletId: accounts.chi.walletId, bal: targetChi }
  ];

  for (const item of seedBalances) {
    if (item.bal > 0) {
      const txnId = randomUUID();
      const refId = `seed-${item.name}-${Date.now()}-${randomUUID().slice(0, 8)}`;
      runningClearingBal -= item.bal;

      // 1. DEBIT on CLEARING_TOPUP
      await prisma.ledgerEntry.create({
        data: {
          transactionId: txnId,
          walletId: clearingWallet.id,
          direction: 'DEBIT',
          amount: item.bal,
          balanceAfter: runningClearingBal,
          referenceId: `ref-clr-${refId}`,
          transferType: 'TOPUP',
          note: `Seed funding debit for ${item.name}`
        }
      });

      // 2. CREDIT on User Wallet
      await prisma.ledgerEntry.create({
        data: {
          transactionId: txnId,
          walletId: item.walletId,
          direction: 'CREDIT',
          amount: item.bal,
          balanceAfter: item.bal,
          referenceId: `ref-usr-${refId}`,
          transferType: 'TOPUP',
          note: `Seed funding credit for ${item.name}`
        }
      });
    }
  }

  // Verify conservation immediately
  const conservation = await checkSystemConservation(prisma);
  if (!conservation.passed) {
    throw new Error(`resetToSeed failed conservation: ${conservation.errors.join('; ')}`);
  }

  return { accounts, targets, conservation };
}

/**
 * Login and retrieve fresh JWT access tokens
 */
export async function loginSeed() {
  return await initSeedAccountsOnce();
}

/**
 * Verify PIN and retrieve transaction token (60s)
 */
export async function getPinTransactionToken(senderToken, paymentId, amount, pin = SEED_PIN) {
  const res = await apiCall('/auth/pin/verify', {
    method: 'POST',
    token: senderToken,
    body: {
      pin,
      paymentId,
      amount: String(amount)
    },
    expected: 200
  });
  return res.data.data.transactionToken;
}
