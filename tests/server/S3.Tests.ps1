# Pester 5. The S3 browser and import (server/S3.ps1): settings and the allowlist, where a bucket answers (GovCloud,
# FIPS, dotted names, endpoints), ListObjectsV2 parsing from fixtures, GetObject streamed to a file through a fake HTTP
# layer (Open-SemAwsResponse mocked, so no AWS call), size checks, .gz, a partitioned prefix joined into one table, the
# import contract (Import-SemLocalFile mocked, and its stub), the routes, and that no secret reaches a log or an answer.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Lake.ps1', 'Vault.ps1', 'Connectors.ps1', 'Commands.ps1', 'S3.ps1') { . ([IO.Path]::Combine($server, $f)) }
    function script:Settings([object[]]$Buckets, $MaxMb = $null, $Aws = $null) {
        $s3 = @{ buckets = @($Buckets) }
        if ($null -ne $MaxMb) { $s3.maxObjectMb = $MaxMb }
        $j = (@{ s3 = $s3; aws = $Aws } | ConvertTo-Json -Depth 6 | ConvertFrom-Json)
        return @{ S3 = $j.s3; Aws = $j.aws }
    }
    $script:Std = Settings @(@{ bucket = 'maint-exports'; region = 'us-gov-west-1'; prefix = 'semaphore' }, @{ bucket = 'lab.data'; region = 'us-east-1' }, @{ bucket = 'sim'; region = 'us-east-1'; endpoint = 'http://127.0.0.1:9000' })
    $script:Config = Get-SemS3Config $script:Std
    $script:Entry = $script:Config.Buckets[0]
    function script:Bytes([string]$Text) { return [Text.Encoding]::UTF8.GetBytes($Text) }
    function script:Resp([int]$Status, [byte[]]$Body, [hashtable]$Headers = @{}, [long]$Length = -2) {
        $h = @{}; foreach ($k in $Headers.Keys) { $h[$k] = $Headers[$k] }
        if ($Length -eq -2) { $Length = $Body.Length }
        if ($Length -ge 0) { $h['content-length'] = [string]$Length }
        return @{ Status = $Status; Headers = $h; Stream = (New-Object IO.MemoryStream (, $Body)); Response = $null }
    }
    function script:Gzip([byte[]]$Data) {
        $ms = New-Object IO.MemoryStream
        $gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionMode]::Compress, $true)
        $gz.Write($Data, 0, $Data.Length); $gz.Dispose()
        return $ms.ToArray()
    }
    function script:ListXml([string[]]$Keys, [string[]]$Prefixes = @(), [string]$Next = '') {
        $c = ($Keys | ForEach-Object { '<Contents><Key>' + [Security.SecurityElement]::Escape($_.Split('|')[0]) + '</Key><LastModified>2026-11-02T10:00:00.000Z</LastModified><ETag>&quot;' + $_.Split('|')[2] + '&quot;</ETag><Size>' + $_.Split('|')[1] + '</Size><StorageClass>STANDARD</StorageClass></Contents>' }) -join ''
        $p = ($Prefixes | ForEach-Object { '<CommonPrefixes><Prefix>' + $_ + '</Prefix></CommonPrefixes>' }) -join ''
        $t = if ($Next) { '<IsTruncated>true</IsTruncated><NextContinuationToken>' + $Next + '</NextContinuationToken>' } else { '<IsTruncated>false</IsTruncated>' }
        return '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>maint-exports</Name>' + $t + $c + $p + '</ListBucketResult>'
    }
    function script:New-Job([string]$Id = 'job1') { return (New-SemS3JobState -Id $Id -Plan @{ Bucket = 'maint-exports'; Prefix = $null; Keys = @('semaphore/x.csv'); Table = 't' }) }
    $script:HomeDir = Join-Path $TestDrive 'home'
    New-Item -ItemType Directory -Path $script:HomeDir | Out-Null
    $script:SemLogPath = Join-Path $TestDrive 'semaphore.log'
}

