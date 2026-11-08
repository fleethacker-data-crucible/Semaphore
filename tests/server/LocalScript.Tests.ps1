# Pester 5. SQL scripts on the local database (server/LocalScript.cs and LocalScript.ps1): one transaction per script,
# savepoint try / catch, variables, bounded loops, the authorizer's refusals and _semaphore_* protection, plan checks,
# IMPORT INTO from a live source (mocked), saved scripts; the dataset exports read back (CSV, Parquet through
# SemColumnar, SQLite through LocalConnection, xlsx through ZipArchive); and pipelines (Pipeline.ps1): validation,
# a run with the atomic swap on failure, the unchanged-source skip, publish, the schedule tick, catch-up and the CLI.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    $script:Root = Split-Path -Parent $server
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Vault.ps1', 'Connectors.ps1', 'LocalDb.ps1', 'Columnar.ps1', 'LocalScript.ps1', 'Pipeline.ps1', 'Commands.ps1') { $p = [IO.Path]::Combine($server, $f); if ([IO.File]::Exists($p)) { . $p } }
    Initialize-SemLocalTypes

    $script:Work = Join-Path ([IO.Path]::GetTempPath()) ('sem-script-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($script:Work)
    $script:HomeDir = Resolve-SemHome -Settings @{ home = (Join-Path $script:Work 'home') } -Create
    $script:Sem.Home = $script:HomeDir
    $script:Sem.Version = '0.0.0-test'
    $script:Sem.LocalShares = @()
    [void](Initialize-SemLocalDb -HomeDir $script:HomeDir -Cleanup)

    function script:Plan([object[]]$Nodes, [object[]]$Params = @()) {
        return ([pscustomobject]@{ version = 1; dialect = 'sqlite'; nodes = $Nodes; params = $Params } | ConvertTo-Json -Depth 100 | ConvertFrom-Json)
    }
    function script:Sql([string]$Sql, [int]$Line = 1) { return [ordered]@{ op = 'sql'; sql = $Sql; line = $Line; kind = 'write' } }
    function script:Run($Plan, $Params = $null) { return (Invoke-SemLocalScript -HomeDir $script:HomeDir -Plan $Plan -Params $Params -Label 'test') }
    function script:Q([string]$Sql) {
        $c = Open-SemLocalConnection -HomeDir $script:HomeDir
        try {
            $cmd = $c.CreateCommand(); $cmd.CommandText = $Sql
            $r = $cmd.ExecuteReader()
            $out = New-Object System.Collections.Generic.List[object]
            try { while ($r.Read()) { $row = [ordered]@{}; for ($i = 0; $i -lt $r.FieldCount; $i++) { $v = $r.GetValue($i); if ($v -is [DBNull]) { $v = $null }; $row[$r.GetName($i)] = $v }; $out.Add([pscustomobject]$row) } } finally { $r.Dispose(); $cmd.Dispose() }
            return , $out.ToArray()
        } finally { $c.Dispose() }
    }
    function script:Write-Csv([string]$Name, [string]$Text) {
        $p = Join-Path $script:Work $Name
        [IO.File]::WriteAllText($p, $Text, (New-Object Text.UTF8Encoding $false))
        return $p
    }
    function script:Save-Pipeline([string]$Id, $Doc) {
        Save-SemPipeline -HomeDir $script:HomeDir -Id $Id -Bytes ([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Doc -Depth 10)))
    }
    function script:Save-Script([string]$Id, [object[]]$Nodes) {
        $doc = [ordered]@{ version = 1; name = $Id; dialect = 'sqlite'; text = '-- test'; plan = [ordered]@{ version = 1; dialect = 'sqlite'; nodes = $Nodes; params = @() } }
        Save-SemScript -HomeDir $script:HomeDir -Id $Id -Bytes ([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $doc -Depth 20)))
    }
    [void](Run (Plan @((Sql 'CREATE TABLE stock (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)'), (Sql "INSERT INTO stock VALUES (1, 'bolt', 5), (2, 'nut', 7)"))))
}

AfterAll {
    try { [IO.Directory]::Delete($script:Work, $true) } catch { }
}

