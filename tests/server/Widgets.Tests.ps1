# Pester 5. Custom chart widgets on the server: the sandbox page's own headers (its CSP, framing by
# the same origin only, loadable from its opaque origin, no session needed) and the team widget
# library routes (GET/POST /api/widgets, GET/DELETE /api/widgets/<id>): validation, caps, names,
# ids, the trash. Requests are dispatched in memory, as in Security.Tests.ps1.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Vault.ps1', 'Connectors.ps1') { . ([IO.Path]::Combine($server, $f)) }

    $script:TestHome = Join-Path ([IO.Path]::GetTempPath()) ('sem-whome-' + [guid]::NewGuid().ToString('N'))
    $script:TestWeb = Join-Path ([IO.Path]::GetTempPath()) ('sem-wweb-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory((Join-Path $script:TestWeb 'sandbox'))
    [IO.File]::WriteAllText((Join-Path $script:TestWeb 'index.html'), '<!doctype html><title>t</title>')
    [IO.File]::WriteAllText([IO.Path]::Combine($script:TestWeb, 'sandbox', 'widget.html'), '<!doctype html><title>w</title><script src="widget-host.0123456789.js"></script>')
    [IO.File]::WriteAllText([IO.Path]::Combine($script:TestWeb, 'sandbox', 'widget-host.0123456789.js'), 'void 0')

    $script:Sem.Port = 8800
    $script:Sem.Token = New-SemToken
    $script:Sem.Version = '0.3.0'
    $script:Sem.WebRoot = $script:TestWeb
    $script:Sem.Home = Resolve-SemHome -Settings @{ home = $script:TestHome } -Create
    $script:SemLogPath = Join-Path $script:TestHome 'widgets-test.log'
    Initialize-SemPresence -AutoStop $true

    function Invoke-TestRequest {
        param([string]$Method = 'GET', [string]$Path = '/', [hashtable]$Headers = @{}, [string]$Body = '')
        $h = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        $h['Host'] = '127.0.0.1:8800'
        foreach ($k in $Headers.Keys) { $h[$k] = [string]$Headers[$k] }
        $bytes = [Text.Encoding]::UTF8.GetBytes($Body)
        $req = @{ Method = $Method; Path = $Path; Query = ''; Headers = $h; ContentLength = $bytes.Length; Body = $bytes; Json = $null; RemoteAddress = [Net.IPAddress]::Loopback; Client = $null }
        $ms = New-Object IO.MemoryStream
        $script:Sem.Stream = $ms
        Invoke-SemRequest -Req $req
        $script:Sem.Stream = $null
        $text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
        $split = $text.IndexOf("`r`n`r`n")
        [pscustomobject]@{ Status = [int]($text.Substring(0, $split).Split(' ')[1]); Head = $text.Substring(0, $split); Body = $text.Substring($split + 4) }
    }
    function Get-Auth { return @{ 'X-Semaphore-Session' = $script:Sem.Token } }
    function Send-Widget([hashtable]$Body) { return (Invoke-TestRequest -Method 'POST' -Path '/api/widgets' -Headers (Get-Auth) -Body (ConvertTo-Json -InputObject $Body -Depth 5 -Compress)) }
    function Get-HeaderValue($R, [string]$Name) {
        foreach ($line in ($R.Head -split "`r`n")) { if ($line.StartsWith($Name + ': ')) { return $line.Substring($Name.Length + 2) } }
        return $null
    }
    $script:WidgetDir = Join-Path $script:Sem.Home 'widgets'
}

AfterAll {
    Remove-Item -LiteralPath $script:TestHome -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:TestWeb -Recurse -Force -ErrorAction SilentlyContinue
    $script:SemLogPath = $null
}

