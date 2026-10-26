#requires -Version 5.1
<#
.SYNOPSIS
  Stops every running Semaphore server of this install. No PID needed.
.DESCRIPTION
  Semaphore normally stops itself when its browser tab closes, or from End session in the browser.
  This is the fallback (after Launch-Semaphore.bat --stay, or a hidden server whose tab is long gone):
  it reads the runtime files logs\semaphore-server-<pid>.json, asks each server to stop through
  POST /__fleethacker/shutdown, stops any that does not exit (after checking that the pid is still a
  PowerShell running Semaphore), and removes the files, including stale ones whose process is gone.
  On Windows it also finds any PowerShell still running this install's Start-Semaphore.ps1.
.PARAMETER Quiet
  Print nothing unless something was stopped.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\server\Stop-Semaphore.ps1
#>
[CmdletBinding()]
param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$root = Split-Path -Parent $PSScriptRoot
$stopped = @(Stop-SemInstances -Root $root)
if ($stopped.Count -gt 0) {
    foreach ($i in $stopped) { Write-Host ('Stopped Semaphore ' + (Format-SemInstance $i) + '.') -ForegroundColor Yellow }
} elseif (-not $Quiet) {
    Write-Host 'Semaphore is not running.' -ForegroundColor DarkGray
}
