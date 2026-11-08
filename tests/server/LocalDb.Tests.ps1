# Pester 5. The local database (server/LocalDb.cs and LocalDb.ps1) on the SQLite engine that ships with
# Windows: open and create, the CSV parser and type inference, Excel and SQLite imports, the columnar hook,
# parameters, the time limit, GetSchema and profiling, read-only refusal on the query path, the network
# share allowlist, the routes (including a real streamed upload over a loopback socket) and a 2M-row timing.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Vault.ps1', 'Connectors.ps1', 'LocalDb.ps1', 'Commands.ps1') { . ([IO.Path]::Combine($server, $f)) }
    Initialize-SemLocalTypes

    $script:Work = Join-Path ([IO.Path]::GetTempPath()) ('sem-local-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($script:Work)
    $script:HomeDir = Resolve-SemHome -Settings @{ home = (Join-Path $script:Work 'home') } -Create
    $script:Sem.Home = $script:HomeDir
    $script:Sem.Port = 8800
    $script:Sem.Token = New-SemToken
    $script:Sem.Version = '0.0.0-test'
    $script:Sem.LocalShares = @()
    [void](Initialize-SemLocalDb -HomeDir $script:HomeDir -Cleanup)

    function script:Write-TestFile([string]$Name, [string]$Text, $Encoding = (New-Object Text.UTF8Encoding $false)) {
        $p = Join-Path $script:Work $Name
        [IO.File]::WriteAllText($p, $Text, $Encoding)
        return $p
    }
    function script:Get-Rows([string]$Sql, [object[]]$Params = @()) {
        $c = Open-SemLocalConnection -HomeDir $script:HomeDir
        try {
            $cmd = $c.CreateCommand(); $cmd.CommandText = $Sql
            foreach ($v in $Params) { [void]$cmd.Parameters.Add((New-Object SemLocal.LocalParameter 'p', $v)) }
            $r = $cmd.ExecuteReader()
            $out = New-Object System.Collections.Generic.List[object]
            try {
                while ($r.Read()) {
                    $row = [ordered]@{}
                    for ($i = 0; $i -lt $r.FieldCount; $i++) { $row[$r.GetName($i)] = $r.GetValue($i) }
                    $out.Add([pscustomobject]$row)
                }
            } finally { $r.Dispose(); $cmd.Dispose() }
            return , $out.ToArray()
        } finally { $c.Dispose() }
    }
    function script:Get-Decl([string]$Table) {
        $c = Open-SemLocalConnection -HomeDir $script:HomeDir
        try { return (@($c.TableColumns($Table) | ForEach-Object { $_[1] }) -join ',') } finally { $c.Dispose() }
    }
    function script:Import-Text([string]$Name, [string]$Text, [hashtable]$More = @{}, $Encoding = (New-Object Text.UTF8Encoding $false)) {
        $p = Write-TestFile $Name $Text $Encoding
        return (Import-SemLocalFile -HomeDir $script:HomeDir -Path $p @More)
    }
    function script:New-TestXlsx([string]$Path) {
        Add-Type -AssemblyName System.IO.Compression
        $fs = [IO.File]::Create($Path)
        $zip = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
        $put = {
            param($name, $xml)
            $e = $zip.CreateEntry($name)
            $w = New-Object IO.StreamWriter($e.Open(), (New-Object Text.UTF8Encoding $false))
            $w.Write($xml); $w.Dispose()
        }
        & $put '[Content_Types].xml' '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'
        & $put '_rels/.rels' '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
        & $put 'xl/workbook.xml' '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Jobs" sheetId="1" r:id="rId1"/><sheet name="Crew List" sheetId="2" r:id="rId2"/></sheets></workbook>'
        & $put 'xl/_rels/workbook.xml.rels' '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>'
        & $put 'xl/sharedStrings.xml' '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Job</t></si><si><t>Opened</t></si><si><t>Hours</t></si><si><t>Done</t></si><si><r><t>Note </t></r><r><t>text</t></r><rPh><t>x</t></rPh></si><si><t>Pump &amp; valve</t></si><si><t>Started</t></si><si><t>Name</t></si></sst>'
        & $put 'xl/styles.xml' '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\-mm\-dd\ hh:mm"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>'
        # Row 1 headers (shared strings, one rich text), then numbers, a boolean, an inline string, dates by style, a missing cell.
        & $put 'xl/worksheets/sheet1.xml' ('<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>6</v></c></row>' +
            '<row r="2"><c r="A2"><v>101</v></c><c r="B2" s="1"><v>45306</v></c><c r="C2"><v>2.5</v></c><c r="D2" t="b"><v>1</v></c><c r="E2" t="s"><v>5</v></c><c r="F2" s="2"><v>45306.5</v></c></row>' +
            '<row r="3"><c r="A3"><v>102</v></c><c r="B3" s="1"><v>45337</v></c><c r="C3"><v>4</v></c><c r="D3" t="b"><v>0</v></c><c r="E3" t="inlineStr"><is><t>inline one</t></is></c></row>' +
            '<row r="5"><c r="A5"><v>103</v></c><c r="C5"><v>1e3</v></c><c r="D5" t="b"><v>0</v></c><c r="E5" t="str"><v>formula text</v></c><c r="F5" s="2"><v>45337.25</v></c></row>' +
            '</sheetData></worksheet>')
        & $put 'xl/worksheets/sheet2.xml' '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>7</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Ana</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Bo</t></is></c></row></sheetData></worksheet>'
        $zip.Dispose(); $fs.Dispose()
    }
    function script:New-Req([string]$Method, [string]$Path, $Json = $null, [hashtable]$Headers = @{}) {
        $h = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        $h['Host'] = '127.0.0.1:8800'
        $h['X-Semaphore-Session'] = $script:Sem.Token
        foreach ($k in $Headers.Keys) { $h[$k] = [string]$Headers[$k] }
        $bytes = New-Object byte[] 0
        if ($null -ne $Json) { $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Json -Compress)) }
        return @{ Method = $Method; Path = $Path; Query = ''; Headers = $h; ContentLength = $bytes.Length; Body = $bytes; Json = $null; RemoteAddress = [Net.IPAddress]::Loopback; Client = $null }
    }
    function script:Invoke-Req($Req) {
        $ms = New-Object IO.MemoryStream
        $script:Sem.Stream = $ms
        Invoke-SemRequest -Req $Req
        $script:Sem.Stream = $null
        $text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
        $split = $text.IndexOf("`r`n`r`n")
        $body = $text.Substring($split + 4)
        $j = $null; if ($body) { $j = $body | ConvertFrom-Json }
        return [pscustomobject]@{ Status = [int]($text.Substring(0, $split).Split(' ')[1]); Body = $body; Json = $j }
    }
    function script:Wait-Job([string]$Job, [int]$Seconds = 60) {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
            Update-SemLocalJobs
            $t = Read-SemLocalJobStatus -HomeDir $script:HomeDir -Job $Job
            if ($t) { $s = $t | ConvertFrom-Json; if ($s.state -eq 'done' -or $s.state -eq 'failed') { Update-SemLocalJobs; return $s } }
            Start-Sleep -Milliseconds 100
        }
        throw "Job $Job did not finish"
    }
}

