# Pester 5. The Redshift, Synapse and Foundry connectors (server/Connectors.ps1) against simulated services on
# loopback: the request shapes follow the vendors' published APIs, so signing, paging, polling, typing, errors and
# secret handling are tested without an account. See docs/CONNECTORS.md for what still needs a real service.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Lake.ps1', 'Vault.ps1', 'Connectors.ps1') { . ([IO.Path]::Combine($server, $f)) }

    function script:Start-FakeService {
        # Routes: key = X-Amz-Target value, or "METHOD /path". Each value is a list of @{ Status; Body; Type }; the last repeats.
        param([hashtable]$Routes)
        $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start()
        $state = [hashtable]::Synchronized(@{ Requests = (New-Object Collections.ArrayList); Routes = $Routes; Seen = @{} })
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
                    [void]$S.Requests.Add(@{ Head = $head; Body = $body })
                    $line = ($head -split "`r`n")[0] -split ' '
                    $key = if ($head -match 'X-Amz-Target: (\S+)') { $Matches[1] } else { $line[0] + ' ' + $line[1] }
                    $list = $S.Routes[$key]
                    if ($null -eq $list) { $r = @{ Status = 404; Body = '{"message":"no route ' + $key + '"}'; Type = 'application/json' } }
                    else { $i = [int]$S.Seen[$key]; $S.Seen[$key] = $i + 1; $r = @($list)[[Math]::Min($i, @($list).Count - 1)] }
                    $type = if ($r.Type) { $r.Type } else { 'application/x-amz-json-1.1' }
                    $b = [Text.Encoding]::UTF8.GetBytes([string]$r.Body)
                    $h = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $($r.Status) X`r`nContent-Type: $type`r`nContent-Length: $($b.Length)`r`nConnection: close`r`n`r`n")
                    $st.Write($h, 0, $h.Length); $st.Write($b, 0, $b.Length); $st.Flush()
                } catch { } finally { $c.Close() }
            }
        }).AddArgument($l).AddArgument($state)
        [void]$ps.BeginInvoke()
        return @{ L = $l; PS = $ps; State = $state; Endpoint = 'http://127.0.0.1:' + ([Net.IPEndPoint]$l.LocalEndpoint).Port }
    }
    function script:Stop-FakeService($F) { try { $F.L.Stop() } catch { }; try { $F.PS.Dispose() } catch { } }
    function script:Raw([string]$Json) { return ($Json | ConvertFrom-Json) }
    function script:New-SourceList([string]$Json) {
        $dir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $dir | Out-Null
        Set-Content -LiteralPath (Join-Path $dir 'sources.json') -Value $Json -Encoding UTF8
        return , @(Get-SemSources -HomeDir $dir)
    }
    function script:Typed($t, $v) { return @{ Type = $t; Value = $v } }
    $script:TokenText = 'eyJfoundryTOKENvalue0123456789'
}

Describe 'Synapse connection string' {
    It 'builds an encrypted, read-intent ODBC string for integrated sign-in' {
        $cs = New-SemSynapseConnection (Raw '{"server":"ws-ondemand.sql.azuresynapse.net","database":"maint"}')
        $cs | Should -Be 'Driver={ODBC Driver 18 for SQL Server};Server=tcp:ws-ondemand.sql.azuresynapse.net,1433;Database={maint};Encrypt=yes;TrustServerCertificate=no;ApplicationIntent=ReadOnly;Connection Timeout=30;Authentication=ActiveDirectoryIntegrated'
    }
    It 'accepts US Gov and Azure SQL hosts and driver 17' {
        { New-SemSynapseConnection (Raw '{"server":"ws.sql.azuresynapse.usgovcloudapi.net","database":"d","driver":"ODBC Driver 17 for SQL Server"}') } | Should -Not -Throw
        { New-SemSynapseConnection (Raw '{"server":"s.database.usgovcloudapi.net","database":"d"}') } | Should -Not -Throw
    }
    It 'refuses <Why>' -TestCases @(
        @{ Why = 'a host outside Azure'; J = '{"server":"evil.example.com","database":"d"}' }
        @{ Why = 'a host with a port or path'; J = '{"server":"a.database.windows.net:1433/x","database":"d"}' }
        @{ Why = 'a database name with a brace'; J = '{"server":"a.database.windows.net","database":"d};Server=evil"}' }
        @{ Why = 'an unknown authentication'; J = '{"server":"a.database.windows.net","database":"d","authentication":"Trusted"}' }
        @{ Why = 'a password sign-in with no vault'; J = '{"server":"a.database.windows.net","database":"d","authentication":"SqlPassword"}' }
        @{ Why = 'a password in the file'; J = '{"server":"a.database.windows.net","database":"d","password":"x"}' }
        @{ Why = 'a driver that is not the SQL Server one'; J = '{"server":"a.database.windows.net","database":"d","driver":"Evil Driver"}' }
    ) {
        { New-SemSynapseConnection (Raw $J) } | Should -Throw
    }
    It 'becomes an ODBC azure-synapse source, and takes its sign-in from the vault' {
        $s = (New-SourceList '[{"id":"syn","provider":"synapse","server":"ws.sql.azuresynapse.net","database":"d","authentication":"ActiveDirectoryPassword","vault":{"user":"SYN_USER","password":"SYN_PASSWORD"}}]')[0]
        $s.provider | Should -Be 'odbc'
        $s.kind | Should -Be 'azure-synapse'
        Set-SemVaultRequest @{ Values = @{ user = 'svc@contoso.com'; password = 'p}w' } }
        try {
            $cs = Get-SemEffectiveConnectionString -Source $s
            $cs | Should -BeLike '*Authentication=ActiveDirectoryPassword;UID={svc@contoso.com};PWD={p}}w}'
            $cs | Should -BeLike '*Encrypt=yes*'
        } finally { Set-SemVaultRequest $null }
    }
    It 'skips a bad source and keeps the rest' {
        (New-SourceList '[{"id":"a","provider":"synapse","server":"nope","database":"d"},{"id":"b","provider":"synapse","server":"x.database.windows.net","database":"d"}]').id | Should -Be 'b'
    }
}

