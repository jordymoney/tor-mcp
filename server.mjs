#!/usr/bin/env node

/**

 * Tor MCP — gives Cursor AI safe, private web access through a managed Tor daemon.

 *

 * Tools:

 *   tor_fetch        — GET any URL (clearnet or .onion) through Tor

 *   tor_post         — POST through Tor

 *   tor_new_circuit  — Request a fresh Tor circuit (new exit IP)

 *   tor_status       — Check daemon health and bootstrap progress

 *   tor_unlock       — Apply a purchased unlock key (unlimited use)

 *

 *   tor_restart      — Restart local Tor (free, recovery)

 *

 * Free tier: 5 successful billable uses (fetch/post/circuit) without unlock.

 * All DNS resolves inside Tor (socks5h). No clearnet DNS leaks.

 * Ports: SOCKS 9055, Control 9056 (won't collide with Tor Browser on 9050/9051).

 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { z } from 'zod'

import fetch from 'node-fetch'

import { SocksProxyAgent } from 'socks-proxy-agent'

import { torDaemon, ensureTor, MCP_VERSION, isRecoverableTorError, isInstantSocksReject } from './tor-daemon.mjs'

import { gateBillableCheck, gateBillableCommit, getQuotaStatus, initUsageGate, verifyAndUnlock, addCallPermit } from './usage-gate.mjs'



// ── Boot: verify license, then Tor ────────────────────────────────────────────

const licenseInit = await initUsageGate()
if (!licenseInit.ok) {
  process.stderr.write(`[tor-mcp] ${licenseInit.message}\n`)
}

torDaemon.start().catch((err) => {

  process.stderr.write(`[tor-mcp] Tor startup failed: ${err.message}\n`)

  process.stderr.write(`[tor-mcp] Run setup.ps1 to install the Tor Expert Bundle.\n`)

})

function billableSucceeded(result) {
  return Boolean(result && (result.ok === true || typeof result.status === 'number'))
}



function blockedPayload(gate) {

  return {

    ok: false,

    error: gate.error,

    message: gate.message,

    hint: gate.hint,

    quota: gate.quota,

  }

}



// ── Helpers ───────────────────────────────────────────────────────────────────

async function torFetch(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000, skipOnionEnsure = false } = {}) {

  const proxyUrl = await ensureTor({ onion: url.includes('.onion') && !skipOnionEnsure })

  const agent = new SocksProxyAgent(proxyUrl)

  const effectiveTimeout = url.includes('.onion')
    ? Math.max(timeoutMs, 90_000)
    : timeoutMs

  const controller = new AbortController()

  const timer = setTimeout(() => controller.abort(), effectiveTimeout)

  try {

    const res = await fetch(url, {

      method,

      headers: { 'User-Agent': 'Mozilla/5.0 (tor-mcp research)', ...headers },

      body: body ?? undefined,

      agent,

      signal: controller.signal,

    })

    clearTimeout(timer)

    const text = await res.text()

    let json = null

    if (res.headers.get('content-type')?.includes('application/json')) {

      try { json = JSON.parse(text) } catch {}

    }

    return {

      ok: res.ok,

      status: res.status,

      url: res.url,

      contentType: res.headers.get('content-type') || '',

      body: json ?? text.slice(0, 32_000),

    }

  } finally {

    clearTimeout(timer)

  }

}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

/** NEWNYM retries on instant SOCKS reject — no auto tor_restart (avoids port fights). */
async function torFetchResilient(url, opts) {
  const isOnion = url.includes('.onion')
  const maxAttempts = isOnion ? 4 : 1
  let lastErr

  const run = async () => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await torFetch(url, { ...opts, skipOnionEnsure: isOnion })
        return result
      } catch (err) {
        lastErr = err
        if (!isOnion || !isRecoverableTorError(err)) throw err
        torDaemon.markOnionFetchFailed(err)
        if (attempt >= maxAttempts - 1) break
        const instant = isInstantSocksReject(err)
        await torDaemon.newCircuit().catch(() => {})
        await sleep(instant ? 6000 : 4000)
      }
    }
    throw lastErr
  }

  if (isOnion) {
    return torDaemon.withOnionLock(async () => {
      await torDaemon.ensureOnionReady()
      return run()
    })
  }
  return run()
}



// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({

  name: 'tor-mcp',

  version: '1.3.1',

})



server.tool(

  'tor_fetch',

  'Fetch a URL through the Tor network (clearnet or .onion). DNS resolves inside Tor — no IP leaks. Returns status, content-type, and up to 32 KB of body. Free trial: 5 uses, then $0.05 call permit (aizamon.com/x402/v1/tor-call) or Pro unlock.',

  {

    url: z.string().url().describe('URL to fetch (http/https/onion)'),

    headers: z.record(z.string()).optional().describe('Extra request headers'),

    timeout_ms: z.number().int().min(1000).max(120_000).default(30_000).describe('Request timeout in ms'),

  },

  async ({ url, headers, timeout_ms }) => {

    const gate = await gateBillableCheck('tor_fetch')

    if (!gate.allowed) {

      return { content: [{ type: 'text', text: JSON.stringify(blockedPayload(gate), null, 2) }] }

    }



    const warning = url.startsWith('http://') && !url.includes('.onion')

      ? 'WARNING: plain HTTP — the Tor exit node can read the response body. Use HTTPS when possible.'

      : null

    try {

      const result = await torFetchResilient(url, { headers, timeoutMs: timeout_ms })

      if (billableSucceeded(result)) await gateBillableCommit()

      if (warning) result._warning = warning

      result._quota = getQuotaStatus()

      if (gate.trialWarning) result._trialWarning = gate.trialWarning

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }

    } catch (err) {

      return {

        content: [{

          type: 'text',

          text: JSON.stringify({

            ok: false,

            error: err.message,

            _warning: warning,

            _quota: getQuotaStatus(),

          }),

        }],

      }

    }

  },

)



server.tool(

  'tor_post',

  'POST data to a URL through the Tor network. Use for form submissions, API calls, or .onion services. Counts against the 5-use free trial (then call permit or Pro).',

  {

    url: z.string().url().describe('URL to POST to'),

    body: z.string().describe('Request body (JSON string, form data, etc.)'),

    content_type: z.string().default('application/json').describe('Content-Type header'),

    headers: z.record(z.string()).optional().describe('Extra request headers'),

    timeout_ms: z.number().int().min(1000).max(120_000).default(30_000).describe('Request timeout in ms'),

  },

  async ({ url, body, content_type, headers, timeout_ms }) => {

    const gate = await gateBillableCheck('tor_post')

    if (!gate.allowed) {

      return { content: [{ type: 'text', text: JSON.stringify(blockedPayload(gate), null, 2) }] }

    }



    const warning = url.startsWith('http://') && !url.includes('.onion')

      ? 'WARNING: plain HTTP — the Tor exit node can read the request body. Use HTTPS when possible.'

      : null

    try {

      const result = await torFetchResilient(url, {

        method: 'POST',

        headers: { 'Content-Type': content_type, ...headers },

        body,

        timeoutMs: timeout_ms,

      })

      if (billableSucceeded(result)) await gateBillableCommit()

      if (warning) result._warning = warning

      result._quota = getQuotaStatus()

      if (gate.trialWarning) result._trialWarning = gate.trialWarning

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }

    } catch (err) {

      return {

        content: [{

          type: 'text',

          text: JSON.stringify({

            ok: false,

            error: err.message,

            _warning: warning,

            _quota: getQuotaStatus(),

          }),

        }],

      }

    }

  },

)



