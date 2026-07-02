/**
 * TorDaemon — manages the tor.exe lifecycle and control-port interactions.
 *
 * Looks for tor.exe in (priority order):
 *   1. TOR_BIN env var
 *   2. ./tor-bin/tor.exe  (placed here by setup.ps1)
 *   3. PATH
 */
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import fetch from 'node-fetch'
import { SocksProxyAgent } from 'socks-proxy-agent'

const HERE = dirname(fileURLToPath(import.meta.url))

const SOCKS_PORT = parseInt(process.env.TOR_SOCKS_PORT || '9055')
const CONTROL_PORT = parseInt(process.env.TOR_CONTROL_PORT || '9056')
const TORRC = resolve(HERE, 'torrc')
const TOR_DATA = resolve(HERE, 'tor-data')

/** Known v3 onion used only for local health checks (DuckDuckGo). */
const ONION_PROBE_URL =
  process.env.TOR_ONION_PROBE_URL ||
  'http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/'

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

export const MCP_VERSION = '1.2.2'

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function probeOnion(timeoutMs = 60_000) {
  const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${SOCKS_PORT}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // Match tor_fetch: follow redirects to the final hidden-service response.
    const res = await fetch(ONION_PROBE_URL, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (tor-mcp onion-probe)' },
      agent,
      signal: controller.signal,
      redirect: 'follow',
    })
    return { ok: res.ok, status: res.status, finalUrl: res.url }
  } catch (err) {
    return { ok: false, error: err.message }
  } finally {
    clearTimeout(timer)
  }
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

    const probe = await probeOnion()
    this.lastOnionProbe = probe
    this.lastOnionProbeAt = Date.now()
    this.onionOk = probe.ok
    if (!probe.ok) {
      this.logs.push(
        `Hidden-service probe failed (${probe.error || `HTTP ${probe.status}`}). ` +
        'Use socks5h (remote DNS). If another app owns port 9055, stop it and restart tor-mcp.',
      )
      return false
    }

    this.logs.push('Hidden-service probe OK (.onion reachable)')
    return true
  }

  /**
   * Start tor and wait for "Bootstrapped 100%", then verify .onion works.
   * If SOCKS is already open, validate it is our Tor with HS support — never blind-attach.
   */
  async start(timeoutMs = 120_000) {
    if (this.ready) return
    if (this._startPromise) return this._startPromise

    this._startPromise = (async () => {
      const socksUp = await portOpen(SOCKS_PORT)
      if (socksUp) {
        const valid = await this.validateExistingTor()
        if (valid) {
          this.external = true
          this.ready = true
          this.startedAt = this.startedAt || new Date().toISOString()
          this.logs.push(`Attached to existing Tor on SOCKS ${SOCKS_PORT}`)
          return
        }
        throw new Error(
          `Port ${SOCKS_PORT} is in use but hidden services (.onion) are not working. ` +
          `Stop the process on ${SOCKS_PORT}/${CONTROL_PORT} and reload Cursor so tor-mcp can start its own tor.exe.`,
        )
      }

      await new Promise((resolveStart, reject) => {
        const exe = findTorExe()
        const args = [
          '-f', TORRC,
          '--DataDirectory', TOR_DATA,
          '--SOCKSPort', String(SOCKS_PORT),
          '--ControlPort', String(CONTROL_PORT),
        ]

        this.proc = spawn(exe, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
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

      const probe = await probeOnion()
      this.lastOnionProbe = probe
      this.lastOnionProbeAt = Date.now()
      this.onionOk = probe.ok
      if (!probe.ok) {
        throw new Error(
          `Tor bootstrapped but .onion probe failed: ${probe.error || `HTTP ${probe.status}`}. ` +
          'Check system clock and network; retry tor_status in a minute.',
        )
      }
      this.ready = true
      this.logs.push('Managed Tor ready with hidden-service support')
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

  async shutdownTorOnPorts() {
    try {
      await controlTalk(['SIGNAL SHUTDOWN'])
    } catch {
      /* port may already be down */
    }
    for (let i = 0; i < 30; i++) {
      if (!(await portOpen(SOCKS_PORT))) return true
      await sleep(500)
    }
    return !(await portOpen(SOCKS_PORT))
  }

  /** Stop tor on our ports and start a fresh managed instance. */
  async restart() {
    if (this.proc && !this.external) {
      this.proc.kill()
      this.proc = null
    } else if (await portOpen(SOCKS_PORT)) {
      await this.shutdownTorOnPorts()
    }
    this.ready = false
    this.external = false
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
    return {
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
      recentLog: this.logs.slice(-5),
    }
  }

  /** Re-probe hidden services before billable .onion fetches (cached ~30s). */
  async ensureOnionReady(maxAgeMs = 30_000) {
    if (!this.ready) await this.start()
    const age = this.lastOnionProbeAt ? Date.now() - this.lastOnionProbeAt : Infinity
    if (age <= maxAgeMs && this.onionOk === true) return true
    const probe = await probeOnion()
    this.lastOnionProbe = probe
    this.lastOnionProbeAt = Date.now()
    this.onionOk = probe.ok
    if (!probe.ok) {
      throw new Error(
        `Hidden service probe failed (${probe.error || `HTTP ${probe.status}`}). ` +
        'Reload Cursor to restart tor-mcp, or stop other apps on port 9055.',
      )
    }
    return true
  }
}

export const torDaemon = new TorDaemon()

/** Convenience: ensure Tor is up, then return the proxy URL */
export async function ensureTor({ onion = false } = {}) {
  if (!torDaemon.ready) await torDaemon.start()
  if (onion) await torDaemon.ensureOnionReady()
  return torDaemon.proxyUrl
}

export function isRecoverableTorError(err) {
  const msg = err?.message || ''
  return /Socks5 proxy rejected|ECONNREFUSED|socket hang up|ETIMEDOUT|aborted/i.test(msg)
}