Describe 'The script runner' {
    It 'runs a script in one transaction and reports rows, changes and timings per statement' {
        $r = Run (Plan @((Sql 'CREATE TABLE t1 (a INTEGER, b TEXT)' 1), (Sql "INSERT INTO t1 VALUES (1, 'x'), (2, 'y')" 2), (Sql 'UPDATE t1 SET b = upper(b) WHERE a = 2' 3), (Sql 'SELECT a, b FROM t1 ORDER BY a' 4)))
        $r.ok | Should -BeTrue
        @($r.results).Count | Should -Be 4
        $r.results[1].changes | Should -Be 2
        $r.results[2].changes | Should -Be 1
        $r.results[3].kind | Should -Be 'rows'
        @($r.results[3].columns) | Should -Be @('a', 'b')
        $r.results[3].rows[1][1] | Should -Be 'Y'
        $r.results[3].line | Should -Be 4
        $r.tables | Should -Contain 't1'
        (Q "SELECT source, rows FROM _semaphore_tables WHERE name = 't1'")[0].rows | Should -Be 2
    }
    It 'rolls the whole script back on an error and names the statement and its line' {
        $r = Run (Plan @((Sql "INSERT INTO stock VALUES (10, 'kept?', 1)" 1), (Sql 'UPDATE stock SET qty = 0' 2), (Sql "INSERT INTO stock VALUES (1, 'dup', 1)" 7)))
        $r.ok | Should -BeFalse
        $r.error.line | Should -Be 7
        $r.error.message | Should -Match '^Line 7: .*UNIQUE'
        $r.error.sql | Should -Match 'dup'
        (Q 'SELECT COUNT(*) AS n FROM stock WHERE id = 10 OR qty = 0')[0].n | Should -Be 0
    }
    It 'runs a try block in a savepoint: on an error only that part is undone and the catch block sees @error_message' {
        $try = [ordered]@{ op = 'try'; line = 2; body = @((Sql "INSERT INTO stock VALUES (21, 'undone', 1)" 3), (Sql "INSERT INTO stock VALUES (1, 'dup', 1)" 4)); catch = @((Sql "INSERT INTO stock VALUES (22, @error_message, 0)" 6)) }
        $r = Run (Plan @((Sql "INSERT INTO stock VALUES (20, 'kept', 1)" 1), $try))
        $r.ok | Should -BeTrue
        @((Q 'SELECT id FROM stock WHERE id >= 20 ORDER BY id') | ForEach-Object { $_.id }) | Should -Be @(20, 22)
        (Q 'SELECT name FROM stock WHERE id = 22')[0].name | Should -Match 'UNIQUE'
        [void](Run (Plan @((Sql 'DELETE FROM stock WHERE id >= 20'))))
    }
    It 'binds variables and parameters by name, runs IF and bounded WHILE loops, and stops a loop at its limit' {
        $nodes = @(
            [ordered]@{ op = 'declare'; name = 'i'; sql = 'SELECT 0'; line = 1 },
            [ordered]@{ op = 'while'; cond = 'SELECT CASE WHEN @i < @upto THEN 1 ELSE 0 END'; max = 100; line = 2; body = @(
                    [ordered]@{ op = 'assign'; names = @('i'); sql = 'SELECT @i + 1'; mode = 'last'; line = 3 },
                    [ordered]@{ op = 'continue'; cond = 'SELECT @i = 2'; line = 4 },
                    [ordered]@{ op = 'if'; cond = 'SELECT @i > 3'; line = 5; then = @([ordered]@{ op = 'break'; line = 5 }); else = @((Sql 'INSERT INTO log VALUES (@i)' 6)) }
                ) },
            [ordered]@{ op = 'print'; sql = "SELECT 'done at ' || @i"; line = 8 }
        )
        $r = Run (Plan (@((Sql 'CREATE TABLE log (n INTEGER)')) + $nodes) @([ordered]@{ name = 'upto'; label = '@upto' })) @{ upto = 10 }
        $r.ok | Should -BeTrue
        @((Q 'SELECT n FROM log') | ForEach-Object { $_.n }) | Should -Be @(1, 3)
        ($r.results | Where-Object { $_.kind -eq 'message' }).message | Should -Be 'done at 4'
        $loop = Run (Plan @([ordered]@{ op = 'while'; cond = 'SELECT 1'; max = 5; line = 1; body = @((Sql 'SELECT 1' 1)) }))
        $loop.ok | Should -BeFalse
        $loop.error.message | Should -Match 'ran 5 times'
        $undeclared = Run (Plan @((Sql 'SELECT @nobody' 3)))
        $undeclared.error.message | Should -Match '@nobody is not declared'
    }
    It 'refuses ATTACH, DETACH, PRAGMA (but the safe reads), VACUUM INTO, load_extension, transactions and triggers through the authorizer' {
        foreach ($case in @(
                @("ATTACH DATABASE '$($script:Work)\x.db' AS x", 'ATTACH is refused'),
                @('DETACH DATABASE main', 'DETACH'),
                @('PRAGMA journal_mode = DELETE', 'PRAGMA journal_mode is refused'),
                @('PRAGMA writable_schema = 1', 'refused'),
                @("VACUUM INTO '$($script:Work)\copy.db'", 'VACUUM'),
                @("SELECT load_extension('evil')", 'load_extension is refused'),
                @('BEGIN', 'BEGIN, COMMIT'),
                @('SAVEPOINT x', 'SAVEPOINT'),
                @('CREATE TRIGGER tr AFTER INSERT ON stock BEGIN DELETE FROM stock; END', 'Triggers are refused'))) {
            $r = Run (Plan @((Sql $case[0] 3)))
            $r.ok | Should -BeFalse -Because $case[0]
            $r.error.message | Should -Match ([regex]::Escape($case[1])) -Because $case[0]
            $r.error.line | Should -Be 3
        }
        (Run (Plan @((Sql "PRAGMA table_info('stock')")))).ok | Should -BeTrue
        (Run (Plan @((Sql "SELECT name FROM pragma_table_info('stock')")))).ok | Should -BeTrue
        [IO.File]::Exists((Join-Path $script:Work 'copy.db')) | Should -BeFalse
    }
    It 'never lets a script change a _semaphore table: insert, update, delete, drop, alter, rename onto one, or an index' {
        foreach ($sql in @("INSERT INTO _semaphore_tables (name) VALUES ('x')", 'UPDATE _semaphore_tables SET rows = 0', 'DELETE FROM _semaphore_tables', 'DROP TABLE _semaphore_tables', 'ALTER TABLE _semaphore_tables ADD COLUMN z', 'CREATE TABLE _semaphore_mine (a)', 'CREATE INDEX ix ON _semaphore_tables (rows)', 'ALTER TABLE stock RENAME TO _semaphore_stock')) {
            $r = Run (Plan @((Sql $sql 2)))
            $r.ok | Should -BeFalse -Because $sql
            $r.error.message | Should -Match '_semaphore' -Because $sql
        }
        (Q "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'stock'")[0].n | Should -Be 1
        (Run (Plan @((Sql 'SELECT COUNT(*) FROM _semaphore_tables')))).ok | Should -BeTrue
    }
    It 'checks the plan itself: unknown steps, bad names, nesting, IMPORT below the top, and more than one statement per step' {
        { Run (Plan @([ordered]@{ op = 'shell'; sql = 'x'; line = 1 })) } | Should -Throw '*Unknown step*'
        { Run (Plan @([ordered]@{ op = 'declare'; name = 'a b'; line = 1 })) } | Should -Throw '*variable name*'
        { Run (Plan @([ordered]@{ op = 'if'; cond = 'SELECT 1'; line = 1; then = @([ordered]@{ op = 'import'; table = 't'; source = 's'; sql = 'SELECT 1'; mode = 'replace'; line = 2 }); else = @() })) } | Should -Throw '*only at the top*'
        $deep = [ordered]@{ op = 'sql'; sql = 'SELECT 1'; line = 1 }
        for ($i = 0; $i -lt 20; $i++) { $deep = [ordered]@{ op = 'try'; line = 1; body = @($deep); catch = @() } }
        { Run (Plan @($deep)) } | Should -Throw '*16 deep*'
        $two = Run (Plan @((Sql 'SELECT 1; DROP TABLE stock' 5)))
        $two.ok | Should -BeFalse
        $two.error.message | Should -Match 'one SQL statement per step'
        (Q "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'stock'")[0].n | Should -Be 1
    }
    It 'pulls from a live source with IMPORT INTO through the guarded SELECT (mocked) and refuses anything but a SELECT' {
        $script:Pulled = $null
        Mock Find-SemSource { if ($Id -eq 'erp') { return [pscustomobject]@{ id = 'erp'; label = 'ERP'; kind = 'oracle'; provider = 'odbc'; connection = 'DSN=erp'; raw = $null } }; return $null }
        Mock Export-SemLiveRowsToCsv { $script:Pulled = $Sql; [IO.File]::WriteAllText($Path, "id,qty`n1,10`n2,20`n3,30`n"); return 3 }
        try {
            $plan = Plan @((Sql 'CREATE TABLE before_pull (a)' 1), [ordered]@{ op = 'import'; table = 'erp_orders'; source = 'erp'; sql = 'SELECT id, qty FROM orders'; mode = 'replace'; line = 2 }, (Sql 'SELECT SUM(qty) AS total FROM erp_orders' 3))
            $r = Run $plan
            $r.ok | Should -BeTrue -Because ([string]$r.error.message)
            $script:Pulled | Should -Be 'SELECT id, qty FROM orders'
            $r.results[1].changes | Should -Be 3
            $r.results[2].rows[0][0] | Should -Be 60
            (Q "SELECT source FROM _semaphore_tables WHERE name = 'erp_orders'")[0].source | Should -Be 'source erp'
            $bad = Run (Plan @([ordered]@{ op = 'import'; table = 'x'; source = 'erp'; sql = 'DELETE FROM orders'; mode = 'replace'; line = 4 }))
            $bad.ok | Should -BeFalse
            $bad.error.message | Should -Match 'Live databases stay read-only'
            $none = Run (Plan @([ordered]@{ op = 'import'; table = 'x'; source = 'nowhere'; sql = 'SELECT 1'; mode = 'replace'; line = 4 }))
            $none.error.message | Should -Match "no source 'nowhere'"
            Should -Invoke Export-SemLiveRowsToCsv -Times 1 -Exactly
        } finally { }
    }
    It 'saves, lists, runs and removes scripts in the library, refusing a bad id or a bad plan' {
        Save-Script 'count-stock' @((Sql 'SELECT COUNT(*) AS n FROM stock' 1))
        $saved = Invoke-SemSavedScript -HomeDir $script:HomeDir -Id 'count-stock'
        $saved.ok | Should -BeTrue -Because ([string]$saved.error.message)
        @(Get-SemScriptList -HomeDir $script:HomeDir | ForEach-Object { $_.id }) | Should -Contain 'count-stock'
        (Invoke-SemSavedScript -HomeDir $script:HomeDir -Id 'count-stock').results[0].rows[0][0] | Should -Be 2
        { Save-SemScript -HomeDir $script:HomeDir -Id '../evil' -Bytes ([byte[]]@(123, 125)) } | Should -Throw '*script id*'
        $badPlan = '{"version":1,"name":"x","dialect":"sqlite","plan":{"version":1,"nodes":[{"op":"rm","line":1}]}}'
        { Save-SemScript -HomeDir $script:HomeDir -Id 'bad' -Bytes ([Text.Encoding]::UTF8.GetBytes($badPlan)) } | Should -Throw '*not valid*'
        Remove-SemScript -HomeDir $script:HomeDir -Id 'count-stock' | Should -BeTrue
        Read-SemScript -HomeDir $script:HomeDir -Id 'count-stock' | Should -BeNullOrEmpty
    }
}