Describe 'Settings and the allowlist' {
    It 'reads buckets, adds the slash to a prefix and defaults the size limit to 20480 MB' {
        $script:Config.Buckets.Count | Should -Be 3
        $script:Entry.Prefix | Should -Be 'semaphore/'
        $script:Config.MaxObjectMb | Should -Be 20480
        $script:Config.MaxObjectBytes | Should -Be ([long]20480 * 1MB)
        (Get-SemS3Config (Settings @() 5)).MaxObjectBytes | Should -Be ([long]5MB)
    }
    It 'skips bad entries with a sentence each' {
        $c = Get-SemS3Config (Settings @(@{ bucket = 'UPPER'; region = 'us-east-1' }, @{ bucket = 'ok-bucket'; region = 'nowhere' }, @{ bucket = 'ok-bucket'; region = 'us-east-1'; endpoint = 'http://evil.example.com' }, 'text') 0)
        $c.Buckets.Count | Should -Be 0
        $c.Problems.Count | Should -Be 5
        ($c.Problems -join ' ') | Should -Match 'maxObjectMb'
    }
    It 'allows only listed buckets, and inside them only the listed prefix' {
        (Find-SemS3Entry -Config $script:Config -Bucket 'maint-exports' -Key 'semaphore/a/b.csv').Entry.Bucket | Should -Be 'maint-exports'
        (Find-SemS3Entry -Config $script:Config -Bucket 'lab.data' -Key 'anything.csv').Entry.Bucket | Should -Be 'lab.data'
        $r = Find-SemS3Entry -Config $script:Config -Bucket 'other-bucket' -Key 'semaphore/a.csv'
        $r.Error.Status | Should -Be 403; $r.Error.Message | Should -Match 'not one Semaphore may read'
        $r = Find-SemS3Entry -Config $script:Config -Bucket 'maint-exports' -Key 'payroll/a.csv'
        $r.Error.Code | Should -Be 's3-not-allowed'; $r.Error.Message | Should -Match 'only s3://maint-exports/semaphore/ is allowed'
        (Find-SemS3Entry -Config $script:Config -Bucket 'maint-exports' -Key 'semaphore-archive/a.csv').Error.Status | Should -Be 403 -Because '"semaphore" must not open "semaphore-archive/"'
        (Find-SemS3Entry -Config $script:Config -Bucket 'Maint-Exports' -Key 'semaphore/a.csv').Error.Status | Should -Be 403 -Because 'bucket names are matched exactly'
        (Find-SemS3Entry -Config (Get-SemS3Config (Settings @())) -Bucket 'x' -Key 'y').Error.Message | Should -Match 'No S3 buckets are set up'
    }
    It 'finds where a bucket answers: virtual host, path style for dots, FIPS, an endpoint' {
        (Get-SemS3Location $script:Entry).Origin | Should -Be 'https://maint-exports.s3.us-gov-west-1.amazonaws.com'
        (Get-SemS3Location $script:Entry).PathPrefix | Should -Be ''
        $dot = Get-SemS3Location $script:Config.Buckets[1]
        $dot.Origin | Should -Be 'https://s3.us-east-1.amazonaws.com'; $dot.PathPrefix | Should -Be '/lab.data'
        $sim = Get-SemS3Location $script:Config.Buckets[2]
        $sim.Origin | Should -Be 'http://127.0.0.1:9000'; $sim.PathPrefix | Should -Be '/sim'
        $f = Get-SemS3Config (Settings @(@{ bucket = 'gov-data'; region = 'us-gov-east-1' }) $null @{ fips = $true })
        (Get-SemS3Location $f.Buckets[0]).Origin | Should -Be 'https://gov-data.s3-fips.us-gov-east-1.amazonaws.com'
    }
    It 'shows the page the allowlist and nothing else' {
        $script:Sem.AwsSettings = Settings @(@{ bucket = 'maint-exports'; region = 'us-gov-west-1'; prefix = 'semaphore/' }) $null @{ vault = @{ accessKeyId = 'AWS_ACCESS_KEY_ID'; secretAccessKey = 'AWS_SECRET_ACCESS_KEY' } }
        $l = Get-SemS3BucketList
        $l.buckets[0].bucket | Should -Be 'maint-exports'
        $l.maxPrefixObjects | Should -Be 2000
        (ConvertTo-Json $l -Depth 5) | Should -Not -Match 'vault|AWS_|accessKey'
    }
}

Describe 'Listing (ListObjectsV2)' {
    It 'parses folders, objects, sizes, unquoted ETags and the continuation token, without the folder marker' {
        $x = ListXml @('semaphore/|0|d41d8cd98f00b204e9800998ecf8427e', 'semaphore/work_orders.csv|48213|9b2cf535f27731c974343645a3985328', 'semaphore/a&b.csv|7|abc-2') @('semaphore/parts/') 'token/+=='
        $p = ConvertFrom-SemS3ListXml -Text $x -Prefix 'semaphore/'
        $p.Folders.Count | Should -Be 1; $p.Folders[0].name | Should -Be 'parts'; $p.Folders[0].prefix | Should -Be 'semaphore/parts/'
        @($p.Objects | ForEach-Object { $_.name }) | Should -Be @('work_orders.csv', 'a&b.csv')
        $p.Objects[0].size | Should -Be 48213
        $p.Objects[0].etag | Should -Be '9b2cf535f27731c974343645a3985328'
        $p.Objects[0].lastModified | Should -Be '2026-11-02T10:00:00.000Z'
        $p.Truncated | Should -BeTrue; $p.NextToken | Should -Be 'token/+=='
    }
    It 'asks S3 with delimiter, prefix and the continuation token, signed for s3 in the bucket''s region' {
        $script:Seen = $null
        Mock Open-SemAwsResponse { $script:Seen = @{ Origin = $Origin; Path = $Path; Query = $Query.Clone(); Service = $Service; Region = $Region; Method = $Method }; return (Resp 200 (Bytes (ListXml @('semaphore/x.csv|5|e1')))) }
        $p = Invoke-SemS3ListPage -Entry $script:Entry -Prefix 'semaphore/' -Token 'tok1'
        $p.Objects[0].key | Should -Be 'semaphore/x.csv'
        $script:Seen.Service | Should -Be 's3'; $script:Seen.Region | Should -Be 'us-gov-west-1'; $script:Seen.Method | Should -Be 'GET'
        $script:Seen.Path | Should -Be '/'
        $script:Seen.Query['list-type'] | Should -Be '2'; $script:Seen.Query['delimiter'] | Should -Be '/'
        $script:Seen.Query['prefix'] | Should -Be 'semaphore/'; $script:Seen.Query['continuation-token'] | Should -Be 'tok1'
    }
    It 'turns an S3 error into a sentence with the permission it needs' {
        Mock Open-SemAwsResponse { return (Resp 403 (Bytes '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message><RequestId>X</RequestId></Error>')) }
        { Invoke-SemS3ListPage -Entry $script:Entry -Prefix 'semaphore/' } | Should -Throw '*S3 answered 403 when listing s3://maint-exports/semaphore/: AccessDenied: Access Denied.*s3:ListBucket*'
    }
    It 'refuses a listing outside the allowlist on the route, before AWS is asked' {
        Mock Open-SemAwsResponse { throw 'AWS must not be asked' }
        Mock Send-SemError { $script:Err = @{ Status = $Status; Code = $Code; Message = $Message } }
        $script:Err = $null
        Invoke-SemAwsWorkerRequest -Req @{ Path = '/api/s3/list'; Query = 'bucket=maint-exports&prefix=payroll%2F' } -Settings $script:Std
        $script:Err.Status | Should -Be 403
        $script:Err = $null
        Invoke-SemAwsWorkerRequest -Req @{ Path = '/api/s3/list'; Query = 'bucket=secret-bucket' } -Settings $script:Std
        $script:Err.Status | Should -Be 403
        Should -Invoke Open-SemAwsResponse -Times 0 -Exactly
    }
    It 'lists from the allowlisted prefix when none is given' {
        Mock Open-SemAwsResponse { $script:Q = $Query.Clone(); return (Resp 200 (Bytes (ListXml @('semaphore/x.csv|5|e1') @('semaphore/parts/')))) }
        Mock Send-SemJson { $script:Out = $Object }
        Invoke-SemAwsWorkerRequest -Req @{ Path = '/api/s3/list'; Query = 'bucket=maint-exports' } -Settings $script:Std
        $script:Q['prefix'] | Should -Be 'semaphore/'
        $script:Out.root | Should -Be 'semaphore/'
        $script:Out.folders[0].name | Should -Be 'parts'
        $script:Out.objects[0].etag | Should -Be 'e1'
    }
    It 'reads query values, percent-decoded' {
        Get-SemQueryParam 'bucket=a&prefix=x%2Fy+z%2F&token=' 'prefix' | Should -Be 'x/y z/'
        Get-SemQueryParam 'bucket=a' 'token' | Should -Be ''
    }
}

