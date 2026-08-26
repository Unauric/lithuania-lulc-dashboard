
# One canonical way to start the dashboard server. Always use this instead of
# typing `python -m http.server` or `python serve_dashboard.py` by hand --
# plain http.server has no /api/hydro/ proxy route, so if it ends up bound to
# port 8000 instead of serve_dashboard.py, every hydro station fetch the
# dashboard makes silently 404s (looks like "the API is down" but isn't).
#
# This script checks who currently holds port 8000: if it's the wrong server,
# it kills it and starts the right one; if serve_dashboard.py is already
# running, it does nothing.

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$listener = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($proc -and $proc.CommandLine -notmatch "serve_dashboard\.py") {
        Write-Host "Port 8000 is in use by a different server (PID $($proc.ProcessId): $($proc.CommandLine))"
        Write-Host "Stopping it so the hydro API proxy is available..."
        Stop-Process -Id $proc.ProcessId -Force
        Start-Sleep -Milliseconds 500
    }
    elseif ($proc) {
        Write-Host "serve_dashboard.py is already running on port 8000 (PID $($proc.ProcessId))."
        Write-Host "Dashboard: http://localhost:8000/dashboard/index.html"
        exit 0
    }
}

# Prefer the `py` launcher (most reliably a real interpreter on Windows),
# then bare `python`, then the Microsoft Store shim's own real install path
# as a last resort -- some shells resolve a bare `python` to that shim
# instead of a real interpreter and it silently no-ops.
$pythonCmd = $null
foreach ($candidate in @("py", "python")) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -notmatch "WindowsApps") {
        $pythonCmd = $candidate
        break
    }
}
if (-not $pythonCmd) {
    Write-Host "Could not find a real Python interpreter on PATH (only the Microsoft Store shim, or nothing)."
    Write-Host "Install Python from python.org or run: winget install Python.Python.3"
    exit 1
}

Write-Host "Starting dashboard server (with hydro API proxy) on http://localhost:8000/ ..."
Write-Host "Dashboard: http://localhost:8000/dashboard/index.html"
& $pythonCmd serve_dashboard.py
