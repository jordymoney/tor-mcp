#!/usr/bin/env node
/**
 * Tor MCP — gives Cursor AI safe, private web access through a managed Tor daemon.
 *
 * Tools:
 *   tor_fetch        — GET any URL (clearnet or .onion) through Tor
 *   tor_post         — POST through Tor
 *   tor_new_circuit  — Request a fresh Tor circuit (new exit IP)
 *   tor_status       — Check daemon health and bootstrap progress
 *
 * All DNS resolves inside Tor (socks5h). No clearnet DNS leaks.
 * Ports: SOCKS 9055, Control 9056 (won't collide with Tor Browser on 9050/9051).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fetch from 'node-fetch'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { torDaemon, ensureTor } from './tor-daemon.mjs'

// ── Boot Tor on server start ──────────────────────────────────────────────────
torDaemon.start().catch((err) => {
  process.stderr.write(`[tor-mcp] Tor startup failed: ${err.message}\n`)
  process.stderr.write(`[tor-mcp] Run setup.ps1 to install the Tor Expert Bundle.\n`)
})

// ── Helpers ───────────────────────────────────────────────────────────────────
async function torFetch(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {
  const proxyUrl = await ensureTor()
  const agent = new SocksProxyAgent(proxyUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
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

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new McpServer({
  name: 'tor-mcp',
  version: '1.0.0',
})

server.tool(
  'tor_fetch',
  'Fetch a URL through the Tor network (clearnet or .onion). DNS resolves inside Tor — no IP leaks. Returns status, content-type, and up to 32 KB of body.',
  {
    url: z.string().url().describe('URL to fetch (http/https/onion)'),
    headers: z.record(z.string()).optional().describe('Extra request headers'),
    timeout_ms: z.number().int().min(1000).max(120_000).default(30_000).describe('Request timeout in ms'),
  },
  async ({ url, headers, timeout_ms }) => {
    const warning = url.startsWith('http://') && !url.includes('.onion')
      ? 'WARNING: plain HTTP — the Tor exit node can read the response body. Use HTTPS when possible.'
      : null
    try {
      const result = await torFetch(url, { headers, timeoutMs: timeout_ms })
      if (warning) result._warning = warning
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message, _warning: warning }) }] }
    }
  },
)

server.tool(
  'tor_post',
  'POST data to a URL through the Tor network. Use for form submissions, API calls, or .onion services.',
  {
    url: z.string().url().describe('URL to POST to'),
    body: z.string().describe('Request body (JSON string, form data, etc.)'),
    content_type: z.string().default('application/json').describe('Content-Type header'),
    headers: z.record(z.string()).optional().describe('Extra request headers'),
    timeout_ms: z.number().int().min(1000).max(120_000).default(30_000).describe('Request timeout in ms'),
  },
  async ({ url, body, content_type, headers, timeout_ms }) => {
    const warning = url.startsWith('http://') && !url.includes('.onion')
      ? 'WARNING: plain HTTP — the Tor exit node can read the request body. Use HTTPS when possible.'
      : null
    try {
      const result = await torFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': content_type, ...headers },
        body,
        timeoutMs: timeout_ms,
      })
      if (warning) result._warning = warning
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message, _warning: warning }) }] }
    }
  },
)

server.tool(
  'tor_new_circuit',
  'Ask Tor for a fresh circuit — your apparent exit IP changes within a few seconds. Use this to rotate identity between requests.',
  {},
  async () => {
    try {
      const result = await torDaemon.newCircuit()
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ok: true, message: 'New circuit requested. Exit IP will rotate in ~3s.', ...result }),
        }],
      }
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }] }
    }
  },
)

server.tool(
  'tor_status',
  'Check the Tor daemon health: running state, bootstrap progress, SOCKS port, and recent log lines.',
  {},
  async () => {
    const status = torDaemon.status()
    const extra = status.running
      ? '✓ Tor is ready. All requests through tor_fetch/tor_post are anonymised.'
      : status.bootstrapPct > 0
        ? `⏳ Tor is bootstrapping (${status.bootstrapPct}%). Wait a moment then retry.`
        : '✗ Tor is not running. First request will trigger auto-start, or check that tor.exe is in tor-bin/.'
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...status, note: extra }, null, 2) }],
    }
  },
)

// ── Start ──────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport()
await server.connect(transport)
