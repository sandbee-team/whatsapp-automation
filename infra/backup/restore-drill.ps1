# infra/backup/restore-drill.ps1 (P29a Unit U3, step 9) - timed Postgres
# restore drill wrapper. Loads `.secrets/dev.env` the same way the P26
# script did, then runs the TS orchestrator (`restore-drill.ts`), which
# owns every mode (`basebackup` default, `pgbackrest` argv-only on this
# box) and the production-target refusal. Follows the gate.ps1 discipline:
# never `2>&1 |` on a native command in this repo's PowerShell scripts.
#
# Usage:
#   powershell -File infra/backup/restore-drill.ps1
#   powershell -File infra/backup/restore-drill.ps1 --keep
#   powershell -File infra/backup/restore-drill.ps1 --mode pgbackrest
#   powershell -File infra/backup/restore-drill.ps1 --allow-remote-source   # required opt-in when POSTGRES_HOST is not loopback; a production-pattern-matching source is still refused regardless

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

$envFilePath = Join-Path $repoRoot '.secrets/dev.env'
if (-not (Test-Path $envFilePath)) {
  Write-Error "Missing env file: $envFilePath"
  exit 1
}
Get-Content $envFilePath | ForEach-Object {
  $line = $_.Trim()
  if ($line -eq '' -or $line.StartsWith('#')) { return }
  $eqIndex = $line.IndexOf('=')
  if ($eqIndex -lt 0) { return }
  $key = $line.Substring(0, $eqIndex).Trim()
  $value = $line.Substring($eqIndex + 1).Trim()
  Set-Item -Path "env:$key" -Value $value
}

pnpm exec tsx infra/backup/restore-drill.ts @args
exit $LASTEXITCODE
