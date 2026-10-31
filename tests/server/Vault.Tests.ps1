# Pester 5. The Lazarette bridge (server/Vault.ps1) against a fake Lazarette that follows the contract in
# Lazarette's docs/INTEGRATION.md (lib\Arc.ps1 with Test-ArcVaultUnlocked, Unlock-ArcVaultInteractive,
# Get-ArcSecret). A real Lazarette vault is not touched: see docs/VAULT.md for what still needs checking by hand.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Lake.ps1', 'Vault.ps1', 'Connectors.ps1') { . ([IO.Path]::Combine($server, $f)) }

    $script:Arc = Join-Path $TestDrive 'Lazarette'
    New-Item -ItemType Directory -Path (Join-Path $script:Arc 'lib') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $script:Arc 'lib\Arc.ps1') -Encoding ASCII -Value @'
$script:FakeVault = @{ Open = $false; Prompted = 0; Reads = (New-Object System.Collections.ArrayList)
    Items = @{
        'maint-db'      = @{ Secret = 'S3cr}et"pw;1'; Fields = @{ Username = 'svc_semaphore' } }
        'plain-db'      = @{ Secret = 'plainPassw0rd'; Fields = @{} }
        'aws-semaphore' = @{ Secret = ''; Fields = @{ AccessKeyId = 'AKIAFAKEFAKEFAKE1234'; SecretAccessKey = 'fakeSecretKey/with+chars0123456789abcdef'; SessionToken = 'fakeSessionToken-0123456789abcdefghij' } }
        'aws-nosession' = @{ Secret = ''; Fields = @{ AccessKeyId = 'AKIAFAKEFAKEFAKE9999'; SecretAccessKey = 'fakeSecretKey/other0123456789abcdefgh' } }
        'empty-item'    = @{ Secret = ''; Fields = @{} }
    } }
function Test-ArcVaultUnlocked { return [bool]$script:FakeVault.Open }
function Unlock-ArcVaultInteractive { $script:FakeVault.Prompted++; $script:FakeVault.Open = $true; return $true }
function Get-ArcSecret {
    param([string]$Service, [string]$User, [string]$Field)
    if (-not $script:FakeVault.Open) { throw 'Lazarette is locked' }
    [void]$script:FakeVault.Reads.Add("$Service|$Field")
    if (-not $script:FakeVault.Items.ContainsKey($Service)) { throw "No item named '$Service'" }
    $it = $script:FakeVault.Items[$Service]
    if ($Field) { if (-not $it.Fields.ContainsKey($Field)) { throw "Item '$Service' has no field '$Field'" }; return $it.Fields[$Field] }
    return $it.Secret
}
'@
    $env:ARC_PATH = $script:Arc
    . (Get-SemArcLibPath)   # as Start-Semaphore does, at script scope

    function script:New-Source([string]$Json) {
        $dir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir | Out-Null
        Set-Content -LiteralPath (Join-Path $dir 'sources.json') -Value $Json -Encoding UTF8
        return , @(Get-SemSources -HomeDir $dir)
    }
}
AfterAll { Remove-Item Env:\ARC_PATH -ErrorAction SilentlyContinue }

Describe 'Finding Lazarette' {
    It 'prefers ARC_PATH, then ARC_ROOT, ARC_HOME' {
        Find-SemArcRoot | Should -Be ([IO.Path]::GetFullPath($script:Arc))
    }
    It 'finds a sibling Lazarette folder next to the Semaphore folder' {
        $old = $env:ARC_PATH; Remove-Item Env:\ARC_PATH
        try {
            $parent = Join-Path $TestDrive 'suite'
            New-Item -ItemType Directory -Path (Join-Path $parent 'Lazarette\lib'), (Join-Path $parent 'Semaphore') -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $parent 'Lazarette\lib\Arc.ps1') -Value '# x'
            Find-SemArcRoot -Root (Join-Path $parent 'Semaphore') | Should -Be (Join-Path $parent 'Lazarette')
        } finally { $env:ARC_PATH = $old }
    }
    It 'returns nothing when lib\Arc.ps1 is missing' {
        $old = $env:ARC_PATH; $env:ARC_PATH = (Join-Path $TestDrive 'nowhere')
        try { Find-SemArcRoot | Should -Not -Be (Join-Path $TestDrive 'nowhere') } finally { $env:ARC_PATH = $old }
    }
}

