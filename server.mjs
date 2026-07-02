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

 * Free tier: 5 billable uses (fetch/post/circuit) without unlock.

 * All DNS resolves inside Tor (socks5h). No clearnet DNS leaks.

 * Ports: SOCKS 9055, Control 9056 (won't collide with Tor Browser on 9050/9051).

 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { z } from 'zod'

import fetch from 'node-fetch'

import { SocksProxyAgent } from 'socks-proxy-agent'

import { torDaemon, ensureTor, MCP_VERSION, isRecoverableTorError } from './tor-daemon.mjs'

import { gateBillableUse, getQuotaStatus, verifyAndUnlock } from './usage-gate.mjs'



// ── Boot Tor on server start ──────────────────────────────────────────────────

torDaemon.start().catch((err) => {

  process.stderr.write(`[tor-mcp] Tor startup failed: ${err.message}\n`)

  process.stderr.write(`[tor-mcp] Run setup.ps1 to install the Tor Expert Bundle.\n`)

})



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

async function torFetch(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {

  const proxyUrl = await ensureTor({ onion: url.includes('.onion') })

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

/** One retry with fresh circuit; full tor restart if still failing. */
async function torFetchResilient(url, opts) {
  try {
    return await torFetch(url, opts)
  } catch (err) {
    if (!url.includes('.onion') || !isRecoverableTorError(err)) throw err
    try {
      await torDaemon.newCircuit()
      await sleep(3000)
      await torDaemon.ensureOnionReady(0)
      return await torFetch(url, opts)
    } catch (err2) {
      if (!isRecoverableTorError(err2)) throw err2
      try {
        await torDaemon.refreshCircuits()
        return await torFetch(url, opts)
      } catch (err3) {
        if (!isRecoverableTorError(err3)) throw err3
        await torDaemon.restart()
        return await torFetch(url, opts)
      }
    }
  }
}



// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({

  name: 'tor-mcp',

  version: '1.2.3',

})



server.tool(

  'tor_fetch',

  'Fetch a URL through the Tor network (clearnet or .onion). DNS resolves inside Tor — no IP leaks. Returns status, content-type, and up to 32 KB of body. Free trial: 5 uses, then unlock at aizamon.com/client?sku=SKU_TOR_MCP_PRO.',

  {

    url: z.string().url().describe('URL to fetch (http/https/onion)'),

    headers: z.record(z.string()).optional().describe('Extra request headers'),

    timeout_ms: z.number().int().min(1000).max(120_000).default(30_000).describe('Request timeout in ms'),

  },

  async ({ url, headers, timeout_ms }) => {

    const gate = gateBillableUse('tor_fetch')

    if (!gate.allowed) {

      return { content: [{ type: 'text', text: JSON.stringify(blockedPayload(gate), null, 2) }] }

    }



    const warning = url.startsWith('http://') && !url.includes('.onion')

      ? 'WARNING: plain HTTP — the Tor exit node can read the response body. Use HTTPS when possible.'

      : null

    try {

      const result = await torFetchResilient(url, { headers, timeoutMs: timeout_ms })

      if (warning) result._warning = warning

      result._quota = gate.quota

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

            _quota: gate.quota,

          }),

        }],

      }

    }

  },

)



server.tool(

  'tor_post',

  'POST data to a URL through the Tor network. Use for form submissions, API calls, or .onion services. Counts against the 5-use free trial.',

  {

    url: z.string().url().describe('URL to POST to'),

    body: z.string().describe('Request body (JSON string, form data, etc.)'),

    content_type: z.string().default('application/json').describe('Content-Type header'),

    headers: z.record(z.string()).optional().describe('Extra request headers'),

    timeout_ms: z.number().int().min(1000).max(120_000).default(30_000).describe('Request timeout in ms'),

  },

  async ({ url, body, content_type, headers, timeout_ms }) => {

    const gate = gateBillableUse('tor_post')

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

      if (warning) result._warning = warning

      result._quota = gate.quota

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

            _quota: gate.quota,

          }),

        }],

      }

    }

  },

)



server.tool(

  'tor_new_circuit',

  'Ask Tor for a fresh circuit — your apparent exit IP changes within a few seconds. Counts against the 5-use free trial.',

  {},

  async () => {

    const gate = gateBillableUse('tor_new_circuit')

    if (!gate.allowed) {

      return { content: [{ type: 'text', text: JSON.stringify(blockedPayload(gate), null, 2) }] }

    }



    try {

      const result = await torDaemon.newCircuit()

      return {

        content: [{

          type: 'text',

          text: JSON.stringify({

            ok: true,

            message: 'New circuit requested. Exit IP will rotate in ~3s.',

            ...result,

            _quota: gate.quota,

            _trialWarning: gate.trialWarning || undefined,

          }),

        }],

      }

    } catch (err) {

      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message, _quota: gate.quota }) }] }

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

        ? `✓ Tor is ready.${hsNote} Operator mode — unlimited use.`

        : quota.unlocked

          ? `✓ Tor is ready.${hsNote} Unlimited use (unlocked).`

          : `✓ Tor is ready.${hsNote} Free trial: ${quota.used}/${quota.freeLimit} uses${quota.remaining === 0 ? ' — unlock at ' + quota.unlockUrl : ''}.`

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



// ── Start ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()

await server.connect(transport)

