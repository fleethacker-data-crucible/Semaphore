#requires -Version 5.1
# =============================================================================
# Semaphore local HTTP server: transport, security gate, static files, session, presence.
# Based on Lazarette's lib/server/Http.ps1 (TcpListener on 127.0.0.1, no HTTP.sys URL ACL).
#
#   * Bound to 127.0.0.1 only (Assert-SemLoopbackEndpoint). Connections are accepted into a pending
#     list and served when they send data, so an idle browser preconnect never stalls the loop.
#   * Headers must arrive within 5 s (32 KB cap); bodies are capped at 8 MB and must arrive within
#     30 s. Transfer-Encoding and duplicate Content-Length are rejected.
#   * Every request: loopback caller, Host 127.0.0.1:<port> or localhost:<port>, Origin (when
#     present) the same origin; otherwise 403.
#   * /api/*: header X-Semaphore-Session must equal the session token (constant-time compare),
#     else 401. /api/leaving alone takes the token in its JSON body (sendBeacon cannot set headers).
#     The token is never logged, never put in the runtime file and never read from a query string.
#   * /api/query and /api/profile run on a small runspace pool (Query.ps1), so a slow database never
#     blocks heartbeats, static files or other flags' queries.
#   * Presence (TechStack "Lifecycle rules"): stop 20 s after the last heartbeat, or 5 s after a
#     leaving signal with no new heartbeat; never while a query or save is running.
# =============================================================================

$script:SemCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
$script:SemMaxBody = 8388608          # 8 MB
$script:SemMaxHeader = 32768

if ($null -eq $script:Sem) {
    $script:Sem = @{
        Port = 0; Token = ''; Version = '0.0.0'; ScriptPath = ''; Root = ''; WebRoot = ''; Home = ''
        Stream = $null; Responded = $false; Deferred = $false
        StopRequested = $false; StopReason = ''; Stay = $false
        RuntimeFile = ''; StartedAt = (Get-Date); SyncBusy = $false
        Workers = $null; Pool = $null; WorkerContext = $null
        OnOpenBrowser = $null; OpenRequested = $false
        Presence = @{ AutoStop = $false; TimeoutSec = 20; GraceSec = 5; FirstSec = 120; Tabs = @{}; BusyEnd = [datetime]::MinValue; EverSeen = $false }
    }
}

# ---------------------------------------------------------------------------
# Tokens
# ---------------------------------------------------------------------------
function New-SemToken {
    $bytes = New-Object byte[] 32
    $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'))
}

function Test-SemStringsEqual {
    # Constant-time for equal lengths (the token length is public: 43 characters).
    param([string]$A, [string]$B)
    if ([string]::IsNullOrEmpty($A) -or [string]::IsNullOrEmpty($B)) { return $false }
    $x = [Text.Encoding]::UTF8.GetBytes($A); $y = [Text.Encoding]::UTF8.GetBytes($B)
    if ($x.Length -ne $y.Length) { return $false }
    $diff = 0
    for ($i = 0; $i -lt $x.Length; $i++) { $diff = $diff -bor ($x[$i] -bxor $y[$i]) }
    return ($diff -eq 0)
}

function Test-SemSessionToken {
    param([string]$Candidate)
    return (Test-SemStringsEqual $Candidate $script:Sem.Token)
}

# ---------------------------------------------------------------------------
# Gate
# ---------------------------------------------------------------------------
function Assert-SemLoopbackEndpoint {
    # The bind rule: only a loopback address, never a wildcard or a LAN address.
    param([Parameter(Mandatory = $true)][Net.IPAddress]$Address)
    if (-not [Net.IPAddress]::IsLoopback($Address)) { throw "Bind rule: Semaphore listens on loopback only, not $Address." }
}

function New-SemListener {
    # TcpListener on 127.0.0.1:<port>, started. Throws when the port is taken.
    param([Parameter(Mandatory = $true)][int]$Port, [string]$Address = '127.0.0.1')
    $ip = [Net.IPAddress]::Parse($Address)
    Assert-SemLoopbackEndpoint -Address $ip
    $l = New-Object Net.Sockets.TcpListener($ip, $Port)
    if (Test-SemIsWindows) { try { $l.ExclusiveAddressUse = $true } catch { } }
    $l.Start()
    Assert-SemLoopbackEndpoint -Address ([Net.IPEndPoint]$l.LocalEndpoint).Address
    return $l
}