Describe 'Dataset exports' {
    BeforeAll {
        [void](Run (Plan @((Sql 'CREATE TABLE ex (id INTEGER, name TEXT, cost REAL, opened DATE, ok BOOLEAN)'), (Sql ("INSERT INTO ex VALUES (1, 'a,b', 1.5, '2026-01-02', 1), (2, '=SUM(A1)', NULL, '2026-02-03 04:05:06', 0), (3, 'line" + "`n" + "two', -2, NULL, NULL)")))))
    }
    It 'writes CSV with a byte-order mark, RFC 4180 quotes and formula-safe text' {
        $p = Join-Path $script:Work 'ex.csv'
        (Export-SemLocalDataset -HomeDir $script:HomeDir -Name 'ex' -Path $p -Format 'csv').Rows | Should -Be 3
        $bytes = [IO.File]::ReadAllBytes($p)
        $bytes[0..2] | Should -Be @(0xEF, 0xBB, 0xBF)
        $text = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
        $text | Should -Match '^id,name,cost,opened,ok\r\n1,"a,b",1\.5,2026-01-02,1\r\n'
        $text | Should -Match "2,'=SUM\(A1\),,2026-02-03 04:05:06,0"
        $text | Should -Match '3,"line\ntwo",-2,,'
        $back = Import-SemLocalFile -HomeDir $script:HomeDir -Path $p -Table 'ex_csv_back' -Replace
        $back.Rows | Should -Be 3
    }
    It 'writes a one-table SQLite file that LocalConnection reads back with its types' {
        $p = Join-Path $script:Work 'ex.sqlite'
        (Export-SemLocalDataset -HomeDir $script:HomeDir -Name 'ex' -Path $p -Format 'sqlite').Rows | Should -Be 3
        $c = New-Object SemLocal.LocalConnection ('Data Source=' + $p + ';Mode=ReadOnly'); $c.Open()
        try {
            @($c.UserTables() | ForEach-Object { $_[0] }) | Should -Be @('ex')
            (@($c.TableColumns('ex') | ForEach-Object { $_[1] }) -join ',') | Should -Be 'INTEGER,TEXT,REAL,DATE,BOOLEAN'
            $c.ScalarLong('SELECT COUNT(*) FROM ex') | Should -Be 3
            $c.Scalar("SELECT name FROM ex WHERE id = 2") | Should -Be '=SUM(A1)'
        } finally { $c.Dispose() }
    }
    It 'writes an xlsx workbook (ZipArchive) with a header row, numbers, dates and booleans, and the local importer reads it back' {
        $p = Join-Path $script:Work 'ex.xlsx'
        $r = Export-SemLocalDataset -HomeDir $script:HomeDir -Name 'ex' -Path $p -Format 'xlsx'
        $r.Rows | Should -Be 3
        $r.Note | Should -BeNullOrEmpty
        Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
        $zip = [IO.Compression.ZipFile]::OpenRead($p)
        try {
            @($zip.Entries | ForEach-Object { $_.FullName }) | Should -Contain 'xl/worksheets/sheet1.xml'
            $sr = New-Object IO.StreamReader ($zip.GetEntry('xl/worksheets/sheet1.xml').Open())
            $xml = $sr.ReadToEnd(); $sr.Dispose()
        } finally { $zip.Dispose() }
        $xml | Should -Match '<c r="A1" t="inlineStr"><is><t>id</t>'
        $xml | Should -Match '<c r="C2"><v>1.5</v></c>'
        $xml | Should -Match '<c r="D2" s="1"><v>46024</v></c>'
        $xml | Should -Match '<c r="E2" t="b"><v>1</v></c>'
        $back = Import-SemLocalFile -HomeDir $script:HomeDir -Path $p -Table 'ex_xlsx_back' -Replace
        $back.Rows | Should -Be 3
        (Q 'SELECT opened FROM ex_xlsx_back WHERE id = 1')[0].opened | Should -Be ([datetime]'2026-01-02')
    }
    It 'writes Parquet that SemColumnar reads back' {
        $p = Join-Path $script:Work 'ex.parquet'
        (Export-SemLocalDataset -HomeDir $script:HomeDir -Name 'ex' -Path $p -Format 'parquet').Rows | Should -Be 3
        $rd = [SemColumnar.ColumnarFiles]::Open($p)
        try {
            @($rd.Names) | Should -Be @('id', 'name', 'cost', 'opened', 'ok')
            $row = New-Object object[] 5; $n = 0
            while ($rd.Next($row)) { $n++ }
            $n | Should -Be 3
        } finally { $rd.Dispose() }
    }
    It 'refuses an unknown format or table' {
        { Export-SemLocalDataset -HomeDir $script:HomeDir -Name 'ex' -Path (Join-Path $script:Work 'x.doc') -Format 'doc' } | Should -Throw '*csv, parquet*'
        { Export-SemLocalDataset -HomeDir $script:HomeDir -Name 'nope' -Path (Join-Path $script:Work 'x.csv') -Format 'csv' } | Should -Throw '*No table*'
    }
}