Describe 'GetObject streamed to a file' {
    BeforeEach { $script:Out = Join-Path $TestDrive ([guid]::NewGuid().ToString('N') + '.csv') }
    It 'writes the whole object in pieces, pinned to the ETag, and counts the bytes' {
        $data = New-Object byte[] (3MB + 17); (New-Object Random 7).NextBytes($data)
        $script:Headers = $null
        Mock Open-SemAwsResponse { $script:Headers = $Headers.Clone(); $script:Path = $Path; return (Resp 200 $data) }
        $state = New-Job
        $n = Save-SemS3Object -Entry $script:Entry -Key 'semaphore/big file+1.csv' -ETag 'abc' -Size $data.Length -OutFile $script:Out -MaxBytes 1GB -State $state
        $n | Should -Be $data.Length
        $state.bytes | Should -Be $data.Length
        (Get-SemSha256Hex ([IO.File]::ReadAllBytes($script:Out))) | Should -Be (Get-SemSha256Hex $data)
        $script:Headers['If-Match'] | Should -Be '"abc"'
        $script:Path | Should -Be '/semaphore/big file+1.csv' -Because 'the raw key goes to the seam, which encodes it once'
    }
    It 'refuses a size that differs from the listing, a short body, a changed object and an object over the limit' {
        Mock Open-SemAwsResponse { return (Resp 200 (Bytes 'abc')) }
        { Save-SemS3Object -Entry $script:Entry -Key 'semaphore/a.csv' -Size 4 -OutFile $script:Out -MaxBytes 1MB } | Should -Throw '*is 3 bytes now, not the 4*'
        Mock Open-SemAwsResponse { return (Resp 200 (Bytes 'abc') -Length 10) }
        { Save-SemS3Object -Entry $script:Entry -Key 'semaphore/a.csv' -OutFile (Join-Path $TestDrive 'short.csv') -MaxBytes 1MB } | Should -Throw '*stopped after 3 of 10 bytes*'
        Mock Open-SemAwsResponse { return (Resp 412 (Bytes '<Error><Code>PreconditionFailed</Code></Error>')) }
        { Save-SemS3Object -Entry $script:Entry -Key 'semaphore/a.csv' -ETag 'old' -OutFile (Join-Path $TestDrive 'p.csv') -MaxBytes 1MB } | Should -Throw '*changed after it was listed*'
        Mock Open-SemAwsResponse { return (Resp 200 (New-Object byte[] 2048) -Length -1) }
        { Save-SemS3Object -Entry $script:Entry -Key 'semaphore/a.csv' -OutFile (Join-Path $TestDrive 'big.csv') -MaxBytes 1024 } | Should -Throw '*larger than the 0 MB limit*'
    }
    It 'expands a .gz file and refuses a concatenated (multi-member) one' {
        $plain = Bytes ("a,b`n" + ('1,2' + "`n") * 5000)
        $gz = Join-Path $TestDrive 'one.gz'; [IO.File]::WriteAllBytes($gz, (Gzip $plain))
        $outFile = Join-Path $TestDrive 'one.csv'
        Expand-SemGzipFile -Path $gz -OutFile $outFile -MaxBytes 1GB | Should -Be $plain.Length
        [IO.File]::ReadAllBytes($outFile).Length | Should -Be $plain.Length
        $two = Join-Path $TestDrive 'two.gz'; [IO.File]::WriteAllBytes($two, [byte[]]((Gzip (Bytes "a,b`n1,2`n")) + (Gzip (Bytes "3,4`n"))))
        { Expand-SemGzipFile -Path $two -OutFile (Join-Path $TestDrive 'two.csv') -MaxBytes 1GB } | Should -Throw '*several gzip streams*'
        { Expand-SemGzipFile -Path $gz -OutFile (Join-Path $TestDrive 'cap.csv') -MaxBytes 100 } | Should -Throw '*limit*'
    }
}

