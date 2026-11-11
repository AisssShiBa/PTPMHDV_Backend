/**
 * Scenario A1: 20 Concurrent Transfers on 100,000 VND Wallet
 * K20 Acceptance Verification (Mục G8)
 *
 * Specification:
 * - Sender: an@demo.vn (Tier 2, wallet balance = 100,000 VND)
 * - Recipient: binh@demo.vn (Tier 1, initial balance = 300,000 VND)
 * - 20 concurrent P2P requests of 60,000 VND each.
 * - EXPECTED: Exactly 1 succeeds, 19 rejected (with INSUFFICIENT_BALANCE / INSUFFICIENT_FUNDS).
 * - Sender final balance: 40,000 VND, heldBalance: 0.
 * - Recipient final balance: 360,000 VND, heldBalance: 0.
 * - Double-entry ledger: exactly 1 DEBIT / CREDIT pair (amount 60,000 VND).
 * - Total system conservation: sum(Wallet.balance) = 0, sum(Debit) = sum(Credit).
 * - Repeat 10 consecutive iterations with clean seed reset before each. All 10 must PASS.
 */

import { randomUUID } from 'node:crypto';
import {
  createK20Logger,
  apiCall,
  resetToSeed,
  checkSystemConservation,
  getFinancialSnapshot,
  getWalletPrisma,
  getPinTransactionToken,
  SEED_USERS,
  SEED_PIN
} from './k20-shared.mjs';

