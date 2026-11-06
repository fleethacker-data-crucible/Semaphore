# Pester 5. The Lazarette bridge (server/Vault.ps1 and its copy of Lazarette's tools/Lazarette.Client.ps1) against a
# fake Lazarette on loopback that speaks the tool protocol of Lazarette's docs/TOOLS.md: X-Fleet-Peer header, the
# HMAC proof over the nonce, time, names and purpose, and an answer sealed with AES-256-CBC + HMAC-SHA256 under a key
# derived from the pairing secret and the nonce (the construction of Lazarette's lib/integrations/Tools.ps1, written
# out again here). The pairing is stored with DPAPI under a temporary LOCALAPPDATA. A real Lazarette is not touched:
# see docs/VAULT.md for what still needs checking by hand.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Intelligence.ps1', 'Lake.ps1', 'Vault.ps1', 'Connectors.ps1', 'Commands.ps1') { . ([IO.Path]::Combine($server, $f)) }

    $script:SavedLocal = $env:LOCALAPPDATA
    $script:SavedPort = $env:LAZARETTE_PORT
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
                $c = $L.AcceptTcpClient()
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

    $script:Fake = Start-FakeLazarette
    $env:LAZARETTE_PORT = [string]$script:Fake.Port
}
AfterAll {
    try { $script:Fake.L.Stop(); $script:Fake.PS.Dispose() } catch { }
    $env:LOCALAPPDATA = $script:SavedLocal
    if ($null -eq $script:SavedPort) { Remove-Item Env:\LAZARETTE_PORT -ErrorAction SilentlyContinue } else { $env:LAZARETTE_PORT = $script:SavedPort }
}

Describe 'No Lazarette engine in Semaphore' {
    BeforeAll {
        $script:ServerFiles = @(Get-ChildItem -LiteralPath $server -File | Where-Object { @('.ps1', '.psm1') -contains $_.Extension.ToLowerInvariant() })
    }
    It 'dot-sources no Lazarette engine file and calls no engine function anywhere in server/' {
        $bad = @()
        foreach ($f in $script:ServerFiles) {
            $text = [IO.File]::ReadAllText($f.FullName)
            foreach ($rx in @('Lazarette\.ps1', 'Get-LazaretteSecret\b', 'Unlock-LazaretteVault', 'Test-LazaretteVaultUnlocked', 'Get-LazaretteItemNames', 'Lock-LazaretteVault', 'LAZARETTE_PATH')) {
                if ($text -match $rx) { $bad += ('{0}: {1}' -f $f.Name, $rx) }
            }
        }
        $bad | Should -BeNullOrEmpty
    }
    It 'dot-sources only Semaphore''s own server files' {
        $bad = @()
        foreach ($file in $script:ServerFiles) {
            $tokens = $null; $errs = $null
            $ast = [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errs)
            $dots = $ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.InvocationOperator -eq [Management.Automation.Language.TokenKind]::Dot }, $true)
            foreach ($d in $dots) {
                $text = $d.Extent.Text
                if ($text -match '^\.\s+\$Ctx\.[A-Za-z]+Path$') { continue }   # the worker loads the files Initialize-SemWorkers names
                $isPs1 = { param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst] -and $n.Value -like '*.ps1' }
                $consts = @($d.FindAll($isPs1, $true) | ForEach-Object { $_.Value })
                if ($consts.Count -eq 0) {
                    # foreach ($f in 'Common.ps1', ...) { . (Join-Path $here $f) }: the names are in the loop's list.
                    $loop = $d.Parent
                    while ($null -ne $loop -and $loop -isnot [Management.Automation.Language.ForEachStatementAst]) { $loop = $loop.Parent }
                    if ($null -ne $loop) { $consts = @($loop.Condition.FindAll($isPs1, $true) | ForEach-Object { $_.Value }) }
                }
                if ($consts.Count -eq 0) { $bad += ('{0}: {1}' -f $file.Name, $text); continue }
                foreach ($c in $consts) { if (-not [IO.File]::Exists((Join-Path $server ([IO.Path]::GetFileName($c))))) { $bad += ('{0}: {1}' -f $file.Name, $c) } }
            }
        }
        $bad | Should -BeNullOrEmpty
    }
    It 'ships the client copy with the Lazarette version and commit it came from' {
        $head = (Get-Content -LiteralPath (Join-Path $server 'Lazarette.Client.ps1') -TotalCount 8) -join "`n"
        $head | Should -Match 'Lazarette 5\.\d+\.\d+'
        $head | Should -Match 'commit [0-9a-f]{7}'
        Get-Command Get-LazaretteToolSecrets -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
    }
}

