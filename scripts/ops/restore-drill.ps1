# restore-drill.ps1 - moved to infra/backup/ in P29a. This forwarder exists
# only so existing references to this path keep resolving.
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
& powershell -File (Join-Path $repoRoot 'infra/backup/restore-drill.ps1') @args
exit $LASTEXITCODE