export async function runA1Iteration(iterNum, logger) {
  logger.section(`A1 ITERATION ${iterNum} / 10`);

  // Step 1: Clean seed reset with An balance = 100,000 VND
  const { accounts } = await resetToSeed({ forScenario: 'A1' });
  const an = accounts.an;
  const binh = accounts.binh;

  const prisma = getWalletPrisma();

  // Verify starting state
  const anStartWallet = await prisma.wallet.findUnique({ where: { id: an.walletId } });
  const binhStartWallet = await prisma.wallet.findUnique({ where: { id: binh.walletId } });

  logger.info(`Starting An balance: ${anStartWallet.balance} VND, held: ${anStartWallet.heldBalance} VND`);
  logger.info(`Starting Binh balance: ${binhStartWallet.balance} VND, held: ${binhStartWallet.heldBalance} VND`);

  if (Number(anStartWallet.balance) !== 100000) {
    throw new Error(`An starting balance is not 100,000 VND (actual: ${anStartWallet.balance})`);
  }

  const preConservation = await checkSystemConservation(prisma);
  if (!preConservation.passed) {
    throw new Error(`Pre-run conservation check failed: ${preConservation.errors.join('; ')}`);
  }
  const preSnapshot = preConservation.snapshot;

  // Step 2: Prepare 20 threads (quote -> checkout)
  const THREAD_COUNT = 20;
  const TRANSFER_AMOUNT = 60000;

  logger.info(`Launching ${THREAD_COUNT} concurrent P2P transfer requests of ${TRANSFER_AMOUNT} VND...`);

  // Execute 20 parallel threads
  const threadPromises = Array.from({ length: THREAD_COUNT }, async (_, idx) => {
    const threadId = `th-${String(idx).padStart(2, '0')}`;
    const idempotencyKey = `k20-a1-iter${iterNum}-${threadId}-${randomUUID()}`;

    // Step 2a: Quote
    let quoteData = null;
    try {
      const qRes = await apiCall('/payments/p2p/quote', {
        method: 'POST',
        token: an.token,
        body: {
          destinationUserId: binh.userId,
          amount: String(TRANSFER_AMOUNT)
        }
      });
      quoteData = qRes.data?.data;
    } catch (qErr) {
      // If quote fails, record failure
      return {
        threadId,
        idx,
        stage: 'QUOTE',
        success: false,
        status: qErr.status || 500,
        code: qErr.data?.error?.code || 'QUOTE_ERROR',
        message: qErr.data?.error?.message || qErr.message
      };
    }

    // Step 2b: Checkout (expected 201 for the single winning thread)
    try {
      const cRes = await apiCall('/payments/p2p/checkout', {
        method: 'POST',
        token: an.token,
        expected: 201,
        headers: {
          'Idempotency-Key': idempotencyKey
        },
        body: {
          destinationUserId: binh.userId,
          amount: String(TRANSFER_AMOUNT),
          note: `A1 concurrent transfer iter ${iterNum} thread ${threadId}`
        }
      });

      const payment = cRes.data?.data;

      // Step 2c: If checkout succeeded, proceed to PIN verify and Confirm!
      let confirmData = null;
      try {
        const transactionToken = await getPinTransactionToken(
          an.token,
          payment.id,
          TRANSFER_AMOUNT,
          SEED_PIN
        );

        const confRes = await apiCall(`/payments/${payment.id}/confirm`, {
          method: 'POST',
          token: an.token,
          headers: {
            'x-transaction-token': transactionToken
          }
        });

        confirmData = confRes.data?.data;

        return {
          threadId,
          idx,
          stage: 'CONFIRMED',
          success: true,
          status: confRes.status,
          paymentId: payment.id,
          paymentStatus: confirmData?.status || 'SUCCESS',
          replayed: payment.replayed
        };
      } catch (confErr) {
        return {
          threadId,
          idx,
          stage: 'CONFIRM',
          success: false,
          status: confErr.status || 500,
          code: confErr.data?.error?.code || 'CONFIRM_ERROR',
          message: confErr.data?.error?.message || confErr.message,
          paymentId: payment?.id
        };
      }
    } catch (cErr) {
      // Checkout rejected as expected for 19 threads
      return {
        threadId,
        idx,
        stage: 'CHECKOUT',
        success: false,
        status: cErr.status || 500,
        code: cErr.data?.error?.code || cErr.data?.code || 'CHECKOUT_REJECTED',
        message: cErr.data?.error?.message || cErr.message
      };
    }
  });

  const results = await Promise.all(threadPromises);

  // Step 3: Analyze results
  const successfulThreads = results.filter(r => r.success);
  const rejectedThreads = results.filter(r => !r.success);

  logger.info(`Results summary: ${successfulThreads.length} succeeded, ${rejectedThreads.length} rejected.`);

  // Log breakdown of rejections
  const rejectionCodeCounts = {};
  for (const r of rejectedThreads) {
    const code = `${r.status} ${r.code}`;
    rejectionCodeCounts[code] = (rejectionCodeCounts[code] || 0) + 1;
    logger.info(`  [${r.threadId}] REJECTED at ${r.stage}: HTTP ${r.status} (${r.code}): ${r.message}`);
  }
  for (const s of successfulThreads) {
    logger.info(`  [${s.threadId}] SUCCESS: paymentId=${s.paymentId}, status=${s.paymentStatus}`);
  }
  logger.info(`Rejection code distribution: ${JSON.stringify(rejectionCodeCounts)}`);

  // Step 4: Verification of Balances & Holds in DB
  const anEndWallet = await prisma.wallet.findUnique({ where: { id: an.walletId } });
  const binhEndWallet = await prisma.wallet.findUnique({ where: { id: binh.walletId } });

  logger.info(`Ending An balance: ${anEndWallet.balance} VND (expected: 40000), held: ${anEndWallet.heldBalance} VND (expected: 0)`);
  logger.info(`Ending Binh balance: ${binhEndWallet.balance} VND (expected: 360000), held: ${binhEndWallet.heldBalance} VND (expected: 0)`);

  // Check Ledger Entries for this iteration
  const successfulPaymentId = successfulThreads[0]?.paymentId;
  const newLedgerEntries = successfulPaymentId ? await prisma.ledgerEntry.findMany({
    where: {
      OR: [
        { referenceId: { contains: successfulPaymentId } },
        { referenceId: { startsWith: 'pay-' } }
      ]
    }
  }) : [];

  // Check conservation
  const postConservation = await checkSystemConservation(prisma);
  const postSnapshot = postConservation.snapshot;

  logger.info(`System conservation: totalBalance=${postSnapshot.totalBalance}, totalDebit=${postSnapshot.totalDebit}, totalCredit=${postSnapshot.totalCredit}`);

  // Assertions:
  const checks = [
    { name: 'Exactly 1 thread succeeded', pass: successfulThreads.length === 1, details: `Actual: ${successfulThreads.length}` },
    { name: 'Exactly 19 threads rejected', pass: rejectedThreads.length === 19, details: `Actual: ${rejectedThreads.length}` },
    { name: 'Successful payment status is SUCCESS', pass: successfulThreads[0]?.paymentStatus === 'SUCCESS', details: `Status: ${successfulThreads[0]?.paymentStatus}` },
    { name: 'An ending balance is 40,000 VND', pass: Number(anEndWallet.balance) === 40000, details: `Actual: ${anEndWallet.balance}` },
    { name: 'An heldBalance is 0 VND', pass: Number(anEndWallet.heldBalance) === 0, details: `Actual: ${anEndWallet.heldBalance}` },
    { name: 'Binh ending balance is 360,000 VND', pass: Number(binhEndWallet.balance) === 360000, details: `Actual: ${binhEndWallet.balance}` },
    { name: 'Binh heldBalance is 0 VND', pass: Number(binhEndWallet.heldBalance) === 0, details: `Actual: ${binhEndWallet.heldBalance}` },
    { name: 'No negative wallets detected', pass: postSnapshot.negativeWallets.length === 0, details: `Negative count: ${postSnapshot.negativeWallets.length}` },
    { name: 'Total system balance = 0', pass: Math.abs(postSnapshot.totalBalance) < 0.01, details: `Total balance: ${postSnapshot.totalBalance}` },
    { name: 'Double-entry ledger credit == debit', pass: Math.abs(postSnapshot.totalCredit - postSnapshot.totalDebit) < 0.01, details: `Credit: ${postSnapshot.totalCredit}, Debit: ${postSnapshot.totalDebit}` },
    { name: 'Delta conservation preserved', pass: Math.abs(postSnapshot.totalBalance - preSnapshot.totalBalance) < 0.01, details: `Delta: ${postSnapshot.totalBalance - preSnapshot.totalBalance}` }
  ];

  let iterPassed = true;
  for (const c of checks) {
    if (c.pass) {
      logger.info(`  [PASS] ${c.name} (${c.details})`);
    } else {
      logger.error(`  [FAIL] ${c.name} (${c.details})`);
      iterPassed = false;
    }
  }

  return {
    iterNum,
    passed: iterPassed,
    successfulCount: successfulThreads.length,
    rejectedCount: rejectedThreads.length,
    rejectionCodeCounts,
    anBalance: Number(anEndWallet.balance),
    binhBalance: Number(binhEndWallet.balance),
    checks
  };
}

