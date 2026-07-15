# Changelog

## [1.3.1] — 2026-07-15 — Pay-per-call permits

### Added
- **Call permits after free trial** — redeem `SKU_AG_TOR_CALL_01` tokens via `GET /api/v1/tor-call-permit`.
- **`tor_add_call_permit`** tool + `TOR_MCP_CALL_TOKEN` env to queue tokens from `/x402/v1/tor-call`.
- Exhausted-trial errors now point at `$0.05` x402 call buy **and** Pro unlock.

### Changed
- `gateBillableCheck` is async; billable tools await permit redeem when trial is exhausted.


## [1.3.0] — 2026-07-02 — Shippable release

### Fixed (customer-facing)
- **Trial counts successful uses only** — failed/timeouts no longer consume free uses.
- **Unlock keys verified online on startup** — env/file keys must pass `/api/tor-mcp/verify`; revoked keys cleared.
- **7-day offline grace** after first successful verify (travel/offline use).
- **Version alignment** — `package.json`, server, and daemon all `1.3.0`.
- **Missing `scripts/Restart-TorMcp.ps1`** added; README documents `tor_restart`.

### Changed
- Removed customer docs for bypass env vars (`TOR_MCP_OPERATOR`, `TOR_MCP_FREE_USES`).
- Operator/dev flags hidden from `tor_status` unless `TOR_MCP_OPERATOR=1`.
- README: trial-on-success, support, troubleshooting, correct pricing ($12 / ~$7.80 agent).

## [1.2.5] — 2026-07-02

### Fixed
- **HS circuit warmup** — Facebook canary (any HTTP = pipe works) then DDG before `onionOk`; post-bootstrap settle + NEWNYM on instant SOCKS reject (~2ms).
- **Serialized `.onion` fetches** — global lock prevents parallel fetches from killing Tor / fighting MCP restart.
- **Fetch failures clear `onionOk`** — stale DDG probe no longer masks bad circuit state.
- **Recovery without `tor_restart`** — up to 4 `NEWNYM` + wait retries on instant reject; no auto full restart on fetch (avoids port fights / MCP disconnect).

### Changed
- `sweep-onions.mjs` uses same lock; reports `instantReject` timing.

## [1.2.4] — 2026-07-02

### Fixed
- **Port conflict / two Tors fighting** — operator mode no longer hard-fails when 9055/9056 stay busy; falls back to attach + live probe instead of spawning a second tor.exe.
- Graceful shutdown → force-kill listeners only when recycle is needed; then attach if spawn is impossible.
- MCP exit no longer shuts down attached/external tor (avoids killing another app's Tor).

### Added
- **Auto-refresh** for operator: `NEWNYM` + DDG onion re-probe every 5 min (`TOR_MCP_REFRESH_MS`, default 300000).
- Startup refresh after attach (fresh circuits immediately).
- `attachFallback`, `preferManaged`, `autoRefreshMs` in `tor_status`.

## [1.2.3] — 2026-07-02

### Fixed
- **Operator mode (`TOR_MCP_OPERATOR=1`) always owns tor** — no more attaching to stale orphan `tor.exe` on 9055; MCP shuts down and respawns managed tor on startup.
- **`.onion` fetch recovery** — after `NEWNYM` retry fails, auto `tor_restart` then retry once more.
- **Probe failure auto-restart** in operator mode when hidden-service check fails.
- MCP exit shuts down tor on 9055/9056 in operator mode so orphans do not survive Cursor reloads.

### Added
- `forceManaged` / `operatorMode` in `tor_status`.
- `scripts/Restart-TorMcp.ps1` — manual kill of stuck tor on 9055/9056.

## [1.2.2] — 2026-07-02

### Fixed
- **Intermittent `.onion` SOCKS failures** — `tor_fetch`/`tor_post` retry once with `NEWNYM` + live re-probe when the proxy rejects a hidden-service connection.
- Stale attach to long-running `tor.exe` on 9055 can leave bad circuits; use new `tor_restart` to bounce cleanly.

### Added
- **`tor_restart`** tool — shutdown tor on 9055/9056 and start fresh (free, no trial charge).
- `lastOnionProbeAt` in `tor_status` for debugging probe vs fetch timing.

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
