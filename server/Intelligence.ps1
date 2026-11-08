#requires -Version 5.1
# =============================================================================
# Semaphore intelligence: drafts go through Fairlead, the Fleet's model router, on loopback.
# (TechStack "Intelligence router"; docs/INTELLIGENCE_PROVIDERS.md.)
#
#   GET  /api/ai                        { configured, url, model, privacyLocal, keySource }  (never the key)
#   POST /api/ai/check                  asks Fairlead for its models -> { ok, detail, models }
#   POST /api/ai/v1/chat/completions    OpenAI-style request passed to Fairlead; its JSON answer returned
#
# The browser's OpenAICompatibleProvider talks to /api/ai/v1 with the session token; this server adds
# the Fairlead client key. The key comes from SEMAPHORE_AI_KEY (process environment or
# config\semaphore.env, for CI and test machines), Windows Credential Manager, or a legacy DPAPI file.
# New setup writes only to the app-prefixed Windows credential. It never reaches the browser, the
# log, the runtime file or an error message.
#
# Port authority (Test-SemAiIdentity): the key is sent only after the address answers /__fleethacker/id as
# "fairlead" with the PID of the process that really listens on the port (GetExtendedTcpTable, compiled with
# Add-Type) AND a "path" that is exactly that process's executable or its -File script (Win32_Process); with
# settings.json "fairleadPath" set, the path must also be that one. When the port check cannot be compiled,
# the key is never sent and /api/ai says why.
# What this is and is not: it keeps the key from an honest program that happens to hold port 8776 while
# Fairlead is down (another Fleet tool, a dev server, a Semaphore started on the wrong port), and from a
# Fairlead run from an unexpected folder when the path is pinned. It is not authentication: any program
# running as this Windows account can name its own PID and path, and the same account can read the key
# from Credential Manager directly. Hostile code in the user's own session is outside what a loopback
# check can decide; the controls there are the workstation's application-control policy and the key's
# scope (a Fairlead client key is revocable in Fairlead > Clients and useless outside Fairlead).
# Semaphore only ever calls a loopback address: Fairlead decides where a prompt goes. By default the
# request asks for Fairlead's "local" route and sends X-Fairlead-Privacy: local, so prompts stay on
# this machine. SEMAPHORE_AI_MODEL picks another route (auto, smart, fast); SEMAPHORE_AI_PRIVACY=off
# drops the privacy header. Prompts carry briefs and catalog labels only, never data rows (core rule).
# The two POST routes run on the worker pool (Query.ps1), so a slow model never blocks heartbeats.
# =============================================================================

$script:SemAiDefaultUrl = 'http://127.0.0.1:8776/v1'
$script:SemAiMaxRequest = 262144       # 256 KB: a draft request is a brief plus catalog labels
$script:SemAiMaxResponse = 2000000     # same cap as MAX_RESPONSE_CHARS in src/core/intelligence/remote.ts
$script:SemAiTimeoutSec = 180          # local models can be slow; the browser waits a little longer
. (Join-Path $PSScriptRoot 'AiCredential.ps1')

function Get-SemAiKeyPath {
    $base = $env:LOCALAPPDATA
    if (-not $base) { $base = [Environment]::GetFolderPath('LocalApplicationData') }
    return [IO.Path]::Combine($base, 'Semaphore', 'fairlead-key.dat')
}

function Test-SemAiKeyShape {
    # A Fairlead client key: "fl-" then letters, digits, '-' or '_'. Checked before storing or sending.
    param([string]$Key)
    return ($null -ne $Key -and $Key -cmatch '\Afl-[A-Za-z0-9_-]{8,256}\z')
}

function Read-SemAiKeyFile {
    # The key from the DPAPI file, or $null when there is none or it cannot be read by this account.
    param([string]$Path = (Get-SemAiKeyPath))
    if (-not [IO.File]::Exists($Path)) { return $null }
    $bstr = [IntPtr]::Zero
    try {
        $secure = ConvertTo-SecureString -String ([IO.File]::ReadAllText($Path).Trim()) -ErrorAction Stop
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } catch {
        return $null
    } finally {
        if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
}

function Save-SemAiKeyFile {
    # DPAPI (current user) protected, written atomically. Throws on a key that is not a Fairlead client key.
    param([Security.SecureString]$Key, [string]$Path = (Get-SemAiKeyPath))
    $bstr = [IntPtr]::Zero
    try {
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Key)
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        if (-not (Test-SemAiKeyShape $plain)) { throw 'That is not a Fairlead client key (they start with fl-). Create one in Fairlead > Clients.' }
    } finally {
        if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
    $dir = [IO.Path]::GetDirectoryName($Path)
    if (-not [IO.Directory]::Exists($dir)) { [void][IO.Directory]::CreateDirectory($dir) }
    $tmp = $Path + '.tmp'
    [IO.File]::WriteAllText($tmp, (ConvertFrom-SecureString -SecureString $Key), (New-Object Text.UTF8Encoding $false))
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($tmp, $Path, $null) } else { [IO.File]::Move($tmp, $Path) }
}

function Test-SemAiUrl {
    # $null when the URL is an http(s) address on this machine with no user info, else the reason.
    param([string]$Url)
    $u = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$u)) { return 'SEMAPHORE_AI_URL is not a valid URL.' }
    if ($u.Scheme -ne 'http' -and $u.Scheme -ne 'https') { return 'SEMAPHORE_AI_URL must be http or https.' }
    if ($u.UserInfo) { return 'SEMAPHORE_AI_URL may not contain a user name or password.' }
    if (-not $u.IsLoopback) { return 'SEMAPHORE_AI_URL must be on this machine (Fairlead on 127.0.0.1). Fairlead decides where prompts go.' }
    return $null
}