Describe 'Redshift Data API' {
    BeforeEach {
        $script:SavedAws = @{}
        foreach ($n in 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN') { $script:SavedAws[$n] = [Environment]::GetEnvironmentVariable($n) }
        [Environment]::SetEnvironmentVariable('AWS_ACCESS_KEY_ID', 'AKIAFAKEFAKEFAKE1234'); [Environment]::SetEnvironmentVariable('AWS_SECRET_ACCESS_KEY', 'fakeSecretKey/with+chars0123456789abcdef'); [Environment]::SetEnvironmentVariable('AWS_SESSION_TOKEN', $null)
    }
    AfterEach { foreach ($n in $script:SavedAws.Keys) { [Environment]::SetEnvironmentVariable($n, $script:SavedAws[$n]) } }

    Context 'settings' {
        It 'accepts a provisioned cluster with a database user' {
            $r = Get-SemRedshiftSettings (Raw '{"region":"us-gov-west-1","database":"dev","clusterId":"maint-1","dbUser":"semaphore_ro"}')
            $r.ClusterId | Should -Be 'maint-1'; $r.DbUser | Should -Be 'semaphore_ro'
        }
        It 'accepts serverless' { (Get-SemRedshiftSettings (Raw '{"region":"us-east-1","database":"dev","workgroup":"wg-1"}')).Workgroup | Should -Be 'wg-1' }
        It 'refuses <Why>' -TestCases @(
            @{ Why = 'both cluster and workgroup'; J = '{"region":"us-east-1","database":"d","clusterId":"a","workgroup":"b","dbUser":"u"}' }
            @{ Why = 'neither'; J = '{"region":"us-east-1","database":"d"}' }
            @{ Why = 'a cluster with no way to sign in'; J = '{"region":"us-east-1","database":"d","clusterId":"a"}' }
            @{ Why = 'dbUser and secretArn together'; J = '{"region":"us-east-1","database":"d","clusterId":"a","dbUser":"u","secretArn":"arn:aws:secretsmanager:us-east-1:123456789012:secret:x-AbCdEf"}' }
            @{ Why = 'a bad region'; J = '{"region":"mars","database":"d","workgroup":"w"}' }
            @{ Why = 'a bad secret ARN'; J = '{"region":"us-east-1","database":"d","clusterId":"a","secretArn":"not-an-arn"}' }
            @{ Why = 'an access key in the file'; J = '{"region":"us-east-1","database":"d","workgroup":"w","accessKeyId":"AKIA"}' }
            @{ Why = 'a plain-http endpoint off loopback'; J = '{"region":"us-east-1","database":"d","workgroup":"w","endpoint":"http://example.com"}' }
        ) { { Get-SemRedshiftSettings (Raw $J) } | Should -Throw }
    }

    Context 'statement conversion' {
        It 'turns ? into named parameters with casts and leaves quoted question marks alone' {
            $ps = @((Typed 'date' ([datetime]'2026-01-01')), (Typed 'number' 5), (Typed 'string' "O'Brien"), (Typed 'boolean' $true))
            $r = ConvertTo-SemRedshiftStatement -Sql 'SELECT "a?" AS "x" FROM "t" WHERE "d" >= ? AND "n" > ? AND "s" = ? AND note = ''why?'' AND "b" = ?' -Params $ps
            $r.Sql | Should -Be 'SELECT "a?" AS "x" FROM "t" WHERE "d" >= CAST(:p1 AS TIMESTAMP) AND "n" > CAST(:p2 AS DOUBLE PRECISION) AND "s" = :p3 AND note = ''why?'' AND "b" = CAST(:p4 AS BOOLEAN)'
            ($r.Parameters | ForEach-Object { $_.name + '=' + $_.value }) -join '|' | Should -Be "p1=2026-01-01 00:00:00|p2=5|p3=O'Brien|p4=true"
        }
        It 'writes NULL for a null parameter and refuses a count mismatch' {
            (ConvertTo-SemRedshiftStatement -Sql 'SELECT 1 WHERE a = ?' -Params @((Typed 'string' ([DBNull]::Value)))).Sql | Should -Be 'SELECT 1 WHERE a = NULL'
            { ConvertTo-SemRedshiftStatement -Sql 'SELECT ? , ?' -Params @((Typed 'string' 'a')) } | Should -Throw '*more ? markers*'
            { ConvertTo-SemRedshiftStatement -Sql 'SELECT ?' -Params @((Typed 'string' 'a'), (Typed 'string' 'b')) } | Should -Throw '*fewer ? markers*'
        }
    }

    Context 'against a simulated Data API' {
        It 'executes, polls, pages and types the result, signing as redshift-data' {
            $cols = '[{"name":"d0","label":"d0","typeName":"varchar"},{"name":"a0","label":"a0","typeName":"float8"},{"name":"d1","label":"d1","typeName":"date"},{"name":"n","label":"n","typeName":"int8"},{"name":"b","label":"b","typeName":"bool"}]'
            $fake = Start-FakeService @{
                'RedshiftData.ExecuteStatement' = @(@{ Status = 200; Body = '{"Id":"stmt-1"}' })
                'RedshiftData.DescribeStatement' = @(@{ Status = 200; Body = '{"Id":"stmt-1","Status":"STARTED"}' }, @{ Status = 200; Body = '{"Id":"stmt-1","Status":"FINISHED","HasResultSet":true}' })
                'RedshiftData.GetStatementResult' = @(
                    @{ Status = 200; Body = '{"ColumnMetadata":' + $cols + ',"Records":[[{"stringValue":"Gulf"},{"doubleValue":3240000.5},{"stringValue":"2026-01-01"},{"longValue":7},{"booleanValue":true}]],"NextToken":"t2"}' },
                    @{ Status = 200; Body = '{"ColumnMetadata":' + $cols + ',"Records":[[{"stringValue":"Northeast"},{"isNull":true},{"stringValue":"2026-02-01 00:00:00"},{"longValue":0},{"booleanValue":false}]]}' })
            }
            try {
                $rs = Get-SemRedshiftSettings (Raw ('{"region":"us-gov-west-1","database":"dev","clusterId":"c1","dbUser":"ro","endpoint":"' + $fake.Endpoint + '"}'))
                $plan = @{ Sql = 'SELECT "region" AS "d0" FROM "ops"."work_orders" WHERE "opened_on" >= ?'; Params = @((Typed 'date' ([datetime]'2026-01-01'))); RowCap = 100; TimeoutSec = 30 }
                $o = (Invoke-SemRedshiftQuery -Rs $rs -Plan $plan -PollMs 10) | ConvertFrom-Json
                $o.columns | Should -Be @('d0', 'a0', 'd1', 'n', 'b')
                @($o.rows).Count | Should -Be 2
                $o.rows[0].d0 | Should -Be 'Gulf'; $o.rows[0].a0 | Should -Be 3240000.5; $o.rows[0].d1 | Should -Be '2026-01-01'; $o.rows[0].n | Should -Be 7; $o.rows[0].b | Should -BeTrue
                $o.rows[1].a0 | Should -BeNullOrEmpty; $o.rows[1].d1 | Should -Be '2026-02-01T00:00:00'; $o.rows[1].b | Should -BeFalse
                $o.truncated | Should -BeFalse
                $reqs = @($fake.State.Requests)
                $exec = Raw (@($reqs | Where-Object { $_.Head -like '*RedshiftData.ExecuteStatement*' })[0].Body)
                $exec.ClusterIdentifier | Should -Be 'c1'; $exec.DbUser | Should -Be 'ro'; $exec.Database | Should -Be 'dev'
                $exec.Sql | Should -BeLike '*CAST(:p1 AS TIMESTAMP)*'
                $exec.Parameters[0].name | Should -Be 'p1'
                $reqs[0].Head | Should -BeLike '*/us-gov-west-1/redshift-data/aws4_request*'
                (($reqs | ForEach-Object { $_.Head + $_.Body }) -join '') | Should -Not -BeLike '*fakeSecretKey*'
                @($reqs | Where-Object { $_.Head -like '*GetStatementResult*' }).Count | Should -Be 2
            } finally { Stop-FakeService $fake }
        }
        It 'stops at the row cap and says so' {
            $rec = '[{"stringValue":"a"}]'
            $fake = Start-FakeService @{
                'RedshiftData.ExecuteStatement' = @(@{ Status = 200; Body = '{"Id":"s"}' })
                'RedshiftData.DescribeStatement' = @(@{ Status = 200; Body = '{"Status":"FINISHED"}' })
                'RedshiftData.GetStatementResult' = @(@{ Status = 200; Body = '{"ColumnMetadata":[{"name":"c","label":"c","typeName":"varchar"}],"Records":[' + (@($rec, $rec, $rec) -join ',') + ']}' })
            }
            try {
                $rs = Get-SemRedshiftSettings (Raw ('{"region":"us-east-1","database":"d","workgroup":"w","endpoint":"' + $fake.Endpoint + '"}'))
                $o = (Invoke-SemRedshiftQuery -Rs $rs -Plan @{ Sql = 'SELECT 1'; Params = @(); RowCap = 2; TimeoutSec = 30 } -PollMs 10) | ConvertFrom-Json
                @($o.rows).Count | Should -Be 2; $o.truncated | Should -BeTrue
            } finally { Stop-FakeService $fake }
        }
        It 'reports a failed statement with the cluster''s message' {
            $fake = Start-FakeService @{
                'RedshiftData.ExecuteStatement' = @(@{ Status = 200; Body = '{"Id":"s"}' })
                'RedshiftData.DescribeStatement' = @(@{ Status = 200; Body = '{"Status":"FAILED","Error":"ERROR: relation nope does not exist"}' })
            }
            try {
                $rs = Get-SemRedshiftSettings (Raw ('{"region":"us-east-1","database":"d","workgroup":"w","endpoint":"' + $fake.Endpoint + '"}'))
                { Invoke-SemRedshiftQuery -Rs $rs -Plan @{ Sql = 'SELECT 1'; Params = @(); RowCap = 10; TimeoutSec = 30 } -PollMs 10 } | Should -Throw '*failed the statement*does not exist*'
            } finally { Stop-FakeService $fake }
        }
        It 'cancels a statement that outlives its time limit' {
            $fake = Start-FakeService @{
                'RedshiftData.ExecuteStatement' = @(@{ Status = 200; Body = '{"Id":"s"}' })
                'RedshiftData.DescribeStatement' = @(@{ Status = 200; Body = '{"Status":"STARTED"}' })
                'RedshiftData.CancelStatement' = @(@{ Status = 200; Body = '{"Status":true}' })
            }
            try {
                $rs = Get-SemRedshiftSettings (Raw ('{"region":"us-east-1","database":"d","workgroup":"w","endpoint":"' + $fake.Endpoint + '"}'))
                { Invoke-SemRedshiftQuery -Rs $rs -Plan @{ Sql = 'SELECT 1'; Params = @(); RowCap = 10; TimeoutSec = 0 } -PollMs 10 } | Should -Throw '*cancelled*'
                @($fake.State.Requests | Where-Object { $_.Head -like '*CancelStatement*' }).Count | Should -Be 1
            } finally { Stop-FakeService $fake }
        }
        It 'profiles from the catalog calls without running SQL' {
            $fake = Start-FakeService @{
                'RedshiftData.ListTables' = @(@{ Status = 200; Body = '{"Tables":[{"schema":"ops","name":"work_orders","type":"TABLE"}]}' })
                'RedshiftData.DescribeTable' = @(@{ Status = 200; Body = '{"ColumnList":[{"name":"region","typeName":"varchar"},{"name":"labor_cost","typeName":"float8"},{"name":"opened_on","typeName":"date"}]}' })
            }
            try {
                $rs = Get-SemRedshiftSettings (Raw ('{"region":"us-east-1","database":"d","workgroup":"w","endpoint":"' + $fake.Endpoint + '"}'))
                (Get-SemRedshiftProfile -Rs $rs -Table '').tables | Should -Be @('ops.work_orders')
                $p = Get-SemRedshiftProfile -Rs $rs -Table 'ops.work_orders'
                (($p.columns | ForEach-Object { $_.name + ':' + $_.type }) -join ',') | Should -Be 'region:string,labor_cost:number,opened_on:date'
                $d = Raw (@($fake.State.Requests | Where-Object { $_.Head -like '*DescribeTable*' })[0].Body)
                $d.Schema | Should -Be 'ops'; $d.Table | Should -Be 'work_orders'
                @($fake.State.Requests | Where-Object { $_.Head -like '*ExecuteStatement*' }).Count | Should -Be 0
            } finally { Stop-FakeService $fake }
        }
    }
}

Describe 'Foundry SQL' {
    AfterEach { Set-SemVaultRequest $null }

    Context 'settings and literals' {
        It 'accepts a host, branch and dataset paths' {
            $f = Get-SemFoundrySettings (Raw '{"host":"https://acme.palantirfoundry.com/","branch":"master","datasets":{"ops.work_orders":"/Acme/Maint/work_orders"}}')
            $f.Host | Should -Be 'https://acme.palantirfoundry.com'; $f.Datasets['ops.work_orders'] | Should -Be '/Acme/Maint/work_orders'
        }
        It 'refuses <Why>' -TestCases @(
            @{ Why = 'a plain http host'; J = '{"host":"http://acme.example.com"}' }
            @{ Why = 'a token in the file'; J = '{"host":"https://a.example.com","token":"x"}' }
            @{ Why = 'a dataset path with a backtick'; J = '{"host":"https://a.example.com","datasets":{"t":"/a`b"}}' }
            @{ Why = 'a dataset name that is not an identifier'; J = '{"host":"https://a.example.com","datasets":{"t;x":"/a"}}' }
        ) { { Get-SemFoundrySettings (Raw $J) } | Should -Throw }
        It 'writes checked literals: escaped text, dates, numbers, booleans, null' {
            Format-SemSparkLiteral (Typed 'string' "it's a \ test") | Should -Be "'it\'s a \\ test'"
            Format-SemSparkLiteral (Typed 'string' "a`nb") | Should -Be "'a\nb'"
            Format-SemSparkLiteral (Typed 'date' ([datetime]'2026-03-04')) | Should -Be "DATE'2026-03-04'"
            Format-SemSparkLiteral (Typed 'date' ([datetime]'2026-03-04T05:06:07')) | Should -Be "TIMESTAMP'2026-03-04 05:06:07'"
            Format-SemSparkLiteral (Typed 'number' 1.5) | Should -Be '1.5'
            Format-SemSparkLiteral (Typed 'boolean' $false) | Should -Be 'false'
            Format-SemSparkLiteral (Typed 'string' ([DBNull]::Value)) | Should -Be 'NULL'
        }
        It 'refuses control characters and non-finite numbers' {
            { Format-SemSparkLiteral (Typed 'string' "a$([char]0)b") } | Should -Throw '*control characters*'
            { Format-SemSparkLiteral (Typed 'number' ([double]::PositiveInfinity)) } | Should -Throw '*finite*'
        }
        It 'cannot be broken out of by a hostile value' {
            $f = @{ Datasets = @{} }
            $q = ConvertTo-SemFoundryQuery -Sql 'SELECT `a` FROM `t` WHERE `s` = ? AND `n` = ?' -Params @((Typed 'string' "x' OR '1'='1"), (Typed 'string' "\' OR 1=1 --")) -Foundry $f
            $q | Should -Be 'SELECT `a` FROM `t` WHERE `s` = ''x\'' OR \''1\''=\''1'' AND `n` = ''\\\'' OR 1=1 --'''
        }
        It 'swaps catalog table names for dataset paths and leaves other text alone' {
            $f = @{ Datasets = @{ 'ops.work_orders' = '/Acme/Maint/work_orders' } }
            (ConvertTo-SemFoundryQuery -Sql 'SELECT `region` FROM `ops`.`work_orders` WHERE `note` = ''ops.work_orders''' -Params @() -Foundry $f) | Should -Be 'SELECT `region` FROM `/Acme/Maint/work_orders` WHERE `note` = ''ops.work_orders'''
        }
    }

    Context 'CSV' {
        It 'parses quotes, doubled quotes, commas, newlines, BOM and CRLF' {
            $csv = [string][char]0xFEFF + "a,b,c`r`n" + '1,"x,y","he said ""hi"""' + "`r`n" + '2,,"line1' + "`n" + 'line2"' + "`r`n"
            $p = ConvertFrom-SemCsvText $csv
            $p.Header | Should -Be @('a', 'b', 'c')
            @($p.Rows).Count | Should -Be 2
            $p.Rows[0][1] | Should -Be 'x,y'; $p.Rows[0][2] | Should -Be 'he said "hi"'
            $p.Rows[1][1] | Should -Be ''; $p.Rows[1][2] | Should -Be "line1`nline2"
        }
        It 'types columns from their values' {
            Get-SemCsvColumnKind @('1', '2.5', '-3e2', '') | Should -Be 'number'
            Get-SemCsvColumnKind @('01234', '5') | Should -Be 'string'
            Get-SemCsvColumnKind @('2026-01-01', '2026-02-01 10:00:00') | Should -Be 'date'
            Get-SemCsvColumnKind @('', '') | Should -Be 'string'
            Get-SemCsvColumnKind @('a', '1') | Should -Be 'string'
        }
    }

    Context 'against a simulated Foundry' {
        It 'executes as CSV, polls getStatus, fetches getResults and sends the vault token as a bearer' {
            $csv = "d0,a0,d1`r`nGulf,3240000.5,2026-01-01`r`n""North, east"",,2026-02-01`r`n"
            $fake = Start-FakeService @{
                'POST /api/v2/sqlQueries/execute' = @(@{ Status = 200; Type = 'application/json'; Body = '{"running":{"queryId":"q1"}}' })
                'GET /api/v2/sqlQueries/q1/getStatus' = @(@{ Status = 200; Type = 'application/json'; Body = '{"running":{"queryId":"q1"}}' }, @{ Status = 200; Type = 'application/json'; Body = '{"succeeded":{"queryId":"q1"}}' })
                'GET /api/v2/sqlQueries/q1/getResults' = @(@{ Status = 200; Type = 'text/csv'; Body = $csv })
            }
            try {
                Set-SemVaultRequest @{ Values = @{ token = $script:TokenText } }
                $f = Get-SemFoundrySettings (Raw ('{"host":"' + $fake.Endpoint + '","branch":"master","datasets":{"ops.work_orders":"/Acme/Maint/work_orders"}}'))
                $plan = @{ Sql = 'SELECT `region` AS `d0` FROM `ops`.`work_orders` WHERE `opened_on` >= ?'; Params = @((Typed 'date' ([datetime]'2026-01-01'))); RowCap = 100; TimeoutSec = 30 }
                $o = (Invoke-SemFoundryQuery -Foundry $f -Plan $plan -PollMs 10) | ConvertFrom-Json
                $o.columns | Should -Be @('d0', 'a0', 'd1')
                $o.rows[0].d0 | Should -Be 'Gulf'; $o.rows[0].a0 | Should -Be 3240000.5; $o.rows[0].d1 | Should -Be '2026-01-01'
                $o.rows[1].d0 | Should -Be 'North, east'; $o.rows[1].a0 | Should -BeNullOrEmpty
                $reqs = @($fake.State.Requests)
                $reqs[0].Head | Should -BeLike "*Authorization: Bearer $($script:TokenText)*"
                $body = Raw $reqs[0].Body
                $body.serializationFormat | Should -Be 'CSV'; $body.fallbackBranchIds | Should -Be @('master')
                $body.query | Should -Be 'SELECT `region` AS `d0` FROM `/Acme/Maint/work_orders` WHERE `opened_on` >= DATE''2026-01-01'''
                $reqs.Count | Should -Be 4
            } finally { Stop-FakeService $fake }
        }
        It 'stops at the row cap and says so' {
            $fake = Start-FakeService @{
                'POST /api/v2/sqlQueries/execute' = @(@{ Status = 200; Type = 'application/json'; Body = '{"succeeded":{"queryId":"q1"}}' })
                'GET /api/v2/sqlQueries/q1/getResults' = @(@{ Status = 200; Type = 'text/csv'; Body = "c`r`n1`r`n2`r`n3`r`n" })
            }
            try {
                Set-SemVaultRequest @{ Values = @{ token = $script:TokenText } }
                $f = Get-SemFoundrySettings (Raw ('{"host":"' + $fake.Endpoint + '"}'))
                $o = (Invoke-SemFoundryQuery -Foundry $f -Plan @{ Sql = 'SELECT 1'; Params = @(); RowCap = 2; TimeoutSec = 30 } -PollMs 10) | ConvertFrom-Json
                @($o.rows).Count | Should -Be 2; $o.truncated | Should -BeTrue
            } finally { Stop-FakeService $fake }
        }
        It 'reports a failed query and never echoes the token' {
            $fake = Start-FakeService @{
                'POST /api/v2/sqlQueries/execute' = @(@{ Status = 200; Type = 'application/json'; Body = '{"failed":{"errorMessage":"Table not found; token eyJfoundryTOKENvalue0123456789 rejected"}}' })
            }
            try {
                Set-SemVaultRequest @{ Values = @{ token = $script:TokenText } }
                $f = Get-SemFoundrySettings (Raw ('{"host":"' + $fake.Endpoint + '"}'))
                $msg = ''
                try { Invoke-SemFoundryQuery -Foundry $f -Plan @{ Sql = 'SELECT 1'; Params = @(); RowCap = 2; TimeoutSec = 30 } -PollMs 10 } catch { $msg = Get-SemLakeSafeText $_.Exception.Message }
                $msg | Should -BeLike '*Table not found*'
                $msg | Should -Not -BeLike '*eyJfoundry*'
            } finally { Stop-FakeService $fake }
        }
        It 'maps an HTTP error without the token' {
            $fake = Start-FakeService @{ 'POST /api/v2/sqlQueries/execute' = @(@{ Status = 403; Type = 'application/json'; Body = '{"errorName":"PermissionDenied","errorDescription":"No access"}' }) }
            try {
                Set-SemVaultRequest @{ Values = @{ token = $script:TokenText } }
                $f = Get-SemFoundrySettings (Raw ('{"host":"' + $fake.Endpoint + '"}'))
                { Invoke-SemFoundryQuery -Foundry $f -Plan @{ Sql = 'SELECT 1'; Params = @(); RowCap = 2; TimeoutSec = 30 } -PollMs 10 } | Should -Throw '*answered 403*PermissionDenied*'
            } finally { Stop-FakeService $fake }
        }
        It 'asks for a token when there is none' {
            $old = $env:FOUNDRY_TOKEN; $env:FOUNDRY_TOKEN = $null
            try { { Invoke-SemFoundryRequest -Foundry @{ Host = 'http://127.0.0.1:1' } -Method 'GET' -Path '/x' } | Should -Throw '*No Foundry token*' } finally { $env:FOUNDRY_TOKEN = $old }
        }
        It 'profiles a dataset from a sample' {
            $fake = Start-FakeService @{
                'POST /api/v2/sqlQueries/execute' = @(@{ Status = 200; Type = 'application/json'; Body = '{"succeeded":{"queryId":"q1"}}' })
                'GET /api/v2/sqlQueries/q1/getResults' = @(@{ Status = 200; Type = 'text/csv'; Body = "region,cost,opened`r`nGulf,1.5,2026-01-01`r`nGulf,2,2026-01-02`r`nWest,,2026-01-03`r`n" })
            }
            try {
                Set-SemVaultRequest @{ Values = @{ token = $script:TokenText } }
                $f = Get-SemFoundrySettings (Raw ('{"host":"' + $fake.Endpoint + '"}'))
                $p = Get-SemFoundryProfile -Foundry $f -Table 'work_orders'
                (($p.columns | ForEach-Object { $_.name + ':' + $_.type + ':' + $_.distinct }) -join ',') | Should -Be 'region:string:2,cost:number:2,opened:date:3'
                (Raw $fake.State.Requests[0].Body).query | Should -Be 'SELECT * FROM `work_orders` LIMIT 200'
            } finally { Stop-FakeService $fake }
        }
    }
}

