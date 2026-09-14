# No-git versioning mechanism (ADR 0003: no git, no VCS, ever, for this repo).
# Computes the next `v1.<YYYYMMDD>.<n>` stamp from VERSION, stages an
# exclusion-filtered copy of the repo tree via robocopy, compresses it to a
# stamped zip in an EXTERNAL folder (-OutDir, default D:\kd\wp-snapshots),
# then bumps VERSION and appends a CHANGELOG.md entry. See
# docs/CONVENTIONS.md "Versioning without git" for the canonical spec.
#
# Usage:
#   scripts/snapshot.ps1 -Message "one line summary of what changed"
#   scripts/snapshot.ps1 -Message "..." -OutDir D:\somewhere-else
#   scripts/snapshot.ps1 -Message "..." -DryRun   # prints plan, writes nothing

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Message,

    [string]$OutDir = 'D:\kd\wp-snapshots',

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$versionFile = Join-Path $repoRoot 'VERSION'
$changelogFile = Join-Path $repoRoot 'CHANGELOG.md'

# Directories/files never in a snapshot archive, at ANY depth - every package
# has its own node_modules/dist, and .secrets must never leave the machine.
$excludeDirNames = @('node_modules', 'demo', '.secrets', 'dist', 'coverage')
$excludeFilePatterns = @('.env*', '*.tsbuildinfo')

# --- Compute next version -------------------------------------------------

if (-not (Test-Path -Path $versionFile)) {
    Write-Error "VERSION file not found at '$versionFile'."
    exit 1
}

if (-not (Test-Path -Path $changelogFile)) {
    Write-Error "CHANGELOG.md file not found at '$changelogFile'."
    exit 1
}

$versionLine = (Get-Content -Path $versionFile -Raw).Trim()
if ($versionLine -notmatch '^v1\.(\d{8})\.(\d+)$') {
    Write-Error "VERSION file has unexpected content: '$versionLine' (expected 'v1.<YYYYMMDD>.<n>')."
    exit 1
}

$storedDateStamp = $Matches[1]
$storedN = [int]$Matches[2]

$todayStamp = Get-Date -Format 'yyyyMMdd'
if ($todayStamp -eq $storedDateStamp) {
    $nextN = $storedN + 1
} else {
    $nextN = 1
}
$nextVersion = "v1.$todayStamp.$nextN"
$archiveName = "wp-$nextVersion.zip"
$archivePath = Join-Path $OutDir $archiveName
$todayDash = Get-Date -Format 'yyyy-MM-dd'

# Builds the bumped CHANGELOG.md content (header, blank line, new entry,
# blank line, then the pre-existing body) from an existing changelog file's
# lines. Shared by both the staging-tree write (so the archive's internal
# stamp matches the filename stamp) and the real post-archive write (so the
# two can never drift apart).
function Get-BumpedChangelogLines([string[]]$existingLines, [string]$nextVersion, [string]$todayDash, [string]$message) {
    $header = $existingLines[0]

    $restStartIndex = 1
    while ($restStartIndex -lt $existingLines.Count -and $existingLines[$restStartIndex].Trim() -eq '') {
        $restStartIndex++
    }
    $restLines = @()
    if ($restStartIndex -lt $existingLines.Count) {
        $restLines = $existingLines[$restStartIndex..($existingLines.Count - 1)]
    }

    return @($header, '', "## $nextVersion - $todayDash", '', "- $message", '') + $restLines
}

# --- Dry run: report the plan, write nothing ------------------------------

