import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'

function freshStore(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-billing-pause-'))
  const store = new RequestLogStore({ dataDir, mode: 'normal' })
  t.after(() => {
    store.db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  return { store, flag: path.join(dataDir, 'admin-billing-paused') }
}

test('billing pause skips repository reads and removal restores the same live store', (t) => {
  const { store, flag } = freshStore(t)
  const names = ['totals', 'billingStats', 'ownerBilling', 'costByModel', 'vmUsageStats', 'keyUsageStats']
  const opts = { vmId: 'vm-a', apiKeyId: 'key-a' }
  const calls = new Map()
  const results = new Map()
  for (const name of names) {
    calls.set(name, 0)
    results.set(name, name === 'costByModel' ? [{ model: 'test', total_cost: 12 }] : { total_cost: 12 })
    store.repo[name] = (...args) => {
      assert.equal(fs.existsSync(flag), false, `${name} must not query while paused`)
      assert.deepEqual(args, name === 'totals' ? [] : [opts])
      calls.set(name, calls.get(name) + 1)
      return results.get(name)
    }
    assert.equal(store[name](opts), results.get(name))
  }

  fs.writeFileSync(flag, '')
  for (const name of names) {
    assert.deepEqual(store[name](opts), name === 'costByModel' ? [] : null)
    assert.equal(calls.get(name), 1)
  }

  fs.unlinkSync(flag)
  for (const name of names) {
    assert.equal(store[name](opts), results.get(name))
    assert.equal(calls.get(name), 2)
  }
})

test('billing pause belongs to one data directory', (t) => {
  const paused = freshStore(t)
  const active = freshStore(t)
  const activeTotals = { requests: 3, total_cost: 7 }
  active.store.repo.totals = () => activeTotals
  fs.writeFileSync(paused.flag, '')

  assert.equal(paused.store.totals(), null)
  assert.equal(active.store.totals(), activeTotals)
})

test('paused billing still stores request usage, costs and actual cost', (t) => {
  const { store, flag } = freshStore(t)
  fs.writeFileSync(flag, '')
  const ctx = store.start(
    { method: 'POST', headers: {}, socket: {} },
    { protocol: 'anthropic.messages', pathName: '/v1/messages' },
  )
  const summary = store.finish(ctx, {
    status: 200,
    model: 'claude-sonnet-5',
    requested_model: 'claude-sonnet-5',
    upstream_model: 'claude-sonnet-5',
    rate_multiplier: 1.5,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 7,
      cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 3 },
    },
  })

  assert.equal(store.billingStats(), null)
  assert.equal(store.hasSuccessfulRequest(), true)
  const rows = store.queryNormal({ limit: 5 }).items
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.request_id, ctx.request_id)
  assert.equal(row.log_mode, 'normal')
  assert.equal(row.input_tokens, 10)
  assert.equal(row.output_tokens, 5)
  assert.equal(row.cache_read_tokens, 3)
  assert.equal(row.cache_creation_tokens, 7)
  assert.equal(row.cache_creation_5m_tokens, 4)
  assert.equal(row.cache_creation_1h_tokens, 3)
  assert.equal(row.pricing_model, 'claude-sonnet-5')
  assert.ok(Math.abs(row.total_cost - 0.0000926) < 1e-12)
  assert.ok(Math.abs(row.actual_cost - 0.0001389) < 1e-12)
  assert.equal(row.total_cost, summary.total_cost)
  assert.equal(row.actual_cost, summary.actual_cost)

  fs.unlinkSync(flag)
  assert.equal(store.totals().requests, 1)
  assert.equal(store.ownerBilling({}).totals.requests, 1)
})
