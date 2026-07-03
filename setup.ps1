# tor-mcp/setup.ps1
# Downloads the Tor Expert Bundle for Windows, extracts tor.exe + DLLs to ./tor-bin/,
# then installs Node.js dependencies.
#
# Run once:
#   powershell -ExecutionPolicy Bypass -File setup.ps1
# or:
#   npm run setup

param(
    [string]$TorVersion = "15.0.17"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$TorBin = Join-Path $Root "tor-bin"
$TorExe = Join-Path $TorBin "tor.exe"

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "  >> $msg" -ForegroundColor Cyan
}

function Write-OK([string]$msg) {
    Write-Host "  ✓ $msg" -ForegroundColor Green
}

Write-Host ""
Write-Host "  +--------------------------------------------+" -ForegroundColor DarkMagenta
Write-Host "  |     Tor MCP  —  Setup / Install            |" -ForegroundColor Magenta
Write-Host "  +--------------------------------------------+" -ForegroundColor DarkMagenta
Write-Host ""

# ── Check if already installed ────────────────────────────────────────────────
if (Test-Path $TorExe) {
    $ver = & $TorExe --version 2>&1 | Select-String "Tor version" | Select-Object -First 1
    Write-OK "tor.exe already present: $ver"
    Write-Host "  (Delete ./tor-bin/ and re-run to reinstall)" -ForegroundColor DarkGray
    Write-Host ""
} else {
    Write-Step "Downloading Tor Expert Bundle for Windows (v$TorVersion)..."

    # Official Tor Project dist URL
    $Arch = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
    $FileName = "tor-expert-bundle-$Arch-$TorVersion.tar.gz"
    $Url = "https://www.torproject.org/dist/torbrowser/$TorVersion/$FileName"

    $TmpDir = Join-Path $env:TEMP "tor-mcp-setup"
    $TmpFile = Join-Path $TmpDir $FileName

    New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

    try {
        Invoke-WebRequest -Uri $Url -OutFile $TmpFile -UseBasicParsing
    } catch {
        Write-Host ""
        Write-Host "  [!] Direct download failed ($($_.Exception.Message))." -ForegroundColor Yellow
        Write-Host "      Trying alternate URL (may differ for newer versions)..." -ForegroundColor DarkGray

        # Some versions ship as tarballs under /dist/tor/ instead
        $AltUrl = "https://www.torproject.org/dist/tor/tor-$TorVersion-$Arch.zip"
        try {
            Invoke-WebRequest -Uri $AltUrl -OutFile ($TmpFile -replace "\.tar\.gz$", ".zip") -UseBasicParsing
            $TmpFile = $TmpFile -replace "\.tar\.gz$", ".zip"
        } catch {
            Write-Host ""
            Write-Host "  [!] Automated download failed. Please:" -ForegroundColor Red
            Write-Host "      1. Visit https://www.torproject.org/download/tor/" -ForegroundColor White
            Write-Host "      2. Download the Windows Expert Bundle (tor-expert-bundle-windows-x86_64-*.tar.gz)" -ForegroundColor White
            Write-Host "      3. Extract tor.exe + the Data/Tor/*.dll files into:" -ForegroundColor White
            Write-Host "         $TorBin" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "      Or install via winget: winget install TorProject.TorBrowser" -ForegroundColor DarkCyan
            Write-Host "      Then set TOR_BIN env var to the tor.exe inside Tor Browser's install." -ForegroundColor DarkGray
            exit 1
        }
    }

    Write-OK "Downloaded: $FileName"
    Write-Step "Extracting..."

    New-Item -ItemType Directory -Force -Path $TorBin | Out-Null

    if ($TmpFile.EndsWith(".tar.gz")) {
        # tar is available on Windows 10+
        $TmpExtract = Join-Path $TmpDir "extracted"
        New-Item -ItemType Directory -Force -Path $TmpExtract | Out-Null
        & tar -xzf $TmpFile -C $TmpExtract
        # Find tor.exe inside the extracted tree
        $TorExeFound = Get-ChildItem -Recurse -Filter "tor.exe" -Path $TmpExtract | Select-Object -First 1
        if ($TorExeFound) {
            # Copy tor.exe and its sibling DLLs
            Copy-Item -Path (Join-Path $TorExeFound.DirectoryName "*") -Destination $TorBin -Recurse -Force
            Write-OK "Extracted tor.exe + DLLs to $TorBin"
        } else {
            Write-Host "  [!] Could not find tor.exe in the extracted bundle. Check manually: $TmpExtract" -ForegroundColor Red
            exit 1
        }
    } elseif ($TmpFile.EndsWith(".zip")) {
        Expand-Archive -Path $TmpFile -DestinationPath (Join-Path $TmpDir "extracted") -Force
        $TorExeFound = Get-ChildItem -Recurse -Filter "tor.exe" -Path (Join-Path $TmpDir "extracted") | Select-Object -First 1
        if ($TorExeFound) {
            Copy-Item -Path (Join-Path $TorExeFound.DirectoryName "*") -Destination $TorBin -Recurse -Force
            Write-OK "Extracted tor.exe + DLLs"
        }
    }

    # Cleanup temp
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
}

# ── Verify tor.exe ─────────────────────────────────────────────────────────────
if (Test-Path $TorExe) {
    Write-OK "tor.exe is ready at $TorExe"
} else {
    Write-Host "  [!] tor.exe not found at $TorExe — see manual instructions above." -ForegroundColor Red
    exit 1
}

# ── npm install ────────────────────────────────────────────────────────────────
Write-Step "Installing Node.js dependencies..."
Set-Location $Root
& npm install --silent
Write-OK "npm packages installed"

# ── Done ───────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  +--------------------------------------------+" -ForegroundColor DarkMagenta
Write-Host "  |   Setup complete!                          |" -ForegroundColor Green
Write-Host "  +--------------------------------------------+" -ForegroundColor DarkMagenta
Write-Host ""
Write-Host "  Next: add tor-mcp to ~/.cursor/mcp.json (see README.md)" -ForegroundColor White
Write-Host ""
Write-Host "  Tor SOCKS port : 9055" -ForegroundColor DarkCyan
Write-Host "  Tor control    : 9056" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "  The MCP server auto-starts tor.exe when Cursor loads it." -ForegroundColor DarkGray
Write-Host "  Use tor_status to verify, tor_restart if .onion fails." -ForegroundColor DarkGray
Write-Host ""
if ([Environment]::UserInteractive) {
  Read-Host "Press Enter to close"
}
