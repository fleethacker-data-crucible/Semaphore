# Pester 5. Region maps for map flags on the server (GET/POST /api/maps, GET/DELETE /api/maps/<id>):
# the shapes check (a FeatureCollection of named polygons), the caps, names, ids, other names, the
# shapes kept apart from what the map is, and the trash. Requests are dispatched in memory, as in
# Widgets.Tests.ps1.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Vault.ps1', 'Connectors.ps1') { . ([IO.Path]::Combine($server, $f)) }

    $script:TestHome = Join-Path ([IO.Path]::GetTempPath()) ('sem-mhome-' + [guid]::NewGuid().ToString('N'))
    $script:TestWeb = Join-Path ([IO.Path]::GetTempPath()) ('sem-mweb-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($script:TestWeb)
    [IO.File]::WriteAllText((Join-Path $script:TestWeb 'index.html'), '<!doctype html><title>t</title>')

    $script:Sem.Port = 8800
    $script:Sem.Token = New-SemToken
    $script:Sem.Version = '0.3.0'
    $script:Sem.WebRoot = $script:TestWeb
    $script:Sem.Home = Resolve-SemHome -Settings @{ home = $script:TestHome } -Create
    $script:SemLogPath = Join-Path $script:TestHome 'maps-test.log'
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
    function Send-Map([hashtable]$Body) { return (Invoke-TestRequest -Method 'POST' -Path '/api/maps' -Headers (Get-Auth) -Body (ConvertTo-Json -InputObject $Body -Depth 6 -Compress)) }
    # A square region named $Name at column $X, as the page sends it (properties.name only).
    function New-Region([string]$Name, [int]$X = 0) {
        return ('{"type":"Feature","properties":{"name":' + (ConvertTo-Json $Name) + '},"geometry":{"type":"Polygon","coordinates":[[[' + $X + ',0],[' + ($X + 1) + ',0],[' + ($X + 1) + ',1],[' + $X + ',1],[' + $X + ',0]]]}}')
    }
    function New-Shapes([string[]]$Names) {
        $i = 0
        $parts = foreach ($n in $Names) { New-Region $n ($i++) }
        return ('{"type":"FeatureCollection","features":[' + ($parts -join ',') + ']}')
    }
    $script:MapDir = Join-Path $script:Sem.Home 'maps'
}

AfterAll {
    Remove-Item -LiteralPath $script:TestHome -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:TestWeb -Recurse -Force -ErrorAction SilentlyContinue
    $script:SemLogPath = $null
}

