# tor-mcp

**Give your Cursor AI agent anonymous, private internet access through Tor — in one step.**

`tor-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that spins up and manages a Tor daemon, then exposes clean tools so any AI agent (Cursor, Claude Desktop, etc.) can fetch URLs anonymously, rotate its exit IP, and access `.onion` hidden services — without touching a browser.

---

## Why

Most AI agent web tools make requests directly from your machine's IP. Every API you hit, every page you scrape, every site you research — it all traces back to you. `tor-mcp` routes everything through the Tor network instead. The target sees a random exit node. Your IP never appears.

**Use cases:**
- Anonymous market research and competitor intel without leaving traces in their analytics
- Scraping APIs and job boards from rotating IPs to avoid blocks and rate limits
- Accessing `.onion` hidden services from inside your AI agent workflow
- Geo-targeted fetching — pick an exit node in a different country to see regional content
- Privacy-preserving OSINT — research people, prices, and signals without attribution

---

## Tools

| Tool | Description | Trial |
|------|-------------|-------|
| `tor_fetch` | GET any URL (clearnet or `.onion`) through Tor. DNS resolves inside Tor — no leaks. | 1 use on success |
| `tor_post` | POST data through Tor. | 1 use on success |
| `tor_new_circuit` | Request a fresh circuit — your apparent exit IP rotates within ~3 seconds. | Free |
| `tor_set_exit_country` | Prefer exits in one country for **clearnet** (`us`, `de`, …). Pass `any` to clear. Not for `.onion`. | Free |
| `tor_research` | Search (DDG onion) and/or fetch URLs; extract title, prices, stock, snippets as JSON. | 1 use on success |
| `tor_geo_compare` | Deal scout: `urls[]` locale pages (recommended) or same URL via exit countries. | 1 use on success |
| `tor_status` | Check daemon health, bootstrap progress, SOCKS port, exit country, and free-trial quota. | Free |
| `tor_unlock` | Apply your Tor MCP Pro key — removes the trial limit on this machine. | Free |
| `tor_restart` | Restart local Tor on ports 9055/9056 (recovery when `.onion` fails). | Free |

---

## Free trial & unlock

**25 free successful uses** — `tor_fetch`, `tor_post`, `tor_research`, and `tor_geo_compare` each count **once per successful operation** (failed requests do not consume trial uses). `tor_new_circuit`, `tor_status`, `tor_set_exit_country`, `tor_unlock`, and `tor_restart` are always free.

When the trial runs out, network tools return an unlock message instead of fetching. Check remaining quota anytime:

```
tor_status()
```

**Unlock unlimited use** — [$12 one-time at aizamon.com](https://aizamon.com/client?sku=SKU_TOR_MCP_PRO) (wallet agents: ~$7.80 USDC via [agent store](https://aizamon.com/agent-store.json)):

1. [Buy Tor MCP Pro](https://aizamon.com/client?sku=SKU_TOR_MCP_PRO) — key emailed after checkout.
2. In Cursor, run `tor_unlock` with your key **once**, or add to `~/.cursor/mcp.json`:

```json
"env": {
  "TOR_MCP_UNLOCK_KEY": "your-key-here"
}
```

3. **Reload Cursor.** Keys are verified online at startup. `tor_status` should show `unlocked: true`.

**Support:** [aizamon.com/client](https://aizamon.com/client) · lost key → use the email from checkout · [GitHub issues](https://github.com/jordymoney/tor-mcp/issues)

| Env var | Default | Description |
|---------|---------|-------------|
| `TOR_MCP_UNLOCK_KEY` | — | Pro unlock key (verified online on startup) |
| `TOR_MCP_VERIFY_URL` | `https://aizamon.com/api/tor-mcp/verify` | Key verification endpoint |

---

## Setup

### 1. Install the Tor daemon

