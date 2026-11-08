#requires -Version 5.1
<#
.SYNOPSIS
  Starts Semaphore: the local server on 127.0.0.1 (port block 8800-8802) and the browser.
  Launch-Semaphore.bat calls this. Windows PowerShell 5.1 only. ASCII only.
.DESCRIPTION
  Lifecycle (TechStack "Lifecycle rules"): the server stops 90 s after the last heartbeat of its
  browser tab, 5 s after a leaving signal with no new heartbeat, from End session in the browser,
  or with Stop-Semaphore.ps1. One copy runs at a time:
    - a running copy of the same version that no tab is using: the browser is opened on it (reuse);
    - a running copy that a tab is using: "Stop it and start fresh?" (Yes/No box; No opens it);
    - an older copy is stopped and replaced; a newer copy is reused ("stale launcher" in the log).
  Options (switches or launcher flags):
    -Replace     / --replace      stop a running copy without asking
    -Stay        / --stay         keep running after the tab closes (also SEMAPHORE_AUTO_STOP=0,
                                  as an environment variable or a line in config\semaphore.env)
    -NoBrowser   / --no-browser   do not open a browser; print the session link to this console
    -ShowConsole / --console      started in a visible console (questions are asked there)
    -Port n      / --port n       use exactly this port
    -CheckOnly   / --check-only   self-check only (scripts parse, settings, sources); no server
    -Ask         / --ask          open the leadership view (Ask-Semaphore.bat); settings "view" sets the default
    -Refresh     / --refresh      refresh every playbook snapshot in a headless Edge or Chrome, report, and
                                  stop (for an IT-approved morning run on an always-on machine; at most
                                  settings refreshTimeoutMin minutes). Exit 3 when another Semaphore was
                                  already running and nothing was refreshed.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [int]$Port = 0,
    [switch]$NoBrowser,
    [switch]$ShowConsole,
    [switch]$Stay,
    [switch]$Replace,
    [switch]$CheckOnly,
    [switch]$Ask,
    [switch]$Refresh,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)
$ErrorActionPreference = 'Stop'
# Started from a PowerShell 7 console, 5.1 inherits 7's PSModulePath and autoloads 7's core modules,
# which fail here (Import-PowerShellDataFile "not recognized"). Keep only the 5.1-compatible entries.
if ($PSVersionTable.PSVersion.Major -lt 6 -and $env:PSModulePath) {
    $env:PSModulePath = (($env:PSModulePath -split ';') |
        Where-Object { $_ -and $_ -notmatch '\\PowerShell\\|\\microsoft\.powershell_' }) -join ';'
}
$here = $PSScriptRoot
$root = Split-Path -Parent $here

$restArgs = @($Rest)
for ($i = 0; $i -lt $restArgs.Count; $i++) {
    $a = [string]$restArgs[$i]
    switch -Regex ($a) {
        '^(--?|/)console$' { $ShowConsole = $true; continue }
        '^(--?|/)stay$' { $Stay = $true; continue }
        '^(--?|/)replace$' { $Replace = $true; continue }
        '^(--?|/)no-?browser$' { $NoBrowser = $true; continue }
        '^(--?|/)check-?only$' { $CheckOnly = $true; continue }
        '^(--?|/)ask$' { $Ask = $true; continue }
        '^(--?|/)refresh$' { $Refresh = $true; continue }
        '^(--?|/)port$' {
            if ($i + 1 -lt $restArgs.Count) { $i++; $p = 0; if ([int]::TryParse([string]$restArgs[$i], [ref]$p)) { $Port = $p } }
            continue
        }
        '^(--?|/)port=(\d+)$' { $Port = [int]$Matches[2]; continue }
        default { if ($a) { Write-Warning "Ignoring unknown option $a" } }
    }
}

. (Join-Path $here 'Common.ps1')
$logFile = Initialize-SemLog -Root $root