function Test-SemRequestOrigin {
    # Loopback caller, a Host naming this port on 127.0.0.1 or localhost, and Origin absent or the same origin.
    param($RemoteAddress, $Headers, [int]$Port)
    if ($null -eq $RemoteAddress -or -not [Net.IPAddress]::IsLoopback([Net.IPAddress]$RemoteAddress)) { return $false }
    $h = ''
    if ($Headers.ContainsKey('Host')) { $h = [string]$Headers['Host'] }
    if (@("127.0.0.1:$Port", "localhost:$Port") -notcontains $h.ToLowerInvariant()) { return $false }
    if ($Headers.ContainsKey('Origin')) {
        $o = ([string]$Headers['Origin']).ToLowerInvariant()
        if (@("http://127.0.0.1:$Port", "http://localhost:$Port") -notcontains $o) { return $false }
    }
    return $true
}

# ---------------------------------------------------------------------------
# Responses
# ---------------------------------------------------------------------------
function Get-SemHttpReason {
    param([int]$Status)
    switch ($Status) {
        200 { 'OK' } 202 { 'Accepted' } 204 { 'No Content' } 400 { 'Bad Request' } 401 { 'Unauthorized' }
        403 { 'Forbidden' } 404 { 'Not Found' } 405 { 'Method Not Allowed' } 408 { 'Request Timeout' }
        409 { 'Conflict' } 413 { 'Payload Too Large' } 422 { 'Unprocessable Entity' } 500 { 'Internal Server Error' }
        501 { 'Not Implemented' } 502 { 'Bad Gateway' } 503 { 'Service Unavailable' } 504 { 'Gateway Timeout' }
        default { 'Error' }
    }
}

function Get-SemSecurityHeaders {
    param([bool]$NoStore = $true)
    $h = @(
        ('Content-Security-Policy: ' + $script:SemCsp),
        'X-Content-Type-Options: nosniff',
        'Referrer-Policy: no-referrer',
        'X-Frame-Options: DENY',
        'Cross-Origin-Resource-Policy: same-origin'
    )
    if ($NoStore) { $h += 'Cache-Control: no-store' } else { $h += 'Cache-Control: no-cache' }
    return $h
}

function Send-SemBytes {
    param([int]$Status, [string]$ContentType, [byte[]]$Bytes, [bool]$NoStore = $true, [string[]]$ExtraHeaders = @(), [switch]$HeadOnly)
    $stream = $script:Sem.Stream
    if ($null -eq $stream) { return }
    if ($null -eq $Bytes) { $Bytes = New-Object byte[] 0 }
    $lines = @("HTTP/1.1 $Status $(Get-SemHttpReason $Status)")
    if ($ContentType) { $lines += "Content-Type: $ContentType" }
    $lines += "Content-Length: $($Bytes.Length)"
    $lines += 'Connection: close'
    $lines += (Get-SemSecurityHeaders -NoStore $NoStore)
    $lines += $ExtraHeaders
    $head = [Text.Encoding]::ASCII.GetBytes(($lines -join "`r`n") + "`r`n`r`n")
    $stream.Write($head, 0, $head.Length)
    if ($Bytes.Length -gt 0 -and -not $HeadOnly) { $stream.Write($Bytes, 0, $Bytes.Length) }
    $stream.Flush()
    $script:Sem.Responded = $true
}

function Send-SemJsonText {
    param([int]$Status, [string]$Json)
    Send-SemBytes -Status $Status -ContentType 'application/json; charset=utf-8' -Bytes ((New-Object Text.UTF8Encoding $false).GetBytes($Json))
}

function ConvertTo-SemJson {
    param($Object)
    $j = ConvertTo-Json -InputObject $Object -Depth 12 -Compress
    if ($null -eq $j) { return 'null' }
    return $j
}

function Send-SemJson {
    param([int]$Status, $Object)
    Send-SemJsonText -Status $Status -Json (ConvertTo-SemJson $Object)
}

function Send-SemError {
    # { error: "message", code: "..." }. Never a stack trace or a connection string.
    param([int]$Status, [string]$Code, [string]$Message)
    Send-SemJson -Status $Status -Object ([ordered]@{ error = $Message; code = $Code })
}

