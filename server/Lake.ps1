#requires -Version 5.1
# =============================================================================
# Semaphore's lake engine: the S3 data lake through Amazon Athena, with a cost guard and a result
# cache. It folds in the "Sounding Line" proposal (comms repo, proposals/sounding-line): the same
# engine serves the raw-SQL desk, and AWS sessions can be brokered through Lazarette (Vault.ps1).
#
# A lake source in <home>\sources.json:
#   { "id": "lake", "label": "Data lake", "kind": "aws-athena", "provider": "athena",
#     "region": "us-gov-west-1", "workgroup": "semaphore", "database": "maintenance",
#     "priceUsdPerTB": 5, "approveAboveGB": 10, "dailyLimitGB": 200, "cacheHours": 12 }
# Optional "endpoint" (http(s) base, e.g. a simulator on 127.0.0.1) replaces the AWS endpoints.
# AWS keys are never written in sources.json (refused). A "vault": { "item": "name" } block takes them from
# a Lazarette item (fields AccessKeyId, SecretAccessKey, SessionToken), so analysts hold no AWS keys; without
# one they come from the environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN), a short
# session the analyst or IT sets. Keys are never logged or returned.
#
# Cost guard, before a query runs:
#   * the table's location (Glue) and its size on S3 (ListObjectsV2) give an upper bound on the
#     bytes Athena can scan, and so the price (priceUsdPerTB);
#   * a partitioned table queried without a filter on a partition column is warned about;
#   * above approveAboveGB the query waits for the analyst's approval (409 lake-approval);
#   * past dailyLimitGB of this user's actual scans today it is refused (429 lake-daily-limit).
# Every run records the bytes Athena actually scanned in <home>\lake\usage\<date>-<user>.json.
# Results are cached in <home>\lake\cache for cacheHours: the same query is answered locally and
# free, marked "cached" with its time.
# =============================================================================

$script:SemLakeMaxListObjects = 50000
$script:SemLakeEmptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

# ---------------------------------------------------------------------------
# AWS Signature Version 4 (BCL only)
# ---------------------------------------------------------------------------
function Get-SemSha256Hex {
    param([byte[]]$Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return (-join ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') })) } finally { $sha.Dispose() }
}
function Get-SemHmac {
    param([byte[]]$Key, [string]$Data)
    $h = New-Object Security.Cryptography.HMACSHA256 (, $Key)
    try { return $h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Data)) } finally { $h.Dispose() }
}
function ConvertTo-SemUriEncoded {
    # RFC 3986 unreserved characters stay; everything else is %XX (upper case), as SigV4 requires.
    param([string]$Text, [switch]$KeepSlash)
    $sb = New-Object Text.StringBuilder
    foreach ($b in [Text.Encoding]::UTF8.GetBytes($Text)) {
        $c = [char]$b
        if (($b -ge 65 -and $b -le 90) -or ($b -ge 97 -and $b -le 122) -or ($b -ge 48 -and $b -le 57) -or $c -eq '-' -or $c -eq '_' -or $c -eq '.' -or $c -eq '~' -or ($KeepSlash -and $c -eq '/')) { [void]$sb.Append($c) }
        else { [void]$sb.Append('%').Append($b.ToString('X2')) }
    }
    return $sb.ToString()
}
function New-SemAwsSignature {
    <#
      Returns the headers to add (Authorization, X-Amz-Date, X-Amz-Content-Sha256 and, with a session
      token, X-Amz-Security-Token). $Headers are the request headers to sign (host included).
      $Query is a hashtable of query parameters. Pure: the clock and keys are parameters.
    #>
    param(
        [string]$Method, [string]$Path, [hashtable]$Query = @{}, [hashtable]$Headers, [byte[]]$Body = (New-Object byte[] 0),
        [string]$Service, [string]$Region, [string]$AccessKey, [string]$SecretKey, [string]$SessionToken = '', [datetime]$Now = [datetime]::UtcNow
    )
    $amzDate = $Now.ToString("yyyyMMdd'T'HHmmss'Z'", [Globalization.CultureInfo]::InvariantCulture)
    $day = $amzDate.Substring(0, 8)
    $payloadHash = if ($Body.Length) { Get-SemSha256Hex $Body } else { $script:SemLakeEmptySha }
    $all = @{}
    foreach ($k in $Headers.Keys) { $all[$k.ToLowerInvariant()] = ([string]$Headers[$k]).Trim() -replace '\s+', ' ' }
    $all['x-amz-date'] = $amzDate
    if ($Service -eq 's3') { $all['x-amz-content-sha256'] = $payloadHash }
    if ($SessionToken) { $all['x-amz-security-token'] = $SessionToken }
    $names = @($all.Keys | Sort-Object { $_ } -CaseSensitive)
    $canonicalHeaders = ($names | ForEach-Object { "$($_):$($all[$_])`n" }) -join ''
    $signedHeaders = $names -join ';'
    $q = @($Query.Keys | ForEach-Object { (ConvertTo-SemUriEncoded $_) + '=' + (ConvertTo-SemUriEncoded ([string]$Query[$_])) } | Sort-Object { $_ } -CaseSensitive) -join '&'
    $canonicalPath = if ($Service -eq 's3') { ConvertTo-SemUriEncoded $Path -KeepSlash } else { ConvertTo-SemUriEncoded (ConvertTo-SemUriEncoded $Path -KeepSlash) -KeepSlash }
    if (-not $canonicalPath) { $canonicalPath = '/' }
    $canonical = "$Method`n$canonicalPath`n$q`n$canonicalHeaders`n$signedHeaders`n$payloadHash"
    $scope = "$day/$Region/$Service/aws4_request"
    $toSign = "AWS4-HMAC-SHA256`n$amzDate`n$scope`n" + (Get-SemSha256Hex ([Text.Encoding]::UTF8.GetBytes($canonical)))
    $k = Get-SemHmac ([Text.Encoding]::UTF8.GetBytes('AWS4' + $SecretKey)) $day
    $k = Get-SemHmac $k $Region
    $k = Get-SemHmac $k $Service
    $k = Get-SemHmac $k 'aws4_request'
    $sig = -join ((Get-SemHmac $k $toSign) | ForEach-Object { $_.ToString('x2') })
    $out = @{ 'Authorization' = "AWS4-HMAC-SHA256 Credential=$AccessKey/$scope, SignedHeaders=$signedHeaders, Signature=$sig"; 'X-Amz-Date' = $amzDate }
    if ($Service -eq 's3') { $out['X-Amz-Content-Sha256'] = $payloadHash }
    if ($SessionToken) { $out['X-Amz-Security-Token'] = $SessionToken }
    return $out
}

