# Install Aizamon MCP into ~/.cursor/mcp.json (Windows / PowerShell)
# Run from tor-mcp repo root:
#   powershell -ExecutionPolicy Bypass -File scripts/Install-AizamonMcp.ps1
# Optional:
#   -AgentId "my-bot"
#   -RepoRoot "C:\path\to\tor-mcp"

param(
  [string]$AgentId = "",
  [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

$ServerPath = Join-Path $RepoRoot "aizamon-mcp\server.mjs"
if (-not (Test-Path $ServerPath)) {
  Write-Error "Missing $ServerPath — clone jordymoney/tor-mcp and run from that tree."
}

Push-Location (Join-Path $RepoRoot "aizamon-mcp")
try {
  if (-not (Test-Path "node_modules")) {
    Write-Host "npm install in aizamon-mcp..." -ForegroundColor Cyan
    npm install
  }
} finally {
  Pop-Location
}

$CursorDir = Join-Path $env:USERPROFILE ".cursor"
$McpJson = Join-Path $CursorDir "mcp.json"
New-Item -ItemType Directory -Force -Path $CursorDir | Out-Null

$config = @{ mcpServers = @{} }
if (Test-Path $McpJson) {
  try {
    $raw = Get-Content $McpJson -Raw
    if ($raw.Trim()) {
      $config = $raw | ConvertFrom-Json -AsHashtable
    }
  } catch {
    Write-Warning "Could not parse existing mcp.json — backing up and starting fresh."
    Copy-Item $McpJson "$McpJson.bak-$(Get-Date -Format yyyyMMddHHmmss)"
    $config = @{ mcpServers = @{} }
  }
}

if (-not $config.mcpServers) { $config.mcpServers = @{} }

if (-not $AgentId) {
  $AgentId = $env:AIZAMON_AGENT_ID
}
if (-not $AgentId) {
  $AgentId = "cursor-" + ($env:USERNAME -replace '[^a-zA-Z0-9_-]', '').ToLower()
  if (-not $AgentId -or $AgentId -eq "cursor-") { $AgentId = "cursor-user" }
}

$unixPath = $ServerPath -replace '\\', '/'
$config.mcpServers["aizamon"] = @{
  command = "node"
  args    = @($unixPath)
  env     = @{
    AIZAMON_BASE_URL = "https://aizamon.com"
    AIZAMON_AGENT_ID = $AgentId
  }
}

($config | ConvertTo-Json -Depth 8) | Set-Content -Path $McpJson -Encoding UTF8

Write-Host ""
Write-Host "Aizamon MCP installed." -ForegroundColor Green
Write-Host "  server : $ServerPath"
Write-Host "  agent  : $AgentId"
Write-Host "  config : $McpJson"
Write-Host ""
Write-Host "Reload Cursor (Ctrl+Shift+P → Reload Window), then ask:" -ForegroundColor Cyan
Write-Host "  run aizamon_free_venue_gaps"
Write-Host ""
