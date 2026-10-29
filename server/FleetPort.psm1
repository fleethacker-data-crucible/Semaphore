<#
.SYNOPSIS
    FleetHacker port blocks with self-detection (Windows PowerShell 5.1). ASCII only.
.DESCRIPTION
    Each tool owns one contiguous port block (FleetPorts.psd1). It starts at the block's first port and
    walks upward only inside its block. When a port is busy it probes GET /__fleethacker/id first:
      - another program, or no answer   -> next port in the block
      - this same tool                  -> apply the tool's policy:
          (any policy but multi) a NEWER copy is running: Action 'Reuse' with a 'stale launcher' Note
                    (also written as a warning); never downgrade
          reuse     same version: return Action 'Reuse' (open the browser to it and exit);
                    older or unparseable version: stop it gracefully, then start on that port
          restart   always stop it gracefully, then start on that port
          multi     leave it running, try the next port (whatever its version: built for parallelism)
          exclusive same version: Reuse; older version: throw (never auto-stop; holds a lease)
    Block full -> a clear error. Binds http://localhost:<port>/ only. No random or OS-ephemeral fallback.
    Graceful stop: POST /__fleethacker/shutdown (header X-FleetHacker-Shutdown: 1). If the port is still
    held, Stop-Process only on the self-reported pid, and only when the reported path is absolute, it EXACTLY
    equals that pid's -File script (parsed from Win32_Process.CommandLine) or ExecutablePath, and that pid
    owns the listening port. Never a substring match.
    Functions: Get-FleetPortBlock, Test-FleetPortFree, Test-FleetSelf, Stop-FleetInstance, Resolve-FleetPort,
               Invoke-FleetIdEndpoint (drop-in for an HttpListener request loop).
#>
Set-StrictMode -Version Latest

$script:IdPath = '/__fleethacker/id'
$script:ShutdownPath = '/__fleethacker/shutdown'
$script:Policies = @('reuse', 'restart', 'multi', 'exclusive')

function Get-FleetPortBlock {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Tool,
        [string]$RegistryPath = (Join-Path $PSScriptRoot 'FleetPorts.psd1')
    )
    $reg = Import-PowerShellDataFile -LiteralPath $RegistryPath
    if (-not $reg.ContainsKey($Tool)) { throw "Tool '$Tool' has no port block in $RegistryPath. Add one (see PORTS.md)." }
    $b = $reg[$Tool]
    $policy = [string]$b.Policy
    if ($script:Policies -notcontains $policy) { throw "Tool '$Tool' has an unknown policy '$policy' (use $($script:Policies -join ', '))." }
    $start = [int]$b.Start; $size = [int]$b.Size
    if ($size -lt 1) { throw "Tool '$Tool' block size must be at least 1." }
    New-Object PSObject -Property ([ordered]@{ Tool = $Tool; Start = $start; End = $start + $size - 1; Size = $size; Policy = $policy })
}

# Free on both IPv4 and IPv6 loopback. A machine without IPv6 counts as free on that side.
function Test-FleetPortFree {
    [CmdletBinding()]
    [OutputType([bool])]
    param([Parameter(Mandatory = $true)][int]$Port)
    foreach ($addr in @([System.Net.IPAddress]::Loopback, [System.Net.IPAddress]::IPv6Loopback)) {
        # The constructor already creates the socket on .NET Core, so it is inside the try as well
        # (a machine without IPv6 throws AddressFamilyNotSupported there). Semaphore copy: patched.
        try { $t = New-Object System.Net.Sockets.TcpListener $addr, $Port; $t.Start(); $t.Stop() }
        catch {
            $se = $_.Exception
            while ($se -and $se -isnot [System.Net.Sockets.SocketException]) { $se = $se.InnerException }
            if ($se -and $addr.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6 -and
                $se.SocketErrorCode -eq [System.Net.Sockets.SocketError]::AddressFamilyNotSupported) { continue }
            return $false
        }
    }
    return $true
}