# ---------------------------------------------------------------------------
# Sources and credentials
# ---------------------------------------------------------------------------
function Get-SemLakeSettings {
    # The lake fields of a source entry from sources.json (a PSCustomObject), checked. Throws a readable message.
    param($Raw)
    $region = [string]$Raw.region
    if ($region -cnotmatch '\A[a-z]{2}(-gov)?-[a-z]+-\d\z') { throw 'The lake source needs a region such as us-gov-west-1.' }
    $workgroup = [string]$Raw.workgroup; if (-not $workgroup) { $workgroup = 'primary' }
    if ($workgroup -cnotmatch '\A[A-Za-z0-9._-]{1,128}\z') { throw 'The lake source has an invalid workgroup name.' }
    $database = [string]$Raw.database
    if ($database -cnotmatch '\A[A-Za-z0-9_]{1,255}\z') { throw 'The lake source needs a Glue database name (letters, digits, _).' }
    $endpoint = [string]$Raw.endpoint
    if ($endpoint) {
        $u = $null
        if (-not [Uri]::TryCreate($endpoint, [UriKind]::Absolute, [ref]$u) -or ($u.Scheme -ne 'https' -and -not ($u.Scheme -eq 'http' -and $u.IsLoopback)) -or $u.UserInfo) { throw 'The lake endpoint must be https (or http on 127.0.0.1 for a simulator) without user info.' }
        $endpoint = $endpoint.TrimEnd('/')
    }
    foreach ($forbidden in @('accessKey', 'accessKeyId', 'secretKey', 'secretAccessKey', 'sessionToken', 'aws_access_key_id', 'aws_secret_access_key')) {
        if ($Raw.PSObject.Properties[$forbidden]) { throw 'AWS keys do not belong in sources.json. Remove them; Name a Lazarette item with a "vault" block, or set a short session in the environment.' }
    }
    $num = { param($v, $d, $min, $max) $x = 0.0; if ($null -ne $v -and [double]::TryParse([string]$v, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$x) -and $x -ge $min -and $x -le $max) { $x } else { $d } }
    return @{
        Region = $region; Workgroup = $workgroup; Database = $database; Catalog = 'AwsDataCatalog'; Endpoint = $endpoint
        PricePerTB = (& $num $Raw.priceUsdPerTB 5 0 1000); ApproveAboveGB = (& $num $Raw.approveAboveGB 10 0 1000000)
        DailyLimitGB = (& $num $Raw.dailyLimitGB 200 0 10000000); CacheHours = (& $num $Raw.cacheHours 12 0 720)
    }
}
function Get-SemAwsCredentials {
    # The Lazarette item's session when the request carries one (Vault.ps1), else the environment. Throws a readable message when there are none.
    $va = Get-SemVaultValue 'accessKeyId'; $vs = Get-SemVaultValue 'secretAccessKey'
    if ($va -and $vs) { return @{ AccessKey = $va; SecretKey = $vs; SessionToken = [string](Get-SemVaultValue 'sessionToken') } }
    $ak = [Environment]::GetEnvironmentVariable('AWS_ACCESS_KEY_ID'); $sk = [Environment]::GetEnvironmentVariable('AWS_SECRET_ACCESS_KEY')
    if (-not $ak -or -not $sk) { throw 'No AWS session: the lake needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (a short session) in the environment that started Semaphore, or a "vault" block naming a Lazarette item.' }
    return @{ AccessKey = $ak; SecretKey = $sk; SessionToken = [string][Environment]::GetEnvironmentVariable('AWS_SESSION_TOKEN') }
}
function Get-SemLakeSafeText {
    param([string]$Text)
    if (-not $Text) { return '' }
    foreach ($n in @('AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_ACCESS_KEY_ID')) {
        $v = [Environment]::GetEnvironmentVariable($n); if ($v) { $Text = $Text.Replace($v, '[redacted]') }
    }
    $Text = Get-SemVaultSafeText $Text
    $Text = [regex]::Replace($Text, '[\x00-\x1F\x7F]+', ' ').Trim()
    if ($Text.Length -gt 300) { $Text = $Text.Substring(0, 300) + '...' }
    return $Text
}