Describe 'The custom widget sandbox page' {
    It 'is served with its own CSP: sandboxed, no network, eval only for the widget code, framed by Semaphore only' {
        $r = Invoke-TestRequest -Path '/sandbox/widget.html'
        $r.Status | Should -Be 200
        $csp = Get-HeaderValue $r 'Content-Security-Policy'
        $csp | Should -Be "sandbox allow-scripts; default-src 'none'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src data: blob:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
        $csp | Should -Not -Match 'connect-src|allow-same-origin|allow-top-navigation|allow-popups|allow-forms'
        $csp | Should -Not -Match "img-src[^;]*('self'|https?:|\*)"
        Get-HeaderValue $r 'X-Frame-Options' | Should -Be 'SAMEORIGIN'
        Get-HeaderValue $r 'Cross-Origin-Resource-Policy' | Should -Be 'cross-origin'
        Get-HeaderValue $r 'X-Content-Type-Options' | Should -Be 'nosniff'
        Get-HeaderValue $r 'Referrer-Policy' | Should -Be 'no-referrer'
        Get-HeaderValue $r 'Cache-Control' | Should -Be 'no-store'
    }

    It 'needs no session: it holds no data until the page posts some' {
        (Invoke-TestRequest -Path '/sandbox/widget.html').Status | Should -Be 200
        $js = Invoke-TestRequest -Path '/sandbox/widget-host.0123456789.js'
        $js.Status | Should -Be 200
        $js.Head | Should -Match 'Content-Type: text/javascript'
        Get-HeaderValue $js 'Cache-Control' | Should -Be 'public, max-age=31536000, immutable'
        Get-HeaderValue $js 'Content-Security-Policy' | Should -Be $script:SemSandboxCsp
    }

    It 'has no app-route fallback and refuses traversal under /sandbox/' {
        (Invoke-TestRequest -Path '/sandbox/anything').Status | Should -Be 404
        (Invoke-TestRequest -Path '/sandbox/').Status | Should -Be 404
        (Invoke-TestRequest -Path '/sandbox/nope.js').Status | Should -Be 404
        (Invoke-TestRequest -Path '/sandbox/../index.html').Status | Should -Be 404
        (Invoke-TestRequest -Method 'POST' -Path '/sandbox/widget.html').Status | Should -Be 405
    }

    It 'leaves the page''s own headers as they were, with frame-src for the widget frame' {
        $page = Invoke-TestRequest -Path '/'
        $csp = Get-HeaderValue $page 'Content-Security-Policy'
        $csp | Should -Be $script:SemCsp
        $csp | Should -Match "frame-src 'self';"
        $csp | Should -Match "frame-ancestors 'none'$"
        $csp | Should -Not -Match 'unsafe-eval'
        Get-HeaderValue $page 'X-Frame-Options' | Should -Be 'DENY'
        Get-HeaderValue $page 'Cross-Origin-Resource-Policy' | Should -Be 'same-origin'
        # An API answer never carries the sandbox's looser set.
        Get-HeaderValue (Invoke-TestRequest -Path '/api/widgets' -Headers (Get-Auth)) 'Content-Security-Policy' | Should -Be $script:SemCsp
    }
}