Describe 'The import plan (no AWS call)' {
    It 'takes one of key, keys or prefix, inside the allowlist' {
        $b = { param($h) Get-SemS3ImportPlan -Body ($h | ConvertTo-Json | ConvertFrom-Json) -Config $script:Config }
        $p = & $b @{ bucket = 'maint-exports'; key = 'semaphore/Work Orders 2026.csv.gz' }
        $p.Keys | Should -Be @('semaphore/Work Orders 2026.csv.gz'); $p.Table | Should -Be 'work_orders_2026'
        (& $b @{ bucket = 'maint-exports'; prefix = 'semaphore/parts' }).Prefix | Should -Be 'semaphore/parts/'
        (& $b @{ bucket = 'maint-exports'; prefix = 'semaphore/parts' }).Table | Should -Be 'parts'
        (& $b @{ bucket = 'maint-exports'; keys = @('semaphore/p/a.parquet', 'semaphore/p/b.parquet'); table = 'Parts_2026'; replace = $true }).Table | Should -Be 'Parts_2026'
        (& $b @{ bucket = 'maint-exports'; keys = @('semaphore/p/a.parquet', 'semaphore/p/b.parquet') }).Table | Should -Be 'p'
        (& $b @{ bucket = 'maint-exports'; key = 'semaphore/2026.csv' }).Table | Should -Be 't_2026'
    }
    It 'refuses the rest with a sentence' {
        $b = { param($h) (Get-SemS3ImportPlan -Body ($h | ConvertTo-Json | ConvertFrom-Json) -Config $script:Config).Error }
        (& $b @{ bucket = 'payroll'; key = 'semaphore/a.csv' }).Status | Should -Be 403
        (& $b @{ bucket = 'maint-exports'; key = 'other/a.csv' }).Status | Should -Be 403
        (& $b @{ bucket = 'maint-exports'; keys = @('semaphore/a.csv', 'other/b.csv') }).Status | Should -Be 403 -Because 'every key is checked'
        (& $b @{ bucket = 'maint-exports'; prefix = 'other/' }).Status | Should -Be 403
        (& $b @{ bucket = 'maint-exports'; key = 'semaphore/a.csv'; prefix = 'semaphore/' }).Message | Should -Match 'exactly one'
        (& $b @{ bucket = 'maint-exports'; keys = @('semaphore/a.csv', 'semaphore/b.parquet') }).Message | Should -Match 'different kinds'
        (& $b @{ bucket = 'maint-exports'; key = 'semaphore/a.exe' }).Message | Should -Match 'CSV, TSV'
        (& $b @{ bucket = 'maint-exports'; key = 'semaphore/a.csv'; table = 'x; DROP' }).Message | Should -Match 'table name'
        (& $b @{ bucket = 'maint-exports'; key = 'semaphore/dir/' }).Message | Should -Match 'not a folder'
        (& $b @{ bucket = 'maint-exports'; keys = @(1..2001 | ForEach-Object { "semaphore/$_.csv" }) }).Message | Should -Match 'At most 2000'
    }
}

