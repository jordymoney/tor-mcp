# Changelog

## [1.2.1] — 2026-07-02

### Fixed
- **Onion probe matches `tor_fetch`** — probe now follows redirects and requires `res.ok` (v1.2.0 counted HTTP 301 as success while fetches still failed).
- **Live re-probe before `.onion` fetches** — `ensureOnionReady()` caches ~30s; `tor_status` refreshes the probe when called.

### Added
- `mcpVersion` in `tor_status` output so agents can confirm which build Cursor loaded.

## [1.2.0] — 2026-07-02

### Fixed
- **Hidden services (`.onion`)** — no more blind attach when SOCKS 9055 is already open; tor-mcp now verifies bootstrap 100% and probes a known `.onion` before marking ready.
- Longer default timeout for `.onion` fetches (90s).

### Added
- **`TOR_MCP_OPERATOR=1`** — unlimited local use for the operator/dev machine (paid trial unchanged for everyone else).
- `tor_status` reports `onionOk` and operator mode in the status note.

## [1.1.0] — 2026-07-02

### Added
- **5-use free trial** on `tor_fetch`, `tor_post`, and `tor_new_circuit` (configurable via `TOR_MCP_FREE_USES`).
- **`tor_unlock` tool** — apply a Tor MCP Pro key from [aizamon.com](https://aizamon.com/client?sku=SKU_TOR_MCP_PRO).
- **`usage-gate.mjs`** — local quota tracking in `tor-data/usage-gate.json`.
- Quota info in `tor_status` and `_quota` on every billable response.

### Changed
- Blocked responses include unlock URL and hint when trial is exhausted.
- README documents trial, unlock, and env vars.

### Wallet agents
- Buy `SKU_TOR_MCP_PRO` via USDC on Base → `result.torUnlock.unlockKey` inline on `/fulfill`.
- Verify keys at `POST https://aizamon.com/api/tor-mcp/verify`.

## [1.0.0] — initial release

- `tor_fetch`, `tor_post`, `tor_new_circuit`, `tor_status`
- Managed local Tor daemon (SOCKS 9055, control 9056)
- Attach-to-existing-Tor fix when ports already in use