function Show-Fatal([string]$Text) {
    # The console is usually hidden, so a fatal error goes to the log and a message box.
    Write-SemLog 'FATAL' $Text
    Write-Host "Semaphore could not start. $Text" -ForegroundColor Red
    if ((Test-SemIsWindows) -and -not $ShowConsole) {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            [void][System.Windows.Forms.MessageBox]::Show("Semaphore could not start.`n`n$Text`n`nLog: $logFile", 'Semaphore', 'OK', 'Error')
        } catch { }
    }
}
trap { Show-Fatal ("{0} (line {1})" -f $_.Exception.Message, $_.InvocationInfo.ScriptLineNumber); exit 1 }

function Show-SemQuestion([string]$Text) {
    # Yes/No on top of every window ($true / $false), or $null when no dialog can be shown.
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $owner = New-Object System.Windows.Forms.Form
        $owner.TopMost = $true
        try {
            $r = [System.Windows.Forms.MessageBox]::Show($owner, $Text, 'Semaphore', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
            return ($r -eq [System.Windows.Forms.DialogResult]::Yes)
        } finally { $owner.Dispose() }
    } catch { return $null }
}

function Find-SemBrowser([string]$Choice) {
    # Edge, else Chrome (per settings.browser); $null means the default browser.
    $pf = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
    $edge = @(foreach ($b in $pf) { Join-Path $b 'Microsoft\Edge\Application\msedge.exe' })
    $chrome = @(foreach ($b in $pf) { Join-Path $b 'Google\Chrome\Application\chrome.exe' })
    $order = @()
    switch ($Choice) {
        'edge' { $order = $edge + $chrome }
        'chrome' { $order = $chrome + $edge }
        'default' { $order = @() }
        default { $order = $edge + $chrome }
    }
    foreach ($exe in $order) { if (Test-Path -LiteralPath $exe) { return $exe } }
    return $null
}

function Get-SemHeadlessProfile {
    return [IO.Path]::Combine($root, 'temp', 'refresh-browser')
}

function Start-SemHeadless([string]$Url, [hashtable]$Settings) {
    # The refresher: the page itself plans and runs the snapshot queries, so the headless browser
    # uses exactly the code analysts use. Its own profile folder keeps it apart from anyone's browser.
    if (-not (Test-SemIsWindows)) { Write-Host "Open this link in a browser to refresh: $Url"; return $true }
    $exe = Find-SemBrowser $Settings.browser
    if (-not $exe) { Write-SemLog 'ERROR' 'Refresh: Edge or Chrome is needed for --refresh and neither was found'; return $false }
    $profileDir = Get-SemHeadlessProfile
    [void][IO.Directory]::CreateDirectory($profileDir)
    $argLine = '--headless=new --disable-gpu --no-first-run --no-default-browser-check --disable-extensions --user-data-dir="' + $profileDir + '" "' + $Url + '"'
    Start-Process -FilePath $exe -ArgumentList $argLine -WindowStyle Hidden
    Write-SemLog 'INFO' ('Refresh: started headless ' + [IO.Path]::GetFileName($exe))
    return $true
}

