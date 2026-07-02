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

const HERE = dirname(fileURLToPath(import.meta.url))

const SOCKS_PORT = parseInt(process.env.TOR_SOCKS_PORT || '9055')
const CONTROL_PORT = parseInt(process.env.TOR_CONTROL_PORT || '9056')
const TORRC = resolve(HERE, 'torrc')
const TOR_DATA = resolve(HERE, 'tor-data')

function findTorExe() {
  if (process.env.TOR_BIN && existsSync(process.env.TOR_BIN)) return process.env.TOR_BIN
  const bundled = resolve(HERE, 'tor-bin', 'tor.exe')
  if (existsSync(bundled)) return bundled
  // Try PATH (Linux/macOS 'tor', Windows 'tor.exe')
  const fromPath = process.platform === 'win32' ? 'tor.exe' : 'tor'
  return fromPath
}

function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = createConnection(port, host)
    const done = (open) => {
      sock.removeAllListeners()
      sock.destroy()
      resolve(open)
    }
    sock.setTimeout(timeoutMs)
    sock.on('connect', () => done(true))
    sock.on('timeout', () => done(false))
    sock.on('error', () => done(false))
  })
}

class TorDaemon {
  constructor() {
    this.proc = null
    this.ready = false
    this.external = false  // true when reusing an already-running tor on our ports
    this.bootstrapPct = 0
    this.startedAt = null
    this.logs = []
  }

  get socksPort() { return SOCKS_PORT }
  get controlPort() { return CONTROL_PORT }
  get proxyUrl() { return `socks5h://127.0.0.1:${SOCKS_PORT}` }

  /**
   * Start tor and wait for "Bootstrapped 100%".
   * If SOCKS port is already open (e.g. tor started manually or by another session),
   * attach to the existing daemon instead of spawning a second one.
   */
  async start(timeoutMs = 120_000) {
    if (this.ready) return
    if (this._startPromise) return this._startPromise

    this._startPromise = (async () => {
      const socksUp = await portOpen(SOCKS_PORT)
      if (socksUp) {
        this.external = true
        this.ready = true
        this.bootstrapPct = 100
        this.startedAt = this.startedAt || new Date().toISOString()
        this.logs.push(`Attached to existing Tor on SOCKS ${SOCKS_PORT}`)
        return
      }

      await new Promise((resolve, reject) => {
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
                this.ready = true
                clearTimeout(timer)
                this.proc.stdout?.off('data', onData)
                this.proc.stderr?.off('data', onData)
                resolve()
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
    this._startPromise = null
  }

  /**
   * Send NEWNYM to the control port — asks Tor for a fresh circuit / new exit IP.
   * Authenticates using the cookie file written by Tor (CookieAuthentication 1).
   * Returns within ~1s; the new circuit is ready a few seconds after.
   */
  async newCircuit() {
    // Read the cookie Tor wrote to the data directory
    let cookieHex = ''
    try {
      const cookiePath = resolve(TOR_DATA, 'control_auth_cookie')
      const cookieBytes = readFileSync(cookiePath)
      cookieHex = cookieBytes.toString('hex').toUpperCase()
    } catch {
      // Fallback: try unauthenticated (works if no password was set)
      cookieHex = null
    }

    return new Promise((resolve, reject) => {
      const sock = createConnection(CONTROL_PORT, '127.0.0.1', () => {
        const auth = cookieHex != null
          ? `AUTHENTICATE ${cookieHex}\r\n`
          : `AUTHENTICATE ""\r\n`
        sock.write(auth + 'SIGNAL NEWNYM\r\nQUIT\r\n')
      })
      let buf = ''
      sock.on('data', (d) => { buf += d.toString() })
      sock.on('end', () => {
        if (buf.includes('250')) resolve({ ok: true, response: buf.trim() })
        else reject(new Error(`Control port error: ${buf.trim()}`))
      })
      sock.on('error', reject)
      setTimeout(() => { sock.destroy(); reject(new Error('Control port timeout')) }, 5000)
    })
  }

  status() {
    return {
      running: this.ready,
      managed: !!this.proc && !this.external,
      external: this.external,
      bootstrapPct: this.bootstrapPct,
      startedAt: this.startedAt,
      socksPort: SOCKS_PORT,
      controlPort: CONTROL_PORT,
      proxyUrl: this.proxyUrl,
      recentLog: this.logs.slice(-3),
    }
  }
}

// Singleton
export const torDaemon = new TorDaemon()

/** Convenience: ensure Tor is up, then return the proxy URL */
export async function ensureTor() {
  if (!torDaemon.ready) await torDaemon.start()
  return torDaemon.proxyUrl
}
