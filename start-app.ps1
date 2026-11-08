# Launcher for "Okinawa Memory Palace"
# Starts a local web server (if not running) and opens the app in a Chrome app window.
$ErrorActionPreference = 'SilentlyContinue'
$dir  = $PSScriptRoot
$port = 8000
$url  = "http://localhost:$port/"

function Test-Listening { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }

if (-not (Test-Listening)) {
    $python = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue).Source }
    if (-not $python) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show('Python was not found. Please install Python.', 'Memory Palace') | Out-Null
        exit 1
    }
    # 127.0.0.1 only = not reachable from other devices (safe default)
    # server.py = static files + "open in Chrome" for the image AI button
    Start-Process -FilePath $python -ArgumentList "`"$dir\server.py`"", $port `
        -WorkingDirectory $dir -WindowStyle Hidden
    for ($i = 0; $i -lt 50 -and -not (Test-Listening); $i++) { Start-Sleep -Milliseconds 100 }
}

$chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chrome) { Start-Process -FilePath $chrome -ArgumentList "--app=$url" }
else { Start-Process $url }
