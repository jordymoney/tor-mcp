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

| Tool | Description |
|------|-------------|
| `tor_fetch` | GET any URL (clearnet or `.onion`) through Tor. DNS resolves inside Tor — no leaks. |
| `tor_post` | POST data through Tor. |
| `tor_new_circuit` | Request a fresh circuit — your apparent exit IP rotates within ~3 seconds. |
| `tor_status` | Check daemon health, bootstrap progress, and SOCKS port. |

---

## Setup

### 1. Install the Tor daemon

Run the setup script — it downloads the official [Tor Expert Bundle](https://www.torproject.org/download/tor/) for Windows and installs Node dependencies:

```powershell
cd tor-mcp
powershell -ExecutionPolicy Bypass -File setup.ps1
```

> **Linux/macOS:** Install Tor via your package manager (`sudo apt install tor` / `brew install tor`), then just run `npm install`. The server will find `tor` on your PATH automatically.

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

Run `tor_status` to confirm bootstrap.

---

## Usage examples

**Check your anonymous IP:**
```
tor_fetch("https://check.torproject.org/api/ip")
```

**Scrape a page without leaving your IP:**
```
tor_fetch("https://example.com/prices", { headers: { "Accept": "text/html" } })
```

**Rotate exit node between requests:**
```
tor_new_circuit()
// wait ~3s, then fetch again from a different country
tor_fetch("https://api.example.com/data")
```

**Access a .onion hidden service:**
```
tor_fetch("http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/")
```

---

## Privacy guarantees

- **`socks5h://`** — hostname resolution happens inside Tor, never on your machine. No DNS leaks.
- **Localhost-only binding** — SOCKS port `9055` and control port `9056` only accept connections from `127.0.0.1`. Nothing is exposed to your network.
- **Cookie authentication** — the Tor control port uses file-based cookie auth. No unauthenticated access.
- **Client only** — the `torrc` sets `ExitPolicy reject *:*`. This node never relays other people's traffic.
- **HTTP warning** — `tor_fetch` and `tor_post` will flag plain `http://` URLs in the response. The Tor exit node can read unencrypted traffic; use HTTPS when possible.

**What this does NOT protect against:**
- Tor's fundamental limitation: a nation-state adversary controlling both your entry and exit nodes can de-anonymize via timing correlation.
- Application-level identity: if you pass auth cookies or are logged into a site, the site still knows who you are.

---

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `TOR_SOCKS_PORT` | `9055` | SOCKS5 proxy port |
| `TOR_CONTROL_PORT` | `9056` | Tor control port |
| `TOR_BIN` | auto-detect | Path to `tor` / `tor.exe` if not in `./tor-bin/` or PATH |

Ports `9055`/`9056` are chosen to avoid conflict with Tor Browser (`9050`/`9051`). Both can run simultaneously.

---

## Python helper

If you use Python scripts alongside the MCP server, `tor_session.py` gives you a requests-compatible session routed through the same Tor proxy:

```python
from tor_session import tor_get, new_circuit

response = tor_get("https://api.example.com/data")
print(response.json())

new_circuit()  # rotate exit IP
```

Requires: `pip install requests[socks]`

---

## Project structure

```
tor-mcp/
├── server.mjs          # MCP server (tools: tor_fetch, tor_post, tor_new_circuit, tor_status)
├── tor-daemon.mjs      # Tor process manager + control port interface
├── torrc               # Tor configuration (SOCKS 9055, control 9056, client-only)
├── setup.ps1           # Windows: downloads Tor Expert Bundle + npm install
├── package.json
└── tor-bin/            # tor.exe lives here after setup (git-ignored)
```

---

## License

MIT