# ---------------------------------------------------------------------------
# Calls
# ---------------------------------------------------------------------------
function Invoke-SemAwsRequest {
    # One signed request. Returns @{ Status; Text }. Throws a readable, key-free message on network failures.
    param([hashtable]$Lake, [string]$Service, [string]$Method, [string]$Url, [hashtable]$Query = @{}, [hashtable]$Headers = @{}, [byte[]]$Body = (New-Object byte[] 0), [int]$TimeoutSec = 30)
    $cred = Get-SemAwsCredentials
    $u = [Uri]$Url
    $hostHeader = if ($u.IsDefaultPort) { $u.Host } else { "$($u.Host):$($u.Port)" }
    $sign = @{ host = $hostHeader }
    foreach ($k in $Headers.Keys) { $sign[$k] = $Headers[$k] }
    $sig = New-SemAwsSignature -Method $Method -Path $u.AbsolutePath -Query $Query -Headers $sign -Body $Body -Service $Service -Region $Lake.Region -AccessKey $cred.AccessKey -SecretKey $cred.SecretKey -SessionToken $cred.SessionToken
    $qs = @($Query.Keys | Sort-Object | ForEach-Object { (ConvertTo-SemUriEncoded $_) + '=' + (ConvertTo-SemUriEncoded ([string]$Query[$_])) }) -join '&'
    $req = [Net.HttpWebRequest]::Create($Url + $(if ($qs) { '?' + $qs } else { '' }))
    $req.Method = $Method; $req.Timeout = $TimeoutSec * 1000; $req.ReadWriteTimeout = $TimeoutSec * 1000
    $req.AllowAutoRedirect = $false; $req.UserAgent = 'Semaphore'
    foreach ($k in $Headers.Keys) { if ($k -ieq 'content-type') { $req.ContentType = $Headers[$k] } else { $req.Headers[$k] = $Headers[$k] } }
    foreach ($k in $sig.Keys) { $req.Headers[$k] = $sig[$k] }
    $resp = $null
    try {
        if ($Body.Length -or $Method -eq 'POST') { $req.ContentLength = $Body.Length; $s = $req.GetRequestStream(); try { $s.Write($Body, 0, $Body.Length) } finally { $s.Dispose() } }
        try { $resp = $req.GetResponse() } catch [Net.WebException] { if ($null -eq $_.Exception.Response) { throw }; $resp = $_.Exception.Response }
        $r = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
        try { $text = $r.ReadToEnd() } finally { $r.Dispose() }
        return @{ Status = [int]$resp.StatusCode; Text = $text }
    } catch [Net.WebException] {
        throw ('AWS could not be reached (' + $Service + '): ' + (Get-SemLakeSafeText $_.Exception.Message))
    } finally { if ($null -ne $resp) { try { $resp.Close() } catch { } } }
}
function Invoke-SemAwsJson {
    # Athena and Glue JSON 1.1 APIs: POST / with X-Amz-Target. Returns the parsed answer or throws AWS's message.
    param([hashtable]$Lake, [ValidateSet('athena', 'glue', 'redshift-data')][string]$Service, [string]$Target, [hashtable]$Payload, [int]$TimeoutSec = 30)
    $base = if ($Lake.Endpoint) { $Lake.Endpoint } else { "https://$Service.$($Lake.Region).amazonaws.com" }
    $body = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Payload -Depth 8 -Compress))
    $r = Invoke-SemAwsRequest -Lake $Lake -Service $Service -Method 'POST' -Url ($base + '/') -Headers @{ 'Content-Type' = 'application/x-amz-json-1.1'; 'X-Amz-Target' = $Target } -Body $body -TimeoutSec $TimeoutSec
    $j = $null
    try { $j = $r.Text | ConvertFrom-Json -ErrorAction Stop } catch { }
    if ($r.Status -ne 200) {
        $msg = ''
        if ($j) { $msg = [string](Get-SemJsonProp $j 'Message'); if (-not $msg) { $msg = [string](Get-SemJsonProp $j 'message') } }
        throw ("{0} answered {1}: {2}" -f $Target.Split('.')[-1], $r.Status, (Get-SemLakeSafeText $msg))
    }
    return $j
}
function Get-SemS3PrefixSize {
    # Bytes under s3://bucket/prefix (ListObjectsV2, paged, capped). Returns @{ Bytes; Objects; Capped }.
    param([hashtable]$Lake, [string]$Bucket, [string]$Prefix)
    $base = if ($Lake.Endpoint) { "$($Lake.Endpoint)/$Bucket" } else { "https://$Bucket.s3.$($Lake.Region).amazonaws.com" }
    $bytes = [long]0; $objects = 0; $token = $null
    do {
        $q = @{ 'list-type' = '2'; 'prefix' = $Prefix; 'max-keys' = '1000' }
        if ($token) { $q['continuation-token'] = $token }
        $r = Invoke-SemAwsRequest -Lake $Lake -Service 's3' -Method 'GET' -Url ($base + '/') -Query $q
        if ($r.Status -ne 200) { throw ('S3 answered ' + $r.Status + ' when sizing the table.') }
        $x = New-Object Xml.XmlDocument; $x.XmlResolver = $null; $x.LoadXml($r.Text)
        $ns = New-Object Xml.XmlNamespaceManager $x.NameTable; $ns.AddNamespace('s', $x.DocumentElement.NamespaceURI)
        $p = if ($x.DocumentElement.NamespaceURI) { 's:' } else { '' }
        foreach ($n in $x.SelectNodes("//${p}Contents/${p}Size", $ns)) { $bytes += [long]$n.InnerText; $objects++ }
        $trunc = $x.SelectSingleNode("//${p}IsTruncated", $ns)
        $next = $x.SelectSingleNode("//${p}NextContinuationToken", $ns)
        $token = if ($trunc -and $trunc.InnerText -eq 'true' -and $next) { $next.InnerText } else { $null }
    } while ($token -and $objects -lt $script:SemLakeMaxListObjects)
    return @{ Bytes = $bytes; Objects = $objects; Capped = [bool]$token }
}

