#!/usr/bin/env node

/**

 * Tor MCP — gives Cursor AI safe, private web access through a managed Tor daemon.

 *

 * Tools:

 *   tor_fetch        — GET any URL (clearnet or .onion) through Tor

 *   tor_post         — POST through Tor

 *   tor_new_circuit  — Request a fresh Tor circuit (new exit IP)

 *   tor_set_exit_country — Prefer exits in one country for clearnet (not .onion)

 *   tor_research     — Search + fetch + extract title/price/stock JSON

 *   tor_geo_compare  — Same clearnet URL via multiple exit countries (deal scout)

 *   tor_status       — Check daemon health and bootstrap progress

 *   tor_unlock       — Apply a purchased unlock key (unlimited use)

 *

 *   tor_restart      — Restart local Tor (free, recovery)

 *

 * Free tier: 25 successful billable uses (fetch/post/research/geo) without unlock.

 * Circuit rotate + status + exit country are free (do not burn trial).

 * All DNS resolves inside Tor (socks5h). No clearnet DNS leaks.

 * Ports: SOCKS 9055, Control 9056 (won't collide with Tor Browser on 9050/9051).

 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { z } from 'zod'

import fetch from 'node-fetch'

import { SocksProxyAgent } from 'socks-proxy-agent'

import { torDaemon, ensureTor, MCP_VERSION, isRecoverableTorError, isInstantSocksReject } from './tor-daemon.mjs'

import {
  gateBillableCheck,
  gateBillableCommit,
  getQuotaStatus,
  initUsageGate,
  verifyAndUnlock,
  addCallPermit,
  sendTrialHeartbeat,
} from './usage-gate.mjs'

import { runResearch, runGeoCompare } from './research.mjs'



// ── Boot: verify license, then Tor ────────────────────────────────────────────

const licenseInit = await initUsageGate()
if (!licenseInit.ok) {
  process.stderr.write(`[tor-mcp] ${licenseInit.message}\n`)
}
void sendTrialHeartbeat({ force: true }).catch(() => {})

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

  'POST data to a URL through the Tor network. Use for form submissions, API calls, or .onion services. Counts against the free trial (then call permit or Pro).',

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

  'Ask Tor for a fresh circuit — your apparent exit IP changes within a few seconds. Free — does not count against the trial.',

  {},

  async () => {

    try {

      const result = await torDaemon.newCircuit()

      return {

        content: [{

          type: 'text',

          text: JSON.stringify({

            ok: true,

            message: 'New circuit requested. Exit IP will rotate in ~3s.',

            ...result,

            _quota: getQuotaStatus(),

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

  'tor_set_exit_country',

  'Prefer Tor exit nodes in one country for clearnet websites (ISO code like us, ca, de, gb). Pass "any" to clear. Does NOT affect .onion sites. Default is soft prefer (not strict) so circuits do not hang. Verifies with a geo lookup when possible. Free — does not count against trial.',

  {

    country: z

      .string()

      .min(2)

      .max(8)

      .describe('Two-letter country code (us, ca, de, gb, nl, …) or "any" to clear'),

    strict: z

      .boolean()

      .optional()

      .describe('If true, ONLY use that country (can hang). Default false = prefer.'),

  },

  async ({ country, strict }) => {

    try {

      await ensureTor({ onion: false })

      const result = await torDaemon.setExitCountry(country, { verify: true, strict: Boolean(strict) })

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }

    } catch (err) {

      return {

        content: [{

          type: 'text',

          text: JSON.stringify({

            ok: false,

            error: err.message,

            hint: 'Some countries have few Tor exits — try us, de, nl, or gb. .onion traffic ignores exit country.',

            exitCountry: torDaemon.status().exitCountry || null,

          }, null, 2),

        }],

      }

    }

  },

)



server.tool(

  'tor_research',

  'Ban-resistant research pack: optional DuckDuckGo .onion search + fetch URLs through Tor, then extract title, prices, stock hints, and key snippets as structured JSON. One successful run = one billable use.',

  {

    query: z.string().min(2).max(200).optional().describe('Search query via DuckDuckGo onion HTML'),

    urls: z.array(z.string().url()).max(6).optional().describe('Direct http(s) or .onion URLs to fetch'),

    maxSearchHits: z.number().int().min(1).max(8).optional().describe('Max DDG hits to keep (default 5)'),

    maxPages: z.number().int().min(1).max(6).optional().describe('Max pages to fetch+extract (default 4)'),

    followSearchHits: z.boolean().optional().describe('Fetch top search hit pages (default true)'),

  },

  async ({ query, urls, maxSearchHits, maxPages, followSearchHits }) => {

    const gate = await gateBillableCheck()

    if (!gate.allowed) {

      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: gate.error, _quota: getQuotaStatus() }) }] }

    }

    if (!query && !(urls && urls.length)) {

      return {

        content: [{

          type: 'text',

          text: JSON.stringify({ ok: false, error: 'Provide query and/or urls', _quota: getQuotaStatus() }),

        }],

      }

    }

    try {

      const result = await runResearch(torFetchResilient, {

        query: query || null,

        urls: urls || [],

        maxSearchHits: maxSearchHits ?? 5,

        maxPages: maxPages ?? 4,

        followSearchHits: followSearchHits !== false,

      })

      if (result.ok) await gateBillableCommit()

      return {

        content: [{

          type: 'text',

          text: JSON.stringify({ ...result, _quota: getQuotaStatus(), _trialWarning: gate.trialWarning || undefined }, null, 2),

        }],

      }

    } catch (err) {

      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message, _quota: getQuotaStatus() }) }] }

    }

  },

)



server.tool(

  'tor_geo_compare',

  'Deal / geo price scout. Prefer urls[] for storefront compare (amazon.ca vs amazon.com). Or pass url + countries for best-effort Tor exit prefer. One successful run = one billable use. Not for .onion.',

  {

    url: z.string().url().optional().describe('Single clearnet URL to re-fetch via exit countries'),

    urls: z

      .array(z.string().url())

      .min(1)

      .max(6)

      .optional()

      .describe('Locale storefront URLs to compare (recommended for deals)'),

    countries: z

      .array(z.string().min(2).max(2))

      .min(1)

      .max(6)

      .optional()

      .describe('ISO exit countries when using url mode (default de, nl)'),

    strict: z

      .boolean()

      .optional()

      .describe('Hard-pin exits (often hangs). Default false.'),

  },

  async ({ url, urls, countries, strict }) => {

    const gate = await gateBillableCheck()

    if (!gate.allowed) {

      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: gate.error, _quota: getQuotaStatus() }) }] }

    }

    if (!url && !(urls && urls.length)) {

      return {

        content: [{

          type: 'text',

          text: JSON.stringify({ ok: false, error: 'Provide urls[] (recommended) or url + countries', _quota: getQuotaStatus() }),

        }],

      }

    }

    try {

      const result = await runGeoCompare(

        torFetchResilient,

        async (country, opts = {}) =>

          torDaemon.setExitCountry(country, {

            verify: false,

            strict: Boolean(opts.strict ?? strict),

          }),

        {

          url: url || null,

          urls: urls || null,

          countries: countries || ['de', 'nl'],

          settleMs: 3000,

          matchAttempts: 4,

          strict: Boolean(strict),

          newCircuitFn: () => torDaemon.newCircuit(),

        },

      )

      if (result.ok) await gateBillableCommit()
      return {

        content: [{

          type: 'text',

          text: JSON.stringify({ ...result, _quota: getQuotaStatus(), _trialWarning: gate.trialWarning || undefined }, null, 2),

        }],

      }

    } catch (err) {

      return {

        content: [{

          type: 'text',

          text: JSON.stringify({

            ok: false,

            error: err.message,

            hint: 'Clearnet only. Prefer us/de/nl/gb exits. Amazon often blocks Tor — try vendor/SaaS pages or ifconfig.co/json for geo proof.',

            _quota: getQuotaStatus(),

          }, null, 2),

        }],

      }

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

  'Apply your Tor MCP Pro unlock key from aizamon.com (SKU_TOR_MCP_PRO). Removes the free-trial limit on this machine. Does not count against trial.',

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

