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
# config\semaphore.env, for CI and test machines) or else from %LOCALAPPDATA%\Semaphore\fairlead-key.dat,
# DPAPI-protected for this Windows account by Set-SemaphoreAiKey.ps1. It never reaches the browser, the
# log, the runtime file or an error message.
#
# Port authority: the key is sent only after the address answers /__fleethacker/id as "fairlead"
# (Test-SemAiIdentity), the rule Lazarette uses, so a tool squatting on Fairlead's port never gets it.
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
    # Url, Model, PrivacyLocal, Key (or $null), KeySource: environment | file | none, Problem (or $null).
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
    if (-not $key) { $key = Read-SemAiKeyFile -Path $KeyPath; $source = 'file' }
    if (-not $key) { $source = 'none' }
    $problem = Test-SemAiUrl $url
    if (-not $problem -and $key -and -not (Test-SemAiKeyShape $key)) { $problem = 'The stored Fairlead key is not in the fl-... format. Run Set-SemaphoreAiKey.bat again.' }
    return @{ Url = $url; Model = $model; PrivacyLocal = $privacyLocal; Key = $key; KeySource = $source; Problem = $problem }
}

function Get-SemAiStatus {
    # What the browser may know: never the key.
    param($Settings = (Get-SemAiSettings))
    return [ordered]@{
        configured   = [bool]($Settings.Key -and -not $Settings.Problem)
        provider     = 'fairlead'
        url          = $Settings.Url
        model        = $Settings.Model
        privacyLocal = [bool]$Settings.PrivacyLocal
        keySource    = $Settings.KeySource
        problem      = $Settings.Problem
        setup        = 'Create a client key in Fairlead > Clients, then run Set-SemaphoreAiKey.bat. Until then, local rules draft every flag.'
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

function Test-SemAiIdentity {
    <#
      Port authority (edge-ops PORTS.md, the same rule Lazarette uses): before the key is sent, the
      address must answer GET /__fleethacker/id as "fairlead". Ports can be taken by another tool when
      Fairlead is down (Semaphore's own block reaches 8776), and the key must never go to it.
      Returns $null when it is Fairlead, else @{ Code; Error }. The id request carries no key.
    #>
    param($Settings, [int]$TimeoutSec = 3)
    $u = [Uri]$Settings.Url
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
        $tool = $null
        try { $tool = Get-SemJsonProp ($text | ConvertFrom-Json -ErrorAction Stop) 'tool' } catch { }
        if ($tool -ceq 'fairlead') { return $null }
        $who = if ($tool -is [string] -and $tool -cmatch '\A[A-Za-z0-9._-]{1,40}\z') { '"' + $tool + '"' } else { 'something else' }
        return @{ Code = 'ai-not-fairlead'; Error = ('The program at ' + $u.Authority + ' is ' + $who + ', not Fairlead, so the Fairlead key was not sent. Start Fairlead (it must have port ' + $u.Port + ') and try again.') }
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
        $status = 502; if ($notFairlead.Code -eq 'ai-down') { $status = 503 } elseif ($notFairlead.Code -eq 'ai-timeout') { $status = 504 }
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
