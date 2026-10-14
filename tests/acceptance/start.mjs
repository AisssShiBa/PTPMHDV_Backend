import { spawn } from 'node:child_process'
import { openSync, writeFileSync, closeSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runtime, services, serviceDir, serviceEnv, ports } from './config.mjs'

const processFile = resolve(runtime, 'processes.json')
const processes = existsSync(processFile) ? JSON.parse(readFileSync(processFile, 'utf8')) : []
for (const name of (process.argv.length > 2 ? process.argv.slice(2) : [...services, 'gateway'])) {
  if (!(name in ports)) throw new Error('Unknown service')
  const health = 'http://127.0.0.1:' + ports[name] + '/health'
  if (await fetch(health).then(() => true).catch(() => false)) {
    throw new Error(name + ' port already occupied; inspect before replacing a running service.')
  }
  const log = openSync(resolve(runtime, name + '.log'), 'a')
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: serviceDir(name), env: serviceEnv(name), detached: true, windowsHide: true, stdio: ['ignore', log, log]
  })
  processes.push({ name, pid: child.pid })
  child.unref()
  closeSync(log)
  let ready = false
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await fetch(health).then((r) => name === 'wallet' ? r.status === 404 : r.ok).catch(() => false)) { ready = true; break }
    await delay(500)
  }
  writeFileSync(resolve(runtime, 'processes.json'), JSON.stringify(processes, null, 2))
  if (!ready) throw new Error(name + ' failed to start; see .cache/acceptance/' + name + '.log')
  console.log(name + ' ready on port ' + ports[name])
}
