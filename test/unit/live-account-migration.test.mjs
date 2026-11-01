import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  createLiveAccountMigration,
  LIVE_MIGRATION_ORIGIN,
} from '../../src/lib/admin/live-account-migration.mjs'

const TOKEN = 'T'.repeat(43)
const JOB = 'b0d9a6b3-5110-40b3-9f69-82d13298a765'
const sha = value => createHash('sha256').update(value).digest('hex')
const account = (id = 'account-one') => ({
  id,
  access_token: 'access-' + id,
  refresh_token: 'refresh-' + id,
  id_token: 'header.payload.signature',
  expires_at: 1893456000,
  chatgpt_account_id: id,
  email: id + '@private.test',
  chatgpt_plan_type: 'pro',
})

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-live-migration-'))
  fs.mkdirSync(path.join(root, 'data'), { mode: 0o700 })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = { id: 'vm-02', status: 'stopped', schedulable: false,
    schedule_disabled_reason: 'stopped', policy: { inflight: 0 }, ...(options.vm || {}) }
  let accounts = options.accounts || [account()]
  const sticky = options.sticky || []
  const poolScheduler = { vmInflight: new Map(options.inflight ? [[vm.id, options.inflight]] : []) }
  let now = 1800000000000, liveStatus = options.liveStatus || 'ready', uploadedReceipt
  const requests = []
  const fetchFn = options.fetchFn || (async (url, init) => {
    requests.push({ url, init })
    if (init.method === 'GET') {
      const body = { ok: true, data: { jobId: JOB, slotId: 'codex-account-01', sourceId: vm.id,
        status: liveStatus, uploadSha256: uploadedReceipt.uploadSha256,
        stageSha256: uploadedReceipt.stageSha256, stageBytes: uploadedReceipt.stageBytes,
        ...(liveStatus === 'failed' ? { errorCode: 'activation_model_failed' } : {}) } }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const input = Buffer.from(init.body)
    uploadedReceipt = { uploadSha256: sha(input), stageSha256: 'a'.repeat(64), stageBytes: 777 }
    const body = { ok: true, data: { jobId: JOB, slotId: 'codex-account-01', sourceId: vm.id,
      status: 'uploaded', ...uploadedReceipt } }
    return new Response(JSON.stringify(body), { status: 201, headers: { 'content-type': 'application/json' } })
  })
  const manager = createLiveAccountMigration({ projectRoot: root,
    getVm: id => id === vm.id ? structuredClone(vm) : null,
    readAccounts: id => id === vm.id ? structuredClone(accounts) : [],
    stickyRouter: { boundKeys: ({ vmId }) => vmId === vm.id ? structuredClone(sticky) : [] },
    poolScheduler, fetchFn, clock: () => now, randomToken: () => TOKEN })
  return { root, vm, manager, requests, poolScheduler,
    setAccounts(value) { accounts = value }, setLiveStatus(value) { liveStatus = value }, advance(ms) { now += ms } }
}

test('prepare writes a private one-time token but returns only its hash and safe metadata', t => {
  const f = fixture(t), result = f.manager.prepare('vm-02')
  assert.equal(result.status, 'prepared')
  assert.equal(result.token_hash, sha(TOKEN))
  assert.equal(JSON.stringify(result).includes(TOKEN), false)
  assert.equal(JSON.stringify(result).includes('access-account-one'), false)
  const file = path.join(f.root, 'data/live-migrations/vm-02.json')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const state = JSON.parse(fs.readFileSync(file))
  assert.equal(state.token, TOKEN)
  assert.equal(state.token_hash, sha(TOKEN))
  assert.match(state.source_sha256, /^[a-f0-9]{64}$/)
  assert.throws(() => f.manager.prepare('vm-02'), { code: 'live_migration_conflict' })
})

test('prepare requires stopped, unschedulable, idle, unpinned and exactly one complete account', t => {
  const cases = [
    [{ vm: { status: 'running' } }, 'live_migration_vm_not_stopped'],
    [{ vm: { schedulable: true } }, 'live_migration_vm_not_stopped'],
    [{ vm: { policy: { inflight: 1 } } }, 'live_migration_vm_busy'],
    [{ inflight: 1 }, 'live_migration_vm_busy'],
    [{ sticky: [{ key: 'private', vmId: 'vm-02' }] }, 'live_migration_sticky_sessions_present'],
    [{ accounts: [] }, 'live_migration_account_count_invalid'],
    [{ accounts: [account('one'), account('two')] }, 'live_migration_account_count_invalid'],
    [{ accounts: [{ ...account(), refresh_token: '' }] }, 'live_migration_credential_invalid'],
  ]
  for (const [options, code] of cases) {
    const f = fixture(t, options)
    assert.throws(() => f.manager.prepare('vm-02'), { code })
    assert.equal(fs.existsSync(path.join(f.root, 'data/live-migrations/vm-02.json')), false)
  }
})

test('upload is fixed-origin, no-redirect, exact-hash and one-shot', async t => {
  const f = fixture(t), prepared = f.manager.prepare('vm-02')
  const result = await f.manager.upload('vm-02', { migration_id: prepared.migration_id, live_job_id: JOB })
  assert.equal(result.status, 'uploaded')
  assert.equal(result.live_job_id, JOB)
  assert.equal(f.requests.length, 1)
  const [{ url, init }] = f.requests
  assert.equal(url, LIVE_MIGRATION_ORIGIN + '/api/account-migrations/' + JOB + '/credential')
  assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual')
  assert.equal(init.headers.authorization, 'Bearer ' + TOKEN)
  assert.equal(init.headers['content-type'], 'application/json')
  const document = JSON.parse(Buffer.from(init.body))
  assert.deepEqual(Object.keys(document), ['accounts'])
  assert.equal(document.accounts.length, 1)
  assert.equal(document.accounts[0].chatgpt_account_id, 'account-one')
  assert.equal(result.upload_sha256, sha(Buffer.from(init.body)))
  assert.equal(JSON.stringify(result).includes(TOKEN), false)
  await assert.rejects(f.manager.upload('vm-02', { migration_id: prepared.migration_id, live_job_id: JOB }),
    { code: 'live_migration_replayed' })
})

