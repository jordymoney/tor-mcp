#!/usr/bin/env node
/** One-at-a-time onion sweep — run from tor-mcp dir. Do not run while MCP is fetching. */
import fetch from 'node-fetch'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { torDaemon, MCP_VERSION, isInstantSocksReject } from '../tor-daemon.mjs'

const SITES = [
  { name: 'Facebook-canary', url: 'https://facebookwkhpilnemxj7asaniu7vnjjbiltxjqhye3mhbshg7kx5tfyd.onion/' },
  { name: 'DDG', url: 'http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/' },
  { name: 'Brave', url: 'https://brave4u7jddbv7cevdebnyra7nuwccqgdlqbjd.onion/' },
  { name: 'Archive', url: 'http://archiveiya74codqgi.onion/' },
  { name: 'ProtonMail', url: 'https://protonmailrmez3lotccipshtkleegetol5jk8ok45wcphc5nyggnetochr.onion/' },
]

async function tryUrl(name, url, proxy) {
  const agent = new SocksProxyAgent(proxy)
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      agent,
      redirect: 'follow',
      headers: { 'User-Agent': 'tor-mcp-sweep/1.1' },
      signal: AbortSignal.timeout(90_000),
    })
    const ms = Date.now() - t0
    const body = (await res.text()).slice(0, 80)
    return {
      name,
      kind: 'HS',
      status: res.status,
      ms,
      instantReject: false,
      bodyPreview: body.replace(/\s+/g, ' ').trim(),
    }
  } catch (err) {
    const ms = Date.now() - t0
    return {
      name,
      kind: 'ERR',
      error: err.message?.slice(0, 100),
      ms,
      instantReject: isInstantSocksReject(err, ms),
    }
  }
}

await torDaemon.start()
const proxy = torDaemon.proxyUrl
console.log('proxy', proxy, 'mcpVersion', MCP_VERSION)
for (const s of SITES) {
  const r = await torDaemon.withOnionLock(() => tryUrl(s.name, s.url, proxy))
  console.log(JSON.stringify(r))
  await new Promise((resolve) => setTimeout(resolve, 3000))
}