Describe 'Athena failure paths (simulated AWS)' {
    BeforeEach {
        $script:SavedAws = @{}
        foreach ($n in 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN') { $script:SavedAws[$n] = [Environment]::GetEnvironmentVariable($n) }
        [Environment]::SetEnvironmentVariable('AWS_ACCESS_KEY_ID', 'AKIAFAKEFAKEFAKE1234'); [Environment]::SetEnvironmentVariable('AWS_SECRET_ACCESS_KEY', 'fakeSecretKey/with+chars0123456789abcdef'); [Environment]::SetEnvironmentVariable('AWS_SESSION_TOKEN', $null)
    }
    AfterEach { foreach ($n in $script:SavedAws.Keys) { [Environment]::SetEnvironmentVariable($n, $script:SavedAws[$n]) } }
    function script:New-Lake($F) { return (Get-SemLakeSettings (Raw ('{"region":"us-gov-west-1","database":"maint","endpoint":"' + $F.Endpoint + '"}'))) }
    BeforeAll { $script:LakePlan = @{ Source = @{ id = 'lake' }; Sql = 'SELECT 1'; Params = @(); RowCap = 100; TimeoutSec = 30 } }

    It 'reports a FAILED query with Athena''s reason' {
        $fake = Start-FakeService @{
            'AmazonAthena.StartQueryExecution' = @(@{ Status = 200; Body = '{"QueryExecutionId":"q-1"}' })
            'AmazonAthena.GetQueryExecution' = @(@{ Status = 200; Body = '{"QueryExecution":{"Status":{"State":"FAILED","StateChangeReason":"SYNTAX_ERROR: line 1:8: Column x cannot be resolved"}}}' })
        }
        try { { Invoke-SemLakeQuery -Lake (New-Lake $fake) -Plan $script:LakePlan -PollMs 5 } | Should -Throw '*failed the query*Column x cannot be resolved*' } finally { Stop-FakeService $fake }
    }
    It 'stops a query that outlives its limit' {
        $fake = Start-FakeService @{
            'AmazonAthena.StartQueryExecution' = @(@{ Status = 200; Body = '{"QueryExecutionId":"q-1"}' })
            'AmazonAthena.GetQueryExecution' = @(@{ Status = 200; Body = '{"QueryExecution":{"Status":{"State":"RUNNING"}}}' })
            'AmazonAthena.StopQueryExecution' = @(@{ Status = 200; Body = '{}' })
        }
        try {
            $plan = $script:LakePlan.Clone(); $plan.TimeoutSec = 0
            { Invoke-SemLakeQuery -Lake (New-Lake $fake) -Plan $plan -PollMs 5 } | Should -Throw '*was stopped*'
            @($fake.State.Requests | Where-Object { $_.Head -like '*StopQueryExecution*' }).Count | Should -Be 1
        } finally { Stop-FakeService $fake }
    }
    It 'pages results with NextToken, skipping the header row once, and honours the row cap' {
        $meta = '"ResultSetMetadata":{"ColumnInfo":[{"Name":"d0","Type":"varchar"}]}'
        $fake = Start-FakeService @{
            'AmazonAthena.StartQueryExecution' = @(@{ Status = 200; Body = '{"QueryExecutionId":"q-1"}' })
            'AmazonAthena.GetQueryExecution' = @(@{ Status = 200; Body = '{"QueryExecution":{"Status":{"State":"SUCCEEDED"},"Statistics":{"DataScannedInBytes":1000}}}' })
            'AmazonAthena.GetQueryResults' = @(
                @{ Status = 200; Body = '{"ResultSet":{' + $meta + ',"Rows":[{"Data":[{"VarCharValue":"d0"}]},{"Data":[{"VarCharValue":"a"}]},{"Data":[{"VarCharValue":"b"}]}]},"NextToken":"n2"}' },
                @{ Status = 200; Body = '{"ResultSet":{' + $meta + ',"Rows":[{"Data":[{"VarCharValue":"c"}]},{"Data":[{"VarCharValue":"d"}]}]}}' })
        }
        try {
            $o = (Invoke-SemLakeQuery -Lake (New-Lake $fake) -Plan $script:LakePlan -PollMs 5).Json | ConvertFrom-Json
            ($o.rows | ForEach-Object { $_.d0 }) -join ',' | Should -Be 'a,b,c,d'
            $o.truncated | Should -BeFalse; $o.scannedBytes | Should -Be 1000
            $fake.State.Seen['AmazonAthena.GetQueryResults'] = 0
            $plan = $script:LakePlan.Clone(); $plan.RowCap = 3
            $o = (Invoke-SemLakeQuery -Lake (New-Lake $fake) -Plan $plan -PollMs 5).Json | ConvertFrom-Json
            @($o.rows).Count | Should -Be 3; $o.truncated | Should -BeTrue
        } finally { Stop-FakeService $fake }
    }
    It 'maps AWS errors (access denied, throttling) to a message without keys' {
        foreach ($case in @(@{ Status = 400; Body = '{"__type":"AccessDeniedException","message":"User is not authorized for AKIAFAKEFAKEFAKE1234"}'; Like = '*not authorized*' }, @{ Status = 400; Body = '{"__type":"ThrottlingException","message":"Rate exceeded"}'; Like = '*Rate exceeded*' })) {
            $fake = Start-FakeService @{ 'AmazonAthena.StartQueryExecution' = @(@{ Status = $case.Status; Body = $case.Body }) }
            try {
                $msg = ''
                try { Invoke-SemLakeQuery -Lake (New-Lake $fake) -Plan $script:LakePlan -PollMs 5 } catch { $msg = Get-SemLakeSafeText $_.Exception.Message }
                $msg | Should -BeLike $case.Like
                $msg | Should -Not -BeLike '*AKIAFAKE*'
            } finally { Stop-FakeService $fake }
        }
    }
    It 'reports an unreachable endpoint without keys' {
        $lake = Get-SemLakeSettings (Raw '{"region":"us-gov-west-1","database":"maint","endpoint":"http://127.0.0.1:1"}')
        $msg = ''
        try { Invoke-SemLakeQuery -Lake $lake -Plan $script:LakePlan -PollMs 5 } catch { $msg = Get-SemLakeSafeText $_.Exception.Message }
        $msg | Should -BeLike '*could not be reached*'
        $msg | Should -Not -BeLike '*fakeSecretKey*'
    }
}