function Get-SemAiSettings {
    # Url, Model, PrivacyLocal, Key (or $null), KeySource: environment | credential-manager | file | none, Problem (or $null).
    param([string]$Root = (Get-SemRoot), [string]$KeyPath = (Get-SemAiKeyPath))
    $url = Get-SemEnvValue -Name 'SEMAPHORE_AI_URL' -Root $Root
    if (-not $url) { $url = $script:SemAiDefaultUrl }
    $url = $url.TrimEnd('/')
    $model = Get-SemEnvValue -Name 'SEMAPHORE_AI_MODEL' -Root $Root
    if (-not $model -or $model -cnotmatch '\A[A-Za-z0-9._:/-]{1,128}\z') { $model = 'local' }
    $privacy = Get-SemEnvValue -Name 'SEMAPHORE_AI_PRIVACY' -Root $Root
    $privacyLocal = -not ($privacy -and $privacy.Trim().ToLowerInvariant() -in @('off', '0', 'false', 'no'))
    $key = Get-SemEnvValue -Name 'SEMAPHORE_AI_KEY' -Root $Root
    $source = 'environment'
    # An explicit legacy path is a test/migration seam; never read a real user
    # credential when the caller supplies its own isolated key file.
    # A failed Credential Manager read (Add-Type refused, a Win32 error other than "not found") must
    # not hide the legacy key file: note it and fall through.
    $credProblem = $null
    if (-not $key -and -not $PSBoundParameters.ContainsKey('KeyPath')) {
        $source = 'credential-manager'
        try { $key = Read-SemAiCredential }
        catch { $key = $null; $credProblem = 'Could not read the Fairlead key from Windows Credential Manager: ' + $_.Exception.Message; Write-SemLog 'WARN' $credProblem }
    }
    if (-not $key) { $key = Read-SemAiKeyFile -Path $KeyPath; $source = 'file' }
    if (-not $key) { $source = 'none' }
    $problem = Test-SemAiUrl $url
    if (-not $problem -and -not $key -and $credProblem) { $problem = $credProblem }
    if (-not $problem -and $key -and -not (Test-SemAiKeyShape $key)) { $problem = 'The stored Fairlead key is not in the fl-... format. Run Set-SemaphoreAiKey.bat again.' }
    # settings.json "fairleadPath": the one Start-Fairlead.ps1 (or executable) path the key may go to; '' accepts any.
    $expected = ''
    try { $expected = [string](Read-SemSettings -Root $Root).fairleadPath } catch { $expected = '' }
    return @{ Url = $url; Model = $model; PrivacyLocal = $privacyLocal; Key = $key; KeySource = $source; Problem = $problem; ExpectedPath = $expected }
}

function Get-SemAiStatus {
    # What the browser may know: never the key. With a key stored, a port check that cannot run
    # (Add-Type refused) is the problem: the key would never be sent.
    param($Settings = (Get-SemAiSettings))
    $problem = $Settings.Problem
    if (-not $problem -and $Settings.Key) { $problem = Initialize-SemAiPortCheck }
    return [ordered]@{
        configured   = [bool]($Settings.Key -and -not $problem)
        provider     = 'fairlead'
        url          = $Settings.Url
        model        = $Settings.Model
        privacyLocal = [bool]$Settings.PrivacyLocal
        keySource    = $Settings.KeySource
        expectedPath = [string]$Settings.ExpectedPath
        problem      = $problem
        setup        = 'Open Fairlead > Clients and install a key for Semaphore (or run Set-SemaphoreAiKey.bat as a fallback). Until then, local rules draft every flag.'
    }
}

function Get-SemAiSafeText {
    # Provider text for a message: the key removed, control characters dropped, at most 300 characters.
    param([string]$Text, [string]$Key)
    if (-not $Text) { return '' }
    if ($Key) { $Text = $Text.Replace($Key, '[key]') }
    $Text = [regex]::Replace($Text, '[\x00-\x1F\x7F]+', ' ').Trim()
    if ($Text.Length -gt 300) { $Text = $Text.Substring(0, 300) + '...' }
    return $Text
}

