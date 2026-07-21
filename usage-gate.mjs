/**
 * Free-tier usage gate for Tor MCP network tools.
 * Billable (on success): tor_fetch, tor_post, tor_research, tor_geo_compare.
 * Always free: tor_status, tor_unlock, tor_add_call_permit, tor_restart, tor_new_circuit,
 * tor_set_exit_country (circuit rotates should not burn the trial).
 *
 * After the free trial: either SKU_TOR_MCP_PRO unlock (unlimited) OR per-call permits
 * from GET /x402/v1/tor-call → result.torCallPermit.token (SKU_AG_TOR_CALL_01).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import fetch from 'node-fetch'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOR_DATA = resolve(HERE, 'tor-data')
const USAGE_PATH = resolve(TOR_DATA, 'usage-gate.json')
const UNLOCK_PATH = resolve(TOR_DATA, 'unlock.key')
const UNLOCK_META_PATH = resolve(TOR_DATA, 'unlock.meta.json')
const CALL_PERMITS_PATH = resolve(TOR_DATA, 'call-permits.json')
const ANON_ID_PATH = resolve(TOR_DATA, 'anon-id')
const TELEMETRY_META_PATH = resolve(TOR_DATA, 'telemetry.json')

export const FREE_LIMIT = Math.max(1, parseInt(process.env.TOR_MCP_FREE_USES || '25', 10))
const VERIFY_URL = (process.env.TOR_MCP_VERIFY_URL || 'https://aizamon.com/api/tor-mcp/verify').replace(/\/$/, '')
const EVENTS_URL = (process.env.TOR_MCP_EVENTS_URL || 'https://aizamon.com/api/tor-mcp/events').replace(/\/$/, '')
const UNLOCK_URL = process.env.TOR_MCP_UNLOCK_URL || 'https://aizamon.com/client?sku=SKU_TOR_MCP_PRO'
const CALL_PERMIT_REDEEM_URL = (
  process.env.TOR_MCP_CALL_PERMIT_URL || 'https://aizamon.com/api/v1/tor-call-permit'
).replace(/\/$/, '')
const CALL_BUY_URL = process.env.TOR_MCP_CALL_BUY_URL || 'https://aizamon.com/x402/v1/tor-call'
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000
const TELEMETRY_MIN_INTERVAL_MS = 60 * 60 * 1000

function packageVersion() {
  try {
    return JSON.parse(readFileSync(resolve(HERE, 'package.json'), 'utf8')).version || 'unknown'
  } catch {
    return 'unknown'
  }
}

function telemetryEnabled() {
  const v = String(process.env.TOR_MCP_TELEMETRY ?? '1').trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off')
}

function getOrCreateAnonId() {
  ensureDataDir()
  if (existsSync(ANON_ID_PATH)) {
    try {
      const existing = readFileSync(ANON_ID_PATH, 'utf8').trim()
      if (existing) return existing
    } catch { /* recreate below */ }
  }
  const id = randomUUID()
  try {
    writeFileSync(ANON_ID_PATH, id, { mode: 0o600 })
  } catch { /* ignore */ }
  return id
}

function loadTelemetryMeta() {
  if (!existsSync(TELEMETRY_META_PATH)) return {}
  try {
    return JSON.parse(readFileSync(TELEMETRY_META_PATH, 'utf8')) || {}
  } catch {
    return {}
  }
}

function saveTelemetryMeta(meta) {
  ensureDataDir()
  writeFileSync(TELEMETRY_META_PATH, JSON.stringify(meta, null, 2), { mode: 0o600 })
}

/**
 * Anonymous trial heartbeat (no unlock key, no paths).
 * Throttled to once/hour unless force=true (boot).
 */