AfterAll {
    try { Stop-SemLocalJobs } catch { }
    Remove-Item -LiteralPath $script:Work -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Opening and creating the database' {
    It 'creates <home>\local\warehouse.sqlite with WAL, 8 KB pages and the metadata table' {
        $db = Get-SemLocalDbPath -HomeDir $script:HomeDir
        [IO.File]::Exists($db) | Should -BeTrue
        foreach ($d in 'temp', 'incoming', 'jobs') { [IO.Directory]::Exists((Join-Path (Join-Path $script:HomeDir 'local') $d)) | Should -BeTrue }
        $c = Open-SemLocalConnection -HomeDir $script:HomeDir -Write
        try {
            $c.Scalar('PRAGMA journal_mode') | Should -Be 'wal'
            $c.ScalarLong('PRAGMA page_size') | Should -Be 8192
            $c.ScalarLong('PRAGMA temp_store') | Should -Be 1
            $c.TableExists('_semaphore_tables') | Should -BeTrue
        } finally { $c.Dispose() }
    }
    It 'opens read-only for queries and reports the Windows SQLite version' {
        $c = Open-SemLocalConnection -HomeDir $script:HomeDir
        try {
            $c.IsReadOnly | Should -BeTrue
            $c.State | Should -Be 'Open'
            [SemLocal.LocalConnection]::Version | Should -Match '^3\.\d+\.\d+'
        } finally { $c.Dispose() }
        $c.State | Should -Be 'Closed'
    }
    It 'refuses a connection string without a Data Source and an unknown mode' {
        { (New-Object SemLocal.LocalConnection 'Mode=ReadOnly').Open() } | Should -Throw '*Data Source*'
        { New-Object SemLocal.LocalConnection 'Data Source=x;Mode=Sideways' } | Should -Throw
    }
    It 'drops staging tables a crashed import left behind' {
        $c = Open-SemLocalConnection -HomeDir $script:HomeDir -Write
        try { $c.Execute('CREATE TABLE _semaphore_stage_deadbeef0000 (a)') } finally { $c.Dispose() }
        [void](Initialize-SemLocalDb -HomeDir $script:HomeDir -Cleanup)
        $c = Open-SemLocalConnection -HomeDir $script:HomeDir
        try { $c.TableExists('_semaphore_stage_deadbeef0000') | Should -BeFalse } finally { $c.Dispose() }
    }
}

