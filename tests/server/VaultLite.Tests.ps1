# Pester 5. The Lazarette Lite fallback (server/Vault.ps1, docs/VAULT.md): when Lazarette is not
# running, secret-only sources resolve from Lazarette Lite by variable name; a pairing, lock or
# rate-limit error never falls back, and Lazarette still wins when it answers. Two fakes: a Lite
# folder on disk (LazaretteLite.psd1 at the root, lib\Lazarette.ps1 defining Get-LazaretteSecret /
# Get-LiteItemNames from a values.json the tests refill, with a reads.log so the tests can prove
# Lite was never called) and the fake Lazarette on loopback copied from tests/server/Vault.Tests.ps1
# (same HMAC proof and sealed answer). No real Credential Manager, no real Lazarette.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Intelligence.ps1', 'Lake.ps1', 'Vault.ps1', 'Connectors.ps1', 'Commands.ps1') { . ([IO.Path]::Combine($server, $f)) }

    $script:SavedLocal = $env:LOCALAPPDATA
    $script:SavedPort = $env:LAZARETTE_PORT
    $script:SavedLite = $env:LAZARETTE_PATH
    $env:LOCALAPPDATA = Join-Path $TestDrive 'local'
    New-Item -ItemType Directory -Path $env:LOCALAPPDATA -Force | Out-Null

    $script:ToolId = [guid]::NewGuid().ToString()
    $script:Secret = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($script:Secret) } finally { $rng.Dispose() }
    $script:Code = 'lztl1.' + $script:ToolId + '.' + [Convert]::ToBase64String($script:Secret).TrimEnd('=').Replace('+', '-').Replace('/', '_')

    function script:New-Source([string]$Json) {
        $dir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir | Out-Null
        Set-Content -LiteralPath (Join-Path $dir 'sources.json') -Value $Json -Encoding UTF8
        return , @(Get-SemSources -HomeDir $dir)
    }
    function script:ConvertTo-Secure([string]$Text) {
        $ss = New-Object Security.SecureString
        foreach ($ch in $Text.ToCharArray()) { $ss.AppendChar($ch) }
        return $ss
    }
    function script:Set-Pairing { [void](Register-SemVaultPairing -Code (ConvertTo-Secure $script:Code)) }

    function script:Start-FakeLazarette {
        # POST /peer/tools/v1/secrets as Lazarette answers it. $S.Mode: ok | locked | not-paired | other-program | rate-limited | bad-seal.
        $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start()
        $state = [hashtable]::Synchronized(@{ Mode = 'ok'; ToolId = $script:ToolId; Secret = $script:Secret; Shares = @{}; Heads = (New-Object Collections.ArrayList); Requests = (New-Object Collections.ArrayList); Proofs = (New-Object Collections.ArrayList) })
        $ps = [powershell]::Create()
        [void]$ps.AddScript({
            param($L, $S)
            function Get-H([byte[]]$Key, [byte[]]$Data) { $h = New-Object Security.Cryptography.HMACSHA256 (, $Key); try { return , $h.ComputeHash($Data) } finally { $h.Dispose() } }
            function Get-K([byte[]]$Ikm, [string]$Label) {
                $prk = Get-H (New-Object byte[] 32) $Ikm
                $info = [Text.Encoding]::UTF8.GetBytes($Label)
                $in = New-Object byte[] ($info.Length + 1); [Array]::Copy($info, $in, $info.Length); $in[$in.Length - 1] = 1
                return , (Get-H $prk $in)
            }
            function Get-B([byte[]]$B) { return [Convert]::ToBase64String($B).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
            function Send-J($St, [int]$Code, $Obj) {
                $b = [Text.Encoding]::UTF8.GetBytes(($Obj | ConvertTo-Json -Compress -Depth 6))
                $h = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $Code X`r`nContent-Type: application/json`r`nContent-Length: $($b.Length)`r`nConnection: close`r`n`r`n")
                $St.Write($h, 0, $h.Length); $St.Write($b, 0, $b.Length); $St.Flush()
            }
            function Send-State($St, [int]$Code, [string]$Name, [string]$Message) { Send-J $St $Code ([ordered]@{ state = $Name; error = $Name; message = $Message }) }
            function Invoke-Answer($St, [string]$Head, $J) {
                if ($Head -notmatch '(?m)^X-Fleet-Peer: lazarette-tool/1\r?$') { Send-State $St 400 'peer-header' 'Send X-Fleet-Peer: lazarette-tool/1.'; return }
                if ($Head -match '(?mi)^Origin:') { Send-State $St 403 'origin' 'Browser requests are refused.'; return }
                if ($S.Mode -eq 'locked') { Send-State $St 423 'locked' 'Lazarette is locked. Unlock it in the browser.'; return }
                if ($S.Mode -eq 'rate-limited') { Send-State $St 429 'rate-limited' 'Too many failed requests. Try again in 60 seconds.'; return }
                $names = @($J.names | ForEach-Object { [string]$_ })
                $msg = ('lazarette-tools-v1', 'POST', '/peer/tools/v1/secrets', [string]$J.tool, [string]$J.time, [string]$J.nonce, ($names -join ','), [string]$J.purpose) -join "`n"
                $expect = Get-B (Get-H $S.Secret ([Text.Encoding]::UTF8.GetBytes($msg)))
                [void]$S.Proofs.Add(($expect -eq [string]$J.proof))
                if ($S.Mode -eq 'not-paired' -or [string]$J.tool -ne $S.ToolId -or $expect -ne [string]$J.proof) { Send-State $St 401 'not-paired' 'This tool is not paired with Lazarette (or was removed). Pair it again in Lazarette.'; return }
                if ($S.Mode -eq 'other-program') { Send-State $St 403 'peer-unverified' 'A different program is using this pairing. Pair the tool again from the program that should hold it.'; return }
                $secrets = [ordered]@{}
                foreach ($n in $names) {
                    if (-not $S.Shares.ContainsKey($n)) { $secrets[$n] = [ordered]@{ state = 'not-shared' } }
                    elseif ([string]::IsNullOrEmpty([string]$S.Shares[$n])) { $secrets[$n] = [ordered]@{ state = 'empty' } }
                    else { $secrets[$n] = [ordered]@{ state = 'ok'; value = [string]$S.Shares[$n] } }
                }
                $plain = [Text.Encoding]::UTF8.GetBytes(([ordered]@{ format = 'lazarette-tool-secrets/1'; tool = 'Semaphore'; secrets = $secrets } | ConvertTo-Json -Depth 5 -Compress))
                $nonce = [string]$J.nonce
                $key = Get-K $S.Secret ('lazarette-tools-v1 response|' + $nonce)
                $enc = Get-K $key 'LZTL-v1-enc'; $mac = Get-K $key 'LZTL-v1-mac'
                $iv = New-Object byte[] 16; $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($iv) } finally { $rng.Dispose() }
                $aes = [Security.Cryptography.Aes]::Create()
                try { $aes.Mode = 'CBC'; $aes.Padding = 'PKCS7'; $aes.Key = $enc; $aes.IV = $iv; $e = $aes.CreateEncryptor(); try { $ct = $e.TransformFinalBlock($plain, 0, $plain.Length) } finally { $e.Dispose() } } finally { $aes.Dispose() }
                $aad = [Text.Encoding]::UTF8.GetBytes(('lazarette-tools-v1', $S.ToolId, $nonce) -join '|')
                $buf = New-Object byte[] (8 + $aad.Length + 16 + $ct.Length)
                [Array]::Copy([BitConverter]::GetBytes([uint64]$aad.Length), 0, $buf, 0, 8)
                [Array]::Copy($aad, 0, $buf, 8, $aad.Length)
                [Array]::Copy($iv, 0, $buf, 8 + $aad.Length, 16)
                [Array]::Copy($ct, 0, $buf, 8 + $aad.Length + 16, $ct.Length)
                $tag = Get-H $mac $buf
                if ($S.Mode -eq 'bad-seal') { $tag[0] = $tag[0] -bxor 1 }
                $blob = New-Object byte[] (16 + $ct.Length + 32)
                [Array]::Copy($iv, 0, $blob, 0, 16); [Array]::Copy($ct, 0, $blob, 16, $ct.Length); [Array]::Copy($tag, 0, $blob, 16 + $ct.Length, 32)
                Send-J $St 200 ([ordered]@{ state = 'ok'; tool = $S.ToolId; nonce = $nonce; sealed = [Convert]::ToBase64String($blob) })
            }
            while ($true) {
                try { $c = $L.AcceptTcpClient() } catch { break }   # the listener was stopped
                try {
                    $st = $c.GetStream(); $st.ReadTimeout = 5000
                    $buf = New-Object byte[] 65536; $raw = ''
                    do { $n = $st.Read($buf, 0, $buf.Length); $raw += [Text.Encoding]::UTF8.GetString($buf, 0, $n) } while ($n -gt 0 -and $raw -notmatch "`r`n`r`n")
                    $head = $raw.Substring(0, $raw.IndexOf("`r`n`r`n")); $body = $raw.Substring($raw.IndexOf("`r`n`r`n") + 4)
                    if ($head -match 'Content-Length: (\d+)') { while ([Text.Encoding]::UTF8.GetByteCount($body) -lt [int]$Matches[1]) { $n = $st.Read($buf, 0, $buf.Length); if ($n -le 0) { break }; $body += [Text.Encoding]::UTF8.GetString($buf, 0, $n) } }
                    [void]$S.Heads.Add($head)
                    $j = $body | ConvertFrom-Json
                    [void]$S.Requests.Add(@{ Names = @($j.names | ForEach-Object { [string]$_ }); Purpose = [string]$j.purpose })
                    Invoke-Answer $st $head $j
                } catch { } finally { $c.Close() }
            }
        }).AddArgument($l).AddArgument($state)
        [void]$ps.BeginInvoke()
        return @{ L = $l; PS = $ps; State = $state; Port = ([Net.IPEndPoint]$l.LocalEndpoint).Port }
    }
    function script:Get-ClosedPort {
        $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start()
        $p = ([Net.IPEndPoint]$l.LocalEndpoint).Port; $l.Stop()
        return $p
    }

    # --- Fake Lite folder: LazaretteLite.psd1 at the root, the shim in lib\ --------
    # The shim is built from single-quoted lines (no nested here-string): it reads the
    # values from values.json on every call and logs each read to reads.log, so a test
    # can prove Lite was never called. $script:FakeLiteDir is captured when Vault.ps1
    # dot-sources the shim, the same way the real shim's $PSScriptRoot works.
    $script:LiteRoot = Join-Path $TestDrive 'Lite'
    New-Item -ItemType Directory -Path (Join-Path $script:LiteRoot 'lib') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $script:LiteRoot 'LazaretteLite.psd1') -Value '# marker: the real Lite folder has its module manifest here.' -Encoding ASCII
    $shimLines = @(
        '$script:FakeLiteDir = $PSScriptRoot',
        'function Get-LazaretteSecret {',
        '    param([Parameter(Mandatory)][Alias(''Name'')][string]$Service, [string]$User, [string]$Field)',
        '    $vals = Get-Content -LiteralPath (Join-Path $script:FakeLiteDir ''values.json'') -Raw | ConvertFrom-Json',
        '    if ($Field) { throw "Lazarette Lite item ''$Service'' has no field ''$Field''. Lite keeps one secret per item; custom fields are a Lazarette feature." }',
        '    [void](Add-Content -LiteralPath (Join-Path $script:FakeLiteDir ''reads.log'') -Value $Service)',
        '    $p = $vals.PSObject.Properties[$Service]',
        '    if ($null -eq $p -or [string]::IsNullOrEmpty([string]$p.Value)) { throw "Lazarette Lite has no item ''$Service''." }',
        '    return [string]$p.Value',
        '}',
        'function Get-LiteItemNames {',
        '    $vals = Get-Content -LiteralPath (Join-Path $script:FakeLiteDir ''values.json'') -Raw | ConvertFrom-Json',
        '    return @($vals.PSObject.Properties | ForEach-Object { [pscustomobject]@{ Service = $_.Name; User = $_.Name; Type = ''login''; Tags = @() } })',
        '}'
    )
    Set-Content -LiteralPath (Join-Path $script:LiteRoot 'lib\Lazarette.ps1') -Value ($shimLines -join "`n") -Encoding UTF8
    function script:Set-LiteValues([hashtable]$Values) {
        ($Values | ConvertTo-Json -Compress) | Set-Content -LiteralPath (Join-Path $script:LiteRoot 'lib\values.json') -Encoding UTF8
        Remove-Item -LiteralPath (Join-Path $script:LiteRoot 'lib\reads.log') -ErrorAction SilentlyContinue
    }
    function script:Get-LiteReads {
        $p = Join-Path $script:LiteRoot 'lib\reads.log'
        if (-not (Test-Path -LiteralPath $p)) { return @() }
        return @(Get-Content -LiteralPath $p)
    }

    $script:Fake = Start-FakeLazarette
    Set-Pairing
}
AfterAll {
    try { $script:Fake.L.Stop(); $script:Fake.PS.Dispose() } catch { }
    $env:LOCALAPPDATA = $script:SavedLocal
    if ($null -eq $script:SavedPort) { Remove-Item Env:\LAZARETTE_PORT -ErrorAction SilentlyContinue } else { $env:LAZARETTE_PORT = $script:SavedPort }
    if ($null -eq $script:SavedLite) { Remove-Item Env:\LAZARETTE_PATH -ErrorAction SilentlyContinue } else { $env:LAZARETTE_PATH = $script:SavedLite }
}