function Invoke-FleetLocalRequest {
    param([int]$Port, [string]$Path, [string]$Method = 'GET', [int]$TimeoutMs = 1500, [hashtable]$Headers = @{})
    # Try 127.0.0.1 first, then [::1] only if IPv4 refused the connection. Always send Host: localhost:<port>,
    # which http.sys needs to match a localhost prefix. (Going to ::1 first would cost ~2 s on Windows,
    # which retries a refused connect.)
    foreach ($ip in @('127.0.0.1', '[::1]')) {
        try {
            $req = [System.Net.HttpWebRequest]::Create("http://${ip}:$Port$Path")
            $req.Host = "localhost:$Port"
            $req.Method = $Method
            $req.Proxy = $null                      # never send loopback probes through a proxy
            $req.Timeout = $TimeoutMs
            $req.ReadWriteTimeout = $TimeoutMs
            $req.AllowAutoRedirect = $false
            foreach ($k in $Headers.Keys) { $req.Headers[$k] = [string]$Headers[$k] }
            if ($Method -eq 'POST') { $req.ContentLength = 0 }
            $resp = $req.GetResponse()
            try {
                $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
                $body = $sr.ReadToEnd()
                return New-Object PSObject -Property @{ Status = [int]$resp.StatusCode; Body = $body }
            } finally { $resp.Close() }
        } catch [System.Net.WebException] {
            $we = $_.Exception
            if ($we -isnot [System.Net.WebException] -and $we.InnerException -is [System.Net.WebException]) { $we = $we.InnerException }
            $r = $we.Response
            if ($r) { $code = [int]$r.StatusCode; $r.Close(); return New-Object PSObject -Property @{ Status = $code; Body = '' } }
            # Refused is ConnectFailure on .NET Framework and UnknownError on .NET Core; a timeout means
            # something holds the IPv4 port, so do not spend another timeout on ::1.
            if ($we.Status -eq [System.Net.WebExceptionStatus]::Timeout) { return $null }
        } catch {
            return $null
        }
    }
    return $null
}

# Probes GET /__fleethacker/id. Returns $null when nothing FleetHacker answers, else
# @{ IsSelf; Tool; Version; Pid; Path }.
function Test-FleetSelf {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$Tool,
        [int]$TimeoutMs = 1500
    )
    $r = Invoke-FleetLocalRequest -Port $Port -Path $script:IdPath -TimeoutMs $TimeoutMs
    if (-not $r -or $r.Status -ne 200 -or -not $r.Body) { return $null }
    try { $id = $r.Body | ConvertFrom-Json } catch { return $null }
    if (-not $id -or -not ($id.PSObject.Properties.Name -contains 'tool')) { return $null }
    $path = $null; if ($id.PSObject.Properties.Name -contains 'path') { $path = [string]$id.path }
    $procId = 0; if ($id.PSObject.Properties.Name -contains 'pid') { $procId = [int]$id.pid }
    $ver = ''; if ($id.PSObject.Properties.Name -contains 'version') { $ver = [string]$id.version }
    New-Object PSObject -Property ([ordered]@{
        IsSelf = ([string]$id.tool -eq $Tool); Tool = [string]$id.tool; Version = $ver; Pid = $procId; Path = $path; Port = $Port })
}

# 1 if A is newer than B, -1 if older, 0 if equal, $null if either is not a dotted version
# (a leading 'v' and a '-suffix' / '+build' are ignored). Unknown counts as "different", never "newer".
function Compare-FleetVersion {
    param([string]$A, [string]$B)
    $va = ConvertTo-FleetVersion $A; $vb = ConvertTo-FleetVersion $B
    if ($null -eq $va -or $null -eq $vb) { return $null }
    return $va.CompareTo($vb)
}

function ConvertTo-FleetVersion {
    param([string]$Text)
    if ($Text -notmatch '^\s*v?(\d+(\.\d+){0,3})') { return $null }
    $t = $Matches[1]; if ($t -notmatch '\.') { $t = "$t.0" }
    $v = $null
    if ([System.Version]::TryParse($t, [ref]$v)) { return $v }
    return $null
}