function Send-SemNoContent { Send-SemBytes -Status 204 -ContentType '' -Bytes (New-Object byte[] 0) }

# ---------------------------------------------------------------------------
# Request parsing
# ---------------------------------------------------------------------------
function Read-SemHttpRequest {
    # Reads one request from a connection that has data waiting. Returns the request, or $null after
    # replying with an error (or when the peer closed).
    param([Parameter(Mandatory = $true)][Net.Sockets.TcpClient]$Client)
    $Client.ReceiveTimeout = 5000
    $Client.SendTimeout = 10000
    $stream = $Client.GetStream()
    $script:Sem.Stream = $stream
    $buf = New-Object System.Collections.Generic.List[byte]
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    $headerEnd = -1
    while ($headerEnd -lt 0) {
        if ($buf.Count -gt $script:SemMaxHeader) { Send-SemError 413 'headers-too-large' 'Request headers too large.'; return $null }
        if ($deadline.ElapsedMilliseconds -gt 5000) { Send-SemError 408 'timeout' 'Request headers too slow.'; return $null }
        $b = $stream.ReadByte()
        if ($b -lt 0) { return $null }
        $buf.Add([byte]$b)
        $n = $buf.Count
        if ($n -ge 4 -and $buf[$n - 4] -eq 13 -and $buf[$n - 3] -eq 10 -and $buf[$n - 2] -eq 13 -and $buf[$n - 1] -eq 10) { $headerEnd = $n }
    }
    $remote = $null
    try { $remote = ([Net.IPEndPoint]$Client.Client.RemoteEndPoint).Address } catch { $remote = $null }
    $req = ConvertFrom-SemRequestHead -Text ([Text.Encoding]::ASCII.GetString($buf.ToArray(), 0, $headerEnd - 4)) -RemoteAddress $remote
    if ($req.ContainsKey('ErrorStatus')) { Send-SemError $req.ErrorStatus $req.ErrorCode $req.ErrorMessage; return $null }
    $len = $req.ContentLength
    $body = New-Object byte[] 0
    if ($len -gt 0) {
        $body = New-Object byte[] $len
        $read = 0
        while ($read -lt $len) {
            if ($deadline.ElapsedMilliseconds -gt 30000) { Send-SemError 408 'timeout' 'Request body too slow.'; return $null }
            $c = $stream.Read($body, $read, $len - $read)
            if ($c -le 0) { break }
            $read += $c
        }
        if ($read -ne $len) { Send-SemError 400 'bad-request' 'Incomplete request body.'; return $null }
    }
    $req.Body = $body
    $req.Client = $Client
    return $req
}

function ConvertFrom-SemRequestHead {
    # Parses the request line and headers (no body). Returns a request hashtable; on a malformed
    # request it carries ErrorStatus / ErrorCode / ErrorMessage instead.
    param([string]$Text, $RemoteAddress)
    $lines = $Text -split "`r`n"
    if ($lines.Count -lt 1 -or $lines[0] -notmatch '^([A-Z]{3,7}) (\S+) HTTP/1\.[01]$') { return @{ ErrorStatus = 400; ErrorCode = 'bad-request'; ErrorMessage = 'Malformed request line.' } }
    $method = $Matches[1]; $target = $Matches[2]
    $headers = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
    $contentLength = 0; $clCount = 0
    for ($i = 1; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($line -notmatch '^([^:\s]+):[ \t]*(.*)$') { return @{ ErrorStatus = 400; ErrorCode = 'bad-request'; ErrorMessage = 'Malformed header.' } }
        $name = $Matches[1]; $value = $Matches[2].Trim()
        if ($name -eq 'Content-Length') {
            $clCount++
            if ($value -notmatch '^\d{1,10}$') { return @{ ErrorStatus = 400; ErrorCode = 'bad-request'; ErrorMessage = 'Bad Content-Length.' } }
            $contentLength = [long]$value
        }
        if ($name -eq 'Transfer-Encoding') { return @{ ErrorStatus = 400; ErrorCode = 'bad-request'; ErrorMessage = 'Transfer-Encoding is not supported.' } }
        if ($headers.ContainsKey($name)) { $headers[$name] = $headers[$name] + ', ' + $value } else { $headers[$name] = $value }
    }
    if ($clCount -gt 1) { return @{ ErrorStatus = 400; ErrorCode = 'bad-request'; ErrorMessage = 'Duplicate Content-Length.' } }
    if ($contentLength -gt $script:SemMaxBody) { return @{ ErrorStatus = 413; ErrorCode = 'too-large'; ErrorMessage = 'Request body is larger than 8 MB.' } }
    $path = $target; $query = ''
    $qi = $target.IndexOf('?')
    if ($qi -ge 0) { $path = $target.Substring(0, $qi); $query = $target.Substring($qi + 1) }
    if ($path -cnotmatch '^/[A-Za-z0-9._~/@+-]*\z') { return @{ ErrorStatus = 400; ErrorCode = 'bad-path'; ErrorMessage = 'Bad request path.' } }
    return @{ Method = $method; Path = $path; Query = $query; Headers = $headers; ContentLength = [int]$contentLength; Body = (New-Object byte[] 0); Json = $null; RemoteAddress = $RemoteAddress; Client = $null }
}

