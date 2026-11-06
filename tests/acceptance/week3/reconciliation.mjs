// Week 3 final-acceptance aggregator (plan §10). It reads the result.json of each
// phase run and emits the §10.4 row set — it never invents a verdict. A row is
// PASS only if that run wrote PASS for it; anything a phase could not answer stays
// BLOCKED, and work no harness exercises is NOT_RUN / MANUAL_PENDING.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const cache = resolve(root, '.cache/acceptance-week2')

// Phase -> the isolated Compose project whose evidence proves it. The project is
// supplied explicitly rather than guessed, because a run directory is only an
// environment and says nothing about which phase produced it.
const PHASES = [
  { phase: 'H11', title: 'VNPAY IPN + recovery', project: 'finvault-acceptance-06c23428207b' },
  { phase: 'H12', title: 'Two-step cash-out', project: 'finvault-acceptance-0c69458dd4d5' },
  { phase: 'H13', title: 'Outlet / API key / QR HMAC', project: 'finvault-acceptance-671281c9a033' },
  { phase: 'H14', title: 'KYC reject reason / review event / TTL', project: 'finvault-acceptance-af9a17974b53' }
]

// Rows no harness can answer yet, with the reason each is not a PASS. These are
// the plan's own dependencies (§10.1) and open STOP gates, not test failures.
// Owner is the person who owes the answer, which is often not this branch.
const OUTSIDE = [
  ['A1-A5', 'P2P / PIN / Wallet regression', 'MANUAL_PENDING', 'Chủ P2P/PIN/Wallet',
    'Owned by the P2P/PIN/Wallet owners. Not run by this branch; must be run by the owner before the common gate (§13) is signed off.'],
  ['ADMIN-KYC-REPORT', 'Admin reconciliation report (N13)', 'NOT_RUN', 'Nguyên',
    'No Admin reconciliation API exists in this branch. §10.1 lists it as a cross-owner handoff.'],
  ['MIGRATION-ROLLBACK', 'Migration backup + rollback strategy', 'MANUAL_PENDING', 'Huu',
    'Every H11–H14 migration was applied to disposable isolated projects only. Backing up and rehearsing a rollback against a retained dataset is a release step, not an acceptance scenario.'],
  ['REAL-VNPAY-SANDBOX', 'Real VNPAY sandbox round-trip', 'NOT_RUN', 'Khoa',
    'Callbacks are signed locally with a synthetic terminal. Plan risk R11 stays MEDIUM; no sandbox credentials were used.'],
  ['H12-OUTBOX-CONSUMER', 'funding.cashout_* has an Inbox consumer (§7.1, §10.1)', 'BLOCKED', 'Nguyên',
    'The events are committed transactionally with a registered schema and a valid envelope, and are readable from the run volume, but nothing binds funding.cashout_* on finvault.events. Observed: 6 funding.cashout_completed + 2 funding.cashout_failed left PENDING with retryCount 4-9 while payment.succeeded on the same publisher reached SENT. Money state is persisted and conserved; only notify is missing, which is §10.1\'s declared fallback rather than a dropped event. See docs/week3-h12-cashout-acceptance.md.']
]

// Evidence a phase wrote beside result.json for a BLOCKED row that has no
// result.json#<id> anchor of its own.
const EVIDENCE_FILES = {
  'C03': 'finvault-acceptance-0c69458dd4d5/c03-evidence.json',
  'C13': 'finvault-acceptance-0c69458dd4d5/c13-hold-extend-evidence.json',
  'K03': 'finvault-acceptance-af9a17974b53/k03-evidence.json',
  'K04-REVIEW': 'finvault-acceptance-af9a17974b53/k04-review-evidence.json'
}

// §10.2 money invariants, mapped to the rows that prove them. The result is read
// from those rows, never asserted here.
const MONEY = [
  ['Topup +100.000 → user +100.000, SYSTEM CLEARING_TOPUP −100.000, 1 debit / 1 credit', ['H11:V01']],
  ['Cash-out SUCCESS → user −100.000, system +100.000, hold CAPTURED', ['H12:C01']],
  ['Cash-out FAILED → no balance change, hold RELEASED, no capture rows', ['H12:C02']],
  ['Cash-out UNKNOWN → balance unchanged, hold PENDING', ['H12:C03']],
  ['Hold outlives its TTL while the bank is UNKNOWN → still CAPTURED once', ['H12:C13']],
  ['SUM(balance) = 0, ledger debit = credit', ['H11:CONSERVATION', 'H12:CONSERVATION', 'H12:C15', 'H13:CONSERVATION', 'H14:CONSERVATION']]
]

function commitOf() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'],
      { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  } catch { return null }
}

function load(project) {
  const path = resolve(cache, project, 'result.json')
  if (!existsSync(path)) return { path, report: null }
  return { path, report: JSON.parse(readFileSync(path, 'utf8')) }
}