function Invoke-SemAiForward {
    <#
      Calls Fairlead. Returns @{ Status; Bytes; Target } for any HTTP answer, or @{ Status = 0; Error }
      when Fairlead could not be reached or did not answer in time. Never throws with the key in it.
    #>
    param($Settings, [ValidateSet('GET', 'POST')][string]$Method, [string]$RelPath, [byte[]]$Body, [int]$TimeoutSec = $script:SemAiTimeoutSec)
    $req = [Net.HttpWebRequest]::Create($Settings.Url + $RelPath)
    $req.Method = $Method
    $req.Timeout = $TimeoutSec * 1000
    $req.ReadWriteTimeout = $TimeoutSec * 1000
    $req.Proxy = $null                    # loopback only: never through a corporate proxy
    $req.AllowAutoRedirect = $false
    $req.Accept = 'application/json'
    $req.UserAgent = 'Semaphore'
    $req.Headers.Add('Authorization', 'Bearer ' + $Settings.Key)
    $req.Headers.Add('X-Fairlead-Label', 'Semaphore')
    if ($Settings.PrivacyLocal) { $req.Headers.Add('X-Fairlead-Privacy', 'local') }
    $resp = $null
    try {
        if ($Method -eq 'POST') {
            $req.ContentType = 'application/json'
            $req.ContentLength = $Body.Length
            $out = $req.GetRequestStream()
            try { $out.Write($Body, 0, $Body.Length) } finally { $out.Dispose() }
        }
        try { $resp = $req.GetResponse() }
        catch [Net.WebException] {
            if ($null -eq $_.Exception.Response) { throw }
            $resp = $_.Exception.Response
        }
        $stream = $resp.GetResponseStream()
        $ms = New-Object IO.MemoryStream
        try {
            $buf = New-Object byte[] 65536
            while (($n = $stream.Read($buf, 0, $buf.Length)) -gt 0) {
                if ($ms.Length + $n -gt $script:SemAiMaxResponse) { return @{ Status = 0; Error = 'Fairlead sent an answer larger than Semaphore accepts.' } }
                $ms.Write($buf, 0, $n)
            }
        } finally { $stream.Dispose() }
        return @{ Status = [int]$resp.StatusCode; Bytes = $ms.ToArray(); Target = [string]$resp.Headers['X-Fairlead-Target']; Fallback = [string]$resp.Headers['X-Fairlead-Fallback'] }
    } catch [Net.WebException] {
        $s = $_.Exception.Status
        if ($s -eq [Net.WebExceptionStatus]::Timeout) { return @{ Status = 0; Code = 'ai-timeout'; Error = "Fairlead did not answer within $TimeoutSec s." } }
        if ($s -eq [Net.WebExceptionStatus]::ConnectFailure -or (Test-SemConnectRefused $_.Exception)) { return @{ Status = 0; Code = 'ai-down'; Error = ('Fairlead is not running at ' + $Settings.Url + '. Start it with Launch-Fairlead.bat.') } }
        return @{ Status = 0; Code = 'ai-unreachable'; Error = ('Fairlead could not be reached: ' + (Get-SemAiSafeText $_.Exception.Message $Settings.Key)) }
    } catch {
        return @{ Status = 0; Code = 'ai-unreachable'; Error = ('Fairlead could not be reached: ' + (Get-SemAiSafeText $_.Exception.Message $Settings.Key)) }
    } finally {
        if ($null -ne $resp) { try { $resp.Close() } catch { } }
    }
}

function Test-SemConnectRefused {
    # Nothing listening. PowerShell 5.1 says ConnectFailure; 7 (HttpClient underneath) only says so in an inner SocketException.
    param([Exception]$Exception)
    for ($e = $Exception; $null -ne $e; $e = $e.InnerException) {
        if ($e -is [Net.Sockets.SocketException] -and $e.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused) { return $true }
    }
    return $false
}

function Get-SemAiErrorText {
    # Fairlead's own error message ({ error: { message } } or { error: "..." }), made safe; '' when none.
    param([byte[]]$Bytes, [string]$Key)
    try {
        $j = ([Text.Encoding]::UTF8.GetString($Bytes)) | ConvertFrom-Json -ErrorAction Stop
        $e = Get-SemJsonProp $j 'error'
        if ($e -is [string]) { return (Get-SemAiSafeText $e $Key) }
        $m = Get-SemJsonProp $e 'message'
        if ($m -is [string]) { return (Get-SemAiSafeText $m $Key) }
    } catch { }
    return ''
}

