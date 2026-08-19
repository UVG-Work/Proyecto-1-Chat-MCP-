# Captures a complete MCP session against the DEPLOYED server over HTTPS
# (project requirement 7, encrypted half).
#
# Unlike the loopback capture, this traffic crosses a real network: a real
# Ethernet/Wi-Fi link layer, routing to a public address, and TLS. A naive
# capture would therefore show only "Application Data" records.
#
# To make it readable without weakening the deployment, the client exports its
# own TLS session keys (MCP_TLS_KEYLOG=1 -> docs/captures/session.keylog, written
# by src/mcp/http-transport.ts from Node's TLS keylog event). Point Wireshark at
# that file under:
#   Preferences > Protocols > TLS > (Pre)-Master-Secret log filename
#
#   powershell -ExecutionPolicy Bypass -File scripts/capture-remote.ps1

param(
    [string] $OutFile    = 'docs/captures/mcp-https-remote.pcapng',
    [string] $KeyLog     = 'docs/captures/session.keylog',
    [int]    $MaxSeconds = 90,
    # Capture interface. Auto-detected from the default route when omitted.
    [string] $Interface
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$tshark = Join-Path $env:ProgramFiles 'Wireshark\tshark.exe'
if (-not (Test-Path $tshark)) { throw "tshark not found at $tshark. Install Wireshark first." }

# --- resolve the remote endpoint -------------------------------------------

$remoteUrl = (Get-Content .env | Select-String '^NOC_REMOTE_URL=(.*)$').Matches.Groups[1].Value
if (-not $remoteUrl) { throw 'NOC_REMOTE_URL is not set in .env' }
$remoteHost = ([Uri]$remoteUrl).Host
Write-Host "Remote endpoint: $remoteUrl" -ForegroundColor Cyan

$addresses = [System.Net.Dns]::GetHostAddresses($remoteHost) |
    Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
    ForEach-Object { $_.IPAddressToString }
if (-not $addresses) { throw "Could not resolve $remoteHost to an IPv4 address" }
Write-Host "Resolves to: $($addresses -join ', ')" -ForegroundColor Cyan

# --- pick the capture interface --------------------------------------------

if (-not $Interface) {
    # The interface carrying the default route is the one the traffic leaves by.
    $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
        Sort-Object RouteMetric | Select-Object -First 1
    if (-not $route) { throw 'Could not determine the default route; pass -Interface explicitly.' }
    $alias = (Get-NetAdapter -InterfaceIndex $route.InterfaceIndex).InterfaceDescription
    $line = & $tshark -D | Where-Object { $_ -match [regex]::Escape((Get-NetAdapter -InterfaceIndex $route.InterfaceIndex).Name) } | Select-Object -First 1
    if (-not $line) { throw "Could not match the default-route adapter to a capture interface. Run '$tshark -D' and pass -Interface." }
    $Interface = ($line -split ' ')[1]
    Write-Host "Capturing on: $Interface ($alias)" -ForegroundColor Cyan
}

# --- prepare -----------------------------------------------------------------

$outPath = Join-Path $repoRoot $OutFile
$keyPath = Join-Path $repoRoot $KeyLog
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outPath) | Out-Null
Remove-Item $outPath -ErrorAction SilentlyContinue
Remove-Item $keyPath -ErrorAction SilentlyContinue

$filter = ($addresses | ForEach-Object { "host $_" }) -join ' or '
$filter = "($filter) and tcp port 443"

Write-Host "Capture filter: $filter" -ForegroundColor Cyan
$captureArgs = @('-i', $Interface, '-f', "`"$filter`"", '-a', "duration:$MaxSeconds", '-w', "`"$outPath`"")
$capture = Start-Process -FilePath $tshark -ArgumentList $captureArgs `
    -PassThru -NoNewWindow -RedirectStandardError "$env:TEMP\tshark-remote.log"

Start-Sleep -Seconds 3

# --- drive the session -------------------------------------------------------

Write-Host "`nRunning the scripted MCP session against the deployment..." -ForegroundColor Cyan
$env:MCP_TLS_KEYLOG = '1'
try {
    & npx tsx src/cli/demo-session.ts noc-remote
}
finally {
    $env:MCP_TLS_KEYLOG = '0'
}

Start-Sleep -Seconds 2
if (-not $capture.HasExited) { Stop-Process -Id $capture.Id -Force }
Start-Sleep -Seconds 1

# --- report ------------------------------------------------------------------

if (-not (Test-Path $outPath)) { throw 'Capture file was not produced.' }
Write-Host "`nCapture written: $outPath ($((Get-Item $outPath).Length) bytes)" -ForegroundColor Green

if (Test-Path $keyPath) {
    $secrets = (Get-Content $keyPath | Measure-Object -Line).Lines
    Write-Host "TLS keylog written: $keyPath ($secrets secrets)" -ForegroundColor Green
} else {
    Write-Host 'WARNING: no TLS keylog was produced; the capture will not decrypt.' -ForegroundColor Yellow
}

Write-Host "`n--- TLS records (encrypted view) ---" -ForegroundColor Cyan
& $tshark -r $outPath -Y 'tls.handshake.type == 1 or tls.handshake.type == 2' `
    -T fields -e frame.number -e tls.handshake.type -e tls.handshake.extensions_server_name 2>$null

Write-Host "`n--- decrypted HTTP, using the exported keys ---" -ForegroundColor Cyan
& $tshark -r $outPath -o "tls.keylog_file:$keyPath" -Y 'http' `
    -T fields -e frame.number -e http.request.method -e http.request.uri -e http.response.code 2>$null