export async function sendTrialHeartbeat({ force = false } = {}) {
  if (!telemetryEnabled()) return { ok: false, skipped: 'opt_out' }
  const meta = loadTelemetryMeta()
  const last = Number(meta.lastHeartbeatAt) || 0
  if (!force && Date.now() - last < TELEMETRY_MIN_INTERVAL_MS) {
    return { ok: false, skipped: 'throttled' }
  }
  const quota = getQuotaStatus()
  const body = {
    event: 'heartbeat',
    anonId: getOrCreateAnonId(),
    uses: quota.used,
    freeLimit: quota.freeLimit,
    unlocked: Boolean(quota.unlocked),
    version: packageVersion(),
  }
  try {
    const resp = await fetch(EVENTS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    })
    saveTelemetryMeta({ ...meta, lastHeartbeatAt: Date.now() })
    return { ok: resp.ok, status: resp.status }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
}

let unlockVerified = false
let unlockOfflineGrace = false
let initDone = false
let gateChain = Promise.resolve()
/** Set when a call permit was redeemed for the in-flight billable op. */
let permitAuthorizedForNextCommit = false

function ensureDataDir() {
  if (!existsSync(TOR_DATA)) mkdirSync(TOR_DATA, { recursive: true })
}

function withGateLock(fn) {
  const run = gateChain.then(fn, fn)
  gateChain = run.catch(() => {})
  return run
}

function loadState() {
  ensureDataDir()
  if (!existsSync(USAGE_PATH)) return { uses: 0 }
  try {
    const raw = JSON.parse(readFileSync(USAGE_PATH, 'utf8'))
    return { uses: Math.max(0, Number(raw.uses) || 0) }
  } catch {
    return { uses: 0 }
  }
}

function saveState(state) {
  ensureDataDir()
  writeFileSync(
    USAGE_PATH,
    JSON.stringify({ uses: state.uses, updatedAt: new Date().toISOString() }, null, 2),
  )
}

function readLocalUnlockKey() {
  if (existsSync(UNLOCK_PATH)) {
    try {
      return readFileSync(UNLOCK_PATH, 'utf8').trim() || null
    } catch {
      return null
    }
  }
  const envKey = String(process.env.TOR_MCP_UNLOCK_KEY || '').trim()
  return envKey || null
}

function loadUnlockMeta() {
  if (!existsSync(UNLOCK_META_PATH)) return null
  try {
    return JSON.parse(readFileSync(UNLOCK_META_PATH, 'utf8'))
  } catch {
    return null
  }
}

function saveUnlockMeta(meta) {
  ensureDataDir()
  writeFileSync(UNLOCK_META_PATH, JSON.stringify(meta, null, 2), { mode: 0o600 })
}

function clearUnlock() {
  try {
    if (existsSync(UNLOCK_PATH)) unlinkSync(UNLOCK_PATH)
    if (existsSync(UNLOCK_META_PATH)) unlinkSync(UNLOCK_META_PATH)
  } catch { /* ignore */ }
  unlockVerified = false
  unlockOfflineGrace = false
}

function isOperator() {
  const v = String(process.env.TOR_MCP_OPERATOR || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'operator'
}

function loadCallPermits() {
  ensureDataDir()
  const tokens = []
  const envRaw = String(process.env.TOR_MCP_CALL_TOKEN || process.env.TOR_MCP_CALL_TOKENS || '').trim()
  if (envRaw) {
    for (const part of envRaw.split(/[\s,;]+/)) {
      const t = part.trim()
      if (t) tokens.push(t)
    }
  }
  if (existsSync(CALL_PERMITS_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CALL_PERMITS_PATH, 'utf8'))
      const list = Array.isArray(raw.tokens) ? raw.tokens : []
      for (const t of list) {
        const s = String(t || '').trim()
        if (s && !tokens.includes(s)) tokens.push(s)
      }
    } catch { /* ignore */ }
  }
  return tokens
}