# ---------------------------------------------------------------------------
# Port owner: which process listens on Fairlead's port (issue #65). iphlpapi.dll is an OS DLL, so
# P/Invoke into it from Add-Type source is allowed on the workstation (TechStack); the same approach
# as Lazarette's Initialize-LazarettePeerCheck. C# 5 only.
# ---------------------------------------------------------------------------
$script:SemAiPortOwnerSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SemaphorePortOwner {
    [DllImport("iphlpapi.dll", SetLastError = true)]
    static extern uint GetExtendedTcpTable(IntPtr pTcpTable, ref int dwOutBufLen, bool sort, int ipVersion, int tableClass, uint reserved);
    const int TcpTableOwnerPidListener = 3;
    const uint ErrorInsufficientBuffer = 122;
    static int Port(int raw) { return ((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF); }
    static bool Loopback(IntPtr row, int family) {
        if (family == 2) {
            byte first = Marshal.ReadByte(row, 4);
            return first == 127 || Marshal.ReadInt32(row, 4) == 0;
        }
        for (int i = 0; i < 15; i++) { if (Marshal.ReadByte(row, i) != 0) return false; }
        byte last = Marshal.ReadByte(row, 15);
        return last == 0 || last == 1;
    }
    static void Scan(int family, int rowSize, int portOffset, int pidOffset, int port, List<int> pids) {
        for (int attempt = 0; attempt < 4; attempt++) {
            int len = 0;
            GetExtendedTcpTable(IntPtr.Zero, ref len, false, family, TcpTableOwnerPidListener, 0);
            if (len <= 0) throw new InvalidOperationException("GetExtendedTcpTable gave no table size.");
            len += 4096;
            IntPtr buf = Marshal.AllocHGlobal(len);
            try {
                uint rc = GetExtendedTcpTable(buf, ref len, false, family, TcpTableOwnerPidListener, 0);
                if (rc == ErrorInsufficientBuffer) continue;
                if (rc != 0) throw new InvalidOperationException("GetExtendedTcpTable failed with error " + rc + ".");
                int n = Marshal.ReadInt32(buf);
                for (int i = 0; i < n; i++) {
                    IntPtr row = new IntPtr(buf.ToInt64() + 4 + (long)i * rowSize);
                    if (Port(Marshal.ReadInt32(row, portOffset)) != port) continue;
                    if (!Loopback(row, family)) continue;
                    int pid = Marshal.ReadInt32(row, pidOffset);
                    if (!pids.Contains(pid)) pids.Add(pid);
                }
                return;
            } finally { Marshal.FreeHGlobal(buf); }
        }
        throw new InvalidOperationException("The TCP table kept changing while it was read.");
    }
    // Distinct PIDs listening at this port on IPv4 loopback or the IPv4 wildcard, or IPv6 ::1 or the IPv6 wildcard.
    public static int[] GetListenerPids(int port) {
        List<int> pids = new List<int>();
        Scan(2, 24, 8, 20, port, pids);    // MIB_TCPROW_OWNER_PID: state, localAddr, localPort, remoteAddr, remotePort, owningPid
        Scan(23, 56, 20, 52, port, pids);  // MIB_TCP6ROW_OWNER_PID: localAddr[16], scope, localPort, remoteAddr[16], scope, remotePort, state, owningPid
        return pids.ToArray();
    }
}
'@

function Initialize-SemAiPortCheck {
    <#
      $null when Semaphore can tell which process listens on Fairlead's port, else the sentence that
      says why it cannot (and so never sends the key: fail closed). Compiled once per process; the
      outcome is kept in the AppDomain so the worker runspaces do not compile again.
    #>
    if ('SemaphorePortOwner' -as [type]) { return $null }
    $known = [AppDomain]::CurrentDomain.GetData('Semaphore.PortCheckProblem')
    if ($known) { return [string]$known }
    $problem = $null
    if (-not (Test-SemIsWindows)) {
        $problem = 'Semaphore can check which program holds Fairlead''s port only on Windows, so the Fairlead key is not sent.'
    } else {
        try { Add-Type -TypeDefinition $script:SemAiPortOwnerSource -Language CSharp -ErrorAction Stop }
        catch { $problem = 'Windows did not let Semaphore compile its port check (Add-Type was refused), so Semaphore cannot confirm that Fairlead holds its port and does not send the Fairlead key.' }
    }
    if ($problem) {
        [AppDomain]::CurrentDomain.SetData('Semaphore.PortCheckProblem', $problem)
        Write-SemLog 'WARN' ('AI port check unavailable: ' + $problem)
    }
    return $problem
}

function Get-SemAiListenerPids {
    # The distinct PIDs listening on this loopback port. Throws when the TCP table cannot be read.
    # Tests replace it with a stub (Mock).
    param([Parameter(Mandatory = $true)][int]$Port)
    return [SemaphorePortOwner]::GetListenerPids($Port)
}

function Get-SemAiProcessStamp {
    # "<pid>:<start time ticks>" so a cached answer dies with its process (a reused PID has another
    # start time); '' when the start time cannot be read (then nothing is cached).
    param([int]$ProcessId)
    try {
        $p = [Diagnostics.Process]::GetProcessById($ProcessId)
        try { return ('{0}:{1}' -f $ProcessId, $p.StartTime.ToUniversalTime().Ticks) } finally { $p.Dispose() }
    } catch { return '' }
}

function Clear-SemAiIdentityCache {
    [AppDomain]::CurrentDomain.SetData('Semaphore.FairleadProcess', $null)
}

function Get-SemAiProcessPaths {
    # The executable and the -File script of a process, from Win32_Process: @{ ExecutablePath; ScriptPath }, '' when
    # unknown (the process is gone, or belongs to another account). Tests replace it with a stub (Mock).
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    $p = $null
    try { $p = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop } catch { $p = $null }
    if (-not $p) { return @{ ExecutablePath = ''; ScriptPath = '' } }
    $file = ''
    $m = [regex]::Match([string]$p.CommandLine, '(?i)(?:^|\s)[-/](?:file|f)\s+(?:"([^"]+)"|(\S+))')
    if ($m.Success) { if ($m.Groups[1].Success) { $file = $m.Groups[1].Value } else { $file = $m.Groups[2].Value } }
    return @{ ExecutablePath = [string]$p.ExecutablePath; ScriptPath = $file }
}

function ConvertTo-SemAiNormalPath {
    # An absolute, normalized Windows path (drive or UNC) without quotes or a trailing separator, or '' when it is not one.
    param([string]$Path)
    if (-not $Path) { return '' }
    $p = $Path.Trim().Trim('"').Replace('/', '\')
    if ($p -notmatch '^(?:[A-Za-z]:\\|\\\\[^\\?.]+\\[^\\]+)') { return '' }
    try { return [IO.Path]::GetFullPath($p).TrimEnd('\') } catch { return '' }
}

function Test-SemAiProcessPath {
    # $true only when $Path (what the id answer reports) is exactly the process's executable or -File script,
    # compared as normalized absolute paths without case. Never a substring, never a bare name.
    param([int]$ProcessId, [string]$Path)
    $want = ConvertTo-SemAiNormalPath $Path
    if (-not $want) { return $false }
    $paths = Get-SemAiProcessPaths -ProcessId $ProcessId
    foreach ($candidate in @($paths.ExecutablePath, $paths.ScriptPath)) {
        $c = ConvertTo-SemAiNormalPath $candidate
        if ($c -and [string]::Equals($c, $want, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Test-SemAiIdentity {
    <#
      Port authority (edge-ops PORTS.md; the rule FleetPort.psm1 applies before it stops a process): before the key is sent,
        1. the port check must be available (Initialize-SemAiPortCheck), else nothing is sent;
        2. exactly one process may listen on the port on loopback (Get-SemAiListenerPids);
        3. the address must answer GET /__fleethacker/id as "fairlead" with that process's PID and a "path";
        4. that path must be exactly the process's executable or -File script (Test-SemAiProcessPath);
        5. with settings.json "fairleadPath" set, the path must be that one too.
      Ports can be taken by another program when Fairlead is down (8776 is Fairlead's own port, outside
      Semaphore's block 8800-8802), and the key must never go to it. A verified process is remembered
      by PID and start time, so the id request is made again only when the listener changes.
      Returns $null when it is Fairlead, else @{ Code; Error }. The id request carries no key.
      This tells honest programs apart; it is not authentication (see the file header).
    #>
    param($Settings, [int]$TimeoutSec = 3)
    $u = [Uri]$Settings.Url
    $notFairlead = 'Something other than Fairlead is answering on port ' + $u.Port + '; the key was not sent.'
    $checkProblem = Initialize-SemAiPortCheck
    if ($checkProblem) { return @{ Code = 'ai-port-check'; Error = $checkProblem } }
    try { $pids = @(Get-SemAiListenerPids -Port $u.Port) }
    catch { return @{ Code = 'ai-port-check'; Error = ('Semaphore could not read which program listens on port ' + $u.Port + ', so the Fairlead key was not sent.') } }
    if ($pids.Count -eq 0) { return @{ Code = 'ai-down'; Error = ('Fairlead is not running at ' + $Settings.Url + '. Start it with Launch-Fairlead.bat.') } }
    if ($pids.Count -gt 1) {
        Write-SemLog 'WARN' ('AI: {0} processes listen on port {1}' -f $pids.Count, $u.Port)
        return @{ Code = 'ai-not-fairlead'; Error = $notFairlead }
    }
    $owner = [int]$pids[0]
    $stamp = Get-SemAiProcessStamp -ProcessId $owner
    if ($stamp -and ([string][AppDomain]::CurrentDomain.GetData('Semaphore.FairleadProcess')) -ceq $stamp) { return $null }
    $idUrl = $u.GetLeftPart([UriPartial]::Authority) + '/__fleethacker/id'
    $req = [Net.HttpWebRequest]::Create($idUrl)
    $req.Method = 'GET'; $req.Timeout = $TimeoutSec * 1000; $req.ReadWriteTimeout = $TimeoutSec * 1000
    $req.Proxy = $null; $req.AllowAutoRedirect = $false; $req.Accept = 'application/json'; $req.UserAgent = 'Semaphore'
    $resp = $null
    try {
        $resp = $req.GetResponse()
        $reader = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
        try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
        if ($text.Length -gt 4096) { $text = '' }
        $id = $null
        try { $id = $text | ConvertFrom-Json -ErrorAction Stop } catch { }
        $tool = Get-SemJsonProp $id 'tool'
        if ($tool -cne 'fairlead') {
            $who = if ($tool -is [string] -and $tool -cmatch '\A[A-Za-z0-9._-]{1,40}\z') { '"' + $tool + '"' } else { 'something else' }
            return @{ Code = 'ai-not-fairlead'; Error = ('The program at ' + $u.Authority + ' is ' + $who + ', not Fairlead, so the Fairlead key was not sent. Start Fairlead (it must have port ' + $u.Port + ') and try again.') }
        }
        $idPid = 0
        if (-not [int]::TryParse([string](Get-SemJsonProp $id 'pid'), [ref]$idPid) -or $idPid -ne $owner) {
            Write-SemLog 'WARN' ('AI: the program on port {0} says it is Fairlead with PID {1}, but PID {2} holds the port' -f $u.Port, $idPid, $owner)
            return @{ Code = 'ai-not-fairlead'; Error = $notFairlead }
        }
        $reported = Get-SemJsonProp $id 'path'
        if ($reported -isnot [string] -or -not $reported) {
            Write-SemLog 'WARN' ('AI: the program on port {0} says it is Fairlead but reports no path' -f $u.Port)
            return @{ Code = 'ai-not-fairlead'; Error = ('The program on port ' + $u.Port + ' says it is Fairlead but does not say which script it runs, so the Fairlead key was not sent. Update Fairlead.') }
        }
        if (-not (Test-SemAiProcessPath -ProcessId $owner -Path $reported)) {
            Write-SemLog 'WARN' ('AI: the program on port {0} (PID {1}) reports a path that is not what that process runs' -f $u.Port, $owner)
            return @{ Code = 'ai-not-fairlead'; Error = $notFairlead }
        }
        $pin = ConvertTo-SemAiNormalPath ([string]$Settings.ExpectedPath)
        if ($pin -and -not [string]::Equals($pin, (ConvertTo-SemAiNormalPath $reported), [StringComparison]::OrdinalIgnoreCase)) {
            Write-SemLog 'WARN' ('AI: Fairlead on port {0} runs from another path than settings.json fairleadPath pins' -f $u.Port)
            return @{ Code = 'ai-not-fairlead'; Error = ('Fairlead on port ' + $u.Port + ' runs from another folder than the fairleadPath pinned in config\settings.json, so the Fairlead key was not sent.') }
        }
        if ($stamp) { [AppDomain]::CurrentDomain.SetData('Semaphore.FairleadProcess', $stamp) }
        return $null
    } catch [Net.WebException] {
        if ($_.Exception.Status -eq [Net.WebExceptionStatus]::ConnectFailure -or (Test-SemConnectRefused $_.Exception)) { return @{ Code = 'ai-down'; Error = ('Fairlead is not running at ' + $Settings.Url + '. Start it with Launch-Fairlead.bat.') } }
        if ($_.Exception.Status -eq [Net.WebExceptionStatus]::Timeout) { return @{ Code = 'ai-timeout'; Error = ('Nothing answered at ' + $u.Authority + ' within ' + $TimeoutSec + ' s.') } }
        return @{ Code = 'ai-not-fairlead'; Error = ('The program at ' + $u.Authority + ' did not identify itself as Fairlead, so the Fairlead key was not sent.') }
    } catch {
        return @{ Code = 'ai-not-fairlead'; Error = ('The program at ' + $u.Authority + ' did not identify itself as Fairlead, so the Fairlead key was not sent.') }
    } finally {
        if ($null -ne $resp) { try { $resp.Close() } catch { } }
    }
}

function Test-SemAiChatBody {
    # $null when the browser's request may be forwarded, else the reason. The model must be the
    # configured route, so a page cannot pick a different one.
    param($Req, $Settings)
    if ($Req.Body.Length -gt $script:SemAiMaxRequest) { return 'The drafting request is larger than 256 KB.' }
    $j = $Req.Json
    if ($j -isnot [Management.Automation.PSCustomObject]) { return 'The body must be a JSON object.' }
    $model = Get-SemJsonProp $j 'model'
    if ($model -cne $Settings.Model) { return ('The request must use the configured model "' + $Settings.Model + '".') }
    $messages = @(Get-SemJsonProp $j 'messages')
    if ($messages.Count -lt 1 -or $messages.Count -gt 20) { return 'The request must carry 1 to 20 messages.' }
    if ($null -ne (Get-SemJsonProp $j 'stream') -and (Get-SemJsonProp $j 'stream') -ne $false) { return 'Streaming is not supported.' }
    return $null
}

function Invoke-SemAiRequest {
    # Worker side of POST /api/ai/check and POST /api/ai/v1/chat/completions.
    param($Req, [string]$Root = (Get-SemRoot))
    $s = Get-SemAiSettings -Root $Root
    if ($s.Problem) { Send-SemError 400 'ai-config' $s.Problem; return }
    if (-not $s.Key) { Send-SemError 409 'ai-not-configured' 'No Fairlead client key is stored. Create one in Fairlead > Clients, then run Set-SemaphoreAiKey.bat.'; return }
    if ($Req.Path -ne '/api/ai/check' -and $Req.Path -ne '/api/ai/v1/chat/completions') { Send-SemError 404 'not-found' 'Unknown API route.'; return }
    if ($Req.Path -ne '/api/ai/check') {
        $why = Test-SemAiChatBody -Req $Req -Settings $s
        if ($why) { Send-SemError 400 'bad-request' $why; return }
    }
    $notFairlead = Test-SemAiIdentity -Settings $s
    if ($notFairlead) {
        Write-SemLog 'WARN' ('AI request not sent: ' + $notFairlead.Code)
        if ($Req.Path -eq '/api/ai/check') { Send-SemJson 200 ([ordered]@{ ok = $false; code = $notFairlead.Code; detail = $notFairlead.Error }); return }
        $status = 502; if ($notFairlead.Code -eq 'ai-down' -or $notFairlead.Code -eq 'ai-port-check') { $status = 503 } elseif ($notFairlead.Code -eq 'ai-timeout') { $status = 504 }
        Send-SemError $status $notFairlead.Code $notFairlead.Error; return
    }
    if ($Req.Path -eq '/api/ai/check') {
        $r = Invoke-SemAiForward -Settings $s -Method GET -RelPath '/models' -TimeoutSec 15
        if ($r.Status -eq 0) { Send-SemJson 200 ([ordered]@{ ok = $false; code = $r.Code; detail = $r.Error }); return }
        if ($r.Status -eq 401 -or $r.Status -eq 403) { Send-SemJson 200 ([ordered]@{ ok = $false; code = 'ai-key'; detail = 'Fairlead refused the client key. Create a new one in Fairlead > Clients and run Set-SemaphoreAiKey.bat.' }); return }
        if ($r.Status -ne 200) { Send-SemJson 200 ([ordered]@{ ok = $false; code = 'ai-error'; detail = ('Fairlead answered ' + $r.Status + '. ' + (Get-SemAiErrorText $r.Bytes $s.Key)).Trim() }); return }
        $models = @()
        try {
            $j = ([Text.Encoding]::UTF8.GetString($r.Bytes)) | ConvertFrom-Json -ErrorAction Stop
            $models = @(@(Get-SemJsonProp $j 'data') | ForEach-Object { [string](Get-SemJsonProp $_ 'id') } | Where-Object { $_ } | Select-Object -First 50)
        } catch { }
        Send-SemJson 200 ([ordered]@{ ok = $true; detail = ('Fairlead is reachable with this key; route "' + $s.Model + '" will draft.'); models = $models })
        Write-SemLog 'INFO' 'AI check: Fairlead reachable'
        return
    }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-SemAiForward -Settings $s -Method POST -RelPath '/chat/completions' -Body $Req.Body
    $secs = [Math]::Round($clock.Elapsed.TotalSeconds, 1)
    if ($r.Status -eq 0) {
        Write-SemLog 'WARN' ('AI draft failed after {0} s: {1}' -f $secs, $r.Code)
        $status = 502; if ($r.Code -eq 'ai-timeout') { $status = 504 } elseif ($r.Code -eq 'ai-down') { $status = 503 }
        Send-SemError $status $r.Code $r.Error; return
    }
    if ($r.Status -eq 401 -or $r.Status -eq 403) {
        Write-SemLog 'WARN' 'AI draft refused: Fairlead did not accept the client key'
        Send-SemError 502 'ai-key' 'Fairlead refused the client key. Create a new one in Fairlead > Clients and run Set-SemaphoreAiKey.bat.'; return
    }
    if ($r.Status -ne 200) {
        Write-SemLog 'WARN' ('AI draft: Fairlead answered {0} after {1} s' -f $r.Status, $secs)
        Send-SemError 502 'ai-error' (('Fairlead answered ' + $r.Status + '. ' + (Get-SemAiErrorText $r.Bytes $s.Key)).Trim()); return
    }
    $target = ''
    if ($r.Target -and $r.Target -cmatch '\A[A-Za-z0-9._:/@-]{1,200}\z') { $target = $r.Target }
    # Fairlead says when a local fallback answered instead of the model asked for ("local" or "discovered").
    $fallback = ''
    if ($r.Fallback -and $r.Fallback -cmatch '\A[a-z-]{1,20}\z') { $fallback = $r.Fallback }
    Write-SemLog 'INFO' ('AI draft answered in {0} s by {1}{2}' -f $secs, $(if ($target) { $target } else { 'Fairlead' }), $(if ($fallback) { ' (fallback: ' + $fallback + ', not ' + $s.Model + ')' } else { '' }))
    $extra = @(); if ($target) { $extra += 'X-Fairlead-Target: ' + $target }
    if ($fallback) { $extra += 'X-Fairlead-Fallback: ' + $fallback }
    Send-SemBytes -Status 200 -ContentType 'application/json; charset=utf-8' -Bytes $r.Bytes -ExtraHeaders $extra
}

# ---- Spoken answers (TalkForge) ---------------------------------------------------------------
# As in Lazarette (lib/server/Stark.ps1): the assistant's answer, a sentence at a time, goes to the
# TalkForge speech server on this computer and comes back as WAV audio. The browser never talks to
# TalkForge (TalkForge refuses browser requests anyway); only this server does, to the configured
# loopback address, with the token. The page may choose the voice and speed; it can never change the
# address, so the token only ever goes to the one place a person set up. Redirects are not followed,
# no proxy is used, and the text and the token are never logged.
#
# Address: SEMAPHORE_VOICE_URL (environment or config\semaphore.env), default http://127.0.0.1:25009.
# Token: SEMAPHORE_VOICE_TOKEN in the same places, else the Lazarette share TALKFORGE_TOKEN (Settings >
# Tools > Semaphore in Lazarette), read when needed and dropped straight after.

$script:SemVoiceDefaultUrl = 'http://127.0.0.1:25009'
$script:SemVoiceTokenShare = 'TALKFORGE_TOKEN'
$script:SemVoiceMaxChars = 4000
$script:SemVoiceMaxBytes = 32MB
$script:SemVoiceNamePattern = '\A[A-Za-z0-9._-]{1,80}\z'

function Test-SemVoiceUrl {
    # '' when the TalkForge address is acceptable, otherwise the reason. Loopback by address only: a host
    # name could resolve elsewhere. No path, query or credentials.
    param([AllowNull()][string]$Url)
    $u = ([string]$Url).Trim()
    if ($u -eq '') { return 'Set the TalkForge address, for example http://127.0.0.1:25009.' }
    if ($u -match '\Ahttp://(127\.0\.0\.1|\[::1\]):(\d{1,5})/?\z' -and [int]$Matches[2] -ge 1 -and [int]$Matches[2] -le 65535) { return '' }
    return 'The TalkForge address must be http://127.0.0.1:<port>, the address talkforge serve prints; TalkForge only runs on this computer.'
}

function Get-SemVoiceSettings {
    # Url, Problem (or ''), and where the token would come from: environment | lazarette.
    param([string]$Root = (Get-SemRoot))
    $url = Get-SemEnvValue -Name 'SEMAPHORE_VOICE_URL' -Root $Root
    if (-not $url) { $url = $script:SemVoiceDefaultUrl }
    $url = $url.Trim().TrimEnd('/')
    $tokenSource = 'lazarette'
    if (Get-SemEnvValue -Name 'SEMAPHORE_VOICE_TOKEN' -Root $Root) { $tokenSource = 'environment' }
    return @{ Url = $url; Problem = (Test-SemVoiceUrl $url); TokenSource = $tokenSource; TokenShare = $script:SemVoiceTokenShare }
}

function Get-SemVoiceStatus {
    # What the browser may know for Settings: the address and where the token comes from, never the token.
    param([string]$Root = (Get-SemRoot))
    $s = Get-SemVoiceSettings -Root $Root
    return [ordered]@{ url = $s.Url; problem = $s.Problem; tokenSource = $s.TokenSource; tokenShare = $s.TokenShare }
}

function Read-SemVoiceToken {
    # The token, or throws a sentence the person can act on. Worker side.
    param([string]$Root = (Get-SemRoot))
    $t = Get-SemEnvValue -Name 'SEMAPHORE_VOICE_TOKEN' -Root $Root
    if ($t) { return $t.Trim() }
    $got = $null
    try {
        try { $got = Get-LazaretteToolSecrets -Tool $script:SemVaultTool -Names @($script:SemVoiceTokenShare) -Purpose 'Semaphore spoken answers' }
        catch { throw (ConvertTo-SemVaultError -Message ([string]$_.Exception.Message)).Message }
        $v = $got[$script:SemVoiceTokenShare]
        if ($null -eq $v -or ([string]$v).Length -eq 0) {
            throw ('Share the TalkForge token with Semaphore: in Lazarette open Settings > Tools > Semaphore and share {0} (the token TalkForge was started with), or set SEMAPHORE_VOICE_TOKEN.' -f $script:SemVoiceTokenShare)
        }
        return [string]$v
    } finally { $got = $null }
}

function New-SemVoicePayload {
    param([string]$Text, [string]$Voice, [double]$Speed)
    $p = [ordered]@{ input = $Text; response_format = 'wav'; speed = [Math]::Round([Math]::Min(2.0, [Math]::Max(0.5, $Speed)), 2) }
    if (-not [string]::IsNullOrWhiteSpace($Voice)) { $p['voice'] = $Voice }
    return ($p | ConvertTo-Json -Compress)
}

function Read-SemVoiceSpeakBody {
    # Text, Voice, Speed from the page, or Error. The page chooses the voice and speed only.
    param($Json)
    $text = ([string](Get-SemJsonProp $Json 'text')).Trim()
    if ($text -eq '' -or $text.Length -gt $script:SemVoiceMaxChars) { return @{ Error = ('Send 1-{0} characters of text.' -f $script:SemVoiceMaxChars) } }
    $voice = ([string](Get-SemJsonProp $Json 'voice')).Trim()
    if ($voice -ne '' -and $voice -cnotmatch $script:SemVoiceNamePattern) { return @{ Error = 'The voice must be 1-80 letters, digits and . _ - (or empty for the TalkForge default).' } }
    $speed = 1.0
    $raw = Get-SemJsonProp $Json 'speed'
    if ($null -ne $raw) {
        try { $speed = [double]::Parse(([string]$raw), [Globalization.CultureInfo]::InvariantCulture) } catch { $speed = 1.0 }
        if ([double]::IsNaN($speed) -or [double]::IsInfinity($speed)) { $speed = 1.0 }
    }
    return @{ Text = $text; Voice = $voice; Speed = [Math]::Min(2.0, [Math]::Max(0.5, $speed)) }
}

function Invoke-SemVoiceSpeak {
    # Worker side of POST /api/voice/speak.
    param($Req, [string]$Root = (Get-SemRoot))
    $body = Read-SemVoiceSpeakBody -Json $Req.Json
    if ($body.ContainsKey('Error')) { Send-SemError 400 'input' $body.Error; return }
    $s = Get-SemVoiceSettings -Root $Root
    if ($s.Problem) { Send-SemError 400 'voice-config' $s.Problem; return }
    $endpoint = $s.Url + '/v1/audio/speech'
    $token = $null; $request = $null; $response = $null
    try {
        try { $token = Read-SemVoiceToken -Root $Root } catch { Send-SemError 424 'voice-token' ([string]$_.Exception.Message); return }
        $bytes = [Text.Encoding]::UTF8.GetBytes((New-SemVoicePayload -Text $body.Text -Voice $body.Voice -Speed $body.Speed))
        $request = [Net.HttpWebRequest]::Create($endpoint)
        $request.Method = 'POST'; $request.ContentType = 'application/json; charset=utf-8'; $request.Accept = 'audio/wav'
        $request.Headers[[Net.HttpRequestHeader]::Authorization] = 'Bearer ' + $token
        $request.Timeout = 60000; $request.ReadWriteTimeout = 60000; $request.KeepAlive = $false
        $request.AllowAutoRedirect = $false   # never carry the token to another address
        $request.Proxy = $null                 # loopback only, never through a proxy
        $request.ContentLength = $bytes.Length
        try {
            $up = $request.GetRequestStream()
            try { $up.Write($bytes, 0, $bytes.Length) } finally { $up.Close() }
            $response = $request.GetResponse()
        } catch {
            $ex = $_.Exception
            while ($null -ne $ex -and -not ($ex -is [Net.WebException])) { $ex = $ex.InnerException }
            if ($null -ne $ex -and $null -ne $ex.Response) { $response = $ex.Response }
            else { Send-SemError 503 'voice-offline' ('TalkForge is not running at {0}. Start it with talkforge serve, then try again.' -f $s.Url); return }
        }
        $status = [int]$response.StatusCode
        if ($status -ne 200) {
            Write-SemLog 'WARN' ('TalkForge speech failed (HTTP {0})' -f $status)
            if ($status -eq 401) { Send-SemError 502 'voice-token' 'TalkForge refused the token. Share the token TalkForge was started with.'; return }
            if ($status -eq 503) { Send-SemError 503 'voice-files' 'TalkForge is missing voice files. Run populate-assets in TalkForge, then try again.'; return }
            Send-SemError 502 'voice' ('TalkForge answered HTTP {0}.' -f $status); return
        }
        if ([string]$response.ContentType -notmatch '\Aaudio/') { Send-SemError 502 'voice' 'The TalkForge address answered, but not with audio. Check SEMAPHORE_VOICE_URL.'; return }
        $ms = New-Object IO.MemoryStream
        $src = $response.GetResponseStream()
        try {
            $buf = New-Object byte[] 65536
            while (($n = $src.Read($buf, 0, $buf.Length)) -gt 0) {
                $ms.Write($buf, 0, $n)
                if ($ms.Length -gt $script:SemVoiceMaxBytes) { Send-SemError 502 'voice' 'TalkForge sent more audio than expected.'; return }
            }
        } finally { $src.Dispose() }
        Send-SemBytes -Status 200 -ContentType 'audio/wav' -Bytes ($ms.ToArray())
    } catch {
        Write-SemLog 'WARN' ('TalkForge speech failed: ' + $_.Exception.GetType().Name)
        if (-not $script:Sem.Responded) { Send-SemError 502 'voice' 'Speech failed. Check that TalkForge is running and the token is shared.' }
    } finally {
        $token = $null
        if ($response) { try { $response.Close() } catch { } }
        if ($request) { try { $request.Abort() } catch { } }
    }
}
