#requires -Version 5.1
# =============================================================================
# Copied unchanged from Lazarette 5.1.0, tools/Lazarette.Client.ps1 at commit 7a5fda8 (Lazarette main
# e167907, 2026-11-06). Do not edit this copy: copy the file again from Lazarette when it changes.
# Semaphore uses it through server/Vault.ps1 only (docs/VAULT.md).
# Lazarette tool client (docs/TOOLS.md). Copy this one file into a tool (Semaphore, Halyard,
# Eight Bells, Gangplank, a scheduled script) and dot-source it. It talks to the running Lazarette
# over loopback; it never loads the vault engine and never sees the vault key.
#
#   . .\Lazarette.Client.ps1
#   Register-LazaretteToolPairing -Tool Semaphore -Code 'lztl1....'     # once; code from Lazarette Settings -> Tools
#   $s = Get-LazaretteToolSecrets -Tool Semaphore -Names SMDATS_PASSWORD, GITLAB_TOKEN -Purpose 'weekly metrics'
#   $s.SMDATS_PASSWORD                                                    # the value, or $null when not shared
#
# The pairing code is kept DPAPI-protected (CurrentUser) under %LOCALAPPDATA%\Lazarette\tools\, so
# only this Windows account on this computer can use it. Each request is a one-time HMAC proof; the
# answer comes back sealed under a key only this pairing can derive, and is checked before use.
# Windows PowerShell 5.1, .NET Framework and OS components only. ASCII only.
# =============================================================================

$script:LzClient = @{
    Version = 'lazarette-tool/1'
    Path = '/peer/tools/v1/secrets'
    Label = 'lazarette-tools-v1'
    SealDomain = 'LZTL-v1'
    TimeoutMs = 5000
}

function Get-LzClientPort {
    if ($env:LAZARETTE_PORT -match '^\d{2,5}$') { return [int]$env:LAZARETTE_PORT }
    return 8765
}

function Get-LzClientStorePath {
    param([Parameter(Mandatory)][string]$Tool)
    if ($Tool -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._\-]{0,39}$') { throw "Tool name '$Tool' is not valid (letters, digits, space . _ -, up to 40)." }
    $base = $env:LOCALAPPDATA; if (-not $base) { $base = [IO.Path]::GetTempPath() }
    return (Join-Path (Join-Path $base 'Lazarette\tools') ($Tool + '.pairing'))
}

function Get-LzClientEntropy { param([string]$Tool) return ,([Text.Encoding]::UTF8.GetBytes('lazarette-tool-pairing|' + $Tool.ToLowerInvariant())) }