function Wait-FleetPortFree {
    param([int]$Port, [int]$TimeoutMs)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
        if (Test-FleetPortFree -Port $Port) { return $true }
        Start-Sleep -Milliseconds 100
    }
    return (Test-FleetPortFree -Port $Port)
}

# Absolute, normalized Windows path (drive root 'C:\...' or UNC '\\server\share\...'), or $null.
# Relative or bare values such as 'powershell' or 'tool.ps1' are rejected.
function ConvertTo-FleetAbsolutePath {
    param([string]$Path)
    if (-not $Path) { return $null }
    $p = $Path.Trim().Trim('"').Replace('/', '\')
    if ($p -notmatch '^(?:[A-Za-z]:\\|\\\\[^\\?.]+\\[^\\]+)') { return $null }
    if ($env:OS -eq 'Windows_NT') {
        try { $p = [System.IO.Path]::GetFullPath($p) } catch { return $null }
    } elseif ($p -match '\\\.{1,2}(\\|$)') {
        return $null                            # cannot normalize '.' / '..' segments off Windows; refuse
    }
    return $p.TrimEnd('\')
}

# Splits a Windows command line the way CommandLineToArgvW / the MSVC runtime does:
# whitespace separates arguments; "..." groups; 2n backslashes + quote -> n backslashes and a quote toggle;
# 2n+1 backslashes + quote -> n backslashes and a literal quote; other backslashes are literal.
function Split-FleetCommandLine {
    param([string]$CommandLine)
    $out = New-Object System.Collections.Generic.List[string]
    if (-not $CommandLine) { return , $out.ToArray() }
    $sb = New-Object System.Text.StringBuilder
    $inQuote = $false; $have = $false; $i = 0; $n = $CommandLine.Length
    while ($i -lt $n) {
        $c = $CommandLine[$i]
        if ($c -eq '\') {
            $j = $i; while ($j -lt $n -and $CommandLine[$j] -eq '\') { $j++ }
            $count = $j - $i
            if ($j -lt $n -and $CommandLine[$j] -eq '"') {
                [void]$sb.Append('\', [int][Math]::Floor($count / 2))
                if ($count % 2 -eq 1) { [void]$sb.Append('"'); $i = $j + 1 } else { $i = $j }
            } else { [void]$sb.Append('\', $count); $i = $j }
            $have = $true; continue
        }
        if ($c -eq '"') {
            if ($inQuote -and ($i + 1) -lt $n -and $CommandLine[$i + 1] -eq '"') { [void]$sb.Append('"'); $i += 2; $have = $true; continue }
            $inQuote = -not $inQuote; $have = $true; $i++; continue
        }
        if (-not $inQuote -and ($c -eq ' ' -or $c -eq "`t")) {
            if ($have) { $out.Add($sb.ToString()); [void]$sb.Clear(); $have = $false }
            $i++; continue
        }
        [void]$sb.Append($c); $have = $true; $i++
    }
    if ($have) { $out.Add($sb.ToString()) }
    return , $out.ToArray()
}

# The script passed to powershell.exe / pwsh.exe with -File (or -f), or $null. Returns $null when the host is not
# PowerShell, or when -Command / -EncodedCommand comes first (then the path is only an argument, not the script).
function Get-FleetScriptFromCommandLine {
    param([string]$CommandLine)
    [string[]]$argv = Split-FleetCommandLine $CommandLine
    if ($null -eq $argv -or $argv.Count -lt 3) { return $null }
    $exeLeaf = ($argv[0] -split '[\\/]')[-1]
    if (@('powershell', 'powershell.exe', 'pwsh', 'pwsh.exe') -notcontains $exeLeaf.ToLowerInvariant()) { return $null }
    for ($k = 1; $k -lt $argv.Count - 1; $k++) {
        $a = $argv[$k].ToLowerInvariant()
        if ($a -eq '-file' -or $a -eq '-f' -or $a -eq '/file') { return $argv[$k + 1] }
        if ($a -match '^[-/](c|command|e|ec|encodedcommand|commandwithargs|cwa)$') { return $null }
        if ($a -match '^[-/](executionpolicy|ep|ex|windowstyle|w|version|v|inputformat|if|outputformat|of|psconsolefile|configurationname|workingdirectory|wd|settingsfile)$') { $k++; continue }
        if ($a -notmatch '^[-/]') { return $null }   # a bare argument before -File: not a -File launch
    }
    return $null
}

# $true only when the process IS the tool at $Path: an exact (case-insensitive) match of the normalized path
# against the -File script of a PowerShell host, or against ExecutablePath for a compiled tool. Never a substring.
function Test-FleetProcessIdentity {
    param([string]$Path, [string]$CommandLine, [string]$ExecutablePath)
    $want = ConvertTo-FleetAbsolutePath $Path
    if (-not $want) { return $false }
    $exe = ConvertTo-FleetAbsolutePath $ExecutablePath
    if ($exe -and [string]::Equals($exe, $want, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    $script = ConvertTo-FleetAbsolutePath (Get-FleetScriptFromCommandLine $CommandLine)
    if ($script -and [string]::Equals($script, $want, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $false
}

function Get-FleetProcessInfo {
    param([int]$ProcessId)
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if (-not $p) { return $null }
    New-Object PSObject -Property @{ CommandLine = [string]$p.CommandLine; ExecutablePath = [string]$p.ExecutablePath }
}

# PIDs listening on the port. Empty when unknown (no Get-NetTCPConnection), which makes Stop-FleetInstance refuse.
# Note: an http.sys (HttpListener) port is owned by PID 4 (System); see Stop-FleetInstance for the netsh proof.
function Get-FleetPortOwner {
    param([int]$Port)
    if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { return @() }
    @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
}

# Raw `netsh http show servicestate view=requestq` output, or $null when netsh is missing or fails
# (non-zero exit, for example access denied). Read-only.
function Get-FleetHttpSysRequestQueueText {
    $sys = [Environment]::SystemDirectory
    if (-not $sys) { return $null }
    $netsh = Join-Path $sys 'netsh.exe'
    if (-not (Test-Path -LiteralPath $netsh)) { return $null }
    try { $out = & $netsh http show servicestate view=requestq 2>&1 } catch { return $null }
    if ($LASTEXITCODE -ne 0) { return $null }
    return (@($out | ForEach-Object { [string]$_ }) -join "`n")
}

<#
  One URL from the "Registered URLs:" list, parsed deliberately, or $null when it is not a form we understand.
  Forms (http.sys URL prefix strings, as netsh prints them in upper case):
    HTTP://LOCALHOST:8845/                  host:port
    HTTP://127.0.0.1:25000:127.0.0.1/       host:port:ip (IP-bound prefix; TalkForge registers this form)
    HTTP://[::1]:8845/                      bracketed IPv6 host
    Wildcard host prefixes (+ or *) are recognized only for inspection; never bound.
  Returns @{ Scheme; Host; Port; BoundIp; Path; Loopback }. Loopback is true only when the host is localhost,
  127.0.0.1 or [::1] AND, for the host:port:ip form, the bound ip is 127.0.0.1 or ::1 too. + and * are never loopback.
#>
function ConvertFrom-FleetHttpSysUrl {
    param([string]$Url)
    $m = [regex]::Match([string]$Url, '^(?i)(https?)://(\[[0-9a-f:.]+\]|[^:/\[\]]+):(\d{1,5})(?::(\[[0-9a-f:.]+\]|[0-9a-f:.]+))?(/.*)$')
    if (-not $m.Success) { return $null }
    $port = [int]$m.Groups[3].Value
    if ($port -lt 1 -or $port -gt 65535) { return $null }
    $hostName = $m.Groups[2].Value.ToLowerInvariant()
    $boundIp = $null
    if ($m.Groups[4].Success) { $boundIp = $m.Groups[4].Value.Trim('[', ']').ToLowerInvariant() }
    $loopHosts = @('localhost', '127.0.0.1', '[::1]')
    $loop = ($loopHosts -contains $hostName)
    if ($loop -and $null -ne $boundIp) { $loop = (@('127.0.0.1', '::1') -contains $boundIp) }
    return @{ Scheme = $m.Groups[1].Value.ToLowerInvariant(); Host = $hostName; Port = $port; BoundIp = $boundIp; Path = $m.Groups[5].Value; Loopback = [bool]$loop }
}

<#
  Pid of the http.sys request queue that serves <Port> only on loopback, or $null unless that is certain.
  Only the English layout is understood ("Snapshot of HTTP service state (Request Queue View):", "Request queue name:",
  "ID: <pid>, image: ...", and the registered URL lines, which real output nests under "URL groups:").
  Every registered URL is parsed with ConvertFrom-FleetHttpSysUrl and matched on its port number, so the host:port:ip
  form (HTTP://127.0.0.1:25000:127.0.0.1/) counts as being on port 25000 rather than slipping past a text match.
  Refuses ($null) when: the header is missing (other language, error text, access denied), any URL line cannot be
  parsed, no queue or more than one queue registers a URL on that port, any URL on that port is not plain http with
  a loopback host (localhost, 127.0.0.1, [::1]; for host:port:ip the ip must be loopback too) or has a path other than
  "/" (for example an extra /legacy/ prefix), or the queue does not list exactly one process.
#>
function Get-FleetHttpSysQueuePid {
    param([string]$Text, [int]$Port)
    if (-not $Text -or $Text -notmatch '(?m)^\s*Snapshot of HTTP service state \(Request Queue View\):\s*$') { return $null }
    $queues = New-Object System.Collections.Generic.List[object]
    $cur = $null
    foreach ($raw in ($Text -split "`r?`n")) {
        $line = $raw.TrimEnd()
        if ($line -match '^Request queue name:') { $cur = @{ Pids = New-Object System.Collections.Generic.List[int]; Urls = New-Object System.Collections.Generic.List[object]; Attached = -1; Bad = $false }; $queues.Add($cur); continue }
        if (-not $cur) { continue }
        if ($line -match '^\s+Number of active processes attached:\s*(\d+)\s*$') { $cur.Attached = [int]$Matches[1]; continue }
        if ($line -match '^\s+ID:\s*(\d+),\s*image:') { $cur.Pids.Add([int]$Matches[1]); continue }
        if ($line -match '^\s+(HTTPS?://\S+)$') {
            $u = ConvertFrom-FleetHttpSysUrl $Matches[1]
            if ($u) { $cur.Urls.Add($u) } else { $cur.Bad = $true }
        }
    }
    # A URL line we cannot parse could be on this port, so it makes the whole answer uncertain.
    if (@($queues | Where-Object { $_.Bad }).Count -gt 0) { return $null }
    $onPort = @($queues | Where-Object { @($_.Urls | Where-Object { $_.Port -eq $Port }).Count -gt 0 })
    if ($onPort.Count -ne 1) { return $null }
    $q = $onPort[0]
    foreach ($u in @($q.Urls | Where-Object { $_.Port -eq $Port })) {
        if ($u.Scheme -ne 'http' -or -not $u.Loopback -or $u.Path -ne '/') { return $null }
    }
    $pids = @($q.Pids | Sort-Object -Unique)
    if ($pids.Count -ne 1) { return $null }
    if ($q.Attached -ne -1 -and $q.Attached -ne 1) { return $null }
    return [int]$pids[0]
}

# Graceful first (shutdown endpoint). If the port is still held after GraceMs, Stop-Process is used only when ALL hold:
#   - the self-reported path is absolute and normalized,
#   - the self-reported pid is not this process,
#   - that pid IS the tool (Test-FleetProcessIdentity: exact -File script or ExecutablePath match),
#   - that pid owns the listening port (Get-NetTCPConnection), OR the port is owned only by PID 4 (http.sys) and
#     the netsh request queue serving that port only on loopback belongs to exactly that pid (Get-FleetHttpSysQueuePid),
#   - and, for http.sys, /__fleethacker/id on the port still reports the same tool and pid just before the kill.
# Otherwise it refuses with a warning and returns $false. For an http.sys port whose proof fails it THROWS (nothing is
# killed): "An older <Tool> v<X> is still running; close its window and relaunch." The script blocks are for tests.
function Stop-FleetInstance {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Instance,
        [int]$GraceMs = 5000,
        [switch]$NoForce,
        [scriptblock]$GetProcessInfo = { param($i) Get-FleetProcessInfo -ProcessId $i },
        [scriptblock]$GetPortOwner = { param($p) Get-FleetPortOwner -Port $p },
        [scriptblock]$KillProcess = { param($i) Stop-Process -Id $i -Force -ErrorAction SilentlyContinue },
        [scriptblock]$GetHttpSysQueues = { Get-FleetHttpSysRequestQueueText },
        [scriptblock]$GetSelf = { param($p, $t) Test-FleetSelf -Port $p -Tool $t }
    )
    [void](Invoke-FleetLocalRequest -Port $Instance.Port -Path $script:ShutdownPath -Method 'POST' -Headers @{ 'X-FleetHacker-Shutdown' = '1' })
    if (Wait-FleetPortFree -Port $Instance.Port -TimeoutMs $GraceMs) { return $true }
    if ($NoForce) { return $false }
    $procId = [int]$Instance.Pid
    $tag = "$($Instance.Tool) pid $procId on port $($Instance.Port)"
    if ($procId -le 4 -or $procId -eq $PID) { Write-Warning "Not stopping ${tag}: invalid pid."; return $false }
    $path = ConvertTo-FleetAbsolutePath $Instance.Path
    if (-not $path) { Write-Warning "Not stopping ${tag}: reported path '$($Instance.Path)' is not an absolute path."; return $false }
    $info = & $GetProcessInfo $procId
    if (-not $info) { Write-Warning "Not stopping ${tag}: process not found."; return $false }
    if (-not (Test-FleetProcessIdentity -Path $path -CommandLine $info.CommandLine -ExecutablePath $info.ExecutablePath)) {
        Write-Warning "Not stopping ${tag}: it is not '$path' (no exact -File or executable match)."; return $false
    }
    $owners = @(& $GetPortOwner $Instance.Port)
    if ($owners.Count -eq 1 -and $owners[0] -eq 4) {
        # http.sys holds the port for the HttpListener process. Kill only with the request-queue proof.
        $closeMsg = "An older $($Instance.Tool) v$($Instance.Version) is still running; close its window and relaunch."
        $queuePid = Get-FleetHttpSysQueuePid -Text ([string](& $GetHttpSysQueues)) -Port $Instance.Port
        if ($null -eq $queuePid) { throw "$closeMsg (pid $procId on port $($Instance.Port) ignored the shutdown request; its http.sys request queue could not be identified with certainty from 'netsh http show servicestate view=requestq', so nothing was stopped.)" }
        if ($queuePid -ne $procId) { throw "$closeMsg (pid $procId on port $($Instance.Port) ignored the shutdown request; netsh shows the request queue for port $($Instance.Port) held by pid $queuePid, so nothing was stopped.)" }
        $again = & $GetSelf $Instance.Port $Instance.Tool
        if (-not $again -or -not $again.IsSelf -or [int]$again.Pid -ne $procId) { throw "$closeMsg (pid $procId on port $($Instance.Port): /__fleethacker/id no longer reports that tool and pid, so nothing was stopped.)" }
        & $KillProcess $procId
        return (Wait-FleetPortFree -Port $Instance.Port -TimeoutMs 3000)
    }
    if ($owners -notcontains $procId) {
        Write-Warning "Not stopping ${tag}: the port is held by pid(s) '$($owners -join ', ')', not $procId."; return $false
    }
    & $KillProcess $procId
    return (Wait-FleetPortFree -Port $Instance.Port -TimeoutMs 3000)
}

function Start-FleetHttpListener {
    param([int]$Port)
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://localhost:$Port/")
    try { $l.Start(); return $l } catch { $l.Close(); return $null }
}

<#
.SYNOPSIS
    Walks the tool's block and applies its policy. Returns @{ Action = 'Start'|'Reuse'; Port; Url; Listener; Existing; Note }. Log Note when it is set.
    Action 'Start': Listener is a started HttpListener on http://localhost:<Port>/ (or $null with -NoListener; bind it yourself).
    Action 'Reuse': open Url in the browser and exit.
#>
function Resolve-FleetPort {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Tool,
        [Parameter(Mandatory = $true)][string]$Version,
        [int]$Start = 0,
        [int]$Size = 0,
        [ValidateSet('', 'reuse', 'restart', 'multi', 'exclusive')][string]$Policy = '',
        [string]$RegistryPath = (Join-Path $PSScriptRoot 'FleetPorts.psd1'),
        [int]$ProbeTimeoutMs = 1500,
        [int]$GraceMs = 5000,
        [switch]$NoListener,
        [scriptblock]$StopInstance = { param($i, $g) Stop-FleetInstance -Instance $i -GraceMs $g }
    )
    if ($Start -gt 0 -and $Size -gt 0 -and $Policy) {
        $block = New-Object PSObject -Property @{ Tool = $Tool; Start = $Start; End = $Start + $Size - 1; Size = $Size; Policy = $Policy }
    } else {
        $block = Get-FleetPortBlock -Tool $Tool -RegistryPath $RegistryPath
        if ($Start -gt 0) { $block.Start = $Start; $block.End = $Start + $block.Size - 1 }
        if ($Size -gt 0) { $block.Size = $Size; $block.End = $block.Start + $Size - 1 }
        if ($Policy) { $block.Policy = $Policy }
    }
    $notes = New-Object System.Collections.Generic.List[string]
    for ($p = $block.Start; $p -le $block.End; $p++) {
        if (Test-FleetPortFree -Port $p) {
            $r = Get-FleetStartResult -Port $p -NoListener:$NoListener
            if ($r) { return $r }
        }
        $id = Test-FleetSelf -Port $p -Tool $Tool -TimeoutMs $ProbeTimeoutMs
        if (-not $id) { $notes.Add("${p}: in use by another program"); continue }
        if (-not $id.IsSelf) { $notes.Add("${p}: in use by FleetHacker tool '$($id.Tool)'"); continue }
        $same = ($id.Version -eq $Version)
        $stop = $false
        if ($block.Policy -ne 'multi' -and -not $same -and (Compare-FleetVersion $id.Version $Version) -gt 0) {
            # Never downgrade: a newer copy is already running, so this launcher is stale.
            $note = "Stale launcher: $Tool $Version was started, but newer $Tool $($id.Version) is already running on port $p (pid $($id.Pid)); reusing it."
            Write-Warning $note
            return (New-FleetReuse $p $id $note)
        }
        switch ($block.Policy) {
            'multi'     { $notes.Add("${p}: another $Tool instance (multi)"); continue }
            'reuse'     { if ($same) { return (New-FleetReuse $p $id) } else { $stop = $true } }
            'exclusive' {
                if ($same) { return (New-FleetReuse $p $id) }
                throw "$Tool $($id.Version) is already running on port $p (pid $($id.Pid)). It holds a lease, so it is not stopped automatically. Close it, then start $Tool $Version."
            }
            'restart'   { $stop = $true }
        }
        if ($stop) {
            if (& $StopInstance $id $GraceMs) {
                $r = Get-FleetStartResult -Port $p -NoListener:$NoListener
                if ($r) { return $r }
            }
            $notes.Add("${p}: $Tool $($id.Version) (pid $($id.Pid)) did not stop")
        }
    }
    throw ("Port block $($block.Start)-$($block.End) for $Tool is full: " + ($notes -join '; ') + '. Close one of these programs, or change the block in PORTS.md.')
}

function New-FleetReuse {
    param([int]$Port, $Existing, [string]$Note = '')
    New-Object PSObject -Property ([ordered]@{ Action = 'Reuse'; Port = $Port; Url = "http://localhost:$Port/"; Listener = $null; Existing = $Existing; Note = $Note })
}

function Get-FleetStartResult {
    param([int]$Port, [switch]$NoListener)
    $l = $null
    if (-not $NoListener) { $l = Start-FleetHttpListener -Port $Port; if (-not $l) { return $null } }
    New-Object PSObject -Property ([ordered]@{ Action = 'Start'; Port = $Port; Url = "http://localhost:$Port/"; Listener = $l; Existing = $null; Note = '' })
}

<#
.SYNOPSIS
    Drop-in for an HttpListener loop. Returns 'id', 'shutdown' or 'denied' when it answered the request
    (the response is already closed), else $null (not a /__fleethacker/ path; handle it yourself).
    On 'shutdown' the caller stops its listener and exits.
.EXAMPLE
    $ctx = $listener.GetContext()
    $h = Invoke-FleetIdEndpoint -Context $ctx -Tool 'lasso' -Version $version -Path $PSCommandPath
    if ($h -eq 'shutdown') { $listener.Stop(); break }
    if ($h) { continue }
#>
function Invoke-FleetIdEndpoint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][string]$Tool,
        [Parameter(Mandatory = $true)][string]$Version,
        [string]$Path = ''
    )
    $req = $Context.Request
    $local = $req.Url.AbsolutePath
    if ($local -ne $script:IdPath -and $local -ne $script:ShutdownPath) { return $null }
    $res = $Context.Response
    $origin = $req.Headers['Origin']
    $port = $req.Url.Port
    $hostOk = @("localhost:$port", "127.0.0.1:$port", "[::1]:$port") -contains [string]$req.Headers['Host']
    $originOk = (-not $origin) -or (@("http://localhost:$port", "http://127.0.0.1:$port", "http://[::1]:$port") -contains [string]$origin)
    # Loopback caller, loopback Host (blocks DNS rebinding), and Origin absent or same-origin (blocks other web pages).
    $ok = [System.Net.IPAddress]::IsLoopback($req.RemoteEndPoint.Address) -and $hostOk -and $originOk
    $status = 404; $body = ''; $handled = $null
    if (-not $ok) { $status = 403 }
    elseif ($local -eq $script:IdPath -and $req.HttpMethod -eq 'GET') {
        $status = 200; $handled = 'id'
        $body = (New-Object PSObject -Property ([ordered]@{ tool = $Tool; version = $Version; pid = $PID; path = $Path })) | ConvertTo-Json -Compress
    }
    elseif ($local -eq $script:ShutdownPath -and $req.HttpMethod -eq 'POST' -and $req.Headers['X-FleetHacker-Shutdown'] -eq '1') {
        $status = 202; $handled = 'shutdown'; $body = '{"stopping":true}'
    }
    else { $status = 405 }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $res.StatusCode = $status
    $res.ContentType = 'application/json; charset=utf-8'
    $res.Headers['Cache-Control'] = 'no-store'
    $res.ContentLength64 = $bytes.Length
    if ($bytes.Length -gt 0) { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
    $res.Close()
    if (-not $handled) { return 'denied' }
    return $handled
}

Export-ModuleMember -Function Get-FleetPortBlock, Test-FleetPortFree, Test-FleetSelf, Stop-FleetInstance, Resolve-FleetPort, Invoke-FleetIdEndpoint
