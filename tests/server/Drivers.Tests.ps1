# Pester 5. ODBC and OLE DB through the real Windows drivers, not mocks: Semaphore's own source loading, SQL guard,
# typed parameter binding, connection, result writer, row cap, profiling and error mapping run against a CSV folder
# read by the Microsoft Access Text ODBC driver and the ACE OLE DB provider. A database server is not involved, so
# this proves the driver plumbing (binding, types, errors, secrets stay out of messages), not any vendor's SQL dialect.
# A test is skipped, and says so, when its driver is not installed on the machine that runs it.
BeforeDiscovery {
    $odbcKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\ODBC\ODBCINST.INI\ODBC Drivers')
    $script:HasOdbc = [Environment]::Is64BitProcess -and $null -ne $odbcKey -and (@($odbcKey.GetValueNames()) -contains 'Microsoft Access Text Driver (*.txt, *.csv)')
    $script:HasOleDb = [Environment]::Is64BitProcess -and $null -ne [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey('Microsoft.ACE.OLEDB.12.0')
}
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Lake.ps1', 'Vault.ps1', 'Connectors.ps1') { . ([IO.Path]::Combine($server, $f)) }
    [void](Initialize-SemJsonWriter)

    $script:Data = Join-Path $TestDrive 'csv'
    New-Item -ItemType Directory -Path $script:Data | Out-Null
    Set-Content -LiteralPath (Join-Path $script:Data 'work_orders.csv') -Encoding ASCII -Value @(
        'region,labor_cost,opened_on,done,note',
        'Gulf,100.5,2026-01-15,1,"first, with comma"',
        'Gulf,50,2026-02-10,0,',
        'West,75.25,2026-02-20,1,third',
        'East,10,2026-03-05,0,fourth')
    Set-Content -LiteralPath (Join-Path $script:Data 'schema.ini') -Encoding ASCII -Value @(
        '[work_orders.csv]', 'Format=CSVDelimited', 'ColNameHeader=True', 'DateTimeFormat=yyyy-mm-dd',
        'Col1=region Text', 'Col2=labor_cost Double', 'Col3=opened_on Date', 'Col4=done Bit', 'Col5=note Text')

    $script:SemTestHome = Join-Path $TestDrive 'home'
    New-Item -ItemType Directory -Path $script:SemTestHome | Out-Null
    $odbc = "Driver={Microsoft Access Text Driver (*.txt, *.csv)};Dbq=$($script:Data);Extensions=asc,csv,tab,txt"
    $oledb = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$($script:Data);Extended Properties=""text;HDR=Yes;FMT=Delimited"""
    $bad = "Driver={Microsoft Access Text Driver (*.txt, *.csv)};Dbq=$(Join-Path $TestDrive 'does-not-exist');Extensions=csv"
    $list = @(
        [ordered]@{ id = 'o'; kind = 'access'; provider = 'odbc'; connection = $odbc }
        [ordered]@{ id = 'ole'; kind = 'access'; provider = 'oledb'; connection = $oledb }
        [ordered]@{ id = 'bad'; kind = 'other'; provider = 'odbc'; connection = $bad }
    )
    Set-Content -LiteralPath (Join-Path $script:SemTestHome 'sources.json') -Encoding UTF8 -Value (ConvertTo-Json -InputObject $list)

    function script:Invoke-Plan([string]$Source, [string]$Sql, $Params = @(), [int]$RowCap = 1000) {
        $plan = Get-SemQueryPlan -Body ([pscustomobject]@{ source = $Source; sql = $Sql; params = $Params; rowCap = $RowCap }) -HomeDir $script:SemTestHome
        if ($plan.ContainsKey('Error')) { throw ('plan: ' + $plan.Error.Code) }
        $conn = New-SemConnection -Source $plan.Source -TimeoutSec 30
        try { return (Invoke-SemQueryOnConnection -Connection $conn -Plan $plan | ConvertFrom-Json) } finally { $conn.Dispose() }
    }
}

Describe 'ODBC through the Microsoft Access Text driver' -Skip:(-not $script:HasOdbc) {
    It 'loads the source and returns typed columns' {
        $o = Invoke-Plan 'o' 'SELECT region, labor_cost, opened_on, done, note FROM [work_orders#csv] ORDER BY labor_cost DESC'
        $o.columns | Should -Be @('region', 'labor_cost', 'opened_on', 'done', 'note')
        @($o.rows).Count | Should -Be 4
        $o.rows[0].region | Should -Be 'Gulf'
        $o.rows[0].labor_cost | Should -Be 100.5
        $o.rows[0].opened_on | Should -Be '2026-01-15'
        $o.rows[0].done | Should -BeTrue
        $o.rows[0].note | Should -Be 'first, with comma'
        $o.rows[1].note | Should -Be 'third'; $o.rows[2].note | Should -BeNullOrEmpty
        $o.truncated | Should -BeFalse
    }
    It 'binds date, number, string and boolean parameters by type' {
        (Invoke-Plan 'o' 'SELECT region FROM [work_orders#csv] WHERE opened_on >= ?' @([pscustomobject]@{ type = 'date'; value = '2026-02-01' })).rows.Count | Should -Be 3
        (Invoke-Plan 'o' 'SELECT region FROM [work_orders#csv] WHERE labor_cost > ?' @([pscustomobject]@{ type = 'number'; value = 60 })).rows.Count | Should -Be 2
        (Invoke-Plan 'o' 'SELECT region FROM [work_orders#csv] WHERE region = ?' @([pscustomobject]@{ type = 'string'; value = 'Gulf' })).rows.Count | Should -Be 2
        (Invoke-Plan 'o' 'SELECT region FROM [work_orders#csv] WHERE done = ?' @([pscustomobject]@{ type = 'boolean'; value = $true })).rows.Count | Should -Be 2
    }
    It 'aggregates in the driver and keeps the aliases' {
        $o = Invoke-Plan 'o' 'SELECT region AS d0, SUM(labor_cost) AS a0 FROM [work_orders#csv] GROUP BY region ORDER BY SUM(labor_cost) DESC'
        $o.columns | Should -Be @('d0', 'a0')
        $o.rows[0].d0 | Should -Be 'Gulf'; $o.rows[0].a0 | Should -Be 150.5
    }
    It 'keeps a hostile string value as data, never as SQL' {
        $o = Invoke-Plan 'o' 'SELECT region FROM [work_orders#csv] WHERE region = ?' @([pscustomobject]@{ type = 'string'; value = "Gulf' OR '1'='1" })
        @($o.rows).Count | Should -Be 0
    }
    It 'stops at the row cap and marks the result truncated' {
        $o = Invoke-Plan 'o' 'SELECT region FROM [work_orders#csv]' @() 2
        @($o.rows).Count | Should -Be 2; $o.truncated | Should -BeTrue
    }
    It 'refuses SQL the guard does not allow before any connection is made' {
        { Invoke-Plan 'o' 'DELETE FROM [work_orders#csv]' } | Should -Throw '*sql-refused*'
        { Invoke-Plan 'o' 'SELECT 1; SELECT 2' } | Should -Throw '*sql-refused*'
    }
    It 'maps a bad table to a query error that does not contain the connection string' {
        $plan = Get-SemQueryPlan -Body ([pscustomobject]@{ source = 'o'; sql = 'SELECT x FROM [nope#csv]'; params = @() }) -HomeDir $script:SemTestHome
        $conn = New-SemConnection -Source $plan.Source -TimeoutSec 30
        try {
            $err = $null
            try { [void](Invoke-SemQueryOnConnection -Connection $conn -Plan $plan) } catch { $err = Get-SemQueryError -Exception $_.Exception -Source $plan.Source -Stage 'query' }
            $err.Code | Should -Be 'query-failed'; $err.Status | Should -Be 422
            $err.Message | Should -Not -BeLike "*$($script:Data)*"
            $err.Message | Should -Not -BeLike '*Dbq=*'
        } finally { $conn.Dispose() }
    }
    It 'maps an unreachable source to source-unavailable without the connection string' {
        $src = Find-SemSource -HomeDir $script:SemTestHome -Id 'bad'
        $err = $null
        try { [void](New-SemConnection -Source $src -TimeoutSec 5) } catch { $err = Get-SemQueryError -Exception $_.Exception -Source $src -Stage 'connect' }
        $err.Code | Should -Be 'source-unavailable'; $err.Status | Should -Be 502
        $err.Message | Should -Not -BeLike '*Dbq=*'
    }
    It 'profiles the table: columns, kinds, distinct counts and samples' {
        $src = Find-SemSource -HomeDir $script:SemTestHome -Id 'o'
        $conn = New-SemConnection -Source $src -TimeoutSec 30
        try {
            $p = Get-SemProfileTable -Connection $conn -Source $src -Table 'work_orders#csv'
            $byName = @{}; foreach ($c in $p.columns) { $byName[$c.name] = $c }
            $byName['labor_cost'].type | Should -Be 'number'
            $byName['opened_on'].type | Should -Be 'date'
            $byName['region'].type | Should -Be 'string'
            $byName['region'].distinct | Should -Be 3
        } finally { $conn.Dispose() }
    }
    It 'opens a vault source with the password in memory only' {
        $src = [pscustomobject]@{ id = 'v'; kind = 'access'; provider = 'odbc'; connection = "Driver={Microsoft Access Text Driver (*.txt, *.csv)};Dbq=$($script:Data);Extensions=csv"; raw = ([pscustomobject]@{ vault = [pscustomobject]@{ item = 'x' } }) }
        Set-SemVaultRequest @{ Values = @{ password = 'unused-by-text-driver' } }
        try {
            $conn = New-SemConnection -Source $src -TimeoutSec 30
            try { $conn.State.ToString() | Should -Be 'Open' } finally { $conn.Dispose() }
            $src.connection | Should -Not -BeLike '*PWD*'
        } finally { Set-SemVaultRequest $null }
    }
}

Describe 'OLE DB through the ACE provider' -Skip:(-not $script:HasOleDb) {
    It 'returns typed columns and binds parameters by type' {
        $o = Invoke-Plan 'ole' 'SELECT region, labor_cost, opened_on FROM [work_orders#csv] WHERE opened_on >= ? AND labor_cost > ? ORDER BY labor_cost DESC' @([pscustomobject]@{ type = 'date'; value = '2026-02-01' }, [pscustomobject]@{ type = 'number'; value = 20 })
        @($o.rows).Count | Should -Be 2
        $o.rows[0].region | Should -Be 'West'; $o.rows[0].labor_cost | Should -Be 75.25; $o.rows[0].opened_on | Should -Be '2026-02-20'
    }
    It 'opens read-only: Mode=Read is added to the connection string' {
        $src = Find-SemSource -HomeDir $script:SemTestHome -Id 'ole'
        Get-SemEffectiveConnectionString -Source $src | Should -BeLike '*;Mode=Read'
        $conn = New-SemConnection -Source $src -TimeoutSec 30
        try { $conn.State.ToString() | Should -Be 'Open' } finally { $conn.Dispose() }
    }
    It 'stops at the row cap' {
        $o = Invoke-Plan 'ole' 'SELECT region FROM [work_orders#csv]' @() 3
        @($o.rows).Count | Should -Be 3; $o.truncated | Should -BeTrue
    }
    It 'maps a bad table to a query error without the connection string' {
        $src = Find-SemSource -HomeDir $script:SemTestHome -Id 'ole'
        $plan = Get-SemQueryPlan -Body ([pscustomobject]@{ source = 'ole'; sql = 'SELECT x FROM [nope#csv]'; params = @() }) -HomeDir $script:SemTestHome
        $conn = New-SemConnection -Source $src -TimeoutSec 30
        try {
            $err = $null
            try { [void](Invoke-SemQueryOnConnection -Connection $conn -Plan $plan) } catch { $err = Get-SemQueryError -Exception $_.Exception -Source $src -Stage 'query' }
            $err.Code | Should -Be 'query-failed'
            $err.Message | Should -Not -BeLike '*Extended Properties*'
        } finally { $conn.Dispose() }
    }
}
