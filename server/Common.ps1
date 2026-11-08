#requires -Version 5.1
# =============================================================================
# Semaphore shared helpers (Windows PowerShell 5.1, ASCII only). Dot-sourced by
# Start-Semaphore.ps1, Stop-Semaphore.ps1 and the query workers.
#   * version (root VERSION), settings (config\settings.json + config\settings.local.json),
#     home folder, auto-stop off switch (SEMAPHORE_AUTO_STOP=0 or config\semaphore.env)
#   * log lines: logs\Semaphore_yyyy_MM_dd_HHmmss.log, "yyyy-MM-dd HH:mm:ss  [LEVEL] text"
#   * running instances (TechStack "Lifecycle rules"): every server writes
#     logs\semaphore-server-<pid>.json (pid, port, url without token, startedAt) and deletes it
#     on stop. Get-SemInstances reads them and deletes stale ones (dead pid); Stop-SemInstance
#     asks a server to stop through /__fleethacker/shutdown, then stops the verified pid.
# =============================================================================

$script:SemLogPath = ''
$script:SemIdRx = '\A[A-Za-z0-9_-]{1,64}\z'

function Test-SemIsWindows { return ($env:OS -eq 'Windows_NT') }

function Get-SemRoot { return (Split-Path -Parent $PSScriptRoot) }

