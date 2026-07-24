# Distribution drafts — tor-mcp + Aizamon MCP

Post these after merging. Goal: unlocks ($12–19) + Bot Fuel micros ($0.25+).

---

## Show HN — tor-mcp

**Title:** Show HN: tor-mcp – anonymous Tor web access for Cursor/Claude agents

**Body:**

```
I built an MCP server that gives AI coding agents anonymous internet access
through a local Tor daemon — clearnet + .onion, with circuit rotate and a
geo deal-scout tool.

Install (Windows):
  irm https://aizamon.com/install/Install-TorMcp.ps1 | iex

Or clone https://github.com/jordymoney/tor-mcp → setup → point Cursor mcp.json
at server.mjs.

25 free successful fetches. Circuit rotate is free. Then a one-time unlock
(~$12–19) if you want unlimited.

Why: agent web tools usually leak your IP into every analytics pixel. Tor
routes DNS inside the SOCKS tunnel (socks5h). Client-only node — never relays.

Demo prompts for Cursor:
  1) tor_status
  2) tor_fetch https://check.torproject.org/api/ip
  3) tor_new_circuit → fetch again (new exit)
  4) tor_research query="…"  (DDG onion + extract)

Companion commerce MCP (same repo, aizamon-mcp/): free Polymarket↔Kalshi
gaps → $0.25 Bot Fuel intent without leaving chat.

Happy to take heat on the trial/unlock model — MIT source, paid unlimited key.
```

---

## Reddit — r/cursor / r/LocalLLaMA / r/MCP

**Title:** Anonymous web access for Cursor agents via Tor (MCP, 25 free uses)

```
Built tor-mcp so Cursor can fetch URLs without burning my home IP.

- Local Tor daemon managed by the MCP (ports 9055/9056)
- tor_fetch / tor_post / tor_research / tor_geo_compare
- .onion works (DDG onion search built into research)
- One-command Windows install: https://aizamon.com/install/tor-mcp
- Source: https://github.com/jordymoney/tor-mcp

Not a VPN app. Not Tor Browser. It's for your *agent*.

Also shipping aizamon-mcp in the same tree — free venue gaps + agent
checkout tools so Cursor can open a $0.25 Bot Fuel intent mid-chat.

Feedback welcome on install friction.
```

---

## X / Bluesky short

```
Cursor agents leak your IP on every fetch.

tor-mcp: local Tor + MCP tools. .onion, circuit rotate, geo deal scout.
25 free uses → https://aizamon.com/install/tor-mcp

Need signal not anonymity? aizamon-mcp → free Polymarket↔Kalshi gaps,
then $0.25 Bot Fuel.
```

---

## Prediction-market thread (r/Polymarket / Discord)

**Title:** Free Polymarket vs Kalshi gap feed + $0.25 Bot Fuel from Cursor

```
Live free gaps (JSON, refreshed ~30m):
  https://aizamon.com/venue-wire/gaps

If you're running a Cursor/Claude agent, install aizamon-mcp from
https://github.com/jordymoney/tor-mcp/tree/main/aizamon-mcp

Then:
  aizamon_free_venue_gaps
  aizamon_purchase_intent({ sku: "SKU_AG_BOT_FUEL_01" })  // after you confirm
  pay USDC on Base → aizamon_checkout_settle

No profit-share. You buy the card, you keep the PnL.
```

---

## Directory PR checklist

- [ ] awesome-mcp-servers — add tor-mcp under Browser / Privacy
- [ ] MCP registry / pulse.mcp if listed
- [ ] npm publish `tor-mcp` + `@aizamon/mcp` (see package.json bin fields)
- [ ] Link both from aizamon.com/llms.txt (already partially there)

---

## npm publish notes

```bash
# from repo root (tor-mcp)
npm publish --access public

# from aizamon-mcp/
cd aizamon-mcp && npm publish --access public
```

Requires npm login on the machine that owns the @aizamon org (or drop scope).
