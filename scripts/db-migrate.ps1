# Loads .secrets/dev.env into $env: (KEY=VALUE, skips blank/# lines), then
# runs the ROLE=migrate entrypoint (app/backend/src/roles/migrate.ts).
# Exits with the child process's exit code.

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$envFilePath = Join-Path $repoRoot '.secrets/dev.env'
if (-not (Test-Path $envFilePath)) {
    Write-Error "Missing env file: $envFilePath"
    exit 1
}

Get-Content $envFilePath | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) {
        return
    }

    $eqIndex = $line.IndexOf('=')
    if ($eqIndex -lt 0) {
        return
    }

    $key = $line.Substring(0, $eqIndex).Trim()
    $value = $line.Substring($eqIndex + 1).Trim()
    Set-Item -Path "env:$key" -Value $value
}

pnpm exec tsx app/backend/src/roles/migrate.ts
exit $LASTEXITCODE