Describe 'Import jobs' {
    BeforeEach {
        $script:Imports = New-Object Collections.ArrayList
        Mock Import-SemLocalFile {
            [void]$script:Imports.Add(@{ HomeDir = $HomeDir; Path = $Path; Table = $Table; Sheet = $Sheet; SourceLabel = $SourceLabel; Replace = [bool]$Replace; Content = [IO.File]::ReadAllText($Path); Exists = [IO.File]::Exists($Path) })
            return @{ Table = $Table; Rows = 2; Columns = 3; Ms = 5 }
        }
    }
    It 'imports one object: HEAD, GET to a file under local\incoming, then Import-SemLocalFile with s3://bucket/key#etag' {
        $body = Bytes "id,region,cost`n1,Gulf,10`n2,West,20`n"
        Mock Open-SemAwsResponse {
            if ($Method -eq 'HEAD') { return (Resp 200 (New-Object byte[] 0) @{ etag = '"e-123"'; 'last-modified' = 'Mon, 02 Nov 2026 10:00:00 GMT' } -Length $body.Length) }
            return (Resp 200 $body)
        }
        $state = New-Job 'jobA'
        $plan = Get-SemS3ImportPlan -Body ('{"bucket":"maint-exports","key":"semaphore/work_orders.csv","replace":true}' | ConvertFrom-Json) -Config $script:Config
        Invoke-SemS3ImportJob -Plan $plan -HomeDir $script:HomeDir -State $state -MaxBytes 1GB
        $state.error | Should -BeNullOrEmpty
        $state.state | Should -Be 'done'; $state.table | Should -Be 'work_orders'; $state.rows | Should -Be 2; $state.columns | Should -Be 3
        $state.bytes | Should -Be $body.Length; $state.totalBytes | Should -Be $body.Length
        $script:Imports.Count | Should -Be 1
        $i = $script:Imports[0]
        $i.SourceLabel | Should -Be 's3://maint-exports/semaphore/work_orders.csv#e-123'
        $i.Replace | Should -BeTrue; $i.Table | Should -Be 'work_orders'; $i.HomeDir | Should -Be $script:HomeDir
        $i.Path | Should -BeLike ((Join-Path $script:HomeDir 'local\incoming\jobA') + '\*.csv')
        $i.Content | Should -Be "id,region,cost`n1,Gulf,10`n2,West,20`n"
        [IO.Directory]::Exists((Join-Path $script:HomeDir 'local\incoming\jobA')) | Should -BeFalse -Because 'the download is removed after the import'
    }
    It 'expands a .gz object before the import' {
        $plain = Bytes "a,b`n1,2`n"
        $gz = Gzip $plain
        Mock Open-SemAwsResponse {
            if ($Method -eq 'HEAD') { return (Resp 200 (New-Object byte[] 0) @{ etag = '"g1"' } -Length $gz.Length) }
            return (Resp 200 $gz)
        }
        $state = New-Job 'jobGz'
        $plan = Get-SemS3ImportPlan -Body ('{"bucket":"maint-exports","key":"semaphore/hulls.csv.gz","table":"hulls"}' | ConvertFrom-Json) -Config $script:Config
        Invoke-SemS3ImportJob -Plan $plan -HomeDir $script:HomeDir -State $state -MaxBytes 1GB
        $state.state | Should -Be 'done'
        $script:Imports[0].Content | Should -Be "a,b`n1,2`n"
        $script:Imports[0].Path | Should -Match '\.csv$'
        $script:Imports[0].Replace | Should -BeFalse
    }
    It 'joins the CSV parts of a partitioned prefix into one table, header once, bookkeeping files left out' {
        $parts = @{ 'semaphore/parts/year=2025/part-0000.csv' = "id,cost`r`n1,10`r`n"; 'semaphore/parts/year=2026/part-0000.csv' = ([char]0xFEFF + "id,cost`n2,20"); 'semaphore/parts/year=2026/part-0001.csv' = "id,cost`n3,30`n" }
        Mock Open-SemAwsResponse {
            if ($Query -and $Query.ContainsKey('list-type')) {
                $Query.ContainsKey('delimiter') | Should -BeFalse -Because 'a prefix import lists every key below it'
                $keys = @($parts.Keys | Sort-Object | ForEach-Object { $_ + '|' + [Text.Encoding]::UTF8.GetByteCount($parts[$_]) + '|' + $_.GetHashCode() }) + @('semaphore/parts/_SUCCESS|0|x', 'semaphore/parts/year=2025/.part-0000.csv.crc|12|y', 'semaphore/parts/year=2026/|0|z')
                return (Resp 200 (Bytes (ListXml $keys)))
            }
            $k = $Path.Substring(1)
            return (Resp 200 (Bytes $parts[$k]))
        }
        $state = New-Job 'jobP'
        $plan = Get-SemS3ImportPlan -Body ('{"bucket":"maint-exports","prefix":"semaphore/parts/"}' | ConvertFrom-Json) -Config $script:Config
        Invoke-SemS3ImportJob -Plan $plan -HomeDir $script:HomeDir -State $state -MaxBytes 1GB
        $state.error | Should -BeNullOrEmpty
        $state.objectCount | Should -Be 3; $state.objects | Should -Be 3
        $script:Imports.Count | Should -Be 1
        $script:Imports[0].Content | Should -Be "id,cost`r`n1,10`r`n2,20`n3,30`n"
        $script:Imports[0].Table | Should -Be 'parts'
        $script:Imports[0].SourceLabel | Should -Match '^s3://maint-exports/semaphore/parts/#[0-9a-f]{16}$'
    }
    It 'refuses parts whose columns differ' {
        $parts = @{ 'semaphore/p/a.csv' = "id,cost`n1,10`n"; 'semaphore/p/b.csv' = "id,price`n2,20`n" }
        Mock Open-SemAwsResponse {
            if ($Query -and $Query.ContainsKey('list-type')) { return (Resp 200 (Bytes (ListXml @($parts.Keys | Sort-Object | ForEach-Object { $_ + '|' + $parts[$_].Length + '|e' })))) }
            return (Resp 200 (Bytes $parts[$Path.Substring(1)]))
        }
        $state = New-Job 'jobDiff'
        Invoke-SemS3ImportJob -Plan (Get-SemS3ImportPlan -Body ('{"bucket":"maint-exports","prefix":"semaphore/p/"}' | ConvertFrom-Json) -Config $script:Config) -HomeDir $script:HomeDir -State $state -MaxBytes 1GB
        $state.state | Should -Be 'failed'
        $state.error | Should -Match 'Part 2 of the prefix has different columns'
        $script:Imports.Count | Should -Be 0
    }
    It 'imports Parquet parts one by one into the same table: the first replaces, the rest add' {
        Mock Open-SemAwsResponse {
            if ($Method -eq 'HEAD') { return (Resp 200 (New-Object byte[] 0) @{ etag = '"pq"' } -Length 4) }
            return (Resp 200 (Bytes 'PAR1'))
        }
        $state = New-Job 'jobPq'
        $plan = Get-SemS3ImportPlan -Body ('{"bucket":"maint-exports","keys":["semaphore/pq/a.parquet","semaphore/pq/b.parquet"],"replace":true}' | ConvertFrom-Json) -Config $script:Config
        Invoke-SemS3ImportJob -Plan $plan -HomeDir $script:HomeDir -State $state -MaxBytes 1GB
        $state.state | Should -Be 'done'; $state.rows | Should -Be 4
        @($script:Imports | ForEach-Object { $_.Replace }) | Should -Be @($true, $false)
        @($script:Imports | ForEach-Object { $_.Table } | Select-Object -Unique) | Should -Be @('pq')
    }
    It 'caps a prefix at 2000 objects' {
        Mock Open-SemAwsResponse { return (Resp 200 (Bytes (ListXml @(1..2001 | ForEach-Object { "semaphore/big/part-$_.csv|10|e" })))) }
        $state = New-Job 'jobCap'
        Invoke-SemS3ImportJob -Plan (Get-SemS3ImportPlan -Body ('{"bucket":"maint-exports","prefix":"semaphore/big/"}' | ConvertFrom-Json) -Config $script:Config) -HomeDir $script:HomeDir -State $state -MaxBytes 1GB
        $state.state | Should -Be 'failed'
        $state.error | Should -Match 'more than 2000 data objects'
    }
    It 'refuses an object over s3.maxObjectMb before downloading it' {
        Mock Open-SemAwsResponse { if ($Method -eq 'HEAD') { return (Resp 200 (New-Object byte[] 0) @{ etag = '"e"' } -Length (3MB)) }; throw 'must not download' }
        $state = New-Job 'jobBig'
        Invoke-SemS3ImportJob -Plan (Get-SemS3ImportPlan -Body ('{"bucket":"maint-exports","key":"semaphore/huge.csv"}' | ConvertFrom-Json) -Config $script:Config) -HomeDir $script:HomeDir -State $state -MaxBytes 2MB
        $state.error | Should -Match 'larger than the 2 MB limit'
    }
}

