/**
 * Structured research helpers for Tor MCP — extract money-relevant signals from HTML.
 */
const DDG_ONION =
  'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/html/'

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function extractTitle(html) {
  const og =
    html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/content=["']([^"']+)["']\s+property=["']og:title["']/i)?.[1]
  if (og) return stripTags(og).slice(0, 200)
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  return t ? stripTags(t).slice(0, 200) : null
}

function extractDescription(html) {
  const og =
    html.match(/property=["']og:description["']\s+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/name=["']description["']\s+content=["']([^"']+)["']/i)?.[1]
  return og ? stripTags(og).slice(0, 400) : null
}

/** Pull currency-looking amounts from page text / common ecommerce markup. */
function extractPrices(html) {
  const text = stripTags(html).slice(0, 80_000)
  const found = []
  const patterns = [
    /(?:CAD|USD|EUR|GBP|C\$|US\$|\$|€|£)\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/gi,
    /([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)\s?(?:CAD|USD|EUR|GBP)/gi,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(text)) !== null) {
      const raw = m[0].replace(/\s+/g, ' ').trim()
      if (raw.length < 2 || raw.length > 24) continue
      found.push(raw)
      if (found.length >= 12) break
    }
    if (found.length >= 12) break
  }
  // JSON-LD offers
  const ldBlocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
  for (const block of ldBlocks.slice(0, 6)) {
    try {
      const data = JSON.parse(block[1])
      const nodes = Array.isArray(data) ? data : [data]
      for (const n of nodes) {
        const offer = n?.offers || n?.Offer
        const list = Array.isArray(offer) ? offer : offer ? [offer] : []
        for (const o of list) {
          if (o?.price != null) {
            const cur = o.priceCurrency || ''
            found.push(`${cur} ${o.price}`.trim())
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  return [...new Set(found)].slice(0, 10)
}

function extractStockHints(html) {
  const t = stripTags(html).toLowerCase()
  const hints = []
  if (/\bout of stock\b|\bsold out\b|\bunavailable\b/.test(t)) hints.push('out_of_stock')
  if (/\bin stock\b|\bavailable to ship\b|\badd to cart\b/.test(t)) hints.push('in_stock_likely')
  if (/\blimited stock\b|\bonly \d+ left\b/.test(t)) hints.push('limited')
  return hints
}

function extractSnippets(html, max = 4) {
  const text = stripTags(html)
  if (!text) return []
  // Prefer mid-page chunks that look like sentences
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 60 && p.length < 280)
  return parts.slice(0, max)
}

export function extractPageSignals(html, url) {
  const title = extractTitle(html)
  const description = extractDescription(html)
  const prices = extractPrices(html)
  const stock = extractStockHints(html)
  const snippets = extractSnippets(html)
  return {
    url,
    title,
    description,
    prices,
    stock,
    snippets,
    bytes: Buffer.byteLength(html || '', 'utf8'),
  }
}

function resolveDdgHref(raw) {
  if (!raw) return null
  let href = decodeEntities(String(raw)).trim()
  if (href.includes('uddg=') || href.startsWith('/l/?')) {
    try {
      const abs = href.startsWith('http') ? href : `https://duckduckgo.com${href.startsWith('/') ? href : `/${href}`}`
      const u = new URL(abs)
      const uddg = u.searchParams.get('uddg')
      if (uddg) href = uddg
    } catch {
      const m = href.match(/uddg=([^&]+)/i)
      if (m) {
        try {
          href = decodeURIComponent(m[1])
        } catch {
          href = m[1]
        }
      }
    }
  }
  // Skip DDG ad redirectors
  if (/duckduckgo\.com\/y\.js/i.test(href) || /bing\.com\/aclick/i.test(href)) return null
  return href.startsWith('http') ? href : null
}

export function parseDdgHtmlResults(html, limit = 5) {
  const results = []
  // DDG uses class="links_main links_deep result__body" — not a solo class attr
  const blocks = html.split(/\bresult__body\b/i).slice(1)
  for (const block of blocks) {
    // Ad marker usually sits on the parent result div just before this chunk
    if (/result--ad/i.test(block.slice(0, 80))) continue
    const aTag =
      block.match(/<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>/i)?.[0] ||
      block.match(/class="result__a"[^>]*>/i)?.[0] ||
      ''
    const hrefRaw =
      aTag.match(/\bhref="([^"]+)"/i)?.[1] ||
      block.match(/class="result__a"[^>]*href="([^"]+)"/i)?.[1] ||
      block.match(/href="([^"]+)"[^>]*class="[^"]*result__a/i)?.[1]
    const href = resolveDdgHref(hrefRaw)
    const title = stripTags(
      block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ||
        block.match(/class="result__title"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ||
        '',
    )
    const snippet = stripTags(
      block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i)?.[1] || '',
    )
    if (title && href) {
      results.push({ title: title.slice(0, 160), url: href, snippet: snippet.slice(0, 240) })
    }
    if (results.length >= limit) break
  }
  return results
}

export function ddgOnionSearchUrl(query) {
  return `${DDG_ONION}?q=${encodeURIComponent(query)}`
}

/**
 * Build a short money-oriented summary from extracted pages.
 */
export function summarizeResearch({ query, searchHits, pages }) {
  const priceHits = pages.flatMap((p) => (p.prices || []).map((price) => ({ url: p.url, title: p.title, price })))
  const stockNotes = pages
    .filter((p) => (p.stock || []).length)
    .map((p) => ({ url: p.url, title: p.title, stock: p.stock }))
  return {
    query: query || null,
    searchHitCount: (searchHits || []).length,
    pagesFetched: (pages || []).length,
    priceHits: priceHits.slice(0, 20),
    stockNotes,
    topTitles: (pages || []).map((p) => p.title).filter(Boolean).slice(0, 8),
  }
}

/**
 * @param {(url: string, opts?: object) => Promise<{ok:boolean,status:number,url:string,body:any,contentType?:string}>} fetchFn
 */
export async function runResearch(fetchFn, {
  query = null,
  urls = [],
  maxSearchHits = 5,
  maxPages = 4,
  followSearchHits = true,
} = {}) {
  const searchHits = []
  const pages = []
  const errors = []

  if (query) {
    const searchUrl = ddgOnionSearchUrl(query)
    try {
      const res = await fetchFn(searchUrl, { timeoutMs: 90_000 })
      const html = typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
      if (!res.ok) {
        errors.push({ step: 'search', url: searchUrl, status: res.status })
      } else {
        searchHits.push(...parseDdgHtmlResults(html, maxSearchHits))
      }
    } catch (err) {
      errors.push({ step: 'search', url: searchUrl, error: err.message })
    }
  }

  const toFetch = []
  for (const u of urls || []) {
    if (u && typeof u === 'string' && u.startsWith('http')) toFetch.push(u)
  }
  if (followSearchHits) {
    for (const hit of searchHits) {
      if (toFetch.length >= maxPages) break
      if (!toFetch.includes(hit.url)) toFetch.push(hit.url)
    }
  }

  for (const url of toFetch.slice(0, maxPages)) {
    try {
      const res = await fetchFn(url, {
        timeoutMs: url.includes('.onion') ? 90_000 : 35_000,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })
      const raw = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? '')
      if (!res.ok) {
        errors.push({ step: 'fetch', url, status: res.status })
        pages.push({
          url,
          title: null,
          description: null,
          prices: [],
          stock: [],
          snippets: [],
          status: res.status,
          ok: false,
        })
        continue
      }
      const signals = extractPageSignals(raw, res.url || url)
      pages.push({ ...signals, status: res.status, ok: true })
    } catch (err) {
      errors.push({ step: 'fetch', url, error: err.message })
      pages.push({
        url,
        title: null,
        description: null,
        prices: [],
        stock: [],
        snippets: [],
        ok: false,
        error: err.message,
      })
    }
  }

  return {
    ok: pages.some((p) => p.ok) || searchHits.length > 0,
    query: query || null,
    searchHits,
    pages,
    summary: summarizeResearch({ query, searchHits, pages }),
    errors: errors.slice(0, 12),
  }
}

/**
 * Geo / deal scout.
 *
 * Mode A — urls[]: fetch locale storefronts (amazon.ca vs .com) — reliable for affiliate.
 * Mode B — url + countries[]: soft-prefer Tor exits and re-fetch (best-effort; strict often hangs).
 */
export async function runGeoCompare(fetchFn, setCountryFn, {
  url = null,
  urls = null,
  countries = ['de', 'nl'],
  settleMs = 3000,
  matchAttempts = 4,
  strict = false,
  newCircuitFn = null,
} = {}) {
  const localeUrls = (urls || []).filter(
    (u) => typeof u === 'string' && u.startsWith('http') && !u.includes('.onion'),
  )

  if (localeUrls.length >= 1) {
    const results = []
    for (const pageUrl of localeUrls.slice(0, 6)) {
      try {
        const res = await fetchFn(pageUrl, {
          timeoutMs: 50_000,
          headers: {
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        })
        const raw = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? '')
        const signals = extractPageSignals(raw, res.url || pageUrl)
        let host = null
        try { host = new URL(pageUrl).hostname } catch { /* */ }
        results.push({
          url: pageUrl,
          host,
          ok: res.ok,
          status: res.status,
          title: signals.title,
          prices: signals.prices,
          stock: signals.stock,
          snippets: signals.snippets.slice(0, 2),
          description: signals.description,
        })
      } catch (err) {
        results.push({ url: pageUrl, ok: false, error: err.message, prices: [], title: null })
      }
    }
    return {
      ok: results.some((r) => r.ok),
      mode: 'urls',
      results,
      priceDiffs: results
        .filter((r) => r.ok && (r.prices || []).length)
        .map((r) => ({ host: r.host, url: r.url, prices: r.prices, title: r.title })),
      note: 'Compared locale URLs through Tor (no exit pin). Best for Amazon CA/US/DE deal scouting.',
    }
  }

  if (!url || !url.startsWith('http')) {
    throw new Error('Provide url (+ countries) or urls[] locale list')
  }
  if (url.includes('.onion')) {
    throw new Error('Geo compare is clearnet-only — .onion ignores exit country')
  }

  const codes = [...new Set(
    (countries || [])
      .map((c) => String(c || '').trim().toLowerCase())
      .filter((c) => /^[a-z]{2}$/.test(c)),
  )].slice(0, 6)

  if (!codes.length) throw new Error('Provide at least one ISO country code (us, ca, de, …)')

  async function probeExit() {
    const res = await fetchFn('https://ifconfig.co/json', { timeoutMs: 40_000 })
    const body = typeof res.body === 'object' && res.body ? res.body : null
    const iso = String(body?.country_iso || body?.countryCode || '')
      .trim()
      .toLowerCase()
      .slice(0, 2)
    return {
      ok: res.ok && Boolean(iso),
      ip: body?.ip || null,
      country: body?.country || null,
      country_iso: iso || null,
    }
  }

  async function recoverCircuits() {
    try { await setCountryFn('any', { strict: false }) } catch { /* */ }
    if (newCircuitFn) {
      try { await newCircuitFn() } catch { /* */ }
    }
    await new Promise((r) => setTimeout(r, 2500))
  }

  async function alignExit(country) {
    let setInfo = await setCountryFn(country, { strict: false })
    let lastProbe = null
    for (let i = 0; i < matchAttempts; i++) {
      await new Promise((r) => setTimeout(r, settleMs))
      try {
        lastProbe = await probeExit()
        if (lastProbe.country_iso === country) {
          return { setInfo, probe: lastProbe, matched: true, attempts: i + 1 }
        }
      } catch (err) {
        lastProbe = { ok: false, error: err.message }
        await recoverCircuits()
        setInfo = await setCountryFn(country, { strict: false })
        continue
      }
      if (newCircuitFn) {
        try { await newCircuitFn() } catch { /* */ }
      }
    }
    return { setInfo, probe: lastProbe, matched: false, attempts: matchAttempts }
  }

  const results = []
  for (const country of codes) {
    let align = null
    try {
      align = await alignExit(country)
      const res = await fetchFn(url, {
        timeoutMs: 50_000,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })
      const raw = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? '')
      let geoHint = align?.probe || null
      try {
        const j = typeof res.body === 'object' && res.body ? res.body : JSON.parse(raw)
        if (j?.country_iso || j?.country) {
          geoHint = {
            ip: j.ip || j.query || null,
            country: j.country || null,
            country_iso: String(j.country_iso || j.countryCode || '').toLowerCase().slice(0, 2) || null,
          }
        }
      } catch {
        /* not json */
      }
      const signals = extractPageSignals(raw, res.url || url)
      results.push({
        requestedCountry: country,
        matchedExit: Boolean(align?.matched) || geoHint?.country_iso === country,
        exitAttempts: align?.attempts || null,
        setOk: align?.setInfo?.ok !== false,
        verifiedExit: align?.probe || null,
        status: res.status,
        ok: res.ok,
        geoHint,
        title: signals.title,
        prices: signals.prices,
        stock: signals.stock,
        snippets: signals.snippets.slice(0, 2),
        description: signals.description,
      })
    } catch (err) {
      results.push({
        requestedCountry: country,
        ok: false,
        error: err.message,
        matchedExit: Boolean(align?.matched),
        setOk: align?.setInfo?.ok !== false,
        verifiedExit: align?.probe || null,
      })
      await recoverCircuits()
    }
  }

  try {
    await setCountryFn('any', { strict: false })
  } catch {
    /* best effort */
  }

  return {
    ok: results.some((r) => r.ok),
    mode: 'exit_country',
    url,
    countries: codes,
    strict: false,
    distinctExitCountries: [...new Set(results.map((r) => r.geoHint?.country_iso).filter(Boolean))],
    results,
    priceDiffs: results
      .filter((r) => r.ok && (r.prices || []).length)
      .map((r) => ({ country: r.requestedCountry, prices: r.prices, title: r.title, matchedExit: r.matchedExit })),
    note: 'Exit-country mode is best-effort. Prefer urls[] (amazon.ca vs amazon.com) for deal scouting.',
  }
}

export { DDG_ONION, stripTags, extractTitle }