# ---------------------------------------------------------------------------
# Static files: web\dist only
# ---------------------------------------------------------------------------
function Resolve-SemStaticFile {
    <#
      Maps a URL path to a file under WebRoot. Returns @{ Kind; File }:
        file      the file exists under WebRoot
        index     SPA fallback (no extension) or '/', and WebRoot\index.html exists
        notbuilt  '/' or a fallback, but WebRoot\index.html is missing
        missing   a path with an extension that does not exist
        refused   '..', '.' segments, dot files, backslashes or anything resolving outside WebRoot
    #>
    param([Parameter(Mandatory = $true)][string]$WebRoot, [Parameter(Mandatory = $true)][string]$Path)
    if ($Path.Contains('//')) { return @{ Kind = 'refused'; File = $null } }
    $rel = $Path.TrimStart('/')
    if ($rel.Contains('\') -or $rel.Contains(':')) { return @{ Kind = 'refused'; File = $null } }
    foreach ($seg in ($rel -split '/')) {
        if ($seg.StartsWith('.')) { return @{ Kind = 'refused'; File = $null } }
    }
    $rootFull = [IO.Path]::GetFullPath($WebRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $index = $rootFull + 'index.html'
    $cmp = [StringComparison]::Ordinal
    if (Test-SemIsWindows) { $cmp = [StringComparison]::OrdinalIgnoreCase }
    if ($rel -ne '' -and $rel -ne 'index.html') {
        $full = [IO.Path]::GetFullPath($rootFull + $rel.Replace('/', [string][IO.Path]::DirectorySeparatorChar))
        if (-not $full.StartsWith($rootFull, $cmp)) { return @{ Kind = 'refused'; File = $null } }
        if ([IO.File]::Exists($full)) { return @{ Kind = 'file'; File = $full } }
        $last = ($rel.TrimEnd('/') -split '/')[-1]
        if ($last.Contains('.')) { return @{ Kind = 'missing'; File = $null } }
    }
    if ([IO.File]::Exists($index)) { return @{ Kind = 'index'; File = $index } }
    return @{ Kind = 'notbuilt'; File = $null }
}

function Get-SemMimeType {
    param([string]$File)
    switch ([IO.Path]::GetExtension($File).ToLowerInvariant()) {
        '.html' { 'text/html; charset=utf-8' } '.js' { 'text/javascript; charset=utf-8' } '.mjs' { 'text/javascript; charset=utf-8' }
        '.css' { 'text/css; charset=utf-8' } '.json' { 'application/json; charset=utf-8' } '.map' { 'application/json; charset=utf-8' }
        '.svg' { 'image/svg+xml' } '.png' { 'image/png' } '.jpg' { 'image/jpeg' } '.jpeg' { 'image/jpeg' } '.gif' { 'image/gif' }
        '.webp' { 'image/webp' } '.ico' { 'image/x-icon' } '.woff2' { 'font/woff2' } '.woff' { 'font/woff' } '.ttf' { 'font/ttf' }
        '.wasm' { 'application/wasm' } '.txt' { 'text/plain; charset=utf-8' } '.webmanifest' { 'application/manifest+json' }
        default { 'application/octet-stream' }
    }
}

function Get-SemNotBuiltPage {
    $v = $script:Sem.Version
    return @"
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Semaphore</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#1b2430;background:#fff}code{background:#eef1f5;padding:0 .3em;border-radius:3px}</style>
</head><body>
<h1>Semaphore $v</h1>
<p>The local server is running, but the browser interface has not been built: <code>web\dist\index.html</code> is missing.</p>
<p>On a build machine, run <code>npm ci &amp;&amp; npm run build</code> in the Semaphore folder and copy <code>web\dist</code> here, or install Semaphore from a release zip.</p>
<p>Stop the server with <code>server\Stop-Semaphore.ps1</code>; it also stops by itself after a short while.</p>
</body></html>
"@
}

function Send-SemStatic {
    param($Req)
    $head = ($Req.Method -eq 'HEAD')
    $r = Resolve-SemStaticFile -WebRoot $script:Sem.WebRoot -Path $Req.Path
    switch ($r.Kind) {
        'refused' { Send-SemError 404 'not-found' 'Not found.'; return }
        'missing' { Send-SemError 404 'not-found' 'Not found.'; return }
        'notbuilt' {
            Send-SemBytes -Status 200 -ContentType 'text/html; charset=utf-8' -Bytes ((New-Object Text.UTF8Encoding $false).GetBytes((Get-SemNotBuiltPage))) -HeadOnly:$head
            return
        }
        default {
            $isHtml = $r.File.EndsWith('.html', [StringComparison]::OrdinalIgnoreCase)
            Send-SemBytes -Status 200 -ContentType (Get-SemMimeType $r.File) -Bytes ([IO.File]::ReadAllBytes($r.File)) -NoStore $isHtml -HeadOnly:$head
        }
    }
}

# ---------------------------------------------------------------------------
# Presence: the tab owns the server
# ---------------------------------------------------------------------------
function Initialize-SemPresence {
    param([bool]$AutoStop = $true, [int]$TimeoutSec = 20, [int]$GraceSec = 5, [int]$FirstSec = 120, [datetime]$Now = (Get-Date))
    $script:Sem.Presence = @{ AutoStop = $AutoStop; TimeoutSec = $TimeoutSec; GraceSec = $GraceSec; FirstSec = $FirstSec; Tabs = @{}; BusyEnd = [datetime]::MinValue; EverSeen = $false; Started = $Now }
}

function Register-SemPresence {
    # A heartbeat (Leaving = $false) or the leaving signal of one tab.
    param([string]$Tab = 'default', [bool]$Leaving = $false, [datetime]$Now = (Get-Date))
    $p = $script:Sem.Presence
    if (-not $p.Tabs.ContainsKey($Tab)) {
        foreach ($k in @($p.Tabs.Keys)) { if (($Now - $p.Tabs[$k].Seen).TotalSeconds -gt 600) { $p.Tabs.Remove($k) } }
        if ($p.Tabs.Count -ge 64) { return }
        if ($Leaving) { return }     # a leaving signal from a tab never seen changes nothing
        $p.Tabs[$Tab] = @{ Seen = $Now; Leaving = $null }
    }
    $t = $p.Tabs[$Tab]
    if ($Leaving) { $t.Leaving = $Now }
    else { $t.Seen = $Now; $t.Leaving = $null; $p.EverSeen = $true }
}

function Register-SemBusyEnd {
    # After a slow request on the main loop, heartbeats waited in the queue: silence before now does not count.
    param([datetime]$Now = (Get-Date))
    $script:Sem.Presence.BusyEnd = $Now
}

function Test-SemBusy {
    if ($script:Sem.SyncBusy) { return $true }
    if ($null -ne $script:Sem.Workers -and $script:Sem.Workers.Count -gt 0) { return $true }
    return $false
}

function Test-SemShouldAutoStop {
    <#
      True when auto-stop is on, nothing is running, and every tab that sent a heartbeat has either
      sent its leaving signal GraceSec ago (a reload sends a fresh heartbeat well inside that) or been
      silent for TimeoutSec. A server no tab ever reached stops FirstSec after it started.
    #>
    param([datetime]$Now = (Get-Date))
    $p = $script:Sem.Presence
    if (-not $p.AutoStop) { return $false }
    if (Test-SemBusy) { return $false }
    if (-not $p.EverSeen) {
        $since = $p.Started; if ($p.BusyEnd -gt $since) { $since = $p.BusyEnd }
        return (($Now - $since).TotalSeconds -ge $p.FirstSec)
    }
    foreach ($t in $p.Tabs.Values) {
        $since = $t.Seen; if ($p.BusyEnd -gt $since) { $since = $p.BusyEnd }
        if ($null -ne $t.Leaving) {
            $left = $t.Leaving; if ($p.BusyEnd -gt $left) { $left = $p.BusyEnd }
            if (($Now - $left).TotalSeconds -ge $p.GraceSec) { continue }
            if (($Now - $since).TotalSeconds -lt $p.TimeoutSec) { return $false }
            continue
        }
        if (($Now - $since).TotalSeconds -lt $p.TimeoutSec) { return $false }
    }
    return $true
}

function Get-SemLiveTabCount {
    param([datetime]$Now = (Get-Date))
    $p = $script:Sem.Presence
    $n = 0
    foreach ($t in $p.Tabs.Values) {
        if ($null -ne $t.Leaving) { continue }
        if (($Now - $t.Seen).TotalSeconds -lt $p.TimeoutSec) { $n++ }
    }
    return $n
}

function Request-SemStop {
    param([string]$Reason = 'quit')
    if (-not $script:Sem.StopReason) { $script:Sem.StopReason = $Reason }
    $script:Sem.StopRequested = $true
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
function Invoke-SemFleetEndpoint {
    # /__fleethacker/id, /__fleethacker/shutdown (PORTS.md) and /__semaphore/open (launcher hand-off:
    # the running server opens the browser on its own session link, so the token never leaves it).
    param($Req)
    if ($Req.Path -eq '/__fleethacker/id') {
        if ($Req.Method -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Send-SemJson 200 ([ordered]@{ tool = 'semaphore'; version = $script:Sem.Version; pid = $PID; path = $script:Sem.ScriptPath; tabs = [int](Get-SemLiveTabCount) })
        return
    }
    if ($Req.Path -eq '/__fleethacker/shutdown') {
        if ($Req.Method -ne 'POST' -or -not $Req.Headers.ContainsKey('X-FleetHacker-Shutdown') -or $Req.Headers['X-FleetHacker-Shutdown'] -ne '1') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Send-SemBytes -Status 202 -ContentType 'application/json; charset=utf-8' -Bytes ([Text.Encoding]::ASCII.GetBytes('{"stopping":true}'))
        Write-SemLog 'INFO' 'Shutdown requested through /__fleethacker/shutdown'
        Request-SemStop 'shutdown'
        return
    }
    if ($Req.Path -eq '/__semaphore/open') {
        if ($Req.Method -ne 'POST' -or $Req.Headers.ContainsKey('Origin') -or -not $Req.Headers.ContainsKey('X-Semaphore-Open') -or $Req.Headers['X-Semaphore-Open'] -ne '1') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Send-SemBytes -Status 202 -ContentType 'application/json; charset=utf-8' -Bytes ([Text.Encoding]::ASCII.GetBytes('{"opening":true}'))
        $script:Sem.OpenRequested = $true
        return
    }
    Send-SemError 404 'not-found' 'Not found.'
}

function Invoke-SemRequest {
    param($Req)
    $script:Sem.Responded = $false
    $script:Sem.Deferred = $false
    if (-not (Test-SemRequestOrigin -RemoteAddress $Req.RemoteAddress -Headers $Req.Headers -Port $script:Sem.Port)) {
        Write-SemLog 'WARN' ('Refused {0} {1}: not a local same-origin request' -f $Req.Method, $Req.Path)
        Send-SemError 403 'forbidden' 'Request refused: not a local same-origin request.'
        return
    }
    $path = $Req.Path
    if ($path.StartsWith('/__fleethacker/') -or $path.StartsWith('/__semaphore/')) { Invoke-SemFleetEndpoint -Req $Req; return }
    if ($path -eq '/api' -or $path.StartsWith('/api/')) {
        if ($Req.Body.Length -gt 0) {
            $text = (New-Object Text.UTF8Encoding $false).GetString($Req.Body)
            # Only a JSON object is a valid API body (ConvertFrom-Json would unroll a one-element array).
            if (-not $text.TrimStart().StartsWith('{')) { Send-SemError 400 'bad-json' 'Request body must be a JSON object.'; return }
            try { $Req.Json = $text | ConvertFrom-Json -ErrorAction Stop }
            catch { Send-SemError 400 'bad-json' 'Request body is not valid JSON.'; return }
        }
        if ($path -eq '/api/leaving') { Invoke-SemLeaving -Req $Req; return }
        $tok = ''
        if ($Req.Headers.ContainsKey('X-Semaphore-Session')) { $tok = [string]$Req.Headers['X-Semaphore-Session'] }
        if (-not (Test-SemSessionToken $tok)) { Send-SemError 401 'session' 'Missing or wrong session token. Relaunch Semaphore.'; return }
        Invoke-SemRoute -Req $Req
        return
    }
    if ($Req.Method -ne 'GET' -and $Req.Method -ne 'HEAD') { Send-SemError 405 'method' 'Method not allowed.'; return }
    Send-SemStatic -Req $Req
}

function Invoke-SemLeaving {
    # POST /api/leaving { token, tab }: the one route that takes the token in the JSON body
    # (navigator.sendBeacon cannot set headers). Never from the query string; never logged.
    param($Req)
    if ($Req.Method -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
    $j = $Req.Json
    $tok = ''; $tab = 'default'
    if ($j -is [Management.Automation.PSCustomObject]) {
        $v = $j.PSObject.Properties['token']; if ($null -ne $v -and $v.Value -is [string]) { $tok = $v.Value }
        $v = $j.PSObject.Properties['tab']; if ($null -ne $v -and $null -ne $v.Value) { $tab = [string]$v.Value }
    }
    if (-not (Test-SemSessionToken $tok)) { Send-SemError 401 'session' 'Missing or wrong session token.'; return }
    if ($tab -cnotmatch '\A[A-Za-z0-9_-]{1,64}\z') { Send-SemError 400 'bad-tab' 'Invalid tab id.'; return }
    Register-SemPresence -Tab $tab -Leaving $true
    Send-SemNoContent
}

# ---------------------------------------------------------------------------
# Runtime file: logs\semaphore-server-<pid>.json (never the session token)
# ---------------------------------------------------------------------------
function Write-SemRuntimeFile {
    param([Parameter(Mandatory = $true)][string]$Root)
    try {
        $dir = Join-Path $Root 'logs'
        if (-not (Test-Path -LiteralPath $dir)) { [void][IO.Directory]::CreateDirectory($dir) }
        $path = Join-Path $dir ('semaphore-server-{0}.json' -f $PID)
        $info = [ordered]@{
            tool = 'semaphore'; pid = $PID; port = $script:Sem.Port; url = ('http://127.0.0.1:{0}/' -f $script:Sem.Port)
            startedAt = (Get-Date).ToUniversalTime().ToString('o'); version = $script:Sem.Version; path = $script:Sem.ScriptPath
        }
        $tmp = $path + '.tmp'
        [IO.File]::WriteAllText($tmp, (ConvertTo-SemJson $info), (New-Object Text.UTF8Encoding $false))
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
        Move-Item -LiteralPath $tmp -Destination $path
        $script:Sem.RuntimeFile = $path
        return $path
    } catch {
        Write-SemLog 'WARN' ('Could not write the runtime file: ' + $_.Exception.Message)
        return ''
    }
}

function Remove-SemRuntimeFile {
    $f = $script:Sem.RuntimeFile
    if ($f) { try { Remove-Item -LiteralPath $f -Force -ErrorAction Stop } catch { } }
    $script:Sem.RuntimeFile = ''
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
function Start-SemHttpServer {
    param(
        [Parameter(Mandatory = $true)][Net.Sockets.TcpListener]$Listener,
        [Parameter(Mandatory = $true)][hashtable]$Settings,
        [bool]$AutoStop = $true,
        [scriptblock]$OnReady = $null,
        [scriptblock]$OnOpenBrowser = $null
    )
    $script:Sem.Port = ([Net.IPEndPoint]$Listener.LocalEndpoint).Port
    $script:Sem.StopRequested = $false
    $script:Sem.StopReason = ''
    $script:Sem.StartedAt = Get-Date
    Initialize-SemPresence -AutoStop $AutoStop -TimeoutSec $Settings.heartbeatTimeoutSec -GraceSec $Settings.leavingGraceSec -FirstSec $Settings.firstHeartbeatSec
    Initialize-SemWorkers -Size $Settings.queryWorkers
    $pending = New-Object System.Collections.Generic.List[object]
    $presenceClock = [Diagnostics.Stopwatch]::StartNew()
    $stopClock = $null
    try {
        [void](Write-SemRuntimeFile -Root $script:Sem.Root)
        if ($OnReady) { & $OnReady }
        while ($true) {
            if ($script:Sem.StopRequested) {
                # Let running queries finish (up to 15 s) before the pool is closed.
                if ($null -eq $stopClock) { $stopClock = [Diagnostics.Stopwatch]::StartNew() }
                Update-SemWorkers
                if ($script:Sem.Workers.Count -eq 0 -or $stopClock.ElapsedMilliseconds -gt 15000) { break }
                Start-Sleep -Milliseconds 50
                continue
            }
            while ($Listener.Pending() -and $pending.Count -lt 64) {
                $c = $Listener.AcceptTcpClient()
                $c.NoDelay = $true
                $pending.Add(@{ Client = $c; At = [Diagnostics.Stopwatch]::StartNew() })
            }
            $served = $false
            foreach ($item in @($pending.ToArray())) {
                $sock = $item.Client.Client
                $ready = $false; $gone = $false
                try {
                    if ($sock.Available -gt 0) { $ready = $true }
                    elseif ($sock.Poll(0, [Net.Sockets.SelectMode]::SelectRead)) { $gone = $true }   # readable with no data = closed
                } catch { $gone = $true }
                if (-not $ready -and -not $gone -and $item.At.ElapsedMilliseconds -gt 10000) { $gone = $true }   # idle preconnect
                if ($gone) { [void]$pending.Remove($item); try { $item.Client.Close() } catch { }; continue }
                if (-not $ready) { continue }
                [void]$pending.Remove($item)
                $served = $true
                Invoke-SemConnection -Client $item.Client
                if ($script:Sem.OpenRequested) {
                    $script:Sem.OpenRequested = $false
                    if ($OnOpenBrowser) { try { & $OnOpenBrowser } catch { Write-SemLog 'WARN' ('Could not open the browser: ' + $_.Exception.Message) } }
                }
                if ($script:Sem.StopRequested) { break }
            }
            Update-SemWorkers
            if (-not $served) { Start-Sleep -Milliseconds 20 }
            if ($presenceClock.ElapsedMilliseconds -ge 1000) {
                $presenceClock.Restart()
                if (Test-SemShouldAutoStop) {
                    Write-SemLog 'INFO' 'No Semaphore tab is open any more: stopping (Launch-Semaphore.bat --stay or SEMAPHORE_AUTO_STOP=0 keeps it running)'
                    Request-SemStop 'browser-gone'
                }
            }
        }
    } finally {
        foreach ($item in $pending) { try { $item.Client.Close() } catch { } }
        try { $Listener.Stop() } catch { }
        Close-SemWorkers
        Remove-SemRuntimeFile
        Write-SemLog 'INFO' ('Stopped ({0})' -f $script:Sem.StopReason)
    }
}

function Invoke-SemConnection {
    param([Net.Sockets.TcpClient]$Client)
    $took = [Diagnostics.Stopwatch]::StartNew()
    $req = $null
    $script:Sem.Deferred = $false
    try {
        $req = Read-SemHttpRequest -Client $Client
        if ($null -ne $req) {
            try { Invoke-SemRequest -Req $req }
            catch {
                Write-SemLog 'ERROR' ('{0} {1}: {2}' -f $req.Method, $req.Path, $_.Exception.Message)
                if (-not $script:Sem.Responded) { try { Send-SemError 500 'internal' 'Internal server error.' } catch { } }
            }
        }
    } catch {
        Write-SemLog 'WARN' ('Connection failed: ' + $_.Exception.GetType().Name)
    } finally {
        $script:Sem.SyncBusy = $false
        if (-not $script:Sem.Deferred) { try { $Client.Close() } catch { } }
        $script:Sem.Stream = $null
        if ($took.ElapsedMilliseconds -ge 500) { Register-SemBusyEnd }
    }
}
