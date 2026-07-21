/**
 * TorDaemon — manages the tor.exe lifecycle and control-port interactions.
 *
 * Looks for tor.exe in (priority order):
 *   1. TOR_BIN env var
 *   2. ./tor-bin/tor.exe  (placed here by setup.ps1)
 *   3. PATH
 */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createConnection } from 'node:net'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import fetch from 'node-fetch'
import { SocksProxyAgent } from 'socks-proxy-agent'

const HERE = dirname(fileURLToPath(import.meta.url))

const SOCKS_PORT = parseInt(process.env.TOR_SOCKS_PORT || '9055')
const CONTROL_PORT = parseInt(process.env.TOR_CONTROL_PORT || '9056')
const TORRC = resolve(HERE, 'torrc')
const TOR_DATA = resolve(HERE, 'tor-data')

const OPERATOR_MODE = process.env.TOR_MCP_OPERATOR === '1'
/** Prefer owning tor; if ports stay busy, attach to a working instance instead of failing. */
const PREFER_MANAGED = OPERATOR_MODE || process.env.TOR_MCP_FORCE_MANAGED === '1'
const AUTO_REFRESH_MS = parseInt(
  process.env.TOR_MCP_REFRESH_MS ?? (OPERATOR_MODE ? '300000' : '0'),
  10,
)

const execFileAsync = promisify(execFile)

/** DDG — secondary confirm after canary warmup. */
const ONION_PROBE_URL =
  process.env.TOR_ONION_PROBE_URL ||
  'http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/'

/** Facebook — HS canary; any HTTP response (incl. 500) means circuits work. */
const ONION_CANARY_URL =
  process.env.TOR_ONION_CANARY_URL ||
  'https://facebookwkhpilnemxj7asaniu7vnjjbiltxjqhye3mhbshg7kx5tfyd.onion/'

function findTorExe() {
  if (process.env.TOR_BIN && existsSync(process.env.TOR_BIN)) return process.env.TOR_BIN
  const bundled = resolve(HERE, 'tor-bin', 'tor.exe')
  if (existsSync(bundled)) return bundled
  const fromPath = process.platform === 'win32' ? 'tor.exe' : 'tor'
  return fromPath
}

function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolvePort) => {
    const sock = createConnection(port, host)
    const done = (open) => {
      sock.removeAllListeners()
      sock.destroy()
      resolvePort(open)
    }
    sock.setTimeout(timeoutMs)
    sock.on('connect', () => done(true))
    sock.on('timeout', () => done(false))
    sock.on('error', () => done(false))
  })
}

function readControlCookieHex() {
  try {
    const cookiePath = resolve(TOR_DATA, 'control_auth_cookie')
    return readFileSync(cookiePath).toString('hex').toUpperCase()
  } catch {
    return null
  }
}

function controlTalk(commands, timeoutMs = 8000) {
  return new Promise((resolveTalk, reject) => {
    const sock = createConnection(CONTROL_PORT, '127.0.0.1')
    let buf = ''
    const cookieHex = readControlCookieHex()
    const auth = cookieHex != null ? `AUTHENTICATE ${cookieHex}\r\n` : 'AUTHENTICATE ""\r\n'
    const payload = auth + commands.map((c) => `${c}\r\n`).join('') + 'QUIT\r\n'

    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('Control port timeout'))
    }, timeoutMs)

    sock.on('connect', () => sock.write(payload))
    sock.on('data', (d) => { buf += d.toString() })
    sock.on('end', () => {
      clearTimeout(timer)
      resolveTalk(buf)
    })
    sock.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function parseBootstrapPct(controlText) {
  const m = controlText.match(/BOOTSTRAP PROGRESS=(\d+)/i)
  return m ? parseInt(m[1], 10) : null
}

function parseTorVersion(controlText) {
  const m = controlText.match(/version=([^\r\n]+)/i)
  return m ? m[1].trim() : null
}

export const MCP_VERSION = '1.3.5'

const EXIT_COUNTRY_PATH = resolve(TOR_DATA, 'exit-country.json')

