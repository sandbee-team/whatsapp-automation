# gate.ps1 - the ONE sanctioned way to run the full CI gate.
#
# Why this file exists (P10, 2026-09-01): the gate was run as
# `.\scripts\ci.ps1 2>&1 | Select-Object -Last 70`. In Windows PowerShell 5.1,
# redirecting a NATIVE command's stderr into the pipeline wraps every stderr
# line in an ErrorRecord (NativeCommandError) and fails the call even when the
# process exited 0. A harmless Node `[DEP0190] DeprecationWarning` was enough:
# the gate reported RED before a single CI step had run, and ~10 minutes plus a
# wrong "the gate is failing" belief were spent on a failure that did not exist.
#
# A convention that several agent files must each remember gets broken again.
# A wrapper cannot be composed wrongly - so no agent may compose the gate
# pipeline itself. Call this script.
#
# Usage:  powershell -File scripts/gate.ps1
#         powershell -File scripts/gate.ps1 -Tail 80
#         powershell -File scripts/gate.ps1 -LogPath C:\some\path\gate.log
#
# Contract: prints the log tail, then a final line `EXITCODE:<n>`, and exits
# with that same code. `<n> = 0` means the gate is green. If the output carries
# no `--- CI step:` / `CI GREEN` / `CI FAILED at step` marker, the gate never
# ran - that is a SHELL error, not a test failure.

[CmdletBinding()]
param(
  [int]$Tail = 45,
  [string]$LogPath = (Join-Path $env:TEMP ("wp-gate-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")),
  # Escape hatch for a deliberate run against a different database. Never use
  # it to point the gate at `wp` - see the TEST DATABASE note below.
  [string]$DatabaseName = 'wp_test2'
)

$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  # ---------------------------------------------------------------------
  # TEST DATABASE (added 2026-09-14 after a real incident)
  #
  # `resolveDatabaseUrl()` (app/backend/src/platform/db/db-url.ts) takes
  # `process.env.DATABASE_URL` if set, and OTHERWISE parses
  # `.secrets/dev.env` - whose `DATABASE_URL` names the DEV database `wp`.
  # Nothing in ci-steps.ts, in any vitest config, or in this wrapper used to
  # set that variable, so the gate only ran against `wp_test2` when a human
  # happened to export it by hand first (see
  # docs/evidence/P29a-gate-tail.md's "DATABASE_URL -> wp_test2" note).
  #
  # On 2026-09-14 a gate ran without it and hit `wp`, which holds real
  # dev-scale data (1,195 clients / 2,105 instances / 2,136 outbox_events).
  # 19 tests failed across 14 files. They were not code defects: bounded and
  # cross-tenant scans that assume a near-empty database were reading
  # thousands of unrelated rows (relay-lag-metric asserted 1 and got 263).
  # The suite also WRITES, so it was mutating the dev database.
  #
  # Deriving the URL here, from the same dev.env line, with only the database
  # name swapped, makes the isolation structural instead of a convention
  # nobody can see. An explicitly exported DATABASE_URL still wins, so a
  # deliberate override is unaffected.
  # ---------------------------------------------------------------------
  if (-not $env:DATABASE_URL) {
    $devEnv = Join-Path $repoRoot '.secrets\dev.env'
    if (Test-Path $devEnv) {
      $line = (Select-String -Path $devEnv -Pattern '^\s*DATABASE_URL\s*=' | Select-Object -First 1).Line
      if ($line) {
        $url = $line.Substring($line.IndexOf('=') + 1).Trim()
        # Swap ONLY the trailing database name, preserving user, password,
        # host, port and any query string. Never echo the value: it carries
        # the password.
        $swapped = [regex]::Replace($url, '/[^/?]+(\?|$)', "/$DatabaseName`$1")
        if ($swapped -ne $url) {
          $env:DATABASE_URL = $swapped
          Write-Host "gate: DATABASE_URL -> $DatabaseName (derived from .secrets/dev.env; value not echoed)"
        } else {
          Write-Host "gate: WARNING - could not rewrite the database name in .secrets/dev.env's DATABASE_URL."
          Write-Host "gate: refusing to run the suite against an unknown database. Export DATABASE_URL yourself."
          Write-Host ""
          Write-Host "EXITCODE:1"
          exit 1
        }
      }
    }
  } else {
    Write-Host "gate: using the DATABASE_URL already set in the environment (not overridden)."
  }

  Write-Host "gate: running full CI gate -> $LogPath"

  # `*>` sends ALL streams to the file without building ErrorRecords in the
  # pipeline. Do NOT change this to `2>&1 |` (see the header).
  pnpm exec tsx scripts/ci-steps.ts run *> $LogPath

  # Capture immediately: any statement in between would clobber $LASTEXITCODE.
  $code = $LASTEXITCODE

  if (Test-Path $LogPath) {
    Get-Content $LogPath -Tail $Tail
  } else {
    Write-Host "gate: WARNING - no log file was produced at $LogPath"
  }

  # Anchor the verdict to a real step marker so a shell-level failure can never
  # be mistaken for a test failure.
  $markers = Select-String -Path $LogPath -Pattern '--- CI step:|CI GREEN|CI FAILED at step' -ErrorAction SilentlyContinue
  if (-not $markers) {
    Write-Host ""
    Write-Host "gate: SHELL-ERROR - no CI step marker found in the output. The gate never ran."
    Write-Host "gate: this is NOT a test failure. Do not dispatch a debugger against it."
  }

  Write-Host ""
  Write-Host "EXITCODE:$code"
  exit $code
} finally {
  Pop-Location
}