function ConvertTo-LzClientB64Url { param([byte[]]$Bytes) return ([Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')) }
function ConvertFrom-LzClientB64Url {
    param([string]$Text)
    $t = $Text.Replace('-', '+').Replace('_', '/')
    switch ($t.Length % 4) { 2 { $t += '==' } 3 { $t += '=' } 1 { throw 'bad base64url' } }
    return ,[Convert]::FromBase64String($t)
}

function Get-LzClientHmac { param([byte[]]$Key, [byte[]]$Data) $h = New-Object System.Security.Cryptography.HMACSHA256 (, $Key); try { return ,$h.ComputeHash($Data) } finally { $h.Dispose() } }

function Get-LzClientHkdf {
    # HKDF-SHA256, zero salt, 32 bytes: the engine's Get-LazaretteHkdf.
    param([byte[]]$Ikm, [string]$Label)
    $prk = Get-LzClientHmac -Key (New-Object byte[] 32) -Data $Ikm
    try {
        $info = [Text.Encoding]::UTF8.GetBytes($Label)
        $in = New-Object byte[] ($info.Length + 1); [Array]::Copy($info, $in, $info.Length); $in[$in.Length - 1] = 1
        return ,(Get-LzClientHmac -Key $prk -Data $in)
    } finally { [Array]::Clear($prk, 0, $prk.Length) }
}

function Test-LzClientBytesEqual {
    param([byte[]]$A, [byte[]]$B)
    if ($null -eq $A -or $null -eq $B) { return $false }
    $d = $A.Length -bxor $B.Length; $n = [Math]::Min($A.Length, $B.Length)
    for ($i = 0; $i -lt $n; $i++) { $d = $d -bor ($A[$i] -bxor $B[$i]) }
    return ($d -eq 0)
}

function Open-LzClientSeal {
    # AES-256-CBC + HMAC-SHA256 (encrypt-then-MAC) as in the engine's Unprotect-LazaretteAead.
    # The tag is checked in constant time before decrypting; any mismatch throws.
    param([byte[]]$Secret, [string]$ToolId, [string]$Nonce, [byte[]]$Blob)
    $C = $script:LzClient
    if ($Blob.Length -lt 64) { throw 'Lazarette answer is too short.' }
    $key = Get-LzClientHkdf -Ikm $Secret -Label ($C.Label + ' response|' + $Nonce)
    $enc = Get-LzClientHkdf -Ikm $key -Label ($C.SealDomain + '-enc')
    $mac = Get-LzClientHkdf -Ikm $key -Label ($C.SealDomain + '-mac')
    try {
        $aad = [Text.Encoding]::UTF8.GetBytes(($C.Label, $ToolId, $Nonce) -join '|')
        $ctLen = $Blob.Length - 48
        $buf = New-Object byte[] (8 + $aad.Length + 16 + $ctLen)
        $len = [BitConverter]::GetBytes([uint64]$aad.Length); if (-not [BitConverter]::IsLittleEndian) { [Array]::Reverse($len) }
        [Array]::Copy($len, 0, $buf, 0, 8)
        [Array]::Copy($aad, 0, $buf, 8, $aad.Length)
        [Array]::Copy($Blob, 0, $buf, 8 + $aad.Length, 16 + $ctLen)
        $tag = New-Object byte[] 32; [Array]::Copy($Blob, 16 + $ctLen, $tag, 0, 32)
        if (-not (Test-LzClientBytesEqual (Get-LzClientHmac -Key $mac -Data $buf) $tag)) { throw 'The answer did not come from Lazarette for this pairing (seal check failed).' }
        $iv = New-Object byte[] 16; [Array]::Copy($Blob, 0, $iv, 0, 16)
        $aes = [System.Security.Cryptography.Aes]::Create()
        try {
            $aes.Mode = 'CBC'; $aes.Padding = 'PKCS7'; $aes.Key = $enc; $aes.IV = $iv
            $d = $aes.CreateDecryptor(); try { return ,$d.TransformFinalBlock($Blob, 16, $ctLen) } finally { $d.Dispose() }
        } finally { $aes.Dispose() }
    } finally { foreach ($k in @($key, $enc, $mac)) { [Array]::Clear($k, 0, $k.Length) } }
}

function Get-LzClientPairing {
    param([Parameter(Mandatory)][string]$Tool)
    $p = Get-LzClientStorePath $Tool
    if (-not (Test-Path -LiteralPath $p)) { throw "No Lazarette pairing for '$Tool'. Pair it in Lazarette (Settings -> Tools) and run Register-LazaretteToolPairing." }
    Add-Type -AssemblyName System.Security
    $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($p), (Get-LzClientEntropy $Tool), 'CurrentUser')
    try { $code = [Text.Encoding]::ASCII.GetString($plain) } finally { [Array]::Clear($plain, 0, $plain.Length) }
    return (ConvertFrom-LzClientCode $code)
}

function ConvertFrom-LzClientCode {
    param([string]$Code)
    if ($Code -notmatch '^lztl1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$') { throw 'That is not a Lazarette tool pairing code (lztl1.<id>.<secret>).' }
    return @{ Id = $Matches[1]; Secret = (ConvertFrom-LzClientB64Url $Matches[2]) }
}

function Register-LazaretteToolPairing {
    <# Stores the pairing code shown once in Lazarette, DPAPI-protected for this Windows account. #>
    param([Parameter(Mandatory)][string]$Tool, [Parameter(Mandatory)][string]$Code)
    [void](ConvertFrom-LzClientCode $Code.Trim())
    Add-Type -AssemblyName System.Security
    $p = Get-LzClientStorePath $Tool
    [void][IO.Directory]::CreateDirectory((Split-Path $p -Parent))
    $plain = [Text.Encoding]::ASCII.GetBytes($Code.Trim())
    try { [IO.File]::WriteAllBytes($p, [Security.Cryptography.ProtectedData]::Protect($plain, (Get-LzClientEntropy $Tool), 'CurrentUser')) }
    finally { [Array]::Clear($plain, 0, $plain.Length) }
    return $p
}

function Unregister-LazaretteToolPairing {
    param([Parameter(Mandatory)][string]$Tool)
    $p = Get-LzClientStorePath $Tool
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force; return $true }
    return $false
}

function Test-LazaretteToolPairing { param([Parameter(Mandatory)][string]$Tool) return (Test-Path -LiteralPath (Get-LzClientStorePath $Tool)) }

function Invoke-LzClientPost {
    # Plain HTTP/1.1 over a loopback socket: no proxy, no Origin header, nothing a browser could send.
    param([int]$Port, [string]$Path, [string]$Json)
    $body = [Text.Encoding]::UTF8.GetBytes($Json)
    $head = [Text.Encoding]::ASCII.GetBytes(("POST {0} HTTP/1.1`r`nHost: 127.0.0.1:{1}`r`nX-Fleet-Peer: {2}`r`nContent-Type: application/json`r`nContent-Length: {3}`r`nConnection: close`r`n`r`n" -f $Path, $Port, $script:LzClient.Version, $body.Length))
    $tcp = New-Object Net.Sockets.TcpClient
    try {
        $ar = $tcp.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne($script:LzClient.TimeoutMs) -or -not $tcp.Connected) { throw "Lazarette is not running (nothing on 127.0.0.1:$Port). Start Lazarette and unlock it." }
        $tcp.EndConnect($ar)
        $s = $tcp.GetStream(); $s.ReadTimeout = $script:LzClient.TimeoutMs
        $s.Write($head, 0, $head.Length); $s.Write($body, 0, $body.Length); $s.Flush()
        $ms = New-Object IO.MemoryStream; $buf = New-Object byte[] 8192
        while (($n = $s.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n); if ($ms.Length -gt 4MB) { throw 'Answer too large.' } }
        $text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
    } catch [Net.Sockets.SocketException] {
        throw "Lazarette is not running (nothing on 127.0.0.1:$Port). Start Lazarette and unlock it."
    } finally { $tcp.Close() }
    $split = $text.IndexOf("`r`n`r`n")
    if ($split -lt 0 -or $text -notmatch '^HTTP/1\.[01] (\d{3})') { throw 'Lazarette sent a malformed answer.' }
    $status = [int]$Matches[1]
    $json = $null; try { $json = $text.Substring($split + 4) | ConvertFrom-Json -ErrorAction Stop } catch { $json = $null }
    return @{ Status = $status; Json = $json }
}

