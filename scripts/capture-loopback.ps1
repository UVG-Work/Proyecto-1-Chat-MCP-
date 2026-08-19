# Captures a complete MCP session over Streamable HTTP on the loopback
# interface, in plaintext (project requirement 7).
#
# This is the readable half of the analysis: because the traffic never leaves
# the machine there is no TLS, so the JSON-RPC messages appear verbatim in the
# packet bytes and Wireshark's HTTP/JSON dissectors decode them without any key
# material. The encrypted capture against the deployed server is taken
# separately by capture-remote.ps1.
#
# Requires Wireshark with the Npcap loopback adapter. No elevation needed.
#
#   powershell -ExecutionPolicy Bypass -File scripts/capture-loopback.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/capture-loopback.ps1 -Sse

param(
    [int]    $Port     = 8787,
    [string] $OutFile  = 'docs/captures/mcp-http-loopback.pcapng',
    [int]    $MaxSeconds = 60,
    # Answer requests with an SSE stream instead of plain JSON. Produces a
    # chunked, long-lived response that is more interesting to analyse.
    [switch] $Sse
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$tshark = Join-Path $env:ProgramFiles 'Wireshark\tshark.exe'
if (-not (Test-Path $tshark)) { throw "tshark not found at $tshark. Install Wireshark first." }

$outPath = Join-Path $repoRoot $OutFile
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outPath) | Out-Null
Remove-Item $outPath -ErrorAction SilentlyContinue

if (-not (Test-Path (Join-Path $repoRoot 'dist/server/http-main.js'))) {
    Write-Host 'Building...' -ForegroundColor Cyan
    npm run build | Out-Null
}

Write-Host "Starting the NOC MCP server on port $Port (SSE: $($Sse.IsPresent))..." -ForegroundColor Cyan
$env:PORT    = "$Port"
$env:MCP_SSE = if ($Sse) { '1' } else { '0' }
$server = Start-Process -FilePath 'node' -ArgumentList 'dist/server/http-main.js' `
    -PassThru -NoNewWindow -RedirectStandardError "$env:TEMP\noc-server.log"

try {
    Start-Sleep -Seconds 2

    Write-Host "Capturing on the loopback adapter, filter: tcp port $Port" -ForegroundColor Cyan
    $captureArgs = @(
        '-i', '\Device\NPF_Loopback',
        '-f', "`"tcp port $Port`"",
        '-a', "duration:$MaxSeconds",
        '-w', "`"$outPath`""
    )
    $capture = Start-Process -FilePath $tshark -ArgumentList $captureArgs `
        -PassThru -NoNewWindow -RedirectStandardError "$env:TEMP\tshark.log"

    # Let the capture attach before generating any traffic, otherwise the TCP
    # handshake of the first connection is missed.
    Start-Sleep -Seconds 3

    Write-Host "`nRunning the scripted MCP session..." -ForegroundColor Cyan
    & npx tsx src/cli/demo-session.ts noc-http-local

    # Let the final packets (FIN/ACK of the DELETE) be recorded.
    Start-Sleep -Seconds 2

    Write-Host "`nStopping capture..." -ForegroundColor Cyan
    if (-not $capture.HasExited) { Stop-Process -Id $capture.Id -Force }
    Start-Sleep -Seconds 1
}
finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}

if (-not (Test-Path $outPath)) { throw 'Capture file was not produced.' }

Write-Host "`nCapture written: $outPath ($((Get-Item $outPath).Length) bytes)" -ForegroundColor Green
Write-Host "`n--- JSON-RPC methods seen on the wire ---" -ForegroundColor Cyan
& $tshark -r $outPath -Y 'http' -T fields -e frame.number -e http.request.method -e http.request.uri -e http.response.code 2>$null
