import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { connectInspector, pauseExpression } from '../../scripts/admin-billing-live-pause.mjs'

test('live pause preserves writes, restores methods, and follows the marker without restarting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-live-pause-'))
  fs.mkdirSync(path.join(root, 'src/lib/admin'), { recursive: true })
  fs.mkdirSync(path.join(root, 'data'))
  fs.writeFileSync(
    path.join(root, 'src/lib/admin/request-log.mjs'),
    `
    export class RequestLogStore {
      constructor() { this.dataDir = ${JSON.stringify(path.join(root, 'data'))}; this.writes = 0 }
      billingStats() { return 'active' } ownerBilling() { return 'active' } totals() { return 'active' }
      costByModel() { return ['active'] } vmUsageStats() { return 'active' } keyUsageStats() { return 'active' }
      finish() { this.writes++; return this.writes }
    }
  `,
  )
  fs.writeFileSync(
    path.join(root, 'target.mjs'),
    `
    import { RequestLogStore } from './src/lib/admin/request-log.mjs';
    globalThis.store = new RequestLogStore(); setInterval(() => {}, 1000);
  `,
  )
  const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', path.join(root, 'target.mjs')], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let client
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture inspector timeout')), 10000)
      child.stderr.on('data', (data) => {
        const match = String(data).match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)
        if (match) {
          clearTimeout(timer)
          resolve(match[0])
        }
      })
    })
    client = await connectInspector(url)
    assert.equal(await client.evaluate('store.billingStats()'), 'active')
    const options = { projectRoot: root, expectedEntry: 'target.mjs' }
    const applied = await client.evaluate(pauseExpression(options))
    assert.equal(applied.applied, true)
    fs.writeFileSync(path.join(root, 'data/admin-billing-paused'), 'paused')
    assert.deepEqual(
      await client.evaluate(
        '[store.billingStats(), store.ownerBilling(), store.totals(), store.costByModel(), store.vmUsageStats(), store.keyUsageStats(), store.finish()]',
      ),
      [null, null, null, [], null, null, 1],
    )
    fs.unlinkSync(path.join(root, 'data/admin-billing-paused'))
    assert.equal(await client.evaluate('store.billingStats()'), 'active')
    assert.equal((await client.evaluate(pauseExpression({ ...options, mode: 'restore' }))).applied, false)
    assert.equal(await client.evaluate('store.finish()'), 2)
    await client.evaluate("setTimeout(() => process.getBuiltinModule('inspector').close(), 50); true")
    client.close()
    client = undefined
    await new Promise((resolve) => setTimeout(resolve, 200))
    await assert.rejects(fetch(`http://${new URL(url).host}/json/list`))
    assert.doesNotThrow(() => process.kill(child.pid, 0))
  } finally {
    client?.close()
    child.kill('SIGTERM')
    fs.rmSync(root, { recursive: true, force: true })
  }
})
