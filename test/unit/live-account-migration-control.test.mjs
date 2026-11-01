import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs, projectMigration, runControl } from '../../scripts/live-account-migration-control.mjs'

const MIGRATION = 'aa8c1126-3d86-465a-8c49-419ddd9a877f'
const JOB = 'a7ef1dd1-6499-4a98-b829-d96831765d2d'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-control-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(root, 'data'), { recursive: true, mode: 0o700 })
  const vmFile = path.join(root, 'vms', 'vm-01.json')
  const writeVm = value => { fs.writeFileSync(vmFile, JSON.stringify(value), { mode: 0o600 }); fs.chmodSync(vmFile, 0o600) }
  writeVm({ id: 'vm-01', status: 'running', schedulable: true, policy: { inflight: 0 } })
  const db = new DatabaseSync(path.join(root, 'data', 'kin.db'))
  db.exec('CREATE TABLE sticky_sessions(key TEXT PRIMARY KEY,vm_id TEXT,expires_at INTEGER,hits INTEGER NOT NULL DEFAULT 0)')
  db.close()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, vmFile, writeVm }
}

const response = (data, status = 200) => new Response(JSON.stringify({ ok: status < 300, data }), {
  status, headers: { 'content-type': 'application/json' },
})

test('arguments and migration projection accept only bounded safe identifiers', () => {
  assert.deepEqual(parseArgs(['upload', '--vm', 'vm-01', '--migration-id', MIGRATION, '--live-job-id', JOB]),
    { action: 'upload', vmId: 'vm-01', migrationId: MIGRATION, liveJobId: JOB })
  assert.throws(() => parseArgs(['upload', '--vm', '../vm', '--migration-id', MIGRATION, '--live-job-id', JOB]),
    { code: 'control_vm_invalid' })
  assert.deepEqual(projectMigration({ migration_id: MIGRATION, vm_id: 'vm-01', token_hash: 'a'.repeat(64),
    status: 'prepared', token: 'drop', credential: { refresh_token: 'drop' } }),
    { migration_id: MIGRATION, vm_id: 'vm-01', token_hash: 'a'.repeat(64), status: 'prepared' })
})