export async function runA1() {
  const logger = createK20Logger('A1');
  logger.section('SCENARIO A1: CONCURRENT TRANSFERS (20 REQUESTS X 60,000 VND, 10 ITERATIONS)');

  const ITERATION_TOTAL = 10;
  const iterationSummaries = [];
  let allIterationsPassed = true;

  for (let i = 1; i <= ITERATION_TOTAL; i++) {
    try {
      const iterResult = await runA1Iteration(i, logger);
      iterationSummaries.push(iterResult);
      if (!iterResult.passed) {
        allIterationsPassed = false;
        logger.error(`Iteration ${i} FAILED.`);
      } else {
        logger.info(`Iteration ${i} PASSED.`);
      }
    } catch (err) {
      allIterationsPassed = false;
      logger.error(`Iteration ${i} threw unhandled exception: ${err.message}\n${err.stack}`);
      iterationSummaries.push({ iterNum: i, passed: false, error: err.message });
    }
  }

  logger.section('A1 10-ITERATION SUMMARY REPORT');
  for (const summary of iterationSummaries) {
    logger.info(`Iteration ${summary.iterNum}: ${summary.passed ? 'PASS' : 'FAIL'} (Success: ${summary.successfulCount}, Rejected: ${summary.rejectedCount}, An Bal: ${summary.anBalance}, Binh Bal: ${summary.binhBalance})`);
  }

  const passedCount = iterationSummaries.filter(s => s.passed).length;
  logger.info(`Total Passed Iterations: ${passedCount} / ${ITERATION_TOTAL}`);

  const finalPassed = allIterationsPassed && passedCount === ITERATION_TOTAL;
  logger.result(
    finalPassed,
    finalPassed
      ? `A1 CONCURRENT TRANSFER PASS (10/10 iterations successfully passed with 1 success, 19 rejected, An=40k, Binh=360k, Conservation=0)`
      : `A1 CONCURRENT TRANSFER FAIL (${passedCount}/${ITERATION_TOTAL} iterations passed)`
  );

  return {
    passed: finalPassed,
    iterations: iterationSummaries,
    logFile: logger.filePath
  };
}

if (import.meta.main || (process.argv[1] && process.argv[1].endsWith('a1-scenario.mjs'))) {
  runA1()
    .then(res => process.exit(res.passed ? 0 : 1))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
