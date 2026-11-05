#requires -Version 5.1
<#
.SYNOPSIS
  Builds and checks Semaphore, then packs a self-contained zip that runs with no installs.
.DESCRIPTION
  Runs on a development machine with Node.js 22.18 or later (npm ci installs the build tools).
  The output dist\Semaphore-<version>.zip needs nothing on the workstation except Windows PowerShell 5.1
  and Microsoft Edge or Chrome (both already present on Windows 10 and 11). It holds the PowerShell
  server, the built browser UI (web\dist), the launchers, the sample catalog, docs and the default
  settings. It contains no DLL, EXE or PDB: the workstation blocks loading custom binaries.
  Extract the zip anywhere and double-click Launch-Semaphore.bat.
.PARAMETER SkipTests
  Skip the TypeScript tests and the typecheck.
.PARAMETER SkipWeb
  Reuse an existing web\dist instead of rebuilding the UI.
.PARAMETER NoZip
  Assemble dist\Semaphore but do not create the zip.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File build\Build-Semaphore.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipTests,
    [switch]$SkipWeb,
    [switch]$NoZip
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root 'dist'
$bundle = Join-Path $dist 'Semaphore'

function Step([string]$m) { Write-Host ''; Write-Host ('== ' + $m) -ForegroundColor Cyan }
function Run([string]$exe, [string[]]$arguments, [string]$cwd = $root) {
    Write-Host ('> ' + $exe + ' ' + ($arguments -join ' ')) -ForegroundColor DarkGray
    Push-Location $cwd
    # npm writes warnings to stderr; Windows PowerShell turns those into terminating errors under 'Stop'.
    # Judge the tool by its exit code only.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $exe @arguments 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host $_.Exception.Message -ForegroundColor DarkYellow } else { Write-Host $_ } }
        if ($LASTEXITCODE -ne 0) { throw ($exe + ' exited with ' + $LASTEXITCODE) }
    } finally { $ErrorActionPreference = $previous; Pop-Location }
}

if (-not $SkipWeb) {
    foreach ($tool in @('node', 'npm')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            throw ($tool + ' is required on the build machine (not on the workstation). Install Node.js 22.18 or later.')
        }
    }
    $web = Join-Path $root 'web'
    Step 'Browser UI'
    if (Test-Path (Join-Path $root 'package-lock.json')) { Run npm @('ci', '--no-audit', '--no-fund') }
    else { Run npm @('install', '--no-audit', '--no-fund') }
    if (-not $SkipTests) {
        Run npm @('run', 'typecheck')
        Run npm @('test')
    }
    Run npm @('run', 'build')
}
if (-not (Test-Path (Join-Path $root 'web\dist\index.html'))) { throw 'web\dist\index.html is missing; build the UI first.' }

Step ('Assembling ' + $bundle)
if (Test-Path $bundle) { Remove-Item $bundle -Recurse -Force }
New-Item -ItemType Directory -Force $bundle | Out-Null

Copy-Item (Join-Path $root 'server') (Join-Path $bundle 'server') -Recurse
Copy-Item (Join-Path $root 'web\dist') (Join-Path $bundle 'web\dist') -Recurse
New-Item -ItemType Directory -Force (Join-Path $bundle 'config') | Out-Null
Copy-Item (Join-Path $root 'config\settings.json') (Join-Path $bundle 'config')
Copy-Item (Join-Path $root 'examples') (Join-Path $bundle 'examples') -Recurse
Copy-Item (Join-Path $root 'docs') (Join-Path $bundle 'docs') -Recurse
foreach ($f in @('Launch-Semaphore.bat', 'Ask-Semaphore.bat', 'Semaphore-CLI.bat', 'Set-SemaphoreAiKey.bat', 'README.md', 'LICENSE', 'CHANGELOG.md', 'VERSION')) {
    Copy-Item (Join-Path $root $f) $bundle
}

# Nothing to install: the bundle must hold no binaries and no build tools.
$bad = @(Get-ChildItem -LiteralPath $bundle -Recurse -File | Where-Object { $_.Extension -in @('.dll', '.exe', '.pdb', '.msi') })
if ($bad.Count -gt 0) { throw ('The bundle must not contain binaries; found: ' + (($bad | ForEach-Object { $_.FullName.Substring($bundle.Length) }) -join ', ')) }
if (Test-Path (Join-Path $bundle 'node_modules')) { throw 'The bundle must not contain node_modules.' }

$version = (Get-Content -LiteralPath (Join-Path $root 'VERSION') -Raw).Trim()

# Self-check the assembled copy the way the workstation runs it, with no network and no UI launched.
Step 'Self-check of the assembled bundle'
Run powershell.exe @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $bundle 'server\Start-Semaphore.ps1'), '-CheckOnly') $bundle
# The self-check creates run-time folders; the workstation creates its own on first launch.
foreach ($d in @('logs', 'temp')) { $p = Join-Path $bundle $d; if (Test-Path $p) { Remove-Item $p -Recurse -Force } }

if (-not $NoZip) {
    $zip = Join-Path $dist ('Semaphore-' + $version + '.zip')
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path (Join-Path $bundle '*') -DestinationPath $zip
    Write-Host ('Bundle: ' + $zip) -ForegroundColor Green
}
Write-Host ('Done. Extract the zip on the workstation and double-click Launch-Semaphore.bat.') -ForegroundColor Green
