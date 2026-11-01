#!/usr/bin/env node
/** Root/container-local account migration control. Never prints API keys or OAuth material. */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const VM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const HASH = /^[a-f0-9]{64}$/
const ACTIONS = new Set(['inspect', 'begin-drain', 'drain-status', 'stop-drained', 'drain',
  'prepare', 'status', 'upload', 'finalize'])
const SAFE_MIGRATION = ['migration_id', 'vm_id', 'status', 'token_hash', 'source_sha256', 'created_at', 'updated_at',
  'expires_at', 'live_job_id', 'upload_sha256', 'stage_sha256', 'stage_bytes', 'live_status', 'finalized_at', 'error_code']

export class MigrationControlError extends Error {
  constructor(code) { super(code); this.code = code }
}
const fail = code => { throw new MigrationControlError(code) }

function privateJSON(file, maximum = 1024 * 1024) {
  const info = fs.lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 2 || info.size > maximum
    || (info.mode & 0o022)) fail('control_file_unsafe')
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { fail('control_file_invalid') }
}

export function projectMigration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('control_response_invalid')
  const out = {}
  for (const key of SAFE_MIGRATION) if (value[key] !== undefined) out[key] = value[key]
  if (out.migration_id !== undefined && !UUID.test(out.migration_id)) fail('control_response_invalid')
  if (out.live_job_id !== undefined && !UUID.test(out.live_job_id)) fail('control_response_invalid')
  if (out.token_hash !== undefined && !HASH.test(out.token_hash)) fail('control_response_invalid')
  return out
}

export function parseArgs(argv) {
  const [action, ...rest] = argv
  if (!ACTIONS.has(action)) fail('control_action_invalid')
  const values = {}
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index], value = rest[index + 1]
    if (!['--vm', '--migration-id', '--live-job-id'].includes(key) || value === undefined || values[key]) {
      fail('control_argument_invalid')
    }
    values[key] = value
  }
  const vmId = values['--vm']
  if (!VM_ID.test(vmId || '')) fail('control_vm_invalid')
  const migrationId = values['--migration-id'], liveJobId = values['--live-job-id']
  if (['upload', 'finalize'].includes(action) && (!UUID.test(migrationId || '') || !UUID.test(liveJobId || ''))) {
    fail('control_migration_id_invalid')
  }
  if (!['upload', 'finalize'].includes(action) && (migrationId !== undefined || liveJobId !== undefined)) {
    fail('control_argument_invalid')
  }
  return { action, vmId, migrationId, liveJobId }
}

function openSticky(projectRoot) {
  const db = new DatabaseSync(path.join(projectRoot, 'data', 'kin.db'), { readOnly: true })
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000')
  return db
}

export function localState(projectRoot, vmId) {
  const vm = privateJSON(path.join(projectRoot, 'vms', vmId + '.json'))
  if (vm.id !== vmId) fail('control_vm_invalid')
  const db = openSticky(projectRoot), now = Date.now()
  let row
  try {
    row = db.prepare('SELECT count(*) AS n,min(expires_at) AS first_exp,max(expires_at) AS last_exp,sum(hits) AS hits FROM sticky_sessions WHERE vm_id=? AND expires_at>?')
      .get(vmId, now)
  } finally { db.close() }
  return { vmId, status: vm.status, schedulable: vm.schedulable !== false,
    disabledReason: vm.schedule_disabled_reason || null, inflight: Number(vm?.policy?.inflight) || 0,
    sticky: Number(row?.n) || 0, stickyHits: Number(row?.hits) || 0,
    firstStickyExpiresAt: Number(row?.first_exp) > now ? new Date(Number(row.first_exp)).toISOString() : null,
    lastStickyExpiresAt: Number(row?.last_exp) > now ? new Date(Number(row.last_exp)).toISOString() : null }
}

