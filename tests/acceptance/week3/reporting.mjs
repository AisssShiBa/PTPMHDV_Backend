import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { root } from '../week2/runtime.mjs'
import { executionFailure } from '../week2/reporting.mjs'

// Section 10.4 report fields, but never credentials, cookies, PINs or response
// bodies: scenario callbacks return only status codes, record ids and invariant
// results, and failures are scrubbed by executionFailure().
export class Blocked extends Error {}

function cell(value) {
  return String(value ?? '-').replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function createRecorder(ctx) {
  const startedAt = new Date().toISOString()
  const commit = (() => {
    try {
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'],
        { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
    } catch { return null }
  })()
  const results = []

  async function check({ id, owner = 'Huu', scenario }, fn) {
    const began = new Date().toISOString()
    const start = Date.now()
    try {
      const detail = (await fn()) ?? {}
      results.push({ id, owner, scenario, commit, environment: ctx.project,
        startedAt: began, result: 'PASS', durationMs: Date.now() - start,
        evidencePath: 'result.json#' + id, ...detail })
      console.log('PASS ' + id + ': ' + scenario)
      return true
    } catch (error) {
      const blocked = error instanceof Blocked
      const reason = blocked ? error.message
        : error?.code === 'ERR_ASSERTION' ? String(error.message).split('\n')[0]
        : executionFailure(error)
      results.push({ id, owner, scenario, commit, environment: ctx.project,
        startedAt: began, result: blocked ? 'BLOCKED' : 'FAIL', reason,
        durationMs: Date.now() - start })
      console.log((blocked ? 'BLOCKED ' : 'FAIL ') + id + ': ' + reason)
      return false
    } finally {
      writeFileSync(resolve(ctx.directory, 'result.partial.json'), JSON.stringify({
        project: ctx.project, status: 'RUNNING', startedAt,
        updatedAt: new Date().toISOString(), results
      }, null, 2))
    }
  }

  function write(extra = {}) {
    const report = { project: ctx.project, gateway: ctx.base, commit,
      startedAt, completedAt: new Date().toISOString(), results, ...extra }
    writeFileSync(resolve(ctx.directory, 'result.json'), JSON.stringify(report, null, 2))
    const rows = results.map(row => '| ' + row.id + ' | ' + row.result + ' | ' +
      cell(row.evidencePath || row.reason) + ' | ' + cell(row.notes) + ' |')
    writeFileSync(resolve(ctx.directory, 'report.md'),
      '# Week 3 — H11 VNPAY acceptance\n\n' +
      '- Project: `' + ctx.project + '`\n' +
      '- Commit: `' + (commit || 'unknown') + '`\n' +
      '- Started: ' + startedAt + '\n' +
      '- Completed: ' + report.completedAt + '\n\n' +
      '| Test | Result | Evidence | Notes |\n|---|---|---|---|\n' + rows.join('\n') + '\n')
    return report
  }

  return { check, write, results, commit }
}