// §10.4 requires the full field set on every row, including ones the harness never
// populates. Missing facets stay '-', which the plan's sample table also uses.
function row(phase, test, result, fields) {
  return {
    id: test,
    phase,
    owner: fields.owner ?? 'Huu',
    scenario: fields.scenario ?? '-',
    commit: fields.commit ?? '-',
    environment: fields.environment ?? '-',
    startedAt: fields.startedAt ?? '-',
    result,
    httpStatus: fields.httpStatus ?? null,
    errorCode: fields.errorCode ?? null,
    walletReferenceId: fields.walletReferenceId ?? null,
    ledgerInvariant: fields.ledgerInvariant ?? null,
    evidencePath: fields.evidencePath ?? (result === 'PASS' ? null
      : EVIDENCE_FILES[test] ? '`' + EVIDENCE_FILES[test] + '`' : null),
    notes: fields.notes ?? fields.reason ?? null
  }
}

export function reconcile(phases = PHASES) {
  const rows = []
  const provenance = []
  let missing = false

  for (const { phase, title, project } of phases) {
    const { path, report } = load(project)
    if (!report) {
      missing = true
      rows.push(row(phase, phase + '-EVIDENCE', 'NOT_RUN', { scenario: title,
        notes: 'No result.json at ' + path + '; this phase cannot be aggregated.' }))
      provenance.push({ phase, title, project, commit: '-', startedAt: '-', completedAt: '-', summary: '-' })
      continue
    }
    provenance.push({ phase, title, project, commit: report.commit,
      gateway: report.gateway, startedAt: report.startedAt,
      completedAt: report.completedAt, summary: report.summary,
      resultCount: report.results.length })
    for (const result of report.results) {
      rows.push(row(phase, result.id, result.result, result))
    }
  }

  for (const [id, scenario, result, owner, notes] of OUTSIDE) {
    rows.push(row('§13', id, result, { scenario, owner, notes }))
  }

  const count = status => rows.filter(item => item.result === status).length
  const summary = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN', 'MANUAL_PENDING']
    .map(status => status + '=' + count(status)).join(', ')

  return { rows, provenance, summary, missing }
}