# ---------------------------------------------------------------------------
# Cost guard
# ---------------------------------------------------------------------------
function Get-SemLakeTableNames {
    # Every table a query reads: after FROM or JOIN, "name", "db"."name" or name; subqueries are looked into.
    param([string]$Sql)
    $names = New-Object System.Collections.Generic.List[string]
    foreach ($m in [regex]::Matches($Sql, '(?is)\b(?:FROM|JOIN)\s+(?:"[^"]+"\.)?"([^"]+)"|\b(?:FROM|JOIN)\s+(?:[A-Za-z_][\w]*\.)?([A-Za-z_][\w]*)')) {
        $n = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
        if ($n -and -not $names.Contains($n)) { $names.Add($n) }
    }
    return $names.ToArray()
}
function Get-SemLakeEstimate {
    # @{ Bytes; Usd; Partitioned; PartitionFiltered; Warnings[]; Table } for a query, before it runs.
    param([hashtable]$Lake, [string]$Sql)
    # Joined tables and hand-written queries read several tables: each is sized and the sizes added.
    $tables = @(Get-SemLakeTableNames $Sql)
    if (-not $tables.Count) { throw 'Could not tell which lake table the query reads.' }
    if ($tables.Count -gt 10) { throw 'The query reads more than 10 lake tables; Semaphore estimates at most 10.' }
    $where = ''
    foreach ($w in [regex]::Matches($Sql, '(?is)\bWHERE\b(.*?)(\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|\)|\z)')) { $where += ' ' + $w.Groups[1].Value }
    $bytes = [long]0
    $partitioned = $false
    $filteredAll = $true
    $warnings = New-Object System.Collections.Generic.List[string]
    foreach ($table in $tables) {
        $t = Invoke-SemAwsJson -Lake $Lake -Service 'glue' -Target 'AWSGlue.GetTable' -Payload @{ DatabaseName = $Lake.Database; Name = $table }
        $tbl = Get-SemJsonProp $t 'Table'
        $loc = [string](Get-SemJsonProp (Get-SemJsonProp $tbl 'StorageDescriptor') 'Location')
        $m = [regex]::Match($loc, '\As3a?://([^/]+)/?(.*)\z')
        if (-not $m.Success) { throw "The lake table '$table' has no S3 location in Glue." }
        $size = Get-SemS3PrefixSize -Lake $Lake -Bucket $m.Groups[1].Value -Prefix $m.Groups[2].Value
        $bytes += $size.Bytes
        $keys = @(@(Get-SemJsonProp $tbl 'PartitionKeys') | ForEach-Object { [string](Get-SemJsonProp $_ 'Name') } | Where-Object { $_ })
        $filtered = $false
        foreach ($k in $keys) { if ($where -match ('(?i)"?' + [regex]::Escape($k) + '"?\s*(=|>|<|IN\b|BETWEEN\b)')) { $filtered = $true } }
        if ($keys.Count) { $partitioned = $true; if (-not $filtered) { $filteredAll = $false } }
        if ($keys.Count -and -not $filtered) { $warnings.Add(("'{0}' is partitioned by {1} and this query does not filter on it, so Athena reads all of it." -f $table, ($keys -join ', '))) }
        if ($size.Capped) { $warnings.Add(("'{0}' has more files than were counted; the estimate is low." -f $table)) }
    }
    $usd = [Math]::Round(($bytes / 1099511627776.0) * $Lake.PricePerTB, 4)
    return @{ Table = ($tables -join ', '); Bytes = $bytes; Usd = $usd; Partitioned = $partitioned; PartitionFiltered = ($partitioned -and $filteredAll); Warnings = $warnings.ToArray() }
}
function Get-SemLakeUsagePath {
    param([string]$HomeDir, [datetime]$Now = (Get-Date))
    $user = ([string]$env:USERNAME).ToLowerInvariant() -replace '[^a-z0-9_-]', '_'
    return [IO.Path]::Combine($HomeDir, 'lake', 'usage', ($Now.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) + '-' + $user + '.json'))
}
function Get-SemLakeUsedBytes {
    param([string]$HomeDir, [datetime]$Now = (Get-Date))
    $f = Get-SemLakeUsagePath -HomeDir $HomeDir -Now $Now
    if (-not [IO.File]::Exists($f)) { return [long]0 }
    try { return [long]((([IO.File]::ReadAllText($f)) | ConvertFrom-Json).bytes) } catch { return [long]0 }
}
function Add-SemLakeUsage {
    param([string]$HomeDir, [long]$Bytes, [datetime]$Now = (Get-Date))
    $f = Get-SemLakeUsagePath -HomeDir $HomeDir -Now $Now
    $dir = [IO.Path]::GetDirectoryName($f); if (-not [IO.Directory]::Exists($dir)) { [void][IO.Directory]::CreateDirectory($dir) }
    $total = (Get-SemLakeUsedBytes -HomeDir $HomeDir -Now $Now) + $Bytes
    [IO.File]::WriteAllText($f, ('{"version":1,"bytes":' + $total + '}'), (New-Object Text.UTF8Encoding $false))
    return $total
}

