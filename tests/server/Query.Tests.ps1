# Pester 5. Query result encoding (rows keyed by alias, ISO dates, null, numbers, truncation) with
# an in-memory DataTable reader instead of a database, for both the C# and the PowerShell writer,
# plus the hoist/catalog file store. ODBC and OLE DB themselves need Windows and a real source.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    . ([IO.Path]::Combine($server, 'Common.ps1'))
    . ([IO.Path]::Combine($server, 'Http.ps1'))
    . ([IO.Path]::Combine($server, 'Routes.ps1'))
    . ([IO.Path]::Combine($server, 'Query.ps1'))

    function New-TestTable {
        $t = New-Object Data.DataTable
        foreach ($c in @(@('region', [string]), @('month', [datetime]), @('opened', [datetime]), @('cost', [decimal]), @('ratio', [double]), @('n', [int]), @('ok', [bool]), @('note', [string]))) {
            [void]$t.Columns.Add($c[0], $c[1])
        }
        [void]$t.Rows.Add('North "east"', [datetime]'2026-01-01', [datetime]'2026-01-02T13:45:10', [decimal]'1234.50', 0.25, 7, $true, ("line1`nline2 <b>"))
        [void]$t.Rows.Add('South', [datetime]'2026-02-01', [datetime]'2026-02-03T00:00:00', [decimal]'-0.5', [double]::NaN, 0, $false, [DBNull]::Value)
        [void]$t.Rows.Add('West', [DBNull]::Value, [DBNull]::Value, [DBNull]::Value, [DBNull]::Value, [DBNull]::Value, [DBNull]::Value, '')
        return , $t
    }
    function Get-TestResult([int]$Cap) {
        $t = New-TestTable
        $r = $t.CreateDataReader()
        $sb = New-Object Text.StringBuilder
        $tr = Write-SemReaderResult -Reader $r -RowCap $Cap -Sb $sb
        [void]$sb.Append(',"ms":1}')
        return @{ Truncated = $tr; Json = $sb.ToString() }
    }
}

Describe 'Query result JSON (<Mode> writer)' -ForEach @(@{ Mode = 'csharp' }, @{ Mode = 'powershell' }) {
    BeforeAll {
        if ($Mode -eq 'powershell') { [void](Initialize-SemJsonWriter -ForcePowerShell) } else { [void](Initialize-SemJsonWriter) }
    }

    It 'uses the requested writer' {
        $script:SemJsonMode | Should -Be $Mode
    }

    It 'returns columns and rows keyed by alias, with typed values' {
        $res = Get-TestResult 50000
        $res.Truncated | Should -BeFalse
        $j = $res.Json | ConvertFrom-Json
        @($j.columns) -join ',' | Should -Be 'region,month,opened,cost,ratio,n,ok,note'
        @($j.rows).Count | Should -Be 3
        $j.truncated | Should -BeFalse
        $j.rows[0].region | Should -Be 'North "east"'
        $j.rows[0].note | Should -Be "line1`nline2 <b>"
        $j.rows[0].cost | Should -Be 1234.5
        $j.rows[0].ratio | Should -Be 0.25
        $j.rows[0].n | Should -Be 7
        $j.rows[0].ok | Should -BeTrue
        $j.rows[1].ok | Should -BeFalse
        $j.rows[1].note | Should -BeNullOrEmpty
        $j.rows[2].note | Should -Be ''
    }

    It 'writes dates as yyyy-MM-dd at midnight, else yyyy-MM-ddTHH:mm:ss, and DBNull/NaN as null' {
        $res = Get-TestResult 50000
        $res.Json | Should -Match '"month":"2026-01-01"'
        $res.Json | Should -Match '"opened":"2026-01-02T13:45:10"'
        $res.Json | Should -Match '"opened":"2026-02-03"'
        $res.Json | Should -Match '"cost":1234\.50?,'
        $res.Json | Should -Match '"cost":-0\.5'
        $res.Json | Should -Match '"ratio":null'
        $res.Json | Should -Match '"month":null,"opened":null,"cost":null,"ratio":null,"n":null,"ok":null'
    }

    It 'stops at the row cap and marks the result truncated' {
        $res = Get-TestResult 2
        $res.Truncated | Should -BeTrue
        $j = $res.Json | ConvertFrom-Json
        @($j.rows).Count | Should -Be 2
        $j.truncated | Should -BeTrue
        (Get-TestResult 3).Truncated | Should -BeFalse
    }

    It 'gives profile samples as strings' {
        ConvertTo-SemSampleText ([datetime]'2026-03-04') | Should -Be '2026-03-04'
        ConvertTo-SemSampleText ([decimal]2.25) | Should -Be '2.25'
        ConvertTo-SemSampleText ([DBNull]::Value) | Should -BeNullOrEmpty
        ConvertTo-SemSampleText $true | Should -Be 'true'
    }
}

