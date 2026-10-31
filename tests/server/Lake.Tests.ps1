# Pester 5. The lake engine (server/Lake.ps1) against a simulated AWS on loopback: Athena, Glue and S3
# answer like the real APIs, so the signing, cost guard, cache, results and profiling are tested
# without an AWS account. AWS's own SigV4 test vector checks the signing itself.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Lake.ps1', 'Vault.ps1') { . ([IO.Path]::Combine($server, $f)) }

    function script:Start-FakeAws {
        # Routes by X-Amz-Target (Athena, Glue) or path (S3 ListObjectsV2). Records every request.
        param([long]$TableBytes = 3221225472, [int]$RunningPolls = 1, [bool]$Partitioned = $true)
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $state = [hashtable]::Synchronized(@{ Requests = (New-Object Collections.ArrayList); Polls = 0 })
        $ps = [powershell]::Create()
        [void]$ps.AddScript({
            param($Listener, $State, $TableBytes, $RunningPolls, $Partitioned)
            while ($true) {
                $c = $Listener.AcceptTcpClient()
                try {
                    $s = $c.GetStream(); $s.ReadTimeout = 5000
                    $buf = New-Object byte[] 65536; $raw = ''
                    do { $n = $s.Read($buf, 0, $buf.Length); $raw += [Text.Encoding]::UTF8.GetString($buf, 0, $n) } while ($n -gt 0 -and $raw -notmatch "`r`n`r`n")
                    $head = $raw.Substring(0, $raw.IndexOf("`r`n`r`n")); $body = $raw.Substring($raw.IndexOf("`r`n`r`n") + 4)
                    if ($head -match 'Content-Length: (\d+)') { while ([Text.Encoding]::UTF8.GetByteCount($body) -lt [int]$Matches[1]) { $n = $s.Read($buf, 0, $buf.Length); if ($n -le 0) { break }; $body += [Text.Encoding]::UTF8.GetString($buf, 0, $n) } }
                    [void]$State.Requests.Add(@{ Head = $head; Body = $body })
                    $target = if ($head -match 'X-Amz-Target: (\S+)') { $Matches[1] } else { '' }
                    $type = 'application/x-amz-json-1.1'
                    switch ($target) {
                        'AmazonAthena.StartQueryExecution' { $out = '{"QueryExecutionId":"q-123"}' }
                        'AmazonAthena.GetQueryExecution' {
                            $State.Polls++
                            $st = if ($State.Polls -le $RunningPolls) { 'RUNNING' } else { 'SUCCEEDED' }
                            $out = '{"QueryExecution":{"QueryExecutionId":"q-123","Status":{"State":"' + $st + '"},"Statistics":{"DataScannedInBytes":52428800}}}'
                        }
                        'AmazonAthena.GetQueryResults' {
                            $out = '{"ResultSet":{"ResultSetMetadata":{"ColumnInfo":[{"Name":"d0","Type":"varchar"},{"Name":"a0","Type":"double"},{"Name":"d1","Type":"date"}]},"Rows":[{"Data":[{"VarCharValue":"d0"},{"VarCharValue":"a0"},{"VarCharValue":"d1"}]},{"Data":[{"VarCharValue":"Gulf"},{"VarCharValue":"3240000.5"},{"VarCharValue":"2026-01-01"}]},{"Data":[{"VarCharValue":"Northeast"},{},{"VarCharValue":"2026-02-01"}]}]}}'
                        }
                        'AWSGlue.GetTable' {
                            $pk = if ($Partitioned) { '[{"Name":"year","Type":"int"}]' } else { '[]' }
                            $out = '{"Table":{"Name":"work_orders","StorageDescriptor":{"Location":"s3://lake/maint/work_orders/","Columns":[{"Name":"region","Type":"string"},{"Name":"labor_cost","Type":"double"},{"Name":"opened_on","Type":"date"}]},"PartitionKeys":' + $pk + '}}'
                        }
                        'AWSGlue.GetTables' { $out = '{"TableList":[{"Name":"work_orders"},{"Name":"hulls"}]}' }
                        default {
                            $type = 'application/xml'
                            $half = [long]($TableBytes / 2)
                            $out = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>lake</Name><IsTruncated>false</IsTruncated><Contents><Key>maint/work_orders/year=2025/a.parquet</Key><Size>' + $half + '</Size></Contents><Contents><Key>maint/work_orders/year=2026/b.parquet</Key><Size>' + ($TableBytes - $half) + '</Size></Contents></ListBucketResult>'
                        }
                    }
                    $bytes = [Text.Encoding]::UTF8.GetBytes($out)
                    $h = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: $type`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n")
                    $s.Write($h, 0, $h.Length); $s.Write($bytes, 0, $bytes.Length); $s.Flush()
                } catch { } finally { $c.Close() }
            }
        }).AddArgument($listener).AddArgument($state).AddArgument($TableBytes).AddArgument($RunningPolls).AddArgument($Partitioned)
        $handle = $ps.BeginInvoke()
        return @{ Listener = $listener; PS = $ps; Handle = $handle; State = $state; Endpoint = 'http://127.0.0.1:' + ([Net.IPEndPoint]$listener.LocalEndpoint).Port }
    }
    function script:Stop-FakeAws {
        param($Fake)
        try { $Fake.Listener.Stop() } catch { }
        try { $Fake.PS.BeginStop($null, $null) | Out-Null } catch { }
    }
    function script:New-Lake {
        param([string]$Endpoint, [hashtable]$Extra = @{})
        $h = @{ id = 'lake'; provider = 'athena'; kind = 'aws-athena'; region = 'us-gov-west-1'; workgroup = 'semaphore'; database = 'maint'; endpoint = $Endpoint; approveAboveGB = 10; dailyLimitGB = 100; cacheHours = 12 }
        foreach ($k in $Extra.Keys) { $h[$k] = $Extra[$k] }
        $raw = [pscustomobject]$h
        return @{ Raw = $raw; Lake = (Get-SemLakeSettings $raw) }
    }
    function script:Invoke-LakeRoute {
        # Runs Invoke-SemLakeRequest with a captured stream; returns @{ Status; Body }.
        param($Raw, [string]$Sql, [object[]]$Params = @(), [hashtable]$Extra = @{})
        $json = [pscustomobject](@{ source = 'lake'; sql = $Sql } + $Extra)
        $plan = @{ Source = [pscustomobject]@{ id = 'lake'; provider = 'athena'; raw = $Raw }; Sql = $Sql; Params = $Params; RowCap = 50000; TimeoutSec = 30 }
        $ms = New-Object IO.MemoryStream
        $script:Sem.Stream = $ms
        try { Invoke-SemLakeRequest -Req @{ Json = $json } -Plan $plan -HomeDir $script:LakeHome } finally { $script:Sem.Stream = $null }
        $text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
        return @{ Status = [int]$text.Substring(9, 3); Body = $text.Substring($text.IndexOf("`r`n`r`n") + 4) }
    }
}

Describe 'Lake engine' {
    BeforeEach {
        $script:LakeHome = Join-Path ([IO.Path]::GetTempPath()) ('sem-lake-' + [guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($script:LakeHome)
        $script:SemLogPath = Join-Path $script:LakeHome 'test.log'
        $script:SavedAws = @{}
        foreach ($n in 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN') { $script:SavedAws[$n] = [Environment]::GetEnvironmentVariable($n) }
        $env:AWS_ACCESS_KEY_ID = 'AKIDTESTSESSION'; $env:AWS_SECRET_ACCESS_KEY = 'secretTESTvalue1234567890'; $env:AWS_SESSION_TOKEN = 'tokenTESTvalue'
    }
    AfterEach {
        foreach ($n in $script:SavedAws.Keys) { [Environment]::SetEnvironmentVariable($n, $script:SavedAws[$n]) }
        Remove-Item -LiteralPath $script:LakeHome -Recurse -Force -ErrorAction SilentlyContinue
    }

    Context 'Signing' {
        It 'matches the AWS SigV4 test suite (get-vanilla)' {
            $h = New-SemAwsSignature -Method 'GET' -Path '/' -Headers @{ host = 'example.amazonaws.com' } -Service 'service' -Region 'us-east-1' -AccessKey 'AKIDEXAMPLE' -SecretKey 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' -Now ([datetime]::ParseExact('20150830T123600Z', "yyyyMMdd'T'HHmmss'Z'", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal))
            $h['Authorization'] | Should -Be 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
        }

        It 'encodes per RFC 3986' {
            ConvertTo-SemUriEncoded 'a b/c~d*' | Should -Be 'a%20b%2Fc~d%2A'
            ConvertTo-SemUriEncoded 'maint/work orders/' -KeepSlash | Should -Be 'maint/work%20orders/'
        }
    }

    Context 'Settings' {
        It 'refuses AWS keys in sources.json' {
            { Get-SemLakeSettings ([pscustomobject]@{ region = 'us-gov-west-1'; database = 'maint'; secretAccessKey = 'x' }) } | Should -Throw -ExpectedMessage '*do not belong in sources.json*'
        }
        It 'refuses a plain-http endpoint that is not loopback, and a bad region' {
            { Get-SemLakeSettings ([pscustomobject]@{ region = 'us-gov-west-1'; database = 'maint'; endpoint = 'http://example.com' }) } | Should -Throw
            { Get-SemLakeSettings ([pscustomobject]@{ region = 'mars'; database = 'maint' }) } | Should -Throw -ExpectedMessage '*region*'
        }
        It 'renders typed parameters as Athena literals' {
            Format-SemLakeLiteral @{ Type = 'string'; Value = "O'Brien" } | Should -Be "'O''Brien'"
            Format-SemLakeLiteral @{ Type = 'number'; Value = 12.5 } | Should -Be '12.5'
            Format-SemLakeLiteral @{ Type = 'date'; Value = [datetime]'2026-01-01' } | Should -Be "DATE '2026-01-01'"
            Format-SemLakeLiteral @{ Type = 'boolean'; Value = $true } | Should -Be 'true'
            Format-SemLakeLiteral @{ Type = 'string'; Value = [DBNull]::Value } | Should -Be 'NULL'
        }
    }

    Context 'Queries' {
        It 'estimates, runs, returns rows in the providers'' shape, records usage and signs every call' {
            $fake = Start-FakeAws -TableBytes 3221225472
            try {
                $l = New-Lake -Endpoint $fake.Endpoint
                $r = Invoke-LakeRoute -Raw $l.Raw -Sql 'SELECT "region" AS "d0", SUM("labor_cost") AS "a0", "opened_on" AS "d1" FROM "work_orders" WHERE "year" = ? GROUP BY 1, 3' -Params @(@{ Type = 'number'; Value = 2026.0 })
                $r.Status | Should -Be 200
                $j = $r.Body | ConvertFrom-Json
                @($j.columns) -join ',' | Should -Be 'd0,a0,d1'
                $j.rows[0].d0 | Should -Be 'Gulf'
                $j.rows[0].a0 | Should -Be 3240000.5
                $j.rows[0].d1 | Should -Be '2026-01-01'
                $j.rows[1].a0 | Should -BeNullOrEmpty
                $j.scannedBytes | Should -Be 52428800
                $j.estimate.bytes | Should -Be 3221225472
                $j.estimate.partitionFiltered | Should -BeTrue
                Get-SemLakeUsedBytes -HomeDir $script:LakeHome | Should -Be 52428800
                $start = @($fake.State.Requests | Where-Object { $_.Head -match 'StartQueryExecution' })[0]
                $start.Body | Should -Match '"ExecutionParameters":\["2026"\]'
                $start.Body | Should -Match '"WorkGroup":"semaphore"'
                foreach ($q in $fake.State.Requests) {
                    $q.Head | Should -Match 'Authorization: AWS4-HMAC-SHA256 Credential=AKIDTESTSESSION/\d{8}/us-gov-west-1/(athena|glue|s3)/aws4_request'
                    $q.Head | Should -Match 'X-Amz-Security-Token: tokenTESTvalue'
                }
            } finally { Stop-FakeAws $fake }
        }

        It 'answers the same query from the cache, free, without calling AWS' {
            $fake = Start-FakeAws
            try {
                $l = New-Lake -Endpoint $fake.Endpoint
                $sql = 'SELECT "region" AS "d0" FROM "work_orders" WHERE "year" = 2026 GROUP BY 1'
                (Invoke-LakeRoute -Raw $l.Raw -Sql $sql).Status | Should -Be 200
                $calls = $fake.State.Requests.Count
                $again = Invoke-LakeRoute -Raw $l.Raw -Sql $sql
                ($again.Body | ConvertFrom-Json).cached | Should -BeTrue
                $fake.State.Requests.Count | Should -Be $calls
                (Invoke-LakeRoute -Raw $l.Raw -Sql $sql -Extra @{ refresh = $true }).Body | Should -Not -Match '"cached":true'
            } finally { Stop-FakeAws $fake }
        }

        It 'asks before a big scan, warns about a missing partition filter, and runs once approved' {
            $fake = Start-FakeAws -TableBytes (20GB)
            try {
                $l = New-Lake -Endpoint $fake.Endpoint
                $sql = 'SELECT "region" AS "d0" FROM "work_orders" GROUP BY 1'
                $r = Invoke-LakeRoute -Raw $l.Raw -Sql $sql
                $r.Status | Should -Be 409
                $j = $r.Body | ConvertFrom-Json
                $j.code | Should -Be 'lake-approval'
                $j.error | Should -Match 'up to 20\.0 GB'
                $j.estimate.warnings[0] | Should -Match 'partitioned by year'
                @($fake.State.Requests | Where-Object { $_.Head -match 'StartQueryExecution' }).Count | Should -Be 0
                (Invoke-LakeRoute -Raw $l.Raw -Sql $sql -Extra @{ approve = $true }).Status | Should -Be 200
            } finally { Stop-FakeAws $fake }
        }

        It 'sizes every table a joined or hand-written query reads' {
            $fake = Start-FakeAws -TableBytes (4GB)
            try {
                $l = New-Lake -Endpoint $fake.Endpoint
                $sql = 'SELECT "t1"."class" AS "d0", COUNT(*) AS "a0" FROM (SELECT DISTINCT * FROM "work_orders") AS "t0" LEFT JOIN "hulls" AS "t1" ON "t0"."hull" = "t1"."hull" WHERE "t0"."year" = 2026 GROUP BY 1'
                @(Get-SemLakeTableNames $sql) -join ',' | Should -Be 'work_orders,hulls'
                $j = (Invoke-LakeRoute -Raw $l.Raw -Sql $sql).Body | ConvertFrom-Json
                $j.estimate.bytes | Should -Be (8GB)
                $j.estimate.table | Should -Be 'work_orders, hulls'
                @($fake.State.Requests | Where-Object { $_.Head -match 'AWSGlue.GetTable' }).Count | Should -Be 2
            } finally { Stop-FakeAws $fake }
        }

        It 'refuses past the daily limit' {
            $fake = Start-FakeAws -TableBytes (5GB)
            try {
                $l = New-Lake -Endpoint $fake.Endpoint -Extra @{ dailyLimitGB = 6 }
                [void](Add-SemLakeUsage -HomeDir $script:LakeHome -Bytes (2GB))
                $r = Invoke-LakeRoute -Raw $l.Raw -Sql 'SELECT "region" AS "d0" FROM "work_orders" WHERE "year" = 2026 GROUP BY 1'
                $r.Status | Should -Be 429
                ($r.Body | ConvertFrom-Json).code | Should -Be 'lake-daily-limit'
            } finally { Stop-FakeAws $fake }
        }

        It 'says when there is no AWS session, and never echoes keys' {
            $env:AWS_SECRET_ACCESS_KEY = $null
            $l = New-Lake -Endpoint 'http://127.0.0.1:9'
            $r = Invoke-LakeRoute -Raw $l.Raw -Sql 'SELECT 1 AS "a0" FROM "work_orders"'
            $r.Status | Should -Be 401
            $r.Body | Should -Match 'No AWS session'
            $r.Body | Should -Not -Match 'AKIDTESTSESSION'
        }
    }

    Context 'Profiling' {
        It 'reads tables and columns from Glue, with no scan' {
            $fake = Start-FakeAws
            try {
                $l = New-Lake -Endpoint $fake.Endpoint
                @((Get-SemLakeProfile -Lake $l.Lake -Table '').tables) -join ',' | Should -Be 'work_orders,hulls'
                $p = Get-SemLakeProfile -Lake $l.Lake -Table 'work_orders'
                @($p.columns | ForEach-Object { "$($_.name):$($_.type)" }) -join ',' | Should -Be 'region:string,labor_cost:number,opened_on:date,year:number'
                @($fake.State.Requests | Where-Object { $_.Head -match 'Athena' }).Count | Should -Be 0
            } finally { Stop-FakeAws $fake }
        }
    }
}
