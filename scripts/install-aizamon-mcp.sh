#!/usr/bin/env bash
# Install Aizamon MCP into ~/.cursor/mcp.json (macOS / Linux)
# Usage: ./scripts/install-aizamon-mcp.sh [agent-id]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$ROOT/aizamon-mcp/server.mjs"
AGENT_ID="${1:-${AIZAMON_AGENT_ID:-cursor-$(whoami | tr -cd 'a-zA-Z0-9_-')}}"
MCP_JSON="${HOME}/.cursor/mcp.json"

if [[ ! -f "$SERVER" ]]; then
  echo "Missing $SERVER" >&2
  exit 1
fi

(cd "$ROOT/aizamon-mcp" && npm install --omit=dev)

mkdir -p "$(dirname "$MCP_JSON")"

node --input-type=module <<EOF
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const mcpPath = ${JSON.stringify(MCP_JSON)}
const server = ${JSON.stringify(SERVER)}
const agentId = ${JSON.stringify(AGENT_ID)}

let cfg = { mcpServers: {} }
if (existsSync(mcpPath)) {
  try {
    cfg = JSON.parse(readFileSync(mcpPath, 'utf8') || '{}')
  } catch {
    /* replace broken file */
  }
}
if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {}

cfg.mcpServers.aizamon = {
  command: 'node',
  args: [server],
  env: {
    AIZAMON_BASE_URL: 'https://aizamon.com',
    AIZAMON_AGENT_ID: agentId,
  },
}

writeFileSync(mcpPath, JSON.stringify(cfg, null, 2) + '\n')
console.log('Aizamon MCP installed.')
console.log('  server :', server)
console.log('  agent  :', agentId)
console.log('  config :', mcpPath)
console.log('Reload Cursor, then: run aizamon_free_venue_gaps')
EOF