Describe 'The vault block in sources.json' {
    It 'accepts an item and per-role field names' {
        $s = New-Source '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"item":"maint-db","fields":{"user":"Login"}}}]'
        $s.Count | Should -Be 1
        $n = Get-SemVaultNeeds $s[0]
        $n.Item | Should -Be 'maint-db'
        ($n.Roles | Where-Object Role -eq 'user').Field | Should -Be 'Login'
        ($n.Roles | Where-Object Role -eq 'password').Field | Should -BeNullOrEmpty
    }
    It 'refuses <Why>' -TestCases @(
        @{ Why = 'a secret in the block'; Json = '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"item":"i","password":"hunter2"}}]' }
        @{ Why = 'a missing item'; Json = '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{}}]' }
        @{ Why = 'a bad item name'; Json = '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"item":"a;b"}}]' }
        @{ Why = 'an unknown role'; Json = '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"item":"i","fields":{"token":"T"}}}]' }
        @{ Why = 'a bad field name'; Json = '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"item":"i","fields":{"user":"a;b"}}}]' }
        @{ Why = 'a string instead of an object'; Json = '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":"item"}]' }
    ) {
        (New-Source $Json).Count | Should -Be 0
    }
    It 'still refuses PWD= in the connection string even with a vault block' {
        Test-SemConnectionString 'DSN=x;PWD=oops' | Should -Not -BeNullOrEmpty
    }
}