/** ISO 3166-1 alpha-2 — common Tor exit countries (not exhaustive of every relay). */
const EXIT_COUNTRY_HINTS = {
  us: 'United States',
  ca: 'Canada',
  gb: 'United Kingdom',
  de: 'Germany',
  nl: 'Netherlands',
  fr: 'France',
  se: 'Sweden',
  ch: 'Switzerland',
  at: 'Austria',
  pl: 'Poland',
  ro: 'Romania',
  ua: 'Ukraine',
  ru: 'Russia',
  jp: 'Japan',
  sg: 'Singapore',
  au: 'Australia',
  br: 'Brazil',
  mx: 'Mexico',
  in: 'India',
  fi: 'Finland',
  no: 'Norway',
  dk: 'Denmark',
  ie: 'Ireland',
  es: 'Spain',
  it: 'Italy',
  cz: 'Czechia',
  hu: 'Hungary',
  bg: 'Bulgaria',
  lt: 'Lithuania',
  lv: 'Latvia',
  ee: 'Estonia',
  is: 'Iceland',
  lu: 'Luxembourg',
  be: 'Belgium',
  pt: 'Portugal',
  nz: 'New Zealand',
  za: 'South Africa',
  kr: 'South Korea',
  hk: 'Hong Kong',
  tw: 'Taiwan',
  il: 'Israel',
}

function normalizeCountryCode(input) {
  if (input == null || input === '') return null
  const raw = String(input).trim().toLowerCase()
  if (!raw || raw === 'any' || raw === 'clear' || raw === 'none' || raw === 'off') return null
  if (!/^[a-z]{2}$/.test(raw)) {
    const err = new Error('Country must be a 2-letter code like us, ca, de, gb (or "any" to clear)')
    err.code = 'BAD_COUNTRY'
    throw err
  }
  return raw
}

function loadExitCountryPref() {
  try {
    const raw = JSON.parse(readFileSync(EXIT_COUNTRY_PATH, 'utf8'))
    return normalizeCountryCode(raw?.country || raw?.code || null)
  } catch {
    return null
  }
}

