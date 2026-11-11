#!/usr/bin/env node
/**
 * FinVault K20 Acceptance Runner (G8 Verification Engine)
 * Runs real acceptance scenarios against clean Docker Compose environment
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createK20Logger,
  checkSystemConservation,
  resetToSeed,
  getFinancialSnapshot,
  getWalletPrisma
} from '../tests/acceptance/k20/k20-shared.mjs';

const root = resolve(import.meta.dirname, '..');

export async function runFrameworkSelfTest() {
  const logger = createK20Logger('FRAMEWORK-TEST');
  logger.section('K20 FRAMEWORK SELF-TEST');
  const { execFileSync } = await import('node:child_process');
  try {
    const output = execFileSync(process.execPath, ['--test', 'tests/acceptance/k20/shared.test.mjs'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true
    });
    logger.raw(output);
    logger.result(true, 'Framework Self-Test PASS');
    return { passed: true, output };
  } catch (err) {
    logger.error(err.stdout || err.message);
    logger.result(false, 'Framework Self-Test FAIL');
    return { passed: false, error: err };
  }
}

const SCENARIO_MAP = {
  'test-framework': runFrameworkSelfTest,
  'A2': async () => {
    const { runA2 } = await import('../tests/acceptance/k20/a2-scenario.mjs');
    return await runA2();
  },
  'A9': async () => {
    const { runA9 } = await import('../tests/acceptance/k20/a9-scenario.mjs');
    return await runA9();
  },
  'A1': async () => {
    const { runA1 } = await import('../tests/acceptance/k20/a1-scenario.mjs');
    return await runA1();
  },
  'A8': async () => {
    const { runA8 } = await import('../tests/acceptance/k20/a8-scenario.mjs');
    return await runA8();
  },
  'ROLLBACK_K12': async () => {
    const { runRollbackK12 } = await import('../tests/acceptance/k20/k12-rollback-scenario.mjs');
    return await runRollbackK12();
  }
};

async function main() {
  const target = process.argv[2] || 'test-framework';

  console.log(`\n======================================================`);
  console.log(`   FINVAULT K20 ACCEPTANCE RUNNER (MỤC G8)`);
  console.log(`   Target: ${target}`);
  console.log(`   Timestamp: ${new Date().toISOString()}`);
  console.log(`======================================================\n`);

  if (target === 'all') {
    const results = {};
    for (const [name, fn] of Object.entries(SCENARIO_MAP)) {
      if (name === 'test-framework') continue;
      console.log(`\n>>> STARTING SCENARIO: ${name} ...`);
      try {
        const res = await fn();
        results[name] = res.passed ? 'PASS' : 'FAIL';
      } catch (e) {
        console.error(`Error in ${name}:`, e);
        results[name] = 'FAIL';
      }
    }
    console.log('\n================ ALL SCENARIOS SUMMARY ================');
    console.table(results);
    const allPassed = Object.values(results).every(r => r === 'PASS');
    process.exit(allPassed ? 0 : 1);
  } else if (SCENARIO_MAP[target]) {
    try {
      const res = await SCENARIO_MAP[target]();
      const passed = res && res.passed !== false;
      console.log(`\n>>> SCENARIO ${target} RESULT: ${passed ? 'PASS' : 'FAIL'}`);
      process.exit(passed ? 0 : 1);
    } catch (e) {
      console.error(`Error running ${target}:`, e);
      process.exit(1);
    }
  } else {
    console.error(`Unknown target: ${target}`);
    console.log(`Available targets: ${Object.keys(SCENARIO_MAP).join(', ')}, all`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('Runner fatal error:', err);
    process.exit(1);
  });
}