# ---------------------------------------------------------------------------
# Result cache
# ---------------------------------------------------------------------------
function Get-SemLakeCacheKey {
    param([string]$SourceId, [string]$Sql, [object[]]$Params)
    $p = @($Params | ForEach-Object { $_.Type + ':' + (Format-SemLakeLiteral $_) }) -join [string][char]1
    return Get-SemSha256Hex ([Text.Encoding]::UTF8.GetBytes("$SourceId`n$Sql`n$p"))
}
function Read-SemLakeCache {
    # The cached response JSON with "cached" and "asOf" added, or $null when absent or too old.
    param([string]$HomeDir, [string]$Key, [double]$Hours)
    if ($Hours -le 0) { return $null }
    $f = [IO.Path]::Combine($HomeDir, 'lake', 'cache', "$Key.json")
    if (-not [IO.File]::Exists($f)) { return $null }
    $at = [IO.File]::GetLastWriteTimeUtc($f)
    if (([datetime]::UtcNow - $at).TotalHours -gt $Hours) { return $null }
    $json = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8)
    if (-not $json.EndsWith('}')) { return $null }
    return $json.Substring(0, $json.Length - 1) + ',"cached":true,"asOf":"' + $at.ToString('yyyy-MM-ddTHH:mm:ssZ', [Globalization.CultureInfo]::InvariantCulture) + '"}'
}
function Save-SemLakeCache {
    param([string]$HomeDir, [string]$Key, [string]$Json)
    $dir = [IO.Path]::Combine($HomeDir, 'lake', 'cache'); if (-not [IO.Directory]::Exists($dir)) { [void][IO.Directory]::CreateDirectory($dir) }
    $tmp = [IO.Path]::Combine($dir, "$Key.tmp"); $f = [IO.Path]::Combine($dir, "$Key.json")
    [IO.File]::WriteAllText($tmp, $Json, (New-Object Text.UTF8Encoding $false))
    if ([IO.File]::Exists($f)) { [IO.File]::Delete($f) }
    [IO.File]::Move($tmp, $f)
}

