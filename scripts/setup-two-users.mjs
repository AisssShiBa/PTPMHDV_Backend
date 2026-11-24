/**
 * Inspect existing demo accounts; optionally recover missing profile/wallet via
 * Auth outbox. This replaces the former destructive reset/funding script.
 * Usage: node scripts/setup-two-users.mjs [--dry-run | --apply] [--email EMAIL]
 * Requires the existing Docker Compose stack. Default targets: An and Admin.
 * Does not create Auth accounts, reset credentials, seed funds or approve KYC.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_EMAILS = ['an@demo.vn', 'admin@demo.vn'];

export function parseArguments(args) {
  const emails = [];
  let apply = false;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--help') return { help: true };
    else if (args[i] === '--email' && args[i + 1]) emails.push(args[++i].trim().toLowerCase());
    else throw new Error('Tham số không hợp lệ: ' + args[i]);
  }
  if (apply && dryRun) throw new Error('Chọn --apply hoặc --dry-run.');
  const selected = [...new Set(emails.length ? emails : DEFAULT_EMAILS)];
  if (selected.some(email => !/^[^\s@]+@demo\.vn$/.test(email))) {
    throw new Error('Công cụ này chỉ dành cho tài khoản mẫu @demo.vn.');
  }
  return { apply, emails: selected };
}

export function repairEventId(authId) {
  const bytes = createHash('sha256').update('finvault:week4:registration-repair:' + authId).digest();
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

const AUTH_PROGRAM = `
const { PrismaClient } = require('@prisma/client');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const prisma = new PrismaClient();
(async () => {
  if (input.action === 'inspect') {
    const users = await prisma.user.findMany({
      where: { email: { in: input.emails } },
      select: { id: true, email: true, username: true, firstName: true, lastName: true, role: true }
    });
    const events = await prisma.authOutboxEvent.findMany({
      where: { aggregateId: { in: users.map(user => user.id) }, eventType: 'user.registered' },
      select: { id: true, aggregateId: true, status: true }
    });
    return { users, events };
  }
  if (input.action !== 'enqueue') throw new Error('INVALID_ACTION');
  return prisma.$transaction(async tx => {
    const user = await tx.user.findUnique({
      where: { id: input.authId },
      select: { id: true, email: true, username: true, firstName: true, lastName: true }
    });
    if (!user || user.email !== input.email) throw new Error('AUTH_CHANGED');
    const event = await tx.authOutboxEvent.upsert({
      where: { id: input.eventId },
      create: {
        id: input.eventId, aggregateId: user.id, eventType: 'user.registered',
        payload: { authUserId: user.id, email: user.email, username: user.username,
          firstName: user.firstName, lastName: user.lastName },
        status: 'PENDING'
      },
      update: {}
    });
    return { id: event.id, status: event.status };
  });
})().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error.code || 'DEMO_REPAIR_QUERY_FAILED');
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
`;

const PROFILE_PROGRAM = `
const { PrismaClient } = require('@prisma/client');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const prisma = new PrismaClient();
prisma.user.findMany({
  where: { OR: [{ authUserId: { in: input.ids } }, { email: { in: input.emails } }] },
  select: { authUserId: true, email: true, deletedAt: true, kycTier: true }
}).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error.code || 'PROFILE_QUERY_FAILED'); process.exitCode = 1;
}).finally(() => prisma.$disconnect());
`;

const WALLET_PROGRAM = `
const { PrismaClient } = require('@prisma/client');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const prisma = new PrismaClient();
prisma.wallet.findMany({
  where: { userId: { in: input.ids }, ownerType: 'USER' },
  select: { userId: true, status: true, kycTier: true }
}).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error.code || 'WALLET_QUERY_FAILED'); process.exitCode = 1;
}).finally(() => prisma.$disconnect());
`;

function runInService(service, program, input) {
  const result = spawnSync('docker', ['compose', 'exec', '-T', service, 'node', '-e', program], {
    cwd: ROOT, input: JSON.stringify(input), encoding: 'utf8', timeout: 30000,
    maxBuffer: 1024 * 1024, windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new Error('Không truy vấn được ' + service + '. Kiểm tra Docker Compose và log dịch vụ.');
  }
  return JSON.parse(result.stdout.trim());
}

async function inspect(emails) {
  const auth = runInService('auth-service', AUTH_PROGRAM, { action: 'inspect', emails });
  const input = { emails, ids: auth.users.map(user => user.id) };
  const profiles = runInService('user-service', PROFILE_PROGRAM, input);
  const wallets = runInService('wallet-service', WALLET_PROGRAM, input);
  return planRepairs(emails, { ...auth, profiles, wallets });
}

export function planRepairs(emails, snapshot) {
  return emails.map(email => {
    const user = snapshot.users.find(item => item.email === email);
    if (!user) return { email, blockers: ['Không có tài khoản Auth; cần tạo qua luồng đăng ký.'] };
    const profile = snapshot.profiles.find(item => item.authUserId === user.id);
    const wallet = snapshot.wallets.find(item => item.userId === user.id);
    const blockers = [];
    if (snapshot.profiles.some(item => item.email === email && item.authUserId !== user.id)) {
      blockers.push('Email profile đang gắn với Auth ID khác.');
    }
    if (profile && (profile.deletedAt || profile.email !== email)) {
      blockers.push('Profile đã xóa hoặc có email không khớp; cần rà soát riêng.');
    }
    if ((!wallet && profile?.kycTier > 0) || (!profile && wallet?.kycTier > 0)
      || (profile && wallet && profile.kycTier !== wallet.kycTier)) {
      blockers.push('Cần đối chiếu KYC trước khi khôi phục; không tự nâng/hạ tier.');
    }
    const events = snapshot.events.filter(item => item.aggregateId === user.id);
    const eventId = repairEventId(user.id);
    const repair = events.find(item => item.id === eventId);
    if (repair?.status === 'FAILED') blockers.push('Sự kiện khôi phục đã FAILED; cần xem publisher/consumer.');
    return {
      email, authId: user.id, eventId, blockers,
      missingProfile: !profile, missingWallet: !wallet,
      complete: Boolean(profile && wallet && blockers.length === 0),
      existingEvent: repair || events.find(item => item.status === 'PENDING')
    };
  });
}

function printPlan(plan) {
  for (const item of plan) {
    const state = item.blockers.length ? 'CẦN RÀ SOÁT' : item.complete ? 'ĐỦ DỮ LIỆU' : 'THIẾU DỮ LIỆU';
    console.log(item.email + ': ' + state);
    if (item.authId) {
      console.log('  Profile: ' + (item.missingProfile ? 'thiếu' : 'có') + '; ví USER: ' + (item.missingWallet ? 'thiếu' : 'có'));
    }
    for (const reason of item.blockers) console.log('  ' + reason);
    if (!item.complete && item.existingEvent) {
      console.log('  Sự kiện đã có: ' + item.existingEvent.status + '; không tạo thêm.');
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('node scripts/setup-two-users.mjs [--dry-run | --apply] [--email an@demo.vn]');
    console.log('Mặc định chỉ kiểm tra An/Admin. --apply ghi sự kiện khôi phục, không reset dữ liệu hay cấp tiền/KYC.');
    return 0;
  }
  let plan = await inspect(options.emails);
  printPlan(plan);
  if (plan.some(item => item.blockers.length)) {
    console.error('Dừng: cần giải quyết các xung đột trước. Không ghi sự kiện khôi phục.');
    return 2;
  }
  if (!options.apply) {
    console.log('DRY RUN: không ghi dữ liệu. Dùng --apply sau khi đã xem kế hoạch khôi phục.');
    return 0;
  }
  if (plan.every(item => item.complete)) {
    console.log('Không có dữ liệu cần khôi phục; không ghi thêm sự kiện.');
    return 0;
  }
  for (const item of plan.filter(item => !item.complete)) {
    if (!item.existingEvent) {
      const event = runInService('auth-service', AUTH_PROGRAM, {
        action: 'enqueue', authId: item.authId, email: item.email, eventId: item.eventId
      });
      console.log(item.email + ': sự kiện khôi phục ' + event.status + '.');
    }
  }
  const deadline = Date.now() + 45000;
  do {
    await delay(1500);
    plan = await inspect(options.emails);
    if (plan.every(item => item.complete)) {
      printPlan(plan);
      console.log('Khôi phục hoàn tất qua publisher/consumer hiện có. Ví mới có số dư mặc định 0; ví cũ được giữ nguyên.');
      return 0;
    }
  } while (Date.now() < deadline && !plan.some(item => item.blockers.length));
  printPlan(plan);
  console.error('Chưa hoàn tất: kiểm tra Auth publisher, User consumer và Wallet consumer. Không chạy seed/reset để xử lý.');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
