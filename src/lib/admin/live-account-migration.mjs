import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { atomicWriteJson } from '../vm/vm-file.mjs'

export const LIVE_MIGRATION_ORIGIN = 'https://live-api.40.160.7.1.sslip.io'
export const LIVE_MIGRATION_LIMIT = 2 * 1024 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const VM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/
const SHA256 = /^[a-f0-9]{64}$/
const REQUIRED = ['access_token', 'refresh_token', 'id_token', 'expires_at', 'chatgpt_account_id']
const LIVE_JOB_STATES = new Set(['awaiting_upload', 'receiving', 'uploaded', 'committing', 'activating',
  'ready', 'failed', 'expired', 'interrupted'])

export class LiveAccountMigrationError extends Error {
  constructor(code, status = 409) {
    super(code)
    this.name = 'LiveAccountMigrationError'
    this.code = code
    this.status = status
  }
}
const fail = (code, status = 409) => { throw new LiveAccountMigrationError(code, status) }
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const safeText = (value, max = 65536) => typeof value === 'string' && value.length > 0
  && value.length <= max && !/[\x00-\x20\x7f]/.test(value)

function privateDirectory(projectRoot) {
  if (!path.isAbsolute(projectRoot || '')) fail('live_migration_project_invalid', 503)
  const directory = path.join(projectRoot, 'data', 'live-migrations')
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
  const info = fs.lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid()
    || (info.mode & 0o777) !== 0o700) fail('live_migration_state_unsafe', 503)
  return directory
}

function statePath(projectRoot, vmId) {
  if (!VM_ID.test(vmId || '')) fail('vm_not_found', 404)
  return path.join(privateDirectory(projectRoot), vmId + '.json')
}

function publicState(state) {
  return Object.freeze({ migration_id: state.migration_id, vm_id: state.vm_id,
    status: state.status, token_hash: state.token_hash, source_sha256: state.source_sha256,
    created_at: state.created_at, updated_at: state.updated_at, expires_at: state.expires_at,
    ...(state.live_job_id ? { live_job_id: state.live_job_id } : {}),
    ...(state.upload_sha256 ? { upload_sha256: state.upload_sha256 } : {}),
    ...(state.stage_sha256 ? { stage_sha256: state.stage_sha256, stage_bytes: state.stage_bytes } : {}),
    ...(state.live_status ? { live_status: state.live_status } : {}),
    ...(state.finalized_at ? { finalized_at: state.finalized_at } : {}),
    ...(state.terminal_at ? { terminal_at: state.terminal_at } : {}),
    ...(state.error_code ? { error_code: state.error_code } : {}) })
}

function readState(projectRoot, vmId) {
  const file = statePath(projectRoot, vmId)
  let info
  try { info = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.geteuid()
    || (info.mode & 0o777) !== 0o600 || info.size < 2 || info.size > 64 * 1024) {
    fail('live_migration_state_unsafe', 503)
  }
  let value
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { fail('live_migration_state_invalid', 503) }
  const sealed = value?.status === 'finalized'
    || value?.status === 'failed' && typeof value.terminal_at === 'string'
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || value.vm_id !== vmId || !UUID.test(value.migration_id || '') || !SHA256.test(value.token_hash || '')
    || sealed && value.token !== undefined || !sealed && !safeText(value.token, 128)
    || !SHA256.test(value.source_sha256 || '')) fail('live_migration_state_invalid', 503)
  return value
}

function writeState(projectRoot, vmId, value) {
  const file = statePath(projectRoot, vmId)
  atomicWriteJson(file, value, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  const fd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY)
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  return value
}

function credentialEnvelope(accounts) {
  if (!Array.isArray(accounts) || accounts.length !== 1) fail('live_migration_account_count_invalid')
  const account = accounts[0]
  if (!account || typeof account !== 'object' || Array.isArray(account)) fail('live_migration_credential_invalid')
  for (const field of REQUIRED) {
    const value = account[field]
    if (field === 'expires_at') {
      if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)
        && !(typeof value === 'string' && value.length > 0 && value.length <= 128
          && !/[\x00-\x1f\x7f]/.test(value) && (Number.isFinite(Date.parse(value)) || /^[0-9]+(?:\.[0-9]+)?$/.test(value)))) {
        fail('live_migration_credential_invalid')
      }
    } else if (!safeText(value)) fail('live_migration_credential_invalid')
  }
  const bytes = Buffer.from(JSON.stringify({ accounts: [account] }))
  if (bytes.length > LIVE_MIGRATION_LIMIT) fail('live_migration_credential_too_large', 413)
  return { bytes, sha256: digest(bytes) }
}

function countInflight(poolScheduler, vmId) {
  return Number(poolScheduler?.vmInflight?.get?.(vmId)) || 0
}

