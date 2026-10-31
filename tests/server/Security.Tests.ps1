# Pester 5. Security gate and route checks that need no browser and no database: Host/Origin
# rejection, the session token, static path traversal, hoist ids, the SQL guard, parameter typing.
# Requests are dispatched in memory (a MemoryStream stands in for the socket).
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    . ([IO.Path]::Combine($server, 'Common.ps1'))
    . ([IO.Path]::Combine($server, 'Http.ps1'))
    . ([IO.Path]::Combine($server, 'Routes.ps1'))
    . ([IO.Path]::Combine($server, 'Query.ps1'))
    . ([IO.Path]::Combine($server, 'Vault.ps1'))

    $script:TestHome = Join-Path ([IO.Path]::GetTempPath()) ('sem-home-' + [guid]::NewGuid().ToString('N'))
    $script:TestWeb = Join-Path ([IO.Path]::GetTempPath()) ('sem-web-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory((Join-Path $script:TestWeb 'assets'))
    [IO.File]::WriteAllText((Join-Path $script:TestWeb 'index.html'), '<!doctype html><title>t</title>')
    [IO.File]::WriteAllText([IO.Path]::Combine($script:TestWeb, 'assets', 'app.js'), 'console.log(1)')
    [IO.File]::WriteAllText((Join-Path ([IO.Path]::GetTempPath()) 'sem-secret.txt'), 'secret')

    $script:Sem.Port = 8774
    $script:Sem.Token = New-SemToken
    $script:Sem.Version = '0.2.0'
    $script:Sem.WebRoot = $script:TestWeb
    $script:Sem.Home = Resolve-SemHome -Settings @{ home = $script:TestHome } -Create
    Initialize-SemPresence -AutoStop $true

    function Invoke-TestRequest {
        param([string]$Method = 'GET', [string]$Path = '/', [hashtable]$Headers = @{}, [string]$Body = '', [switch]$NoHost, $Remote = [Net.IPAddress]::Loopback)
        $h = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        if (-not $NoHost) { $h['Host'] = '127.0.0.1:8774' }
        foreach ($k in $Headers.Keys) { $h[$k] = [string]$Headers[$k] }
        $bytes = [Text.Encoding]::UTF8.GetBytes($Body)
        $req = @{ Method = $Method; Path = $Path; Query = ''; Headers = $h; ContentLength = $bytes.Length; Body = $bytes; Json = $null; RemoteAddress = $Remote; Client = $null }
        $ms = New-Object IO.MemoryStream
        $script:Sem.Stream = $ms
        Invoke-SemRequest -Req $req
        $script:Sem.Stream = $null
        $text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
        $split = $text.IndexOf("`r`n`r`n")
        $head = $text.Substring(0, $split)
        [pscustomobject]@{ Status = [int]($head.Split(' ')[1]); Head = $head; Body = $text.Substring($split + 4) }
    }
    function Get-Auth { return @{ 'X-Semaphore-Session' = $script:Sem.Token } }
}

AfterAll {
    Remove-Item -LiteralPath $script:TestHome -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:TestWeb -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path ([IO.Path]::GetTempPath()) 'sem-secret.txt') -Force -ErrorAction SilentlyContinue
}