test('staged drain stops new placement, preserves sticky state and stops only after it expires', async t => {
  const f = fixture(t), db = new DatabaseSync(path.join(f.root, 'data', 'kin.db'))
  const expires = Date.now() + 60000
  db.prepare('INSERT INTO sticky_sessions(key,vm_id,expires_at,hits) VALUES (?,?,?,?)')
    .run('session-one', 'vm-01', expires, 3)
  db.close()
  const calls = [], fetchFn = async (url, init) => {
    calls.push([new URL(url).pathname, init.method, init.body ? JSON.parse(init.body) : null])
    if (url.endsWith('/schedulable')) f.writeVm({ id: 'vm-01', status: 'running', schedulable: false,
      schedule_disabled_reason: 'live_migration', policy: { inflight: 0 } })
    if (url.endsWith('/stop')) f.writeVm({ id: 'vm-01', status: 'stopped', schedulable: false,
      schedule_disabled_reason: 'stopped', policy: { inflight: 0 } })
    return response({})
  }
  const options = { projectRoot: f.root, env: { KIN_API_KEY: 'x'.repeat(64) }, fetchFn }
  const begun = await runControl({ action: 'begin-drain', vmId: 'vm-01' }, options)
  assert.equal(begun.status, 'running')
  assert.equal(begun.schedulable, false)
  assert.equal(begun.disabledReason, 'live_migration')
  assert.equal(begun.sticky, 1)
  assert.equal(begun.stickyHits, 3)
  assert.match(begun.lastStickyExpiresAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(calls.map(value => value[0]), ['/api/panel/vms/vm-01/schedulable'])
  assert.equal((await runControl({ action: 'drain-status', vmId: 'vm-01' }, options)).sticky, 1)
  await assert.rejects(runControl({ action: 'stop-drained', vmId: 'vm-01' }, options),
    { code: 'control_vm_busy' })
  const clear = new DatabaseSync(path.join(f.root, 'data', 'kin.db')); clear.exec('DELETE FROM sticky_sessions'); clear.close()
  const stopped = await runControl({ action: 'stop-drained', vmId: 'vm-01' }, options)
  assert.deepEqual(stopped, { vmId: 'vm-01', status: 'stopped', schedulable: false,
    disabledReason: 'stopped', inflight: 0, sticky: 0, stickyHits: 0,
    firstStickyExpiresAt: null, lastStickyExpiresAt: null })
  assert.deepEqual(calls.map(value => value[0]), ['/api/panel/vms/vm-01/schedulable', '/api/panel/vms/vm-01/stop'])
})

test('zero-session drain remains an atomic convenience and refuses unrelated disables', async t => {
  const f = fixture(t), calls = []
  const options = { projectRoot: f.root, env: { KIN_API_KEY: 'x'.repeat(64) },
    fetchFn: async (url, init) => {
      calls.push(new URL(url).pathname)
      if (url.endsWith('/schedulable')) f.writeVm({ id: 'vm-01', status: 'running', schedulable: false,
        schedule_disabled_reason: 'live_migration', policy: { inflight: 0 } })
      if (url.endsWith('/stop')) f.writeVm({ id: 'vm-01', status: 'stopped', schedulable: false,
        schedule_disabled_reason: 'stopped', policy: { inflight: 0 } })
      return response({})
    } }
  const stopped = await runControl({ action: 'drain', vmId: 'vm-01' }, options)
  assert.equal(stopped.status, 'stopped')
  assert.deepEqual(calls, ['/api/panel/vms/vm-01/schedulable', '/api/panel/vms/vm-01/stop'])
  f.writeVm({ id: 'vm-01', status: 'running', schedulable: false,
    schedule_disabled_reason: 'disabled', policy: { inflight: 0 } })
  await assert.rejects(runControl({ action: 'begin-drain', vmId: 'vm-01' }, options),
    { code: 'control_vm_not_schedulable' })
})

test('prepare upload and finalize call only fixed local panel routes and never expose the API key', async t => {
  const f = fixture(t), calls = [], env = { KIN_API_KEY: 'x'.repeat(64) }
  f.writeVm({ id: 'vm-01', status: 'stopped', schedulable: false, policy: { inflight: 0 } })
  const fetchFn = async (url, init) => {
    calls.push({ path: new URL(url).pathname, authorization: init.headers.authorization, body: init.body })
    if (url.endsWith('/prepare')) return response({ migration_id: MIGRATION, vm_id: 'vm-01',
      token_hash: 'a'.repeat(64), status: 'prepared', token: 'drop' }, 201)
    if (url.endsWith('/upload')) return response({ migration_id: MIGRATION, vm_id: 'vm-01',
      live_job_id: JOB, status: 'uploaded' })
    return response({ migration_id: MIGRATION, vm_id: 'vm-01', live_job_id: JOB,
      status: 'finalized', live_status: 'ready' })
  }
  const prepared = await runControl({ action: 'prepare', vmId: 'vm-01' }, { projectRoot: f.root, fetchFn, env })
  assert.equal(prepared.status, 'prepared'); assert.equal(Object.hasOwn(prepared, 'token'), false)
  assert.equal((await runControl({ action: 'upload', vmId: 'vm-01', migrationId: MIGRATION, liveJobId: JOB },
    { projectRoot: f.root, fetchFn, env })).status, 'uploaded')
  assert.equal((await runControl({ action: 'finalize', vmId: 'vm-01', migrationId: MIGRATION, liveJobId: JOB },
    { projectRoot: f.root, fetchFn, env })).status, 'finalized')
  assert.deepEqual(calls.map(call => call.path), [
    '/api/panel/vms/vm-01/live-migration/prepare',
    '/api/panel/vms/vm-01/live-migration/upload',
    '/api/panel/vms/vm-01/live-migration/finalize',
  ])
  assert.ok(calls.every(call => call.authorization === 'Bearer ' + 'x'.repeat(64)))
  assert.equal(JSON.stringify([prepared, calls.map(call => call.body)]).includes('x'.repeat(64)), false)
})