function preflight({ vmId, getVm, readAccounts, stickyRouter, poolScheduler }) {
  const vm = getVm(vmId)
  if (!vm || vm.id !== vmId) fail('vm_not_found', 404)
  if (vm.status !== 'stopped' || vm.schedulable !== false) fail('live_migration_vm_not_stopped')
  const inflight = countInflight(poolScheduler, vmId)
  if (inflight !== 0 || Number(vm?.policy?.inflight) > 0) fail('live_migration_vm_busy')
  const sticky = stickyRouter?.boundKeys?.({ vmId }) || []
  if (!Array.isArray(sticky) || sticky.length !== 0) fail('live_migration_sticky_sessions_present')
  const envelope = credentialEnvelope(readAccounts(vmId))
  return { vm, envelope }
}

async function readResponse(response, limit = 64 * 1024) {
  const length = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(length) && length > limit) fail('live_migration_response_too_large', 502)
  const reader = response.body?.getReader?.()
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > limit) fail('live_migration_response_too_large', 502)
    return bytes
  }
  const chunks = []; let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) { await reader.cancel().catch(() => {}); fail('live_migration_response_too_large', 502) }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

export function createLiveAccountMigration({ projectRoot, getVm, readAccounts, stickyRouter, poolScheduler,
  fetchFn = fetch, clock = () => Date.now(), randomToken = () => crypto.randomBytes(32).toString('base64url'),
  ttlMs = 15 * 60 * 1000 } = {}) {
  if (typeof getVm !== 'function' || typeof readAccounts !== 'function' || typeof fetchFn !== 'function'
    || typeof clock !== 'function' || typeof randomToken !== 'function' || !Number.isSafeInteger(ttlMs)
    || ttlMs < 60000 || ttlMs > 60 * 60 * 1000) throw new Error('invalid live account migration configuration')
  privateDirectory(projectRoot)

  function prepare(vmId) {
    const current = readState(projectRoot, vmId)
    if (current && !['failed', 'finalized', 'cancelled'].includes(current.status)) fail('live_migration_conflict')
    const { envelope } = preflight({ vmId, getVm, readAccounts, stickyRouter, poolScheduler })
    const token = randomToken()
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail('live_migration_token_invalid', 503)
    const now = clock(), state = { version: 1, migration_id: crypto.randomUUID(), vm_id: vmId,
      token, token_hash: digest(token), source_sha256: envelope.sha256, status: 'prepared',
      created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttlMs).toISOString(), error_code: null }
    writeState(projectRoot, vmId, state)
    return publicState(state)
  }

  function status(vmId) {
    const state = readState(projectRoot, vmId)
    if (!state) fail('live_migration_not_found', 404)
    if (state.status === 'prepared' && Date.parse(state.expires_at) <= clock()) {
      state.status = 'expired'; state.error_code = 'live_migration_expired'; state.updated_at = new Date(clock()).toISOString()
      writeState(projectRoot, vmId, state)
    }
    return publicState(state)
  }

  async function upload(vmId, input, { signal } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== 'live_job_id,migration_id'
      || !UUID.test(input.migration_id || '') || !UUID.test(input.live_job_id || '')) fail('live_migration_invalid_request', 400)
    const state = readState(projectRoot, vmId)
    if (!state || state.migration_id !== input.migration_id) fail('live_migration_not_found', 404)
    if (state.status !== 'prepared') fail('live_migration_replayed')
    if (Date.parse(state.expires_at) <= clock()) {
      state.status = 'expired'; state.error_code = 'live_migration_expired'; state.updated_at = new Date(clock()).toISOString()
      writeState(projectRoot, vmId, state); fail('live_migration_expired', 410)
    }
    const { envelope } = preflight({ vmId, getVm, readAccounts, stickyRouter, poolScheduler })
    if (envelope.sha256 !== state.source_sha256) fail('live_migration_source_changed')
    state.status = 'uploading'; state.live_job_id = input.live_job_id; state.updated_at = new Date(clock()).toISOString()
    writeState(projectRoot, vmId, state)
    const url = LIVE_MIGRATION_ORIGIN + '/api/account-migrations/' + input.live_job_id + '/credential'
    try {
      const timeout = AbortSignal.timeout(30000)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
      const response = await fetchFn(url, { method: 'POST', redirect: 'manual', signal: combined,
        headers: { authorization: 'Bearer ' + state.token, 'content-type': 'application/json', accept: 'application/json' },
        body: envelope.bytes })
      if (response.status >= 300 && response.status < 400) fail('live_migration_redirect_refused', 502)
      const contentType = String(response.headers.get('content-type') || '')
      const raw = await readResponse(response)
      let value
      try { value = JSON.parse(raw) } catch { fail('live_migration_response_invalid', 502) }
      const data = value?.data
      if (response.status !== 201 || !/^application\/json(?:;|$)/i.test(contentType) || value?.ok !== true
        || data?.jobId !== input.live_job_id || data?.slotId == null || data?.sourceId !== vmId
        || data?.status !== 'uploaded' || data?.uploadSha256 !== envelope.sha256
        || !SHA256.test(data?.stageSha256 || '') || !Number.isSafeInteger(data?.stageBytes) || data.stageBytes < 2) {
        fail('live_migration_response_invalid', 502)
      }
      state.status = 'uploaded'; state.upload_sha256 = data.uploadSha256; state.stage_sha256 = data.stageSha256
      state.stage_bytes = data.stageBytes; state.live_status = data.status; state.updated_at = new Date(clock()).toISOString()
      state.error_code = null; writeState(projectRoot, vmId, state)
      return publicState(state)
    } catch (error) {
      state.status = 'upload_outcome_unknown'; state.error_code = error?.code || 'live_migration_upload_failed'
      state.updated_at = new Date(clock()).toISOString(); writeState(projectRoot, vmId, state)
      throw error instanceof LiveAccountMigrationError ? error : new LiveAccountMigrationError('live_migration_upload_failed', 502)
    }
  }

  async function finalize(vmId, input, { signal } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== 'live_job_id,migration_id'
      || !UUID.test(input.migration_id || '') || !UUID.test(input.live_job_id || '')) fail('live_migration_invalid_request', 400)
    const state = readState(projectRoot, vmId)
    if (!state || state.migration_id !== input.migration_id || state.live_job_id !== input.live_job_id) {
      fail('live_migration_not_found', 404)
    }
    if (state.status === 'finalized') return publicState(state)
    if (state.status !== 'uploaded') fail('live_migration_conflict')
    const { envelope } = preflight({ vmId, getVm, readAccounts, stickyRouter, poolScheduler })
    if (envelope.sha256 !== state.source_sha256 || state.upload_sha256 !== state.source_sha256) {
      fail('live_migration_source_changed')
    }
    const url = LIVE_MIGRATION_ORIGIN + '/api/account-migrations/' + state.live_job_id + '/status'
    try {
      const timeout = AbortSignal.timeout(30000)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
      const response = await fetchFn(url, { method: 'GET', redirect: 'manual', signal: combined,
        headers: { authorization: 'Bearer ' + state.token, accept: 'application/json' } })
      if (response.status >= 300 && response.status < 400) fail('live_migration_redirect_refused', 502)
      const contentType = String(response.headers.get('content-type') || '')
      const raw = await readResponse(response)
      let value
      try { value = JSON.parse(raw) } catch { fail('live_migration_response_invalid', 502) }
      const data = value?.data
      if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(contentType) || value?.ok !== true
        || data?.jobId !== state.live_job_id || data?.sourceId !== vmId || !LIVE_JOB_STATES.has(data?.status)
        || data?.uploadSha256 !== state.upload_sha256 || data?.stageSha256 !== state.stage_sha256
        || data?.stageBytes !== state.stage_bytes) fail('live_migration_response_invalid', 502)
      state.live_status = data.status; state.updated_at = new Date(clock()).toISOString()
      if (data.status === 'failed') {
        state.status = 'failed'
        state.error_code = typeof data.errorCode === 'string' && /^[a-z0-9_]{1,96}$/.test(data.errorCode)
          ? data.errorCode : 'live_migration_live_failed'
        state.terminal_at = state.updated_at
        delete state.token
        writeState(projectRoot, vmId, state)
        return publicState(state)
      }
      if (data.status !== 'ready') {
        state.error_code = 'live_migration_not_ready'
        writeState(projectRoot, vmId, state)
        fail('live_migration_not_ready')
      }
      state.status = 'finalized'; state.finalized_at = new Date(clock()).toISOString(); state.error_code = null
      delete state.token
      writeState(projectRoot, vmId, state)
      return publicState(state)
    } catch (error) {
      if (error instanceof LiveAccountMigrationError) throw error
      throw new LiveAccountMigrationError('live_migration_status_failed', 502)
    }
  }

  async function reconcileUploaded({ signal } = {}) {
    const directory = privateDirectory(projectRoot)
    const names = fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json') && VM_ID.test(entry.name.slice(0, -5)))
      .map(entry => entry.name.slice(0, -5)).sort()
    if (names.length > 1000) fail('live_migration_state_unsafe', 503)
    const result = { scanned: names.length, uploaded: 0, finalized: 0, pending: 0, failed: 0, items: [] }
    for (const vmId of names) {
      if (signal?.aborted) fail('live_migration_cancelled', 499)
      let state
      try { state = readState(projectRoot, vmId) }
      catch (error) {
        result.failed++
        result.items.push({ vm_id: vmId, status: 'failed', error_code: error?.code || 'live_migration_state_invalid' })
        continue
      }
      if (state.status !== 'uploaded') continue
      result.uploaded++
      try {
        const value = await finalize(vmId, { migration_id: state.migration_id, live_job_id: state.live_job_id }, { signal })
        if (value.status === 'finalized') result.finalized++
        else if (value.status === 'failed') result.failed++
        result.items.push({ vm_id: vmId, status: value.status, live_status: value.live_status,
          ...(value.error_code ? { error_code: value.error_code } : {}) })
      } catch (error) {
        const code = error instanceof LiveAccountMigrationError ? error.code : 'live_migration_status_failed'
        if (code === 'live_migration_not_ready') result.pending++
        else result.failed++
        result.items.push({ vm_id: vmId, status: 'uploaded', error_code: code })
      }
    }
    return result
  }

  return Object.freeze({ prepare, status, upload, finalize, reconcileUploaded })
}