Describe 'Host and Origin gate' {
    It 'accepts Host <H> with Origin <O>' -TestCases @(
        @{ H = '127.0.0.1:8774'; O = '' }, @{ H = 'localhost:8774'; O = '' },
        @{ H = '127.0.0.1:8774'; O = 'http://127.0.0.1:8774' }, @{ H = 'LOCALHOST:8774'; O = 'http://localhost:8774' }
    ) {
        $hd = @{ Host = $H }; if ($O) { $hd['Origin'] = $O }
        $d = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($k in $hd.Keys) { $d[$k] = $hd[$k] }
        Test-SemRequestOrigin -RemoteAddress ([Net.IPAddress]::Loopback) -Headers $d -Port 8774 | Should -BeTrue
    }

    It 'refuses Host <H> with Origin <O>' -TestCases @(
        @{ H = 'evil.example:8774'; O = '' }, @{ H = '127.0.0.1:8775'; O = '' }, @{ H = '127.0.0.1'; O = '' }, @{ H = ''; O = '' },
        @{ H = '192.168.1.5:8774'; O = '' }, @{ H = '127.0.0.1:8774'; O = 'http://evil.example' }, @{ H = '127.0.0.1:8774'; O = 'null' },
        @{ H = '127.0.0.1:8774'; O = 'http://127.0.0.1:8775' }, @{ H = '127.0.0.1:8774'; O = 'https://127.0.0.1:8774' }
    ) {
        $d = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        if ($H) { $d['Host'] = $H }
        if ($O) { $d['Origin'] = $O }
        Test-SemRequestOrigin -RemoteAddress ([Net.IPAddress]::Loopback) -Headers $d -Port 8774 | Should -BeFalse
    }

    It 'refuses a caller that is not on loopback' {
        $d = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        $d['Host'] = '127.0.0.1:8774'
        Test-SemRequestOrigin -RemoteAddress ([Net.IPAddress]::Parse('10.0.0.8')) -Headers $d -Port 8774 | Should -BeFalse
        (Invoke-TestRequest -Path '/api/info' -Headers (Get-Auth) -Remote ([Net.IPAddress]::Parse('10.0.0.8'))).Status | Should -Be 403
    }

    It 'answers 403 for a foreign Host or Origin, even with the right token' {
        $a = Get-Auth; $a['Host'] = 'attacker.example:8774'
        (Invoke-TestRequest -Path '/api/info' -Headers $a -NoHost).Status | Should -Be 403
        $a = Get-Auth; $a['Origin'] = 'http://attacker.example'
        (Invoke-TestRequest -Path '/api/info' -Headers $a).Status | Should -Be 403
        (Invoke-TestRequest -Path '/' -Headers @{ Host = 'attacker.example:8774' } -NoHost).Status | Should -Be 403
    }

    It 'sends the security headers on every response' {
        $r = Invoke-TestRequest -Path '/api/info' -Headers (Get-Auth)
        $r.Head | Should -Match "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        $r.Head | Should -Match 'X-Content-Type-Options: nosniff'
        $r.Head | Should -Match 'Referrer-Policy: no-referrer'
        $r.Head | Should -Match 'Cache-Control: no-store'
        (Invoke-TestRequest -Path '/assets/app.js').Head | Should -Match 'X-Content-Type-Options: nosniff'
    }
}