Describe 'Region maps' {
    BeforeEach {
        if (Test-Path -LiteralPath $script:MapDir) { Remove-Item -LiteralPath $script:MapDir -Recurse -Force }
    }

    It 'needs the session token' {
        (Invoke-TestRequest -Path '/api/maps').Status | Should -Be 401
        (Invoke-TestRequest -Method 'POST' -Path '/api/maps' -Body '{"name":"x"}').Status | Should -Be 401
        (Invoke-TestRequest -Path '/api/maps/x').Status | Should -Be 401
        (Invoke-TestRequest -Method 'DELETE' -Path '/api/maps/x').Status | Should -Be 401
    }

    It 'saves, lists, reads back and removes a map, its shapes kept apart from what it is' {
        (Invoke-TestRequest -Path '/api/maps' -Headers (Get-Auth)).Body | Should -Be '[]'
        $shapes = New-Shapes @('Northeast', 'Gulf', 'Pacific Northwest')
        $r = Send-Map @{ name = 'Fleet regions'; geojson = $shapes; aliases = @{ NE = 'Northeast'; 'Gulf Coast' = 'Gulf' }; lonLat = $true }
        $r.Status | Should -Be 200
        $m = ($r.Body | ConvertFrom-Json).map
        $m.id | Should -Be 'fleet-regions'
        $m.name | Should -Be 'Fleet regions'
        $m.regions | Should -Be 3
        $m.aliases.NE | Should -Be 'Northeast'
        $m.aliases.'Gulf Coast' | Should -Be 'Gulf'
        $m.lonLat | Should -BeTrue
        $m.bytes | Should -Be ([Text.Encoding]::UTF8.GetByteCount($shapes))
        $m.by | Should -Be ([string]$env:USERNAME)
        $m.updated | Should -Match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
        [IO.File]::Exists((Join-Path $script:MapDir 'fleet-regions.json')) | Should -BeTrue
        [IO.File]::Exists([IO.Path]::Combine($script:MapDir, 'shapes', 'fleet-regions.json')) | Should -BeTrue

        $list = @((Invoke-TestRequest -Path '/api/maps' -Headers (Get-Auth)).Body | ConvertFrom-Json)
        $list.Count | Should -Be 1
        $list[0].id | Should -Be 'fleet-regions'
        $list[0].regions | Should -Be 3
        $list[0].aliases.NE | Should -Be 'Northeast'
        $list[0].PSObject.Properties.Name | Should -Not -Contain 'geojson' -Because 'the list says what each map is; the shapes come with GET /api/maps/<id>'

        $one = Invoke-TestRequest -Path '/api/maps/fleet-regions' -Headers (Get-Auth)
        $one.Status | Should -Be 200
        $one.Head | Should -Match 'Content-Type: application/json'
        $one.Body | Should -BeExactly $shapes

        (Invoke-TestRequest -Method 'DELETE' -Path '/api/maps/fleet-regions' -Headers (Get-Auth)).Status | Should -Be 200
        (Invoke-TestRequest -Path '/api/maps/fleet-regions' -Headers (Get-Auth)).Status | Should -Be 404
        @(Get-ChildItem -LiteralPath (Join-Path $script:MapDir '.trash') -Filter 'fleet-regions-*.json').Count | Should -Be 1
        @(Get-ChildItem -LiteralPath ([IO.Path]::Combine($script:MapDir, 'shapes', '.trash')) -Filter 'fleet-regions-*.json').Count | Should -Be 1
        (Invoke-TestRequest -Method 'DELETE' -Path '/api/maps/fleet-regions' -Headers (Get-Auth)).Status | Should -Be 404
    }

    It 'gives a second map of the same name its own id, and changes one only by its id' {
        $shapes = New-Shapes @('A', 'B')
        ((Send-Map @{ name = 'Ports'; geojson = $shapes }).Body | ConvertFrom-Json).map.id | Should -Be 'ports'
        ((Send-Map @{ name = 'Ports'; geojson = $shapes }).Body | ConvertFrom-Json).map.id | Should -Be 'ports-2'
        # By id with no shapes: the name and other names change, the shapes stay.
        $u = Send-Map @{ id = 'ports'; name = 'Home ports'; aliases = @{ Alpha = 'A' } }
        $u.Status | Should -Be 200
        $m = ($u.Body | ConvertFrom-Json).map
        $m.id | Should -Be 'ports'
        $m.name | Should -Be 'Home ports'
        $m.regions | Should -Be 2
        $m.bytes | Should -Be ([Text.Encoding]::UTF8.GetByteCount($shapes))
        (Invoke-TestRequest -Path '/api/maps/ports' -Headers (Get-Auth)).Body | Should -BeExactly $shapes
        # By id with shapes: they are replaced.
        $three = New-Shapes @('A', 'B', 'C')
        ((Send-Map @{ id = 'ports'; name = 'Home ports'; geojson = $three }).Body | ConvertFrom-Json).map.regions | Should -Be 3
        (Invoke-TestRequest -Path '/api/maps/ports' -Headers (Get-Auth)).Body | Should -BeExactly $three
        (Send-Map @{ id = 'no-such'; name = 'X'; geojson = $shapes }).Status | Should -Be 404
        @(Get-ChildItem -LiteralPath $script:MapDir -Filter '*.json' -File).Count | Should -Be 2
    }

    It 'keeps lonLat as sent, and keeps it when a change does not send it' {
        ((Send-Map @{ name = 'Grid'; geojson = (New-Shapes @('A')); lonLat = $false }).Body | ConvertFrom-Json).map.lonLat | Should -BeFalse
        ((Send-Map @{ id = 'grid'; name = 'Grid' }).Body | ConvertFrom-Json).map.lonLat | Should -BeFalse
        ((Send-Map @{ name = 'Other'; geojson = (New-Shapes @('A')) }).Body | ConvertFrom-Json).map.lonLat | Should -BeTrue -Because 'shapes are longitude and latitude unless the page says otherwise'
    }

    It 'lists each region once, and keeps names with any letters' {
        $name = 'Bah' + [char]0x00ED + 'a de C' + [char]0x00E1 + 'diz'
        $m = ((Send-Map @{ name = 'Bays'; geojson = (New-Shapes @($name, $name, 'Other')) }).Body | ConvertFrom-Json).map
        $m.regions | Should -Be 2
        $only = ((Send-Map @{ name = ([string][char]0x00E9 + [char]0x00E8); geojson = (New-Shapes @('A')) }).Body | ConvertFrom-Json).map
        $only.id | Should -Be 'map' -Because 'a name with no letters a-z or digits still gets an id'
    }

    It 'cleans other names and holds 500 at most' {
        $many = @{}
        for ($i = 0; $i -lt 600; $i++) { $many["n$i"] = 'A' }
        $many['bad' + [char]10 + 'line'] = 'A'
        $many['blank'] = '   '
        $m = ((Send-Map @{ name = 'Many'; geojson = (New-Shapes @('A')); aliases = $many }).Body | ConvertFrom-Json).map
        @($m.aliases.PSObject.Properties).Count | Should -Be 500
        @($m.aliases.PSObject.Properties | Where-Object { $_.Name -match '[\r\n]' -or $_.Value -eq '' }).Count | Should -Be 0
    }

    It 'refuses <Why>' -TestCases @(
        @{ Why = 'no name'; Body = '{"geojson":"{\"type\":\"FeatureCollection\",\"features\":[]}"}'; Status = 400 },
        @{ Why = 'a name that is not text'; Body = '{"name":5,"geojson":"{}"}'; Status = 400 },
        @{ Why = 'a new map with no shapes'; Body = '{"name":"x"}'; Status = 400 },
        @{ Why = 'shapes that are not text'; Body = '{"name":"x","geojson":{"type":"FeatureCollection"}}'; Status = 400 },
        @{ Why = 'shapes that are not JSON'; Body = '{"name":"x","geojson":"{not json"}'; Status = 400 },
        @{ Why = 'shapes that are an array'; Body = '{"name":"x","geojson":"[1]"}'; Status = 400 },
        @{ Why = 'a Topology (the page converts it first)'; Body = '{"name":"x","geojson":"{\"type\":\"Topology\",\"objects\":{}}"}'; Status = 400 },
        @{ Why = 'a collection with no regions'; Body = '{"name":"x","geojson":"{\"type\":\"FeatureCollection\",\"features\":[]}"}'; Status = 400 },
        @{ Why = 'a point'; Body = '{"name":"x","geojson":"{\"type\":\"FeatureCollection\",\"features\":[{\"type\":\"Feature\",\"properties\":{\"name\":\"P\"},\"geometry\":{\"type\":\"Point\",\"coordinates\":[1,2]}}]}"}'; Status = 400 },
        @{ Why = 'a region with no name'; Body = '{"name":"x","geojson":"{\"type\":\"FeatureCollection\",\"features\":[{\"type\":\"Feature\",\"properties\":{},\"geometry\":{\"type\":\"Polygon\",\"coordinates\":[[[0,0],[1,0],[1,1],[0,0]]]}}]}"}'; Status = 400 },
        @{ Why = 'a region name with a line break'; Body = '{"name":"x","geojson":"{\"type\":\"FeatureCollection\",\"features\":[{\"type\":\"Feature\",\"properties\":{\"name\":\"a\\nb\"},\"geometry\":{\"type\":\"Polygon\",\"coordinates\":[[[0,0],[1,0],[1,1],[0,0]]]}}]}"}'; Status = 400 },
        @{ Why = 'a polygon with no coordinates'; Body = '{"name":"x","geojson":"{\"type\":\"FeatureCollection\",\"features\":[{\"type\":\"Feature\",\"properties\":{\"name\":\"A\"},\"geometry\":{\"type\":\"Polygon\",\"coordinates\":[]}}]}"}'; Status = 400 },
        @{ Why = 'a bad id'; Body = '{"id":"../x","name":"x","geojson":"{}"}'; Status = 400 },
        @{ Why = 'a body that is not an object'; Body = '[1]'; Status = 400 }
    ) {
        (Invoke-TestRequest -Method 'POST' -Path '/api/maps' -Headers (Get-Auth) -Body $Body).Status | Should -Be $Status
        @(Get-ChildItem -LiteralPath (Get-SemMapDir) -Filter '*.json' -File).Count | Should -Be 0
    }

    It 'caps the shapes at 2 MB and 2000 regions, and the request at 3 MB' {
        $saved = $script:SemMapMaxRegions
        try {
            $script:SemMapMaxRegions = 3
            (Send-Map @{ name = 'three'; geojson = (New-Shapes @('A', 'B', 'C')) }).Status | Should -Be 200
            $over = Send-Map @{ name = 'four'; geojson = (New-Shapes @('A', 'B', 'C', 'D')) }
            $over.Status | Should -Be 413
            ($over.Body | ConvertFrom-Json).code | Should -Be 'too-large'
        } finally { $script:SemMapMaxRegions = $saved }
        # A FeatureCollection padded past 2 MB with spaces: refused on its size before it is read.
        $big = (New-Shapes @('A')).Insert(1, (' ' * 2097152))
        (Send-Map @{ name = 'big'; geojson = $big }).Status | Should -Be 413
        (Get-SemBodyLimit -Path '/api/maps').MaxBytes | Should -Be 3145728
        (Get-SemBodyLimit -Path '/api/maps/x').MaxBytes | Should -Be 3145728
        (Invoke-TestRequest -Method 'POST' -Path '/api/maps' -Headers (Get-Auth) -Body ('x' * 3145729)).Status | Should -Be 413
    }

    It 'reads a map of a thousand detailed regions' {
        $parts = for ($i = 0; $i -lt 1000; $i++) {
            $ring = (0..40 | ForEach-Object { '[' + ($i + [Math]::Cos($_ / 6.5)).ToString('0.00000', [Globalization.CultureInfo]::InvariantCulture) + ',' + ([Math]::Sin($_ / 6.5)).ToString('0.00000', [Globalization.CultureInfo]::InvariantCulture) + ']' }) -join ','
            '{"type":"Feature","properties":{"name":"R' + $i + '"},"geometry":{"type":"Polygon","coordinates":[[' + $ring + ']]}}'
        }
        $shapes = '{"type":"FeatureCollection","features":[' + ($parts -join ',') + ']}'
        $r = Send-Map @{ name = 'Detailed'; geojson = $shapes }
        $r.Status | Should -Be 200
        ($r.Body | ConvertFrom-Json).map.regions | Should -Be 1000
    }

    It 'holds a set number of maps at most' {
        $saved = $script:SemMapMaxCount
        try {
            $script:SemMapMaxCount = 2
            (Send-Map @{ name = 'one'; geojson = (New-Shapes @('A')) }).Status | Should -Be 200
            (Send-Map @{ name = 'two'; geojson = (New-Shapes @('A')) }).Status | Should -Be 200
            $r = Send-Map @{ name = 'three'; geojson = (New-Shapes @('A')) }
            $r.Status | Should -Be 409
            ($r.Body | ConvertFrom-Json).code | Should -Be 'full'
            (Send-Map @{ id = 'one'; name = 'one'; geojson = (New-Shapes @('B')) }).Status | Should -Be 200 -Because 'changing one is not adding one'
        } finally { $script:SemMapMaxCount = $saved }
    }

    It 'lists by name and skips files that are not maps' {
        (Send-Map @{ name = 'Zulu'; geojson = (New-Shapes @('A')) }).Status | Should -Be 200
        (Send-Map @{ name = 'Alpha'; geojson = (New-Shapes @('A')) }).Status | Should -Be 200
        [IO.File]::WriteAllText((Join-Path $script:MapDir 'broken.json'), 'not json')
        [IO.File]::WriteAllText((Join-Path $script:MapDir 'bad id.json'), '{"name":"x"}')
        [IO.File]::WriteAllText((Join-Path $script:MapDir 'array.json'), '[1,2]')
        $list = @((Invoke-TestRequest -Path '/api/maps' -Headers (Get-Auth)).Body | ConvertFrom-Json)
        ($list | ForEach-Object { $_.name }) -join ',' | Should -Be 'Alpha,Zulu'
    }

    It 'answers 404 for shapes with no map, 400 for a bad id and 405 for other methods' {
        $shapes = Get-SemMapDir -Shapes
        [IO.File]::WriteAllText((Join-Path $shapes 'orphan.json'), (New-Shapes @('A')))
        (Invoke-TestRequest -Path '/api/maps/orphan' -Headers (Get-Auth)).Status | Should -Be 404
        (Invoke-TestRequest -Path '/api/maps/a.b' -Headers (Get-Auth)).Status | Should -Be 400
        (Invoke-TestRequest -Path '/api/maps/' -Headers (Get-Auth)).Status | Should -Be 400
        (Invoke-TestRequest -Method 'PUT' -Path '/api/maps/x' -Headers (Get-Auth) -Body '{}').Status | Should -Be 405
        (Invoke-TestRequest -Method 'DELETE' -Path '/api/maps' -Headers (Get-Auth)).Status | Should -Be 405
    }

    It 'is listed as a browser-only route with its reason, and Routes.ps1 answers it' {
        . ([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server', 'Commands.ps1'))
        Test-SemRouteCovered '/api/maps' | Should -BeTrue
        Test-SemRouteCovered '/api/maps/{id}' | Should -BeTrue
    }
}
