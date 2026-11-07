#requires -Version 5.1
<#
 .SYNOPSIS
  Stores the Fairlead client key Semaphore uses for AI drafting, encrypted for this Windows account.
 .DESCRIPTION
  Normally Fairlead installs the key itself (Fairlead > Clients, install for Semaphore). Use this script as a
  manual fallback: create the key in Fairlead > Clients (it starts with fl-); this script asks for it without
  showing it, then stores it in Windows Credential Manager as Fairlead/Semaphore.
  The credential belongs to the current Windows account. The key is never printed or logged.
  Afterwards it asks Fairlead whether the key works. A running Semaphore picks the key up on the
  next draft; no restart is needed.
 .PARAMETER Clear
  Delete the stored key. Semaphore then drafts with local rules only.
 .PARAMETER Check
  Do not change the key; only check the stored one against Fairlead.
#>
[CmdletBinding()]
param([switch]$Clear, [switch]$Check)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
. (Join-Path $here 'Common.ps1')
. (Join-Path $here 'Http.ps1')
. (Join-Path $here 'Routes.ps1')
. (Join-Path $here 'Intelligence.ps1')

$path = Get-SemAiKeyPath
if ($Clear) {
    $had = $false
    try { $had = [bool](Read-SemAiCredential) } catch { $had = $false }
    Remove-SemAiCredential
    if ([IO.File]::Exists($path)) { [IO.File]::Delete($path); $had = $true }
    if ($had) { Write-Host 'Removed the stored Fairlead key. Semaphore drafts with local rules until you set one again.' }
    else { Write-Host 'No Fairlead key was stored.' }
    return
}

if (-not $Check) {
    Write-Host 'Semaphore drafts through Fairlead. Paste the client key from Fairlead > Clients (it starts with fl-).'
    Write-Host 'It is not shown while you paste, and it is stored in Windows Credential Manager for your Windows account.'
    $secure = Read-Host -Prompt 'Fairlead client key' -AsSecureString
    if ($secure.Length -eq 0) { Write-Host 'Nothing entered; the stored key is unchanged.'; return }
    try { Save-SemAiCredential -Key $secure }
    catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
    Write-Host 'Saved to Windows Credential Manager as Fairlead/Semaphore' -ForegroundColor Green
}

$s = Get-SemAiSettings -Root (Get-SemRoot)
if ($s.Problem) { Write-Host $s.Problem -ForegroundColor Red; exit 1 }
if (-not $s.Key) { Write-Host 'No Fairlead key is stored. Run this script without -Check to set one.' -ForegroundColor Yellow; exit 1 }
if ($s.KeySource -eq 'environment') { Write-Host 'Note: SEMAPHORE_AI_KEY is set, so it is used instead of the stored key.' -ForegroundColor Yellow }
Write-Host ('Checking Fairlead at ' + $s.Url + ' ...')
$notFairlead = Test-SemAiIdentity -Settings $s
if ($notFairlead) { Write-Host $notFairlead.Error -ForegroundColor Yellow; Write-Host 'The key is stored; Semaphore will use it once Fairlead answers on that port.'; exit 2 }
$r = Invoke-SemAiForward -Settings $s -Method GET -RelPath '/models' -TimeoutSec 15
if ($r.Status -eq 200) {
    Write-Host ('Fairlead accepted the key. Drafts will use route "' + $s.Model + '"' + $(if ($s.PrivacyLocal) { ', kept on this machine.' } else { '.' })) -ForegroundColor Green
    exit 0
}
if ($r.Status -eq 0) { Write-Host $r.Error -ForegroundColor Yellow; Write-Host 'The key is stored; Semaphore will use it once Fairlead is running.'; exit 2 }
if ($r.Status -eq 401 -or $r.Status -eq 403) { Write-Host 'Fairlead refused this key. Create a new one in Fairlead > Clients and run this again.' -ForegroundColor Red; exit 1 }
Write-Host ('Fairlead answered ' + $r.Status + '. ' + (Get-SemAiErrorText $r.Bytes $s.Key)) -ForegroundColor Yellow
exit 2