Describe 'Import-SemLocalFile contract' {
    It 'has the stub that says the local database is not there yet, with the agreed parameters' {
        $cmd = Get-Command Import-SemLocalFile
        foreach ($n in 'HomeDir', 'Path', 'Table', 'Sheet', 'SourceLabel', 'Replace') { $cmd.Parameters.ContainsKey($n) | Should -BeTrue -Because $n }
        $cmd.Parameters['Replace'].SwitchParameter | Should -BeTrue
        if ($cmd.Definition -match 'STUB') { { Import-SemLocalFile -HomeDir 'x' -Path 'y' } | Should -Throw 'The local database is not available yet' }
    }
    It 'reports the stub''s sentence on the job' {
        if ((Get-Command Import-SemLocalFile).Definition -notmatch 'STUB') { Set-ItResult -Skipped -Because 'the real local database is loaded' ; return }
        Mock Open-SemAwsResponse { if ($Method -eq 'HEAD') { return (Resp 200 (New-Object byte[] 0) @{ etag = '"e"' } -Length 4) }; return (Resp 200 (Bytes "a`n1`n")) }
        $state = New-Job 'jobStub'
        Invoke-SemS3ImportJob -Plan (Get-SemS3ImportPlan -Body ('{"bucket":"maint-exports","key":"semaphore/a.csv"}' | ConvertFrom-Json) -Config $script:Config) -HomeDir $script:HomeDir -State $state -MaxBytes 1GB
        $state.state | Should -Be 'failed'
        $state.error | Should -Be 'The local database is not available yet'
    }
}

Describe 'Routes' {
    BeforeEach {
        $script:Sem.AwsSettings = $script:Std
        $script:Sem.S3Jobs = [hashtable]::Synchronized(@{})
        $script:Sent = $null
        Mock Send-SemError { $script:Sent = @{ Status = $Status; Code = $Code; Message = $Message } }
        Mock Send-SemJson { $script:Sent = @{ Status = $Status; Object = $Object } }
    }
    It 'refuses an import outside the allowlist with 403 and starts nothing' {
        Start-SemS3Import -Req @{ Json = ('{"bucket":"payroll","key":"a.csv"}' | ConvertFrom-Json) }
        $script:Sent.Status | Should -Be 403
        $script:Sem.S3Jobs.Count | Should -Be 0
    }
    It 'refuses a second import while one runs' {
        $script:Sem.S3Jobs['busy1'] = New-Job 'busy1'
        $script:Sem.S3Jobs['busy1'].state = 'running'
        Start-SemS3Import -Req @{ Json = ('{"bucket":"maint-exports","key":"semaphore/a.csv"}' | ConvertFrom-Json) }
        $script:Sent.Status | Should -Be 409
    }
    It 'answers the status of a job, and 404 for an unknown one' {
        $j = New-Job 'abc123'; $j.state = 'running'; $j.phase = 'downloading'; $j.bytes = 10; $j.totalBytes = 40
        $script:Sem.S3Jobs['abc123'] = $j
        Invoke-SemS3StatusRoute -Path '/api/s3/import-status/abc123'
        $script:Sent.Status | Should -Be 200
        $script:Sent.Object.phase | Should -Be 'downloading'; $script:Sent.Object.totalBytes | Should -Be 40
        Invoke-SemS3StatusRoute -Path '/api/s3/import-status/../../x'
        $script:Sent.Status | Should -Be 404
    }
    It 'serves the S3 and RDS routes through the router' {
        Invoke-SemRoute -Req @{ Path = '/api/s3/buckets'; Method = 'GET'; Json = $null }
        $script:Sent.Status | Should -Be 200
        $script:Sent.Object.buckets.Count | Should -Be 3
        Invoke-SemRoute -Req @{ Path = '/api/s3/import'; Method = 'GET'; Json = $null }
        $script:Sent.Status | Should -Be 405
        Mock Start-SemWorkerRequest { $script:Worker = $Req.Path }
        Invoke-SemRoute -Req @{ Path = '/api/rds/discover'; Method = 'GET'; Json = $null }
        $script:Worker | Should -Be '/api/rds/discover'
        Invoke-SemRoute -Req @{ Path = '/api/s3/list'; Method = 'GET'; Json = $null }
        $script:Worker | Should -Be '/api/s3/list'
    }
    It 'lists each S3 and RDS route as browser-only, with a reason' {
        foreach ($r in '/api/s3/buckets', '/api/s3/list', '/api/s3/import', '/api/s3/import-status', '/api/rds/discover') { Test-SemRouteCovered $r | Should -BeTrue -Because $r }
    }
}