Describe 'The vault block in sources.json' {
    It 'names one share per role' {
        $s = New-Source '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"password":"SMDATS_PASSWORD","user":"SMDATS_USER"}}]'
        $s.Count | Should -Be 1
        $n = Get-SemVaultNeeds $s[0]
        ($n.Roles | Where-Object Role -eq 'user').Name | Should -Be 'SMDATS_USER'
        ($n.Roles | Where-Object Role -eq 'user').Optional | Should -BeTrue
        ($n.Roles | Where-Object Role -eq 'password').Name | Should -Be 'SMDATS_PASSWORD'
    }
    It 'reads only the optional roles a block names' {
        $s = New-Source '[{"id":"a","provider":"oledb","connection":"Provider=x","vault":{"password":"PARTS_PASSWORD"}},{"id":"l","provider":"athena","region":"us-gov-west-1","database":"maint","vault":{"accessKeyId":"AWS_ACCESS_KEY_ID","secretAccessKey":"AWS_SECRET_ACCESS_KEY"}}]'
        $s.Count | Should -Be 2
        @((Get-SemVaultNeeds $s[0]).Roles).Count | Should -Be 1
        @((Get-SemVaultNeeds $s[1]).Roles | ForEach-Object { $_.Role }) | Should -Be @('accessKeyId', 'secretAccessKey')
    }
    It 'refuses <Why>' -TestCases @(
        @{ Why = 'the retired item form'; Json = '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"item":"maint-db"}}]' }
        @{ Why = 'the retired vaultItem short form'; Json = '[{"id":"a","provider":"odbc","connection":"DSN=x","vaultItem":"maint-db"}]' }
        @{ Why = 'a missing required role'; Json = '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"user":"SMDATS_USER"}}]' }
        @{ Why = 'an empty block'; Json = '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{}}]' }
        @{ Why = 'a name that is not a variable name'; Json = '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"password":"pa ss;word"}}]' }
        @{ Why = 'a role of another provider'; Json = '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"password":"P","token":"T"}}]' }
        @{ Why = 'two roles on one share'; Json = '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"password":"SMDATS","user":"smdats"}}]' }
        @{ Why = 'a string instead of an object'; Json = '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":"SMDATS_PASSWORD"}]' }
        @{ Why = 'an AWS block without the secret key'; Json = '[{"id":"l","provider":"athena","region":"us-gov-west-1","database":"maint","vault":{"accessKeyId":"AWS_ACCESS_KEY_ID"}}]' }
        @{ Why = 'a Synapse password sign-in with no user share'; Json = '[{"id":"s","provider":"synapse","server":"ws.sql.azuresynapse.net","database":"d","authentication":"SqlPassword","vault":{"password":"SYN_PASSWORD"}}]' }
    ) {
        (New-Source $Json).Count | Should -Be 0
    }
    It 'tells how to write the new form when it meets the old one' {
        Test-SemVaultBlock -Raw ([pscustomobject]@{ vaultItem = 'x' }) -Provider 'odbc' | Should -BeLike '*"password": "SMDATS_PASSWORD"*'
        Test-SemVaultBlock -Raw ([pscustomobject]@{ vault = [pscustomobject]@{ item = 'x' } }) -Provider 'odbc' | Should -BeLike '*Lazarette*'
    }
    It 'still refuses PWD= in the connection string even with a vault block' {
        Test-SemConnectionString 'DSN=x;PWD=oops' | Should -Not -BeNullOrEmpty
    }
}