Describe 'The team widget library' {
    BeforeEach {
        if (Test-Path -LiteralPath $script:WidgetDir) { Remove-Item -LiteralPath $script:WidgetDir -Recurse -Force }
    }

    It 'needs the session token' {
        (Invoke-TestRequest -Path '/api/widgets').Status | Should -Be 401
        (Invoke-TestRequest -Method 'POST' -Path '/api/widgets' -Body '{"name":"x","code":"y"}').Status | Should -Be 401
        (Invoke-TestRequest -Method 'DELETE' -Path '/api/widgets/x').Status | Should -Be 401
    }

    It 'saves, lists, reads back and removes a widget' {
        (Invoke-TestRequest -Path '/api/widgets' -Headers (Get-Auth)).Body | Should -Be '[]'
        $r = Send-Widget @{ name = 'Fleet bullet'; description = 'Cost against target'; code = 'function render(api) { return 1; }'; css = '.note { color: red; }' }
        $r.Status | Should -Be 200
        $w = ($r.Body | ConvertFrom-Json).widget
        $w.id | Should -Be 'fleet-bullet'
        $w.name | Should -Be 'Fleet bullet'
        $w.version | Should -Be 1
        $w.by | Should -Be ([string]$env:USERNAME)
        $w.updated | Should -Match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
        [IO.File]::Exists((Join-Path $script:WidgetDir 'fleet-bullet.json')) | Should -BeTrue

        $list = @((Invoke-TestRequest -Path '/api/widgets' -Headers (Get-Auth)).Body | ConvertFrom-Json)
        $list.Count | Should -Be 1
        $list[0].id | Should -Be 'fleet-bullet'
        $list[0].description | Should -Be 'Cost against target'
        $list[0].PSObject.Properties.Name | Should -Not -Contain 'code' -Because 'the list is names only; the code comes with GET /api/widgets/<id>'

        $one = (Invoke-TestRequest -Path '/api/widgets/fleet-bullet' -Headers (Get-Auth)).Body | ConvertFrom-Json
        $one.code | Should -Be 'function render(api) { return 1; }'
        $one.css | Should -Be '.note { color: red; }'

        (Invoke-TestRequest -Method 'DELETE' -Path '/api/widgets/fleet-bullet' -Headers (Get-Auth)).Status | Should -Be 200
        (Invoke-TestRequest -Path '/api/widgets/fleet-bullet' -Headers (Get-Auth)).Status | Should -Be 404
        @(Get-ChildItem -LiteralPath (Join-Path $script:WidgetDir '.trash') -Filter 'fleet-bullet-*.json').Count | Should -Be 1
        (Invoke-TestRequest -Method 'DELETE' -Path '/api/widgets/fleet-bullet' -Headers (Get-Auth)).Status | Should -Be 404
    }

    It 'gives a second widget of the same name its own id, and replaces one only by its id' {
        (Send-Widget @{ name = 'Gantt'; code = 'a' }).Status | Should -Be 200
        ((Send-Widget @{ name = 'Gantt'; code = 'b' }).Body | ConvertFrom-Json).widget.id | Should -Be 'gantt-2'
        ((Send-Widget @{ name = 'gantt!'; code = 'c' }).Body | ConvertFrom-Json).widget.id | Should -Be 'gantt-3'
        $u = Send-Widget @{ id = 'gantt'; name = 'Gantt, again'; code = 'd' }
        $u.Status | Should -Be 200
        ($u.Body | ConvertFrom-Json).widget.id | Should -Be 'gantt'
        ((Invoke-TestRequest -Path '/api/widgets/gantt' -Headers (Get-Auth)).Body | ConvertFrom-Json).code | Should -Be 'd'
        (Send-Widget @{ id = 'no-such'; name = 'X'; code = 'e' }).Status | Should -Be 404
        @(Get-ChildItem -LiteralPath $script:WidgetDir -Filter '*.json').Count | Should -Be 3
    }

    It 'cleans names: control and line-separator characters, runs of space, 80 characters at most' {
        $name = 'Bad' + [char]0 + 'name' + [char]0x2028 + [char]13 + [char]10 + '  here ' + ('x' * 200)
        $w = ((Send-Widget @{ name = $name; code = 'a' }).Body | ConvertFrom-Json).widget
        $w.name.Length | Should -Be 80
        $w.name | Should -Match '^Bad name here x+$'
        $w.id | Should -Match '^bad-name-here-x+$'
        $w.id.Length | Should -BeLessOrEqual 48
        $only = ((Send-Widget @{ name = ([string][char]0x00E9 + [char]0x00E8); code = 'a' }).Body | ConvertFrom-Json).widget
        $only.id | Should -Be 'widget' -Because 'a name with no letters a-z or digits still gets an id'
        $only.name | Should -Be ([string][char]0x00E9 + [char]0x00E8)
    }

    It 'keeps code byte for byte, non-ASCII included' {
        $code = "function render(api) {`n  api.el.textContent = '" + [char]0x00C5 + [char]0x2013 + "';`n}`n"
        $w = ((Send-Widget @{ name = 'Unicode'; code = $code }).Body | ConvertFrom-Json).widget
        ((Invoke-TestRequest -Path ('/api/widgets/' + $w.id) -Headers (Get-Auth)).Body | ConvertFrom-Json).code | Should -BeExactly $code
    }

    It 'refuses <Why>' -TestCases @(
        @{ Why = 'no name'; Body = '{"code":"a"}'; Status = 400 },
        @{ Why = 'a name of control characters only'; Body = '{"name":"\u0001\u0002 ","code":"a"}'; Status = 400 },
        @{ Why = 'a name that is not text'; Body = '{"name":5,"code":"a"}'; Status = 400 },
        @{ Why = 'no code'; Body = '{"name":"x"}'; Status = 400 },
        @{ Why = 'blank code'; Body = '{"name":"x","code":"   "}'; Status = 400 },
        @{ Why = 'code that is not text'; Body = '{"name":"x","code":{"a":1}}'; Status = 400 },
        @{ Why = 'CSS that is not text'; Body = '{"name":"x","code":"a","css":[1]}'; Status = 400 },
        @{ Why = 'a bad id'; Body = '{"id":"../x","name":"x","code":"a"}'; Status = 400 },
        @{ Why = 'a body that is not an object'; Body = '[1]'; Status = 400 },
        @{ Why = 'a body that is not JSON'; Body = 'name=x'; Status = 400 }
    ) {
        (Invoke-TestRequest -Method 'POST' -Path '/api/widgets' -Headers (Get-Auth) -Body $Body).Status | Should -Be $Status
        @(Get-ChildItem -LiteralPath (Get-SemWidgetDir) -Filter '*.json').Count | Should -Be 0
    }

    It 'caps code at 64 KB, CSS at 16 KB and the request at 512 KB' {
        (Send-Widget @{ name = 'max'; code = ('a' * 65536) }).Status | Should -Be 200
        $over = Send-Widget @{ name = 'over'; code = ('a' * 65537) }
        $over.Status | Should -Be 413
        ($over.Body | ConvertFrom-Json).code | Should -Be 'too-large'
        # Bytes, not characters: 32 769 two-byte characters are over the cap.
        (Send-Widget @{ name = 'wide'; code = ([string][char]0x00E9 * 32769) }).Status | Should -Be 413
        (Send-Widget @{ name = 'css'; code = 'a'; css = ('b' * 16385) }).Status | Should -Be 413
        (Get-SemBodyLimit -Path '/api/widgets').MaxBytes | Should -Be 524288
        (Get-SemBodyLimit -Path '/api/widgets/x').MaxBytes | Should -Be 524288
        (Invoke-TestRequest -Method 'POST' -Path '/api/widgets' -Headers (Get-Auth) -Body ('x' * 524289)).Status | Should -Be 413
    }

    It 'holds a set number of widgets at most' {
        $saved = $script:SemWidgetMaxCount
        try {
            $script:SemWidgetMaxCount = 2
            (Send-Widget @{ name = 'one'; code = 'a' }).Status | Should -Be 200
            (Send-Widget @{ name = 'two'; code = 'a' }).Status | Should -Be 200
            $r = Send-Widget @{ name = 'three'; code = 'a' }
            $r.Status | Should -Be 409
            ($r.Body | ConvertFrom-Json).code | Should -Be 'full'
            (Send-Widget @{ id = 'one'; name = 'one'; code = 'b' }).Status | Should -Be 200 -Because 'replacing one is not adding one'
        } finally { $script:SemWidgetMaxCount = $saved }
    }

    It 'lists by name and skips files that are not widgets' {
        (Send-Widget @{ name = 'Zulu'; code = 'a' }).Status | Should -Be 200
        (Send-Widget @{ name = 'Alpha'; code = 'a' }).Status | Should -Be 200
        [IO.File]::WriteAllText((Join-Path $script:WidgetDir 'broken.json'), 'not json')
        [IO.File]::WriteAllText((Join-Path $script:WidgetDir 'bad id.json'), '{"name":"x"}')
        [IO.File]::WriteAllText((Join-Path $script:WidgetDir 'array.json'), '[1,2]')
        $list = @((Invoke-TestRequest -Path '/api/widgets' -Headers (Get-Auth)).Body | ConvertFrom-Json)
        ($list | ForEach-Object { $_.name }) -join ',' | Should -Be 'Alpha,Zulu'
    }

    It 'answers 400 for a bad id and 405 for other methods' {
        (Invoke-TestRequest -Path '/api/widgets/a.b' -Headers (Get-Auth)).Status | Should -Be 400
        (Invoke-TestRequest -Path '/api/widgets/' -Headers (Get-Auth)).Status | Should -Be 400
        (Invoke-TestRequest -Method 'PUT' -Path '/api/widgets/x' -Headers (Get-Auth) -Body '{}').Status | Should -Be 405
        (Invoke-TestRequest -Method 'DELETE' -Path '/api/widgets' -Headers (Get-Auth)).Status | Should -Be 405
    }

    It 'is listed as a browser-only route with its reason, and Routes.ps1 answers it' {
        . ([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server', 'Commands.ps1'))
        Test-SemRouteCovered '/api/widgets' | Should -BeTrue
        Test-SemRouteCovered '/api/widgets/{id}' | Should -BeTrue
    }
}
