# Changelog

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