Describe 'Lite fallback when Lazarette is not running' {
    BeforeEach {
        $env:LAZARETTE_PORT = [string](Get-ClosedPort)
        $env:LAZARETTE_PATH = $script:LiteRoot
        Set-LiteValues @{ FOUNDRY_TOKEN = 'lite-fnd-token-0123456789'; SMDATS_PASSWORD = 'litePassw0rd'; SMDATS_USER = 'lite-svc-user'; AWS_ACCESS_KEY_ID = 'AKIALITEFAKEFAKE0001'; AWS_SECRET_ACCESS_KEY = 'liteSecretKey/with+chars0123456789abcdef'; AWS_SESSION_TOKEN = 'liteSessionToken-0123456789abcdefghij' }
        $script:Fake.State.Mode = 'ok'
        $script:Fake.State.Shares = @{}
    }
    AfterEach { Set-SemVaultRequest $null }

    It 'resolves a Foundry token from Lite' {
        $s = (New-Source '[{"id":"fnd","kind":"foundry","provider":"foundry","host":"https://acme.palantirfoundry.com","vault":{"token":"FOUNDRY_TOKEN"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.ContainsKey('Error') | Should -BeFalse
        $r.Values.token | Should -Be 'lite-fnd-token-0123456789'
        $r.Store | Should -Be 'lite'
    }
    It 'resolves an ODBC password and user from Lite' {
        $s = (New-Source '[{"id":"maint","provider":"odbc","connection":"DSN=x","vault":{"password":"SMDATS_PASSWORD","user":"SMDATS_USER"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Values.password | Should -Be 'litePassw0rd'
        $r.Values.user | Should -Be 'lite-svc-user'
        $r.Store | Should -Be 'lite'
    }
    It 'resolves Athena roles as separate Lite names, with no field involved' {
        $s = (New-Source '[{"id":"lake","kind":"aws-athena","provider":"athena","region":"us-gov-west-1","database":"maint","vault":{"accessKeyId":"AWS_ACCESS_KEY_ID","secretAccessKey":"AWS_SECRET_ACCESS_KEY","sessionToken":"AWS_SESSION_TOKEN"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Values.accessKeyId | Should -Be 'AKIALITEFAKEFAKE0001'
        $r.Values.secretAccessKey | Should -BeLike 'liteSecretKey*'
        $r.Values.sessionToken | Should -BeLike 'liteSessionToken*'
    }
    It 'leaves a note naming the share when the optional user is not in Lite' {
        Set-LiteValues @{ SMDATS_PASSWORD = 'litePassw0rd' }
        $s = (New-Source '[{"id":"maint","provider":"odbc","connection":"DSN=x","vault":{"password":"SMDATS_PASSWORD","user":"SMDATS_USER"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Values.password | Should -Be 'litePassw0rd'
        $r.Values.ContainsKey('user') | Should -BeFalse
        @($r.Notes).Count | Should -Be 1
        $r.Notes[0] | Should -BeLike '*SMDATS_USER*'
        $r.Notes[0] | Should -Not -BeLike '*litePassw0rd*'
    }
    It 'refuses with vault-not-shared naming Lite when a required name is not in Lite' {
        $s = (New-Source '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"password":"NOT_THERE"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Error.Status | Should -Be 424
        $r.Error.Code | Should -Be 'vault-not-shared'
        $r.Error.Message | Should -BeLike '*NOT_THERE*Lazarette Lite*'
    }
    It 'does nothing for a source with no vault block' {
        $s = (New-Source '[{"id":"a","provider":"odbc","connection":"DSN=x"}]')[0]
        (Resolve-SemVaultSecrets -Source $s).Values | Should -BeNullOrEmpty
        (Get-LiteReads).Count | Should -Be 0
    }
}

Describe 'A folder that is not Lite is not Lite' {
    BeforeEach {
        $env:LAZARETTE_PORT = [string](Get-ClosedPort)
        $script:Fake.State.Mode = 'ok'
    }
    It 'a folder with the manifest but no shim does not fall back' {
        $dir = Join-Path $TestDrive 'not-lite'; New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $dir 'LazaretteLite.psd1') -Value '# marker' -Encoding ASCII
        $env:LAZARETTE_PATH = $dir
        $s = (New-Source '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"password":"SMDATS_PASSWORD"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Error.Status | Should -Be 501
        $r.Error.Code | Should -Be 'vault-unavailable'
    }
    It 'a folder with neither file does not fall back' {
        $env:LAZARETTE_PATH = $TestDrive
        $s = (New-Source '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"password":"SMDATS_PASSWORD"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Error.Code | Should -Be 'vault-unavailable'
    }
}

Describe 'Lazarette still wins, and its errors never fall back' {
    BeforeEach {
        $env:LAZARETTE_PORT = [string]$script:Fake.Port
        $env:LAZARETTE_PATH = $script:LiteRoot
        Set-LiteValues @{ SMDATS_PASSWORD = 'litePassw0rd'; SMDATS_USER = 'lite-svc-user' }
        $script:Fake.State.Mode = 'ok'
        $script:Fake.State.Shares = @{ SMDATS_PASSWORD = 'lazPassw0rd'; SMDATS_USER = 'laz-svc-user' }
        $script:Fake.State.Requests.Clear()
    }
    AfterEach { Set-SemVaultRequest $null }

    It 'uses Lazarette, not Lite, when Lazarette answers' {
        $s = (New-Source '[{"id":"maint","provider":"odbc","connection":"DSN=x","vault":{"password":"SMDATS_PASSWORD","user":"SMDATS_USER"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Values.password | Should -Be 'lazPassw0rd'
        $r.Values.user | Should -Be 'laz-svc-user'
        $r.ContainsKey('Store') | Should -BeFalse
        (Get-LiteReads).Count | Should -Be 0
        $script:Fake.State.Requests.Count | Should -Be 1
    }
    It 'does not fall back on a Lazarette <Code> error' -TestCases @(
        @{ Mode = 'locked'; Status = 423; Code = 'vault-locked' }
        @{ Mode = 'not-paired'; Status = 424; Code = 'vault-not-paired' }
        @{ Mode = 'rate-limited'; Status = 424; Code = 'vault-refused' }
        @{ Mode = 'bad-seal'; Status = 424; Code = 'vault-error' }
    ) {
        $script:Fake.State.Mode = $Mode
        $s = (New-Source '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"password":"SMDATS_PASSWORD"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Error.Status | Should -Be $Status
        $r.Error.Code | Should -Be $Code
        (Get-LiteReads).Count | Should -Be 0
    }
}

Describe 'Status reports the store that answers' {
    BeforeEach {
        $script:StatusHome = Join-Path $TestDrive ('st-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $script:StatusHome | Out-Null
        Set-Content -LiteralPath (Join-Path $script:StatusHome 'sources.json') -Encoding UTF8 -Value '[{"id":"maint","provider":"odbc","connection":"DSN=x","vault":{"password":"SMDATS_PASSWORD","user":"SMDATS_USER"}},{"id":"plain","provider":"odbc","connection":"DSN=y"}]'
        $script:Fake.State.Mode = 'ok'
        $script:Fake.State.Shares = @{ SMDATS_PASSWORD = 'lazPassw0rd' }
    }

    It 'reports lite when Lazarette is down but Lite answers' {
        $env:LAZARETTE_PORT = [string](Get-ClosedPort)
        $env:LAZARETTE_PATH = $script:LiteRoot
        Set-LiteValues @{ SMDATS_PASSWORD = 'litePassw0rd' }
        $st = Get-SemVaultStatus -HomeDir $script:StatusHome
        $st.running | Should -BeFalse
        $st.lite | Should -BeTrue
        $st.store | Should -Be 'lite'
        @($st.shared) | Should -Be @('SMDATS_PASSWORD')
        $st.notShared[0].name | Should -Be 'SMDATS_USER'
        $st.problem | Should -BeLike '*not running*'
        $st.problem | Should -BeLike '*Lite*'
        (ConvertTo-Json -InputObject $st -Depth 6) | Should -Not -BeLike '*litePassw0rd*'
    }
    It 'reports no Lite when Lazarette is down and no Lite folder is configured' {
        $env:LAZARETTE_PORT = [string](Get-ClosedPort)
        Remove-Item Env:\LAZARETTE_PATH -ErrorAction SilentlyContinue
        $st = Get-SemVaultStatus -HomeDir $script:StatusHome
        $st.running | Should -BeFalse
        $st.lite | Should -BeFalse
        $st.store | Should -BeNullOrEmpty
        @($st.shared).Count | Should -Be 0
        $st.problem | Should -BeLike '*not running*'
    }
    It 'reports lazarette when Lazarette answers' {
        $env:LAZARETTE_PORT = [string]$script:Fake.Port
        $env:LAZARETTE_PATH = $script:LiteRoot
        Set-LiteValues @{ SMDATS_PASSWORD = 'litePassw0rd' }
        $st = Get-SemVaultStatus -HomeDir $script:StatusHome
        $st.running | Should -BeTrue
        $st.lite | Should -BeFalse
        $st.store | Should -Be 'lazarette'
        @($st.shared) | Should -Be @('SMDATS_PASSWORD')
    }
}
