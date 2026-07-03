/**
 * Free-tier usage gate for Tor MCP network tools.
 * tor_fetch, tor_post, and tor_new_circuit count against the trial (on success only).
 * tor_status, tor_unlock, and tor_restart are always free.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import fetch from 'node-fetch'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOR_DATA = resolve(HERE, 'tor-data')
const USAGE_PATH = resolve(TOR_DATA, 'usage-gate.json')
const UNLOCK_PATH = resolve(TOR_DATA, 'unlock.key')
const UNLOCK_META_PATH = resolve(TOR_DATA, 'unlock.meta.json')

export const FREE_LIMIT = Math.max(1, parseInt(process.env.TOR_MCP_FREE_USES || '5', 10))
const VERIFY_URL = (process.env.TOR_MCP_VERIFY_URL || 'https://aizamon.com/api/tor-mcp/verify').replace(/\/$/, '')
const UNLOCK_URL = process.env.TOR_MCP_UNLOCK_URL || 'https://aizamon.com/client?sku=SKU_TOR_MCP_PRO'
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000

let unlockVerified = false
let unlockOfflineGrace = false
let initDone = false
let gateChain = Promise.resolve()

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
  const quota = {
    unlocked,
    freeLimit: limit,
    used,
    remaining: unlocked ? null : Math.max(0, limit - used),
    billableTools: ['tor_fetch', 'tor_post', 'tor_new_circuit'],
    unlockUrl: UNLOCK_URL,
  }
  if (unlocked && unlockOfflineGrace) {
    quota.offlineGrace = true
  }
  if (isOperator()) {
    quota.operator = true
  }
  return quota
}

/** Check trial without consuming a use. */
export function gateBillableCheck(toolName) {
  if (isUnlocked()) {
    return { allowed: true, quota: getQuotaStatus() }
  }

  const state = loadState()
  if (state.uses >= FREE_LIMIT) {
    const quota = getQuotaStatus()
    return {
      allowed: false,
      blocked: true,
      error: 'trial_exhausted',
      tool: toolName,
      message:
        `Free trial exhausted (${FREE_LIMIT}/${FREE_LIMIT} successful uses). Unlock at ${UNLOCK_URL}`,
      quota,
      hint:
        'After purchase, run tor_unlock with your key or set TOR_MCP_UNLOCK_KEY in ~/.cursor/mcp.json env, then reload Cursor.',
    }
  }

  const remaining = FREE_LIMIT - state.uses
  return {
    allowed: true,
    quota: getQuotaStatus(),
    trialWarning:
      remaining === 1
        ? `Last free use — next successful ${toolName} requires SKU_TOR_MCP_PRO unlock.`
        : null,
  }
}

/** Consume one trial use after a successful billable operation. */
export function gateBillableCommit() {
  if (isUnlocked()) return
  return withGateLock(async () => {
    const state = loadState()
    if (state.uses < FREE_LIMIT) {
      state.uses += 1
      saveState(state)
    }
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