# ---------------------------------------------------------------------------
# Running a query
# ---------------------------------------------------------------------------
function Format-SemLakeLiteral {
    # A typed parameter as an Athena SQL literal (ExecutionParameters are literals, not raw values).
    param([hashtable]$Typed)
    $v = $Typed.Value
    if ($v -is [DBNull] -or $null -eq $v) { return 'NULL' }
    $inv = [Globalization.CultureInfo]::InvariantCulture
    switch ($Typed.Type) {
        'number' { return ([double]$v).ToString('R', $inv) }
        'boolean' { if ([bool]$v) { return 'true' } else { return 'false' } }
        'date' { $d = [datetime]$v; if ($d.TimeOfDay -eq [TimeSpan]::Zero) { return "DATE '" + $d.ToString('yyyy-MM-dd', $inv) + "'" } else { return "TIMESTAMP '" + $d.ToString('yyyy-MM-dd HH:mm:ss', $inv) + "'" } }
        default { return "'" + ([string]$v).Replace("'", "''") + "'" }
    }
}
function ConvertFrom-SemAthenaValue {
    param([string]$Text, [string]$Type)
    if ($null -eq $Text) { return 'null' }
    $inv = [Globalization.CultureInfo]::InvariantCulture
    switch -Regex ($Type) {
        '^(tinyint|smallint|integer|int|bigint|double|float|real|decimal)' { $x = 0.0; if ([double]::TryParse($Text, [Globalization.NumberStyles]::Float, $inv, [ref]$x)) { return $x.ToString('R', $inv) } else { return 'null' } }
        '^boolean' { if ($Text -eq 'true') { return 'true' } elseif ($Text -eq 'false') { return 'false' } else { return 'null' } }
        '^(date|timestamp)' { return (ConvertTo-SemJsonString ($Text.Replace(' ', 'T') -replace '\.\d+$', '')) }
        default { return (ConvertTo-SemJsonString $Text) }
    }
}
function Invoke-SemLakeQuery {
    # Runs $Plan (Source, Sql, Params, RowCap, TimeoutSec) on Athena and returns the response JSON, in the
    # same shape as the database providers, plus "scannedBytes".
    param([hashtable]$Lake, [hashtable]$Plan, [Diagnostics.Stopwatch]$Clock = ([Diagnostics.Stopwatch]::StartNew()), [int]$PollMs = 500)
    $payload = @{
        QueryString = $Plan.Sql; WorkGroup = $Lake.Workgroup
        QueryExecutionContext = @{ Database = $Lake.Database; Catalog = $Lake.Catalog }
        ClientRequestToken = [guid]::NewGuid().ToString()
    }
    if ($Plan.Params.Count) { $payload.ExecutionParameters = @($Plan.Params | ForEach-Object { Format-SemLakeLiteral $_ }) }
    $start = Invoke-SemAwsJson -Lake $Lake -Service 'athena' -Target 'AmazonAthena.StartQueryExecution' -Payload $payload
    $id = [string](Get-SemJsonProp $start 'QueryExecutionId')
    if ($id -cnotmatch '\A[A-Za-z0-9-]{1,128}\z') { throw 'Athena did not return a query id.' }
    $state = ''; $exec = $null
    while ($true) {
        $exec = Get-SemJsonProp (Invoke-SemAwsJson -Lake $Lake -Service 'athena' -Target 'AmazonAthena.GetQueryExecution' -Payload @{ QueryExecutionId = $id }) 'QueryExecution'
        $state = [string](Get-SemJsonProp (Get-SemJsonProp $exec 'Status') 'State')
        if (@('SUCCEEDED', 'FAILED', 'CANCELLED') -contains $state) { break }
        if ($Clock.Elapsed.TotalSeconds -gt $Plan.TimeoutSec) {
            try { [void](Invoke-SemAwsJson -Lake $Lake -Service 'athena' -Target 'AmazonAthena.StopQueryExecution' -Payload @{ QueryExecutionId = $id }) } catch { }
            throw "Athena did not finish within $($Plan.TimeoutSec) s; the query was stopped."
        }
        Start-Sleep -Milliseconds $PollMs
    }
    $scanned = [long](Get-SemJsonProp (Get-SemJsonProp $exec 'Statistics') 'DataScannedInBytes')
    if ($state -ne 'SUCCEEDED') { throw ('Athena ' + $state.ToLowerInvariant() + ' the query: ' + (Get-SemLakeSafeText ([string](Get-SemJsonProp (Get-SemJsonProp $exec 'Status') 'StateChangeReason')))) }
    $sb = New-Object Text.StringBuilder 65536
    [void]$sb.Append('{"columns":[')
    $names = $null; $types = $null; $count = 0; $truncated = $false; $token = $null; $first = $true
    do {
        $p = @{ QueryExecutionId = $id; MaxResults = 1000 }; if ($token) { $p.NextToken = $token }
        $res = Invoke-SemAwsJson -Lake $Lake -Service 'athena' -Target 'AmazonAthena.GetQueryResults' -Payload $p -TimeoutSec 60
        $set = Get-SemJsonProp $res 'ResultSet'
        if ($null -eq $names) {
            $info = @(Get-SemJsonProp (Get-SemJsonProp $set 'ResultSetMetadata') 'ColumnInfo')
            $names = @($info | ForEach-Object { [string](Get-SemJsonProp $_ 'Name') })
            $types = @($info | ForEach-Object { ([string](Get-SemJsonProp $_ 'Type')).ToLowerInvariant() })
            [void]$sb.Append((@($names | ForEach-Object { ConvertTo-SemJsonString $_ }) -join ',')).Append('],"rows":[')
        }
        $rows = @(Get-SemJsonProp $set 'Rows')
        for ($r = 0; $r -lt $rows.Count; $r++) {
            if ($first) { $first = $false; continue }   # the first row of the first page is the header
            if ($count -ge $Plan.RowCap) { $truncated = $true; break }
            $data = @(Get-SemJsonProp $rows[$r] 'Data')
            if ($count -gt 0) { [void]$sb.Append(',') }
            [void]$sb.Append('{')
            for ($c = 0; $c -lt $names.Count; $c++) {
                if ($c -gt 0) { [void]$sb.Append(',') }
                $cell = if ($c -lt $data.Count) { Get-SemJsonProp $data[$c] 'VarCharValue' } else { $null }
                [void]$sb.Append((ConvertTo-SemJsonString $names[$c])).Append(':').Append((ConvertFrom-SemAthenaValue $cell $types[$c]))
            }
            [void]$sb.Append('}')
            $count++
        }
        $token = [string](Get-SemJsonProp $res 'NextToken')
    } while ($token -and -not $truncated)
    if ($null -eq $names) { [void]$sb.Append('],"rows":[') }
    [void]$sb.Append('],"truncated":').Append($(if ($truncated) { 'true' } else { 'false' }))
    [void]$sb.Append(',"scannedBytes":').Append([string]$scanned).Append(',"ms":').Append([string][long]$Clock.ElapsedMilliseconds).Append('}')
    return @{ Json = $sb.ToString(); Scanned = $scanned }
}

