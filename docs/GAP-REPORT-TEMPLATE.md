# Venue Wire — daily gap post template

Pull live data first:

```
curl -s https://aizamon.com/venue-wire/gaps
```

Or in Cursor with aizamon-mcp: `aizamon_free_venue_gaps`.

---

## Post body

**Title:** Polymarket vs Kalshi: {topic} — {gapCents}¢ gap

```
Venue Wire scan @ {scannedAt}

Topic: {topic}
Gap: {gapCents}¢ (match {matchScore})
Kalshi YES: {kalshi.yes} — {kalshi.url}
Polymarket YES: {polymarket.yes} — {polymarket.url}
Hint: {hint}

Free JSON feed (auto-refreshed):
https://aizamon.com/venue-wire/gaps

Want the live Bot Fuel card (net-edge hints) mid-loop?
- Agents: $0.25 USDC → SKU_AG_BOT_FUEL_01
  https://aizamon.com/x402/v1/bot-fuel
- Cursor MCP: https://github.com/jordymoney/tor-mcp/tree/main/aizamon-mcp

No cut of your PnL. Signal only.
```

---

## Cadence

1. Post when `gapCents >= 8` and matchScore looks sane
2. Link free feed every time (builds trust)
3. Soft CTA to Bot Fuel — never dump the whole store
