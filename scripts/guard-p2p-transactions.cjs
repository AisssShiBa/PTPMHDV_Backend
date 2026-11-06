/**
 * scripts/guard-p2p-transactions.cjs
 *
 * STATIC AST ANALYZER & CI GUARD FOR K16:
 * Scans P2pService for any occurrences of HTTP calls, wallet calls, or sleep/timers
 * inside prisma.$transaction callbacks.
 *
 * Exits with 0 if clean, exits with 1 if any violation is detected.
 */

const fs = require('fs');
const path = require('path');
const ts = require(path.resolve(__dirname, '../services/payment-service/node_modules/typescript'));

const targetFile = path.resolve(__dirname, '../services/payment-service/src/services/p2p.service.ts');

function analyzeFile(filePath, customSource) {
  const sourceCode = customSource !== undefined ? customSource : fs.readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    path.basename(filePath),
    sourceCode,
    ts.ScriptTarget.Latest,
    true
  );

  const violations = [];
  let transactionBlockCount = 0;

  function isPrismaTransactionCall(node) {
    if (!ts.isCallExpression(node)) return false;
    const expression = node.expression;
    // Check if calling prisma.$transaction or tx.$transaction
    if (ts.isPropertyAccessExpression(expression)) {
      const propName = expression.name.text;
      if (propName === '$transaction') return true;
    }
    return false;
  }

  function checkInsideTransaction(txNode, txIndex) {
    function visitInside(childNode) {
      // Check for CallExpression
      if (ts.isCallExpression(childNode)) {
        const expr = childNode.expression;
        const callText = childNode.getText(sourceFile);

        // 1. Check for wallet calls (this.wallet.*, walletClient.*, wallet.*)
        if (
          callText.includes('this.wallet') ||
          callText.includes('walletClient') ||
          /wallet\.(createHold|captureHold|releaseHold|refundCapture|lookupTransaction)/.test(callText)
        ) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(childNode.getStart(sourceFile));
          violations.push({
            type: 'WALLET_CALL_INSIDE_TRANSACTION',
            line: line + 1,
            col: character + 1,
            code: callText,
            message: `Gọi ví trong active transaction bị cấm: ${callText}`,
          });
        }

        // 2. Check for network HTTP I/O (fetch, axios, http.request, etc.)
        if (
          ts.isIdentifier(expr) && expr.text === 'fetch' ||
          callText.startsWith('axios.') ||
          callText.startsWith('http.') ||
          callText.startsWith('https.')
        ) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(childNode.getStart(sourceFile));
          violations.push({
            type: 'NETWORK_IO_INSIDE_TRANSACTION',
            line: line + 1,
            col: character + 1,
            code: callText,
            message: `Gọi network HTTP I/O trong transaction bị cấm: ${callText}`,
          });
        }

        // 3. Check for sleep / timers (setTimeout, setInterval, sleep)
        if (
          (ts.isIdentifier(expr) && (expr.text === 'setTimeout' || expr.text === 'setInterval' || expr.text === 'sleep')) ||
          callText.includes('setTimeout')
        ) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(childNode.getStart(sourceFile));
          violations.push({
            type: 'SLEEP_TIMER_INSIDE_TRANSACTION',
            line: line + 1,
            col: character + 1,
            code: callText,
            message: `Dùng setTimeout / sleep trong transaction giữ lock DB bị cấm: ${callText}`,
          });
        }
      }

      ts.forEachChild(childNode, visitInside);
    }

    ts.forEachChild(txNode, visitInside);
  }

  function visit(node) {
    if (isPrismaTransactionCall(node)) {
      transactionBlockCount++;
      const args = node.arguments;
      if (args && args.length > 0) {
        // First argument is typically the callback function: async (tx) => { ... }
        const callbackArg = args[0];
        checkInsideTransaction(callbackArg, transactionBlockCount);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {
    file: filePath,
    transactionBlockCount,
    violations,
  };
}

// CLI execution
if (require.main === module) {
  console.log(`[K16 Guard] Scanning: ${targetFile}`);
  const result = analyzeFile(targetFile);

  console.log(`[K16 Guard] Phát hiện ${result.transactionBlockCount} khối prisma.$transaction trong file.`);

  if (result.violations.length > 0) {
    console.error(`\n❌ [VIOLATION DETECTED] Phát hiện ${result.violations.length} vi phạm gọi ví/I/O trong transaction:`);
    for (const v of result.violations) {
      console.error(`  - Dòng ${v.line}:${v.col} [${v.type}]: ${v.message}`);
    }
    process.exit(1);
  } else {
    console.log(`✅ [PASS] 100% SẠCH SẼ: Không có bất kỳ lời gọi ví (walletClient), Network I/O, hay setTimeout nào nằm trong prisma.$transaction.`);
    process.exit(0);
  }
}

module.exports = { analyzeFile };