async function panel(pathname, { method = 'GET', value, fetchFn = fetch, env = process.env } = {}) {
  const key = String(env.KIN_API_KEY || env.VM2API_API_KEY || '').trim()
  if (key.length < 32 || [...key].some(char => char <= ' ')) fail('control_api_key_unavailable')
  const port = String(env.PORT || '8787')
  const response = await fetchFn(`http://127.0.0.1:${port}${pathname}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(120000),
    headers: { authorization: 'Bearer ' + key, accept: 'application/json',
      ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  })
  if (response.status >= 300 && response.status < 400) fail('control_redirect_refused')
  let body
  try { body = await response.json() } catch { fail('control_response_invalid') }
  if (!response.ok || body?.ok === false) {
    const code = body?.error?.code
    fail(typeof code === 'string' && /^[a-z0-9_]{1,96}$/.test(code) ? code : 'control_request_failed')
  }
  return body?.data ?? body
}

async function wait(ms) { await new Promise(resolve => setTimeout(resolve, ms)) }

export async function runControl(input, { projectRoot = process.env.KIN_PROJECT_ROOT || '/opt/vm2api',
  fetchFn = fetch, env = process.env, sleepFn = wait } = {}) {
  const { action, vmId, migrationId, liveJobId } = Array.isArray(input) ? parseArgs(input) : input
  if (!VM_ID.test(vmId || '') || !ACTIONS.has(action)) fail('control_argument_invalid')
  if (action === 'inspect' || action === 'drain-status') return localState(projectRoot, vmId)
  const beginDrain = async () => {
    let current = localState(projectRoot, vmId)
    if (current.status === 'stopped' && current.schedulable === false) return current
    if (current.schedulable === false && current.disabledReason !== 'live_migration') fail('control_vm_not_schedulable')
    if (current.schedulable) {
      await panel(`/api/panel/vms/${encodeURIComponent(vmId)}/schedulable`, {
        method: 'POST', value: { schedulable: false, reason: 'live_migration' }, fetchFn, env,
      })
      current = localState(projectRoot, vmId)
    }
    if (current.status !== 'running' || current.schedulable || current.disabledReason !== 'live_migration') {
      fail('control_drain_unproven')
    }
    return current
  }
  const stopDrained = async () => {
    let current = localState(projectRoot, vmId)
    if (current.status === 'stopped' && current.schedulable === false) return current
    if (current.schedulable || current.disabledReason !== 'live_migration') fail('control_drain_not_started')
    if (current.sticky || current.inflight) fail('control_vm_busy')
    await panel(`/api/panel/vms/${encodeURIComponent(vmId)}/stop`, { method: 'POST', value: {}, fetchFn, env })
    current = localState(projectRoot, vmId)
    if (current.status !== 'stopped' || current.schedulable || current.sticky || current.inflight) fail('control_stop_unproven')
    return current
  }
  if (action === 'begin-drain') return beginDrain()
  if (action === 'stop-drained') return stopDrained()
  if (action === 'drain') {
    const current = await beginDrain()
    if (current.sticky || current.inflight) fail('control_vm_busy')
    return stopDrained()
  }
  if (action === 'prepare') {
    return projectMigration(await panel(`/api/panel/vms/${encodeURIComponent(vmId)}/live-migration/prepare`, {
      method: 'POST', value: {}, fetchFn, env,
    }))
  }
  if (action === 'status') {
    return projectMigration(await panel(`/api/panel/vms/${encodeURIComponent(vmId)}/live-migration`, { fetchFn, env }))
  }
  if (!UUID.test(migrationId || '') || !UUID.test(liveJobId || '')) fail('control_migration_id_invalid')
  return projectMigration(await panel(`/api/panel/vms/${encodeURIComponent(vmId)}/live-migration/${action}`, {
    method: 'POST', value: { migration_id: migrationId, live_job_id: liveJobId }, fetchFn, env,
  }))
}

async function main() {
  console.log(JSON.stringify(await runControl(process.argv.slice(2))))
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    const code = error instanceof MigrationControlError ? error.code : 'control_failed'
    console.error(JSON.stringify({ ok: false, errorCode: code }))
    process.exitCode = 1
  })
}