function Invoke-SemLakeRequest {
    # /api/query for a lake source: cache, cost guard, run, record usage. Sends the response.
    param($Req, [hashtable]$Plan, [string]$HomeDir)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try { $lake = Get-SemLakeSettings $Plan.Source.raw } catch { Send-SemError 400 'lake-config' $_.Exception.Message; return }
    $key = Get-SemLakeCacheKey -SourceId $Plan.Source.id -Sql $Plan.Sql -Params $Plan.Params
    $refresh = (Get-SemJsonProp $Req.Json 'refresh') -eq $true
    if (-not $refresh) {
        $hit = Read-SemLakeCache -HomeDir $HomeDir -Key $key -Hours $lake.CacheHours
        if ($hit) { Write-SemLog 'INFO' ("Lake query on '{0}': from cache" -f $Plan.Source.id); Send-SemJsonText 200 $hit; return }
    }
    try { [void](Get-SemAwsCredentials) } catch { Send-SemError 401 'lake-no-session' $_.Exception.Message; return }
    try { $est = Get-SemLakeEstimate -Lake $lake -Sql $Plan.Sql }
    catch { Send-SemError 502 'lake-estimate' (Get-SemLakeSafeText $_.Exception.Message); return }
    $estimate = [ordered]@{ table = $est.Table; bytes = $est.Bytes; usd = $est.Usd; partitioned = $est.Partitioned; partitionFiltered = $est.PartitionFiltered; warnings = @($est.Warnings) }
    $used = Get-SemLakeUsedBytes -HomeDir $HomeDir
    $limit = [long]($lake.DailyLimitGB * 1073741824)
    if ($used + $est.Bytes -gt $limit) {
        Send-SemJson 429 ([ordered]@{ error = ("This would pass your daily lake limit of {0:N0} GB ({1:N1} GB used today)." -f $lake.DailyLimitGB, ($used / 1073741824)); code = 'lake-daily-limit'; estimate = $estimate }); return
    }
    $approved = (Get-SemJsonProp $Req.Json 'approve') -eq $true
    if (-not $approved -and $est.Bytes -gt [long]($lake.ApproveAboveGB * 1073741824)) {
        Send-SemJson 409 ([ordered]@{ error = ("This query could scan up to {0:N1} GB (about `${1:N2}). Run it?" -f ($est.Bytes / 1073741824), $est.Usd); code = 'lake-approval'; estimate = $estimate }); return
    }
    try {
        $r = Invoke-SemLakeQuery -Lake $lake -Plan $Plan -Clock $clock
        $total = Add-SemLakeUsage -HomeDir $HomeDir -Bytes $r.Scanned
        Save-SemLakeCache -HomeDir $HomeDir -Key $key -Json $r.Json
        Write-SemLog 'INFO' ("Lake query on '{0}': {1} bytes scanned, {2} ms; {3} bytes today" -f $Plan.Source.id, $r.Scanned, $clock.ElapsedMilliseconds, $total)
        Send-SemJsonText 200 ($r.Json.Substring(0, $r.Json.Length - 1) + ',"estimate":' + (ConvertTo-SemJson $estimate) + '}')
    } catch {
        Write-SemLog 'WARN' ("Lake query on '{0}' failed" -f $Plan.Source.id)
        Send-SemError 502 'lake-query' (Get-SemLakeSafeText $_.Exception.Message)
    }
}