function Stop-SemHeadless {
    # Stop only the browser processes started with our own profile folder, never anyone else's.
    if (-not (Test-SemIsWindows)) { return }
    $profileDir = Get-SemHeadlessProfile
    try {
        foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" -ErrorAction Stop)) {
            if ($p.CommandLine -and $p.CommandLine.IndexOf($profileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
    } catch { Write-SemLog 'WARN' ('Refresh: could not check for the headless browser: ' + $_.Exception.Message) }
}

function Open-SemBrowser([string]$Url, [hashtable]$Settings) {
    # The session link carries a single-use launch code (never the token); it is not logged either.
    if (-not (Test-SemIsWindows)) { Write-Host "Open this link: $Url"; return }
    $exe = Find-SemBrowser $Settings.browser
    if ($exe) {
        $arg = '--new-window "' + $Url + '"'
        if ($Settings.appWindow) { $arg = '--app="' + $Url + '"' }
        Start-Process -FilePath $exe -ArgumentList $arg
        Write-SemLog 'INFO' ('Opened ' + [IO.Path]::GetFileName($exe) + ' on http://127.0.0.1:' + $script:Sem.Port + '/')
    } else {
        Start-Process $Url
        Write-SemLog 'INFO' ('Opened the default browser on http://127.0.0.1:' + $script:Sem.Port + '/')
    }
}

function Invoke-SemSelfCheck {
    # Static checks with no server: scripts parse and are ASCII, settings, version, port block, sources.
    $problems = New-Object System.Collections.Generic.List[string]
    foreach ($f in @(Get-ChildItem -LiteralPath $here -File | Where-Object { @('.ps1', '.psm1', '.psd1') -contains $_.Extension.ToLowerInvariant() })) {
        $tokens = $null; $errs = $null
        [void][Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
        foreach ($e in @($errs)) { $problems.Add(('{0}:{1}: {2}' -f $f.Name, $e.Extent.StartLineNumber, $e.Message)) }
        foreach ($b in [IO.File]::ReadAllBytes($f.FullName)) { if ($b -gt 127) { $problems.Add("$($f.Name): contains non-ASCII bytes"); break } }
    }
    $v = Get-SemVersion -Root $root
    if ($v -eq '0.0.0') { $problems.Add('VERSION is missing or not semver') }
    try {
        Import-Module (Join-Path $here 'FleetPort.psm1') -Force
        $b = Get-FleetPortBlock -Tool 'semaphore' -RegistryPath (Join-Path $here 'FleetPorts.psd1')
        if ($b.Start -ne 8800 -or $b.End -ne 8802 -or $b.Policy -ne 'reuse') { $problems.Add('FleetPorts.psd1: semaphore must be 8800-8802, reuse') }
    } catch { $problems.Add('Port block: ' + $_.Exception.Message) }
    $s = Read-SemSettings -Root $root
    $homeDir = Resolve-SemHome -Settings $s
    foreach ($src in @(Get-SemSources -HomeDir $homeDir)) {
        $bad = Test-SemSourceConnection $src
        if ($bad) { $problems.Add("Source '$($src.id)': $bad") }
        if ($src.kind -eq 'aws-rds') {
            # The driver an RDS source would use on this computer (Aws.ps1); a missing one is a note, not a failure.
            try { Write-Host ("Source '{0}' ({1}): ODBC driver ""{2}""" -f $src.id, $src.engine, (Find-SemRdsDriver -Rds (Get-SemRdsSettings $src.raw))) }
            catch { Write-Host ("Note: source '{0}': {1}" -f $src.id, ([string]$_.Exception.Message -replace '^provider-unavailable:\s*', '')) -ForegroundColor Yellow }
        }
    }
    if (-not (Test-Path -LiteralPath ([IO.Path]::Combine($root, 'web', 'dist', 'index.html')))) { Write-Host 'Note: web\dist\index.html is missing (the UI is not built). Use the Semaphore-<version>.zip from the Releases page, not the source code; the server would show a "not built" page with these steps.' -ForegroundColor Yellow }
    Write-Host ("Semaphore {0}, home {1}, auto-stop {2}" -f $v, $homeDir, $(if (Test-SemAutoStopEnabled -Root $root) { 'on' } else { 'off' }))
    if ($problems.Count -gt 0) {
        foreach ($p in $problems) { Write-Host "  FAIL $p" -ForegroundColor Red; Write-SemLog 'ERROR' "Self-check: $p" }
        return $false
    }
    Write-Host 'Self-check passed.' -ForegroundColor Green
    Write-SemLog 'INFO' 'Self-check passed.'
    return $true
}

# ---------------------------------------------------------------------------
if ($PSVersionTable.PSVersion.Major -ne 5 -and $env:SEMAPHORE_ALLOW_PWSH -ne '1') {
    throw "Run Semaphore with Windows PowerShell 5.1 (powershell.exe), not PowerShell $($PSVersionTable.PSVersion)."
}
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    throw ("PowerShell runs in {0} mode here (an application-control policy). Semaphore needs FullLanguage." -f $ExecutionContext.SessionState.LanguageMode)
}

# Temp files (Add-Type scratch, .NET temp) stay inside the tool folder.
$env:TEMP = [IO.Path]::Combine($root, 'temp', 'sys'); $env:TMP = $env:TEMP
if (-not (Test-Path -LiteralPath $env:TEMP)) { [void][IO.Directory]::CreateDirectory($env:TEMP) }

. (Join-Path $here 'Http.ps1')
. (Join-Path $here 'Routes.ps1')
. (Join-Path $here 'Query.ps1')
. (Join-Path $here 'Intelligence.ps1')
. (Join-Path $here 'Lake.ps1')
. (Join-Path $here 'Vault.ps1')
. (Join-Path $here 'Connectors.ps1')
. (Join-Path $here 'LocalDb.ps1')
. (Join-Path $here 'S3.ps1')
. (Join-Path $here 'Commands.ps1')
Import-Module (Join-Path $here 'FleetPort.psm1') -Force

if ($CheckOnly) { if (Invoke-SemSelfCheck) { exit 0 } else { exit 1 } }

$version = Get-SemVersion -Root $root
$settings = Read-SemSettings -Root $root
$homeDir = Resolve-SemHome -Settings $settings -Create
$autoStop = (-not $Stay) -and (Test-SemAutoStopEnabled -Root $root)
Write-SemLog 'INFO' ("Semaphore {0} launcher (PID {1}, PowerShell {2}); home {3}" -f $version, $PID, $PSVersionTable.PSVersion, $homeDir)

if ($Refresh) {
    $Stay = $false; $NoBrowser = $true; $autoStop = $true
    if (@(Get-SemInstances -Root $root).Count -gt 0) {
        # A copy someone is using refreshes stale snapshots itself; never interrupt it.
        Write-SemLog 'INFO' 'Refresh: Semaphore is already running on this computer; it refreshes snapshots itself. Nothing to do.'
        exit 0
    }
}

# ---- Lazarette (only when a source takes secrets from it) ------------------------
# Nothing of Lazarette loads here: each request reads its shares over loopback (Vault.ps1, Lazarette.Client.ps1).
$vaultSources = @(Get-SemSources -HomeDir $homeDir | Where-Object { Get-SemSourceVault $_ })
if ($vaultSources.Count -gt 0 -and -not $CheckOnly) {
    if (Test-SemVaultPaired) { Write-SemLog 'INFO' ('{0} source(s) read their secrets from Lazarette over loopback' -f $vaultSources.Count) }
    else { Write-SemLog 'WARN' ('{0} source(s) take secrets from Lazarette, but Semaphore is not paired with it: run Semaphore-CLI.bat vault pair' -f $vaultSources.Count) }
}

# ---- One instance -----------------------------------------------------------
function Exit-SemReuse([int]$ReusePort, [string]$Why) {
    if ($Refresh) {
        # A refresh run must not hand its work to a copy someone is using (it refreshes stale snapshots itself),
        # and must not report success for a refresh that did not run: exit 3, which the CLI reports.
        Write-SemLog 'WARN' ("Refresh: another Semaphore is already running on port {0} ({1}); nothing was refreshed" -f $ReusePort, $Why)
        Write-Host "Refresh: another Semaphore is already running on http://127.0.0.1:$ReusePort/ ($Why); nothing was refreshed." -ForegroundColor Yellow
        exit 3
    }
    Write-SemLog 'INFO' ("Reusing the running Semaphore on port {0}: {1}" -f $ReusePort, $Why)
    if ($NoBrowser) { Write-Host "Semaphore is already running on http://127.0.0.1:$ReusePort/ ($Why)." -ForegroundColor Yellow }
    elseif (-not (Request-SemOpenBrowser -Port $ReusePort)) { Write-SemLog 'WARN' "The running copy on port $ReusePort did not accept the open request" }
    exit 0
}

$running = @(Get-SemInstances -Root $root)
if ($running.Count -gt 0) {
    $where = ($running | ForEach-Object { Format-SemInstance $_ }) -join ', '
    if ($Replace) {
        Write-SemLog 'INFO' "Replacing running copy ($where): --replace"
        foreach ($r in $running) { if (Stop-SemInstance -Instance $r) { Write-Host ('Stopped ' + (Format-SemInstance $r) + '.') -ForegroundColor Yellow } }
    } else {
        $live = $null
        foreach ($r in $running) { if ($r.Port -gt 0) { $id = Get-SemInstanceId -Port $r.Port; if ($id -and $id.Pid -eq $r.Pid) { $live = $id; break } } }
        if ($null -eq $live) {
            # No copy answers: one is still starting (no runtime file yet), or it hangs.
            $starting = @($running | Where-Object { -not $_.File } | Where-Object {
                $p = Get-Process -Id $_.Pid -ErrorAction SilentlyContinue
                $young = $false
                # StartTime is denied for another account's process: such a copy is not "ours still starting".
                if ($p) { try { $young = ($p.StartTime -and ((Get-Date) - $p.StartTime).TotalSeconds -lt 90) } catch { $young = $false } }
                $young })
            if ($starting.Count -gt 0) { Write-SemLog 'INFO' "Another launch is still starting ($where); leaving it"; exit 0 }
            Write-SemLog 'WARN' "A running copy does not answer ($where): stopping it"
            foreach ($r in $running) { [void](Stop-SemInstance -Instance $r) }
        } else {
            $cmp = Compare-SemVersion $live.Version $version
            if ($cmp -gt 0) {
                Write-SemLog 'WARN' ("Stale launcher: Semaphore {0} was started, but newer {1} is already running on port {2}" -f $version, $live.Version, $live.Port)
                Exit-SemReuse $live.Port 'newer version running'
            }
            if ($null -eq $cmp -or $cmp -lt 0) {
                Write-SemLog 'INFO' ("Replacing older Semaphore {0} on port {1}" -f $live.Version, $live.Port)
                foreach ($r in $running) { [void](Stop-SemInstance -Instance $r) }
            } elseif ($live.Tabs -le 0) {
                Exit-SemReuse $live.Port 'same version, no tab open'
            } else {
                $question = "Semaphore is already open in $($live.Tabs) browser tab$(if ($live.Tabs -ne 1) { 's' }) (http://127.0.0.1:$($live.Port)/).`n`nStop it and start fresh? Unsaved changes in that tab are lost.`n`nNo switches to the running copy."
                $yes = $null
                if ($ShowConsole -or -not (Test-SemIsWindows)) {
                    Write-Host $question -ForegroundColor Yellow
                    $answer = ''
                    try { $answer = Read-Host 'Stop it and start fresh? [y/N]' } catch { $answer = '' }
                    $yes = ($answer -match '^[Yy]')
                } else {
                    $yes = Show-SemQuestion $question
                }
                if ($yes -ne $true) { Exit-SemReuse $live.Port 'kept the running copy' }
                Write-SemLog 'INFO' "Running copy in use ($where): replaced on request"
                foreach ($r in $running) { [void](Stop-SemInstance -Instance $r) }
            }
        }
    }
}

# ---- Port block 8800-8802 (PORTS.md), FleetPort reuse policy ---------------------
$resolveArgs = @{ Tool = 'semaphore'; Version = $version; RegistryPath = (Join-Path $here 'FleetPorts.psd1'); NoListener = $true }
if ($Port -gt 0) { $resolveArgs.Start = $Port; $resolveArgs.Size = 1; $resolveArgs.Policy = 'reuse' }
elseif ($settings.port -gt 0) { $resolveArgs.Start = $settings.port }
$res = Resolve-FleetPort @resolveArgs
if ($res.Note) { Write-SemLog 'WARN' $res.Note }
if ($res.Action -eq 'Reuse') { Exit-SemReuse $res.Port 'found on its port' }
$listener = New-SemListener -Port $res.Port

# ---- Serve ----------------------------------------------------------------------
$script:Sem.Root = $root
$script:Sem.WebRoot = [IO.Path]::Combine($root, 'web', 'dist')
$script:Sem.Home = $homeDir
$script:Sem.Version = $version
$script:Sem.ScriptPath = $PSCommandPath
$script:Sem.Stay = [bool]$Stay
$script:Sem.Token = New-SemToken
$script:Sem.Port = $res.Port
$baseUrl = 'http://127.0.0.1:{0}/' -f $res.Port
$script:Sem.View = [string]$settings.view
if ($Ask) { $script:Sem.View = 'ask' }
if ($Refresh) { $script:Sem.View = 'refresh'; $script:Sem.Deadline = (Get-Date).AddMinutes($settings.refreshTimeoutMin) }
$script:Sem.Reviewer = [string]$settings.playbookReviewer
$script:Sem.Skin = [string]$settings.skin
$script:Sem.Social = Get-SemSocialSettings -Settings $settings
# Local database (LocalDb.ps1): network shares it may read, the upload cap, and the database itself.
$script:Sem.LocalShares = @($settings.localShares)
$script:Sem.LocalMaxBytes = [long]$settings.localImportMaxGB * 1GB
try { [void](Initialize-SemLocalDb -HomeDir $homeDir -Cleanup) } catch { Write-SemLog 'WARN' ('The local database is not available on this computer: ' + $_.Exception.Message) }
$script:Sem.AwsSettings = @{ S3 = $settings.s3; Aws = $settings.aws }
# Each link carries a fresh single-use launch code, never the session token (Http.ps1, Launch codes):
# browser command lines and console transcripts are recorded on the workstation.
function New-SemSessionLink {
    $u = $baseUrl + '?launch=' + (New-SemLaunchCode)
    if ($script:Sem.View -eq 'ask' -or $script:Sem.View -eq 'refresh') { $u += '&view=' + $script:Sem.View }
    return $u
}

if (-not (Test-Path -LiteralPath (Join-Path $script:Sem.WebRoot 'index.html'))) { Write-SemLog 'WARN' 'web\dist\index.html is missing: serving the "UI not built" page' }
Write-SemLog 'INFO' ("Serving {0} (PID {1}, auto-stop {2}, stay {3})" -f $baseUrl, $PID, $autoStop, [bool]$Stay)

$onReady = {
    $how = 'It stops when you close its browser tab or choose End session.'
    if (-not $autoStop) { $how = 'It keeps running after the tab closes: use End session or Stop-Semaphore.ps1.' }
    Write-Host ("Semaphore {0} is running at {1}. {2}" -f $version, $baseUrl, $how) -ForegroundColor Green
    if ($Refresh) {
        if (-not (Start-SemHeadless -Url (New-SemSessionLink) -Settings $settings)) { Request-SemStop 'refresh-no-browser' }
    }
    elseif ($NoBrowser) { Write-Host ('Session link (works once, for 10 minutes): ' + (New-SemSessionLink)) }
    else {
        try { Open-SemBrowser -Url (New-SemSessionLink) -Settings $settings }
        catch { Write-SemLog 'ERROR' ('Could not open the browser: ' + $_.Exception.Message); Write-Host ('Open this link (works once, for 10 minutes): ' + (New-SemSessionLink)) -ForegroundColor Yellow }
    }
}
$onOpen = { Open-SemBrowser -Url (New-SemSessionLink) -Settings $settings }
try {
    Start-SemHttpServer -Listener $listener -Settings $settings -AutoStop $autoStop -OnReady $onReady -OnOpenBrowser $onOpen
} finally {
    if ($Refresh) { Stop-SemHeadless }
}
exit 0