Describe 'Session token' {
    It 'is 32 random bytes, base64url, different each time' {
        $a = New-SemToken; $b = New-SemToken
        $a | Should -Match '^[A-Za-z0-9_-]{43}$'
        $a | Should -Not -Be $b
    }

    It 'compares strings exactly' {
        Test-SemStringsEqual 'abc' 'abc' | Should -BeTrue
        Test-SemStringsEqual 'abc' 'abd' | Should -BeFalse
        Test-SemStringsEqual 'abc' 'abcd' | Should -BeFalse
        Test-SemStringsEqual '' '' | Should -BeFalse
        Test-SemStringsEqual $null 'a' | Should -BeFalse
    }

    It 'refuses /api calls without the header or with a wrong token (401)' {
        (Invoke-TestRequest -Path '/api/info').Status | Should -Be 401
        (Invoke-TestRequest -Path '/api/info' -Headers @{ 'X-Semaphore-Session' = 'wrong' }).Status | Should -Be 401
        (Invoke-TestRequest -Method 'POST' -Path '/api/end').Status | Should -Be 401
        (Invoke-TestRequest -Path '/api/hoists').Status | Should -Be 401
    }

    It 'serves /api/info with the token' {
        $r = Invoke-TestRequest -Path '/api/info' -Headers (Get-Auth)
        $r.Status | Should -Be 200
        $j = $r.Body | ConvertFrom-Json
        $j.tool | Should -Be 'semaphore'
        $j.version | Should -Be '0.2.0'
        $j.port | Should -Be 8774
        $j.autoStop | Should -BeTrue
        $r.Body | Should -Not -Match ([regex]::Escape($script:Sem.Token))
    }

    It 'accepts the token in the JSON body of /api/leaving only' {
        $body = '{"token":"' + $script:Sem.Token + '","tab":"t1"}'
        (Invoke-TestRequest -Method 'POST' -Path '/api/leaving' -Body $body).Status | Should -Be 204
        (Invoke-TestRequest -Method 'POST' -Path '/api/leaving' -Body '{"token":"nope","tab":"t1"}').Status | Should -Be 401
        (Invoke-TestRequest -Method 'POST' -Path '/api/heartbeat' -Body $body).Status | Should -Be 401
        (Invoke-TestRequest -Method 'POST' -Path '/api/info' -Body $body).Status | Should -Be 401
    }

    It 'never reads the token from the query string' {
        $h = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        $h['Host'] = '127.0.0.1:8774'
        $req = @{ Method = 'POST'; Path = '/api/leaving'; Query = 'token=' + $script:Sem.Token; Headers = $h; ContentLength = 0; Body = (New-Object byte[] 0); Json = $null; RemoteAddress = [Net.IPAddress]::Loopback; Client = $null }
        $ms = New-Object IO.MemoryStream; $script:Sem.Stream = $ms
        Invoke-SemRequest -Req $req
        [Text.Encoding]::UTF8.GetString($ms.ToArray()) | Should -Match '^HTTP/1.1 401'
    }

    It 'parses a request line and refuses odd paths and bodies' {
        (ConvertFrom-SemRequestHead -Text "GET /api/info?x=1 HTTP/1.1`r`nHost: 127.0.0.1:8774" -RemoteAddress ([Net.IPAddress]::Loopback)).Path | Should -Be '/api/info'
        (ConvertFrom-SemRequestHead -Text "GET /a\b HTTP/1.1`r`nHost: x").ErrorStatus | Should -Be 400
        (ConvertFrom-SemRequestHead -Text "GET /%2e%2e/x HTTP/1.1`r`nHost: x").ErrorStatus | Should -Be 400
        (ConvertFrom-SemRequestHead -Text "POST /api/query HTTP/1.1`r`nTransfer-Encoding: chunked").ErrorStatus | Should -Be 400
        (ConvertFrom-SemRequestHead -Text "POST /api/query HTTP/1.1`r`nContent-Length: 1`r`nContent-Length: 2").ErrorStatus | Should -Be 400
        (ConvertFrom-SemRequestHead -Text "POST /api/query HTTP/1.1`r`nContent-Length: 9000000").ErrorStatus | Should -Be 413
    }
}

