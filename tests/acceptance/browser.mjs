import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(100) }
  throw new Error('Timed out: ' + label)
}

export async function openBrowser(directory, label) {
  const executable = process.env.BROWSER_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  ].find(existsSync)
  if (!executable) throw new Error('Set BROWSER_PATH to Chrome/Edge')
  const profile = resolve(directory, 'browser-' + label + '-' + process.pid)
  mkdirSync(profile, { recursive: true })
  const browserProcess = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' })
  const portFile = resolve(profile, 'DevToolsActivePort')
  await until(() => existsSync(portFile), 'Chrome DevTools port')
  const port = readFileSync(portFile, 'utf8').split('\n')[0].trim()
  const target = await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' }).then((r) => r.json())
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let nextId = 0
  const pending = new Map()
  const errors = []
  const network = []
  const requests = new Map()
  const listeners = new Map()
  socket.addEventListener('message', ({ data }) => {
    const event = JSON.parse(data)
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text)
    if (event.method === 'Network.requestWillBeSent') requests.set(event.params.requestId, event.params.request.method)
    if (event.method === 'Network.responseReceived') {
      const { response, requestId } = event.params
      if (response.url.startsWith('http')) {
        const url = new URL(response.url)
        network.push({ method: requests.get(requestId), origin: url.origin, path: url.pathname, status: response.status })
      }
    }
    if (listeners.has(event.method)) void listeners.get(event.method)(event.params)
    if (event.id && pending.has(event.id)) {
      const { resolve, reject, timer } = pending.get(event.id)
      clearTimeout(timer); pending.delete(event.id)
      if (event.error) reject(new Error(event.error.message)); else resolve(event.result)
    }
  })
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 15000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  const has = (selector) => evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')')
  const text = (value) => evaluate('document.body.innerText.includes(' + JSON.stringify(value) + ')')
  const fill = (selector, value) => evaluate('(() => { const input = document.querySelector(' + JSON.stringify(selector) + '); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ' + JSON.stringify(value) + '); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); })()')
  const click = (label, times = 1) => evaluate('(() => { const button = [...document.querySelectorAll("button")].find(el => el.textContent.trim() === ' + JSON.stringify(label) + '); if (!button) throw new Error("Missing button: " + ' + JSON.stringify(label) + '); for (let i=0;i<' + times + ';i++) button.click(); })()')
  const screenshot = async (label) => {
    const result = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    writeFileSync(resolve(directory, label + '.png'), Buffer.from(result.data, 'base64'))
  }
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false })
  return {
    cdp, evaluate, has, text, fill, click, screenshot, network, errors,
    on: (method, callback) => listeners.set(method, callback),
    go: (path) => cdp('Page.navigate', { url: 'http://localhost:5173' + path }),
    upload: async (selector, file) => {
      const document = await cdp('DOM.getDocument')
      const input = await cdp('DOM.querySelector', { nodeId: document.root.nodeId, selector })
      await cdp('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] })
    },
    close: async () => {
      await Promise.race([cdp('Browser.close').catch(() => {}), delay(1000)])
      socket.close(); browserProcess.kill()
      for (const { timer } of pending.values()) clearTimeout(timer)
    }
  }
}
