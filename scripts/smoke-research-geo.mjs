import { torDaemon, ensureTor } from '../tor-daemon.mjs'
import { SocksProxyAgent } from 'socks-proxy-agent'
import fetch from 'node-fetch'
import { runGeoCompare, runResearch } from '../research.mjs'

async function torFetch(url, { timeoutMs = 55_000, headers = {} } = {}) {
  const proxyUrl = await ensureTor({ onion: url.includes('.onion') })
  const agent = new SocksProxyAgent(proxyUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), url.includes('.onion') ? Math.max(timeoutMs, 90_000) : timeoutMs)
  try {
    const res = await fetch(url, {
      agent,
      headers: { 'User-Agent': 'tor-mcp-smoke', ...headers },
      signal: controller.signal,
    })
    const text = await res.text()
    let json = null
    if (res.headers.get('content-type')?.includes('application/json')) {
      try { json = JSON.parse(text) } catch { /* */ }
    }
    return { ok: res.ok, status: res.status, url: res.url, body: json ?? text.slice(0, 48_000) }
  } finally {
    clearTimeout(timer)
  }
}

const report = { passed: 0, failed: 0, steps: [] }
function ok(name, detail) {
  report.passed++
  report.steps.push({ name, ok: true, detail })
  console.log('✓', name, detail || '')
}
function fail(name, detail) {
  report.failed++
  report.steps.push({ name, ok: false, detail })
  console.error('✗', name, detail || '')
}

try {
  await ensureTor({ onion: false })
  try { await torDaemon.setExitCountry('any', { verify: false }) } catch { /* */ }
  ok('tor_ready', torDaemon.status().bootstrapPct)

  const direct = await runResearch(torFetch, {
    urls: ['https://en.wikipedia.org/wiki/Canadian_dollar'],
    maxPages: 1,
    followSearchHits: false,
  })
  if (direct.ok && direct.pages[0]?.title) ok('research_direct', direct.pages[0].title)
  else fail('research_direct', direct.errors)

  const search = await runResearch(torFetch, {
    query: 'quiet desk fan',
    maxSearchHits: 3,
    maxPages: 1,
    followSearchHits: false,
  })
  if (search.searchHits.length) ok('research_ddg', `${search.searchHits.length} hits`)
  else fail('research_ddg', search.errors)

  const deals = await runGeoCompare(torFetch, async () => ({ ok: true }), {
    urls: [
      'https://en.wikipedia.org/wiki/United_States_dollar',
      'https://en.wikipedia.org/wiki/Canadian_dollar',
    ],
  })
  if (deals.ok && deals.results.filter((r) => r.ok).length >= 2) ok('geo_urls', '2 pages')
  else fail('geo_urls', deals)

} catch (err) {
  fail('fatal', err.message)
  console.error(err)
} finally {
  try { await torDaemon.setExitCountry('any', { verify: false }) } catch { /* */ }
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, steps: report.steps }, null, 2))
  process.exit(report.failed ? 1 : 0)
}