function Get-SemLakeProfile {
    # /api/profile for a lake source, from the Glue catalog only (no scan, no cost).
    param([hashtable]$Lake, [string]$Table)
    $map = { param($t) $t = $t.ToLowerInvariant(); if ($t -match '^(tinyint|smallint|int|integer|bigint|double|float|real|decimal)') { 'number' } elseif ($t -match '^(date|timestamp)') { 'date' } elseif ($t -eq 'boolean') { 'boolean' } else { 'string' } }
    if (-not $Table) {
        $r = Invoke-SemAwsJson -Lake $Lake -Service 'glue' -Target 'AWSGlue.GetTables' -Payload @{ DatabaseName = $Lake.Database; MaxResults = 100 }
        return [ordered]@{ tables = @(@(Get-SemJsonProp $r 'TableList') | ForEach-Object { [string](Get-SemJsonProp $_ 'Name') } | Where-Object { $_ }) }
    }
    $t = Get-SemJsonProp (Invoke-SemAwsJson -Lake $Lake -Service 'glue' -Target 'AWSGlue.GetTable' -Payload @{ DatabaseName = $Lake.Database; Name = $Table }) 'Table'
    $cols = @(@(Get-SemJsonProp (Get-SemJsonProp $t 'StorageDescriptor') 'Columns') + @(Get-SemJsonProp $t 'PartitionKeys'))
    $out = @($cols | Where-Object { $_ } | ForEach-Object { [ordered]@{ name = [string](Get-SemJsonProp $_ 'Name'); type = (& $map ([string](Get-SemJsonProp $_ 'Type'))); distinct = $null; samples = @() } })
    return [ordered]@{ table = $Table; rows = $null; columns = $out; note = 'From the Glue catalog: no data was scanned.' }
}