Run the setup script — it downloads the official [Tor Expert Bundle](https://www.torproject.org/download/tor/) for Windows and installs Node dependencies:

```powershell
cd tor-mcp
powershell -ExecutionPolicy Bypass -File setup.ps1
```

> **Linux/macOS:** Install Tor via your package manager (`sudo apt install tor` / `brew install tor`), then run `npm install`. The server finds `tor` on your PATH automatically.

### 2. Register in Cursor

Add to `~/.cursor/mcp.json` (global, works in every project):

```json
{
  "mcpServers": {
    "tor": {
      "command": "node",
      "args": ["/absolute/path/to/tor-mcp/server.mjs"],
      "env": {
        "TOR_SOCKS_PORT": "9055",
        "TOR_CONTROL_PORT": "9056"
      }
    }
  }
}
```

### 3. Reload Cursor

`Ctrl+Shift+P` → **Reload Window**. Tor starts automatically when the MCP server loads.

Run `tor_status` to confirm `running: true` and `onionOk: true` before fetching `.onion` URLs.

---

## Troubleshooting

### `.onion` fails

1. **`tor_status`** — look for `onionOk: true` and `mcpVersion: "1.3.0"`.
2. **`tor_restart`** — free recovery tool; wait ~30s, then retry.
3. **Port conflict** — if something else uses `9055`/`9056` (Tor Browser uses `9050`/`9051`), quit it or run `scripts/Restart-TorMcp.ps1`, then reload Cursor.
4. **One fetch at a time** — do not batch parallel `.onion` requests; tor-mcp serializes them automatically.
5. **First connect is slow** — up to 90s for `.onion`; instant `Socks5 proxy rejected` usually means bad circuits (auto-retries with NEWNYM).

### Trial / unlock

- Failed fetches **do not** count against the free trial.
- Keys must verify online at startup (7-day offline grace after first successful verify).
- Revoked keys stop working on next online verify.

---

## Usage examples

**Check your anonymous IP:**
```
tor_fetch("https://check.torproject.org/api/ip")
```

**Rotate exit node between requests:**
```
tor_new_circuit()
tor_fetch("https://api.example.com/data")
```

**Access a .onion hidden service:**
```
tor_fetch("http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/")
```

---

## Privacy guarantees

- **`socks5h://`** — hostname resolution happens inside Tor, never on your machine. No DNS leaks.
- **Localhost-only binding** — SOCKS port `9055` and control port `9056` only accept connections from `127.0.0.1`.
- **Cookie authentication** — the Tor control port uses file-based cookie auth.
- **Client only** — the `torrc` sets `ExitPolicy reject *:*`. This node never relays other people's traffic.
- **HTTP warning** — `tor_fetch` and `tor_post` flag plain `http://` URLs. Use HTTPS when possible.

**What this does NOT protect against:**
- Nation-state adversaries correlating entry/exit timing.
- Application-level identity (cookies, logins).

---

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `TOR_SOCKS_PORT` | `9055` | SOCKS5 proxy port |
| `TOR_CONTROL_PORT` | `9056` | Tor control port |
| `TOR_BIN` | auto-detect | Path to `tor` / `tor.exe` if not in `./tor-bin/` or PATH |

Ports `9055`/`9056` avoid conflict with Tor Browser (`9050`/`9051`).

---

## Project structure

```
tor-mcp/
├── server.mjs          # MCP server (tools + usage gate)
├── usage-gate.mjs      # Trial + online key verification
├── tor-daemon.mjs      # Tor process manager + HS warmup
├── torrc               # Tor configuration (client-only)
├── setup.ps1           # Windows: downloads Tor Expert Bundle
├── scripts/
│   ├── Restart-TorMcp.ps1
│   └── sweep-onions.mjs
└── tor-bin/            # tor.exe after setup (git-ignored)
```

---

## License

MIT — source is open. **Tor MCP Pro** unlimited use requires a valid paid unlock key verified via [aizamon.com](https://aizamon.com/client?sku=SKU_TOR_MCP_PRO).