if ($DryRun) {
    $topLevelItems = Get-ChildItem -Force -Path $repoRoot
    $includedTopLevel = @()
    foreach ($item in $topLevelItems) {
        if ($item.PSIsContainer) {
            if ($excludeDirNames -contains $item.Name) { continue }
        } else {
            $isExcludedFile = $false
            foreach ($pattern in $excludeFilePatterns) {
                if ($item.Name -like $pattern) { $isExcludedFile = $true; break }
            }
            if ($isExcludedFile) { continue }
        }
        $includedTopLevel += $item.Name
    }

    Write-Host "Current VERSION: $versionLine"
    Write-Host "Next version:    $nextVersion"
    Write-Host "Target archive:  $archivePath"
    Write-Host ""
    Write-Host "Excluded dirs (any depth):  $($excludeDirNames -join ', ')"
    Write-Host "Excluded files (any depth): $($excludeFilePatterns -join ', ')"
    Write-Host ""
    Write-Host "Top-level items that would be included:"
    foreach ($name in $includedTopLevel) {
        Write-Host "  $name"
    }
    Write-Host ""
    Write-Host "DRY RUN: nothing written (no archive, no VERSION bump, no CHANGELOG entry)."
    exit 0
}

# --- Real run: refuse to clobber an existing archive ----------------------

if (Test-Path -Path $archivePath) {
    Write-Error "Archive '$archivePath' already exists. Refusing to overwrite (bump collision)."
    exit 1
}

if (-not (Test-Path -Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

# --- Stage an exclusion-filtered copy of the repo tree, then compress -----

$stagingDir = Join-Path ([System.IO.Path]::GetTempPath()) ("wp-snapshot-staging-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null

$archiveWritten = $false
try {
    robocopy $repoRoot $stagingDir /MIR /XD $excludeDirNames /XF $excludeFilePatterns /NFL /NDL /NJH /NJS /NP /R:1 /W:1
    $robocopyExit = $LASTEXITCODE

    # robocopy exit codes: 0-7 are success (various combinations of copied /
    # skipped / extra files), 8 and above are failure.
    if ($robocopyExit -ge 8) {
        Write-Error "robocopy failed staging the snapshot (exit code $robocopyExit). No archive was written."
        exit 1
    }

    # Stamp the STAGED tree with the NEXT version/changelog entry before
    # compressing, so the archive's internal VERSION/CHANGELOG.md already
    # reflect the version the archive is named after - never the pre-bump
    # stamp. The real repo tree's VERSION/CHANGELOG.md are only bumped below,
    # after a successful archive write, so a failed archive changes nothing
    # in the real tree.
    $stagedVersionFile = Join-Path $stagingDir 'VERSION'
    $stagedChangelogFile = Join-Path $stagingDir 'CHANGELOG.md'
    Set-Content -Path $stagedVersionFile -Value $nextVersion
    $stagedExistingLines = @(Get-Content -Path $stagedChangelogFile)
    $stagedNewLines = Get-BumpedChangelogLines $stagedExistingLines $nextVersion $todayDash $Message
    Set-Content -Path $stagedChangelogFile -Value $stagedNewLines

    Compress-Archive -Path (Join-Path $stagingDir '*') -DestinationPath $archivePath -CompressionLevel Optimal
    $archiveWritten = $true
} finally {
    if (Test-Path -Path $stagingDir) {
        Remove-Item -Path $stagingDir -Recurse -Force
    }
}

if (-not $archiveWritten) {
    Write-Error "Archive was not written; aborting before touching VERSION/CHANGELOG.md."
    exit 1
}

Write-Host "Wrote archive: $archivePath"

# --- Archive succeeded: bump VERSION, then append CHANGELOG.md -----------
# Archive first, bump second - if the bump half-fails, tell the user exactly
# which parts happened so nothing is silently inconsistent.

$versionBumped = $false
try {
    Set-Content -Path $versionFile -Value $nextVersion
    $versionBumped = $true

    $existingLines = @(Get-Content -Path $changelogFile)
    $newLines = Get-BumpedChangelogLines $existingLines $nextVersion $todayDash $Message
    Set-Content -Path $changelogFile -Value $newLines

    Write-Host "Bumped VERSION to $nextVersion and appended a CHANGELOG.md entry."
} catch {
    if ($versionBumped) {
        Write-Error "Archive written to '$archivePath' and VERSION bumped to $nextVersion, but updating CHANGELOG.md failed: $_. Fix CHANGELOG.md manually."
    } else {
        Write-Error "Archive written to '$archivePath', but bumping VERSION failed: $_. VERSION file is unchanged."
    }
    exit 1
}

exit 0