Describe 'Pairing' {
    BeforeEach { [void](Unregister-SemVaultPairing) }
    It 'stores the code DPAPI-protected where the client reads it, and never in clear text' {
        Test-SemVaultPaired | Should -BeFalse
        $path = Register-SemVaultPairing -Code (ConvertTo-Secure $script:Code)
        $path | Should -BeLike (Join-Path $env:LOCALAPPDATA 'Lazarette\tools\Semaphore.pairing')
        Test-SemVaultPaired | Should -BeTrue
        [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($path)) | Should -Not -BeLike '*lztl1*'
    }
    It 'refuses something that is not a pairing code' {
        { Register-SemVaultPairing -Code (ConvertTo-Secure 'hunter2') } | Should -Throw '*lztl1*'
        Test-SemVaultPaired | Should -BeFalse
    }
    It 'forgets the pairing' {
        Set-Pairing
        Unregister-SemVaultPairing | Should -BeTrue
        Test-SemVaultPaired | Should -BeFalse
        Unregister-SemVaultPairing | Should -BeFalse
    }
    It 'pairs from the CLI command with the code read as a SecureString' {
        Mock Read-Host { ConvertTo-Secure $script:Code } -ParameterFilter { $AsSecureString }
        $r = Invoke-SemCommand -Command (Find-SemCommand 'vault pair') -HomeDir $TestDrive -Root (Split-Path -Parent $server)
        $r.Ok | Should -BeTrue
        Test-SemVaultPaired | Should -BeTrue
        (ConvertTo-Json -InputObject $r -Depth 5) | Should -Not -BeLike '*lztl1*'
        Should -Invoke Read-Host -Times 1 -Exactly
    }
}