function Get-LazaretteToolSecrets {
    <#
      Reads the named secrets this tool was given in Lazarette. Returns a hashtable name -> value
      (string, or SecureString with -AsSecureString); a name not shared, missing or sensitive maps to
      $null and its reason is in the hidden key '__state' (name -> state). Throws when Lazarette is not
      running, is locked, or the pairing is wrong, with a sentence a user can act on.
    #>
    param(
        [Parameter(Mandatory)][string]$Tool,
        [Parameter(Mandatory)][string[]]$Names,
        [ValidateLength(0, 120)][string]$Purpose = '',
        [int]$Port = (Get-LzClientPort),
        [switch]$AsSecureString,
        [switch]$Strict      # throw when any name has no value
    )
    $C = $script:LzClient
    $pair = Get-LzClientPairing $Tool
    try {
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        $nb = New-Object byte[] 24; try { $rng.GetBytes($nb) } finally { $rng.Dispose() }
        $nonce = ConvertTo-LzClientB64Url $nb
        $time = [string][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        $msg = ($C.Label, 'POST', $C.Path, $pair.Id, $time, $nonce, ($Names -join ','), $Purpose) -join "`n"
        $proof = ConvertTo-LzClientB64Url (Get-LzClientHmac -Key $pair.Secret -Data ([Text.Encoding]::UTF8.GetBytes($msg)))
        $req = [ordered]@{ tool = $pair.Id; nonce = $nonce; time = [long]$time; names = @($Names); purpose = $Purpose; proof = $proof } | ConvertTo-Json -Compress -Depth 4
        $r = Invoke-LzClientPost -Port $Port -Path $C.Path -Json $req
        if ($r.Status -ne 200) {
            $why = if ($r.Json -and $r.Json.message) { [string]$r.Json.message } else { "HTTP $($r.Status)" }
            $code = if ($r.Json -and $r.Json.error) { [string]$r.Json.error } else { 'error' }
            throw ("Lazarette refused the request ({0}): {1}" -f $code, $why)
        }
        if ([string]$r.Json.nonce -ne $nonce -or [string]$r.Json.tool -ne $pair.Id) { throw 'Lazarette answered a different request.' }
        $plain = Open-LzClientSeal -Secret $pair.Secret -ToolId $pair.Id -Nonce $nonce -Blob ([Convert]::FromBase64String([string]$r.Json.sealed))
        try { $payload = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json } finally { [Array]::Clear($plain, 0, $plain.Length) }
        if ($payload.format -ne 'lazarette-tool-secrets/1') { throw 'Lazarette answered in an unknown format.' }
        $out = @{}; $states = @{}
        foreach ($n in $Names) {
            $e = $payload.secrets.PSObject.Properties[$n]
            $state = if ($e) { [string]$e.Value.state } else { 'missing' }
            $states[$n] = $state
            if ($state -eq 'ok') {
                $v = [string]$e.Value.value
                if ($AsSecureString) { $ss = New-Object Security.SecureString; foreach ($ch in $v.ToCharArray()) { $ss.AppendChar($ch) }; $ss.MakeReadOnly(); $out[$n] = $ss } else { $out[$n] = $v }
            } else { $out[$n] = $null }
        }
        $payload = $null
        if ($Strict) {
            $bad = @($Names | Where-Object { $states[$_] -ne 'ok' })
            if ($bad.Count) { throw ("Lazarette has no value for {0} ({1}). Share it with {2} in Lazarette (Settings -> Tools)." -f ($bad -join ', '), (($bad | ForEach-Object { $states[$_] }) -join ', '), $Tool) }
        }
        $out['__state'] = $states
        return $out
    } finally { [Array]::Clear($pair.Secret, 0, $pair.Secret.Length) }
}

function Get-LazaretteToolSecret {
    <# One secret by name; throws when it is not shared (use Get-LazaretteToolSecrets for several). #>
    param([Parameter(Mandatory)][string]$Tool, [Parameter(Mandatory)][string]$Name, [string]$Purpose = '', [int]$Port = (Get-LzClientPort), [switch]$AsSecureString)
    $r = Get-LazaretteToolSecrets -Tool $Tool -Names @($Name) -Purpose $Purpose -Port $Port -AsSecureString:$AsSecureString -Strict
    return $r[$Name]
}