Describe 'No secret in logs or answers' {
    BeforeEach {
        $script:SavedEnv = @{}
        foreach ($n in 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN') { $script:SavedEnv[$n] = [Environment]::GetEnvironmentVariable($n) }
        [Environment]::SetEnvironmentVariable('AWS_ACCESS_KEY_ID', 'AKIDLEAKTEST')
        [Environment]::SetEnvironmentVariable('AWS_SECRET_ACCESS_KEY', 'SECRETLEAKTESTVALUE')
        [Environment]::SetEnvironmentVariable('AWS_SESSION_TOKEN', 'SESSIONLEAKTESTVALUE')
        Set-Content -LiteralPath $script:SemLogPath -Value '' -Encoding ASCII
    }
    AfterEach { Clear-SemVaultRequest; foreach ($n in $script:SavedEnv.Keys) { [Environment]::SetEnvironmentVariable($n, $script:SavedEnv[$n]) } }
    It 'scrubs keys and vault values from a failed job''s error and from the log' {
        Set-SemVaultRequest @{ Values = @{ accessKeyId = 'AKIDVAULT'; secretAccessKey = 'VAULTSECRETVALUE' }; Notes = @() }
        Mock Open-SemAwsResponse { throw ('AWS could not be reached (s3): proxy said SECRETLEAKTESTVALUE SESSIONLEAKTESTVALUE VAULTSECRETVALUE') }
        $state = New-Job 'jobLeak'
        Invoke-SemS3ImportJob -Plan (Get-SemS3ImportPlan -Body ('{"bucket":"maint-exports","key":"semaphore/a.csv"}' | ConvertFrom-Json) -Config $script:Config) -HomeDir $script:HomeDir -State $state -MaxBytes 1GB
        $state.state | Should -Be 'failed'
        $state.error | Should -Not -Match 'SECRETLEAKTESTVALUE|SESSIONLEAKTESTVALUE|VAULTSECRETVALUE'
        (ConvertTo-Json (ConvertTo-SemS3JobJson $state)) | Should -Not -Match 'LEAKTEST|VAULTSECRET'
        $log = [IO.File]::ReadAllText($script:SemLogPath)
        $log | Should -Match 'S3 import jobLeak failed'
        $log | Should -Not -Match 'SECRETLEAKTESTVALUE|SESSIONLEAKTESTVALUE|VAULTSECRETVALUE'
    }
    It 'never puts the signing key or session in a request the seam sends, only the signature' {
        # The real seam against a closed loopback port: the failure message carries no key.
        $entry = (Get-SemS3Config (Settings @(@{ bucket = 'sim'; region = 'us-east-1'; endpoint = 'http://127.0.0.1:1' }))).Buckets[0]
        $msg = $null
        try { [void](Invoke-SemS3ListPage -Entry $entry -Prefix '') } catch { $msg = $_.Exception.Message }
        $msg | Should -Match 'could not be reached'
        $msg | Should -Not -Match 'SECRETLEAKTESTVALUE|SESSIONLEAKTESTVALUE'
    }
    It 'answers a discovery failure without keys' {
        Mock Open-SemAwsResponse { throw 'boom SECRETLEAKTESTVALUE' }
        Mock Send-SemError { $script:Sent = $Message }
        Invoke-SemAwsWorkerRequest -Req @{ Path = '/api/rds/discover'; Query = 'region=us-gov-west-1' } -Settings $script:Std
        $script:Sent | Should -Match 'boom'
        $script:Sent | Should -Not -Match 'SECRETLEAKTESTVALUE'
    }
}

Describe 'An import on the worker pool against a simulated S3 on loopback' {
    BeforeAll {
        $script:Body = [Text.Encoding]::UTF8.GetBytes("id,cost`n" + (-join (1..40000 | ForEach-Object { "$_,1.5`n" })))
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $listener.Start()
        $state = [hashtable]::Synchronized(@{ Heads = (New-Object Collections.ArrayList) })
        $ps = [powershell]::Create()
        [void]$ps.AddScript({
            param($Listener, $State, $Body)
            while ($true) {
                try { $c = $Listener.AcceptTcpClient() } catch { break }
                try {
                    $s = $c.GetStream(); $s.ReadTimeout = 5000
                    $buf = New-Object byte[] 65536; $raw = ''
                    do { $n = $s.Read($buf, 0, $buf.Length); $raw += [Text.Encoding]::ASCII.GetString($buf, 0, $n) } while ($n -gt 0 -and $raw -notmatch "`r`n`r`n")
                    $head = $raw.Substring(0, $raw.IndexOf("`r`n`r`n"))
                    [void]$State.Heads.Add($head)
                    $line = $head.Split("`r")[0]
                    $etag = '"5d41402abc4b2a76b9719d911017c592"'
                    if ($line -like 'HEAD /sim/semaphore/work%20orders.csv *') {
                        $h = "HTTP/1.1 200 OK`r`nETag: $etag`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`n`r`n"
                        $hb = [Text.Encoding]::ASCII.GetBytes($h); $s.Write($hb, 0, $hb.Length)
                    } elseif ($line -like 'GET /sim/semaphore/work%20orders.csv *' -and $head -match "(?im)^If-Match: $([regex]::Escape($etag))") {
                        $h = "HTTP/1.1 200 OK`r`nETag: $etag`r`nContent-Type: text/csv`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`n`r`n"
                        $hb = [Text.Encoding]::ASCII.GetBytes($h); $s.Write($hb, 0, $hb.Length)
                        for ($o = 0; $o -lt $Body.Length; $o += 65536) { $s.Write($Body, $o, [Math]::Min(65536, $Body.Length - $o)) }
                    } else {
                        $x = [Text.Encoding]::UTF8.GetBytes('<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>')
                        $hb = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 404 Not Found`r`nContent-Length: $($x.Length)`r`nConnection: close`r`n`r`n"); $s.Write($hb, 0, $hb.Length); $s.Write($x, 0, $x.Length)
                    }
                    $s.Flush()
                } catch { } finally { $c.Close() }
            }
        }).AddArgument($listener).AddArgument($state).AddArgument($script:Body)
        $script:FakeS3 = @{ Listener = $listener; PS = $ps; Handle = $ps.BeginInvoke(); State = $state; Endpoint = 'http://127.0.0.1:' + ([Net.IPEndPoint]$listener.LocalEndpoint).Port }
        $script:SavedEnv = @{}
        foreach ($n in 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN') { $script:SavedEnv[$n] = [Environment]::GetEnvironmentVariable($n) }
        [Environment]::SetEnvironmentVariable('AWS_ACCESS_KEY_ID', 'AKIDPOOLTEST'); [Environment]::SetEnvironmentVariable('AWS_SECRET_ACCESS_KEY', 'POOLSECRETPOOLSECRET'); [Environment]::SetEnvironmentVariable('AWS_SESSION_TOKEN', $null)
        $script:Sem.Home = Join-Path $TestDrive 'poolhome'; New-Item -ItemType Directory -Path $script:Sem.Home | Out-Null
        $script:Sem.AwsSettings = Settings @(@{ bucket = 'sim'; region = 'us-east-1'; prefix = 'semaphore/'; endpoint = $script:FakeS3.Endpoint })
        $script:Sem.S3Jobs = [hashtable]::Synchronized(@{})
        Initialize-SemWorkers -Size 2
    }
    AfterAll {
        Close-SemWorkers
        try { $script:FakeS3.Listener.Stop() } catch { }
        try { [void]$script:FakeS3.PS.BeginStop($null, $null) } catch { }
        foreach ($n in $script:SavedEnv.Keys) { [Environment]::SetEnvironmentVariable($n, $script:SavedEnv[$n]) }
    }
    It 'streams the object through the real seam, signed, and reaches the importer (the stub here)' {
        Mock Send-SemJson { $script:Started = $Object }
        Start-SemS3Import -Req @{ Json = ('{"bucket":"sim","key":"semaphore/work orders.csv"}' | ConvertFrom-Json) }
        $script:Started.state | Should -Be 'queued'
        $job = $script:Sem.S3Jobs[$script:Started.job]
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while (@('queued', 'running') -contains $job.state -and $clock.Elapsed.TotalSeconds -lt 60) { Start-Sleep -Milliseconds 100; Update-SemWorkers }
        $job.bytes | Should -Be $script:Body.Length -Because 'the whole object came through the stream'
        $job.totalBytes | Should -Be $script:Body.Length
        if ((Get-Command Import-SemLocalFile).Definition -match 'STUB') { $job.error | Should -Be 'The local database is not available yet' } else { $job.state | Should -Be 'done' }
        $heads = @($script:FakeS3.State.Heads)
        $heads.Count | Should -Be 2
        $heads[0] | Should -Match '^HEAD /sim/semaphore/work%20orders\.csv HTTP/1\.1'
        $heads[1] | Should -Match '(?m)^Authorization: AWS4-HMAC-SHA256 Credential=AKIDPOOLTEST/\d{8}/us-east-1/s3/aws4_request, SignedHeaders=host;if-match;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}'
        ($heads -join "`n") | Should -Not -Match 'POOLSECRETPOOLSECRET'
        [IO.Directory]::Exists((Join-Path $script:Sem.Home ('local\incoming\' + $script:Started.job))) | Should -BeFalse
    }
}
