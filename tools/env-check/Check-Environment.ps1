#requires -Version 5.1
<#
.SYNOPSIS
  Environment check for a locked-down Windows workstation (NMCI, Nautilus, ...). Tests the exact things the
  Fleet local web apps depend on and writes a log you can compare between machines.
.DESCRIPTION
  Windows PowerShell 5.1 only. No admin rights, no installs, no downloads, nothing leaves the machine.
  It writes only to its own logs folder (or %TEMP% if that is read-only) and to a temporary work folder it deletes.
  The log is written line by line, so a partial log survives even if the check is interrupted.

  What it tests, by the failure it explains:
    ZIP-EXTRACT   a downloaded zip that "has nothing in it": .NET ZipFile, Expand-Archive, Explorer's Shell
                  extraction, tar.exe, and a "tar file named .zip" detector (also run on Semaphore*.zip in Downloads).
    LAUNCH        .bat / .ps1 execution, execution policy, language mode, Add-Type (C# compile), WinForms tray,
                  Credential Manager, DPAPI, AppLocker / code-integrity policy hints.
    NOT-BUILT     the "browser interface has not been built" page: web\dist present and served by a real
                  Semaphore start (only when this folder sits inside a Semaphore install).
    PORTS         TcpListener on 127.0.0.1 ports 8800-8802, raw and proxy-aware HTTP to loopback.
    BLANK-PAGE    a page served from loopback, opened in Edge/Chrome, that tries what the Semaphore UI needs:
                  ES features, modules, Web Worker, WebAssembly, IndexedDB, Web Crypto, canvas, modern CSS.
.PARAMETER NoBrowser
  Do not open a browser; the browser tests are skipped.
.PARAMETER NoLaunch
  Serve the browser test page but do not open a browser; open the printed address yourself.
.PARAMETER NoSemaphoreRun
  Do not start a real Semaphore copy (it is started on a spare loopback port and stopped again).
.PARAMETER ZipPath
  Also validate these zip files, comma separated (is each a real zip, or a tar file named .zip?).
.PARAMETER OutDir
  Where the logs folder goes. Default: next to this script.
.PARAMETER BrowserWaitSec
  How long to wait for the browser page to report back. Default 120.
.PARAMETER Compare
  Two log files: print only the lines that differ (for example NMCI against Nautilus). Runs no tests.
.EXAMPLE
  .\Check-Environment.bat
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\Check-Environment.ps1 -Compare nmci.log nautilus.log
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [switch]$NoBrowser,
    [switch]$NoLaunch,
    [switch]$NoSemaphoreRun,
    [string[]]$ZipPath,
    [string]$OutDir,
    [int]$BrowserWaitSec = 120,
    [string[]]$Compare,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)
$cmpFiles = @(@($Compare) + @($Rest) | Where-Object { $_ })
$ZipPath = @($ZipPath | ForEach-Object { $_ -split ',' } | Where-Object { $_ })   # -File passes "a,b" as one string
$ErrorActionPreference = 'Continue'
$script:ToolVersion = '1.0'
$BS = [string][char]92

# ---------------------------------------------------------------- compare mode
if ($Compare -and $cmpFiles.Count -ge 2) {
    $Compare = $cmpFiles
    function Read-Log([string]$p) {
        $h = @{}
        foreach ($l in [IO.File]::ReadAllLines($p)) {
            if ($l -match '^\[(PASS|FAIL|WARN|INFO|ERROR)\] (\S+) \| (.*)$') {
                if ($Matches[2] -like 'run.*') { continue }
                $h[$Matches[2]] = $Matches[1] + ' ' + $Matches[3]
            }
        }
        return $h
    }
    $a = Read-Log $Compare[0]; $b = Read-Log $Compare[1]
    $keys = @($a.Keys) + @($b.Keys) | Sort-Object -Unique
    $diff = 0
    Write-Host ('A = ' + $Compare[0]); Write-Host ('B = ' + $Compare[1]); Write-Host ''
    foreach ($k in $keys) {
        $va = if ($a.ContainsKey($k)) { $a[$k] } else { '(missing)' }
        $vb = if ($b.ContainsKey($k)) { $b[$k] } else { '(missing)' }
        if ($va -ne $vb) { $diff++; Write-Host $k -ForegroundColor Yellow; Write-Host ('   A: ' + $va); Write-Host ('   B: ' + $vb) }
    }
    Write-Host ''
    Write-Host ("{0} differences, {1} identical." -f $diff, ($keys.Count - $diff))
    return
}

# ---------------------------------------------------------------- logging
$script:UserName = $env:USERNAME
$script:Results = New-Object System.Collections.ArrayList
$script:LogPath = $null

