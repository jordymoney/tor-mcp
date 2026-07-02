/**
 * Free-tier usage gate for Tor MCP network tools.
 * tor_fetch, tor_post, and tor_new_circuit count against the trial.
 * tor_status and tor_unlock are always free.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import fetch from 'node-fetch'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOR_DATA = resolve(HERE, 'tor-data')
const USAGE_PATH = resolve(TOR_DATA, 'usage-gate.json')
const UNLOCK_PATH = resolve(TOR_DATA, 'unlock.key')

export const FREE_LIMIT = Math.max(1, parseInt(process.env.TOR_MCP_FREE_USES || '5', 10))
const VERIFY_URL = (process.env.TOR_MCP_VERIFY_URL || 'https://aizamon.com/api/tor-mcp/verify').replace(/\/$/, '')
const UNLOCK_URL = process.env.TOR_MCP_UNLOCK_URL || 'https://aizamon.com/client?sku=SKU_TOR_MCP_PRO'

function ensureDataDir() {
  if (!existsSync(TOR_DATA)) mkdirSync(TOR_DATA, { recursive: true })
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
  const envKey = String(process.env.TOR_MCP_UNLOCK_KEY || '').trim()
  if (envKey) return envKey
  if (existsSync(UNLOCK_PATH)) {
    try {
      return readFileSync(UNLOCK_PATH, 'utf8').trim()
    } catch {
      return null
    }
  }
  return null
}

function isOperator() {
  const v = String(process.env.TOR_MCP_OPERATOR || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'operator'
}

export function isUnlocked() {
  if (isOperator()) return true
  return Boolean(readLocalUnlockKey())
}

export function getQuotaStatus() {
  const state = loadState()
  const operator = isOperator()
  const unlocked = isUnlocked()
  const used = state.uses
  const limit = FREE_LIMIT
  return {
    unlocked,
    operator,
    freeLimit: limit,
    used,
    remaining: unlocked ? null : Math.max(0, limit - used),
    billableTools: ['tor_fetch', 'tor_post', 'tor_new_circuit'],
    unlockUrl: UNLOCK_URL,
    unlockSku: 'SKU_TOR_MCP_PRO',
  }
}

export function gateBillableUse(toolName) {
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
        `Free trial exhausted (${FREE_LIMIT}/${FREE_LIMIT} uses). Unlock unlimited Tor MCP at ${UNLOCK_URL}`,
      quota,
      hint:
        'After purchase, run tor_unlock with your key or set TOR_MCP_UNLOCK_KEY in ~/.cursor/mcp.json env.',
    }
  }

  state.uses += 1
  saveState(state)
  const quota = getQuotaStatus()
  return {
    allowed: true,
    quota,
    trialWarning:
      !quota.unlocked && quota.remaining === 0
        ? `Last free use — next ${toolName} call requires SKU_TOR_MCP_PRO unlock.`
        : null,
  }
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

  const envKey = String(process.env.TOR_MCP_UNLOCK_KEY || '').trim()
  if (envKey && envKey === trimmed) {
    saveUnlockKey(trimmed)
    return { ok: true, unlocked: true, source: 'env_match', quota: getQuotaStatus() }
  }

  let resp
  try {
    resp = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: trimmed }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    return {
      ok: false,
      error: 'verify_unreachable',
      message: err.message || String(err),
      hint: 'If you already purchased, set TOR_MCP_UNLOCK_KEY in mcp.json or retry when online.',
    }
  }

  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || !data.ok) {
    return {
      ok: false,
      error: data.error || 'invalid_key',
      message: data.message || data.hint || 'Unlock key not recognized.',
    }
  }

  saveUnlockKey(trimmed)
  return { ok: true, unlocked: true, quota: getQuotaStatus() }
}