Describe 'Field kinds for profiling' {
    It 'maps <T> to <K>' -TestCases @(
        @{ T = [int]; K = 'number' }, @{ T = [decimal]; K = 'number' }, @{ T = [double]; K = 'number' }, @{ T = [long]; K = 'number' },
        @{ T = [datetime]; K = 'date' }, @{ T = [bool]; K = 'boolean' }, @{ T = [string]; K = 'string' }, @{ T = [guid]; K = 'string' }
    ) {
        Get-SemFieldKind $T | Should -Be $K
    }
}

Describe 'Document store' {
    BeforeAll {
        $script:Dir = Join-Path ([IO.Path]::GetTempPath()) ('sem-docs-' + [guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($script:Dir)
    }
    AfterAll { Remove-Item -LiteralPath $script:Dir -Recurse -Force -ErrorAction SilentlyContinue }

    It 'writes atomically and replaces an existing file' {
        Save-SemDoc -Dir $script:Dir -Id 'a' -Bytes ([Text.Encoding]::UTF8.GetBytes('{"version":1,"title":"One"}'))
        Save-SemDoc -Dir $script:Dir -Id 'a' -Bytes ([Text.Encoding]::UTF8.GetBytes('{"version":1,"title":"Two"}'))
        Read-SemDoc -Dir $script:Dir -Id 'a' | Should -Be '{"version":1,"title":"Two"}'
        @(Get-ChildItem -LiteralPath $script:Dir -Force -Filter '*.tmp').Count | Should -Be 0
    }

    It 'lists documents, skipping unreadable files and bad names' {
        [IO.File]::WriteAllText((Join-Path $script:Dir 'broken.json'), '{ not json')
        [IO.File]::WriteAllText((Join-Path $script:Dir 'bad name.json'), '{"version":1}')
        [IO.File]::WriteAllText((Join-Path $script:Dir 'b.json'), '{"version":1,"label":"Catalog B"}')
        $list = Get-SemDocList -Dir $script:Dir   # one array object (Send-SemJson serialises it whole)
        ($list | ForEach-Object { $_.id }) -join ',' | Should -Be 'a,b'
        $list[0].title | Should -Be 'Two'
        $list[1].title | Should -Be 'Catalog B'
        $list[1].updated | Should -Match '^\d{4}-\d{2}-\d{2}T'
    }

    It 'moves a deleted document to .trash with a unique timestamp suffix' {
        $now = [datetime]'2026-10-26T09:08:07'
        Remove-SemDoc -Dir $script:Dir -Id 'b' -Now $now | Should -BeTrue
        [IO.File]::WriteAllText((Join-Path $script:Dir 'b.json'), '{"version":1}')
        Remove-SemDoc -Dir $script:Dir -Id 'b' -Now $now | Should -BeTrue
        Test-Path -LiteralPath ([IO.Path]::Combine($script:Dir, '.trash', 'b-20261026-090807.json')) | Should -BeTrue
        Test-Path -LiteralPath ([IO.Path]::Combine($script:Dir, '.trash', 'b-20261026-090807-2.json')) | Should -BeTrue
        Remove-SemDoc -Dir $script:Dir -Id 'b' -Now $now | Should -BeFalse
    }
}