function Initialize-Log {
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $name = 'env-check-' + $env:COMPUTERNAME + '-' + $stamp + '.log'
    $dirs = New-Object System.Collections.ArrayList
    $base = if ($OutDir) { $OutDir } else { $PSScriptRoot }
    [void]$dirs.Add((Join-Path $base 'logs'))
    [void]$dirs.Add((Join-Path $env:TEMP 'FleetEnvCheck'))
    foreach ($d in $dirs) {
        try {
            if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
            $p = Join-Path $d $name
            [IO.File]::WriteAllText($p, '', [Text.Encoding]::ASCII)
            $script:LogPath = $p
            return
        } catch { }
    }
}
function Clean([string]$s) {
    if ($null -eq $s) { return '' }
    $s = $s -replace '[\r\n\t]+', ' '
    $s = $s -replace '[^\x20-\x7e]', '?'
    if ($script:UserName -and $script:UserName.Length -gt 1) { $s = $s.Replace($script:UserName, '<user>') }
    return $s.Trim()
}
function Write-LogLine([string]$line) {
    if (-not $script:LogPath) { return }
    try { [IO.File]::AppendAllText($script:LogPath, $line + [Environment]::NewLine, [Text.Encoding]::ASCII) } catch { }
}
function Add-R([string]$Key, [string]$Status, $Value) {
    $v = Clean ([string]$Value)
    [void]$script:Results.Add([pscustomobject]@{ Key = $Key; Status = $Status; Value = $v })
    $line = '[' + $Status + '] ' + $Key + ' | ' + $v
    Write-LogLine $line
    $color = switch ($Status) { 'PASS' { 'Green' } 'FAIL' { 'Red' } 'ERROR' { 'Red' } 'WARN' { 'Yellow' } default { 'Gray' } }
    Write-Host $line -ForegroundColor $color
}
function Step([string]$Name, [scriptblock]$Body) {
    Write-LogLine ''
    Write-LogLine ('=== ' + $Name)
    Write-Host ''
    Write-Host ('=== ' + $Name) -ForegroundColor Cyan
    try { & $Body } catch { Add-R ($Name + '.exception') 'ERROR' $_.Exception.Message }
}
function Get-Sha256Hex([byte[]]$bytes) {
    $h = [Security.Cryptography.SHA256]::Create()
    try { return (($h.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $h.Dispose() }
}
function Get-RegValue([string]$Path, [string]$Name) {
    try { return (Get-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction Stop).$Name } catch { return $null }
}

# Classifies an archive file: real zip, tar named .zip, or something else.
function Get-ArchiveKind([string]$Path) {
    $fs = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
    try {
        $len = $fs.Length
        if ($len -eq 0) { return 'empty file (0 bytes)' }
        $head = New-Object byte[] ([int][Math]::Min(512, $len))
        [void]$fs.Read($head, 0, $head.Length)
        $isPk = ($head.Length -ge 4 -and $head[0] -eq 0x50 -and $head[1] -eq 0x4B)
        $tarMagic = ''
        if ($head.Length -ge 262) { $tarMagic = [Text.Encoding]::ASCII.GetString($head, 257, 5) }
        $tailLen = [int][Math]::Min(65557, $len)
        $tail = New-Object byte[] $tailLen
        [void]$fs.Seek($len - $tailLen, 'Begin')
        [void]$fs.Read($tail, 0, $tailLen)
        $eocd = $false
        for ($i = $tailLen - 22; $i -ge 0; $i--) {
            if ($tail[$i] -eq 0x50 -and $tail[$i + 1] -eq 0x4B -and $tail[$i + 2] -eq 5 -and $tail[$i + 3] -eq 6) { $eocd = $true; break }
        }
        if ($isPk -and $eocd) { return 'real zip' }
        if ($tarMagic -eq 'ustar') { return 'TAR archive named .zip (Windows cannot open it)' }
        if ($isPk -and -not $eocd) { return 'zip signature but truncated / no end-of-archive record (incomplete download?)' }
        return 'not a zip (first bytes ' + (($head[0..3] | ForEach-Object { $_.ToString('x2') }) -join ' ') + ')'
    } finally { $fs.Dispose() }
}

Initialize-Log
Write-LogLine ('Fleet environment check ' + $script:ToolVersion)
Write-LogLine ('Format: [STATUS] key | value. STATUS is PASS, FAIL, WARN, INFO or ERROR. Keys starting run. are ignored by -Compare.')
Write-Host ('Fleet environment check ' + $script:ToolVersion + ' - log: ' + $script:LogPath) -ForegroundColor Cyan
if (-not $script:LogPath) { Write-Host 'WARNING: no writable log location; results are shown on screen only.' -ForegroundColor Yellow }

$work = Join-Path $env:TEMP ('FleetEnvCheck-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
try { New-Item -ItemType Directory -Path $work -Force | Out-Null } catch { }
Add-R 'run.started' 'INFO' ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
Add-R 'run.script' 'INFO' $PSCommandPath
Add-R 'run.workdir' 'INFO' $work

# Semaphore install this tool sits inside (tools\env-check -> root), if any.
$semRoot = $null
foreach ($cand in @((Split-Path -Parent (Split-Path -Parent $PSScriptRoot)), (Split-Path -Parent $PSScriptRoot), $PSScriptRoot)) {
    if ($cand -and (Test-Path -LiteralPath (Join-Path $cand 'Launch-Semaphore.bat'))) { $semRoot = $cand; break }
}

# ---------------------------------------------------------------- 1 machine
Step 'machine' {
    try {
        $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
        Add-R 'machine.os' 'INFO' ($os.Caption + ' ' + $os.Version + ' build ' + $os.BuildNumber + ' ' + $os.OSArchitecture)
    } catch { Add-R 'machine.os' 'INFO' ([Environment]::OSVersion.VersionString + ' (CIM blocked: ' + $_.Exception.Message + ')') }
    Add-R 'machine.name' 'INFO' $env:COMPUTERNAME
    try {
        $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
        Add-R 'machine.domain' 'INFO' ('PartOfDomain=' + $cs.PartOfDomain + ' Domain=' + $cs.Domain + ' Model=' + $cs.Model)
    } catch { Add-R 'machine.domain' 'INFO' ('USERDOMAIN=' + $env:USERDOMAIN) }
    Add-R 'machine.ram' 'INFO' ('{0} logical processors' -f [Environment]::ProcessorCount)
    Add-R 'machine.user-is-admin' 'INFO' ([bool](New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
    Add-R 'machine.profile-path' 'INFO' ($env:USERPROFILE)
    if ($env:USERPROFILE.StartsWith('\\')) { Add-R 'machine.profile-redirected' 'WARN' 'profile is on a network share' } else { Add-R 'machine.profile-redirected' 'PASS' 'local profile' }
    Add-R 'machine.temp' 'INFO' $env:TEMP
    $cn = Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' 'LongPathsEnabled'
    Add-R 'machine.long-paths' 'INFO' ('LongPathsEnabled=' + $cn)
}

# ---------------------------------------------------------------- 2 powershell
Step 'powershell' {
    $v = $PSVersionTable.PSVersion.ToString()
    Add-R 'ps.version' $(if ($PSVersionTable.PSVersion.Major -eq 5) { 'PASS' } else { 'WARN' }) ($v + ' ' + $PSVersionTable.PSEdition + ' CLR ' + $PSVersionTable.CLRVersion)
    $rel = Get-RegValue 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' 'Release'
    Add-R 'ps.dotnet-release' 'INFO' ('.NET Framework release key ' + $rel + ' (528040+ is 4.8)')
    $lm = [string]$ExecutionContext.SessionState.LanguageMode
    Add-R 'ps.language-mode' $(if ($lm -eq 'FullLanguage') { 'PASS' } else { 'FAIL' }) ($lm + ' (ConstrainedLanguage blocks Add-Type and most Fleet scripts)')
    try {
        foreach ($e in (Get-ExecutionPolicy -List -ErrorAction Stop)) { Add-R ('ps.exec-policy.' + $e.Scope) 'INFO' $e.ExecutionPolicy }
    } catch {
        Add-R 'ps.exec-policy.cmdlet' 'WARN' ('Get-ExecutionPolicy unavailable (' + $_.Exception.Message + '); reading the registry instead')
        Add-R 'ps.exec-policy.MachinePolicy' 'INFO' (Get-RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\PowerShell' 'ExecutionPolicy')
        Add-R 'ps.exec-policy.UserPolicy' 'INFO' (Get-RegValue 'HKCU:\SOFTWARE\Policies\Microsoft\Windows\PowerShell' 'ExecutionPolicy')
        Add-R 'ps.exec-policy.CurrentUser' 'INFO' (Get-RegValue 'HKCU:\SOFTWARE\Microsoft\PowerShell\1\ShellIds\Microsoft.PowerShell' 'ExecutionPolicy')
        Add-R 'ps.exec-policy.LocalMachine' 'INFO' (Get-RegValue 'HKLM:\SOFTWARE\Microsoft\PowerShell\1\ShellIds\Microsoft.PowerShell' 'ExecutionPolicy')
    }
    Add-R 'ps.process-64bit' 'INFO' ([Environment]::Is64BitProcess)
    Add-R 'ps.apartment' 'INFO' ([Threading.Thread]::CurrentThread.ApartmentState)
    foreach ($pol in @(
            @('ps.policy.script-block-logging', 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\PowerShell\ScriptBlockLogging', 'EnableScriptBlockLogging'),
            @('ps.policy.transcription', 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\PowerShell\Transcription', 'EnableTranscripting'),
            @('ps.policy.module-logging', 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\PowerShell\ModuleLogging', 'EnableModuleLogging'))) {
        Add-R $pol[0] 'INFO' ('value=' + (Get-RegValue $pol[1] $pol[2]))
    }
}

# ---------------------------------------------------------------- 3 policy
Step 'policy' {
    $srp = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\SrpV2'
    if (Test-Path -LiteralPath $srp) {
        foreach ($k in (Get-ChildItem -LiteralPath $srp -ErrorAction SilentlyContinue)) {
            Add-R ('policy.applocker.' + $k.PSChildName) 'INFO' ('EnforcementMode=' + (Get-RegValue $k.PSPath 'EnforcementMode') + ' (1 = enforced, 0 = audit)')
        }
    } else { Add-R 'policy.applocker' 'INFO' 'no AppLocker policy keys' }
    try {
        $dg = Get-CimInstance -Namespace 'root\Microsoft\Windows\DeviceGuard' -ClassName Win32_DeviceGuard -ErrorAction Stop
        Add-R 'policy.wdac' 'INFO' ('CodeIntegrity=' + $dg.CodeIntegrityPolicyEnforcementStatus + ' UserMode=' + $dg.UsermodeCodeIntegrityPolicyEnforcementStatus + ' (1 enforced, 2 audit, 0 off)')
    } catch { Add-R 'policy.wdac' 'INFO' ('not readable: ' + $_.Exception.Message) }
    $is = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    Add-R 'policy.proxy' 'INFO' ('ProxyEnable=' + (Get-RegValue $is 'ProxyEnable') + ' ProxyServerSet=' + ([bool](Get-RegValue $is 'ProxyServer')) + ' PacUrlSet=' + ([bool](Get-RegValue $is 'AutoConfigURL')))
    Add-R 'policy.proxy-env' 'INFO' ('HTTP_PROXY set=' + [bool]$env:HTTP_PROXY + ' HTTPS_PROXY set=' + [bool]$env:HTTPS_PROXY + ' NO_PROXY=' + $env:NO_PROXY)
    foreach ($b in @('Edge', 'Chrome')) {
        $p = if ($b -eq 'Edge') { 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' } else { 'HKLM:\SOFTWARE\Policies\Google\Chrome' }
        if (Test-Path -LiteralPath $p) {
            $names = @((Get-Item -LiteralPath $p).Property | Where-Object { $_ -match 'URLBlocklist|URLAllowlist|Download|Javascript|IndexedDB|Local|Storage|ClearBrowsingData|Incognito|Cookies|WebAssembly|Worker|Sandbox' })
            Add-R ('policy.' + $b.ToLower()) 'INFO' ('policy key present; relevant values: ' + ($names -join ', '))
        } else { Add-R ('policy.' + $b.ToLower()) 'INFO' 'no policy key' }
    }
}

# ---------------------------------------------------------------- 4 launch
Step 'launch (LAUNCH)' {
    $where = @(@('script-folder', $PSScriptRoot), @('temp', $work))
    foreach ($w in $where) {
        $d = $w[1]; $n = $w[0]
        try {
            $f = Join-Path $d ('probe-' + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.txt')
            [IO.File]::WriteAllText($f, 'x'); $r = [IO.File]::ReadAllText($f); Remove-Item -LiteralPath $f -Force
            Add-R ('launch.write.' + $n) 'PASS' 'write, read and delete work'
        } catch { Add-R ('launch.write.' + $n) $(if ($n -eq 'temp') { 'FAIL' } else { 'WARN' }) $_.Exception.Message }
    }
    try {
        $dt = (New-Object IO.DriveInfo([IO.Path]::GetPathRoot($PSScriptRoot))).DriveType
        Add-R 'launch.script-drive' 'INFO' ($PSScriptRoot + ' on ' + $dt)
    } catch { }
    try {
        $z = Get-Content -LiteralPath $PSCommandPath -Stream Zone.Identifier -ErrorAction Stop
        Add-R 'launch.mark-of-the-web' 'WARN' ('this script is marked as downloaded: ' + (($z | Where-Object { $_ -match 'ZoneId' }) -join ' '))
    } catch { Add-R 'launch.mark-of-the-web' 'PASS' 'this script has no downloaded-from-internet mark' }

    $bat = Join-Path $work 'probe.bat'
    [IO.File]::WriteAllText($bat, "@echo off`r`necho FLEET-BAT-OK`r`n", [Text.Encoding]::ASCII)
    $o = (& cmd.exe /c $bat 2>&1) -join ' '
    Add-R 'launch.bat-runs' $(if ($o -match 'FLEET-BAT-OK') { 'PASS' } else { 'FAIL' }) $o

    $ps1 = Join-Path $work 'probe.ps1'
    [IO.File]::WriteAllText($ps1, "Write-Output 'FLEET-PS1-OK'`r`n", [Text.Encoding]::ASCII)
    $o = (& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $ps1 2>&1) -join ' '
    Add-R 'launch.ps1-bypass' $(if ($o -match 'FLEET-PS1-OK') { 'PASS' } else { 'FAIL' }) $o
    $o = (& powershell.exe -NoLogo -NoProfile -File $ps1 2>&1) -join ' '
    Add-R 'launch.ps1-default-policy' $(if ($o -match 'FLEET-PS1-OK') { 'PASS' } else { 'WARN' }) ($o + ' (the .bat launchers pass -ExecutionPolicy Bypass; a machine-wide policy overrides it)')

    $cls = 'FleetEnvProbe' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    try {
        Add-Type -TypeDefinition ('public static class ' + $cls + ' { public static int One() { return 1; } }') -ErrorAction Stop
        Add-R 'launch.add-type-csharp' 'PASS' 'C# compiled in memory (used by the tray icon and native helpers)'
    } catch { Add-R 'launch.add-type-csharp' 'FAIL' $_.Exception.Message }
    try {
        Add-Type -AssemblyName System.Windows.Forms, System.Drawing -ErrorAction Stop
        $ni = New-Object System.Windows.Forms.NotifyIcon
        $ni.Icon = [System.Drawing.SystemIcons]::Application; $ni.Text = 'Fleet env check'; $ni.Visible = $true
        Start-Sleep -Milliseconds 300; $ni.Visible = $false; $ni.Dispose()
        Add-R 'launch.tray-notifyicon' 'PASS' 'WinForms NotifyIcon created and removed'
    } catch { Add-R 'launch.tray-notifyicon' 'FAIL' $_.Exception.Message }
    try {
        [void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
        $pv = New-Object Windows.Security.Credentials.PasswordVault
        try { [void]$pv.FindAllByResource('Fleet/EnvCheck/DoesNotExist'); Add-R 'launch.credential-manager' 'PASS' 'PasswordVault answered' }
        catch { if ($_.Exception.Message -match 'Element not found|0x80070490') { Add-R 'launch.credential-manager' 'PASS' 'PasswordVault answers (no such entry, as expected)' } else { Add-R 'launch.credential-manager' 'FAIL' $_.Exception.Message } }
    } catch { Add-R 'launch.credential-manager' 'FAIL' $_.Exception.Message }
    try {
        Add-Type -AssemblyName System.Security -ErrorAction Stop
        $plain = [Text.Encoding]::ASCII.GetBytes('fleet-dpapi')
        $enc = [Security.Cryptography.ProtectedData]::Protect($plain, $null, 'CurrentUser')
        $dec = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser')
        Add-R 'launch.dpapi' $(if ([Text.Encoding]::ASCII.GetString($dec) -eq 'fleet-dpapi') { 'PASS' } else { 'FAIL' }) 'DPAPI CurrentUser round trip'
    } catch { Add-R 'launch.dpapi' 'FAIL' $_.Exception.Message }
}

# ---------------------------------------------------------------- 5 zip
Step 'zip (ZIP-EXTRACT)' {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
    $src = Join-Path $work 'zsrc'
    New-Item -ItemType Directory -Path (Join-Path $src 'web\dist\assets') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $src 'Launch.bat'), "@echo off`r`n", [Text.Encoding]::ASCII)
    [IO.File]::WriteAllText((Join-Path $src 'web\dist\index.html'), '<html></html>', [Text.Encoding]::ASCII)
    $rnd = New-Object byte[] 300000; (New-Object Random 7).NextBytes($rnd)
    [IO.File]::WriteAllBytes((Join-Path $src 'web\dist\assets\app.js'), $rnd)

    $zip = Join-Path $work 'probe-dotnet.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($src, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
    Add-R 'zip.create-dotnet' 'PASS' ((Get-Item $zip).Length.ToString() + ' bytes')
    $kind = Get-ArchiveKind $zip
    Add-R 'zip.signature' $(if ($kind -eq 'real zip') { 'PASS' } else { 'FAIL' }) $kind

    try {
        $za = [IO.Compression.ZipFile]::OpenRead($zip); $n = $za.Entries.Count
        $bad = @($za.Entries | Where-Object { $_.FullName.Contains($BS) }).Count; $za.Dispose()
        Add-R 'zip.read-dotnet' 'PASS' ($n.ToString() + ' entries read')
        Add-R 'zip.entry-separator' 'INFO' ($bad.ToString() + ' of ' + $n + ' entries use backslash separators (normal for powershell.exe; Explorer and Expand-Archive read them)')
    } catch { Add-R 'zip.read-dotnet' 'FAIL' $_.Exception.Message }

    try {
        $d1 = Join-Path $work 'x-expand'
        Expand-Archive -LiteralPath $zip -DestinationPath $d1 -ErrorAction Stop
        $ok = Test-Path -LiteralPath (Join-Path $d1 'web\dist\index.html')
        Add-R 'zip.expand-archive' $(if ($ok) { 'PASS' } else { 'FAIL' }) $(if ($ok) { 'extracted, files present' } else { 'extracted but files missing' })
    } catch { Add-R 'zip.expand-archive' 'FAIL' $_.Exception.Message }

    try {
        $zip2 = Join-Path $work 'probe-compress-archive.zip'
        Compress-Archive -Path (Join-Path $src '*') -DestinationPath $zip2 -ErrorAction Stop
        $k2 = Get-ArchiveKind $zip2
        Add-R 'zip.compress-archive' $(if ($k2 -eq 'real zip') { 'PASS' } else { 'FAIL' }) $k2
    } catch { Add-R 'zip.compress-archive' 'FAIL' $_.Exception.Message }

    try {
        $sh = New-Object -ComObject Shell.Application
        $ns = $sh.NameSpace($zip)
        if ($null -eq $ns) { Add-R 'zip.explorer-shell' 'FAIL' 'Explorer (Shell.Application) cannot open the zip as a folder' }
        else {
            $cnt = $ns.Items().Count
            $d2 = Join-Path $work 'x-shell'; New-Item -ItemType Directory -Path $d2 -Force | Out-Null
            $dst = $sh.NameSpace($d2); $dst.CopyHere($ns.Items(), 20)
            $t = 0; while ($t -lt 100 -and -not (Test-Path -LiteralPath (Join-Path $d2 'web\dist\index.html'))) { Start-Sleep -Milliseconds 100; $t++ }
            $ok = Test-Path -LiteralPath (Join-Path $d2 'web\dist\index.html')
            Add-R 'zip.explorer-shell' $(if ($ok) { 'PASS' } else { 'FAIL' }) ('Explorer-style extract: ' + $cnt + ' top-level items, files present=' + $ok)
        }
    } catch { Add-R 'zip.explorer-shell' 'FAIL' $_.Exception.Message }

    $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($tar) {
        $o = (& tar.exe -tf $zip 2>&1 | Select-Object -First 3) -join ' '
        Add-R 'zip.tar-exe' $(if ($LASTEXITCODE -eq 0) { 'PASS' } else { 'WARN' }) ($tar.Source + ': ' + $o)
    } else { Add-R 'zip.tar-exe' 'INFO' 'tar.exe not present' }

    # The Base64 text fallback the Fleet packagers use when archives are blocked.
    $payload = New-Object byte[] 120000; (New-Object Random 11).NextBytes($payload)
    $ms = New-Object IO.MemoryStream
    $gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionMode]::Compress, $true); $gz.Write($payload, 0, $payload.Length); $gz.Dispose()
    $b64 = [Convert]::ToBase64String($ms.ToArray()); $ms.Dispose()
    $back = [Convert]::FromBase64String($b64)
    $in = New-Object IO.MemoryStream(, $back); $g2 = New-Object IO.Compression.GZipStream($in, [IO.Compression.CompressionMode]::Decompress)
    $out = New-Object IO.MemoryStream; $g2.CopyTo($out); $g2.Dispose()
    Add-R 'zip.base64-gzip-sha256' $(if ((Get-Sha256Hex $out.ToArray()) -eq (Get-Sha256Hex $payload)) { 'PASS' } else { 'FAIL' }) 'gzip + Base64 + SHA-256 round trip (fallback package format)'

    # Real downloaded files: the one given, and Semaphore zips in Downloads.
    $targets = New-Object System.Collections.ArrayList
    foreach ($zp in $ZipPath) { [void]$targets.Add($zp) }
    foreach ($dl in @((Join-Path $env:USERPROFILE 'Downloads'), (Join-Path $env:USERPROFILE 'Desktop'))) {
        if (Test-Path -LiteralPath $dl) { foreach ($f in (Get-ChildItem -LiteralPath $dl -Filter 'Semaphore*.zip' -ErrorAction SilentlyContinue)) { [void]$targets.Add($f.FullName) } }
    }
    if ($targets.Count -eq 0) { Add-R 'zip.downloaded-semaphore' 'INFO' 'no Semaphore*.zip found in Downloads or Desktop (use -ZipPath to check a file)' }
    foreach ($t in $targets) {
        $k = Get-ArchiveKind $t
        Add-R ('zip.downloaded.' + (Split-Path -Leaf $t)) $(if ($k -eq 'real zip') { 'PASS' } else { 'FAIL' }) ((Get-Item -LiteralPath $t).Length.ToString() + ' bytes: ' + $k)
    }
}

# ---------------------------------------------------------------- 6 semaphore install
$script:SemRunUrl = $null
Step 'semaphore install (NOT-BUILT)' {
    if (-not $semRoot) { Add-R 'sem.install' 'INFO' 'this tool is not inside a Semaphore folder; skipped'; return }
    Add-R 'sem.root' 'INFO' $semRoot
    $ver = Join-Path $semRoot 'VERSION'
    if (Test-Path -LiteralPath $ver) { Add-R 'sem.version' 'INFO' ((Get-Content -LiteralPath $ver -TotalCount 1)) }
    foreach ($rel in @('Launch-Semaphore.bat', 'Ask-Semaphore.bat', 'server\Start-Semaphore.ps1', 'server\Stop-Semaphore.ps1', 'server\Common.ps1', 'server\Http.ps1', 'server\Routes.ps1', 'web\dist\index.html', 'web\dist\build.json')) {
        $p = Join-Path $semRoot $rel
        Add-R ('sem.file.' + $rel.Replace($BS, '/')) $(if (Test-Path -LiteralPath $p) { 'PASS' } else { 'FAIL' }) $(if (Test-Path -LiteralPath $p) { 'present' } else { 'MISSING (this is what makes the "not built" page appear)' })
    }
    $assets = Join-Path $semRoot 'web\dist\assets'
    if (Test-Path -LiteralPath $assets) {
        $js = @(Get-ChildItem -LiteralPath $assets -Filter '*.js' -ErrorAction SilentlyContinue)
        Add-R 'sem.dist-assets' $(if ($js.Count -ge 3) { 'PASS' } else { 'FAIL' }) ($js.Count.ToString() + ' js files, ' + ((($js | Measure-Object Length -Sum).Sum) / 1KB).ToString('0') + ' KB total')
    } else { Add-R 'sem.dist-assets' 'FAIL' 'web\dist\assets is missing' }
    $blocked = 0; $total = 0; $nonAscii = 0; $parseErr = 0
    $launchFiles = @(Get-ChildItem -LiteralPath $semRoot -Include *.ps1, *.bat -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\(node_modules|tests|docs|examples|temp)\\' })
    foreach ($f in $launchFiles) {
        $total++
        try { $null = Get-Content -LiteralPath $f.FullName -Stream Zone.Identifier -ErrorAction Stop; $blocked++ } catch { }
        try { if ([IO.File]::ReadAllText($f.FullName) -match '[^\x00-\x7F]') { $nonAscii++ } } catch { }
        if ($f.Extension -eq '.ps1') {
            $errs = $null; [void][Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errs)
            if ($errs -and $errs.Count) { $parseErr++ }
        }
    }
    Add-R 'sem.scripts-marked-downloaded' $(if ($blocked -eq 0) { 'PASS' } else { 'WARN' }) ("$blocked of $total scripts carry a downloaded-from-internet mark (right-click the zip > Properties > Unblock before extracting)")
    Add-R 'sem.scripts-ascii' $(if ($nonAscii -eq 0) { 'PASS' } else { 'INFO' }) "$nonAscii of $total launcher and server scripts contain non-ASCII characters (Windows PowerShell 5.1 reads a file without a BOM as ANSI)"
    Add-R 'sem.scripts-parse' $(if ($parseErr -eq 0) { 'PASS' } else { 'FAIL' }) "$parseErr scripts fail to parse under this PowerShell"

    if ($NoSemaphoreRun) { Add-R 'sem.real-start' 'INFO' 'skipped (-NoSemaphoreRun)'; return }
    if (-not (Test-Path -LiteralPath (Join-Path $semRoot 'Launch-Semaphore.bat'))) { return }
    # Start a real copy on a spare loopback port exactly as a double-click would (hidden, --no-browser), then stop it.
    $port = 0
    foreach ($c in (8800, 8801, 8802) + (8803..8830)) {
        try { $l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $c); $l.Start(); $l.Stop(); $port = $c; break } catch { }
    }
    if ($port -eq 0) { Add-R 'sem.real-start' 'FAIL' 'no free loopback port in 8800-8830'; return }
    try {
        $psi = New-Object Diagnostics.ProcessStartInfo
        $psi.FileName = 'cmd.exe'
        $psi.Arguments = '/c ""' + (Join-Path $semRoot 'Launch-Semaphore.bat') + '" --no-browser --stay -Port ' + $port + '"'
        $psi.WorkingDirectory = $semRoot; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
        [void][Diagnostics.Process]::Start($psi)
        $page = $null; $t0 = Get-Date
        while (((Get-Date) - $t0).TotalSeconds -lt 30 -and -not $page) {
            Start-Sleep -Milliseconds 500
            try { $req = [Net.HttpWebRequest]::Create('http://127.0.0.1:' + $port + '/'); $req.Proxy = $null; $req.Timeout = 3000; $resp = $req.GetResponse(); $sr = New-Object IO.StreamReader($resp.GetResponseStream()); $page = $sr.ReadToEnd(); $code = [int]$resp.StatusCode; $sr.Dispose(); $resp.Close() } catch { }
        }
        if (-not $page) { Add-R 'sem.real-start' 'FAIL' ('Semaphore did not answer on 127.0.0.1:' + $port + ' within 30 seconds (see its logs folder)') }
        elseif ($page -match 'has not been built') { Add-R 'sem.real-start' 'FAIL' 'Semaphore started but served the "UI not built" page' }
        else {
            Add-R 'sem.real-start' 'PASS' ('Semaphore started on 127.0.0.1:' + $port + ', HTTP ' + $code + ', page ' + $page.Length + ' bytes')
            $m = [regex]::Match($page, '(?:src|href)="([^"]+\.js)"')
            if ($m.Success) {
                try {
                    $u = 'http://127.0.0.1:' + $port + '/' + $m.Groups[1].Value.TrimStart('/', '.')
                    $r2 = [Net.HttpWebRequest]::Create($u); $r2.Proxy = $null; $r2.Timeout = 8000; $rs = $r2.GetResponse()
                    Add-R 'sem.real-bundle' 'PASS' ($m.Groups[1].Value + ' -> HTTP ' + [int]$rs.StatusCode + ', ' + $rs.ContentType + ', ' + $rs.ContentLength + ' bytes'); $rs.Close()
                } catch { Add-R 'sem.real-bundle' 'FAIL' $_.Exception.Message }
            } else { Add-R 'sem.real-bundle' 'WARN' 'no script tag found in the served page' }
        }
    } finally {
        try { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $semRoot 'server\Stop-Semaphore.ps1') -Quiet 2>&1 | Out-Null } catch { }
    }
}

# ---------------------------------------------------------------- 7 loopback ports
Step 'loopback (PORTS)' {
    foreach ($p in 8800, 8801, 8802) {
        $l = $null
        try { $l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $p); $l.Start(); $l.Stop(); Add-R ('ports.bind.' + $p) 'PASS' 'TcpListener on 127.0.0.1 works' }
        catch {
            $inUse = $false
            try { $c = New-Object Net.Sockets.TcpClient; $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null); $inUse = $iar.AsyncWaitHandle.WaitOne(500) -and $c.Connected; $c.Close() } catch { }
            Add-R ('ports.bind.' + $p) $(if ($inUse) { 'INFO' } else { 'FAIL' }) $(if ($inUse) { 'already in use by a running program (probably Semaphore)' } else { $_.Exception.Message })
        }
    }
    try { $l6 = New-Object Net.Sockets.TcpListener([Net.IPAddress]::IPv6Loopback, 0); $l6.Start(); $l6.Stop(); Add-R 'ports.ipv6-loopback' 'INFO' 'works' } catch { Add-R 'ports.ipv6-loopback' 'INFO' $_.Exception.Message }
    try { $hl = New-Object Net.HttpListener; $hl.Prefixes.Add('http://127.0.0.1:0/'); Add-R 'ports.httplistener' 'INFO' 'prefix accepted (HttpListener is not used by Semaphore)' } catch { Add-R 'ports.httplistener' 'INFO' $_.Exception.Message }
}

# ---------------------------------------------------------------- 8 loopback http + browser page
$serverScript = {
    param($state)
    $enc = [Text.Encoding]::ASCII
    $listener = $null
    try {
        $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $state.Port = $listener.LocalEndpoint.Port
        while (-not $state.Stop) {
            if (-not $listener.Pending()) { Start-Sleep -Milliseconds 25; continue }
            $client = $listener.AcceptTcpClient()
            try {
                $client.ReceiveTimeout = 3000; $client.SendTimeout = 3000
                $stream = $client.GetStream()
                $buf = New-Object byte[] 16384
                $data = New-Object System.Collections.Generic.List[byte]
                $headEnd = -1
                while ($headEnd -lt 0 -and $data.Count -lt 65536) {
                    $n = $stream.Read($buf, 0, $buf.Length)
                    if ($n -le 0) { break }
                    for ($i = 0; $i -lt $n; $i++) { $data.Add($buf[$i]) }
                    $headEnd = $enc.GetString($data.ToArray()).IndexOf("`r`n`r`n")
                }
                if ($headEnd -lt 0) { continue }
                $text = $enc.GetString($data.ToArray())
                $head = $text.Substring(0, $headEnd).Split(@("`r`n"), [StringSplitOptions]::None)
                $parts = $head[0].Split(' ')
                $method = $parts[0]; $path = if ($parts.Length -gt 1) { $parts[1] } else { '/' }
                $hostHdr = ''; $clen = 0
                foreach ($h in $head) {
                    if ($h -match '^(?i)host:\s*(.+)$') { $hostHdr = $Matches[1].Trim() }
                    if ($h -match '^(?i)content-length:\s*(\d+)') { $clen = [int]$Matches[1] }
                }
                while (($data.Count - ($headEnd + 4)) -lt $clen -and $data.Count -lt 131072) {
                    $n = $stream.Read($buf, 0, $buf.Length); if ($n -le 0) { break }
                    for ($i = 0; $i -lt $n; $i++) { $data.Add($buf[$i]) }
                }
                $body = ''
                if ($clen -gt 0) { $all = $enc.GetString($data.ToArray()); $body = $all.Substring($headEnd + 4) }
                $state.Hits = $state.Hits + 1
                $status = '200 OK'; $ctype = 'text/plain; charset=utf-8'; $out = ''
                $tok = '/' + $state.Token + '/'
                if ($hostHdr -ne ('127.0.0.1:' + $state.Port)) { $status = '421 Misdirected Request'; $out = 'wrong host' }
                elseif ($method -eq 'GET' -and $path -eq $tok) { $ctype = 'text/html; charset=utf-8'; $out = $state.Html }
                elseif ($method -eq 'GET' -and $path -eq ($tok + 'ping')) { $out = 'pong' }
                elseif ($method -eq 'GET' -and $path -eq ($tok + 'probe-worker.js')) { $ctype = 'text/javascript; charset=utf-8'; $out = 'postMessage("worker-file-ok");' }
                elseif ($method -eq 'POST' -and $path -eq ($tok + 'result')) { $state.Result = $body; $state.Done = $true; $out = 'thanks' }
                else { $status = '404 Not Found'; $out = 'not found' }
                $bytes = [Text.Encoding]::UTF8.GetBytes($out)
                $hdr = 'HTTP/1.1 ' + $status + "`r`nContent-Type: " + $ctype + "`r`nContent-Length: " + $bytes.Length + "`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
                $hb = $enc.GetBytes($hdr)
                $stream.Write($hb, 0, $hb.Length); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush()
            } catch { } finally { try { $client.Close() } catch { } }
        }
    } catch { $state.Error = $_.Exception.Message } finally { if ($listener) { $listener.Stop() } }
}

$pageHtml = @'
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fleet environment check</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font:15px/1.5 Segoe UI,Arial,sans-serif;margin:24px;max-width:900px;color:#111;background:#fff}
h1{font-size:20px;margin:0 0 4px} li{margin:2px 0;font-family:Consolas,monospace;font-size:13px}
#sum{padding:10px 12px;border-radius:6px;background:#eef;margin:12px 0}
</style></head><body>
<h1>Fleet environment check - browser tests</h1>
<p>This page only talks to this computer (127.0.0.1). It reports back to the check window and you can close it when it says Done.</p>
<div id="sum">Running...</div><ul id="list"></ul>
<script>
(function () {
  var out = [], fails = 0;
  function add(k, s, v) {
    if (s === 'FAIL') fails++;
    v = String(v).replace(/[\r\n|]+/g, ' ').replace(/[^\x20-\x7e]/g, '?');
    out.push(k + '|' + s + '|' + v);
    var li = document.createElement('li'); li.textContent = '[' + s + '] ' + k + ': ' + v; document.getElementById('list').appendChild(li);
  }
  function limit(p, ms) { return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timed out after ' + ms + ' ms')); }, ms); })]); }
  async function t(k, fn) { try { var r = await limit(Promise.resolve().then(fn), 8000); add(k, (r && r.s) || 'PASS', (r && r.v !== undefined) ? r.v : 'ok'); } catch (e) { add(k, 'FAIL', (e && e.message) ? e.message : e); } }
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  async function run() {
    add('browser.user-agent', 'INFO', navigator.userAgent);
    add('browser.viewport', 'INFO', window.innerWidth + 'x' + window.innerHeight + ' dpr ' + window.devicePixelRatio);
    add('browser.secure-context', window.isSecureContext ? 'PASS' : 'WARN', window.isSecureContext);
    await t('browser.es.modern-methods', function () {
      var miss = [];
      if (!Array.prototype.at) miss.push('Array.at'); if (!Object.hasOwn) miss.push('Object.hasOwn'); if (typeof structuredClone !== 'function') miss.push('structuredClone');
      if (!String.prototype.replaceAll) miss.push('replaceAll'); if (!Array.prototype.findLast) miss.push('findLast'); if (typeof BigInt !== 'function') miss.push('BigInt');
      return miss.length ? { s: 'FAIL', v: 'missing ' + miss.join(', ') + ' (browser too old for the Semaphore UI)' } : { v: 'present' };
    });
    await t('browser.es.dynamic-import-blob-module', async function () {
      var u = URL.createObjectURL(new Blob(['export default 7'], { type: 'text/javascript' }));
      var m = await import(u); return { v: 'imported ' + m.default };
    });
    await t('browser.es.eval-new-function', function () { return { s: 'INFO', v: String(new Function('return 1')()) }; });
    await t('browser.storage.localStorage', function () { localStorage.setItem('fleet-env', '1'); var ok = localStorage.getItem('fleet-env') === '1'; localStorage.removeItem('fleet-env'); if (!ok) throw new Error('read back failed'); return { v: 'works' }; });
    await t('browser.storage.sessionStorage', function () { sessionStorage.setItem('fleet-env', '1'); var ok = sessionStorage.getItem('fleet-env') === '1'; sessionStorage.removeItem('fleet-env'); if (!ok) throw new Error('read back failed'); return { v: 'works' }; });
    await t('browser.storage.indexedDB', function () {
      return new Promise(function (res, rej) {
        var rq = indexedDB.open('fleet-env-check', 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('s'); };
        rq.onerror = function () { rej(rq.error || new Error('open failed')); };
        rq.onblocked = function () { rej(new Error('blocked')); };
        rq.onsuccess = function () {
          var db = rq.result, tx = db.transaction('s', 'readwrite'); tx.objectStore('s').put('x', 'k');
          tx.oncomplete = function () { db.close(); indexedDB.deleteDatabase('fleet-env-check'); res({ v: 'write ok' }); };
          tx.onerror = function () { rej(tx.error || new Error('tx failed')); };
        };
      });
    });
    await t('browser.crypto.sha256', async function () {
      var d = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('x')));
      if (d !== '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881') throw new Error('wrong digest ' + d);
      return { v: 'correct' };
    });
    await t('browser.crypto.aes-gcm', async function () {
      var k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var c = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, new TextEncoder().encode('fleet'));
      var p = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, k, c);
      if (new TextDecoder().decode(p) !== 'fleet') throw new Error('mismatch'); return { v: 'round trip ok' };
    });
    await t('browser.worker.blob', function () {
      return new Promise(function (res, rej) {
        var w = new Worker(URL.createObjectURL(new Blob(['postMessage(1+1)'], { type: 'text/javascript' })));
        w.onmessage = function (e) { w.terminate(); res({ v: 'reply ' + e.data }); };
        w.onerror = function (e) { rej(new Error(e.message || 'worker error')); };
      });
    });
    await t('browser.worker.file', function () {
      return new Promise(function (res, rej) {
        var w = new Worker('probe-worker.js');
        w.onmessage = function (e) { w.terminate(); res({ v: String(e.data) }); };
        w.onerror = function (e) { rej(new Error(e.message || 'worker file blocked')); };
      });
    });
    await t('browser.wasm', async function () { await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); return { v: 'compiled' }; });
    await t('browser.fetch.same-origin', async function () { var r = await fetch('ping', { cache: 'no-store' }); var x = await r.text(); if (x !== 'pong') throw new Error('got ' + x); return { v: 'ok' }; });
    await t('browser.canvas.2d', function () { var c = document.createElement('canvas'); c.width = 20; c.height = 20; var g = c.getContext('2d'); g.fillRect(0, 0, 10, 10); g.measureText('x'); if (!c.toDataURL().startsWith('data:image/png')) throw new Error('no png'); return { v: 'works' }; });
    await t('browser.svg', function () { var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); document.body.appendChild(s); var ok = s.getBBox ? true : false; document.body.removeChild(s); return { v: ok }; });
    await t('browser.blob-url', function () { var u = URL.createObjectURL(new Blob(['x'])); URL.revokeObjectURL(u); return { v: 'works' }; });
    await t('browser.css.modern', function () {
      var need = [['oklch color', CSS.supports('color', 'oklch(0.5 0.1 200)')], ['color-mix', CSS.supports('background', 'color-mix(in srgb, red, blue)')], ['@layer', typeof CSSLayerBlockRule !== 'undefined'], ['container queries', CSS.supports('container-type', 'inline-size')], ['@property', typeof CSS.registerProperty === 'function']];
      var miss = need.filter(function (n) { return !n[1]; }).map(function (n) { return n[0]; });
      return miss.length ? { s: 'FAIL', v: 'missing ' + miss.join(', ') + ' (Tailwind 4 styling needs these)' } : { v: 'all present' };
    });
    add('browser.api.service-worker', 'INFO', 'serviceWorker' in navigator);
    add('browser.api.file-system-access', 'INFO', typeof window.showSaveFilePicker === 'function');
    add('browser.api.clipboard', 'INFO', !!(navigator.clipboard && navigator.clipboard.writeText));
    add('browser.api.webgl', 'INFO', (function () { try { return !!document.createElement('canvas').getContext('webgl'); } catch (e) { return false; } })());
    document.getElementById('sum').textContent = fails === 0 ? 'Done: all browser tests passed. You can close this tab.' : 'Done: ' + fails + ' browser test(s) failed (listed below). You can close this tab.';
    try { await fetch('result', { method: 'POST', body: out.join('\n') }); } catch (e) { document.getElementById('sum').textContent += ' (Could not report back: ' + e.message + ' - take a screenshot of this page.)'; }
  }
  run();
})();
</script></body></html>
'@

$state = [hashtable]::Synchronized(@{ Port = 0; Stop = $false; Done = $false; Result = $null; Error = $null; Hits = 0; Token = ([guid]::NewGuid().ToString('N')); Html = $pageHtml })
$ps = $null; $async = $null
Step 'loopback http (PORTS)' {
    $script:ps = [powershell]::Create()
    [void]$script:ps.AddScript($serverScript.ToString()).AddArgument($state)
    $script:async = $script:ps.BeginInvoke()
    $t0 = Get-Date
    while ($state.Port -eq 0 -and -not $state.Error -and ((Get-Date) - $t0).TotalSeconds -lt 5) { Start-Sleep -Milliseconds 50 }
    if ($state.Port -eq 0) { Add-R 'http.server' 'FAIL' ('could not start the test server: ' + $state.Error); return }
    Add-R 'http.server' 'PASS' ('test server listening on 127.0.0.1:' + $state.Port + ' (background runspace)')
    $base = 'http://127.0.0.1:' + $state.Port + '/' + $state.Token + '/'
    try {
        $tc = New-Object Net.Sockets.TcpClient('127.0.0.1', $state.Port)
        $s = $tc.GetStream(); $req = [Text.Encoding]::ASCII.GetBytes("GET /" + $state.Token + "/ping HTTP/1.1`r`nHost: 127.0.0.1:" + $state.Port + "`r`nConnection: close`r`n`r`n")
        $s.Write($req, 0, $req.Length); $rd = New-Object IO.StreamReader($s); $txt = $rd.ReadToEnd(); $tc.Close()
        Add-R 'http.raw-tcp' $(if ($txt -match 'pong') { 'PASS' } else { 'FAIL' }) $(if ($txt -match 'pong') { 'raw socket request answered' } else { $txt })
    } catch { Add-R 'http.raw-tcp' 'FAIL' $_.Exception.Message }
    try { $r = [Net.HttpWebRequest]::Create($base + 'ping'); $r.Proxy = $null; $r.Timeout = 5000; $x = (New-Object IO.StreamReader($r.GetResponse().GetResponseStream())).ReadToEnd(); Add-R 'http.web-request-no-proxy' $(if ($x -eq 'pong') { 'PASS' } else { 'FAIL' }) $x } catch { Add-R 'http.web-request-no-proxy' 'FAIL' $_.Exception.Message }
    try { $r = [Net.HttpWebRequest]::Create($base + 'ping'); $r.Timeout = 5000; $x = (New-Object IO.StreamReader($r.GetResponse().GetResponseStream())).ReadToEnd(); Add-R 'http.web-request-system-proxy' $(if ($x -eq 'pong') { 'PASS' } else { 'FAIL' }) ($x + ' (system proxy settings applied; failure here means a proxy is intercepting loopback)') } catch { Add-R 'http.web-request-system-proxy' 'FAIL' $_.Exception.Message }
    try { $wc = New-Object Net.WebClient; $x = $wc.DownloadString($base + 'ping'); Add-R 'http.webclient' $(if ($x -eq 'pong') { 'PASS' } else { 'FAIL' }) $x } catch { Add-R 'http.webclient' 'FAIL' $_.Exception.Message }
    try { $x = (Invoke-WebRequest -Uri ($base + 'ping') -UseBasicParsing -TimeoutSec 5).Content; Add-R 'http.invoke-webrequest' $(if ($x -eq 'pong') { 'PASS' } else { 'FAIL' }) $x } catch { Add-R 'http.invoke-webrequest' 'FAIL' $_.Exception.Message }
    try { $r = [Net.HttpWebRequest]::Create('http://localhost:' + $state.Port + '/' + $state.Token + '/ping'); $r.Proxy = $null; $r.Timeout = 5000; [void]$r.GetResponse(); Add-R 'http.localhost-name' 'INFO' 'localhost answered (the DNS-rebinding host check may reject it: expected)' } catch { Add-R 'http.localhost-name' 'INFO' ('localhost rejected or unreachable: ' + $_.Exception.Message + ' (expected: only 127.0.0.1 is accepted)') }
}

Step 'browser (BLANK-PAGE)' {
    if ($NoBrowser) { Add-R 'browser.skipped' 'INFO' 'skipped (-NoBrowser)'; return }
    if ($state.Port -eq 0) { Add-R 'browser.skipped' 'FAIL' 'test server is not running'; return }
    $paths = @(
        @('Edge', (Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe' '(default)')),
        @('Edge', (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')),
        @('Edge', (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')),
        @('Chrome', (Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' '(default)')),
        @('Chrome', (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')),
        @('Chrome', (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')))
    $found = @{}
    foreach ($p in $paths) { if ($p[1] -and -not $found.ContainsKey($p[0]) -and (Test-Path -LiteralPath $p[1])) { $found[$p[0]] = $p[1] } }
    foreach ($k in 'Edge', 'Chrome') {
        if ($found.ContainsKey($k)) { Add-R ('browser.installed.' + $k.ToLower()) 'PASS' ($found[$k] + ' version ' + (Get-Item -LiteralPath $found[$k]).VersionInfo.ProductVersion) }
        else { Add-R ('browser.installed.' + $k.ToLower()) 'INFO' 'not found' }
    }
    if ($found.Count -eq 0) { Add-R 'browser.any-installed' 'FAIL' 'neither Edge nor Chrome was found (Semaphore needs one)' }
    $wv = Get-RegValue 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' 'pv'
    Add-R 'browser.webview2-runtime' 'INFO' ('version=' + $wv)
    Add-R 'browser.default-http-handler' 'INFO' ('ProgId=' + (Get-RegValue 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice' 'ProgId'))
    $url = 'http://127.0.0.1:' + $state.Port + '/' + $state.Token + '/'
    Write-Host ''
    Write-Host ('Opening the browser test page: ' + $url) -ForegroundColor Cyan
    Write-Host '(If no window appears, copy that address into Edge or Chrome yourself.)'
    $launched = $null
    if ($NoLaunch) { Add-R 'browser.launched' 'INFO' 'not launched (-NoLaunch): open the address above yourself' }
    else { try {
        if ($found.ContainsKey('Edge')) { Start-Process -FilePath $found['Edge'] -ArgumentList $url; $launched = 'Edge' }
        elseif ($found.ContainsKey('Chrome')) { Start-Process -FilePath $found['Chrome'] -ArgumentList $url; $launched = 'Chrome' }
        else { Start-Process $url; $launched = 'default handler' }
        Add-R 'browser.launched' 'PASS' $launched
    } catch { Add-R 'browser.launched' 'FAIL' $_.Exception.Message } }
    $t0 = Get-Date
    while (-not $state.Done -and ((Get-Date) - $t0).TotalSeconds -lt $BrowserWaitSec) { Start-Sleep -Milliseconds 300 }
    if (-not $state.Done) {
        Add-R 'browser.report' 'FAIL' ('the page did not report back within ' + $BrowserWaitSec + ' s. Server saw ' + $state.Hits + ' requests. 0 means the browser never reached 127.0.0.1 (blocked or a proxy); more than 0 means the page loaded but its scripts did not run or could not post back.')
    } else {
        $n = 0
        foreach ($line in ([string]$state.Result).Split("`n")) {
            $p = $line.Split('|')
            if ($p.Length -ge 3 -and $p[1] -match '^(PASS|FAIL|WARN|INFO)$') { Add-R $p[0] $p[1] (($p[2..($p.Length - 1)]) -join '|'); $n++ }
        }
        Add-R 'browser.report' 'PASS' ($n.ToString() + ' results received; server saw ' + $state.Hits + ' requests')
    }
}

# stop the test server
try {
    $state.Stop = $true
    if ($script:async) { [void]$script:async.AsyncWaitHandle.WaitOne(3000) }
    if ($script:ps) { $script:ps.Dispose() }
} catch { }
try { if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue } } catch { }

# ---------------------------------------------------------------- verdicts
function Get-Status([string]$key) { $r = $script:Results | Where-Object { $_.Key -eq $key } | Select-Object -Last 1; if ($r) { return $r.Status } else { return 'n/a' } }
function Test-AllPass([string[]]$keys) {
    $bad = @($keys | Where-Object { (Get-Status $_) -eq 'FAIL' -or (Get-Status $_) -eq 'ERROR' })
    $none = @($keys | Where-Object { (Get-Status $_) -eq 'n/a' })
    if ($bad.Count -gt 0) { return 'FAIL' }
    if ($none.Count -eq $keys.Count) { return 'INFO' }
    return 'PASS'
}
$ms2 = @($script:Results | Where-Object { $_.Key -like 'zip.downloaded.*' } | ForEach-Object { $_.Key })
Write-LogLine ''
Write-LogLine '=== verdict (the specific failures)'
Write-Host ''
Write-Host '=== verdict (the specific failures)' -ForegroundColor Cyan
Add-R 'verdict.ZIP-EXTRACT' (Test-AllPass (@('zip.signature', 'zip.read-dotnet', 'zip.expand-archive', 'zip.explorer-shell') + $ms2)) 'a zip can be created, read and extracted here; downloaded Semaphore zips are real zips'
Add-R 'verdict.LAUNCH' (Test-AllPass @('ps.language-mode', 'launch.bat-runs', 'launch.ps1-bypass', 'launch.add-type-csharp', 'launch.tray-notifyicon', 'launch.credential-manager', 'launch.dpapi')) '.bat and .ps1 run, FullLanguage, C# compiles, tray and secrets APIs work'
Add-R 'verdict.NOT-BUILT' (Test-AllPass @('sem.file.web/dist/index.html', 'sem.dist-assets', 'sem.real-start', 'sem.real-bundle')) 'web\dist is present and a real Semaphore start serves the app, not the "not built" page'
Add-R 'verdict.PORTS' (Test-AllPass @('ports.bind.8800', 'ports.bind.8801', 'ports.bind.8802', 'http.server', 'http.raw-tcp', 'http.web-request-no-proxy', 'http.web-request-system-proxy')) 'loopback listeners and HTTP to 127.0.0.1 work, with and without the system proxy'
$bp = @($script:Results | Where-Object { $_.Key -like 'browser.*' -and $_.Status -eq 'FAIL' })
if ($NoBrowser) { Add-R 'verdict.BLANK-PAGE' 'INFO' 'browser tests were skipped' }
elseif (@($script:Results | Where-Object { $_.Key -eq 'browser.report' -and $_.Status -eq 'PASS' }).Count -eq 0) { Add-R 'verdict.BLANK-PAGE' 'FAIL' 'the browser page never reported back' }
else { Add-R 'verdict.BLANK-PAGE' $(if ($bp.Count -eq 0) { 'PASS' } else { 'FAIL' }) $(if ($bp.Count -eq 0) { 'the browser supports everything the Semaphore UI needs' } else { ('failed: ' + (($bp | ForEach-Object { $_.Key }) -join ', ')) }) }

$fails = @($script:Results | Where-Object { $_.Status -eq 'FAIL' -or $_.Status -eq 'ERROR' }).Count
$warns = @($script:Results | Where-Object { $_.Status -eq 'WARN' }).Count
Add-R 'run.finished' 'INFO' ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
Add-R 'run.totals' 'INFO' ("$fails failed, $warns warnings, " + $script:Results.Count + ' results')
Write-Host ''
if ($script:LogPath) { Write-Host ('Log written to: ' + $script:LogPath) -ForegroundColor Green; Write-Host 'Send that file back (it holds the machine name and OS details, with your user name replaced). To compare two machines:'; Write-Host '  Check-Environment.bat -Compare <log from machine A> <log from machine B>' }
