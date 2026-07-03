# Kill orphan tor on tor-mcp ports and remind to reload Cursor.
$ErrorActionPreference = "Stop"

function Stop-PortOwner([int]$Port) {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    $ownerPid = $c.OwningProcess
    if ($ownerPid -le 0) { continue }
    $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host "Stopping $($proc.ProcessName) (PID $ownerPid) on port $Port" -ForegroundColor Yellow
      Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
    }
  }
}

Stop-PortOwner 9055
Stop-PortOwner 9056
Start-Sleep -Seconds 1

$stillUp = Get-NetTCPConnection -LocalPort 9055,9056 -State Listen -ErrorAction SilentlyContinue
if ($stillUp) {
  Write-Host "Ports 9055/9056 still in use. Quit Tor Browser or the other app on those ports." -ForegroundColor Red
  exit 1
}

Write-Host "Tor ports clear. Reload Cursor (Developer: Reload Window)." -ForegroundColor Green