Describe 'Pipelines' {
    BeforeAll {
        $script:OrdersCsv = Write-Csv 'orders.csv' "id,region,cost`n1,North,10`n2,South,20`n"
        Save-Script 'sum-orders' @((Sql 'DROP TABLE IF EXISTS order_totals' 1), (Sql 'CREATE TABLE order_totals AS SELECT region, SUM(cost) AS cost FROM orders GROUP BY region' 2))
        Save-Script 'broken' @((Sql 'DROP TABLE IF EXISTS order_totals' 1), (Sql 'CREATE TABLE order_totals AS SELECT region FROM orders' 2), (Sql 'SELECT no_such_column FROM orders' 3))
    }
    It 'validates a pipeline: steps, ids, kinds, tables, the SQL guard on pulls, and the schedule' {
        $ok = [pscustomobject]@{ version = 1; name = 'n'; steps = @([pscustomobject]@{ id = 'a'; kind = 'import'; path = 'C:\x.csv'; table = 't' }); schedule = [pscustomobject]@{ every = 'weekly'; time = '06:30'; days = @('mon', 'fri'); catchUp = $true } }
        Test-SemPipeline $ok | Should -BeNullOrEmpty
        $cases = @(
            @{ d = [pscustomobject]@{ version = 1; name = 'n'; steps = @() }; m = 'at least one step' },
            @{ d = [pscustomobject]@{ version = 1; name = 'n'; steps = @([pscustomobject]@{ id = 'A B'; kind = 'import'; path = 'x'; table = 't' }) }; m = 'id has' },
            @{ d = [pscustomobject]@{ version = 1; name = 'n'; steps = @([pscustomobject]@{ id = 'a'; kind = 'shell' }) }; m = 'kind is' },
            @{ d = [pscustomobject]@{ version = 1; name = 'n'; steps = @([pscustomobject]@{ id = 'a'; kind = 'import'; path = 'x'; upload = 'y'; table = 't' }) }; m = 'one of path' },
            @{ d = [pscustomobject]@{ version = 1; name = 'n'; steps = @([pscustomobject]@{ id = 'a'; kind = 'import'; path = 'x'; table = '_semaphore_x' }) }; m = 'table has' },
            @{ d = [pscustomobject]@{ version = 1; name = 'n'; steps = @([pscustomobject]@{ id = 'a'; kind = 'pull'; source = 'erp'; table = 't'; sql = 'DELETE FROM x' }) }; m = 'SELECT' },
            @{ d = [pscustomobject]@{ version = 1; name = 'n'; steps = @([pscustomobject]@{ id = 'a'; kind = 'script'; script = 'x' }, [pscustomobject]@{ id = 'a'; kind = 'publish' }) }; m = 'used twice' },
            @{ d = [pscustomobject]@{ version = 1; name = 'n'; steps = @([pscustomobject]@{ id = 'a'; kind = 'publish' }); schedule = [pscustomobject]@{ every = 'daily'; time = '25:00' } }; m = 'HH:mm' },
            @{ d = [pscustomobject]@{ version = 1; name = 'n'; steps = @([pscustomobject]@{ id = 'a'; kind = 'publish' }); schedule = [pscustomobject]@{ every = 'weekly'; time = '06:00'; days = @('someday') } }; m = 'days are' }
        )
        foreach ($c in $cases) { Test-SemPipeline $c.d | Should -Match $c.m }
        Test-SemPipelineBytes -Bytes (New-Object byte[] 300000) | Should -Match '256 KB'
    }
    It 'runs import, script and publish steps, logs rows and ms per step, and skips an unchanged source' {
        $snapDir = Join-Path $script:HomeDir 'snapshots'; [void][IO.Directory]::CreateDirectory($snapDir)
        [IO.File]::WriteAllText((Join-Path $snapDir 'cost-by-region.json'), '{"version":1,"id":"cost-by-region","title":"Cost by region","asOf":"2026-01-01T00:00:00Z","plan":{"source":"local","table":"order_totals"},"rows":[]}')
        [IO.File]::WriteAllText((Join-Path $snapDir 'other.json'), '{"version":1,"id":"other","title":"Other","plan":{"source":"erp","table":"order_totals"},"rows":[]}')
        Save-Pipeline 'nightly' ([ordered]@{ version = 1; name = 'Nightly'; steps = @(
                    [ordered]@{ id = 'load'; kind = 'import'; path = $script:OrdersCsv; table = 'orders' },
                    [ordered]@{ id = 'sum'; kind = 'script'; script = 'sum-orders' },
                    [ordered]@{ id = 'pub'; kind = 'publish' }) })
        $run = Invoke-SemPipelineRun -HomeDir $script:HomeDir -Id 'nightly'
        $run.state | Should -Be 'done'
        @($run.steps | ForEach-Object { $_.state }) | Should -Be @('done', 'done', 'done')
        $run.steps[0].rows | Should -Be 2
        $run.steps[0].ms | Should -Not -BeNullOrEmpty
        $run.outputs | Should -Contain 'order_totals'
        $run.steps[2].rows | Should -Be 1
        ([IO.File]::ReadAllText((Join-Path $snapDir 'cost-by-region.json'))) | Should -Match '^\{"invalidatedAt":"20'
        ([IO.File]::ReadAllText((Join-Path $snapDir 'other.json'))) | Should -Not -Match 'invalidatedAt'
        (Q "SELECT cost FROM order_totals WHERE region = 'South'")[0].cost | Should -Be 20
        $again = Invoke-SemPipelineRun -HomeDir $script:HomeDir -Id 'nightly'
        $again.steps[0].state | Should -Be 'skipped'
        $forced = Invoke-SemPipelineRun -HomeDir $script:HomeDir -Id 'nightly' -Force $true
        $forced.steps[0].state | Should -Be 'done'
        [IO.File]::WriteAllText($script:OrdersCsv, "id,region,cost`n1,North,10`n2,South,20`n3,South,5`n")
        (New-Object IO.FileInfo $script:OrdersCsv).LastWriteTimeUtc = [datetime]::UtcNow.AddMinutes(1)
        $changed = Invoke-SemPipelineRun -HomeDir $script:HomeDir -Id 'nightly'
        $changed.steps[0].state | Should -Be 'done'
        $changed.steps[0].rows | Should -Be 3
        @(Get-SemPipelineRuns -HomeDir $script:HomeDir -Id 'nightly').Count | Should -Be 4
    }
    It 'stops at the first failed step with its message, and the failed step leaves the tables as they were' {
        $before = (Q "SELECT COUNT(*) AS n, SUM(cost) AS c FROM order_totals")[0]
        Save-Pipeline 'broken' ([ordered]@{ version = 1; name = 'Broken'; steps = @(
                    [ordered]@{ id = 'load'; kind = 'import'; path = $script:OrdersCsv; table = 'orders' },
                    [ordered]@{ id = 'bad'; kind = 'script'; script = 'broken' },
                    [ordered]@{ id = 'pub'; kind = 'publish' }) })
        $run = Invoke-SemPipelineRun -HomeDir $script:HomeDir -Id 'broken' -Force $true
        $run.state | Should -Be 'failed'
        @($run.steps | ForEach-Object { $_.state }) | Should -Be @('done', 'failed', 'not run')
        $run.error | Should -Match 'Step 2 \(bad\) failed: Line 3: no such column'
        $after = (Q "SELECT COUNT(*) AS n, SUM(cost) AS c FROM order_totals")[0]
        $after.n | Should -Be $before.n
        $after.c | Should -Be $before.c
        (Q "SELECT name FROM sqlite_master WHERE name LIKE '\_semaphore\_stage%' ESCAPE '\'").Count | Should -Be 0
        $from = Invoke-SemPipelineRun -HomeDir $script:HomeDir -Id 'nightly' -From 'sum'
        @($from.steps | ForEach-Object { $_.state }) | Should -Be @('kept', 'done', 'done')
    }
    It 'runs one pipeline at a time' {
        Enter-SemPipelineLock -HomeDir $script:HomeDir -Id 'other' -Run 'r1' | Should -BeTrue
        try { { Invoke-SemPipelineRun -HomeDir $script:HomeDir -Id 'nightly' } | Should -Throw '*one runs at a time*' }
        finally { Exit-SemPipelineLock -HomeDir $script:HomeDir -Run 'r1' }
        Test-SemPipelineRunning -HomeDir $script:HomeDir | Should -BeFalse
    }
    It 'works out the last due time of hourly, daily and weekly schedules' {
        $now = Get-Date '2026-11-04T10:20:00'   # a Wednesday
        Get-SemPipelineLastDue -Schedule ([pscustomobject]@{ every = 'hourly'; minute = 30 }) -Now $now | Should -Be (Get-Date '2026-11-04T09:30:00')
        Get-SemPipelineLastDue -Schedule ([pscustomobject]@{ every = 'daily'; time = '06:00' }) -Now $now | Should -Be (Get-Date '2026-11-04T06:00:00')
        Get-SemPipelineLastDue -Schedule ([pscustomobject]@{ every = 'daily'; time = '11:00' }) -Now $now | Should -Be (Get-Date '2026-11-03T11:00:00')
        Get-SemPipelineLastDue -Schedule ([pscustomobject]@{ every = 'weekly'; time = '06:00'; days = @('mon', 'fri') }) -Now $now | Should -Be (Get-Date '2026-11-02T06:00:00')
        Get-SemPipelineLastDue -Schedule ([pscustomobject]@{ every = 'off' }) -Now $now | Should -BeNullOrEmpty
    }
    It 'starts a due run on the tick, once, and handles a run missed while the server was down by its catch-up setting' {
        $script:Started = New-Object System.Collections.Generic.List[string]
        $start = { param($id, $trigger, $run) $script:Started.Add($id + ':' + $trigger); Exit-SemPipelineLock -HomeDir $script:HomeDir -Run $run }
        Save-Pipeline 'hourly' ([ordered]@{ version = 1; name = 'Hourly'; steps = @([ordered]@{ id = 'pub'; kind = 'publish'; tables = @('x') }); schedule = [ordered]@{ every = 'hourly'; minute = 0 } })
        foreach ($id in 'nightly', 'broken') { $st = Read-SemPipelineState -HomeDir $script:HomeDir -Id $id; $st.lastScheduled = '2099-01-01T00:00:00Z'; Save-SemPipelineState -HomeDir $script:HomeDir -Id $id -State $st }
        $st = Read-SemPipelineState -HomeDir $script:HomeDir -Id 'hourly'; $st.lastScheduled = '2026-11-04T08:30:00Z'; Save-SemPipelineState -HomeDir $script:HomeDir -Id 'hourly' -State $st
        $serverUp = (Get-Date '2026-11-04T08:45:00Z').ToLocalTime()
        $nowA = (Get-Date '2026-11-04T09:00:30Z').ToLocalTime()
        Test-SemPipelineRunning -HomeDir $script:HomeDir | Should -BeFalse
        $t = Invoke-SemPipelineTick -HomeDir $script:HomeDir -Now $nowA -ServerStarted $serverUp -Start $start
        $t.Id | Should -Be 'hourly'
        $t.Trigger | Should -Be 'schedule'
        [void](Invoke-SemPipelineTick -HomeDir $script:HomeDir -Now $nowA.AddSeconds(30) -ServerStarted $serverUp -Start $start)
        @($script:Started) | Should -Be @('hourly:schedule')
        # Down from 09:30 to 12:10: the 10:00, 11:00 and 12:00 runs were missed. No catch-up: none runs.
        $up2 = (Get-Date '2026-11-04T12:10:00Z').ToLocalTime()
        $t2 = Invoke-SemPipelineTick -HomeDir $script:HomeDir -Now $up2 -ServerStarted $up2 -Start $start
        $t2 | Should -BeNullOrEmpty
        @($script:Started).Count | Should -Be 1
        # With catch-up: one run at start-up for the missed times, then none until the next hour.
        Save-Pipeline 'hourly' ([ordered]@{ version = 1; name = 'Hourly'; steps = @([ordered]@{ id = 'pub'; kind = 'publish'; tables = @('x') }); schedule = [ordered]@{ every = 'hourly'; minute = 0; catchUp = $true } })
        $st = Read-SemPipelineState -HomeDir $script:HomeDir -Id 'hourly'; $st.lastScheduled = '2026-11-04T09:00:00Z'; Save-SemPipelineState -HomeDir $script:HomeDir -Id 'hourly' -State $st
        $t3 = Invoke-SemPipelineTick -HomeDir $script:HomeDir -Now $up2 -ServerStarted $up2 -Start $start
        $t3.Trigger | Should -Be 'catch-up'
        [void](Invoke-SemPipelineTick -HomeDir $script:HomeDir -Now $up2.AddMinutes(5) -ServerStarted $up2 -Start $start)
        @($script:Started) | Should -Be @('hourly:schedule', 'hourly:catch-up')
        Remove-SemPipeline -HomeDir $script:HomeDir -Id 'hourly' | Should -BeTrue
    }
    It 'runs from the CLI: "pipeline run <id>" prints the run log and exits 0, a failed run exits 1' {
        $settingsHome = $script:HomeDir
        $env:SEMAPHORE_HOME = $settingsHome
        try {
            $cli = Join-Path $script:Root 'server\Invoke-SemaphoreCli.ps1'
            $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $cli pipeline run nightly --force yes 2>&1
            $LASTEXITCODE | Should -Be 0 -Because ($out -join "`n")
            ($out -join "`n") | Should -Match 'done\s+import\s+load\s+3 rows'
            $bad = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $cli pipeline run --id broken --json 2>&1
            $LASTEXITCODE | Should -Be 1
            (($bad | Where-Object { $_ -match '^\{' }) -join '' | ConvertFrom-Json).ok | Should -BeFalse
        } finally { Remove-Item env:SEMAPHORE_HOME -ErrorAction SilentlyContinue }
    }
}