Describe 'Resolving a source''s secrets' {
    BeforeEach { $script:FakeVault.Open = $false; $script:FakeVault.Reads.Clear(); $script:FakeVault.Prompted = 0 }

    It 'reports a locked vault without asking for anything' {
        $s = (New-Source '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"item":"maint-db"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Error.Status | Should -Be 423
        $r.Error.Code | Should -Be 'vault-locked'
        $r.Error.Message | Should -BeLike '*--console*'
        $script:FakeVault.Reads.Count | Should -Be 0
        $script:FakeVault.Prompted | Should -Be 0
    }
    It 'unlocks only through Request-SemVaultUnlock, and only with a console' {
        Request-SemVaultUnlock -Interactive $false | Should -BeFalse
        $script:FakeVault.Prompted | Should -Be 0
        Request-SemVaultUnlock -Interactive $true | Should -BeTrue
        $script:FakeVault.Prompted | Should -Be 1
        Request-SemVaultUnlock -Interactive $true | Should -BeTrue
        $script:FakeVault.Prompted | Should -Be 1   # already open: no second prompt
    }
    It 'returns the password and the user for an ODBC source' {
        $script:FakeVault.Open = $true
        $s = (New-Source '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"item":"maint-db"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Values.password | Should -Be 'S3cr}et"pw;1'
        $r.Values.user | Should -Be 'svc_semaphore'
    }
    It 'skips an optional field the item lacks' {
        $script:FakeVault.Open = $true
        $s = (New-Source '[{"id":"a","provider":"oledb","connection":"Provider=x","vault":{"item":"plain-db"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Values.password | Should -Be 'plainPassw0rd'
        $r.Values.ContainsKey('user') | Should -BeFalse
    }
    It 'names the item but never a value when the item is missing' {
        $script:FakeVault.Open = $true
        $s = (New-Source '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"item":"nope"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Error.Status | Should -Be 424
        $r.Error.Code | Should -Be 'vault-item'
        $r.Error.Message | Should -BeLike "*'nope'*"
    }
    It 'refuses an item with no secret' {
        $script:FakeVault.Open = $true
        $s = (New-Source '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"item":"empty-item"}}]')[0]
        (Resolve-SemVaultSecrets -Source $s).Error.Code | Should -Be 'vault-item'
    }
    It 'returns an AWS session (keys and token) for a lake source' {
        $script:FakeVault.Open = $true
        $s = (New-Source '[{"id":"lake","kind":"aws-athena","provider":"athena","region":"us-gov-west-1","database":"maint","vault":{"item":"aws-semaphore"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Values.accessKeyId | Should -Be 'AKIAFAKEFAKEFAKE1234'
        $r.Values.secretAccessKey | Should -BeLike 'fakeSecretKey/with*'
        $r.Values.sessionToken | Should -BeLike 'fakeSessionToken*'
    }
    It 'accepts a long-lived key pair with no session token' {
        $script:FakeVault.Open = $true
        $s = (New-Source '[{"id":"lake","kind":"aws-athena","provider":"athena","region":"us-gov-west-1","database":"maint","vault":{"item":"aws-nosession"}}]')[0]
        $r = Resolve-SemVaultSecrets -Source $s
        $r.Values.ContainsKey('sessionToken') | Should -BeFalse
        $r.Values.accessKeyId | Should -Be 'AKIAFAKEFAKEFAKE9999'
    }
    It 'does nothing for a source with no vault block' {
        $s = (New-Source '[{"id":"a","provider":"odbc","connection":"DSN=x"}]')[0]
        (Resolve-SemVaultSecrets -Source $s).Values | Should -BeNullOrEmpty
        $script:FakeVault.Reads.Count | Should -Be 0
    }
    It 'asks for the secrets of the one source a request names' {
        $script:FakeVault.Open = $true
        $dir = Join-Path $TestDrive 'req'; New-Item -ItemType Directory -Path $dir | Out-Null
        Set-Content -LiteralPath (Join-Path $dir 'sources.json') -Encoding UTF8 -Value '[{"id":"a","provider":"odbc","connection":"DSN=x","vault":{"item":"maint-db"}},{"id":"b","provider":"odbc","connection":"DSN=y","vault":{"item":"plain-db"}}]'
        $req = @{ Json = [pscustomobject]@{ source = 'a' } }
        $c = Get-SemVaultForRequest -Req $req -HomeDir $dir
        $c.Values.password | Should -BeLike 'S3cr*'
        @($script:FakeVault.Reads | Where-Object { $_ -like 'plain-db*' }).Count | Should -Be 0
        Get-SemVaultForRequest -Req @{ Json = [pscustomobject]@{ source = 'zzz' } } -HomeDir $dir | Should -BeNullOrEmpty
    }
    It 'hands a locked-vault error to the worker, which sends it instead of connecting' {
        $c = @{ Error = @{ Status = 423; Code = 'vault-locked'; Message = 'locked' } }
        Set-SemVaultRequest $c
        try { (Get-SemVaultError).Code | Should -Be 'vault-locked' } finally { Set-SemVaultRequest $null }
        Get-SemVaultError | Should -BeNullOrEmpty
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
    It 'refuses a vault value with control characters' {
        { Add-SemVaultToConnectionString -ConnectionString 'DSN=x' -Provider 'odbc' -Values @{ password = "a`r`nb" } } | Should -Throw '*control characters*'
    }
    It 'builds the driver string from the request, with read-only flags, and fails closed without it' {
        $s = (New-Source '[{"id":"a","kind":"access","provider":"odbc","connection":"Driver={Microsoft Access Driver (*.mdb, *.accdb)};Dbq=C:\\x.accdb","vault":{"item":"plain-db"}}]')[0]
        { Get-SemEffectiveConnectionString -Source $s } | Should -Throw '*vault-locked*'
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
    AfterEach { Set-SemVaultRequest $null }
    It 'scrubs the password from a driver error and from the lake error text' {
        Set-SemVaultRequest @{ Values = @{ password = 'plainPassw0rd'; accessKeyId = 'AKIAFAKEFAKEFAKE1234'; secretAccessKey = 'fakeSecretKey/with+chars0123456789abcdef' } }
        $src = [pscustomobject]@{ id = 'a'; connection = 'DSN=x' }
        (Get-SemSafeMessage -Message 'Login failed for plainPassw0rd on DSN=x' -Source $src) | Should -Not -BeLike '*plainPassw0rd*'
        (Get-SemLakeSafeText 'denied for AKIAFAKEFAKEFAKE1234 / fakeSecretKey/with+chars0123456789abcdef') | Should -Not -BeLike '*AKIAFAKE*'
        (Get-SemLakeSafeText 'denied for AKIAFAKEFAKEFAKE1234 / fakeSecretKey/with+chars0123456789abcdef') | Should -Not -BeLike '*fakeSecretKey*'
    }
    It 'maps a connect failure to a message without the password' {
        Set-SemVaultRequest @{ Values = @{ password = 'plainPassw0rd' } }
        $src = [pscustomobject]@{ id = 'a'; connection = 'DSN=x' }
        $e = Get-SemQueryError -Exception ([Exception]::new('FATAL: password plainPassw0rd rejected')) -Source $src -Stage 'connect'
        $e.Message | Should -Not -BeLike '*plainPassw0rd*'
    }
    It 'leaves short values alone so ordinary words survive' {
        Set-SemVaultRequest @{ Values = @{ password = 'ab' } }
        Get-SemVaultSafeText 'a table about cabs' | Should -Be 'a table about cabs'
    }
}

Describe 'AWS session from the vault' {
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
    It 'fails with no session when neither the vault nor the environment has one' {
        { Get-SemAwsCredentials } | Should -Throw '*vault*'
    }
    It 'uses the vault session when the environment has none' {
        Set-SemVaultRequest @{ Values = @{ accessKeyId = 'AKIAFAKEFAKEFAKE1234'; secretAccessKey = 'fakeSecretKey/with+chars0123456789abcdef'; sessionToken = 'tok-0123456789abcdef' } }
        $c = Get-SemAwsCredentials
        $c.AccessKey | Should -Be 'AKIAFAKEFAKEFAKE1234'
        $c.SessionToken | Should -Be 'tok-0123456789abcdef'
    }
    It 'prefers the vault over the environment' {
        [Environment]::SetEnvironmentVariable('AWS_ACCESS_KEY_ID', 'AKIAENVENVENVENV0000'); [Environment]::SetEnvironmentVariable('AWS_SECRET_ACCESS_KEY', 'envSecretenvSecretenvSecret')
        Set-SemVaultRequest @{ Values = @{ accessKeyId = 'AKIAFAKEFAKEFAKE1234'; secretAccessKey = 'fakeSecretKey/with+chars0123456789abcdef' } }
        (Get-SemAwsCredentials).AccessKey | Should -Be 'AKIAFAKEFAKEFAKE1234'
    }
    It 'signs a request with the vault key and sends the secret key nowhere' {
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