Describe 'CSV import' {
    It 'reads quotes, doubled quotes, embedded delimiters and newlines, CRLF and LF' {
        $text = "id,name,note`r`n1,""Smith, J"",""said """"hi""""""`r`n2,plain,""two`r`nlines""`n3,""x"",""lf`nonly""`n"
        $r = Import-Text 'quotes.csv' $text
        $r.Rows | Should -Be 3
        $rows = Get-Rows 'SELECT * FROM quotes ORDER BY id'
        $rows[0].name | Should -Be 'Smith, J'
        $rows[0].note | Should -Be 'said "hi"'
        $rows[1].note | Should -Be "two`r`nlines"
        $rows[2].note | Should -Be "lf`nonly"
    }
    It 'strips a UTF-8 BOM and keeps non-ASCII text' {
        $r = Import-Text 'bom8.csv' "city,n`r`nK$([char]0xF8)benhavn,1`r`n" -Encoding (New-Object Text.UTF8Encoding $true)
        $r.Names[0] | Should -Be 'city'
        (Get-Rows 'SELECT city FROM bom8')[0].city | Should -Be "K$([char]0xF8)benhavn"
    }
    It 'reads UTF-16 with a BOM' {
        $r = Import-Text 'bom16.csv' "a,b`r`nx,2`r`n" -Encoding (New-Object Text.UnicodeEncoding $false, $true)
        $r.Rows | Should -Be 1
        (Get-Rows 'SELECT a, b FROM bom16')[0].a | Should -Be 'x'
    }
    It 'falls back to Windows-1252 when the bytes are not UTF-8' {
        $p = Join-Path $script:Work 'ansi.csv'
        [IO.File]::WriteAllBytes($p, [byte[]](0x6E, 0x61, 0x6D, 0x65, 0x0A, 0x63, 0x61, 0x66, 0xE9, 0x0A))
        [void](Import-SemLocalFile -HomeDir $script:HomeDir -Path $p)
        (Get-Rows 'SELECT name FROM ansi')[0].name | Should -Be "caf$([char]0xE9)"
    }
    It 'sniffs <Name> as the delimiter' -TestCases @(
        @{ Name = 'semicolon'; D = ';'; File = 'semi.csv' }, @{ Name = 'tab'; D = "`t"; File = 'tabbed.tsv' }, @{ Name = 'pipe'; D = '|'; File = 'piped.txt' }
    ) {
        $text = "a${D}b${D}c`n1${D}""x${D}y""${D}3`n4${D}z${D}6`n"
        $r = Import-Text $File $text
        $r.Columns | Should -Be 3
        $t = $r.Table
        (Get-Rows "SELECT b FROM $t ORDER BY a")[0].b | Should -Be "x${D}y"
    }
    It 'infers BOOLEAN, INTEGER, REAL, DATE and TEXT, and keeps leading zeros and empty cells' {
        $text = "ok,n,x,day,at,zip,blank`n" + "true,1,1.5,2024-01-05,2024-01-05T10:30:00,007,`n" + "FALSE,-2,3,2024-02-29,2024-02-01 08:00,010,`n"
        $r = Import-Text 'types.csv' $text
        Get-Decl 'types' | Should -Be 'BOOLEAN,INTEGER,REAL,DATE,DATE,TEXT,TEXT'
        $rows = Get-Rows 'SELECT * FROM types ORDER BY n DESC'
        $rows[0].ok | Should -BeTrue
        $rows[0].ok | Should -BeOfType [bool]
        $rows[0].n | Should -BeOfType [long]
        $rows[0].x | Should -BeOfType [double]
        $rows[0].day | Should -Be ([datetime]'2024-01-05')
        $rows[0].at | Should -Be ([datetime]'2024-01-05T10:30:00')
        $rows[0].zip | Should -Be '007'
        $rows[0].blank | Should -BeOfType [DBNull]
        # Datetimes are stored in SQLite's own form so date() and strftime() and string comparison agree.
        (Get-Rows "SELECT typeof(at) AS t, at >= '2024-02-01' AS later, strftime('%H', at) AS h FROM types ORDER BY n")[0].h | Should -Be '08'
    }
    It 'widens a column past the sample: integer to real, integer to text, boolean to text, date to text' {
        $sb = New-Object Text.StringBuilder
        [void]$sb.Append("n,m,flag,day`n")
        for ($i = 0; $i -lt 50; $i++) { [void]$sb.Append("$i,$i,true,2024-01-01`n") }
        [void]$sb.Append("2.5,abc,1,someday`n")
        $o = New-Object SemLocal.ImportOptions; $o.SampleRows = 10
        $r = Import-Text 'widen.csv' $sb.ToString() @{ Options = $o }
        $r.Rows | Should -Be 51
        Get-Decl 'widen' | Should -Be 'REAL,TEXT,TEXT,TEXT'
        $rows = Get-Rows 'SELECT n, m, flag, day FROM widen'
        $rows[1].n | Should -Be 1.0
        $rows[1].m | Should -Be '1'
        $rows[1].flag | Should -Be 'true'
        $rows[50].flag | Should -Be '1'
        $rows[50].day | Should -Be 'someday'
        @($r.Warnings).Count | Should -BeGreaterThan 0
    }
    It 'pads short rows, drops extra cells with a warning, skips blank lines' {
        $r = Import-Text 'ragged.csv' "a,b,c`n1,2`n`n3,4,5,6`n"
        $r.Rows | Should -Be 2
        (Get-Rows 'SELECT c FROM ragged ORDER BY a')[0].c | Should -BeOfType [DBNull]
        ($r.Warnings -join ' ') | Should -Match 'more cells'
    }
    It 'makes column names safe and unique, and table names safe and unique' {
        $r = Import-Text '2024 Work-Orders (final).csv' "Order #,order #,,Due Date`n1,2,3,2024-01-01`n"
        $r.Table | Should -Be 't_2024_work_orders_final'
        ($r.Names -join '|') | Should -Be 'Order|order_2|column_3|Due Date'
        $r2 = Import-Text '2024 Work-Orders (final).csv' "a`n1`n"
        $r2.Table | Should -Be 't_2024_work_orders_final_2'
    }
    It 'reads a gzipped CSV as it streams' {
        $p = Join-Path $script:Work 'zipped.csv.gz'
        $fs = [IO.File]::Create($p)
        $gz = New-Object IO.Compression.GZipStream($fs, [IO.Compression.CompressionMode]::Compress)
        $b = [Text.Encoding]::UTF8.GetBytes("k,v`n1,one`n2,two`n")
        $gz.Write($b, 0, $b.Length); $gz.Dispose(); $fs.Dispose()
        $r = Import-SemLocalFile -HomeDir $script:HomeDir -Path $p
        $r.Table | Should -Be 'zipped'
        $r.Rows | Should -Be 2
    }
    It 'refuses an empty file and an old .xls with a message' {
        { Import-Text 'empty.csv' '' } | Should -Throw '*empty*'
        $p = Write-TestFile 'old.xls' 'not really'
        { Import-SemLocalFile -HomeDir $script:HomeDir -Path $p } | Should -Throw '*.xlsx*'
    }
}

Describe 'Replace and metadata' {
    It 'records where a table came from' {
        $p = Write-TestFile 'meta.csv' "a`n1`n2`n"
        [void](Import-SemLocalFile -HomeDir $script:HomeDir -Path $p -SourceLabel 's3://bucket/meta.csv' -ETag '"abc123"')
        $t = @((Get-SemLocalTables -HomeDir $script:HomeDir).tables | Where-Object { $_.name -eq 'meta' })[0]
        $t.rows | Should -Be 2
        $t.source | Should -Be 's3://bucket/meta.csv'
        $t.etag | Should -Be '"abc123"'
        $t.fileBytes | Should -Be (New-Object IO.FileInfo $p).Length
        $t.importedAt | Should -Match '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$'
        $t.columns[0].name | Should -Be 'a'
        $t.bytes | Should -BeGreaterThan 0
    }
    It 'swaps a table atomically with -Replace and refuses a taken name without it' {
        $p1 = Write-TestFile 'v1.csv' "a`n1`n"
        $p2 = Write-TestFile 'v2.csv' "a,b`n1,x`n2,y`n"
        [void](Import-SemLocalFile -HomeDir $script:HomeDir -Path $p1 -Table 'swapme')
        { Import-SemLocalFile -HomeDir $script:HomeDir -Path $p2 -Table 'swapme' } | Should -Throw '*already*'
        $r = Import-SemLocalFile -HomeDir $script:HomeDir -Path $p2 -Table 'swapme' -Replace
        $r.Rows | Should -Be 2
        (Get-Rows 'SELECT b FROM swapme').Count | Should -Be 2
    }
    It 'keeps the old table when a replacing import fails' {
        $bad = Write-TestFile 'bad.csv' ''
        { Import-SemLocalFile -HomeDir $script:HomeDir -Path $bad -Table 'swapme' -Replace } | Should -Throw
        (Get-Rows 'SELECT b FROM swapme').Count | Should -Be 2
        $c = Open-SemLocalConnection -HomeDir $script:HomeDir
        try { @($c.UserTables() | Where-Object { $_[0] -like '_semaphore_stage*' }).Count | Should -Be 0 } finally { $c.Dispose() }
    }
    It 'cancels an import part way: nothing is published and the staging table is gone' {
        $sb = New-Object Text.StringBuilder; [void]$sb.Append("a`n"); for ($i = 0; $i -lt 30000; $i++) { [void]$sb.Append("$i`n") }
        $p = Write-TestFile 'cancelme.csv' $sb.ToString()
        $o = New-Object SemLocal.ImportOptions; $o.ProgressMs = 0; $o.BatchRows = 5000
        $script:cancelOpts = $o
        { Import-SemLocalFile -HomeDir $script:HomeDir -Path $p -Options $o -Progress { param($x) if ($x.Rows -gt 8000) { $script:cancelOpts.Cancel() } } } | Should -Throw '*cancelled*'
        $c = Open-SemLocalConnection -HomeDir $script:HomeDir
        try { $c.TableExists('cancelme') | Should -BeFalse; @($c.UserTables() | Where-Object { $_[0] -like '_semaphore_stage*' }).Count | Should -Be 0 } finally { $c.Dispose() }
    }
    It 'renames and drops tables with their metadata' {
        [void](Import-Text 'renameme.csv' "a`n1`n")
        Rename-SemLocalTable -HomeDir $script:HomeDir -Name 'renameme' -NewName 'renamed' | Should -BeTrue
        $names = @((Get-SemLocalTables -HomeDir $script:HomeDir).tables | ForEach-Object { $_.name })
        $names | Should -Contain 'renamed'
        $names | Should -Not -Contain 'renameme'
        @((Get-SemLocalTables -HomeDir $script:HomeDir).tables | Where-Object { $_.name -eq 'renamed' })[0].rows | Should -Be 1
        { Rename-SemLocalTable -HomeDir $script:HomeDir -Name 'renamed' -NewName 'swapme' } | Should -Throw '*already*'
        { Rename-SemLocalTable -HomeDir $script:HomeDir -Name 'renamed' -NewName 'bad name' } | Should -Throw
        { Rename-SemLocalTable -HomeDir $script:HomeDir -Name 'renamed' -NewName '_semaphore_x' } | Should -Throw
        Remove-SemLocalTable -HomeDir $script:HomeDir -Name 'renamed' | Should -BeTrue
        Remove-SemLocalTable -HomeDir $script:HomeDir -Name 'renamed' | Should -BeFalse
        (Get-Rows "SELECT name FROM _semaphore_tables WHERE name = 'renamed'").Count | Should -Be 0
    }
}

Describe 'Excel import' {
    BeforeAll {
        $script:Xlsx = Join-Path $script:Work 'Fleet Jobs.xlsx'
        New-TestXlsx $script:Xlsx
    }
    It 'lists the sheets in workbook order' {
        (@([SemLocal.LocalImport]::XlsxSheets($script:Xlsx)) -join '|') | Should -Be 'Jobs|Crew List'
        (Get-SemLocalSheets -HomeDir $script:HomeDir -Path $script:Xlsx).sheets.Count | Should -Be 2
    }
    It 'imports the first sheet: shared and inline strings, numbers, booleans, dates by format, missing cells' {
        $r = Import-SemLocalFile -HomeDir $script:HomeDir -Path $script:Xlsx
        $r.Table | Should -Be 'fleet_jobs_jobs'
        $r.Rows | Should -Be 3
        ($r.Names -join '|') | Should -Be 'Job|Opened|Hours|Done|Note text|Started'
        Get-Decl 'fleet_jobs_jobs' | Should -Be 'INTEGER,DATE,REAL,BOOLEAN,TEXT,DATE'
        $rows = Get-Rows 'SELECT * FROM fleet_jobs_jobs ORDER BY Job'
        $rows[0].Opened | Should -Be ([datetime]'2024-01-15')
        $rows[0].Hours | Should -Be 2.5
        $rows[0].Done | Should -BeTrue
        $rows[0].'Note text' | Should -Be 'Pump & valve'
        $rows[0].Started | Should -Be ([datetime]'2024-01-15T12:00:00')
        $rows[1].'Note text' | Should -Be 'inline one'
        $rows[1].Started | Should -BeOfType [DBNull]
        $rows[2].Opened | Should -BeOfType [DBNull]
        $rows[2].Hours | Should -Be 1000
        $rows[2].'Note text' | Should -Be 'formula text'
    }
    It 'imports a named sheet' {
        $r = Import-SemLocalFile -HomeDir $script:HomeDir -Path $script:Xlsx -Sheet 'crew list' -Table 'crew'
        $r.Rows | Should -Be 2
        (Get-Rows 'SELECT Name FROM crew ORDER BY Name')[1].Name | Should -Be 'Bo'
        { Import-SemLocalFile -HomeDir $script:HomeDir -Path $script:Xlsx -Sheet 'Nope' } | Should -Throw '*no sheet*'
    }
}

Describe 'SQLite import' {
    BeforeAll {
        $script:Other = Join-Path $script:Work 'other.db'
        $c = New-Object SemLocal.LocalConnection ('Data Source=' + $script:Other + ';Mode=ReadWrite')
        $c.Open()
        $c.Execute("CREATE TABLE ships (id INTEGER PRIMARY KEY, name TEXT, commissioned DATE); INSERT INTO ships VALUES (1, 'Ark', '1990-05-01'), (2, 'Bee', '2001-07-04'); CREATE TABLE crew (ship INTEGER, `"full name`" TEXT); INSERT INTO crew VALUES (1, 'Ana');")
        $c.Dispose()
        $script:OtherHash = (Get-FileHash -LiteralPath $script:Other).Hash
    }
    It 'lists the tables of the file' {
        (Get-SemLocalSheets -HomeDir $script:HomeDir -Path $script:Other).sheets -join ',' | Should -Be 'crew,ships'
    }
    It 'copies every table through a read-only ATTACH, keeping declared types' {
        $r = Import-SemLocalFile -HomeDir $script:HomeDir -Path $script:Other
        @($r.Tables).Count | Should -Be 2
        $r.Rows | Should -Be 3
        $names = @($r.Tables | ForEach-Object { $_.name })
        $names | Should -Contain 'ships'
        Get-Decl 'ships' | Should -Be 'INTEGER,TEXT,DATE'
        (Get-Rows 'SELECT commissioned FROM ships WHERE id = 2')[0].commissioned | Should -Be ([datetime]'2001-07-04')
        (Get-FileHash -LiteralPath $script:Other).Hash | Should -Be $script:OtherHash
    }
    It 'copies one chosen table under a chosen name' {
        $r = Import-SemLocalFile -HomeDir $script:HomeDir -Path $script:Other -Sheet 'ships' -Table 'ships_copy'
        $r.Table | Should -Be 'ships_copy'
        $r.Rows | Should -Be 2
    }
}

Describe 'Columnar hook (Parquet and Arrow through SemColumnar)' {
    BeforeAll {
        # A stand-in with the sibling's shape under another type name, so a real Columnar.cs can load beside it.
        if (-not ('SemColumnarTest.ColumnarFiles' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
namespace SemColumnarTest {
    public interface ITableReader : IDisposable { string[] Names { get; } string[] Types { get; } bool Next(object[] row); }
    public sealed class Fake : ITableReader {
        int _i;
        public string[] Names { get { return new string[] { "id", "when", "ok", "amount", "label" }; } }
        public string[] Types { get { return new string[] { "integer", "date", "boolean", "real", "text" }; } }
        public bool Next(object[] row) {
            if (_i >= 3) return false;
            row[0] = (long)(_i + 1); row[1] = new DateTime(2024, 1, 1 + _i, _i, 0, 0); row[2] = _i % 2 == 0; row[3] = 1.5 * _i; row[4] = _i == 1 ? null : (object)("r" + _i);
            _i++; return true;
        }
        public static bool Disposed;
        public void Dispose() { Disposed = true; }
    }
    public static class ColumnarFiles { public static ITableReader Open(string path) { if (path.EndsWith("broken.parquet")) throw new InvalidOperationException("bad footer"); return new Fake(); } }
}
'@
        }
    }
    AfterAll { [SemLocal.LocalImport]::ColumnarTypeName = 'SemColumnar.ColumnarFiles' }
    It 'says plainly when the columnar reader is missing' {
        [SemLocal.LocalImport]::ColumnarTypeName = 'SemColumnarMissing.ColumnarFiles'
        $p = Write-TestFile 'nothing.parquet' 'PAR1....'
        { Import-SemLocalFile -HomeDir $script:HomeDir -Path $p } | Should -Throw '*Columnar.cs*'
    }
    It 'imports through ITableReader with its declared types' {
        [SemLocal.LocalImport]::ColumnarTypeName = 'SemColumnarTest.ColumnarFiles'
        [SemLocal.LocalImport]::ColumnarAvailable | Should -BeTrue
        $p = Write-TestFile 'events.parquet' 'PAR1....'
        $r = Import-SemLocalFile -HomeDir $script:HomeDir -Path $p
        $r.Rows | Should -Be 3
        Get-Decl 'events' | Should -Be 'INTEGER,DATE,BOOLEAN,REAL,TEXT'
        $rows = Get-Rows 'SELECT * FROM events ORDER BY id'
        $rows[0].when | Should -Be ([datetime]'2024-01-01')
        $rows[1].when | Should -Be ([datetime]'2024-01-02T01:00:00')
        $rows[0].ok | Should -BeTrue
        $rows[1].label | Should -BeOfType [DBNull]
        [SemColumnarTest.Fake]::Disposed | Should -BeTrue
    }
    It 'passes the reader''s own error on' {
        [SemLocal.LocalImport]::ColumnarTypeName = 'SemColumnarTest.ColumnarFiles'
        $p = Write-TestFile 'broken.parquet' 'PAR1....'
        { Import-SemLocalFile -HomeDir $script:HomeDir -Path $p } | Should -Throw '*bad footer*'
    }
}

Describe 'Parquet and Arrow with the real Columnar.cs' {
    BeforeAll {
        [SemLocal.LocalImport]::ColumnarTypeName = 'SemColumnar.ColumnarFiles'
        $script:HasColumnar = [bool]('SemColumnar.ColumnarFiles' -as [type])
        $script:Fixtures = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', 'fixtures', 'columnar'))
    }
    It 'is compiled beside LocalDb.cs and found at run time' {
        $script:HasColumnar | Should -BeTrue
        [SemLocal.LocalImport]::ColumnarAvailable | Should -BeTrue
        (Get-SemLocalTables -HomeDir $script:HomeDir).columnar | Should -BeTrue
    }
    It 'imports an Arrow fixture with the row count the file states' {
        $f = Join-Path $script:Fixtures 'SAMPLE_SALES.arrow'
        $reader = [SemColumnar.ColumnarFiles]::Open($f)
        try { $want = 0; $row = New-Object object[] $reader.Names.Length; while ($reader.Next($row)) { $want++ } } finally { $reader.Dispose() }
        $r = Import-SemLocalFile -HomeDir $script:HomeDir -Path $f
        $r.Table | Should -Be 'sample_sales'
        $r.Rows | Should -Be $want
        $r.Format | Should -Be 'columnar'
    }
    It 'round-trips a table through Parquet and Arrow: export, import, same rows and types' {
        [void](Import-Text 'trip.csv' ("id,name,amount,day,at,ok`n" + "1,Ana,1.5,2024-01-05,2024-01-05 10:30:00,true`n" + "2,,2.25,2024-02-01,2024-02-01 00:00:01,false`n" + "3,Cy,,,,`n"))
        foreach ($fmt in 'parquet', 'arrow') {
            $out = Join-Path $script:Work ('trip_out.' + $fmt)
            $e = Export-SemLocalTable -HomeDir $script:HomeDir -Name 'trip' -Path $out -Format $fmt
            $e.Rows | Should -Be 3
            $r = Import-SemLocalFile -HomeDir $script:HomeDir -Path $out -Table ('trip_' + $fmt)
            $r.Rows | Should -Be 3
            Get-Decl ('trip_' + $fmt) | Should -Be 'INTEGER,TEXT,REAL,DATE,DATE,BOOLEAN'
            $a = Get-Rows ('SELECT * FROM trip_' + $fmt + ' ORDER BY id')
            $a[0].at | Should -Be ([datetime]'2024-01-05T10:30:00')
            $a[0].day | Should -Be ([datetime]'2024-01-05')
            $a[1].ok | Should -BeFalse
            $a[1].name | Should -BeOfType [DBNull]
            $a[2].amount | Should -BeOfType [DBNull]
            (Get-Rows ("SELECT typeof(at) AS t, at FROM trip_" + $fmt + " WHERE id = 1"))[0].at | Should -Be ([datetime]'2024-01-05T10:30:00')
        }
    }
    It 'reports a damaged Parquet file in plain words' {
        $p = Write-TestFile 'damaged.parquet' 'PAR1 this is not a parquet file PAR1'
        { Import-SemLocalFile -HomeDir $script:HomeDir -Path $p } | Should -Throw '*Could not read the file*'
        $c = Open-SemLocalConnection -HomeDir $script:HomeDir
        try { $c.TableExists('damaged') | Should -BeFalse } finally { $c.Dispose() }
    }
    It 'imports a 1M-row Parquet file and reports rows per second' {
        $p = Join-Path $script:Work 'million.parquet'
        $rows = New-Object 'System.Collections.Generic.List[object[]]' 1000000
        $d0 = [datetime]'2020-01-01'
        for ($i = 0; $i -lt 1000000; $i++) { $rows.Add([object[]]@([long]$i, ('r' + ($i % 50)), ($i * 0.5), $d0.AddDays($i % 900).ToString('yyyy-MM-dd'), (($i % 2) -eq 0))) }
        [SemColumnar.ColumnarFiles]::WriteParquet($p, [string[]]@('id', 'region', 'amount', 'day', 'ok'), [string[]]@('integer', 'text', 'real', 'date', 'boolean'), $rows)
        $rows = $null
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $r = Import-SemLocalFile -HomeDir $script:HomeDir -Path $p -Table 'million'
        $sw.Stop()
        Write-Host ('    1,000,000-row Parquet ({0:N1} MB): {1:N0} ms, {2:N0} rows/s' -f ((New-Object IO.FileInfo $p).Length / 1MB), $sw.ElapsedMilliseconds, ($r.Rows / $sw.Elapsed.TotalSeconds))
        $r.Rows | Should -Be 1000000
        Get-Decl 'million' | Should -Be 'INTEGER,TEXT,REAL,DATE,BOOLEAN'
        [IO.File]::Delete($p)
    }
}

Describe 'ADO.NET behaviour on the query path' {
    BeforeAll {
        [void](Import-Text 'jobs.csv' ("id,region,cost,opened,done`n" + "1,North,10.5,2024-01-01,true`n2,South,20,2024-02-01,false`n3,North,,2024-03-01,true`n"))
        $script:Src = Get-SemLocalSource -HomeDir $script:HomeDir
    }
    It 'is a built-in source that needs no sources.json entry' {
        $s = @(Get-SemSources -HomeDir $script:HomeDir)
        $s[-1].id | Should -Be 'local'
        $s[-1].kind | Should -Be 'local'
        (Find-SemSource -HomeDir $script:HomeDir -Id 'local').provider | Should -Be 'local'
        Test-SemUsesBrackets $s[-1] | Should -BeFalse
        Get-SemQuotedName -Name 'Work Orders' -Brackets (Test-SemUsesBrackets $s[-1]) | Should -Be '"Work Orders"'
    }
    It 'binds positional parameters in order: text, number, boolean, date, null' {
        $rows = Get-Rows 'SELECT id FROM jobs WHERE region = ? AND cost > ? AND done = ? AND opened >= ? AND ? IS NULL' @('North', [double]5, $true, [datetime]'2024-01-01', [DBNull]::Value)
        $rows.Count | Should -Be 1
        $rows[0].id | Should -Be 1
    }
    It 'refuses a parameter count that does not match the placeholders' {
        { Get-Rows 'SELECT id FROM jobs WHERE id = ?' @() } | Should -Throw '*placeholders*'
    }
    It 'runs a planned /api/query plan with Add-SemCommandParameter and the JSON writer' {
        $body = '{"source":"local","sql":"SELECT region, SUM(cost) AS total, MIN(opened) AS first FROM jobs WHERE opened >= ? GROUP BY region ORDER BY region","params":[{"value":"2024-01-01","type":"date"}]}' | ConvertFrom-Json
        $plan = Get-SemQueryPlan -Body $body -HomeDir $script:HomeDir
        $plan.ContainsKey('Error') | Should -BeFalse
        $conn = New-SemConnection -Source $plan.Source
        try { $json = Invoke-SemQueryOnConnection -Connection $conn -Plan $plan } finally { $conn.Dispose() }
        $j = $json | ConvertFrom-Json
        @($j.rows).Count | Should -Be 2
        $j.rows[0].region | Should -Be 'North'
        $j.rows[0].total | Should -Be 10.5
        $j.rows[0].first | Should -Be '2024-01-01'
    }
    It 'stops a query at its time limit with sqlite3_interrupt, reported as a timeout' {
        $c = Open-SemLocalConnection -HomeDir $script:HomeDir
        try {
            $cmd = $c.CreateCommand(); $cmd.CommandText = 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT COUNT(*) FROM r'; $cmd.CommandTimeout = 1
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $err = $null
            try { [void]$cmd.ExecuteScalar() } catch { $err = $_.Exception }
            $sw.ElapsedMilliseconds | Should -BeLessThan 5000
            $err | Should -Not -BeNullOrEmpty
            $e = Get-SemQueryError -Exception $err -Source $script:Src -Stage 'query'
            $e.Status | Should -Be 504
            $e.Code | Should -Be 'timeout'
            # The connection is usable afterwards.
            $c.ScalarLong('SELECT COUNT(*) FROM jobs') | Should -Be 3
        } finally { $c.Dispose() }
    }
    It 'stops reading when the command is cancelled mid-read' {
        $c = Open-SemLocalConnection -HomeDir $script:HomeDir
        try {
            $cmd = $c.CreateCommand(); $cmd.CommandText = 'SELECT id FROM jobs ORDER BY id'
            $r = $cmd.ExecuteReader()
            $r.Read() | Should -BeTrue
            $cmd.Cancel()
            $r.Read() | Should -BeFalse
            $r.Dispose()
            $c.ScalarLong('SELECT COUNT(*) FROM jobs') | Should -Be 3
        } finally { $c.Dispose() }
    }
    It 'answers GetSchema Tables and Columns in the shape the profiler reads' {
        $c = New-SemConnection -Source $script:Src
        try {
            $t = $c.GetSchema('Tables')
            @($t.Columns | ForEach-Object { $_.ColumnName }) -join ',' | Should -Be 'TABLE_CATALOG,TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE'
            $names = @($t.Rows | ForEach-Object { $_['TABLE_NAME'] })
            $names | Should -Contain 'jobs'
            $names | Should -Not -Contain '_semaphore_tables'
            $cols = $c.GetSchema('Columns', [string[]]@($null, $null, 'jobs'))
            @($cols.Rows | ForEach-Object { $_['COLUMN_NAME'] + ':' + $_['DATA_TYPE'] }) -join ',' | Should -Be 'id:INTEGER,region:TEXT,cost:REAL,opened:DATE,done:BOOLEAN'
            $p = Get-SemProfileTables -Connection $c
            @($p.tables | ForEach-Object { $_.name }) | Should -Contain 'jobs'
            @($p.tables | Where-Object { $_.name -eq 'jobs' })[0].schema | Should -BeNullOrEmpty
        } finally { $c.Dispose() }
    }
    It 'profiles a table: rows, kinds, distinct counts and samples' {
        $c = New-SemConnection -Source $script:Src
        try { $p = Get-SemProfileTable -Connection $c -Source $script:Src -Table 'jobs' } finally { $c.Dispose() }
        $p.rows | Should -Be 3
        (@($p.columns | ForEach-Object { $_.name + ':' + $_.type }) -join ',') | Should -Be 'id:number,region:string,cost:number,opened:date,done:boolean'
        @($p.columns | Where-Object { $_.name -eq 'region' })[0].distinct | Should -Be 2
        @($p.columns | Where-Object { $_.name -eq 'opened' })[0].samples[0] | Should -Be '2024-01-01'
    }
    It 'refuses every write, ATTACH and PRAGMA on the read-only query connection' -TestCases @(
        @{ Sql = 'DELETE FROM jobs' }, @{ Sql = "INSERT INTO jobs (id) VALUES (9)" }, @{ Sql = 'DROP TABLE jobs' }, @{ Sql = 'CREATE TABLE x (a)' },
        @{ Sql = "ATTACH DATABASE 'C:\Windows\x.db' AS x" }, @{ Sql = 'PRAGMA writable_schema = 1' }, @{ Sql = 'PRAGMA query_only = 0' }, @{ Sql = 'VACUUM' }
    ) {
        $c = New-SemConnection -Source $script:Src
        try {
            $cmd = $c.CreateCommand(); $cmd.CommandText = $Sql
            { [void]$cmd.ExecuteNonQuery() } | Should -Throw
        } finally { $c.Dispose() }
        (Get-Rows 'SELECT COUNT(*) AS n FROM jobs')[0].n | Should -Be 3
    }
    It 'refuses two statements in one command' {
        $c = New-SemConnection -Source $script:Src
        try { $cmd = $c.CreateCommand(); $cmd.CommandText = 'SELECT 1; SELECT 2'; { [void]$cmd.ExecuteScalar() } | Should -Throw '*One SQL statement*' } finally { $c.Dispose() }
    }
    It 'keeps the SQL guard on /api/query for the local source' {
        foreach ($sql in 'DELETE FROM jobs', 'SELECT 1; DELETE FROM jobs', 'SELECT * FROM jobs -- x') {
            $body = ([ordered]@{ source = 'local'; sql = $sql } | ConvertTo-Json) | ConvertFrom-Json
            (Get-SemQueryPlan -Body $body -HomeDir $script:HomeDir).Error.Code | Should -Be 'sql-refused'
        }
    }
}

Describe 'Network paths and the share allowlist' {
    It 'refuses \\<HostName> when the host is not in localShares, without contacting it' -TestCases @(@{ HostName = 'fileserver01' }, @{ HostName = 'files.corp.example' }) {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $r = Resolve-SemLocalPath -Path ("\\$HostName\share\data.csv") -Shares @('otherhost')
        $r.Error | Should -Match 'NTLM'
        $r.Error | Should -Match ([regex]::Escape($HostName))
        $sw.ElapsedMilliseconds | Should -BeLessThan 1000
    }
    It 'refuses WebDAV and device forms and paths that are not absolute' -TestCases @(
        @{ P = '\\host@SSL\DavWWWRoot\x.csv' }, @{ P = '\\.\pipe\x.csv' }, @{ P = '\\?\GLOBALROOT\Device\x.csv' }, @{ P = 'data\x.csv' }, @{ P = 'C:x.csv' }, @{ P = 'C:\data\x.csv:hidden' }, @{ P = '' }
    ) {
        (Resolve-SemLocalPath -Path $P -Shares @('host')).Error | Should -Not -BeNullOrEmpty
    }
    It 'checks the share of a long-form UNC path too' {
        (Resolve-SemLocalPath -Path '\\?\UNC\fileserver01\share\x.csv' -Shares @()).Error | Should -Match 'NTLM'
    }
    It 'does not let .. leave the named share' {
        (Resolve-SemLocalPath -Path '\\allowed\share\..\..\evil\c$\x.csv' -Shares @('allowed')).Error | Should -Not -BeNullOrEmpty
    }
    It 'opens a local file, strips quotes and checks the extension' {
        $p = Write-TestFile 'local ok.csv' "a`n1`n"
        (Resolve-SemLocalPath -Path ('"' + $p + '"')).Path | Should -Be $p
        $q = Write-TestFile 'notes.docx' 'x'
        (Resolve-SemLocalPath -Path $q).Error | Should -Match 'imports'
        (Resolve-SemLocalPath -Path (Join-Path $script:Work 'missing.csv')).Error | Should -Match 'No such file'
        (Resolve-SemLocalPath -Path (Get-SemLocalDbPath -HomeDir $script:HomeDir) -HomeDir $script:HomeDir).Error | Should -Match 'own local database'
    }
    It 'follows a junction to its local target' {
        $target = Join-Path $script:Work 'real-folder'
        [void][IO.Directory]::CreateDirectory($target)
        [IO.File]::WriteAllText((Join-Path $target 'via.csv'), "a`n1`n")
        $link = Join-Path $script:Work 'junction'
        cmd.exe /c mklink /J "$link" "$target" | Out-Null
        $r = Resolve-SemLocalPath -Path (Join-Path $link 'via.csv')
        $r.Error | Should -BeNullOrEmpty
        $r.Path | Should -Be (Join-Path $target 'via.csv')
        cmd.exe /c rmdir "$link" | Out-Null
    }
    It 'reads localShares and localImportMaxGB from settings, ignoring junk' {
        $root = Join-Path $script:Work 'root'
        [void][IO.Directory]::CreateDirectory((Join-Path $root 'config'))
        [IO.File]::WriteAllText((Join-Path $root 'config\settings.json'), '{ "localShares": ["\\\\files01", "files02.corp.example", "bad host", "x@SSL"], "localImportMaxGB": 50 }')
        $s = Read-SemSettings -Root $root
        (@($s.localShares) -join ',') | Should -Be 'files01,files02.corp.example'
        $s.localImportMaxGB | Should -Be 50
        (Get-SemDefaultSettings).localImportMaxGB | Should -Be 20
    }
}

Describe 'Routes' {
    It 'lists the tables' {
        $r = Invoke-Req (New-Req 'GET' '/api/local/tables')
        $r.Status | Should -Be 200
        @($r.Json.tables | ForEach-Object { $_.name }) | Should -Contain 'jobs'
        $r.Json.engine | Should -Match '^SQLite 3'
    }
    It 'needs the session token like every /api route' {
        $q = New-Req 'GET' '/api/local/tables'
        $q.Headers.Remove('X-Semaphore-Session') | Out-Null
        (Invoke-Req $q).Status | Should -Be 401
    }
    It 'imports a file in place on a job and reports its progress' {
        $p = Write-TestFile 'bypath.csv' "a,b`n1,x`n2,y`n"
        $r = Invoke-Req (New-Req 'POST' '/api/local/import-path' @{ path = $p; table = 'by_path' })
        $r.Status | Should -Be 202
        $r.Json.job | Should -Match '^[a-f0-9]{32}$'
        $s = Wait-Job $r.Json.job
        $s.state | Should -Be 'done'
        $s.rows | Should -Be 2
        $s.table | Should -Be 'by_path'
        (Invoke-Req (New-Req 'GET' ('/api/local/import-status/' + $r.Json.job))).Json.state | Should -Be 'done'
    }
    It 'refuses a network path that is not allowed with 403 and the reason' {
        $r = Invoke-Req (New-Req 'POST' '/api/local/import-path' @{ path = '\\fileserver01\share\x.csv' })
        $r.Status | Should -Be 403
        $r.Json.code | Should -Be 'path-refused'
        $r.Json.error | Should -Match 'localShares'
    }
    It 'answers 404 for an unknown import and refuses a bad table name' {
        (Invoke-Req (New-Req 'GET' '/api/local/import-status/0123456789abcdef0123456789abcdef')).Status | Should -Be 404
        (Invoke-Req (New-Req 'GET' '/api/local/import-status/..')).Status | Should -Be 404
        (Invoke-Req (New-Req 'POST' '/api/local/import-path' @{ path = 'C:\x.csv'; table = 'no way' })).Status | Should -Be 400
        (Invoke-Req (New-Req 'DELETE' '/api/local/tables/sqlite_master')).Status | Should -Be 400
    }
    It 'renames and drops a table' {
        (Invoke-Req (New-Req 'POST' '/api/local/tables/by_path/rename' @{ name = 'by_path2' })).Status | Should -Be 200
        (Invoke-Req (New-Req 'DELETE' '/api/local/tables/by_path2')).Status | Should -Be 200
        (Invoke-Req (New-Req 'DELETE' '/api/local/tables/by_path2')).Status | Should -Be 404
    }
    It 'lists the sheets of a workbook given by path' {
        $r = Invoke-Req (New-Req 'POST' '/api/local/sheets' @{ path = (Join-Path $script:Work 'Fleet Jobs.xlsx') })
        $r.Status | Should -Be 200
        @($r.Json.sheets) -join '|' | Should -Be 'Jobs|Crew List'
    }
    It 'leaves a big upload body in the socket: no buffering, and the size cap comes from settings' {
        $h = ConvertFrom-SemRequestHead -Text "POST /api/local/import HTTP/1.1`r`nHost: 127.0.0.1:8800`r`nContent-Length: 10737418240" -RemoteAddress ([Net.IPAddress]::Loopback)
        $h.ContainsKey('ErrorStatus') | Should -BeFalse
        $h.ContentLength | Should -Be 10737418240
        $big = ConvertFrom-SemRequestHead -Text "POST /api/local/import HTTP/1.1`r`nHost: 127.0.0.1:8800`r`nContent-Length: 32212254720" -RemoteAddress ([Net.IPAddress]::Loopback)
        $big.ErrorStatus | Should -Be 413
        $other = ConvertFrom-SemRequestHead -Text "POST /api/query HTTP/1.1`r`nHost: 127.0.0.1:8800`r`nContent-Length: 10737418240" -RemoteAddress ([Net.IPAddress]::Loopback)
        $other.ErrorStatus | Should -Be 413
        (Get-SemBodyLimit -Path '/api/local/import').Streamed | Should -BeTrue
    }
    It 'streams an upload over a real socket to a file, imports it on a job, and deletes the upload' {
        $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
        $listener.Start()
        try {
            $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
            $client = New-Object Net.Sockets.TcpClient
            $client.Connect([Net.IPAddress]::Loopback, $port)
            $serverSide = $listener.AcceptTcpClient()
            $sb = New-Object Text.StringBuilder; [void]$sb.Append("id,name`n"); for ($i = 1; $i -le 5000; $i++) { [void]$sb.Append("$i,row $i`n") }
            $payload = [Text.Encoding]::UTF8.GetBytes($sb.ToString())
            $head = "POST /api/local/import HTTP/1.1`r`nHost: 127.0.0.1:8800`r`nX-Semaphore-Session: " + $script:Sem.Token + "`r`nX-File-Name: " + [Uri]::EscapeDataString('Upload Test.csv') + "`r`nContent-Length: " + $payload.Length + "`r`n`r`n"
            $cs = $client.GetStream()
            $hb = [Text.Encoding]::ASCII.GetBytes($head)
            $cs.Write($hb, 0, $hb.Length)
            $cs.Write($payload, 0, 1000)   # part of the body now, the rest after the server has the request
            $cs.Flush()
            Start-Sleep -Milliseconds 100
            $script:Sem.Port = 8800
            $req = Read-SemHttpRequest -Client $serverSide
            $req.BodyStreamed | Should -BeTrue
            $req.Body.Length | Should -Be 0
            $script:Sem.Deferred = $false
            Invoke-SemRequest -Req $req
            $script:Sem.Deferred | Should -BeTrue
            $cs.Write($payload, 1000, $payload.Length - 1000)
            $cs.Flush()
            $client.ReceiveTimeout = 30000
            $reader = New-Object IO.StreamReader($cs)
            $resp = $reader.ReadToEnd()
            $resp | Should -Match '^HTTP/1.1 202'
            $job = ([regex]::Match($resp, '"job":"([a-f0-9]{32})"')).Groups[1].Value
            $s = Wait-Job $job
            $s.state | Should -Be 'done'
            $s.rows | Should -Be 5000
            $s.table | Should -Be 'upload_test'
            @(Get-ChildItem -LiteralPath (Join-Path $script:HomeDir 'local\incoming') -File).Count | Should -Be 0
            @((Get-SemLocalTables -HomeDir $script:HomeDir).tables | Where-Object { $_.name -eq 'upload_test' })[0].source | Should -Be 'Upload Test.csv (uploaded)'
            $client.Dispose()
        } finally { $listener.Stop() }
    }
    It 'refuses an upload with no name or an unsupported type before reading the body' {
        $q = New-Req 'POST' '/api/local/import' $null @{ 'X-File-Name' = 'x.exe' }
        $q.ContentLength = 10; $q.BodyStreamed = $true
        (Invoke-Req $q).Status | Should -Be 415
        $q = New-Req 'POST' '/api/local/import'
        $q.ContentLength = 10; $q.BodyStreamed = $true
        (Invoke-Req $q).Status | Should -Be 400
    }
}

Describe 'Command line' {
    It 'imports, lists and drops through the commands' {
        $p = Write-TestFile 'cli.csv' "a`n1`n2`n3`n"
        $r = Invoke-SemCommand -Command (Find-SemCommand 'local import') -Options @{ file = $p; table = 'from_cli' } -HomeDir $script:HomeDir -Root (Join-Path $script:Work 'root')
        $r.Ok | Should -BeTrue
        $r.Result.rows | Should -Be 3
        $l = Invoke-SemCommand -Command (Find-SemCommand 'local list') -HomeDir $script:HomeDir
        @($l.Result.tables | ForEach-Object { $_.name }) | Should -Contain 'from_cli'
        (Invoke-SemCommand -Command (Find-SemCommand 'local delete') -Options @{ id = 'from_cli' } -HomeDir $script:HomeDir).Ok | Should -BeFalse   # needs --yes
        (Invoke-SemCommand -Command (Find-SemCommand 'local delete') -Options @{ id = 'from_cli' } -Yes $true -HomeDir $script:HomeDir).Ok | Should -BeTrue
    }
}

Describe 'Throughput' {
    It 'imports a 2M-row CSV and reports rows per second' {
        if (-not ('SemLocalTestGen' -as [type])) {
            Add-Type -TypeDefinition @'
public static class SemLocalTestGen {
    public static void Write(string path, int n) {
        System.Globalization.CultureInfo inv = System.Globalization.CultureInfo.InvariantCulture;
        using (System.IO.StreamWriter w = new System.IO.StreamWriter(path, false, new System.Text.UTF8Encoding(false), 1 << 20)) {
            w.Write("id,region,amount,day,flag,note\n");
            string[] regions = { "North", "South", "East", "West" };
            System.DateTime d0 = new System.DateTime(2020, 1, 1);
            for (int i = 1; i <= n; i++) {
                w.Write(i); w.Write(','); w.Write(regions[i % 4]); w.Write(','); w.Write((i * 0.25).ToString(inv)); w.Write(',');
                w.Write(d0.AddDays(i % 1500).ToString("yyyy-MM-dd", inv)); w.Write(','); w.Write(i % 3 == 0 ? "true" : "false"); w.Write(",\"note "); w.Write(i % 97); w.Write("\"\n");
            }
        }
    }
}
'@
        }
        $p = Join-Path $script:Work 'big.csv'
        [SemLocalTestGen]::Write($p, 2000000)
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $r = Import-SemLocalFile -HomeDir $script:HomeDir -Path $p -Table 'big'
        $sw.Stop()
        $rate = [long]($r.Rows / $sw.Elapsed.TotalSeconds)
        Write-Host ('    2,000,000-row CSV ({0:N0} MB): {1:N0} ms, {2:N0} rows/s' -f ((New-Object IO.FileInfo $p).Length / 1MB), $sw.ElapsedMilliseconds, $rate)
        $r.Rows | Should -Be 2000000
        Get-Decl 'big' | Should -Be 'INTEGER,TEXT,REAL,DATE,BOOLEAN,TEXT'
        $min = 150000; if ($env:SEMAPHORE_LOCALDB_MIN_ROWS_PER_SEC) { $min = [int]$env:SEMAPHORE_LOCALDB_MIN_ROWS_PER_SEC }
        $rate | Should -BeGreaterThan $min
        (Get-Rows "SELECT COUNT(*) AS n FROM big WHERE region = 'North' AND day >= '2023-01-01'")[0].n | Should -BeGreaterThan 0
        [IO.File]::Delete($p)
    }
}