server.tool(

  'tor_new_circuit',

  'Ask Tor for a fresh circuit — your apparent exit IP changes within a few seconds. Counts against the 5-use free trial (then call permit or Pro).',

  {},

  async () => {

    const gate = await gateBillableCheck('tor_new_circuit')

    if (!gate.allowed) {

      return { content: [{ type: 'text', text: JSON.stringify(blockedPayload(gate), null, 2) }] }

    }



    try {

      const result = await torDaemon.newCircuit()

      await gateBillableCommit()

      return {

        content: [{

          type: 'text',

          text: JSON.stringify({

            ok: true,

            message: 'New circuit requested. Exit IP will rotate in ~3s.',

            ...result,

            _quota: getQuotaStatus(),

            _trialWarning: gate.trialWarning || undefined,

          }),

        }],

      }

    } catch (err) {

      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message, _quota: getQuotaStatus() }) }] }

    }

  },

)



server.tool(

  'tor_restart',

  'Shut down tor on ports 9055/9056 and start a fresh managed instance. Use when .onion fetches fail intermittently. Free — does not count against trial.',

  {},

  async () => {

    try {

      const status = await torDaemon.restart()

      return {

        content: [{

          type: 'text',

          text: JSON.stringify({

            ok: true,

            message: 'Tor restarted with fresh circuits.',

            mcpVersion: MCP_VERSION,

            ...status,

          }, null, 2),

        }],

      }

    } catch (err) {

      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message, mcpVersion: MCP_VERSION }) }] }

    }

  },

)



server.tool(

  'tor_status',

  'Check the Tor daemon health: running state, bootstrap progress, SOCKS port, recent log lines, and free-trial quota (always free — does not count against trial).',

  {},

  async () => {

    if (torDaemon.status().running) {
      try {
        await torDaemon.ensureOnionReady()
      } catch {
        /* status still reports last probe */
      }
    }

    const status = torDaemon.status()

    const quota = getQuotaStatus()

    const hsNote = status.onionOk === false
      ? ' ✗ Hidden services (.onion) failed last probe — restart tor-mcp or free port 9055.'
      : status.onionOk === true
        ? ' ✓ .onion hidden services OK.'
        : ''

    const extra = status.running

      ? quota.operator

        ? `✓ Tor is ready.${hsNote} Unlimited use (operator).`

        : quota.unlocked

          ? `✓ Tor is ready.${hsNote} Unlimited use (unlocked).`

          : `✓ Tor is ready.${hsNote} Free trial: ${quota.used}/${quota.freeLimit} successful uses${quota.remaining === 0 ? ' — unlock at ' + quota.unlockUrl : ''}.`

      : status.bootstrapPct > 0

        ? `⏳ Tor is bootstrapping (${status.bootstrapPct}%). Wait a moment then retry.`

        : '✗ Tor is not running. First request will trigger auto-start, or check that tor.exe is in tor-bin/.'

    return {

      content: [{ type: 'text', text: JSON.stringify({ mcpVersion: MCP_VERSION, ...status, quota, note: extra }, null, 2) }],

    }

  },

)



server.tool(

  'tor_unlock',

  'Apply your Tor MCP Pro unlock key from aizamon.com (SKU_TOR_MCP_PRO). Removes the 5-use trial limit on this machine. Does not count against trial.',

  {

    key: z.string().min(8).describe('Unlock key from your purchase email'),

  },

  async ({ key }) => {

    const result = await verifyAndUnlock(key)

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }

  },

)




server.tool(

  'tor_add_call_permit',

  'Queue a paid Tor call permit token from aizamon.com (GET /x402/v1/tor-call → result.torCallPermit.token). After the free trial, each billable tool redeems one permit. Free — does not count against trial.',

  {

    token: z.string().min(8).describe('torCallPermit.token from SKU_AG_TOR_CALL_01 /x402/v1/tor-call'),

  },

  async ({ token }) => {

    const result = addCallPermit(token)

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }

  },

)



// ── Start ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()

await server.connect(transport)

