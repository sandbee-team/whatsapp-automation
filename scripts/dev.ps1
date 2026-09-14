# dev.ps1 - start the local dev stack and tell you exactly where to go.
#
# Why this file exists (2026-09-01): the founder started "the server", landed on
# http://localhost:3000, saw `{"message":"Route GET:/ not found"}` and concluded
# the UI was broken. It was not. The backend is an API-ONLY Fastify process on
# :3000; the panel is a separate Vite SPA on :5173 which PROXIES /v1 to :3000.
# Both must run, and nothing in the repo said so - there was no `dev` script and
# no startup doc (the operator runbook is P25, not yet built).
#
# What it does:
#   1. loads .secrets/dev.env (compose + WP_* + DATABASE_URL/REDIS_* all live there)
#   2. checks the docker dev stack is up (postgres/redis/redis-sig)
#   3. starts backend  ROLE=api        -> http://127.0.0.1:3000  (API only, no UI)
#   4. starts frontend vite            -> http://localhost:5173  (THE UI - open this)
#   5. tails both logs' locations and waits; Ctrl+C stops both.
#
# Usage:  powershell -File scripts/dev.ps1
#         powershell -File scripts/dev.ps1 -BackendOnly
#         powershell -File scripts/dev.ps1 -SkipComposeCheck

[CmdletBinding()]
param(
  [switch]$BackendOnly,
  [switch]$FrontendOnly,
  [switch]$SkipComposeCheck
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# --- 1. env ---------------------------------------------------------------
$envFile = Join-Path $repoRoot '.secrets/dev.env'
if (-not (Test-Path $envFile)) {
  Write-Host "dev: FATAL - $envFile not found. Run scripts/gen-key-ring.mjs and create dev.env first." -ForegroundColor Red
  exit 1
}
Get-Content $envFile | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  Set-Item -Path ("env:" + $k) -Value $v
}
Write-Host "dev: loaded env from .secrets/dev.env"

# The key ring must exist or the backend refuses to boot (envelope crypto).
if ($env:WP_KEY_RING_PATH -and -not (Test-Path $env:WP_KEY_RING_PATH)) {
  Write-Host "dev: FATAL - WP_KEY_RING_PATH points at '$($env:WP_KEY_RING_PATH)' which does not exist." -ForegroundColor Red
  Write-Host "dev: generate a dev ring with:  node scripts/gen-key-ring.mjs" -ForegroundColor Yellow
  exit 1
}

# --- 2. docker stack ------------------------------------------------------
if (-not $SkipComposeCheck) {
  $composeFile = 'infra/compose/docker-compose.dev.yml'
  $running = @(docker compose -f $composeFile ps --format '{{.Name}} {{.State}}' 2>$null)
  $needed = @('postgres', 'redis', 'redis-sig')
  $missing = @()
  foreach ($svc in $needed) {
    if (-not ($running -match "$svc.*running")) { $missing += $svc }
  }
  if ($missing.Count -gt 0) {
    Write-Host "dev: starting docker services (missing: $($missing -join ', '))"
    docker compose -f $composeFile up -d postgres redis redis-sig | Out-Null
    Start-Sleep -Seconds 6
  }
  Write-Host "dev: docker dev stack OK (postgres :$($env:POSTGRES_PORT) redis :$($env:REDIS_PORT) redis-sig :$($env:REDIS_SIG_PORT))"
  Write-Host "dev: note - minio may show 'Restarting'; that is a known inert issue, ignore it." -ForegroundColor DarkGray
}

# --- 3/4. processes -------------------------------------------------------
$jobs = @()
$logDir = Join-Path $env:TEMP 'wp-dev'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$apiLog = Join-Path $logDir 'api.log'
$feLog = Join-Path $logDir 'frontend.log'

if (-not $FrontendOnly) {
  Write-Host "dev: starting backend (ROLE=api) -> $apiLog"
  $jobs += Start-Job -Name 'wp-api' -ScriptBlock {
    param($root, $log, $envVars)
    $envVars.GetEnumerator() | ForEach-Object { Set-Item -Path ("env:" + $_.Key) -Value $_.Value }
    $env:ROLE = 'api'
    Set-Location (Join-Path $root 'app/backend')
    pnpm exec tsx src/main.ts *> $log
  } -ArgumentList $repoRoot, $apiLog, (Get-ChildItem env: | ForEach-Object -Begin { $h = @{} } -Process { $h[$_.Name] = $_.Value } -End { $h })
}

if (-not $BackendOnly) {
  Write-Host "dev: starting frontend (vite) -> $feLog"
  $jobs += Start-Job -Name 'wp-frontend' -ScriptBlock {
    param($root, $log)
    Set-Location (Join-Path $root 'app/frontend')
    pnpm dev *> $log
  } -ArgumentList $repoRoot, $feLog
}

Start-Sleep -Seconds 14

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Green
Write-Host "  OPEN THIS IN YOUR BROWSER:   http://localhost:5173" -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor Green
Write-Host "  http://localhost:5173/signup   create a workspace (start here)"
Write-Host "  http://localhost:5173/login    sign in"
Write-Host "  /  redirects to /login until you are signed in (auth guard)"
Write-Host ""
Write-Host "  http://127.0.0.1:3000  is the API ONLY. Opening it in a browser" -ForegroundColor Yellow
Write-Host "  correctly returns {`"message`":`"Route GET:/ not found`"} - that is" -ForegroundColor Yellow
Write-Host "  NOT a broken UI. There is no UI on :3000, by design." -ForegroundColor Yellow
Write-Host ""
Write-Host "  logs:  $apiLog"
Write-Host "         $feLog"
Write-Host ""
Write-Host "  NOT BUILT YET: sending a message (that is phase P11). You can"
Write-Host "  sign up, sign in, and reach the Connect screen to scan a QR."
Write-Host "=================================================================="
Write-Host "Ctrl+C stops both processes."
Write-Host ""

try {
  while ($true) {
    $dead = $jobs | Where-Object { $_.State -ne 'Running' }
    foreach ($d in $dead) {
      Write-Host "dev: job '$($d.Name)' exited ($($d.State)). Its log tail:" -ForegroundColor Red
      $log = if ($d.Name -eq 'wp-api') { $apiLog } else { $feLog }
      if (Test-Path $log) { Get-Content $log -Tail 20 }
      $jobs = $jobs | Where-Object { $_.Id -ne $d.Id }
    }
    if ($jobs.Count -eq 0) { Write-Host "dev: all processes exited." -ForegroundColor Red; break }
    Start-Sleep -Seconds 3
  }
} finally {
  Write-Host "dev: stopping..."
  $jobs | ForEach-Object { Stop-Job $_ -ErrorAction SilentlyContinue; Remove-Job $_ -Force -ErrorAction SilentlyContinue }
}
