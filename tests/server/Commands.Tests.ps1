# Pester 5. CLI/API parity: every route of the server and every /api path the UI calls has a command in
# server/Commands.ps1 or is listed there as browser-only with its reason; the commands run in-process on a temporary
# Semaphore folder; the real CLI script returns the documented schema, exit codes and BOM-free --out files.
BeforeAll {
    $script:Root = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..'))
    $server = Join-Path $script:Root 'server'
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Intelligence.ps1', 'Lake.ps1', 'Vault.ps1', 'Connectors.ps1', 'Commands.ps1') { . (Join-Path $server $f) }

    function script:New-Home {
        $h = Join-Path $TestDrive ('home-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $h | Out-Null
        return $h
    }
    function script:Run([string]$Name, [hashtable]$Opt = @{}, [bool]$Yes = $false, [bool]$Dry = $false, [string]$HomeDir) {
        return (Invoke-SemCommand -Command (Find-SemCommand $Name) -Options $Opt -Yes $Yes -DryRun $Dry -HomeDir $HomeDir -Root $script:Root)
    }
    function script:Routes-In-Dispatcher {
        # The /api paths Routes.ps1 and Http.ps1 answer, with the document kinds expanded.
        $out = New-Object System.Collections.Generic.List[string]
        foreach ($f in 'Routes.ps1', 'Http.ps1') {
            $text = Get-Content -LiteralPath (Join-Path $server $f) -Raw
            foreach ($m in [regex]::Matches($text, '\$p -eq ''(/api/[A-Za-z0-9/_-]+)''')) { $out.Add($m.Groups[1].Value) }
            foreach ($m in [regex]::Matches($text, '\$p -eq ''(/api/[A-Za-z0-9/_-]+)'' -or \$p -eq ''(/api/[A-Za-z0-9/_-]+)''')) { $out.Add($m.Groups[2].Value) }
            foreach ($m in [regex]::Matches($text, '\$p -match ''\^/api/\(([A-Za-z|]+)\)')) { foreach ($k in $m.Groups[1].Value.Split('|')) { $out.Add("/api/$k"); $out.Add("/api/$k/{id}") } }
        }
        return @($out | Sort-Object -Unique)
    }
}

Describe 'Parity between the routes and the commands' {
    It 'finds the routes it is meant to check (a guard against the scan going blind)' {
        $r = Routes-In-Dispatcher
        $r | Should -Contain '/api/info'
        $r | Should -Contain '/api/hoists/{id}'
        $r | Should -Contain '/api/refresh-report'
        $r | Should -Contain '/api/query'
        $r.Count | Should -BeGreaterThan 12
    }
    It 'gives every server route a command or a browser-only reason' {
        $missing = @(Routes-In-Dispatcher | Where-Object { -not (Test-SemRouteCovered $_) })
        $missing | Should -BeNullOrEmpty -Because ('no command for: ' + ($missing -join ', '))
    }
    It 'gives every /api path the UI calls a command or a browser-only reason' {
        $found = New-Object System.Collections.Generic.List[string]
        foreach ($f in Get-ChildItem -LiteralPath (Join-Path $script:Root 'web\src') -Recurse -File | Where-Object { $_.Extension -in '.ts', '.tsx' }) {
            $text = (Get-Content -LiteralPath $f.FullName -Raw) -replace '\$\{[^}]*\}', '{id}'
            foreach ($m in [regex]::Matches($text, '[''"`](/api/[A-Za-z0-9/_{}.-]+)')) {
                $p = $m.Groups[1].Value.TrimEnd('/')
                # The UI builds /api/${kind}[/${id}] for the document kinds: check each kind it can mean.
                if ($p -match '^/api/\{id\}(/\{id\})?$') { foreach ($k in $script:SemDocKinds.Values) { $found.Add($p.Replace('/api/{id}', "/api/$k")) } }
                else { $found.Add($p) }
            }
        }
        $found.Count | Should -BeGreaterThan 8
        $missing = @($found | Sort-Object -Unique | Where-Object { -not (Test-SemRouteCovered $_) })
        $missing | Should -BeNullOrEmpty -Because ('UI paths with no command: ' + ($missing -join ', '))
    }
    It 'would catch a new route that has no command' {
        Test-SemRouteCovered '/api/brand-new-route' | Should -BeFalse
        Test-SemRouteCovered '/api/vault' | Should -BeTrue -Because 'the Lazarette bridge route has its "vault status" command'
        Test-SemRouteCovered '/api/hoists/abc' | Should -BeTrue
    }
    It 'lists a browser-only route only when it really is a route, with a reason' {
        $real = Routes-In-Dispatcher
        foreach ($k in $script:SemUiOnlyRoutes.Keys) {
            ($real -contains $k -or $k -in @('/api/leaving', '/api/launch')) | Should -BeTrue -Because "$k is not a route any more"
            $script:SemUiOnlyRoutes[$k].Length | Should -BeGreaterThan 10
        }
    }
    It 'has unique names, a summary, and marks every changing command as needing --yes' {
        $names = @(Get-SemCommandRegistry | ForEach-Object { $_.name })
        ($names | Select-Object -Unique).Count | Should -Be $names.Count
        foreach ($c in Get-SemCommandRegistry) {
            $c.summary.Length | Should -BeGreaterThan 10
            if ($c.name -match ' (put|delete|stop)$') { $c.destructive | Should -BeTrue -Because $c.name }
            else { $c.destructive | Should -BeFalse -Because $c.name }
        }
    }
    It 'serves the list on GET /api/commands (the route exists and names the same function)' {
        $src = Get-Content -LiteralPath (Join-Path $server 'Routes.ps1') -Raw
        $src | Should -Match "p -eq '/api/commands'"
        $src | Should -Match 'Get-SemCommandList'
        (Get-SemCommandList).schema | Should -Be 'semaphore.commands/1'
    }
}

Describe 'Commands run on a Semaphore folder' {
    BeforeEach { $script:H = New-Home }
    It 'saves, lists, reads and removes a document, and only saves with --yes' {
        $file = Join-Path $TestDrive 'h.json'
        Set-Content -LiteralPath $file -Encoding UTF8 -Value '{"version":1,"title":"Fleet page"}'
        $r = Run 'hoist put' @{ id = 'fleet'; file = $file } $false $false $script:H
        $r.Ok | Should -BeFalse; $r.Usage | Should -BeTrue; $r.Error | Should -BeLike '*--yes*'
        (Run 'hoist list' @{} $false $false $script:H).Result.Count | Should -Be 0
        (Run 'hoist put' @{ id = 'fleet'; file = $file } $true $false $script:H).Ok | Should -BeTrue
        $list = (Run 'hoist list' @{} $false $false $script:H).Result
        @($list).Count | Should -Be 1; $list[0].id | Should -Be 'fleet'; $list[0].title | Should -Be 'Fleet page'
        (Run 'hoist get' @{ id = 'fleet' } $false $false $script:H).Result.title | Should -Be 'Fleet page'
        $d = Run 'hoist delete' @{ id = 'fleet' } $true $false $script:H
        $d.Ok | Should -BeTrue
        (Run 'hoist get' @{ id = 'fleet' } $false $false $script:H).Ok | Should -BeFalse
        @(Get-ChildItem (Join-Path $script:H 'hoists\.trash') -Filter 'fleet-*.json').Count | Should -Be 1
    }
    It 'works for every document kind' -TestCases @(@{ N = 'hoist' }, @{ N = 'catalog' }, @{ N = 'playbook' }, @{ N = 'snapshot' }, @{ N = 'question' }, @{ N = 'team' }) {
        $file = Join-Path $TestDrive "$N.json"
        Set-Content -LiteralPath $file -Encoding UTF8 -Value '{"version":1,"title":"x"}'
        (Run "$N put" @{ id = 'a1'; file = $file } $true $false $script:H).Ok | Should -BeTrue
        @((Run "$N list" @{} $false $false $script:H).Result).Count | Should -Be 1
    }
    It 'refuses a bad id, a missing file, a body without version 1, and an unknown option as usage errors' {
        $file = Join-Path $TestDrive 'bad.json'
        Set-Content -LiteralPath $file -Value '{"title":"no version"}'
        (Run 'hoist get' @{ id = '../etc' } $false $false $script:H).Usage | Should -BeTrue
        (Run 'hoist put' @{ id = 'a'; file = (Join-Path $TestDrive 'nope.json') } $true $false $script:H).Usage | Should -BeTrue
        $v = Run 'hoist put' @{ id = 'a'; file = $file } $true $false $script:H
        $v.Ok | Should -BeFalse; $v.Error | Should -BeLike '*version*'
        (Run 'hoist list' @{ colour = 'red' } $false $false $script:H).Usage | Should -BeTrue
        (Run 'hoist get' @{} $false $false $script:H).Usage | Should -BeTrue
    }
    It 'with --dry-run changes nothing' {
        $file = Join-Path $TestDrive 'h.json'
        Set-Content -LiteralPath $file -Value '{"version":1}'
        $r = Run 'hoist put' @{ id = 'dry'; file = $file } $false $true $script:H
        $r.Ok | Should -BeTrue; $r.Result.dryRun | Should -BeTrue
        @(Get-ChildItem (Join-Path $script:H 'hoists') -Filter '*.json' -ErrorAction SilentlyContinue).Count | Should -Be 0
    }
    It 'lists sources without connection strings or secrets' {
        Set-Content -LiteralPath (Join-Path $script:H 'sources.json') -Encoding UTF8 -Value '[{"id":"maint","label":"Maintenance","kind":"postgres","provider":"odbc","connection":"DSN=Secretish;Server=db.example"}]'
        $r = Run 'source list' @{} $false $false $script:H
        $r.Result[0].id | Should -Be 'maint'
        (ConvertTo-Json -InputObject $r.Result -Depth 5) | Should -Not -BeLike '*Secretish*'
        (ConvertTo-Json -InputObject (Run 'info show' @{} $false $false $script:H).Result -Depth 5) | Should -Not -BeLike '*Secretish*'
    }
    It 'reports the last refresh, or that none has run' {
        (Run 'refresh report' @{} $false $false $script:H).Ok | Should -BeFalse
        New-Item -ItemType Directory -Force -Path (Join-Path $script:H 'snapshots') | Out-Null
        Set-Content -LiteralPath (Join-Path $script:H 'snapshots\.last-refresh.json') -Value '{"version":1,"refreshed":3,"skipped":1,"failed":[]}'
        (Run 'refresh report' @{} $false $false $script:H).Result.refreshed | Should -Be 3
    }
    It 'reports the Lazarette bridge without any secret: which source reads which share, and the pairing' {
        Set-Content -LiteralPath (Join-Path $script:H 'sources.json') -Encoding UTF8 -Value '[{"id":"maint","provider":"odbc","connection":"DSN=x","vault":{"password":"SMDATS_PASSWORD","user":"SMDATS_USER"}},{"id":"plain","provider":"odbc","connection":"DSN=y"}]'
        $oldLocal = $env:LOCALAPPDATA; $env:LOCALAPPDATA = Join-Path $TestDrive 'no-pairing'
        try { $r = Run 'vault status' @{} $false $false $script:H } finally { $env:LOCALAPPDATA = $oldLocal }
        $r.Ok | Should -BeTrue
        @($r.Result.sources).Count | Should -Be 1
        $r.Result.sources[0].id | Should -Be 'maint'
        $r.Result.sources[0].shares.password | Should -Be 'SMDATS_PASSWORD'
        $r.Result.paired | Should -BeFalse
        $r.Result.problem | Should -BeLike '*vault pair*'
        (ConvertTo-Json -InputObject $r.Result -Depth 5) | Should -Not -BeLike '*DSN*'
    }
    It 'reports AI status without printing a key' {
        $env:SEMAPHORE_AI_KEY = 'fl-test-key-never-print-0123456789'
        try {
            $r = Run 'ai status' @{} $false $false $script:H
            $r.Ok | Should -BeTrue
            (ConvertTo-Json -InputObject $r.Result -Depth 5) | Should -Not -BeLike '*never-print*'
        } finally { Remove-Item Env:\SEMAPHORE_AI_KEY -ErrorAction SilentlyContinue }
    }
    It 'asks for --yes before stopping, and dry-run only describes' {
        (Run 'session stop' @{} $false $false $script:H).Usage | Should -BeTrue
        (Run 'session stop' @{} $false $true $script:H).Result.dryRun | Should -BeTrue
        (Run 'refresh run' @{} $false $true $script:H).Result.dryRun | Should -BeTrue
    }
}

Describe 'The CLI script' {
    BeforeAll {
        $script:Cli = Join-Path $script:Root 'server\Invoke-SemaphoreCli.ps1'
        $script:CliHome = New-Home
        function script:Invoke-SemCli([string[]]$a) {
            $ErrorActionPreference = 'Continue'
            $env:SEMAPHORE_HOME = $script:CliHome
            $out = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script:Cli @a 2>&1
            return @{ Code = $LASTEXITCODE; Text = (($out | ForEach-Object { "$_" }) -join "`n") }
        }
    }
    AfterAll { Remove-Item Env:\SEMAPHORE_HOME -ErrorAction SilentlyContinue }
    It 'prints the command list as semaphore.commands/1 and exits 0' {
        $r = Invoke-SemCli @('commands', '--json')
        $r.Code | Should -Be 0
        $j = $r.Text | ConvertFrom-Json
        $j.schema | Should -Be 'semaphore.commands/1'
        @($j.commands | Where-Object { $_.name -eq 'semaphore hoist list' }).Count | Should -Be 1
        @($j.uiOnly).Count | Should -BeGreaterThan 3
    }
    It 'prints a result as semaphore.result/1' {
        $r = Invoke-SemCli @('hoist', 'list', '--json')
        $r.Code | Should -Be 0
        $j = $r.Text | ConvertFrom-Json
        $j.schema | Should -Be 'semaphore.result/1'; $j.ok | Should -BeTrue; $j.command | Should -Be 'semaphore hoist list'
    }
    It 'exits 1 when a command fails and 2 on a usage error' {
        (Invoke-SemCli @('hoist', 'get', '--id', 'nothing', '--json')).Code | Should -Be 1
        (Invoke-SemCli @('nonsense')).Code | Should -Be 2
        (Invoke-SemCli @('hoist', 'get')).Code | Should -Be 2
        (Invoke-SemCli @('hoist', 'delete', '--id', 'x')).Code | Should -Be 2
    }
    It 'writes --out as UTF-8 without a BOM' {
        $out = Join-Path $TestDrive 'out.json'
        (Invoke-SemCli @('info', 'show', '--out', $out)).Code | Should -Be 0
        $b = [IO.File]::ReadAllBytes($out)
        ($b[0] -eq 0xEF -and $b[1] -eq 0xBB) | Should -BeFalse
        ([Text.Encoding]::UTF8.GetString($b) | ConvertFrom-Json).ok | Should -BeTrue
    }
}
