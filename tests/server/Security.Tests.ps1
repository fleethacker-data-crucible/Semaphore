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
    . ([IO.Path]::Combine($server, 'Connectors.ps1'))

    $script:TestHome = Join-Path ([IO.Path]::GetTempPath()) ('sem-home-' + [guid]::NewGuid().ToString('N'))
    $script:TestWeb = Join-Path ([IO.Path]::GetTempPath()) ('sem-web-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory((Join-Path $script:TestWeb 'assets'))
    [IO.File]::WriteAllText((Join-Path $script:TestWeb 'index.html'), '<!doctype html><title>t</title>')
    [IO.File]::WriteAllText([IO.Path]::Combine($script:TestWeb, 'assets', 'app.js'), 'console.log(1)')
    [IO.File]::WriteAllText((Join-Path ([IO.Path]::GetTempPath()) 'sem-secret.txt'), 'secret')

    $script:Sem.Port = 8800
    $script:Sem.Token = New-SemToken
    $script:Sem.Version = '0.2.0'
    $script:Sem.WebRoot = $script:TestWeb
    $script:Sem.Home = Resolve-SemHome -Settings @{ home = $script:TestHome } -Create
    Initialize-SemPresence -AutoStop $true

    function Invoke-TestRequest {
        param([string]$Method = 'GET', [string]$Path = '/', [hashtable]$Headers = @{}, [string]$Body = '', [switch]$NoHost, $Remote = [Net.IPAddress]::Loopback)
        $h = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        if (-not $NoHost) { $h['Host'] = '127.0.0.1:8800' }
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
        @{ H = '127.0.0.1:8800'; O = '' }, @{ H = 'localhost:8800'; O = '' },
        @{ H = '127.0.0.1:8800'; O = 'http://127.0.0.1:8800' }, @{ H = 'LOCALHOST:8800'; O = 'http://localhost:8800' }
    ) {
        $hd = @{ Host = $H }; if ($O) { $hd['Origin'] = $O }
        $d = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($k in $hd.Keys) { $d[$k] = $hd[$k] }
        Test-SemRequestOrigin -RemoteAddress ([Net.IPAddress]::Loopback) -Headers $d -Port 8800 | Should -BeTrue
    }

    It 'refuses Host <H> with Origin <O>' -TestCases @(
        @{ H = 'evil.example:8800'; O = '' }, @{ H = '127.0.0.1:8775'; O = '' }, @{ H = '127.0.0.1'; O = '' }, @{ H = ''; O = '' },
        @{ H = '192.168.1.5:8800'; O = '' }, @{ H = '127.0.0.1:8800'; O = 'http://evil.example' }, @{ H = '127.0.0.1:8800'; O = 'null' },
        @{ H = '127.0.0.1:8800'; O = 'http://127.0.0.1:8775' }, @{ H = '127.0.0.1:8800'; O = 'https://127.0.0.1:8800' }
    ) {
        $d = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        if ($H) { $d['Host'] = $H }
        if ($O) { $d['Origin'] = $O }
        Test-SemRequestOrigin -RemoteAddress ([Net.IPAddress]::Loopback) -Headers $d -Port 8800 | Should -BeFalse
    }

    It 'refuses a caller that is not on loopback' {
        $d = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        $d['Host'] = '127.0.0.1:8800'
        Test-SemRequestOrigin -RemoteAddress ([Net.IPAddress]::Parse('10.0.0.8')) -Headers $d -Port 8800 | Should -BeFalse
        (Invoke-TestRequest -Path '/api/info' -Headers (Get-Auth) -Remote ([Net.IPAddress]::Parse('10.0.0.8'))).Status | Should -Be 403
    }

    It 'answers 403 for a foreign Host or Origin, even with the right token' {
        $a = Get-Auth; $a['Host'] = 'attacker.example:8800'
        (Invoke-TestRequest -Path '/api/info' -Headers $a -NoHost).Status | Should -Be 403
        $a = Get-Auth; $a['Origin'] = 'http://attacker.example'
        (Invoke-TestRequest -Path '/api/info' -Headers $a).Status | Should -Be 403
        (Invoke-TestRequest -Path '/' -Headers @{ Host = 'attacker.example:8800' } -NoHost).Status | Should -Be 403
    }

    It 'sends exactly the security header set on every response' {
        $csp = "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        $want = @(
            $csp,
            'X-Content-Type-Options: nosniff',
            'Referrer-Policy: no-referrer',
            'X-Frame-Options: DENY',
            'Cross-Origin-Resource-Policy: same-origin',
            'Cross-Origin-Opener-Policy: same-origin',
            'Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=()'
        )
        foreach ($r in @((Invoke-TestRequest -Path '/api/info' -Headers (Get-Auth)), (Invoke-TestRequest -Path '/assets/app.js'), (Invoke-TestRequest -Path '/'), (Invoke-TestRequest -Path '/api/info'))) {
            $lines = @($r.Head -split "`r`n" | Select-Object -Skip 1)
            $security = @($lines | Where-Object { $_ -notmatch '^(Content-Type|Content-Length|Connection|Cache-Control|ETag):' })
            ($security -join "`n") | Should -Be ($want -join "`n")
            @($lines | Where-Object { $_ -match '^Cache-Control:' }).Count | Should -Be 1
        }
        (Invoke-TestRequest -Path '/api/info' -Headers (Get-Auth)).Head | Should -Match 'Cache-Control: no-store'
        $script:SemCsp | Should -Not -Match "style-src 'self' 'unsafe-inline'"
        $script:SemCsp | Should -Not -Match "script-src[^;]*unsafe"
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
        $j.port | Should -Be 8800
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

    It 'trades a launch code for the token once' {
        $code = New-SemLaunchCode
        $code | Should -Not -Be $script:Sem.Token
        $r = Invoke-TestRequest -Method 'POST' -Path '/api/launch' -Body ('{"code":"' + $code + '"}')
        $r.Status | Should -Be 200
        $r.Head | Should -Match 'Cache-Control: no-store'
        ($r.Body | ConvertFrom-Json).token | Should -Be $script:Sem.Token
        $again = Invoke-TestRequest -Method 'POST' -Path '/api/launch' -Body ('{"code":"' + $code + '"}')
        $again.Status | Should -Be 401
        $again.Body | Should -Not -Match ([regex]::Escape($script:Sem.Token))
    }

    It 'refuses an unknown, expired, missing or non-POST launch code' {
        (Invoke-TestRequest -Method 'POST' -Path '/api/launch' -Body '{"code":"nope"}').Status | Should -Be 401
        (Invoke-TestRequest -Method 'POST' -Path '/api/launch' -Body '{}').Status | Should -Be 401
        (Invoke-TestRequest -Method 'POST' -Path '/api/launch' -Body ('{"code":"' + $script:Sem.Token + '"}')).Status | Should -Be 401
        (Invoke-TestRequest -Method 'GET' -Path '/api/launch').Status | Should -Be 405
        $old = New-SemLaunchCode
        $script:Sem.LaunchCodes[$old] = (Get-Date).ToUniversalTime().AddSeconds(-1)
        (Invoke-TestRequest -Method 'POST' -Path '/api/launch' -Body ('{"code":"' + $old + '"}')).Status | Should -Be 401
        $script:Sem.LaunchCodes.ContainsKey($old) | Should -BeFalse
    }

    It 'refuses a launch code from another origin' {
        $code = New-SemLaunchCode
        (Invoke-TestRequest -Method 'POST' -Path '/api/launch' -Headers @{ Origin = 'http://evil.example' } -Body ('{"code":"' + $code + '"}')).Status | Should -Be 403
    }

    It 'puts a launch code, never the token, in the launch link' {
        $src = [IO.File]::ReadAllText([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server', 'Start-Semaphore.ps1'))
        $src | Should -Not -Match '\?session='
        $src | Should -Not -Match 'Sem\.Token\s*\+'
        $src | Should -Match '\?launch='
    }

    It 'tells a source-code copy where the ready-to-run zip is' {
        $page = Get-SemNotBuiltPage
        $page | Should -Match 'releases/latest'
        $page | Should -Match 'Semaphore-0\.2\.0\.zip'
        $page | Should -Match 'Unblock'
    }

    It 'never reads the token from the query string' {
        $h = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        $h['Host'] = '127.0.0.1:8800'
        $req = @{ Method = 'POST'; Path = '/api/leaving'; Query = 'token=' + $script:Sem.Token; Headers = $h; ContentLength = 0; Body = (New-Object byte[] 0); Json = $null; RemoteAddress = [Net.IPAddress]::Loopback; Client = $null }
        $ms = New-Object IO.MemoryStream; $script:Sem.Stream = $ms
        Invoke-SemRequest -Req $req
        [Text.Encoding]::UTF8.GetString($ms.ToArray()) | Should -Match '^HTTP/1.1 401'
    }

    It 'parses a request line and refuses odd paths and bodies' {
        (ConvertFrom-SemRequestHead -Text "GET /api/info?x=1 HTTP/1.1`r`nHost: 127.0.0.1:8800" -RemoteAddress ([Net.IPAddress]::Loopback)).Path | Should -Be '/api/info'
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
            $r.Body | Should -Match 'npm ci</code> then <code>npm run build'
            (Invoke-TestRequest -Path '/app/route').Status | Should -Be 200
            (Invoke-TestRequest -Path '/x.js').Status | Should -Be 404
        } finally { $script:Sem.WebRoot = $old; Remove-Item -LiteralPath $empty -Recurse -Force }
    }
}

Describe 'Caching (hashed assets)' {
    BeforeAll {
        foreach ($n in 'app.c3a35325b2.js', 'app.c3a35325b2.css', 'index-AB12cd34.js', 'worker.c030cbd1d1.js', 'short.ab12.js') {
            [IO.File]::WriteAllText([IO.Path]::Combine($script:TestWeb, 'assets', $n), 'x')
        }
        [IO.File]::WriteAllText((Join-Path $script:TestWeb 'favicon.ico'), 'x')
        [void][IO.Directory]::CreateDirectory((Join-Path $script:TestWeb 'brand'))
        [IO.File]::WriteAllText([IO.Path]::Combine($script:TestWeb, 'brand', 'logo.12345678.png'), 'x')
    }

    It 'serves hashed files under /assets/ as immutable: <P>' -TestCases @(
        @{ P = '/assets/app.c3a35325b2.js' }, @{ P = '/assets/app.c3a35325b2.css' }, @{ P = '/assets/index-AB12cd34.js' }, @{ P = '/assets/worker.c030cbd1d1.js' }
    ) {
        $r = Invoke-TestRequest -Path $P
        $r.Status | Should -Be 200
        $r.Head | Should -Match 'Cache-Control: public, max-age=31536000, immutable'
    }

    It 'revalidates files without a hash, or outside /assets/: <P>' -TestCases @(
        @{ P = '/assets/app.js' }, @{ P = '/assets/short.ab12.js' }, @{ P = '/favicon.ico' }, @{ P = '/brand/logo.12345678.png' }
    ) {
        $r = Invoke-TestRequest -Path $P
        $r.Status | Should -Be 200
        $r.Head | Should -Match 'Cache-Control: no-cache'
        $r.Head | Should -Not -Match 'immutable'
    }

    It 'never caches index.html, the app-route fallback or the API' {
        (Invoke-TestRequest -Path '/').Head | Should -Match 'Cache-Control: no-store'
        (Invoke-TestRequest -Path '/index.html').Head | Should -Match 'Cache-Control: no-store'
        (Invoke-TestRequest -Path '/hoist/fleet').Head | Should -Match 'Cache-Control: no-store'
        (Invoke-TestRequest -Path '/api/info' -Headers (Get-Auth)).Head | Should -Match 'Cache-Control: no-store'
    }

    It 'allows the "not built" page''s own style element by its hash only' {
        $csp = Get-SemNotBuiltCsp
        $csp | Should -Match "style-src 'self' 'sha256-[A-Za-z0-9+/]{43}=';"
        $csp | Should -Not -Match "style-src [^;]*'unsafe-inline'"
        (Get-SemNotBuiltPage) | Should -Match ('<style>' + [regex]::Escape($script:SemNotBuiltStyle) + '</style>')
    }
}

Describe 'Client error log' {
    BeforeEach {
        $script:SemClientLogTimes.Clear()
        $script:SemLogPath = Join-Path $script:TestHome ('client-' + [guid]::NewGuid().ToString('N') + '.log')
    }
    AfterEach { $script:SemLogPath = $null }

    It 'writes one line with message, view and stack, and answers 204' {
        $body = '{"level":"error","message":"Cannot read x","stack":"at A (app.js:1)\nat B (app.js:2)","view":"builder","rows":[{"secret":"value-123"}]}'
        $r = Invoke-TestRequest -Method 'POST' -Path '/api/client-log' -Headers (Get-Auth) -Body $body
        $r.Status | Should -Be 204
        $lines = @([IO.File]::ReadAllLines($script:SemLogPath))
        $lines.Count | Should -Be 1
        $lines[0] | Should -Match '\[ERROR\] Page error: Cannot read x \(view: builder\) stack: at A \(app\.js:1\) \| at B \(app\.js:2\)$'
        $lines[0] | Should -Not -Match 'value-123'
    }

    It 'cannot forge a log line with CR or LF in any field' {
        $forged = '{"level":"warn","message":"ok\r\n2026-11-06 10:00:00  [INFO] Saved hoist evil","view":"a\rb\u2028c","stack":"s\n\n[ERROR] x"}'
        (Invoke-TestRequest -Method 'POST' -Path '/api/client-log' -Headers (Get-Auth) -Body $forged).Status | Should -Be 204
        $text = [IO.File]::ReadAllText($script:SemLogPath)
        @([IO.File]::ReadAllLines($script:SemLogPath)).Count | Should -Be 1
        ($text.TrimEnd("`r", "`n")) | Should -Not -Match "[`r`n]"
        $text | Should -Match '\[WARN\] Page warn: ok \| 2026-11-06'
    }

    It 'needs the session token' {
        (Invoke-TestRequest -Method 'POST' -Path '/api/client-log' -Body '{"level":"error","message":"x"}').Status | Should -Be 401
        [IO.File]::Exists($script:SemLogPath) | Should -BeFalse
    }

    It 'refuses a body over 4 KB, a bad level, a missing message and other methods' {
        $big = '{"level":"error","message":"' + ('m' * 4100) + '"}'
        (Invoke-TestRequest -Method 'POST' -Path '/api/client-log' -Headers (Get-Auth) -Body $big).Status | Should -Be 413
        $max = '{"level":"error","message":"' + ('m' * (4096 - 30)) + '"}'
        (Invoke-TestRequest -Method 'POST' -Path '/api/client-log' -Headers (Get-Auth) -Body $max).Status | Should -Be 204
        (Invoke-TestRequest -Method 'POST' -Path '/api/client-log' -Headers (Get-Auth) -Body '{"level":"info","message":"x"}').Status | Should -Be 400
        (Invoke-TestRequest -Method 'POST' -Path '/api/client-log' -Headers (Get-Auth) -Body '{"level":"error"}').Status | Should -Be 400
        (Invoke-TestRequest -Method 'POST' -Path '/api/client-log' -Headers (Get-Auth) -Body '{"level":"error","message":{"a":1}}').Status | Should -Be 400
        (Invoke-TestRequest -Method 'GET' -Path '/api/client-log' -Headers (Get-Auth)).Status | Should -Be 405
    }

    It 'takes 20 reports a minute, then answers 429' {
        for ($i = 0; $i -lt 20; $i++) {
            (Invoke-TestRequest -Method 'POST' -Path '/api/client-log' -Headers (Get-Auth) -Body ('{"level":"warn","message":"n' + $i + '"}')).Status | Should -Be 204
        }
        $r = Invoke-TestRequest -Method 'POST' -Path '/api/client-log' -Headers (Get-Auth) -Body '{"level":"warn","message":"one more"}'
        $r.Status | Should -Be 429
        ($r.Body | ConvertFrom-Json).code | Should -Be 'rate'
        @([IO.File]::ReadAllLines($script:SemLogPath)).Count | Should -Be 20
        # A minute later the window has moved on.
        Test-SemClientLogRate -Now ((Get-Date).AddSeconds(61)) | Should -BeTrue
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
        $r.Body | Should -Be ('{"ok":true,"etag":"' + (Get-SemSha256Hex ([Text.Encoding]::UTF8.GetBytes($body))) + '"}')
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

Describe 'Body limits and request parsing' {
    It 'caps a document PUT at 2 MB before the body is read or parsed, and gives /api/query the long deadline' {
        $doc = Get-SemBodyLimit -Path '/api/hoists/h1'
        $doc.MaxBytes | Should -Be 2097152
        $doc.DeadlineMs | Should -Be 10000
        $doc.TooLarge | Should -BeLike '*2 MB*'
        (Get-SemBodyLimit -Path '/api/team/t1').MaxBytes | Should -Be 2097152
        $q = Get-SemBodyLimit -Path '/api/query'
        $q.MaxBytes | Should -Be 8388608
        $q.DeadlineMs | Should -Be 30000
        (Get-SemBodyLimit -Path '/api/heartbeat').DeadlineMs | Should -Be 10000
        (Get-SemBodyLimit -Path '/api/hoists').MaxBytes | Should -Be 8388608 -Because 'the list route takes no body; only /<id> is a document'
    }

    It 'refuses an oversized document before parsing it (the body is not JSON at all)' {
        $big = 'x' * 2097153
        $r = Invoke-TestRequest -Method 'PUT' -Path '/api/hoists/big' -Headers (Get-Auth) -Body $big
        $r.Status | Should -Be 413
        ($r.Body | ConvertFrom-Json).code | Should -Be 'too-large'
    }

    It 'parses the request line strictly: upper-case method only' {
        (ConvertFrom-SemRequestHead -Text "GET / HTTP/1.1`r`nHost: 127.0.0.1:8800").Method | Should -Be 'GET'
        (ConvertFrom-SemRequestHead -Text "get / HTTP/1.1`r`nHost: 127.0.0.1:8800").ErrorStatus | Should -Be 400
        (ConvertFrom-SemRequestHead -Text "GET / HTTP/1.1`r`nHost: 127.0.0.1:8800`r`nContent-Length: 2`r`nContent-Length: 2").ErrorMessage | Should -BeLike '*Duplicate*'
    }

    It 'answers HEAD on a missing or refused path with headers only' {
        foreach ($p in @('/assets/nope.js', '/..%2fsecret', '/.git/config')) {
            $r = Invoke-TestRequest -Method 'HEAD' -Path $p
            $r.Status | Should -Be 404
            $r.Body | Should -Be ''
            $r.Head | Should -Match 'Content-Length: \d+'
        }
        (Invoke-TestRequest -Method 'GET' -Path '/assets/nope.js').Body | Should -Match '"not-found"'
    }
}

Describe 'Refresh report' {
    BeforeAll {
        $script:SavedLog = $script:SemLogPath
        $script:ReportLog = Join-Path ([IO.Path]::GetTempPath()) ('sem-rr-' + [guid]::NewGuid().ToString('N') + '.log')
        $script:SemLogPath = $script:ReportLog
    }
    AfterAll {
        $script:SemLogPath = $script:SavedLog
        Remove-Item -LiteralPath $script:ReportLog -Force -ErrorAction SilentlyContinue
    }
    It 'folds page-supplied id, title and error into one log-safe line each, capped, in the log and the saved report' {
        $forged = "x`r`n2026-11-07 09:00:00  [INFO] Stopped (end)"
        $long = 'T' * 400
        $body = '{"refreshed":2,"skipped":0,"failed":[{"id":"' + ('i' * 100) + '","title":"' + $long + '","error":"' + ($forged -replace "`r", '\r' -replace "`n", '\n') + '"}]}'
        $r = Invoke-TestRequest -Method 'POST' -Path '/api/refresh-report' -Headers (Get-Auth) -Body $body
        $r.Status | Should -Be 200
        $saved = [IO.File]::ReadAllText([IO.Path]::Combine($script:Sem.Home, 'snapshots', '.last-refresh.json')) | ConvertFrom-Json
        $saved.failed[0].id.Length | Should -Be 67   # 64 + '...'
        $saved.failed[0].title.Length | Should -Be 203
        $saved.failed[0].error | Should -Be 'x | 2026-11-07 09:00:00  [INFO] Stopped (end)'
        $saved.failed[0].error | Should -Not -Match "`n"
        $lines = @([IO.File]::ReadAllLines($script:ReportLog) | Where-Object { $_ -match 'Snapshot failed' })
        $lines.Count | Should -Be 1
        $lines[0] | Should -Match 'x \| 2026-11-07 09:00:00  \[INFO\] Stopped \(end\)'
        @([IO.File]::ReadAllLines($script:ReportLog) | Where-Object { $_ -match '^2026-11-07 09:00:00  \[INFO\] Stopped' }).Count | Should -Be 0 -Because 'a forged line never starts a log entry'
        (Invoke-TestRequest -Method 'GET' -Path '/api/refresh-report' -Headers (Get-Auth)).Status | Should -Be 200
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
        @{ Why = 'SELECT INTO (makes a table)'; Sql = 'SELECT * INTO copy_of_jobs FROM jobs' },
        @{ Why = 'a second T-SQL statement with no semicolon (EXEC)'; Sql = 'SELECT 1 EXEC sp_who' },
        @{ Why = 'a second T-SQL statement with no semicolon (DROP)'; Sql = "SELECT 1 DROP TABLE t" },
        @{ Why = 'a second statement on a new line'; Sql = "SELECT 1`nDELETE FROM t WHERE 1=1" },
        @{ Why = 'a keyword in another case'; Sql = 'SELECT 1 execute sp_who' },
        @{ Why = 'a batch separator'; Sql = "SELECT 1`nGO`nTRUNCATE TABLE t" }
    ) {
        Test-SemSqlGuard $Sql | Should -Not -BeNullOrEmpty
    }

    It 'lets a statement keyword stand inside a string or a quoted name: <Why>' -TestCases @(
        @{ Why = 'a string literal'; Sql = "SELECT 'drop table x' AS note, 'exec' AS verb FROM t" },
        @{ Why = 'a bracketed column'; Sql = 'SELECT [update], [delete] FROM [insert]' },
        @{ Why = 'a double-quoted column'; Sql = 'SELECT "merge" FROM "jobs" WHERE "go" = ?' },
        @{ Why = 'a backtick name'; Sql = 'SELECT `create` FROM `t`' },
        @{ Why = 'a doubled quote inside a string'; Sql = "SELECT 'it''s drop' FROM t" },
        @{ Why = 'a word that only starts like one'; Sql = 'SELECT executed, dropped, created_at, updated_by FROM t' }
    ) {
        Test-SemSqlGuard $Sql | Should -BeNullOrEmpty
    }

    It 'names the keyword it refused' {
        Test-SemSqlGuard 'SELECT 1 EXEC sp_who' | Should -BeLike '*EXEC*'
        Remove-SemSqlQuoted "SELECT 'a''b' AS [x y], `"q`" FROM t" | Should -Be "SELECT ' '' ' AS [   ], `" `" FROM t"
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

Describe 'Save conflicts (ETag and If-Match) for every document kind' {
    BeforeAll {
        function script:Get-Etag([string]$Head) { if ($Head -match '(?m)^ETag: "([0-9a-f]{64})"\r?$') { return $Matches[1] }; return $null }
        function script:Hash([string]$Text) { return (Get-SemSha256Hex ([Text.Encoding]::UTF8.GetBytes($Text))) }
    }

    It 'sends the sha256 of the stored bytes as ETag and in the PUT answer: <Kind>' -TestCases @(
        @{ Kind = 'hoists' }, @{ Kind = 'catalogs' }, @{ Kind = 'playbook' }, @{ Kind = 'snapshots' }, @{ Kind = 'questions' }, @{ Kind = 'team' }
    ) {
        $a = Get-Auth
        $id = 'etag-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
        $body = '{"version":1,"title":"A"}'
        $put = Invoke-TestRequest -Method 'PUT' -Path "/api/$Kind/$id" -Headers $a -Body $body
        $put.Status | Should -Be 200
        ($put.Body | ConvertFrom-Json).etag | Should -Be (Hash $body)
        $get = Invoke-TestRequest -Path "/api/$Kind/$id" -Headers $a
        $get.Status | Should -Be 200
        Get-Etag $get.Head | Should -Be (Hash $body)
        $stored = [IO.File]::ReadAllBytes([IO.Path]::Combine($script:Sem.Home, $Kind, "$id.json"))
        Get-Etag $get.Head | Should -Be (Get-SemSha256Hex $stored)
    }

    It 'answers 409 "version" to the second of two saves from the same base, and keeps the first: <Kind>' -TestCases @(
        @{ Kind = 'hoists' }, @{ Kind = 'catalogs' }, @{ Kind = 'playbook' }, @{ Kind = 'snapshots' }, @{ Kind = 'questions' }, @{ Kind = 'team' }
    ) {
        $a = Get-Auth
        $id = 'race-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
        $base = '{"version":1,"title":"Base"}'
        (Invoke-TestRequest -Method 'PUT' -Path "/api/$Kind/$id" -Headers $a -Body $base).Status | Should -Be 200
        $etag = Get-Etag (Invoke-TestRequest -Path "/api/$Kind/$id" -Headers $a).Head
        $mine = $a.Clone(); $mine['If-Match'] = '"' + $etag + '"'
        $first = Invoke-TestRequest -Method 'PUT' -Path "/api/$Kind/$id" -Headers $mine -Body '{"version":1,"title":"Tab one"}'
        $first.Status | Should -Be 200
        $second = Invoke-TestRequest -Method 'PUT' -Path "/api/$Kind/$id" -Headers $mine -Body '{"version":1,"title":"Tab two"}'
        $second.Status | Should -Be 409
        $j = $second.Body | ConvertFrom-Json
        $j.code | Should -Be 'version'
        $j.error | Should -Not -BeNullOrEmpty
        $j.etag | Should -Be (Hash '{"version":1,"title":"Tab one"}')
        (Invoke-TestRequest -Path "/api/$Kind/$id" -Headers $a).Body | Should -Be '{"version":1,"title":"Tab one"}'
        # With the new ETag (after "Load theirs") the save goes through.
        $mine['If-Match'] = '"' + $j.etag + '"'
        (Invoke-TestRequest -Method 'PUT' -Path "/api/$Kind/$id" -Headers $mine -Body '{"version":1,"title":"Tab two"}').Status | Should -Be 200
    }

    It 'writes without If-Match (CLI, first save), with If-Match: *, and with If-Match on a new document' {
        $a = Get-Auth
        (Invoke-TestRequest -Method 'PUT' -Path '/api/hoists/nomatch' -Headers $a -Body '{"version":1,"n":1}').Status | Should -Be 200
        (Invoke-TestRequest -Method 'PUT' -Path '/api/hoists/nomatch' -Headers $a -Body '{"version":1,"n":2}').Status | Should -Be 200
        $any = $a.Clone(); $any['If-Match'] = '*'
        (Invoke-TestRequest -Method 'PUT' -Path '/api/hoists/nomatch' -Headers $any -Body '{"version":1,"n":3}').Status | Should -Be 200
        $stale = $a.Clone(); $stale['If-Match'] = '"' + ('0' * 64) + '"'
        (Invoke-TestRequest -Method 'PUT' -Path '/api/hoists/brand-new' -Headers $stale -Body '{"version":1}').Status | Should -Be 200
        (Invoke-TestRequest -Method 'PUT' -Path '/api/hoists/nomatch' -Headers $stale -Body '{"version":1,"n":4}').Status | Should -Be 409
        (Invoke-TestRequest -Path '/api/hoists/nomatch' -Headers $a).Body | Should -Be '{"version":1,"n":3}'
    }

    It 'leaves no temp files behind' {
        $dir = Join-Path $script:Sem.Home 'hoists'
        @(Get-ChildItem -LiteralPath $dir -Force -File | Where-Object { $_.Name -like '.*.tmp' -or $_.Name -like '.*.old' }).Count | Should -Be 0
    }
}

Describe 'Atomic save' {
    BeforeEach {
        $script:Dir = Join-Path $script:TestHome ('atomic-' + [guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($script:Dir)
    }

    It 'creates, then replaces, a document through a temp file in the same folder' {
        Save-SemDoc -Dir $script:Dir -Id 'a' -Bytes ([Text.Encoding]::UTF8.GetBytes('{"version":1,"n":1}'))
        Save-SemDoc -Dir $script:Dir -Id 'a' -Bytes ([Text.Encoding]::UTF8.GetBytes('{"version":1,"n":2}'))
        [IO.File]::ReadAllText((Join-Path $script:Dir 'a.json')) | Should -Be '{"version":1,"n":2}'
        @(Get-ChildItem -LiteralPath $script:Dir -Force -File).Name | Should -Be @('a.json')
    }
}

Describe 'Pairing with Lazarette from the Settings screen' {
    BeforeAll {
        # The pairing file lives under LOCALAPPDATA: never touch the real one.
        $script:SavedLocal = $env:LOCALAPPDATA
        $env:LOCALAPPDATA = Join-Path $script:TestHome 'local'
        [void][IO.Directory]::CreateDirectory($env:LOCALAPPDATA)
        $script:SavedLzPort = $env:LAZARETTE_PORT
        $closed = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $closed.Start()
        $env:LAZARETTE_PORT = [string]([Net.IPEndPoint]$closed.LocalEndpoint).Port; $closed.Stop()
        $secret = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($secret) } finally { $rng.Dispose() }
        $script:PairCode = 'lztl1.' + [guid]::NewGuid().ToString() + '.' + [Convert]::ToBase64String($secret).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        function script:Get-LogText { $d = Join-Path $script:TestHome 'logs'; if (Test-Path -LiteralPath $d) { return ((Get-ChildItem -LiteralPath $d -File | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`n") }; return '' }
    }
    AfterAll {
        $env:LOCALAPPDATA = $script:SavedLocal
        if ($null -eq $script:SavedLzPort) { Remove-Item Env:\LAZARETTE_PORT -ErrorAction SilentlyContinue } else { $env:LAZARETTE_PORT = $script:SavedLzPort }
    }
    It 'refuses a request without the session token, and never stores the code' {
        $body = @{ code = $script:PairCode } | ConvertTo-Json
        (Invoke-TestRequest -Method 'POST' -Path '/api/vault/pair' -Body $body).Status | Should -Be 401
        Test-SemVaultPaired | Should -BeFalse
    }
    It 'answers only POST' {
        (Invoke-TestRequest -Method 'GET' -Path '/api/vault/pair' -Headers (Get-Auth)).Status | Should -Be 405
        (Invoke-TestRequest -Method 'GET' -Path '/api/vault/unpair' -Headers (Get-Auth)).Status | Should -Be 405
    }
    It 'refuses <Why> with a sentence that does not repeat what was sent' -TestCases @(
        @{ Why = 'another kind of code'; Code = 'lzfl1.not-this-kind-of-code' }
        @{ Why = 'a right prefix on a wrong shape'; Code = 'lztl1.not-a-real-pairing-value' }
        @{ Why = 'a very long value'; Code = ('lztl1.' + ('x' * 5000)) }
    ) {
        $r = Invoke-TestRequest -Method 'POST' -Path '/api/vault/pair' -Headers (Get-Auth) -Body (@{ code = $Code } | ConvertTo-Json)
        $r.Status | Should -Be 400
        ($r.Body | ConvertFrom-Json).code | Should -Be 'vault-code'
        ($r.Body | ConvertFrom-Json).error | Should -BeLike '*Settings > Tools*'
        $r.Body.Contains($Code) | Should -BeFalse
        (Get-LogText).Contains($Code) | Should -BeFalse
        Test-SemVaultPaired | Should -BeFalse
    }
    It 'refuses a body with no code' {
        (Invoke-TestRequest -Method 'POST' -Path '/api/vault/pair' -Headers (Get-Auth) -Body '{}').Status | Should -Be 400
        (Invoke-TestRequest -Method 'POST' -Path '/api/vault/pair' -Headers (Get-Auth) -Body '{"code":7}').Status | Should -Be 400
    }
    It 'stores a good code DPAPI-protected, answers with the status, and shows the code nowhere' {
        $r = Invoke-TestRequest -Method 'POST' -Path '/api/vault/pair' -Headers (Get-Auth) -Body (@{ code = $script:PairCode } | ConvertTo-Json)
        $r.Status | Should -Be 200
        ($r.Body | ConvertFrom-Json).paired | Should -BeTrue
        $r.Body.Contains($script:PairCode) | Should -BeFalse
        (Get-LogText).Contains($script:PairCode) | Should -BeFalse
        Test-SemVaultPaired | Should -BeTrue
        $stored = Get-ChildItem -LiteralPath $env:LOCALAPPDATA -Recurse -File | ForEach-Object { [IO.File]::ReadAllBytes($_.FullName) }
        [Text.Encoding]::ASCII.GetString([byte[]]$stored).Contains('lztl1.') | Should -BeFalse
    }
    It 'forgets the pairing on unpair, and says so again when there is none' {
        $r = Invoke-TestRequest -Method 'POST' -Path '/api/vault/unpair' -Headers (Get-Auth) -Body '{}'
        $r.Status | Should -Be 200
        ($r.Body | ConvertFrom-Json).paired | Should -BeFalse
        Test-SemVaultPaired | Should -BeFalse
        (Invoke-TestRequest -Method 'POST' -Path '/api/vault/unpair' -Headers (Get-Auth) -Body '{}').Status | Should -Be 200
    }
}
