import { pathToFileURL } from 'node:url'

const methods = {
  billingStats: null,
  ownerBilling: null,
  totals: null,
  costByModel: [],
  vmUsageStats: null,
  keyUsageStats: null,
}

export function pauseExpression({ projectRoot, mode = 'apply', expectedEntry = 'src/server.mjs' }) {
  if (!['apply', 'status', 'restore'].includes(mode)) throw new Error('invalid mode')
  return `(async () => {
    const root = ${JSON.stringify(projectRoot)};
    const mode = ${JSON.stringify(mode)};
    if (!String(process.argv[1] || '').endsWith(${JSON.stringify(expectedEntry)})) throw new Error('unexpected target entry');
    const fs = process.getBuiltinModule('fs');
    const path = process.getBuiltinModule('path');
    const require = process.getBuiltinModule('module').createRequire(path.join(root, 'src/server.mjs'));
    const { RequestLogStore } = require(path.join(root, 'src/lib/admin/request-log.mjs'));
    const prototype = RequestLogStore.prototype;
    const key = Symbol.for('vm2api.adminBillingPause');
    const returns = ${JSON.stringify(methods)};
    if (mode === 'restore' && globalThis[key]) {
      for (const [name, descriptor] of globalThis[key].originals) Object.defineProperty(prototype, name, descriptor);
      delete globalThis[key];
    }
    if (mode === 'apply' && !globalThis[key]) {
      const originals = Object.keys(returns).map(name => {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        if (typeof descriptor?.value !== 'function' || !descriptor.configurable) throw new Error('unexpected method: ' + name);
        return [name, descriptor];
      });
      try {
        for (const [name, descriptor] of originals) {
          const original = descriptor.value;
          Object.defineProperty(prototype, name, { ...descriptor, value: function(...args) {
            if (fs.existsSync(path.join(this.dataDir, 'admin-billing-paused'))) return Array.isArray(returns[name]) ? [] : null;
            return original.apply(this, args);
          }});
        }
        Object.defineProperty(globalThis, key, { configurable: true, value: { originals, appliedAt: new Date().toISOString() } });
      } catch (error) {
        for (const [name, descriptor] of originals) Object.defineProperty(prototype, name, descriptor);
        throw error;
      }
    }
    return { pid: process.pid, mode, applied: Boolean(globalThis[key]), methods: Object.keys(returns),
      pauseFile: fs.existsSync(path.join(root, 'data/admin-billing-paused')) };
  })()`
}

export async function connectInspector(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('inspector connection failed')), { once: true })
  })
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data))
    const callback = pending.get(message.id)
    if (!callback) return
    pending.delete(message.id)
    clearTimeout(callback.timer)
    if (message.error) callback.reject(new Error(message.error.message))
    else callback.resolve(message.result)
  })
  return {
    async evaluate(expression) {
      const id = ++nextId
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('inspector response timeout'))
        }, 30000)
        pending.set(id, { resolve, reject, timer })
        socket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        )
      })
      if (result.exceptionDetails)
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
      return result.result?.value
    },
    close() {
      socket.close()
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode = 'apply', projectRoot = '/opt/vm2api'] = process.argv.slice(2)
  const targets = await (await fetch('http://127.0.0.1:9229/json/list')).json()
  if (targets.length !== 1 || !targets[0].webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:9229/'))
    throw new Error('unexpected inspector target')
  const client = await connectInspector(targets[0].webSocketDebuggerUrl)
  try {
    const result = await client.evaluate(pauseExpression({ projectRoot, mode }))
    console.log(JSON.stringify(result))
  } finally {
    await client
      .evaluate("setTimeout(() => { process.getBuiltinModule('inspector').close() }, 250); true")
      .catch(() => {})
    client.close()
  }
}