function Get-SemVersion {
    param([string]$Root = (Get-SemRoot))
    $f = Join-Path $Root 'VERSION'
    try {
        $v = ([IO.File]::ReadAllText($f)).Trim()
        if ($v -match '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') { return $v }
    } catch { }
    return '0.0.0'
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
function Initialize-SemLog {
    param([Parameter(Mandatory = $true)][string]$Root, [datetime]$Now = (Get-Date))
    $dir = Join-Path $Root 'logs'
    if (-not (Test-Path -LiteralPath $dir)) { [void][IO.Directory]::CreateDirectory($dir) }
    $script:SemLogPath = Join-Path $dir ('Semaphore_{0}.log' -f $Now.ToString('yyyy_MM_dd_HHmmss'))
    return $script:SemLogPath
}

function Write-SemLog {
    # Never pass a session token, a connection string or a request body here.
    param([string]$Level, [string]$Text)
    if (-not $script:SemLogPath) { return }
    try {
        $line = '{0}  [{1}] {2}{3}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Level.ToUpperInvariant(), $Text, [Environment]::NewLine
        [IO.File]::AppendAllText($script:SemLogPath, $line, (New-Object Text.UTF8Encoding $false))
    } catch { }   # logging never takes the server down
}

# ---------------------------------------------------------------------------
# Settings: built-in defaults <- config\settings.json (tracked) <- config\settings.local.json
# (gitignored), key by key. A missing or broken layer is skipped.
# ---------------------------------------------------------------------------
$script:SemSocialKeys = @('signalBook', 'impact', 'teamLog', 'showAskers', 'bz')

function Get-SemDefaultSettings {
    return @{
        home = ''; port = 0; browser = 'auto'; appWindow = $true
        heartbeatTimeoutSec = 90; leavingGraceSec = 5; firstHeartbeatSec = 120; queryWorkers = 4
        view = 'builder'; playbookReviewer = ''; refreshTimeoutMin = 30; skin = ''
        # The Start-Fairlead.ps1 (or Fairlead executable) path the Fairlead key may be sent to; '' accepts the path the
        # process that holds Fairlead's port runs, whatever it is (docs/INTELLIGENCE_PROVIDERS.md, "Port authority").
        fairleadPath = ''
        # Social and motivational features (docs/PLAYBOOK.md); each can be switched off per deployment.
        signalBook = $true; impact = $true; teamLog = $true; showAskers = $true; bz = $true
        # Local database (docs/LOCAL-DATABASE.md): the hosts whose \\host\share paths it may open (opening one sends the
        # user's Windows sign-in to that host), and the largest file the page may upload, in GB.
        localShares = @(); localImportMaxGB = 20
        # Amazon S3 browsing and import (S3.ps1) and the AWS session for it (aws.vault, aws.fips); checked where used.
        s3 = $null; aws = $null
        # TalkForge for spoken answers and voice input (Get-SemTalkForgeSettings): autoStart, folder, input.
        voice = $null
    }
}

function Get-SemSocialSettings {
    # The page's switches for the social features, as /api/info "social".
    param([hashtable]$Settings)
    $out = [ordered]@{}
    foreach ($k in $script:SemSocialKeys) { $out[$k] = [bool]$Settings[$k] }
    return $out
}

function Merge-SemSettingsFile {
    param([hashtable]$Settings, [string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $false }
    try { $j = [IO.File]::ReadAllText($Path) | ConvertFrom-Json } catch { Write-SemLog 'WARN' "Ignoring unreadable settings file $Path"; return $false }
    if ($null -eq $j) { return $false }
    $names = @($j.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -contains 'home' -and $null -ne $j.home) { $Settings.home = [string]$j.home }
    if ($names -contains 'port' -and $null -ne $j.port) { $p = 0; if ([int]::TryParse([string]$j.port, [ref]$p) -and $p -ge 0 -and $p -le 65535) { $Settings.port = $p } }
    if ($names -contains 'browser' -and @('auto', 'edge', 'chrome', 'default') -contains [string]$j.browser) { $Settings.browser = ([string]$j.browser).ToLowerInvariant() }
    if ($names -contains 'appWindow' -and $null -ne $j.appWindow) { $Settings.appWindow = [bool]$j.appWindow }
    foreach ($k in $script:SemSocialKeys) {
        if ($names -contains $k -and $j.$k -is [bool]) { $Settings[$k] = [bool]$j.$k }
    }
    if ($names -contains 'view' -and @('builder', 'ask') -contains [string]$j.view) { $Settings.view = ([string]$j.view).ToLowerInvariant() }
    # Skin name (docs/SKINS.md): a built-in one (fleet, classic) or one defined in config\skin.css.
    if ($names -contains 'skin' -and $null -ne $j.skin -and ([string]$j.skin) -cmatch '\A([a-z0-9-]{1,32})?\z') { $Settings.skin = [string]$j.skin }
    if ($names -contains 'playbookReviewer' -and $null -ne $j.playbookReviewer) { $Settings.playbookReviewer = ([string]$j.playbookReviewer).Trim() -replace '[^\w .@-]', '' }
    if ($names -contains 'fairleadPath' -and $null -ne $j.fairleadPath) { $Settings.fairleadPath = ([string]$j.fairleadPath).Trim() }
    foreach ($k in @('s3', 'aws', 'voice')) { if ($names -contains $k -and $j.$k -is [Management.Automation.PSCustomObject]) { $Settings[$k] = $j.$k } }
    foreach ($k in @('heartbeatTimeoutSec', 'leavingGraceSec', 'firstHeartbeatSec', 'queryWorkers', 'refreshTimeoutMin')) {
        if ($names -contains $k -and $null -ne $j.$k) {
            $n = 0
            if ([int]::TryParse([string]$j.$k, [ref]$n) -and $n -ge 1 -and $n -le 3600) { $Settings[$k] = $n }
        }
    }
    if ($Settings.queryWorkers -gt 16) { $Settings.queryWorkers = 16 }
    if ($names -contains 'localShares' -and $null -ne $j.localShares) {
        $Settings.localShares = @(@($j.localShares) | ForEach-Object { ([string]$_).Trim().TrimStart('\') } | Where-Object { $_ -cmatch '\A[A-Za-z0-9][A-Za-z0-9._-]{0,252}\z' })
    }
    if ($names -contains 'localImportMaxGB' -and $null -ne $j.localImportMaxGB) {
        $n = 0
        if ([int]::TryParse([string]$j.localImportMaxGB, [ref]$n) -and $n -ge 1 -and $n -le 4096) { $Settings.localImportMaxGB = $n }
    }
    return $true
}

function Read-SemSettings {
    param([string]$Root = (Get-SemRoot))
    $s = Get-SemDefaultSettings
    [void](Merge-SemSettingsFile -Settings $s -Path ([IO.Path]::Combine($Root, 'config', 'settings.json')))
    [void](Merge-SemSettingsFile -Settings $s -Path ([IO.Path]::Combine($Root, 'config', 'settings.local.json')))
    return $s
}

# ---------------------------------------------------------------------------
# TalkForge (spoken answers and voice input), as in Lazarette (lib/core/Config.ps1, PR 141/142):
# settings "voice": { "autoStart": true, "folder": "", "input": true }.
#   autoStart  start TalkForge when speech is needed and it is not running (Intelligence.ps1)
#   folder     the TalkForge folder; SEMAPHORE_VOICE_FOLDER (environment or config\semaphore.env) wins;
#              empty finds a TalkForge folder next to the Semaphore folder or in %USERPROFILE%\Projects
#   input      the deployment switch for voice input: false blocks the microphone for the page
#              (Permissions-Policy microphone=()), the /stt/ files and GET /api/voice/dictation/status
# ---------------------------------------------------------------------------
function Test-SemTalkForgeFolderText {
    # '' when a configured TalkForge folder is a full local path, else the reason.
    param([string]$Path)
    if ($Path -notmatch '\A[A-Za-z]:\\' -or $Path -match '[\r\n"<>|?*]' -or $Path -match '(\A|\\)\.\.(\\|\z)') { return 'The TalkForge folder must be a full path such as C:\Users\you\Projects\TalkForge.' }
    return ''
}

function Find-SemTalkForge {
    # The TalkForge folder: the configured one (no fallback when it is set), else a TalkForge folder next
    # to the Semaphore folder or in %USERPROFILE%\Projects. A folder counts when it has tools\talkforge.mjs.
    param([string]$Configured = '', [string]$SemaphoreRoot = (Get-SemRoot))
    $candidates = @()
    if ($Configured) {
        if (Test-SemTalkForgeFolderText $Configured) { return '' }
        $candidates = @($Configured.TrimEnd('\'))
    } else {
        if ($SemaphoreRoot) { $candidates += (Join-Path (Split-Path -Parent $SemaphoreRoot) 'TalkForge') }
        if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE 'Projects\TalkForge') }
    }
    foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath (Join-Path $c 'tools\talkforge.mjs') -PathType Leaf)) { return $c } }
    return ''
}

function Get-SemTalkForgeSettings {
    # AutoStart, Input, FolderSetting (as configured), FolderSource (environment | settings | ''), Folder (found, or '').
    param([string]$Root = (Get-SemRoot), $Settings = $null)
    if (-not $Root) { $Root = Get-SemRoot }
    if ($null -eq $Settings) { try { $Settings = Read-SemSettings -Root $Root } catch { $Settings = Get-SemDefaultSettings } }
    $autoStart = $true; $voiceInput = $true; $folder = ''
    $v = $Settings.voice
    if ($v -is [Management.Automation.PSCustomObject]) {
        $p = $v.PSObject.Properties
        if ($null -ne $p['autoStart'] -and $p['autoStart'].Value -is [bool]) { $autoStart = [bool]$p['autoStart'].Value }
        if ($null -ne $p['input'] -and $p['input'].Value -is [bool]) { $voiceInput = [bool]$p['input'].Value }
        if ($null -ne $p['folder'] -and $null -ne $p['folder'].Value) { $folder = ([string]$p['folder'].Value).Trim() }
    }
    $source = ''
    $fromEnv = Get-SemEnvValue -Name 'SEMAPHORE_VOICE_FOLDER' -Root $Root
    if ($fromEnv) { $folder = ([string]$fromEnv).Trim(); $source = 'environment' }
    elseif ($folder) { $source = 'settings' }
    $problem = ''
    if ($folder) { $problem = Test-SemTalkForgeFolderText $folder }
    return @{ AutoStart = $autoStart; Input = $voiceInput; FolderSetting = $folder; FolderSource = $source; FolderProblem = $problem; Folder = (Find-SemTalkForge -Configured $folder -SemaphoreRoot $Root) }
}

# ---------------------------------------------------------------------------
# Environment file (config\semaphore.env, KEY=VALUE lines, # comments) and the off switch
# ---------------------------------------------------------------------------
function Get-SemEnvValue {
    param([string]$Name, [string]$Root = (Get-SemRoot))
    $v = [Environment]::GetEnvironmentVariable($Name)
    if ($null -ne $v -and $v -ne '') { return $v }
    $f = [IO.Path]::Combine($Root, 'config', 'semaphore.env')
    if (Test-Path -LiteralPath $f) {
        try {
            foreach ($line in [IO.File]::ReadAllLines($f)) {
                $t = $line.Trim()
                if ($t -eq '' -or $t.StartsWith('#')) { continue }
                $eq = $t.IndexOf('=')
                if ($eq -gt 0 -and $t.Substring(0, $eq).Trim() -eq $Name) { return $t.Substring($eq + 1).Trim().Trim('"') }
            }
        } catch { }
    }
    return $null
}

function Test-SemAutoStopEnabled {
    param([string]$Root = (Get-SemRoot))
    return ((Get-SemEnvValue -Name 'SEMAPHORE_AUTO_STOP' -Root $Root) -ne '0')
}

# ---------------------------------------------------------------------------
# Home folder: $env:SEMAPHORE_HOME, else settings.home, else %USERPROFILE%\Semaphore
# ---------------------------------------------------------------------------
function Resolve-SemHome {
    param([hashtable]$Settings, [switch]$Create)
    $h = $env:SEMAPHORE_HOME
    if (-not $h -and $Settings -and $Settings.home) { $h = [Environment]::ExpandEnvironmentVariables([string]$Settings.home) }
    if (-not $h) {
        $profileDir = $env:USERPROFILE
        if (-not $profileDir) { $profileDir = $env:HOME }
        $h = Join-Path $profileDir 'Semaphore'
    }
    $h = [IO.Path]::GetFullPath($h)
    if ($Create) {
        foreach ($d in @($h, (Join-Path $h 'hoists'), (Join-Path $h 'catalogs'), (Join-Path $h 'playbook'), (Join-Path $h 'snapshots'), (Join-Path $h 'questions'))) {
            if (-not (Test-Path -LiteralPath $d)) { [void][IO.Directory]::CreateDirectory($d) }
        }
    }
    return $h
}

# ---------------------------------------------------------------------------
# Loopback HTTP client (launcher and stop script only; never leaves 127.0.0.1)
# ---------------------------------------------------------------------------
function Invoke-SemLocalRequest {
    param([int]$Port, [string]$Path, [string]$Method = 'GET', [hashtable]$Headers = @{}, [int]$TimeoutMs = 2000)
    try {
        $req = [Net.HttpWebRequest]::Create(('http://127.0.0.1:{0}{1}' -f $Port, $Path))
        $req.Method = $Method
        $req.Proxy = $null                       # never send loopback traffic through a proxy
        $req.Timeout = $TimeoutMs; $req.ReadWriteTimeout = $TimeoutMs
        $req.AllowAutoRedirect = $false
        foreach ($k in $Headers.Keys) { $req.Headers[$k] = [string]$Headers[$k] }
        if ($Method -ne 'GET') { $req.ContentLength = 0 }
        $resp = $req.GetResponse()
        try {
            $sr = New-Object IO.StreamReader($resp.GetResponseStream())
            return [pscustomobject]@{ Status = [int]$resp.StatusCode; Body = $sr.ReadToEnd() }
        } finally { $resp.Close() }
    } catch [Net.WebException] {
        $r = $_.Exception.Response
        if ($r) { $code = [int]$r.StatusCode; $r.Close(); return [pscustomobject]@{ Status = $code; Body = '' } }
        return $null
    } catch { return $null }
}

function Get-SemInstanceId {
    # GET /__fleethacker/id on a port: $null, or @{ Tool; Version; Pid; Tabs }.
    param([int]$Port, [int]$TimeoutMs = 2000)
    $r = Invoke-SemLocalRequest -Port $Port -Path '/__fleethacker/id' -TimeoutMs $TimeoutMs
    if (-not $r -or $r.Status -ne 200 -or -not $r.Body) { return $null }
    try { $j = $r.Body | ConvertFrom-Json } catch { return $null }
    if ($null -eq $j -or [string]$j.tool -ne 'semaphore') { return $null }
    $tabs = -1; if ($j.PSObject.Properties['tabs']) { $tabs = [int]$j.tabs }
    return [pscustomobject]@{ Tool = [string]$j.tool; Version = [string]$j.version; Pid = [int]$j.pid; Tabs = $tabs; Port = $Port }
}

function Request-SemOpenBrowser {
    # Asks a running Semaphore to open a browser on its own session link (the token never leaves it).
    param([int]$Port)
    $r = Invoke-SemLocalRequest -Port $Port -Path '/__semaphore/open' -Method 'POST' -Headers @{ 'X-Semaphore-Open' = '1' }
    return ($null -ne $r -and $r.Status -eq 202)
}

function Compare-SemVersion {
    # 1 if A is newer than B, -1 if older, 0 if equal, $null if either does not parse.
    param([string]$A, [string]$B)
    $va = $null; $vb = $null
    if ($A -match '^\s*v?(\d+(\.\d+){1,3})') { [void][Version]::TryParse($Matches[1], [ref]$va) }
    if ($B -match '^\s*v?(\d+(\.\d+){1,3})') { [void][Version]::TryParse($Matches[1], [ref]$vb) }
    if ($null -eq $va -or $null -eq $vb) { return $null }
    return $va.CompareTo($vb)
}

# ---------------------------------------------------------------------------
# Running instances
# ---------------------------------------------------------------------------
function Get-SemRuntimeDir {
    param([string]$Root = (Get-SemRoot))
    return (Join-Path $Root 'logs')
}

function Test-SemServerProcess {
    # The pid is alive, is a PowerShell, and did not start after its runtime file was written (pid reuse).
    param([int]$Id, [string]$StartedAt = '')
    if ($Id -le 0 -or $Id -eq $PID) { return $false }
    $p = Get-Process -Id $Id -ErrorAction SilentlyContinue
    if ($null -eq $p) { return $false }
    if ($p.ProcessName -notmatch '^(powershell|pwsh)$') { return $false }
    if ($StartedAt) {
        try {
            $written = [datetime]::Parse($StartedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
            if ($p.StartTime.ToUniversalTime() -gt $written.AddSeconds(5)) { return $false }
        } catch { }   # StartTime can be denied; the name check still applies
    }
    return $true
}

function Get-SemInstances {
    <#
      Running Semaphore servers of this install: from logs\semaphore-server-<pid>.json (stale files,
      whose process is gone, are deleted), plus on Windows any PowerShell whose command line runs this
      install's Start-Semaphore.ps1 (one still starting, or killed before it wrote its file).
      The current process is never listed. -CheckOnly runs are skipped.
    #>
    param([string]$Root = (Get-SemRoot))
    $found = @{}
    $dir = Get-SemRuntimeDir -Root $Root
    if (Test-Path -LiteralPath $dir) {
        foreach ($f in @(Get-ChildItem -LiteralPath $dir -Filter 'semaphore-server-*.json' -ErrorAction SilentlyContinue)) {
            $info = $null
            try { $info = [IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json } catch { $info = $null }
            $id = 0
            if ($null -ne $info) { try { $id = [int]$info.pid } catch { $id = 0 } }
            if ($id -eq $PID) { continue }
            if ($id -gt 0 -and (Test-SemServerProcess -Id $id -StartedAt ([string]$info.startedAt))) {
                $found[$id] = [pscustomobject]@{ Pid = $id; Port = [int]$info.port; Url = [string]$info.url; StartedAt = [string]$info.startedAt; Version = [string]$info.version; File = $f.FullName }
            } else {
                Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
            }
        }
    }
    if (Test-SemIsWindows) {
        $startRx = [regex]::Escape((Join-Path $Root 'server\Start-Semaphore.ps1'))
        $procs = @()
        try { $procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop) } catch { $procs = @() }
        foreach ($p in $procs) {
            $id = [int]$p.ProcessId
            if ($id -eq $PID -or $found.ContainsKey($id)) { continue }
            $cl = [string]$p.CommandLine
            if ($cl -match ('(?i)' + $startRx) -and $cl -notmatch '(?i)(-CheckOnly|--check-only)') {
                $found[$id] = [pscustomobject]@{ Pid = $id; Port = 0; Url = ''; StartedAt = ''; Version = ''; File = '' }
            }
        }
    }
    foreach ($k in @($found.Keys | Sort-Object)) { $found[$k] }
}

function Format-SemInstance {
    param($Instance)
    if ($Instance.Url) { return ('{0} (PID {1})' -f $Instance.Url, $Instance.Pid) }
    return ('PID {0}' -f $Instance.Pid)
}

function Stop-SemInstance {
    <#
      Stops one running server: POST /__fleethacker/shutdown first (the server finishes the request it
      is serving and removes its runtime file), then, if the process is still there after the grace
      period, Stop-Process on the pid (re-verified as a PowerShell that runs Semaphore). Returns $true
      when the process is gone.
    #>
    param([Parameter(Mandatory = $true)]$Instance, [int]$GraceMs = 8000)
    $id = [int]$Instance.Pid
    if ($Instance.Port -gt 0) {
        [void](Invoke-SemLocalRequest -Port $Instance.Port -Path '/__fleethacker/shutdown' -Method 'POST' -Headers @{ 'X-FleetHacker-Shutdown' = '1' })
    }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $GraceMs) {
        if (-not (Get-Process -Id $id -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 150
    }
    if (Get-Process -Id $id -ErrorAction SilentlyContinue) {
        if (-not (Test-SemServerProcess -Id $id -StartedAt ([string]$Instance.StartedAt))) {
            Write-Warning ('Not stopping ' + (Format-SemInstance $Instance) + ': it is no longer a Semaphore server.')
            return $false
        }
        try {
            Stop-Process -Id $id -Force -ErrorAction Stop
            try { Wait-Process -Id $id -Timeout 5 -ErrorAction SilentlyContinue } catch { }
        } catch {
            Write-Warning ('Could not stop ' + (Format-SemInstance $Instance) + ': ' + $_.Exception.Message)
            return $false
        }
    }
    if ($Instance.File) { Remove-Item -LiteralPath $Instance.File -Force -ErrorAction SilentlyContinue }
    return $true
}

function Stop-SemInstances {
    # Stops every running Semaphore server of this install and returns those it stopped.
    param([string]$Root = (Get-SemRoot))
    $stopped = New-Object System.Collections.Generic.List[object]
    foreach ($i in @(Get-SemInstances -Root $Root)) {
        if (Stop-SemInstance -Instance $i) { $stopped.Add($i) }
    }
    return $stopped.ToArray()
}