function saveExitCountryPref(code) {
  try {
    if (!code) {
      try { unlinkSync(EXIT_COUNTRY_PATH) } catch { /* missing ok */ }
      return
    }
    writeFileSync(
      EXIT_COUNTRY_PATH,
      JSON.stringify({ country: code, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    )
  } catch {
    /* best effort */
  }
}

function controlOk(buf, label = 'control') {
  // Tor replies with 250 OK lines; 5xx is failure
  if (/^5\d\d /m.test(buf) || buf.includes('551 ') || buf.includes('552 ')) {
    const errLine = buf.split(/\r?\n/).find((l) => /^5\d\d /.test(l)) || buf.trim()
    throw new Error(`${label} failed: ${errLine}`)
  }
  if (!buf.includes('250')) {
    throw new Error(`${label} unexpected response: ${buf.trim().slice(0, 200)}`)
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function killListenersOnPort(port) {
  if (process.platform === 'win32') {
    try {
      await execFileAsync('powershell', [
        '-NoProfile', '-Command',
        `$p=(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess|Select-Object -Unique;` +
        'foreach($id in $p){if($id -gt 0){Stop-Process -Id $id -Force -ErrorAction SilentlyContinue}}',
      ], { windowsHide: true })
      await sleep(1000)
      return !(await portOpen(port))
    } catch {
      return false
    }
  }
  return false
}

async function fetchOnionUrl(url, timeoutMs = 90_000) {
  const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${SOCKS_PORT}`)
  const t0 = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (tor-mcp onion-probe)' },
      agent,
      signal: controller.signal,
      redirect: 'follow',
    })
    await res.text().catch(() => '')
    const ms = Date.now() - t0
    return { ok: res.ok, hsReachable: true, status: res.status, finalUrl: res.url, ms }
  } catch (err) {
    const ms = Date.now() - t0
    return {
      ok: false,
      hsReachable: false,
      error: err.message,
      ms,
      instantReject: isInstantSocksReject(err, ms),
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Warm HS circuits: Facebook canary (any HTTP) then DDG (must be ok). */
async function warmHiddenServiceCircuits() {
  await sleep(2000)
  const canary = await fetchOnionUrl(ONION_CANARY_URL)
  const ddg = await fetchOnionUrl(ONION_PROBE_URL, 60_000)
  const ok = canary.hsReachable && ddg.ok
  return {
    ok,
    canary,
    ddg,
    status: ddg.status,
    finalUrl: ddg.finalUrl,
    error: ok ? undefined : (canary.error || ddg.error),
  }
}

async function warmCanaryOnly() {
  const canary = await fetchOnionUrl(ONION_CANARY_URL)
  return { ok: canary.hsReachable, canary }
}

export function isInstantSocksReject(err, ms = null) {
  const msg = err?.message || ''
  if (!/Socks5 proxy rejected/i.test(msg)) return false
  if (ms == null) return true
  return ms < 5000
}

class TorDaemon {
  constructor() {
    this.proc = null
    this.ready = false
    this.external = false
    this.bootstrapPct = 0
    this.startedAt = null
    this.logs = []
    this.torVersion = null
    this.onionOk = null
    this.lastOnionProbe = null
    this.lastOnionProbeAt = null
    this.attachFallback = false
    this._refreshTimer = null
    this._onionOpChain = Promise.resolve()
    this.exitCountry = loadExitCountryPref()
  }

  /** Serialize all hidden-service work — parallel fetches break Tor circuits. */
  withOnionLock(fn) {
    const run = this._onionOpChain.then(fn, fn)
    this._onionOpChain = run.catch(() => {})
    return run
  }

  markOnionFetchFailed(err) {
    this.onionOk = false
    this.lastOnionProbe = { ok: false, source: 'fetch', error: err?.message || String(err) }
    this.lastOnionProbeAt = Date.now()
  }

  async warmWithRetries(maxAttempts = 3) {
    for (let i = 0; i < maxAttempts; i++) {
      const probe = await warmHiddenServiceCircuits()
      this.lastOnionProbe = probe
      this.lastOnionProbeAt = Date.now()
      this.onionOk = probe.ok
      if (probe.ok) {
        this.logs.push(
          `HS warmup OK (canary HTTP ${probe.canary.status}, DDG ${probe.ddg.status})`,
        )
        return probe
      }
      const instant = probe.canary?.instantReject || probe.ddg?.instantReject
      if (i < maxAttempts - 1) {
        this.logs.push(
          `HS warmup ${i + 1}/${maxAttempts} failed${instant ? ' (instant reject)' : ''} — NEWNYM`,
        )
        try { await this.newCircuit() } catch { /* control may be down */ }
        await sleep(instant ? 6000 : 4000)
      }
    }
    return this.lastOnionProbe
  }

  get socksPort() { return SOCKS_PORT }
  get controlPort() { return CONTROL_PORT }
  get proxyUrl() { return `socks5h://127.0.0.1:${SOCKS_PORT}` }

  async readControlBootstrap() {
    const text = await controlTalk(['GETINFO status/bootstrap-phase', 'GETINFO version'])
    const pct = parseBootstrapPct(text)
    this.torVersion = parseTorVersion(text) || this.torVersion
    if (pct != null) this.bootstrapPct = pct
    return { pct, version: this.torVersion, raw: text }
  }

  async validateExistingTor() {
    const controlUp = await portOpen(CONTROL_PORT)
    if (!controlUp) {
      this.logs.push(`SOCKS ${SOCKS_PORT} open but control ${CONTROL_PORT} closed — not tor-mcp Tor`)
      return false
    }

    try {
      const { pct, version } = await this.readControlBootstrap()
      if (pct == null || pct < 100) {
        this.logs.push(`Existing Tor not ready for hidden services (bootstrap ${pct ?? '?'}%)`)
        return false
      }
      if (version) this.logs.push(`Attached to Tor ${version}`)
    } catch (err) {
      this.logs.push(`Control port auth failed on ${CONTROL_PORT}: ${err.message}`)
      return false
    }

    const probe = await this.warmWithRetries(2)
    if (!probe.ok) {
      this.logs.push(
        `Hidden-service warmup failed (${probe.error || 'canary/DDG'}). ` +
        'Use socks5h (remote DNS). If another app owns port 9055, stop it and restart tor-mcp.',
      )
      return false
    }

    this.logs.push('Hidden-service warmup OK (canary + DDG)')
    return true
  }

  async attachToExistingTor() {
    const valid = await this.validateExistingTor()
    if (!valid) return false
    this.external = true
    this.ready = true
    this.startedAt = this.startedAt || new Date().toISOString()
    this.logs.push(`Attached to existing Tor on SOCKS ${SOCKS_PORT}`)
    return true
  }

  async refreshCircuits() {
    if (!(await portOpen(CONTROL_PORT))) {
      throw new Error(`Control port ${CONTROL_PORT} not available for refresh`)
    }
    await this.newCircuit()
    await sleep(4000)
    const probe = await this.warmWithRetries(2)
    this.logs.push(
      probe.ok
        ? 'Auto-refresh OK (canary + DDG)'
        : `Auto-refresh failed (${probe.error || 'warmup'})`,
    )
    return probe
  }

  startAutoRefresh() {
    if (this._refreshTimer || AUTO_REFRESH_MS <= 0) return
    this._refreshTimer = setInterval(() => {
      if (!this.ready) return
      this.refreshCircuits().catch((err) => {
        this.logs.push(`Auto-refresh error: ${err.message}`)
      })
    }, AUTO_REFRESH_MS)
    this._refreshTimer.unref?.()
    this.logs.push(`Auto-refresh every ${Math.round(AUTO_REFRESH_MS / 1000)}s`)
  }

  /**
   * Start tor and wait for "Bootstrapped 100%", then verify .onion works.
   * If SOCKS is already open, validate or recycle — never blind-attach without probe.
   */
  async start(timeoutMs = 120_000) {
    if (this.ready) return
    if (this._startPromise) return this._startPromise

    this._startPromise = (async () => {
      let socksUp = await portOpen(SOCKS_PORT)

      if (socksUp && PREFER_MANAGED) {
        this.logs.push('Prefer-managed: recycling tor on our ports before start')
        await this.recycleTorOnPorts()
        socksUp = await portOpen(SOCKS_PORT)
      }

      if (socksUp) {
        if (await this.attachToExistingTor()) {
          this.attachFallback = PREFER_MANAGED
          try {
            await this.refreshCircuits()
          } catch (err) {
            this.logs.push(`Startup refresh skipped: ${err.message}`)
          }
          this.startAutoRefresh()
          await this.applyStoredExitCountry()
          return
        }
        throw new Error(
          `Port ${SOCKS_PORT} is in use but hidden services (.onion) are not working. ` +
          `Run scripts/Restart-TorMcp.ps1 or quit the other Tor app, then reload Cursor.`,
        )
      }

      await new Promise((resolveStart, reject) => {
        const exe = findTorExe()
        const args = [
          '-f', TORRC,
          '--DataDirectory', TOR_DATA,
          '--SOCKSPort', `127.0.0.1:${SOCKS_PORT}`,
          '--ControlPort', `127.0.0.1:${CONTROL_PORT}`,
        ]

        this.proc = spawn(exe, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          cwd: HERE,
        })

        this.external = false
        this.startedAt = new Date().toISOString()
        const timer = setTimeout(() => reject(new Error(`Tor bootstrap timed out after ${timeoutMs}ms`)), timeoutMs)

        const onData = (data) => {
          const text = data.toString('utf8')
          for (const line of text.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed) continue
            this.logs.push(trimmed)
            if (this.logs.length > 200) this.logs.shift()

            const m = trimmed.match(/Bootstrapped\s+(\d+)%/)
            if (m) {
              this.bootstrapPct = parseInt(m[1])
              if (this.bootstrapPct >= 100) {
                clearTimeout(timer)
                this.proc.stdout?.off('data', onData)
                this.proc.stderr?.off('data', onData)
                resolveStart()
              }
            }
          }
        }

        this.proc.stdout.on('data', onData)
        this.proc.stderr.on('data', onData)

        this.proc.on('error', (err) => {
          clearTimeout(timer)
          this._startPromise = null
          if (!this.ready) reject(new Error(`Failed to launch tor: ${err.message}. Run setup.ps1 to install it.`))
        })

        this.proc.on('exit', (code) => {
          if (this.external) return
          this.ready = false
          this._startPromise = null
          if (code !== 0 && code !== null && !this.ready) {
            clearTimeout(timer)
            reject(new Error(`Tor exited with code ${code}. Check logs: ${this.logs.slice(-5).join(' | ')}`))
          }
        })
      })

      await sleep(3000)
      const probe = await this.warmWithRetries(3)
      this.onionOk = probe.ok
      if (!probe.ok) {
        throw new Error(
          `Tor bootstrapped but HS warmup failed: ${probe.error || 'canary/DDG unreachable'}. ` +
          'Retry tor_status in a minute.',
        )
      }
      this.ready = true
      this.attachFallback = false
      this.logs.push('Managed Tor ready with hidden-service support')
      this.startAutoRefresh()
      await this.applyStoredExitCountry()
    })()

    return this._startPromise
  }

  stop() {
    if (this.proc && !this.external) {
      this.proc.kill()
      this.proc = null
    }
    this.ready = false
    this.external = false
    this.onionOk = null
    this._startPromise = null
  }

  async newCircuit() {
    let cookieHex = readControlCookieHex()

    return new Promise((resolveCircuit, reject) => {
      const sock = createConnection(CONTROL_PORT, '127.0.0.1', () => {
        const auth = cookieHex != null
          ? `AUTHENTICATE ${cookieHex}\r\n`
          : `AUTHENTICATE ""\r\n`
        sock.write(auth + 'SIGNAL NEWNYM\r\nQUIT\r\n')
      })
      let buf = ''
      sock.on('data', (d) => { buf += d.toString() })
      sock.on('end', () => {
        if (buf.includes('250')) resolveCircuit({ ok: true, response: buf.trim() })
        else reject(new Error(`Control port error: ${buf.trim()}`))
      })
      sock.on('error', reject)
      setTimeout(() => { sock.destroy(); reject(new Error('Control port timeout')) }, 5000)
    })
  }

  /**
   * Prefer exits in one country for clearnet fetches.
   * .onion hidden services do NOT use exit nodes — this only affects normal websites.
   * @param {string|null} country ISO alpha-2 or null/"any" to clear
   * @param {{ verify?: boolean }} opts
   */
  async setExitCountry(country, opts = {}) {
    const code = normalizeCountryCode(country)
    if (!(await portOpen(CONTROL_PORT))) {
      throw new Error(`Control port ${CONTROL_PORT} not available — start Tor first`)
    }

    // Soft prefer by default (StrictNodes=0). Strict=1 often hangs when that
    // country has few exits that will connect to the destination.
    const strict = Boolean(opts.strict)
    const commands = code
      ? [`SETCONF ExitNodes={${code}}`, `SETCONF StrictNodes=${strict ? '1' : '0'}`]
      : ['RESETCONF ExitNodes', 'RESETCONF StrictNodes']

    const buf = await controlTalk(commands, 12_000)
    controlOk(buf, 'SETCONF ExitNodes')

    this.exitCountry = code
    saveExitCountryPref(code)
    this.logs.push(
      code
        ? `Exit country set to {${code}} (${strict ? 'strict' : 'prefer'})`
        : 'Exit country cleared (any)',
    )

    await this.newCircuit()
    await sleep(strict ? 5000 : 3500)

    let verified = null
    if (opts.verify === true && code) {
      verified = await this.verifyExitCountry(code)
    }

    return {
      ok: true,
      exitCountry: code,
      exitCountryName: code ? EXIT_COUNTRY_HINTS[code] || null : null,
      strictNodes: strict,
      note: code
        ? `Clearnet exits prefer {${code}}${strict ? ' (strict)' : ''}. .onion sites ignore this setting.`
        : 'Exit country cleared — Tor picks any exit.',
      verified,
      hints: Object.keys(EXIT_COUNTRY_HINTS).sort(),
    }
  }

  /** Best-effort geo check of current clearnet exit (not perfect; CDNs lie). */
  async verifyExitCountry(expected) {
    try {
      const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${SOCKS_PORT}`)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 35_000)
      const res = await fetch('https://ifconfig.co/json', {
        agent,
        headers: { Accept: 'application/json', 'User-Agent': 'tor-mcp-exit-check' },
        signal: controller.signal,
      })
      clearTimeout(timer)
      const data = await res.json()
      const got = String(data?.country_iso || data?.country_code || data?.country || '')
        .trim()
        .toLowerCase()
        .slice(0, 2)
      const ip = data?.ip || null
      return {
        ok: Boolean(got),
        ip,
        country: got || null,
        countryName: data?.country || null,
        matches: expected ? got === expected : null,
        source: 'ifconfig.co',
      }
    } catch (err) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  async applyStoredExitCountry() {
    const code = this.exitCountry ?? loadExitCountryPref()
    this.exitCountry = code
    if (!code) return null
    try {
      return await this.setExitCountry(code, { verify: false })
    } catch (err) {
      this.logs.push(`Could not apply exit country {${code}}: ${err.message}`)
      return { ok: false, error: err.message }
    }
  }

  async shutdownTorOnPorts() {
    try {
      await controlTalk(['SIGNAL SHUTDOWN'])
    } catch {
      /* not our tor or control unavailable */
    }
    for (let i = 0; i < 20; i++) {
      if (!(await portOpen(SOCKS_PORT))) return true
      await sleep(500)
    }
    return !(await portOpen(SOCKS_PORT))
  }

  /** Graceful shutdown, then force-kill listeners if ports stay busy. */
  async recycleTorOnPorts() {
    if (await this.shutdownTorOnPorts()) return true
    this.logs.push('Graceful shutdown did not free ports — force-killing listeners')
    await killListenersOnPort(SOCKS_PORT)
    await killListenersOnPort(CONTROL_PORT)
    return !(await portOpen(SOCKS_PORT))
  }

  /** Stop tor on our ports and start a fresh managed instance. */
  async restart() {
    if (this.proc && !this.external) {
      this.proc.kill()
      this.proc = null
    } else if (await portOpen(SOCKS_PORT)) {
      if (this.external) {
        try {
          await this.refreshCircuits()
          if (this.onionOk) return this.status()
        } catch { /* fall through to recycle */ }
      }
      await this.recycleTorOnPorts()
    }
    this.ready = false
    this.external = false
    this.attachFallback = false
    this.onionOk = null
    this.lastOnionProbe = null
    this.lastOnionProbeAt = null
    this._startPromise = null
    this.bootstrapPct = 0
    this.startedAt = null
    await this.start()
    return this.status()
  }

  status() {
    const s = {
      running: this.ready,
      managed: !!this.proc && !this.external,
      external: this.external,
      bootstrapPct: this.bootstrapPct,
      onionOk: this.onionOk,
      lastOnionProbe: this.lastOnionProbe,
      lastOnionProbeAt: this.lastOnionProbeAt,
      torVersion: this.torVersion,
      startedAt: this.startedAt,
      socksPort: SOCKS_PORT,
      controlPort: CONTROL_PORT,
      proxyUrl: this.proxyUrl,
      exitCountry: this.exitCountry,
      exitCountryName: this.exitCountry ? EXIT_COUNTRY_HINTS[this.exitCountry] || null : null,
      recentLog: this.logs.slice(-5),
    }
    if (OPERATOR_MODE) {
      s.attachFallback = this.attachFallback
      s.preferManaged = PREFER_MANAGED
      s.autoRefreshMs = AUTO_REFRESH_MS
      s.operatorMode = true
    }
    return s
  }

  /** Pre-fetch HS check: canary when recently warm; full warm if last fetch failed. */
  async ensureOnionReady(maxAgeMs = 30_000) {
    if (!this.ready) await this.start()
    const cacheMs = OPERATOR_MODE ? 0 : maxAgeMs
    const age = this.lastOnionProbeAt ? Date.now() - this.lastOnionProbeAt : Infinity
    if (cacheMs > 0 && age <= cacheMs && this.onionOk === true) return true

    if (this.onionOk === false) {
      const probe = await this.warmWithRetries(2)
      if (!probe.ok) {
        throw new Error(
          `Hidden service warmup failed (${probe.error || 'canary/DDG'}). ` +
          'Run tor_restart if this persists.',
        )
      }
      return true
    }

    const canary = await warmCanaryOnly()
    this.lastOnionProbe = { ok: canary.ok, source: 'canary', canary: canary.canary }
    this.lastOnionProbeAt = Date.now()
    this.onionOk = canary.ok
    if (!canary.ok) {
      const probe = await this.warmWithRetries(2)
      if (!probe.ok) {
        throw new Error(
          `HS canary failed (${canary.canary.error || 'instant reject'}). ` +
          'Circuits not ready for hidden services.',
        )
      }
    }
    return true
  }
}

export const torDaemon = new TorDaemon()

/** Convenience: ensure Tor is up, then return the proxy URL */
export async function ensureTor({ onion = false } = {}) {
  if (!torDaemon.ready) await torDaemon.start()
  if (onion) {
    await torDaemon.withOnionLock(() => torDaemon.ensureOnionReady())
  }
  return torDaemon.proxyUrl
}

export function isRecoverableTorError(err) {
  const msg = err?.message || ''
  return /Socks5 proxy rejected|ECONNREFUSED|socket hang up|ETIMEDOUT|aborted/i.test(msg)
}

function shutdownOnExit() {
  if (torDaemon.proc && !torDaemon.external) {
    try { torDaemon.proc.kill() } catch { /* ignore */ }
  }
  /* Do not kill external/attached tor — may belong to another app on 9055 */
}

process.on('exit', shutdownOnExit)
process.on('SIGINT', () => { shutdownOnExit(); process.exit(0) })
process.on('SIGTERM', () => { shutdownOnExit(); process.exit(0) })
