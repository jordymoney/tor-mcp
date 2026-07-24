#!/usr/bin/env node
/** Smoke-test free Aizamon endpoints + MCP boot banner (no Cursor required). */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const BASE = (process.env.AIZAMON_BASE_URL || 'https://aizamon.com').replace(/\/$/, '')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const paths = [
  '/venue-wire/gaps',
  '/alpha/preview',
  '/agent-store.json',
  '/payment-rails',
  '/x402/services.json',
]

let failed = 0
for (const p of paths) {
  const url = `${BASE}${p}`
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    console.log(res.ok ? 'OK ' : 'FAIL', res.status, p)
    if (!res.ok) failed++
  } catch (err) {
    console.log('FAIL', p, err.message)
    failed++
  }
}

const child = spawn(process.execPath, [join(ROOT, 'aizamon-mcp/server.mjs')], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AIZAMON_AGENT_ID: 'smoke-test' },
})

const boot = await new Promise((resolve) => {
  let err = ''
  const t = setTimeout(() => resolve({ ok: false, reason: 'timeout', stderr: err }), 5000)
  child.stderr.on('data', (b) => {
    err += b.toString()
    if (/aizamon-mcp.*ready/i.test(err)) {
      clearTimeout(t)
      resolve({ ok: true, stderr: err })
    }
  })
  child.on('error', (e) => {
    clearTimeout(t)
    resolve({ ok: false, reason: e.message, stderr: err })
  })
  child.on('exit', (code) => {
    clearTimeout(t)
    resolve({ ok: false, reason: `exit ${code}`, stderr: err })
  })
})

try {
  child.kill('SIGTERM')
} catch {
  /* ignore */
}

console.log(
  boot.ok ? 'OK  aizamon-mcp boot' : 'FAIL aizamon-mcp boot',
  (boot.stderr || boot.reason || '').trim().slice(0, 240),
)
if (!boot.ok) failed++

process.exit(failed ? 1 : 0)