function saveCallPermits(tokens) {
  ensureDataDir()
  writeFileSync(
    CALL_PERMITS_PATH,
    JSON.stringify({ tokens: tokens.slice(), updatedAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  )
}

/** Queue a purchased call-permit token (from /x402/v1/tor-call fulfill). */
export function addCallPermit(token) {
  const trimmed = String(token || '').trim()
  if (!trimmed || trimmed.length < 8) {
    return { ok: false, error: 'missing_token', message: 'Provide result.torCallPermit.token from SKU_AG_TOR_CALL_01.' }
  }
  const tokens = loadCallPermits().filter((t) => t !== trimmed)
  tokens.push(trimmed)
  saveCallPermits(tokens)
  return {
    ok: true,
    queued: tokens.length,
    buyMore: CALL_BUY_URL,
    note: 'Next billable tool after free trial will redeem one permit via aizamon.com.',
  }
}

async function redeemCallPermitRemote(token) {
  const url = `${CALL_PERMIT_REDEEM_URL}?token=${encodeURIComponent(token)}`
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'x-aizamon-tor-call-token': token, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  const data = await resp.json().catch(() => ({}))
  return {
    ok: Boolean(resp.ok && data.ok && data.authorized),
    error: data.error || (resp.ok ? null : `http_${resp.status}`),
    callsRemaining: data.callsRemaining,
    permitId: data.permitId || null,
  }
}

/**
 * Redeem one queued call permit against Aizamon.
 * Returns { ok:true } on success; removes dead tokens from the queue.
 */
export async function tryRedeemCallPermit() {
  return withGateLock(async () => {
    let tokens = loadCallPermits()
    while (tokens.length) {
      const token = tokens[0]
      tokens = tokens.slice(1)
      try {
        const result = await redeemCallPermitRemote(token)
        if (result.ok) {
          saveCallPermits(tokens)
          return {
            ok: true,
            permitId: result.permitId,
            callsRemainingOnPermit: result.callsRemaining,
            queuedRemaining: tokens.length,
          }
        }
      } catch (err) {
        tokens = [token, ...tokens]
        saveCallPermits(tokens)
        return {
          ok: false,
          error: 'redeem_unreachable',
          message: err.message || String(err),
          queued: tokens.length,
        }
      }
      saveCallPermits(tokens)
    }
    return { ok: false, error: 'no_call_permits', queued: 0 }
  })
}

async function verifyKeyRemote(key) {
  const resp = await fetch(VERIFY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
    signal: AbortSignal.timeout(15_000),
  })
  const data = await resp.json().catch(() => ({}))
  return {
    ok: Boolean(resp.ok && data.ok),
    error: data.error || (resp.ok ? null : 'verify_failed'),
    message: data.message || data.hint || null,
  }
}

/** Verify stored key on MCP startup — required before unlock is honored. */
export async function initUsageGate() {
  if (initDone) return { ok: true }
  initDone = true

  if (isOperator()) {
    unlockVerified = true
    return { ok: true, mode: 'operator' }
  }

  const key = readLocalUnlockKey()
  if (!key) {
    unlockVerified = false
    return { ok: true, mode: 'trial' }
  }

  try {
    const result = await verifyKeyRemote(key)
    if (result.ok) {
      saveUnlockKey(key)
      saveUnlockMeta({ verifiedAt: Date.now() })
      unlockVerified = true
      unlockOfflineGrace = false
      return { ok: true, mode: 'unlocked' }
    }
    clearUnlock()
    return { ok: true, mode: 'trial', note: 'stored_key_invalid' }
  } catch {
    const meta = loadUnlockMeta()
    if (meta?.verifiedAt && Date.now() - meta.verifiedAt < OFFLINE_GRACE_MS) {
      unlockVerified = true
      unlockOfflineGrace = true
      return { ok: true, mode: 'unlocked_offline_grace' }
    }
    return {
      ok: false,
      mode: 'verify_unreachable',
      message: 'Could not verify unlock key online. Connect to the internet and reload Cursor.',
    }
  }
}

export function isUnlocked() {
  if (isOperator()) return true
  return unlockVerified
}

export function getQuotaStatus() {
  const state = loadState()
  const unlocked = isUnlocked()
  const used = state.uses
  const limit = FREE_LIMIT
  const callPermitsQueued = loadCallPermits().length
  const quota = {
    unlocked,
    freeLimit: limit,
    used,
    remaining: unlocked ? null : Math.max(0, limit - used),
    callPermitsQueued,
    billableTools: ['tor_fetch', 'tor_post', 'tor_research', 'tor_geo_compare'],
    unlockUrl: UNLOCK_URL,
    callBuyUrl: CALL_BUY_URL,
  }
  if (unlocked && unlockOfflineGrace) {
    quota.offlineGrace = true
  }
  if (isOperator()) {
    quota.operator = true
  }
  return quota
}

function exhaustedPayload(toolName, redeemFail) {
  const quota = getQuotaStatus()
  const hasQueued = quota.callPermitsQueued > 0
  return {
    allowed: false,
    blocked: true,
    error: 'trial_exhausted',
    tool: toolName,
    message:
      `Free trial exhausted (${FREE_LIMIT}/${FREE_LIMIT} successful uses). ` +
      (hasQueued
        ? 'Queued call permit(s) failed to redeem — buy a fresh $0.05 permit or unlock Pro.'
        : `Buy one call ($0.05) at ${CALL_BUY_URL} or unlimited Pro at ${UNLOCK_URL}`),
    quota,
    redeemError: redeemFail?.error || null,
    hint:
      'Per-call: GET /x402/v1/tor-call → pay → set TOR_MCP_CALL_TOKEN=<result.torCallPermit.token> or run tor_add_call_permit. ' +
      'Unlimited: buy SKU_TOR_MCP_PRO then run tor_unlock.',
    buyCall: CALL_BUY_URL,
    buyPro: UNLOCK_URL,
  }
}

/** Check trial / permit without consuming a use (permit redeem happens here when trial is done). */
export async function gateBillableCheck(toolName) {
  permitAuthorizedForNextCommit = false

  if (isUnlocked()) {
    return { allowed: true, quota: getQuotaStatus() }
  }

  const state = loadState()
  if (state.uses >= FREE_LIMIT) {
    const redeemed = await tryRedeemCallPermit()
    if (redeemed.ok) {
      permitAuthorizedForNextCommit = true
      return {
        allowed: true,
        permitCall: true,
        quota: getQuotaStatus(),
        permit: redeemed,
        trialWarning: 'Paid call permit redeemed for this request ($0.05). Queue more via tor_add_call_permit.',
      }
    }
    return exhaustedPayload(toolName, redeemed)
  }

  const remaining = FREE_LIMIT - state.uses
  return {
    allowed: true,
    quota: getQuotaStatus(),
    trialWarning:
      remaining === 1
        ? `Last free use — next successful ${toolName} needs SKU_TOR_MCP_PRO or a $0.05 call permit (${CALL_BUY_URL}).`
        : null,
  }
}

/** Consume one trial use after a successful billable operation (skip if permit already redeemed). */
export function gateBillableCommit() {
  if (isUnlocked()) {
    void sendTrialHeartbeat({ force: false })
    return
  }
  if (permitAuthorizedForNextCommit) {
    permitAuthorizedForNextCommit = false
    void sendTrialHeartbeat({ force: false })
    return
  }
  return withGateLock(async () => {
    const state = loadState()
    if (state.uses < FREE_LIMIT) {
      state.uses += 1
      saveState(state)
    }
    void sendTrialHeartbeat({ force: false })
  })
}

function saveUnlockKey(key) {
  ensureDataDir()
  writeFileSync(UNLOCK_PATH, key.trim(), { mode: 0o600 })
}

export async function verifyAndUnlock(key) {
  const trimmed = String(key || '').trim()
  if (!trimmed) {
    return { ok: false, error: 'missing_key', message: 'Provide your unlock key from the purchase email.' }
  }

  let result
  try {
    result = await verifyKeyRemote(trimmed)
  } catch (err) {
    return {
      ok: false,
      error: 'verify_unreachable',
      message: err.message || String(err),
      hint: 'Check your internet connection and retry tor_unlock.',
    }
  }

  if (!result.ok) {
    return {
      ok: false,
      error: result.error || 'invalid_key',
      message: result.message || 'Unlock key not recognized.',
    }
  }

  saveUnlockKey(trimmed)
  saveUnlockMeta({ verifiedAt: Date.now() })
  unlockVerified = true
  unlockOfflineGrace = false
  return { ok: true, unlocked: true, quota: getQuotaStatus() }
}
