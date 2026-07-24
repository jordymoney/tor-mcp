# @aizamon/mcp

**Cursor / Claude MCP for [Aizamon](https://aizamon.com) agent commerce.**

Browse free Polymarket↔Kalshi gaps, open a $0.25 Bot Fuel intent, fulfill after payment, grab Tor Pro checkout links — without leaving the chat.

This package is a **thin local stdio MCP**. It talks HTTPS to `aizamon.com` (already hosted). It does **not** need Tor, Render, or a wallet on the MCP host. Payment still happens on-chain (or Stripe for human SKUs).

---

## Install (Cursor)

### Option A — from this monorepo

```bash
cd aizamon-mcp
npm install
```

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "aizamon": {
      "command": "node",
      "args": ["/absolute/path/to/tor-mcp/aizamon-mcp/server.mjs"],
      "env": {
        "AIZAMON_BASE_URL": "https://aizamon.com",
        "AIZAMON_AGENT_ID": "your-stable-bot-id"
      }
    }
  }
}
```

Windows one-liner (from repo root):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/Install-AizamonMcp.ps1
```

Reload Cursor → ask the agent to run `aizamon_free_venue_gaps`.

### Option B — npx (after npm publish)

```json
"aizamon": {
  "command": "npx",
  "args": ["-y", "@aizamon/mcp"],
  "env": {
    "AIZAMON_AGENT_ID": "your-stable-bot-id"
  }
}
```

---

## Tools

| Tool | Money? | What it does |
|------|--------|--------------|
| `aizamon_free_venue_gaps` | Free | Polymarket vs Kalshi gaps |
| `aizamon_free_alpha_preview` | Free | Delayed edge teaser |
| `aizamon_get_agent_store` | Free | Full SKU catalog + buy recipe |
| `aizamon_get_payment_rails` | Free | Receive addresses |
| `aizamon_list_x402_services` | Free | x402 micro services |
| `aizamon_get_llms_guide` | Free | `llms.txt` |
| `aizamon_get_catalog` / `_commerce` / `_dynamic_pricing` | Free | Site metadata |
| `aizamon_referral_status` | Free | Referral credit |
| `aizamon_checkout_reminders` | Free | Unfinished intents |
| `aizamon_human_checkout_link` | Free | Stripe URL for Tor Pro / reports |
| `aizamon_purchase_intent` | **Starts pay** | Creates 402 intent |
| `aizamon_fulfill` | **Claims pay** | Inline goods after payment |
| `aizamon_checkout_settle` | **Claims pay** | Auto-discover + fulfill |

**Safety:** agents must confirm with a human before `purchase_intent` / `fulfill` / `checkout_settle`.

---

## Money path (what to demo)

```
aizamon_free_venue_gaps()
  → show a real gap
aizamon_purchase_intent({ sku: "SKU_AG_BOT_FUEL_01" })
  → human pays USDC on Base
aizamon_checkout_settle({ intentId })
  → inline Bot Fuel card
```

Tor unlock upsell for humans:

```
aizamon_human_checkout_link({ sku: "SKU_TOR_MCP_PRO" })
```

---

## Env

| Var | Default | Description |
|-----|---------|-------------|
| `AIZAMON_BASE_URL` | `https://aizamon.com` | API origin |
| `AIZAMON_AGENT_ID` | — | Stable `x-agent-id` / buyerId |

---

## Where this lives

Ships inside [jordymoney/tor-mcp](https://github.com/jordymoney/tor-mcp) under `aizamon-mcp/` until it graduates to its own repo. Backend stays on **aizamon.com** (your existing deploy). This MCP runs on **your PC** next to Cursor — same model as tor-mcp.

Companion: [tor-mcp](https://github.com/jordymoney/tor-mcp) for anonymous Tor fetches.

---

## License

MIT