Describe 'Resolving a source''s secrets over loopback' {
    BeforeAll { Set-Pairing }
    BeforeEach {
        $script:Fake.State.Mode = 'ok'
        $script:Fake.State.Shares = @{ SMDATS_PASSWORD = 'S3cr}et"pw;1'; SMDATS_USER = 'svc_semaphore'; PLAIN_PASSWORD = 'plainPassw0rd'; EMPTY_ONE = ''
            AWS_ACCESS_KEY_ID = 'AKIAFAKEFAKEFAKE1234'; AWS_SECRET_ACCESS_KEY = 'fakeSecretKey/with+chars0123456789abcdef'; AWS_SESSION_TOKEN = 'fakeSessionToken-0123456789abcdefghij' }
        $script:Fake.State.Requests.Clear(); $script:Fake.State.Heads.Clear(); $script:Fake.State.Proofs.Clear()
        $env:LAZARETTE_PORT = [string]$script:Fake.Port
    }
    AfterEach { Set-SemVaultRequest $null }

    It 'returns the password and the user for an ODBC source, with a valid proof and no Origin header' {
        $s = (New-Source '[{"id":"maint","provider":"odbc","connection":"DSN=x","vault":{"password":"SMDATS_PASSWORD","user":"SMDATS_USER"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.ContainsKey('Error') | Should -BeFalse
        $r.Values.password | Should -Be 'S3cr}et"pw;1'
        $r.Values.user | Should -Be 'svc_semaphore'
        @($r.Notes).Count | Should -Be 0
        @($script:Fake.State.Proofs) | Should -Be @($true)
        $script:Fake.State.Requests[0].Names | Should -Be @('SMDATS_PASSWORD', 'SMDATS_USER')
        $script:Fake.State.Requests[0].Purpose | Should -Be 'Semaphore query on source maint'
        [string]$script:Fake.State.Heads[0] | Should -Not -Match '(?mi)^Origin:'
    }
    It 'leaves a note naming the share when the optional user is not shared (#64), and still connects with the password' {
        $script:Fake.State.Shares.Remove('SMDATS_USER')
        $s = (New-Source '[{"id":"maint","provider":"odbc","connection":"DSN=x","vault":{"password":"SMDATS_PASSWORD","user":"SMDATS_USER"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Values.ContainsKey('user') | Should -BeFalse
        $r.Values.password | Should -BeLike 'S3cr*'
        @($r.Notes).Count | Should -Be 1
        $r.Notes[0] | Should -BeLike "*SMDATS_USER*not shared*Windows authentication*"
        $r.Notes[0] | Should -Not -BeLike '*S3cr*'
    }
    It 'puts the note on a connect error the worker sends' {
        Set-SemVaultRequest @{ Values = @{ password = 'plainPassw0rd' }; Notes = @("Lazarette has no user for source 'a' (SMDATS_USER: it is not shared with Semaphore), so it signs in with the user in its DSN or with Windows authentication.") }
        $e = Get-SemQueryError -Exception ([Exception]::new("Login failed for user ''.")) -Source ([pscustomobject]@{ id = 'a'; connection = 'DSN=x' }) -Stage 'connect'
        $e.Message | Should -BeLike "*Login failed*SMDATS_USER*"
    }
    It 'refuses with a sentence naming the share when a required one is <State>' -TestCases @(
        @{ State = 'not shared'; Name = 'NOT_THERE'; Text = '*NOT_THERE (it is not shared with Semaphore)*Settings > Tools > Semaphore*' }
        @{ State = 'empty'; Name = 'EMPTY_ONE'; Text = '*EMPTY_ONE (the shared item has no value*' }
    ) {
        $s = (New-Source ('[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"password":"' + $Name + '"}}]'))[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Error.Status | Should -Be 424
        $r.Error.Code | Should -Be 'vault-not-shared'
        $r.Error.Message | Should -BeLike $Text
    }
    It 'returns an AWS session for a lake source, and goes on with a note when the session token is not shared' {
        $s = (New-Source '[{"id":"lake","kind":"aws-athena","provider":"athena","region":"us-gov-west-1","database":"maint","vault":{"accessKeyId":"AWS_ACCESS_KEY_ID","secretAccessKey":"AWS_SECRET_ACCESS_KEY","sessionToken":"AWS_SESSION_TOKEN"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Values.accessKeyId | Should -Be 'AKIAFAKEFAKEFAKE1234'
        $r.Values.sessionToken | Should -BeLike 'fakeSessionToken*'
        $script:Fake.State.Shares.Remove('AWS_SESSION_TOKEN')
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Values.ContainsKey('sessionToken') | Should -BeFalse
        $r.Notes[0] | Should -BeLike '*AWS_SESSION_TOKEN*key pair alone*'
    }
    It 'reads a Foundry token' {
        $script:Fake.State.Shares['FOUNDRY_TOKEN'] = 'fnd-token-0123456789'
        $s = (New-Source '[{"id":"fnd","kind":"foundry","provider":"foundry","host":"https://acme.palantirfoundry.com","vault":{"token":"FOUNDRY_TOKEN"}}]')[0]
        (Resolve-SemVaultSecrets -Source $s).Values.token | Should -Be 'fnd-token-0123456789'
    }
    It 'maps Lazarette''s answer to <Code> (<Status>) with a sentence' -TestCases @(
        @{ Mode = 'locked'; Status = 423; Code = 'vault-locked'; Text = '*locked. Unlock Lazarette*' }
        @{ Mode = 'not-paired'; Status = 424; Code = 'vault-not-paired'; Text = '*pair Semaphore again*vault pair*' }
        @{ Mode = 'other-program'; Status = 424; Code = 'vault-other-program'; Text = '*different program*' }
        @{ Mode = 'rate-limited'; Status = 424; Code = 'vault-refused'; Text = '*several failed*' }
        @{ Mode = 'bad-seal'; Status = 424; Code = 'vault-error'; Text = '*seal check failed*' }
    ) {
        $script:Fake.State.Mode = $Mode
        $s = (New-Source '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"password":"SMDATS_PASSWORD"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Error.Status | Should -Be $Status
        $r.Error.Code | Should -Be $Code
        $r.Error.Message | Should -BeLike $Text
        $r.Error.Message | Should -Not -BeLike '*S3cr*'
    }
    It 'says Lazarette is not running when nothing listens on its port' {
        $env:LAZARETTE_PORT = [string](Get-ClosedPort)
        $s = (New-Source '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"password":"SMDATS_PASSWORD"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Error.Status | Should -Be 501
        $r.Error.Code | Should -Be 'vault-unavailable'
        $r.Error.Message | Should -BeLike "*Source 'a'*not running*Start Lazarette*"
    }
    It 'says Semaphore is not paired before sending anything' {
        [void](Unregister-SemVaultPairing)
        try {
            $s = (New-Source '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"password":"SMDATS_PASSWORD"}}]')[0]
            $r = Resolve-SemVaultSecrets -Source $s
            $r.Error.Status | Should -Be 424
            $r.Error.Code | Should -Be 'vault-not-paired'
            $r.Error.Message | Should -BeLike '*Settings > Tools*vault pair*'
            $script:Fake.State.Requests.Count | Should -Be 0
        } finally { Set-Pairing }
    }
    It 'does nothing for a source with no vault block' {
        $s = (New-Source '[{"id":"a","provider":"odbc","connection":"DSN=x"}]')[0]
        (Resolve-SemVaultSecrets -Source $s).Values | Should -BeNullOrEmpty
        $script:Fake.State.Requests.Count | Should -Be 0
    }
    It 'asks only for the shares of the one source a request names' {
        $dir = Join-Path $TestDrive ('req-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $dir | Out-Null
        Set-Content -LiteralPath (Join-Path $dir 'sources.json') -Encoding UTF8 -Value '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"password":"SMDATS_PASSWORD"}},{"id":"b","provider":"odbc","connection":"DSN=y","vault":{"password":"PLAIN_PASSWORD"}}]'
        $c = Get-SemVaultForRequest -Req @{ Json = [pscustomobject]@{ source = 'a' } } -HomeDir $dir
        $c.Values.password | Should -BeLike 'S3cr*'
        @($script:Fake.State.Requests | ForEach-Object { $_.Names } | Where-Object { $_ -eq 'PLAIN_PASSWORD' }).Count | Should -Be 0
        Get-SemVaultForRequest -Req @{ Json = [pscustomobject]@{ source = 'zzz' } } -HomeDir $dir | Should -BeNullOrEmpty
    }
    It 'hands an error to the worker, which sends it instead of connecting' {
        Set-SemVaultRequest @{ Error = @{ Status = 423; Code = 'vault-locked'; Message = 'locked' } }
        (Get-SemVaultError).Code | Should -Be 'vault-locked'
        Set-SemVaultRequest $null
        Get-SemVaultError | Should -BeNullOrEmpty
        @(Get-SemVaultNotes).Count | Should -Be 0
    }
}

Describe 'Status: names and states only' {
    BeforeAll { Set-Pairing }
    BeforeEach {
        $script:Fake.State.Mode = 'ok'
        $script:Fake.State.Shares = @{ SMDATS_PASSWORD = 'S3cr}et"pw;1' }
        $env:LAZARETTE_PORT = [string]$script:Fake.Port
        $script:StatusHome = Join-Path $TestDrive ('st-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $script:StatusHome | Out-Null
        Set-Content -LiteralPath (Join-Path $script:StatusHome 'sources.json') -Encoding UTF8 -Value '[{"id":"maint","provider":"odbc","connection":"DSN=x","vault":{"password":"SMDATS_PASSWORD","user":"SMDATS_USER"}},{"id":"plain","provider":"odbc","connection":"DSN=y"}]'
    }
    It 'reports paired, running and unlocked, and which shares are there, without a value' {
        $st = Get-SemVaultStatus -HomeDir $script:StatusHome
        $st.paired | Should -BeTrue
        $st.running | Should -BeTrue
        $st.locked | Should -BeFalse
        @($st.sources).Count | Should -Be 1
        $st.sources[0].shares.user | Should -Be 'SMDATS_USER'
        @($st.shared) | Should -Be @('SMDATS_PASSWORD')
        $st.notShared[0].name | Should -Be 'SMDATS_USER'
        $st.notShared[0].state | Should -Be 'not-shared'
        (ConvertTo-Json -InputObject $st -Depth 6) | Should -Not -BeLike '*S3cr*'
        (ConvertTo-Json -InputObject $st -Depth 6) | Should -Not -BeLike '*DSN*'
    }
    It 'reports a locked Lazarette' {
        $script:Fake.State.Mode = 'locked'
        $st = Get-SemVaultStatus -HomeDir $script:StatusHome
        $st.locked | Should -BeTrue
        $st.problem | Should -BeLike '*locked*'
    }
    It 'reports a Lazarette that is not running' {
        $env:LAZARETTE_PORT = [string](Get-ClosedPort)
        $st = Get-SemVaultStatus -HomeDir $script:StatusHome
        $st.running | Should -BeFalse
        $st.problem | Should -BeLike '*not running*'
    }
}

Describe 'Connection strings' {
    AfterEach { Set-SemVaultRequest $null }
    It 'puts ODBC credentials in braces and doubles a closing brace' {
        $cs = Add-SemVaultToConnectionString -ConnectionString 'DSN=x;' -Provider 'odbc' -Values @{ user = 'svc'; password = 'a}b;c"d' }
        $cs | Should -Be 'DSN=x;UID={svc};PWD={a}}b;c"d}'
    }
    It 'quotes OLE DB credentials and doubles a quote' {
        $cs = Add-SemVaultToConnectionString -ConnectionString 'Provider=SQLOLEDB;Data Source=db' -Provider 'oledb' -Values @{ user = 'svc'; password = 'a"b;c' }
        $cs | Should -Be 'Provider=SQLOLEDB;Data Source=db;User ID="svc";Password="a""b;c"'
    }
    It 'keeps a UID already in the connection string' {
        (Add-SemVaultToConnectionString -ConnectionString 'DSN=x;UID=own' -Provider 'odbc' -Values @{ user = 'svc'; password = 'p' }) | Should -Be 'DSN=x;UID=own;PWD={p}'
    }
    It 'refuses a value with control characters' {
        { Add-SemVaultToConnectionString -ConnectionString 'DSN=x' -Provider 'odbc' -Values @{ password = "a`r`nb" } } | Should -Throw '*control characters*'
    }
    It 'builds the driver string from the request, with read-only flags, and fails closed without it' {
        $s = (New-Source '[{"id":"a","kind":"access","provider":"odbc","connection":"Driver={Microsoft Access Driver (*.mdb, *.accdb)};Dbq=C:\\x.accdb","vault":{"password":"PLAIN_PASSWORD"}}]')[0]
        { Get-SemEffectiveConnectionString -Source $s } | Should -Throw '*not resolved*'
        Set-SemVaultRequest @{ Values = @{ password = 'plainPassw0rd' } }
        $cs = Get-SemEffectiveConnectionString -Source $s
        $cs | Should -BeLike '*ReadOnly=1*'
        $cs | Should -BeLike '*PWD={plainPassw0rd}'
    }
    It 'leaves a source with no vault block exactly as before' {
        $s = (New-Source '[{"id":"a","provider":"oledb","connection":"Provider=Microsoft.ACE.OLEDB.12.0;Data Source=C:\\x.accdb"}]')[0]
        Get-SemEffectiveConnectionString -Source $s | Should -Be 'Provider=Microsoft.ACE.OLEDB.12.0;Data Source=C:\x.accdb;Mode=Read'
    }
}

Describe 'Secrets never reach a message' {
    BeforeAll { Set-Pairing }
    AfterEach { Set-SemVaultRequest $null }
    It 'scrubs values read over loopback from a driver error and from the lake error text' {
        $env:LAZARETTE_PORT = [string]$script:Fake.Port
        $script:Fake.State.Mode = 'ok'
        $script:Fake.State.Shares = @{ PLAIN_PASSWORD = 'plainPassw0rd'; AK = 'AKIAFAKEFAKEFAKE1234'; SK = 'fakeSecretKey/with+chars0123456789abcdef' }
        $db = (New-Source '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"password":"PLAIN_PASSWORD"}}]')[0]
        $lake = (New-Source '[{"id":"l","provider":"athena","region":"us-gov-west-1","database":"maint","vault":{"accessKeyId":"AK","secretAccessKey":"SK"}}]')[0]
        $dir = Join-Path $TestDrive ('scrub-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $dir | Out-Null
        Set-Content -LiteralPath (Join-Path $dir 'sources.json') -Encoding UTF8 -Value '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"password":"PLAIN_PASSWORD"}}]'
        Set-SemVaultRequest (Get-SemVaultForRequest -Req @{ Json = [pscustomobject]@{ source = 'a' } } -HomeDir $dir)
        Get-SemVaultValue 'password' | Should -Be 'plainPassw0rd'
        (Get-SemSafeMessage -Message 'Login failed for plainPassw0rd on DSN=x' -Source $db) | Should -Not -BeLike '*plainPassw0rd*'
        Set-SemVaultRequest @{ Values = (Resolve-SemVaultSecrets -Source $lake).Values }
        (Get-SemLakeSafeText 'denied for AKIAFAKEFAKEFAKE1234 / fakeSecretKey/with+chars0123456789abcdef') | Should -Not -BeLike '*AKIAFAKE*'
        (Get-SemLakeSafeText 'denied for AKIAFAKEFAKEFAKE1234 / fakeSecretKey/with+chars0123456789abcdef') | Should -Not -BeLike '*fakeSecretKey*'
    }
    It 'maps a connect failure to a message without the password' {
        Set-SemVaultRequest @{ Values = @{ password = 'plainPassw0rd' } }
        $e = Get-SemQueryError -Exception ([Exception]::new('FATAL: password plainPassw0rd rejected')) -Source ([pscustomobject]@{ id = 'a'; connection = 'DSN=x' }) -Stage 'connect'
        $e.Message | Should -Not -BeLike '*plainPassw0rd*'
    }
    It 'scrubs a value from a client error before it becomes a sentence' {
        Set-SemVaultRequest @{ Values = @{ password = 'plainPassw0rd' } }
        (ConvertTo-SemVaultError -Message 'Lazarette refused the request (request): plainPassw0rd').Message | Should -Not -BeLike '*plainPassw0rd*'
    }
    It 'leaves short values alone so ordinary words survive' {
        Set-SemVaultRequest @{ Values = @{ password = 'ab' } }
        Get-SemVaultSafeText 'a table about cabs' | Should -Be 'a table about cabs'
    }
}

Describe 'AWS session from Lazarette' {
    BeforeAll {
        function script:Start-OneShot {
            # One loopback HTTP server that records the request head and answers 200 {"ok":true}.
            $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start()
            $state = [hashtable]::Synchronized(@{ Heads = (New-Object Collections.ArrayList) })
            $ps = [powershell]::Create()
            [void]$ps.AddScript({
                param($L, $S)
                while ($true) {
                    $c = $L.AcceptTcpClient()
                    try {
                        $st = $c.GetStream(); $st.ReadTimeout = 5000
                        $buf = New-Object byte[] 65536; $raw = ''
                        do { $n = $st.Read($buf, 0, $buf.Length); $raw += [Text.Encoding]::UTF8.GetString($buf, 0, $n) } while ($n -gt 0 -and $raw -notmatch "`r`n`r`n")
                        $head = $raw.Substring(0, $raw.IndexOf("`r`n`r`n")); $body = $raw.Substring($raw.IndexOf("`r`n`r`n") + 4)
                        if ($head -match 'Content-Length: (\d+)') { while ([Text.Encoding]::UTF8.GetByteCount($body) -lt [int]$Matches[1]) { $n = $st.Read($buf, 0, $buf.Length); if ($n -le 0) { break }; $body += [Text.Encoding]::UTF8.GetString($buf, 0, $n) } }
                        [void]$S.Heads.Add($head)
                        $b = [Text.Encoding]::UTF8.GetBytes('{"ok":true}')
                        $h = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: application/x-amz-json-1.1`r`nContent-Length: $($b.Length)`r`nConnection: close`r`n`r`n")
                        $st.Write($h, 0, $h.Length); $st.Write($b, 0, $b.Length); $st.Flush()
                    } catch { } finally { $c.Close() }
                }
            }).AddArgument($l).AddArgument($state)
            [void]$ps.BeginInvoke()
            return @{ L = $l; PS = $ps; State = $state; Endpoint = 'http://127.0.0.1:' + ([Net.IPEndPoint]$l.LocalEndpoint).Port }
        }
    }
    BeforeEach {
        $script:SavedAws = @{}
        foreach ($n in 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN') { $script:SavedAws[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $null) }
    }
    AfterEach {
        Set-SemVaultRequest $null
        foreach ($n in $script:SavedAws.Keys) { [Environment]::SetEnvironmentVariable($n, $script:SavedAws[$n]) }
    }
    It 'fails with no session when neither Lazarette nor the environment has one' {
        { Get-SemAwsCredentials } | Should -Throw '*vault*'
    }
    It 'uses the shared session when the environment has none' {
        Set-SemVaultRequest @{ Values = @{ accessKeyId = 'AKIAFAKEFAKEFAKE1234'; secretAccessKey = 'fakeSecretKey/with+chars0123456789abcdef'; sessionToken = 'tok-0123456789abcdef' } }
        $c = Get-SemAwsCredentials
        $c.AccessKey | Should -Be 'AKIAFAKEFAKEFAKE1234'
        $c.SessionToken | Should -Be 'tok-0123456789abcdef'
    }
    It 'prefers Lazarette over the environment' {
        [Environment]::SetEnvironmentVariable('AWS_ACCESS_KEY_ID', 'AKIAENVENVENVENV0000'); [Environment]::SetEnvironmentVariable('AWS_SECRET_ACCESS_KEY', 'envSecretenvSecretenvSecret')
        Set-SemVaultRequest @{ Values = @{ accessKeyId = 'AKIAFAKEFAKEFAKE1234'; secretAccessKey = 'fakeSecretKey/with+chars0123456789abcdef' } }
        (Get-SemAwsCredentials).AccessKey | Should -Be 'AKIAFAKEFAKEFAKE1234'
    }
    It 'signs a request with the shared key and sends the secret key nowhere' {
        $fake = Start-OneShot
        try {
            Set-SemVaultRequest @{ Values = @{ accessKeyId = 'AKIAFAKEFAKEFAKE1234'; secretAccessKey = 'fakeSecretKey/with+chars0123456789abcdef'; sessionToken = 'tok-0123456789abcdef' } }
            $lake = @{ Region = 'us-gov-west-1'; Endpoint = $fake.Endpoint }
            $r = Invoke-SemAwsJson -Lake $lake -Service 'athena' -Target 'AmazonAthena.GetQueryExecution' -Payload @{ QueryExecutionId = 'q' }
            $r.ok | Should -BeTrue
            $head = [string]$fake.State.Heads[0]
            $head | Should -BeLike '*Credential=AKIAFAKEFAKEFAKE1234/*'
            $head | Should -BeLike '*X-Amz-Security-Token: tok-0123456789abcdef*'
            $head | Should -Not -BeLike '*fakeSecretKey*'
        } finally { $fake.L.Stop(); $fake.PS.Dispose() }
    }
}

Describe 'Docs match the code' {
    It 'the JSON example in VAULT.md loads every source' {
        $doc = Get-Content -LiteralPath ([IO.Path]::Combine($server, '..', 'docs', 'VAULT.md')) -Raw
        $m = [regex]::Match($doc, '(?s)```json\s*(\[.*?\])\s*```')
        $m.Success | Should -BeTrue
        $n = [regex]::Matches($m.Groups[1].Value, '"id"').Count
        $n | Should -BeGreaterThan 2
        (New-Source $m.Groups[1].Value).Count | Should -Be $n
    }
    It 'VAULT.md names every role of every provider, and the Fairlead key target the code uses' {
        $doc = Get-Content -LiteralPath ([IO.Path]::Combine($server, '..', 'docs', 'VAULT.md')) -Raw
        foreach ($p in $script:SemVaultRoles.Keys) {
            $doc | Should -BeLike "*$p*" -Because "the $p provider reads from Lazarette"
            foreach ($r in $script:SemVaultRoles[$p]) { $doc | Should -BeLike ('*`' + $r.Role + '`*') -Because "the role $($r.Role) is in the code" }
        }
        $doc | Should -BeLike '*Fairlead/Semaphore*'
        $src = Get-Content -LiteralPath ([IO.Path]::Combine($server, 'AiCredential.ps1')) -Raw
        $src | Should -BeLike "*'Fairlead/Semaphore'*"
    }
}