Describe 'Static files' {
    It 'serves files under web\dist and falls back to index.html for app routes' {
        (Resolve-SemStaticFile -WebRoot $script:TestWeb -Path '/assets/app.js').Kind | Should -Be 'file'
        (Resolve-SemStaticFile -WebRoot $script:TestWeb -Path '/').Kind | Should -Be 'index'
        (Resolve-SemStaticFile -WebRoot $script:TestWeb -Path '/hoist/fleet').Kind | Should -Be 'index'
        (Resolve-SemStaticFile -WebRoot $script:TestWeb -Path '/missing.js').Kind | Should -Be 'missing'
        $r = Invoke-TestRequest -Path '/assets/app.js'
        $r.Status | Should -Be 200
        $r.Head | Should -Match 'Content-Type: text/javascript'
        (Invoke-TestRequest -Path '/hoist/fleet').Body | Should -Match '<title>t</title>'
        (Invoke-TestRequest -Path '/nope.css').Status | Should -Be 404
    }

    It 'refuses path traversal <P>' -TestCases @(
        @{ P = '/../sem-secret.txt' }, @{ P = '/assets/../../sem-secret.txt' }, @{ P = '/..' }, @{ P = '/./index.html' },
        @{ P = '/.git/config' }, @{ P = '/assets/..\..\x' }, @{ P = '/C:/Windows/win.ini' }, @{ P = '//etc/passwd' }
    ) {
        (Resolve-SemStaticFile -WebRoot $script:TestWeb -Path $P).Kind | Should -Be 'refused'
    }

    It 'refuses other methods on static paths' {
        (Invoke-TestRequest -Method 'POST' -Path '/index.html').Status | Should -Be 405
    }

    It 'serves a "not built" page when web\dist\index.html is missing' {
        $empty = Join-Path ([IO.Path]::GetTempPath()) ('sem-empty-' + [guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($empty)
        $old = $script:Sem.WebRoot
        try {
            $script:Sem.WebRoot = $empty
            $r = Invoke-TestRequest -Path '/'
            $r.Status | Should -Be 200
            $r.Body | Should -Match 'npm ci &amp;&amp; npm run build'
            (Invoke-TestRequest -Path '/app/route').Status | Should -Be 200
            (Invoke-TestRequest -Path '/x.js').Status | Should -Be 404
        } finally { $script:Sem.WebRoot = $old; Remove-Item -LiteralPath $empty -Recurse -Force }
    }
}

Describe 'Hoists and catalogs' {
    It 'validates ids: <Id> -> <Ok>' -TestCases @(
        @{ Id = 'fleet-maintenance'; Ok = $true }, @{ Id = 'A_b-9'; Ok = $true }, @{ Id = ('x' * 64); Ok = $true },
        @{ Id = ''; Ok = $false }, @{ Id = ('x' * 65); Ok = $false }, @{ Id = 'a.b'; Ok = $false }, @{ Id = '..'; Ok = $false },
        @{ Id = 'a b'; Ok = $false }, @{ Id = "a`n"; Ok = $false }, @{ Id = 'caf' + [char]0xE9; Ok = $false }
    ) {
        Test-SemDocId $Id | Should -Be $Ok
    }

    It 'answers 400 for an invalid id in the URL' {
        (Invoke-TestRequest -Path '/api/hoists/a.b' -Headers (Get-Auth)).Status | Should -Be 400
        (Invoke-TestRequest -Path ('/api/catalogs/' + ('x' * 65)) -Headers (Get-Auth)).Status | Should -Be 400
        (Invoke-TestRequest -Path '/api/hoists/' -Headers (Get-Auth)).Status | Should -Be 400
    }

    It 'saves, lists, reads verbatim and deletes a hoist' {
        $a = Get-Auth
        $body = '{ "version": 1, "id": "h1", "title": "First", "updated": "2026-10-26T10:00:00.000Z", "flags": [] }'
        (Invoke-TestRequest -Path '/api/hoists' -Headers $a).Body | Should -Be '[]'
        $r = Invoke-TestRequest -Method 'PUT' -Path '/api/hoists/h1' -Headers $a -Body $body
        $r.Status | Should -Be 200
        $r.Body | Should -Be '{"ok":true}'
        $list = (Invoke-TestRequest -Path '/api/hoists' -Headers $a).Body | ConvertFrom-Json
        @($list).Count | Should -Be 1
        $list[0].id | Should -Be 'h1'
        $list[0].title | Should -Be 'First'
        (Invoke-TestRequest -Path '/api/hoists/h1' -Headers $a).Body | Should -Be $body
        (Invoke-TestRequest -Method 'DELETE' -Path '/api/hoists/h1' -Headers $a).Status | Should -Be 200
        (Invoke-TestRequest -Path '/api/hoists/h1' -Headers $a).Status | Should -Be 404
        @(Get-ChildItem -LiteralPath ([IO.Path]::Combine($script:Sem.Home, 'hoists', '.trash')) -Filter 'h1-*.json').Count | Should -Be 1
        (Invoke-TestRequest -Method 'DELETE' -Path '/api/hoists/h1' -Headers $a).Status | Should -Be 404
    }

    It 'refuses a document that is not a version 1 JSON object' {
        $a = Get-Auth
        (Invoke-TestRequest -Method 'PUT' -Path '/api/catalogs/c1' -Headers $a -Body '{"version":2}').Status | Should -Be 400
        (Invoke-TestRequest -Method 'PUT' -Path '/api/catalogs/c1' -Headers $a -Body '[{"version":1}]').Status | Should -Be 400
        (Invoke-TestRequest -Method 'PUT' -Path '/api/catalogs/c1' -Headers $a -Body '{"version":"1"}').Status | Should -Be 400
        (Invoke-TestRequest -Method 'PUT' -Path '/api/catalogs/c1' -Headers $a -Body 'not json').Status | Should -Be 400
        (Invoke-TestRequest -Method 'PUT' -Path '/api/catalogs/c1' -Headers $a -Body ('{"version":1,"x":"' + ('a' * 2100000) + '"}')).Status | Should -Be 413
        (Invoke-TestRequest -Method 'PUT' -Path '/api/catalogs/c1' -Headers $a -Body '{"version":1,"sources":[]}').Status | Should -Be 200
    }
}

Describe 'SQL guard and parameters' {
    It 'allows a plain SELECT' {
        Test-SemSqlGuard 'SELECT "region", SUM("cost") AS "m0" FROM "jobs" WHERE "opened" >= ? GROUP BY "region"' | Should -BeNullOrEmpty
        Test-SemSqlGuard "  select [a] from [t]  " | Should -BeNullOrEmpty
    }

    It 'refuses <Why>' -TestCases @(
        @{ Why = 'empty'; Sql = '   ' }, @{ Why = 'not a SELECT'; Sql = 'DELETE FROM t' }, @{ Why = 'WITH'; Sql = 'WITH x AS (SELECT 1) SELECT * FROM x' },
        @{ Why = 'a semicolon'; Sql = 'SELECT 1; DROP TABLE t' }, @{ Why = 'a line comment'; Sql = 'SELECT 1 -- x' },
        @{ Why = 'a block comment'; Sql = 'SELECT /* x */ 1' }, @{ Why = 'SELECTINTO-like prefix'; Sql = 'SELECTX 1' },
        @{ Why = 'over 100 KB'; Sql = ('SELECT ' + ('a' * 102400)) },
        @{ Why = 'SELECT INTO (makes a table)'; Sql = 'SELECT * INTO copy_of_jobs FROM jobs' }
    ) {
        Test-SemSqlGuard $Sql | Should -Not -BeNullOrEmpty
    }

    It 'types parameter values' {
        $p = ConvertTo-SemParamValue -Param ('{"value":"2026-01-31","type":"date"}' | ConvertFrom-Json)
        $p.Value | Should -BeOfType [datetime]
        $p.Value.ToString('yyyy-MM-dd') | Should -Be '2026-01-31'
        (ConvertTo-SemParamValue -Param ('{"value":12.5,"type":"number"}' | ConvertFrom-Json)).Value | Should -BeOfType [double]
        (ConvertTo-SemParamValue -Param ('{"value":"7","type":"number"}' | ConvertFrom-Json)).Value | Should -Be 7
        (ConvertTo-SemParamValue -Param ('{"value":true,"type":"boolean"}' | ConvertFrom-Json)).Value | Should -BeTrue
        (ConvertTo-SemParamValue -Param ('{"value":"Northeast","type":"string"}' | ConvertFrom-Json)).Value | Should -Be 'Northeast'
        (ConvertTo-SemParamValue -Param ('{"value":null,"type":"string"}' | ConvertFrom-Json)).Value | Should -BeOfType [DBNull]
    }

    It 'refuses a bad parameter: <J>' -TestCases @(
        @{ J = '{"value":"2026-02-30","type":"date"}' }, @{ J = '{"value":"31/01/2026","type":"date"}' }, @{ J = '{"value":"abc","type":"number"}' },
        @{ J = '{"value":true,"type":"number"}' }, @{ J = '{"value":"yes","type":"boolean"}' }, @{ J = '{"value":1,"type":"blob"}' }
    ) {
        { ConvertTo-SemParamValue -Param ($J | ConvertFrom-Json) } | Should -Throw
    }

    It 'plans a query: unknown source 404, password 400, guard 400, bounds' {
        [IO.File]::WriteAllText((Join-Path $script:Sem.Home 'sources.json'), '[{"id":"maint","label":"M","kind":"postgres","provider":"odbc","connection":"DSN=Maint"},{"id":"pw","kind":"oracle","provider":"odbc","connection":"DSN=X;PWD=secret"},{"id":"bad","provider":"sqlclient","connection":"x"}]')
        $plan = Get-SemQueryPlan -Body ('{"source":"nope","sql":"SELECT 1"}' | ConvertFrom-Json) -HomeDir $script:Sem.Home
        $plan.Error.Status | Should -Be 404
        $plan = Get-SemQueryPlan -Body ('{"source":"pw","sql":"SELECT 1"}' | ConvertFrom-Json) -HomeDir $script:Sem.Home
        $plan.Error.Code | Should -Be 'credentials-in-connection'
        $plan = Get-SemQueryPlan -Body ('{"source":"maint","sql":"UPDATE t SET a=1"}' | ConvertFrom-Json) -HomeDir $script:Sem.Home
        $plan.Error.Code | Should -Be 'sql-refused'
        $many = '[' + ((1..2001 | ForEach-Object { '{"value":1,"type":"number"}' }) -join ',') + ']'
        $plan = Get-SemQueryPlan -Body ('{"source":"maint","sql":"SELECT 1","params":' + $many + '}' | ConvertFrom-Json) -HomeDir $script:Sem.Home
        $plan.Error.Code | Should -Be 'too-many-params'
        $plan = Get-SemQueryPlan -Body ('{"source":"maint","sql":" SELECT 1 ","params":[{"value":"2026-01-01","type":"date"}],"rowCap":999999,"timeoutSec":0}' | ConvertFrom-Json) -HomeDir $script:Sem.Home
        $plan.ContainsKey('Error') | Should -BeFalse
        $plan.Sql | Should -Be 'SELECT 1'
        $plan.RowCap | Should -Be 200000
        $plan.TimeoutSec | Should -Be 1
        $plan = Get-SemQueryPlan -Body ('{"source":"maint","sql":"SELECT 1"}' | ConvertFrom-Json) -HomeDir $script:Sem.Home
        $plan.RowCap | Should -Be 50000
        $plan.TimeoutSec | Should -Be 60
    }

    It 'lists sources without their connection strings' {
        $r = Invoke-TestRequest -Path '/api/info' -Headers (Get-Auth)
        $j = $r.Body | ConvertFrom-Json
        @($j.sources).Count | Should -Be 2
        $j.sources[0].id | Should -Be 'maint'
        $j.sources[0].placeholders | Should -Be 'question'
        $r.Body | Should -Not -Match 'DSN=|PWD='
    }

    It 'checks and quotes identifiers like catalog.ts isIdentifier()' {
        Test-SemIdentifier 'jobs' | Should -BeTrue
        Test-SemIdentifier 'dbo.Work Orders' | Should -BeTrue
        Test-SemIdentifier 'a.b.c' | Should -BeFalse
        Test-SemIdentifier 'x"; DROP' | Should -BeFalse
        Test-SemIdentifier '1abc' | Should -BeFalse
        Get-SemQuotedName -Name 'dbo.Work Orders' -Brackets $true | Should -Be '[dbo].[Work Orders]'
        Get-SemQuotedName -Name 'public.jobs' -Brackets $false | Should -Be '"public"."jobs"'
        Get-SemQuotedColumn -Name 'a]b' -Brackets $true | Should -Be '[a]]b]'
        Get-SemQuotedColumn -Name 'a"b' -Brackets $false | Should -Be '"a""b"'
    }

    It 'refuses connection strings with a password' {
        Test-SemConnectionString 'DSN=Maint' | Should -BeNullOrEmpty
        Test-SemConnectionString 'Provider=Microsoft.ACE.OLEDB.12.0;Data Source=C:\d\x.accdb' | Should -BeNullOrEmpty
        Test-SemConnectionString 'DSN=X;PWD=s' | Should -Not -BeNullOrEmpty
        Test-SemConnectionString 'Driver={x};Server=y; password = s' | Should -Not -BeNullOrEmpty
        Get-SemSafeMessage -Message 'login failed for DSN=X;UID=bob;PWD=s' -Source ([pscustomobject]@{ connection = 'DSN=Z' }) | Should -Not -Match 'bob|=s'
    }
}