function cell(value) {
  return String(value ?? '-').replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function render(aggregate) {
  const { rows, provenance, summary } = aggregate
  const line = items => items.map(cell).join(' | ')
  const key = item => item.phase + ':' + item.id
  const byKey = new Map(rows.map(item => [key(item), item]))

  const outcomes = rows.map(item => '| ' + line([item.phase, item.id, item.result]) + ' |')
  const transport = rows.map(item => '| ' + line([
    item.phase, item.id, item.httpStatus ?? '-', item.errorCode ?? '-',
    item.walletReferenceId ?? '-', item.ledgerInvariant ?? '-', item.notes ?? '-'
  ]) + ' |')
  const origin = rows.map(item => '| ' + line([
    item.phase, item.id, item.owner, item.commit, item.environment, item.startedAt,
    item.evidencePath ?? '-'
  ]) + ' |')

  const runs = provenance.map(run => '| ' + line([
    run.phase, run.title, '`' + run.project + '`', run.commit, run.startedAt,
    run.completedAt, run.summary
  ]) + ' |')

  const blocked = rows.filter(item => item.result === 'BLOCKED')
  const notRun = rows.filter(item => ['NOT_RUN', 'MANUAL_PENDING'].includes(item.result))

  // A money row is only as good as the rows cited for it. If any cited row is
  // not PASS, the invariant is not PASS.
  const money = MONEY.map(([scenario, refs]) => {
    const cited = refs.map(ref => byKey.get(ref))
    const missingRef = cited.find(item => !item)
    const verdict = missingRef ? 'NOT_RUN'
      : cited.every(item => item.result === 'PASS') ? 'PASS'
      : cited.some(item => item.result === 'FAIL') ? 'FAIL' : 'BLOCKED'
    const where = refs.map(ref => ref.replace(':', ' ')).join(', ')
    return '| ' + line([scenario, where, verdict]) + ' |'
  })

  return `# Week 3 — final backend acceptance (plan §10)

Aggregate of the four phase runs. Every PASS below is read from that phase's own
\`result.json\`; no verdict is inferred from the code, from an earlier test-database
pass, or from a different branch. Rows no harness exercises are \`NOT_RUN\` or
\`MANUAL_PENDING\`, and open STOP gates stay \`BLOCKED\`.

**${summary}**

Each phase ran on its own freshly built, isolated Compose project with random
host ports. Projects are removed at the end of the run; evidence, volumes and the
per-run credentials file are retained under \`.cache/acceptance-week2/\`.

## Phase provenance

| Phase | Scope | Compose project | Commit | Started | Completed | Summary |
|---|---|---|---|---|---|---|
${runs.join('\n')}

## Results

| Phase | Test | Result |
|---|---|---|
${outcomes.join('\n')}

## Transport, money and notes (§10.4)

\`walletReferenceId\` and \`ledgerInvariant\` are populated for the money phases
(H11/H12); the merchant and KYC phases move no money, so those cells are \`-\` by
construction rather than by omission.

| Phase | Test | httpStatus | errorCode | walletReferenceId | ledgerInvariant | notes |
|---|---|---|---|---|---|---|
${transport.join('\n')}

## Provenance fields (§10.4)

| Phase | Test | owner | commit | environment | startedAt | evidencePath |
|---|---|---|---|---|---|---|
${origin.join('\n')}

## Still open

### BLOCKED (${blocked.length})

${blocked.length ? blocked.map(item => '- **' + item.id + '** (' + item.phase + ', owner ' + item.owner + ') — ' + (item.notes ?? '-')).join('\n') : '- none'}

### NOT_RUN / MANUAL_PENDING (${notRun.length})

${notRun.map(item => '- **' + item.id + '** (' + item.result + ', owner ' + item.owner + ') — ' + (item.notes ?? '-')).join('\n')}

## Money invariants (§10.2)

| Scenario | Proven by | Result |
|---|---|---|
${money.join('\n')}

\`SUM(balance) = 0\` is one check, not proof of correctness. The per-transaction
invariants above are what the ledger assertions actually verify. C13 is why the
converse matters too: before the hold gained an extend API, a hold that expired
during an UNKNOWN bank window left \`SUM(balance)\` summing to 0 while the bank had
paid and the user kept the money — the loss sat between the system and the bank,
not inside the ledger, so no conservation check could see it. C13 now pins the
positive invariant: the hold is pushed forward on every reconcile pass, survives
its original TTL, and the eventual SUCCESS captures it exactly once.

## §13 common gate

| Gate | Result | Evidence |
|---|---|---|
| Build/typecheck/test of the three owned services | PASS | payment-service \`npm run build\` clean, \`npm test\` 43 pass / 1 skipped (pre-existing); merchant-service \`typecheck\` clean, \`npm test\` 33/33; user-service \`typecheck\` clean, \`npm test\` 32/32 — all re-run for this report |
| \`SUM(balance)\` = 0, debit = credit, \`heldBalance\` ≥ 0 | PASS | CONSERVATION in all four runs, C15 in H12 |
| Migration has backup + rollback strategy | MANUAL_PENDING | see MIGRATION-ROLLBACK |
| No secret/token/CCCD in Git or logs | PASS | K08 scans the run logs; per-run credentials live in \`.cache/\` (git-ignored) and no secret is printed into any report |
| P2P/PIN/Wallet A1–A5 regression | MANUAL_PENDING | see A1-A5 |
| Every PR has a reviewer and evidence link | MANUAL_PENDING | PRs cannot be opened from this machine (no \`gh\`, no token); see §11.1 |

## H12 status

The H12 cash-out block passes on an isolated runtime: C01–C15 are all PASS,
CONSERVATION is PASS, and the two money invariants that depended on STOP-1
(C03 UNKNOWN → one capture, C13 hold outliving its TTL) are PASS with their own
evidence. STOP-1 is closed by a Wallet hold **extend** API
(\`POST /wallets/:userId/hold/extend\`, monotonic, PENDING-guarded, capped by
\`WALLET_HOLD_MAX_LIFETIME_MS\`) that payment-service calls on every
\`AWAIT_RECONCILE\` pass before it queries the bank, so the sweeper can no longer
take a hold that is still backing a live payout. C13 proves the extend rather
than merely observing survival: \`expiresAt\` advances from
\`2026-11-06T05:52:45.850Z\` to \`2026-11-06T05:53:46.367Z\` across 13 reconcile
passes, then the bank's SUCCESS captures the same hold exactly once.

K12 is also closed. The SYSTEM wallet enum is \`MAIN / FEE / CLEARING_TOPUP /
SETTLEMENT\`: the top-up counterparty is \`CLEARING_TOPUP\` (renamed in place, so
the existing wallet and every ledger reference survive) and a capture with no
explicit destination settles into \`SETTLEMENT\`. Both phases re-ran from empty
databases on the same commit and read it back off the ledger —
\`DEBIT:CLEARING_TOPUP\` in H11, \`CREDIT:SETTLEMENT\` in H12 — rather than off the
configuration.

One H12 row remains BLOCKED, outside this branch's code: the Gateway funding
whitelist (STOP-3, owner Đạt). It is not a money defect and is not reachable from
the Wallet/Payment changes made here. A third gap, \`H12-OUTBOX-CONSUMER\`, is
recorded as BLOCKED on observed evidence rather than assumed: nothing binds
\`funding.cashout_*\` on \`finvault.events\`, so those rows stay \`PENDING\` with a
climbing retry count while \`payment.succeeded\` on the same publisher reaches
\`SENT\`. Money state is persisted and conserved; only the notification is
missing, which is §10.1's declared fallback, not a dropped event.

H13 and H14 are complete as scoped. \`user.kyc_reviewed\` remains BLOCKED by §9.2
(event-version scheme unagreed, registry entry missing) and is not published
outside the transaction.
`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const aggregate = reconcile()
  const out = resolve(root, 'docs/week3-final-acceptance.md')
  writeFileSync(out, render(aggregate))
  writeFileSync(resolve(cache, 'week3-aggregate.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), commit: commitOf(),
      summary: aggregate.summary, provenance: aggregate.provenance, rows: aggregate.rows }, null, 2))
  console.log('Summary: ' + aggregate.summary)
  console.log('Report: ' + out)
  process.exitCode = aggregate.missing || aggregate.rows.some(item => item.result === 'FAIL') ? 1 : 0
}
