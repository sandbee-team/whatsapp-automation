# Human entrypoint for CI on Windows. Preflight only - every actual step
# lives in scripts/ci-steps.ts. Do not add step commands here (see
# ci_ps1_and_ci_sh_run_the_same_ordered_steps).

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$pnpmVersion = (pnpm --version).Trim()
if (-not $pnpmVersion.StartsWith('10.')) {
    Write-Error "Expected pnpm 10.x, got '$pnpmVersion'. Install/activate pnpm 10 before running CI."
    exit 1
}

$nodeVersion = (pnpm node --version).Trim()
if (-not $nodeVersion.StartsWith('v24.')) {
    Write-Error "Expected Node v24.x (via pnpm), got '$nodeVersion'. Check .npmrc use-node-version."
    exit 1
}

Write-Host "Preflight OK: pnpm $pnpmVersion, node $nodeVersion"
Write-Host "Delegating to scripts/ci-steps.ts ..."

pnpm exec tsx scripts/ci-steps.ts run
exit $LASTEXITCODE