test('finalize verifies Live readiness, removes the one-time token and is idempotent', async t => {
  const f = fixture(t), prepared = f.manager.prepare('vm-02')
  const uploaded = await f.manager.upload('vm-02', { migration_id: prepared.migration_id, live_job_id: JOB })
  const finalized = await f.manager.finalize('vm-02', { migration_id: prepared.migration_id, live_job_id: JOB })
  assert.equal(finalized.status, 'finalized')
  assert.equal(finalized.live_status, 'ready')
  assert.match(finalized.finalized_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[1].url, LIVE_MIGRATION_ORIGIN + '/api/account-migrations/' + JOB + '/status')
  assert.equal(f.requests[1].init.method, 'GET')
  assert.equal(f.requests[1].init.redirect, 'manual')
  assert.equal(f.requests[1].init.headers.authorization, 'Bearer ' + TOKEN)
  const state = JSON.parse(fs.readFileSync(path.join(f.root, 'data/live-migrations/vm-02.json')))
  assert.equal(Object.hasOwn(state, 'token'), false)
  assert.equal(state.token_hash, sha(TOKEN))
  assert.equal((await f.manager.finalize('vm-02', { migration_id: prepared.migration_id, live_job_id: JOB })).status, 'finalized')
  assert.equal(f.requests.length, 2, 'idempotent finalization never calls Live again')
  assert.equal(uploaded.upload_sha256, finalized.upload_sha256)
})

test('finalize keeps a stopped source recoverable until Live reports ready', async t => {
  const f = fixture(t, { liveStatus: 'activating' }), prepared = f.manager.prepare('vm-02')
  await f.manager.upload('vm-02', { migration_id: prepared.migration_id, live_job_id: JOB })
  await assert.rejects(f.manager.finalize('vm-02', { migration_id: prepared.migration_id, live_job_id: JOB }),
    { code: 'live_migration_not_ready' })
  const pending = f.manager.status('vm-02')
  assert.equal(pending.status, 'uploaded')
  assert.equal(pending.live_status, 'activating')
  assert.equal(pending.error_code, 'live_migration_not_ready')
  assert.equal(typeof JSON.parse(fs.readFileSync(path.join(f.root, 'data/live-migrations/vm-02.json'))).token, 'string')
  f.setLiveStatus('ready')
  assert.equal((await f.manager.finalize('vm-02', { migration_id: prepared.migration_id, live_job_id: JOB })).status, 'finalized')
})

test('source mutation, redirect and invalid Live receipt fail closed without a replay path', async t => {
  const changed = fixture(t), prepared = changed.manager.prepare('vm-02')
  changed.setAccounts([account('other')])
  await assert.rejects(changed.manager.upload('vm-02', { migration_id: prepared.migration_id, live_job_id: JOB }),
    { code: 'live_migration_source_changed' })
  assert.equal(changed.requests.length, 0)

  const redirected = fixture(t, { fetchFn: async () => new Response('', {
    status: 307, headers: { location: 'https://attacker.invalid/credential', 'content-type': 'application/json' } }) })
  const redirectJob = redirected.manager.prepare('vm-02')
  await assert.rejects(redirected.manager.upload('vm-02', {
    migration_id: redirectJob.migration_id, live_job_id: JOB }), { code: 'live_migration_redirect_refused' })
  assert.equal(redirected.manager.status('vm-02').status, 'upload_outcome_unknown')

  const wrong = fixture(t, { fetchFn: async () => new Response(JSON.stringify({ ok: true, data: {
    jobId: JOB, slotId: 'codex-account-01', sourceId: 'vm-02', status: 'uploaded',
    uploadSha256: 'b'.repeat(64), stageSha256: 'a'.repeat(64), stageBytes: 777 } }),
  { status: 201, headers: { 'content-type': 'application/json' } }) })
  const wrongJob = wrong.manager.prepare('vm-02')
  await assert.rejects(wrong.manager.upload('vm-02', {
    migration_id: wrongJob.migration_id, live_job_id: JOB }), { code: 'live_migration_response_invalid' })
  assert.equal(wrong.manager.status('vm-02').status, 'upload_outcome_unknown')
})

test('expired jobs and malformed upload requests never contact Live', async t => {
  const f = fixture(t), prepared = f.manager.prepare('vm-02')
  f.advance(16 * 60 * 1000)
  await assert.rejects(f.manager.upload('vm-02', { migration_id: prepared.migration_id, live_job_id: JOB }),
    { code: 'live_migration_expired' })
  assert.equal(f.requests.length, 0)
  assert.equal(f.manager.status('vm-02').status, 'expired')

  const malformed = fixture(t), job = malformed.manager.prepare('vm-02')
  await assert.rejects(malformed.manager.upload('vm-02', { migration_id: job.migration_id,
    live_job_id: JOB, url: 'https://attacker.invalid' }), { code: 'live_migration_invalid_request' })
  assert.equal(malformed.requests.length, 0)
})
