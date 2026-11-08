#requires -Version 5.1
# =============================================================================
# Amazon S3: browse allowlisted buckets and import objects into the local database. BCL only (SigV4 in Lake.ps1,
# the HTTP seam and endpoints in Aws.ps1).
#
# config\settings.json (or settings.local.json):
#   "s3":  { "buckets": [ { "bucket": "maint-exports", "region": "us-gov-west-1", "prefix": "semaphore/" },
#                         { "bucket": "lab-data", "region": "us-east-1", "endpoint": "https://bucket.vpce-0abc.s3.us-east-1.vpce.amazonaws.com" } ],
#            "maxObjectMb": 20480 },
#   "aws": { "fips": false, "vault": { "accessKeyId": "AWS_ACCESS_KEY_ID", "secretAccessKey": "AWS_SECRET_ACCESS_KEY", "sessionToken": "AWS_SESSION_TOKEN" } }
# Only the listed buckets, and inside them only keys under the listed prefix, can be listed or read: anything else is
# refused with a sentence before AWS is asked. "aws.vault" names the Lazarette shares of the AWS session (as a lake
# source does); without it the session comes from the environment. "aws.fips" uses the FIPS endpoints. Keys are never
# logged or returned.
#
# Routes (browser only, session checked by Http.ps1):
#   GET  /api/s3/buckets                         the allowlist (main loop, no AWS call)
#   GET  /api/s3/list?bucket=&prefix=&token=     ListObjectsV2 with delimiter "/" and continuation tokens (worker)
#   POST /api/s3/import { bucket, key | keys | prefix, table?, sheet?, replace? }   starts an import job (202 + job id)
#   GET  /api/s3/import-status/<job>             the job's progress and result (main loop)
#   GET  /api/rds/discover?region=               "Find RDS databases" (worker; Aws.ps1)
# An import streams each GetObject to a file under <home>\local\incoming\<job> (never the whole object in memory),
# checks its size, expands .gz, joins the parts of a partitioned prefix (CSV/TSV with the same header, JSON lines) and
# hands the file to Import-SemLocalFile (the local database, feat/local-db). The folder is removed afterwards.
# =============================================================================

$script:SemS3DefaultMaxObjectMb = 20480
$script:SemS3MaxPrefixObjects = 2000
$script:SemS3DataExtensions = @('csv', 'tsv', 'txt', 'json', 'jsonl', 'ndjson', 'parquet', 'xlsx', 'xls')
$script:SemS3HeaderJoin = @('csv', 'tsv', 'txt')
$script:SemS3LineJoin = @('jsonl', 'ndjson')
$script:SemS3BucketRx = '\A[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\z'
$script:SemS3JobDeadlineSec = 43200
$script:SemS3MaxJobs = 20

# ---------------------------------------------------------------------------
# The local database importer (feat/local-db). STUB until that branch lands: the real Import-SemLocalFile,
# when it is loaded, is used instead. Contract:
#   Import-SemLocalFile -HomeDir <string> -Path <string> [-Table <string>] [-Sheet <string>] [-SourceLabel <string>] [-Replace]
#   returns @{ Table; Rows; Columns; Ms }
# ---------------------------------------------------------------------------
if (-not (Get-Command Import-SemLocalFile -CommandType Function -ErrorAction SilentlyContinue)) {
    function Import-SemLocalFile {
        # STUB (S3.ps1): replaced by the local database's own Import-SemLocalFile from feat/local-db.
        param([string]$HomeDir, [string]$Path, [string]$Table, [string]$Sheet, [string]$SourceLabel, [switch]$Replace)
        throw 'The local database is not available yet'
    }
}

# ---------------------------------------------------------------------------
# Settings and the allowlist
# ---------------------------------------------------------------------------
function Get-SemS3Config {
    # The checked S3 settings from @{ S3 = <settings.s3>; Aws = <settings.aws> } (raw JSON objects, either may be $null):
    # @{ Buckets = @(@{ Bucket; Region; Prefix; Endpoint; Fips; Label }); MaxObjectBytes; Fips; Vault; Problems }.
    param($Settings)
    $s3 = $null; $aws = $null
    if ($null -ne $Settings) { $s3 = $Settings.S3; $aws = $Settings.Aws }
    $problems = New-Object System.Collections.Generic.List[string]
    $fips = [bool](Get-SemJsonProp $aws 'fips')
    $vault = Get-SemJsonProp $aws 'vault'
    $maxMb = $script:SemS3DefaultMaxObjectMb
    $rawMax = Get-SemJsonProp $s3 'maxObjectMb'
    if ($null -ne $rawMax) {
        $n = 0.0
        if ([double]::TryParse([string]$rawMax, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$n) -and $n -ge 1 -and $n -le 1048576) { $maxMb = $n }
        else { $problems.Add('s3.maxObjectMb must be a number of MB from 1 to 1048576; using 20480.') }
    }
    $buckets = New-Object System.Collections.Generic.List[object]
    foreach ($b in @(Get-SemJsonProp $s3 'buckets')) {
        if ($null -eq $b) { continue }
        if ($b -isnot [Management.Automation.PSCustomObject]) { $problems.Add('Each entry of s3.buckets must be an object with bucket and region.'); continue }
        $name = [string](Get-SemJsonProp $b 'bucket')
        if ($name -cnotmatch $script:SemS3BucketRx -or $name -match '\.\.') { $problems.Add('s3.buckets: "' + (ConvertTo-SemLogText $name 70) + '" is not a bucket name.'); continue }
        $region = [string](Get-SemJsonProp $b 'region')
        if (-not (Test-SemAwsRegion $region)) { $problems.Add("s3.buckets: $name needs a region such as us-gov-west-1."); continue }
        $prefix = [string](Get-SemJsonProp $b 'prefix')
        if ($prefix -match '[\x00-\x1F\x7F]' -or $prefix.Length -gt 512) { $problems.Add("s3.buckets: the prefix of $name is not valid."); continue }
        $prefix = $prefix.TrimStart('/')
        if ($prefix -and -not $prefix.EndsWith('/')) { $prefix += '/' }   # "sales" must not open "sales-archive/"
        $endpoint = [string](Get-SemJsonProp $b 'endpoint')
        if ($endpoint) {
            if (-not (Test-SemHttpsBase $endpoint)) { $problems.Add("s3.buckets: the endpoint of $name must be https (or http on 127.0.0.1 for a simulator)."); continue }
            $endpoint = $endpoint.TrimEnd('/')
        }
        $bf = $fips
        if ($null -ne (Get-SemJsonProp $b 'fips')) { $bf = [bool](Get-SemJsonProp $b 'fips') }
        $label = [string](Get-SemJsonProp $b 'label'); if (-not $label) { $label = $name }
        $buckets.Add(@{ Bucket = $name; Region = $region; Prefix = $prefix; Endpoint = $endpoint; Fips = $bf; Label = (ConvertTo-SemLogText $label 80) })
    }
    return @{ Buckets = $buckets.ToArray(); MaxObjectBytes = [long]($maxMb * 1MB); MaxObjectMb = $maxMb; Fips = $fips; Vault = $vault; Problems = $problems.ToArray() }
}

function Test-SemS3Key {
    # $true for a key or prefix S3 can name and Semaphore will pass on: 1..1024 characters, no control characters.
    param([string]$Key, [switch]$AllowEmpty)
    if (-not $Key) { return [bool]$AllowEmpty }
    return ($Key.Length -le 1024 -and $Key -notmatch '[\x00-\x1F\x7F]')
}

function Find-SemS3Entry {
    # The allowlist entry that lets $Bucket/$Key be read: @{ Entry } or @{ Error = @{ Status; Code; Message } }.
    param([hashtable]$Config, [string]$Bucket, [string]$Key)
    $known = @($Config.Buckets | Where-Object { $_.Bucket -ceq $Bucket })
    if ($known.Count -eq 0) {
        if ($Config.Buckets.Count -eq 0) { return @{ Error = @{ Status = 403; Code = 's3-not-allowed'; Message = 'No S3 buckets are set up: an administrator lists them under "s3": { "buckets": [...] } in config\settings.json.' } } }
        return @{ Error = @{ Status = 403; Code = 's3-not-allowed'; Message = ('The bucket "' + (ConvertTo-SemLogText $Bucket 70) + '" is not one Semaphore may read. Only the buckets in config\settings.json (s3.buckets) can be browsed or imported.') } }
    }
    foreach ($e in $known) { if ($Key.StartsWith($e.Prefix, [StringComparison]::Ordinal)) { return @{ Entry = $e } } }
    $allowed = (@($known | ForEach-Object { 's3://' + $_.Bucket + '/' + $_.Prefix }) -join ', ')
    return @{ Error = @{ Status = 403; Code = 's3-not-allowed'; Message = ('That is outside what Semaphore may read in ' + $Bucket + ': only ' + $allowed + ' is allowed.') } }
}

function Get-SemS3Location {
    # Where a bucket answers: @{ Origin (scheme://host[:port]); PathPrefix ('' or '/bucket') }. Virtual-hosted style, or
    # path style for bucket names with dots (the wildcard certificate covers one label) and for a configured endpoint.
    param([hashtable]$Entry)
    if ($Entry.Endpoint) {
        $u = [Uri]$Entry.Endpoint
        return @{ Origin = $u.GetLeftPart([UriPartial]::Authority); PathPrefix = ($u.AbsolutePath.TrimEnd('/') + '/' + $Entry.Bucket) }
    }
    $s3Host = Get-SemAwsServiceHost -Service 's3' -Region $Entry.Region -Fips ([bool]$Entry.Fips)
    if ($Entry.Bucket.Contains('.')) { return @{ Origin = 'https://' + $s3Host; PathPrefix = '/' + $Entry.Bucket } }
    return @{ Origin = 'https://' + $Entry.Bucket + '.' + $s3Host; PathPrefix = '' }
}

function Get-SemS3DataKind {
    # @{ Ext; Gzip } for a key: the data extension (after a .gz), lower case, or Ext = '' when it is not a data file.
    param([string]$Key)
    $name = $Key.Substring($Key.LastIndexOf('/') + 1).ToLowerInvariant()
    $gz = $false
    if ($name.EndsWith('.gz')) { $gz = $true; $name = $name.Substring(0, $name.Length - 3) }
    $dot = $name.LastIndexOf('.')
    $ext = if ($dot -ge 0) { $name.Substring($dot + 1) } else { '' }
    if ($script:SemS3DataExtensions -notcontains $ext) { $ext = '' }
    return @{ Ext = $ext; Gzip = $gz }
}

function ConvertTo-SemTableName {
    # A local table name from a key or prefix: the last name, extensions dropped, [a-z0-9_] only.
    param([string]$Text)
    $t = $Text.TrimEnd('/')
    $t = $t.Substring($t.LastIndexOf('/') + 1)
    if ($t.ToLowerInvariant().EndsWith('.gz')) { $t = $t.Substring(0, $t.Length - 3) }
    $dot = $t.LastIndexOf('.'); if ($dot -gt 0) { $t = $t.Substring(0, $dot) }
    $t = (($t.ToLowerInvariant() -replace '[^a-z0-9_]', '_') -replace '_+', '_').Trim('_')
    if (-not $t) { $t = 's3_import' }
    if ($t -match '\A\d') { $t = 't_' + $t }
    if ($t.Length -gt 63) { $t = $t.Substring(0, 63) }
    return $t
}

# ---------------------------------------------------------------------------
# Listing (ListObjectsV2)
# ---------------------------------------------------------------------------
function ConvertFrom-SemS3ListXml {
    # One ListObjectsV2 answer: @{ Folders = @(@{ prefix; name }); Objects = @(@{ key; name; size; lastModified; etag }); NextToken; Truncated }.
    # Pure (tests use fixtures). The folder marker object (the key equal to the prefix) is left out.
    param([string]$Text, [string]$Prefix = '')
    $x = New-SemXmlDocument $Text
    $folders = New-Object System.Collections.Generic.List[object]
    $objects = New-Object System.Collections.Generic.List[object]
    foreach ($n in $x.SelectNodes("/*[local-name()='ListBucketResult']/*[local-name()='CommonPrefixes']/*[local-name()='Prefix']")) {
        $p = [string]$n.InnerText
        $folders.Add([ordered]@{ prefix = $p; name = $p.Substring([Math]::Min($Prefix.Length, $p.Length)).TrimEnd('/') })
    }
    foreach ($c in $x.SelectNodes("/*[local-name()='ListBucketResult']/*[local-name()='Contents']")) {
        $k = $c.SelectSingleNode("*[local-name()='Key']"); if (-not $k) { continue }
        $key = [string]$k.InnerText
        if ($key -ceq $Prefix -or $key.EndsWith('/')) { continue }
        $size = [long]0; $sz = $c.SelectSingleNode("*[local-name()='Size']"); if ($sz) { [void][long]::TryParse($sz.InnerText, [ref]$size) }
        $lm = $c.SelectSingleNode("*[local-name()='LastModified']"); $et = $c.SelectSingleNode("*[local-name()='ETag']")
        $objects.Add([ordered]@{
            key = $key; name = $key.Substring([Math]::Min($Prefix.Length, $key.Length)); size = $size
            lastModified = $(if ($lm) { [string]$lm.InnerText } else { '' }); etag = $(if ($et) { ([string]$et.InnerText).Trim('"') } else { '' })
        })
    }
    $trunc = $x.SelectSingleNode("//*[local-name()='IsTruncated']"); $next = $x.SelectSingleNode("//*[local-name()='NextContinuationToken']")
    $truncated = [bool]($trunc -and $trunc.InnerText -eq 'true')
    return @{ Folders = $folders.ToArray(); Objects = $objects.ToArray(); Truncated = $truncated; NextToken = $(if ($truncated -and $next) { [string]$next.InnerText } else { $null }) }
}

function Invoke-SemS3Text {
    # A small signed S3 call: @{ Status; Text; Headers }.
    param([hashtable]$Entry, [string]$Method = 'GET', [string]$Key = '', [hashtable]$Query = @{}, [hashtable]$Headers = @{})
    $loc = Get-SemS3Location $Entry
    $r = Open-SemAwsResponse -Region $Entry.Region -Service 's3' -Method $Method -Origin $loc.Origin -Path ($loc.PathPrefix + '/' + $Key) -Query $Query -Headers $Headers -TimeoutSec 30
    $status = $r.Status; $h = $r.Headers
    $text = Read-SemAwsResponseText $r
    return @{ Status = $status; Text = $text; Headers = $h }
}

function Get-SemS3ErrorText {
    param([string]$What, [hashtable]$Answer)
    $why = Get-SemAwsXmlError $Answer.Text
    if (-not $why) { $why = 'no detail' }
    $hint = ''
    if ($Answer.Status -eq 403) { $hint = ' The AWS session needs s3:ListBucket on the bucket and s3:GetObject on its objects.' }
    if ($Answer.Status -eq 301 -or $Answer.Status -eq 307) { $hint = ' The bucket is in another region than settings.json says.' }
    return ('S3 answered {0} when {1}: {2}.{3}' -f $Answer.Status, $What, $why, $hint)
}

function Invoke-SemS3ListPage {
    # One page of ListObjectsV2 under $Prefix. Delimiter "/" gives folders; '' lists every key below.
    param([hashtable]$Entry, [string]$Prefix = '', [string]$Token = '', [string]$Delimiter = '/', [int]$MaxKeys = 1000)
    $q = @{ 'list-type' = '2'; 'max-keys' = [string]$MaxKeys }
    if ($Prefix) { $q['prefix'] = $Prefix }
    if ($Delimiter) { $q['delimiter'] = $Delimiter }
    if ($Token) { $q['continuation-token'] = $Token }
    $a = Invoke-SemS3Text -Entry $Entry -Method 'GET' -Query $q
    if ($a.Status -ne 200) { throw (Get-SemS3ErrorText -What ('listing s3://' + $Entry.Bucket + '/' + $Prefix) -Answer $a) }
    return (ConvertFrom-SemS3ListXml -Text $a.Text -Prefix $Prefix)
}

function Get-SemS3PrefixObjects {
    # Every data object under a prefix (recursive), for a partitioned dataset: folder markers, empty objects and
    # bookkeeping files (_SUCCESS, .crc, names starting _ or .) are left out. Refuses more than $Cap objects.
    param([hashtable]$Entry, [string]$Prefix, [int]$Cap = $script:SemS3MaxPrefixObjects)
    $out = New-Object System.Collections.Generic.List[object]
    $token = $null; $pages = 0
    do {
        $page = Invoke-SemS3ListPage -Entry $Entry -Prefix $Prefix -Token $token -Delimiter '' -MaxKeys 1000
        foreach ($o in $page.Objects) {
            $name = $o.key.Substring($o.key.LastIndexOf('/') + 1)
            if ($o.size -le 0 -or $name.StartsWith('_') -or $name.StartsWith('.')) { continue }
            if (-not (Get-SemS3DataKind $o.key).Ext) { continue }
            $out.Add($o)
            if ($out.Count -gt $Cap) { throw ('s3://' + $Entry.Bucket + '/' + $Prefix + ' holds more than ' + $Cap + ' data objects. Import a narrower prefix (one partition folder).') }
        }
        $token = $page.NextToken; $pages++
    } while ($token -and $pages -lt 100)
    if ($out.Count -eq 0) { throw ('s3://' + $Entry.Bucket + '/' + $Prefix + ' holds no data files (CSV, TSV, JSON lines, Parquet or Excel, optionally .gz).') }
    return $out.ToArray()
}

function Get-SemS3ObjectHead {
    # @{ key; size; etag; lastModified } from HeadObject.
    param([hashtable]$Entry, [string]$Key)
    $a = Invoke-SemS3Text -Entry $Entry -Method 'HEAD' -Key $Key
    if ($a.Status -eq 404) { throw ('s3://' + $Entry.Bucket + '/' + $Key + ' does not exist (or the session may not read it).') }
    if ($a.Status -ne 200) { throw (Get-SemS3ErrorText -What ('reading s3://' + $Entry.Bucket + '/' + $Key) -Answer $a) }
    $size = [long]-1; [void][long]::TryParse([string]$a.Headers['content-length'], [ref]$size)
    return [ordered]@{ key = $Key; size = $size; etag = ([string]$a.Headers['etag']).Trim('"'); lastModified = [string]$a.Headers['last-modified'] }
}

# ---------------------------------------------------------------------------
# Downloading (streamed to a file)
# ---------------------------------------------------------------------------
function Save-SemS3Object {
    <#
      Streams GetObject to $OutFile (created new) in 1 MB pieces, never holding the object in memory. If-Match pins the
      object to the ETag it was listed with; the bytes written must equal Content-Length and the listed size. $State, when
      given, gets .bytes advanced as data arrives. Returns the byte count.
    #>
    param([hashtable]$Entry, [string]$Key, [string]$ETag = '', [long]$Size = -1, [string]$OutFile, [long]$MaxBytes, $State = $null)
    $loc = Get-SemS3Location $Entry
    $h = @{}
    if ($ETag) { $h['If-Match'] = '"' + $ETag + '"' }
    $r = Open-SemAwsResponse -Region $Entry.Region -Service 's3' -Method 'GET' -Origin $loc.Origin -Path ($loc.PathPrefix + '/' + $Key) -Headers $h -TimeoutSec 60
    $total = [long]0
    try {
        if ($r.Status -eq 412) { throw ('s3://' + $Entry.Bucket + '/' + $Key + ' changed after it was listed. List it again and import the new copy.') }
        if ($r.Status -ne 200) { $st = $r.Status; $text = Read-SemAwsResponseText $r -MaxBytes 65536; throw (Get-SemS3ErrorText -What ('reading s3://' + $Entry.Bucket + '/' + $Key) -Answer @{ Status = $st; Text = $text }) }
        $len = [long]-1
        if ($r.Headers.ContainsKey('content-length')) { [void][long]::TryParse([string]$r.Headers['content-length'], [ref]$len) }
        if ($Size -ge 0 -and $len -ge 0 -and $len -ne $Size) { throw ('s3://' + $Entry.Bucket + '/' + $Key + ' is ' + $len + ' bytes now, not the ' + $Size + ' it was listed with.') }
        if ($len -gt $MaxBytes) { throw ('s3://' + $Entry.Bucket + '/' + $Key + ' is larger than the ' + [long]($MaxBytes / 1MB) + ' MB limit (s3.maxObjectMb).') }
        $fs = New-Object IO.FileStream($OutFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 1048576)
        try {
            $buf = New-Object byte[] 1048576
            while ($true) {
                $n = $r.Stream.Read($buf, 0, $buf.Length)
                if ($n -le 0) { break }
                $total += $n
                if ($total -gt $MaxBytes) { throw ('s3://' + $Entry.Bucket + '/' + $Key + ' is larger than the ' + [long]($MaxBytes / 1MB) + ' MB limit (s3.maxObjectMb).') }
                $fs.Write($buf, 0, $n)
                if ($null -ne $State) { $State.bytes = [long]$State.bytes + $n }
            }
        } finally { $fs.Dispose() }
        $want = if ($len -ge 0) { $len } else { $Size }
        if ($want -ge 0 -and $total -ne $want) { throw ('The download of s3://' + $Entry.Bucket + '/' + $Key + ' stopped after ' + $total + ' of ' + $want + ' bytes. Try the import again.') }
    } finally { Close-SemAwsResponse $r }
    return $total
}

function Expand-SemGzipFile {
    # Expands a .gz file into $OutFile (streamed), capped at $MaxBytes. Refuses a concatenated (multi-member) gzip,
    # which the .NET Framework stops reading after its first member: the trailer's size must match what came out.
    param([string]$Path, [string]$OutFile, [long]$MaxBytes)
    $total = [long]0
    $in = [IO.File]::OpenRead($Path)
    try {
        $gz = New-Object IO.Compression.GZipStream($in, [IO.Compression.CompressionMode]::Decompress, $true)
        $out = New-Object IO.FileStream($OutFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 1048576)
        try {
            $buf = New-Object byte[] 1048576
            while ($true) {
                $n = $gz.Read($buf, 0, $buf.Length)
                if ($n -le 0) { break }
                $total += $n
                if ($total -gt $MaxBytes) { throw ('The expanded file is larger than the ' + [long]($MaxBytes / 1MB) + ' MB limit (s3.maxObjectMb).') }
                $out.Write($buf, 0, $n)
            }
        } finally { $out.Dispose(); $gz.Dispose() }
        if ($in.Length -ge 4) {
            $t = New-Object byte[] 4
            [void]$in.Seek(-4, [IO.SeekOrigin]::End); [void]$in.Read($t, 0, 4)
            $isize = [BitConverter]::ToUInt32($t, 0)
            if ([uint32]($total % 4294967296) -ne $isize) { throw 'This .gz file is several gzip streams joined together, which Windows'' built-in decompression cannot read whole. Recompress it as one stream, or import it uncompressed.' }
        }
    } catch [IO.InvalidDataException] {
        throw 'This .gz file is not valid gzip data.'
    } finally { $in.Dispose() }
    return $total
}

function Read-SemFirstLine {
    # The first line of a file as text (UTF-8 BOM and the line end dropped) and the byte offset after it.
    param([IO.Stream]$Stream)
    $bytes = New-Object System.Collections.Generic.List[byte]
    while ($bytes.Count -lt 1048576) {
        $b = $Stream.ReadByte()
        if ($b -lt 0) { break }
        $bytes.Add([byte]$b)
        if ($b -eq 10) { break }
    }
    $arr = $bytes.ToArray()
    $start = 0
    if ($arr.Length -ge 3 -and $arr[0] -eq 0xEF -and $arr[1] -eq 0xBB -and $arr[2] -eq 0xBF) { $start = 3 }
    $text = [Text.Encoding]::UTF8.GetString($arr, $start, $arr.Length - $start).TrimEnd("`r", "`n")
    return @{ Text = $text; Offset = $arr.Length; EndsWithNewline = ($arr.Length -gt 0 -and $arr[$arr.Length - 1] -eq 10) }
}

function Join-SemS3Parts {
    # Joins the parts of a partitioned dataset into one file, streamed: CSV/TSV parts must share the first part's header
    # (it is written once); JSON lines parts are concatenated. Each part ends with a line end before the next starts.
    param([string[]]$Files, [string]$Ext, [string]$OutFile)
    $header = $null
    $out = New-Object IO.FileStream($OutFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 1048576)
    try {
        $buf = New-Object byte[] 1048576
        $i = 0
        foreach ($f in $Files) {
            $i++
            $in = [IO.File]::OpenRead($f)
            try {
                $last = [byte]10
                if ($script:SemS3HeaderJoin -contains $Ext) {
                    $line = Read-SemFirstLine $in
                    if ($null -eq $header) {
                        $header = $line.Text
                        [void]$in.Seek(0, [IO.SeekOrigin]::Begin)
                    } elseif ($line.Text -cne $header) {
                        throw ('Part ' + $i + ' of the prefix has different columns from part 1, so they cannot become one table. Import the parts with the same columns, or each on its own.')
                    }
                }
                while ($true) {
                    $n = $in.Read($buf, 0, $buf.Length)
                    if ($n -le 0) { break }
                    $out.Write($buf, 0, $n); $last = $buf[$n - 1]
                }
                if ($last -ne 10) { $out.WriteByte(10) }
            } finally { $in.Dispose() }
        }
    } finally { $out.Dispose() }
}

# ---------------------------------------------------------------------------
# Import jobs
# ---------------------------------------------------------------------------
function Get-SemS3ImportPlan {
    # Checks a POST /api/s3/import body against the allowlist (no AWS call). Returns @{ Error } or the plan:
    # @{ Entry; Bucket; Keys (string[]) or Prefix; Table; Sheet; Replace; Label }.
    param($Body, [hashtable]$Config)
    $bad = { param($m) @{ Error = @{ Status = 400; Code = 'bad-request'; Message = $m } } }
    $bucket = [string](Get-SemJsonProp $Body 'bucket')
    if (-not $bucket) { return (& $bad 'Name the bucket.') }
    $key = Get-SemJsonProp $Body 'key'; $keys = Get-SemJsonProp $Body 'keys'; $prefix = Get-SemJsonProp $Body 'prefix'
    $given = @(@($key, $keys, $prefix) | Where-Object { $null -ne $_ }).Count
    if ($given -ne 1) { return (& $bad 'Give exactly one of key, keys or prefix.') }
    $list = @()
    if ($null -ne $key) { $list = @($key) } elseif ($null -ne $keys) { $list = @($keys) }
    if ($null -ne $prefix -and ($prefix -isnot [string] -or -not (Test-SemS3Key $prefix -AllowEmpty))) { return (& $bad 'The prefix is not a valid S3 prefix.') }
    if ($null -eq $prefix) {
        if ($list.Count -eq 0) { return (& $bad 'Pick at least one object.') }
        if ($list.Count -gt $script:SemS3MaxPrefixObjects) { return (& $bad ('At most ' + $script:SemS3MaxPrefixObjects + ' objects in one import.')) }
        foreach ($k in $list) { if ($k -isnot [string] -or -not (Test-SemS3Key $k) -or $k.EndsWith('/')) { return (& $bad 'Each key must be an S3 object key (not a folder).') } }
        if (@($list | Select-Object -Unique).Count -ne $list.Count) { return (& $bad 'A key is listed twice.') }
    }
    $table = Get-SemJsonProp $Body 'table'
    if ($null -ne $table -and $table -ne '' -and ($table -isnot [string] -or $table -cnotmatch '\A[A-Za-z_][A-Za-z0-9_]{0,62}\z')) { return (& $bad 'The table name may use letters, digits and _ (up to 63, not starting with a digit).') }
    $sheet = Get-SemJsonProp $Body 'sheet'
    if ($null -ne $sheet -and ($sheet -isnot [string] -or $sheet.Length -gt 100 -or $sheet -match '[\x00-\x1F\x7F]')) { return (& $bad 'The sheet name is not valid.') }
    $replace = Get-SemJsonProp $Body 'replace'
    if ($null -ne $replace -and $replace -isnot [bool]) { return (& $bad 'replace is true or false.') }
    $entry = $null
    foreach ($k in $(if ($null -ne $prefix) { @([string]$prefix) } else { $list })) {
        $f = Find-SemS3Entry -Config $Config -Bucket $bucket -Key $k
        if ($f.ContainsKey('Error')) { return $f }
        if ($null -eq $entry) { $entry = $f.Entry }
    }
    if ($null -ne $prefix) {
        $p = [string]$prefix
        if ($p -and -not $p.EndsWith('/')) { $p += '/' }
        $label = 's3://' + $bucket + '/' + $p
        return @{ Entry = $entry; Bucket = $bucket; Keys = $null; Prefix = $p; Table = $(if ($table) { [string]$table } else { ConvertTo-SemTableName $(if ($p) { $p } else { $bucket }) }); Sheet = [string]$sheet; Replace = [bool]$replace; Label = $label }
    }
    $exts = @($list | ForEach-Object { (Get-SemS3DataKind $_).Ext } | Select-Object -Unique)
    if ($exts -contains '') { return (& $bad 'Semaphore imports CSV, TSV, text, JSON, JSON lines, Parquet and Excel files (optionally .gz).') }
    if ($exts.Count -gt 1) { return (& $bad 'The objects picked are of different kinds; import one kind at a time.') }
    $defaultTable = if ($list.Count -eq 1) { ConvertTo-SemTableName $list[0] } else { $folder = $list[0].Substring(0, $list[0].LastIndexOf('/') + 1); ConvertTo-SemTableName $(if ($folder) { $folder } else { $list[0] }) }
    return @{ Entry = $entry; Bucket = $bucket; Keys = [string[]]$list; Prefix = $null; Table = $(if ($table) { [string]$table } else { $defaultTable }); Sheet = [string]$sheet; Replace = [bool]$replace; Label = $null }
}

function Get-SemS3SourceLabel {
    # s3://bucket/key#etag for one object; s3://bucket/prefix#<16 hex of the parts' keys and ETags> for several.
    param([string]$Bucket, [object[]]$Objects, [string]$Prefix = $null)
    if (@($Objects).Count -eq 1 -and -not $Prefix) { return ('s3://' + $Bucket + '/' + $Objects[0].key + '#' + $Objects[0].etag) }
    $text = (@($Objects | ForEach-Object { $_.key + ':' + $_.etag }) -join "`n")
    $hash = (Get-SemSha256Hex ([Text.Encoding]::UTF8.GetBytes($text))).Substring(0, 16)
    $where = if ($Prefix) { $Prefix } else { $Objects[0].key.Substring(0, $Objects[0].key.LastIndexOf('/') + 1) }
    return ('s3://' + $Bucket + '/' + $where + '#' + $hash)
}

function New-SemS3JobState {
    param([string]$Id, [hashtable]$Plan)
    return [hashtable]::Synchronized(@{
        job = $Id; state = 'queued'; phase = 'waiting'; bucket = $Plan.Bucket; what = $(if ($null -ne $Plan.Prefix) { 's3://' + $Plan.Bucket + '/' + $Plan.Prefix } elseif ($Plan.Keys.Count -eq 1) { 's3://' + $Plan.Bucket + '/' + $Plan.Keys[0] } else { [string]$Plan.Keys.Count + ' objects in s3://' + $Plan.Bucket })
        bytes = [long]0; totalBytes = [long]0; objects = 0; objectCount = 0; table = $Plan.Table; rows = $null; columns = $null; ms = $null
        error = $null; started = [datetime]::UtcNow; finished = $null
    })
}

function Invoke-SemS3ImportJob {
    # The import itself (a pool runspace, or a test): list or HEAD the objects, check sizes and disk space, stream each
    # to <home>\local\incoming\<job>, expand .gz, join a partitioned prefix's parts, call Import-SemLocalFile, clean up.
    param([hashtable]$Plan, [string]$HomeDir, $State, [long]$MaxBytes)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $entry = $Plan.Entry
    $dir = [IO.Path]::Combine($HomeDir, 'local', 'incoming', [string]$State.job)
    [void][IO.Directory]::CreateDirectory($dir)
    try {
        $State.state = 'running'; $State.phase = 'listing'
        if ($null -ne $Plan.Prefix) { $objects = @(Get-SemS3PrefixObjects -Entry $entry -Prefix $Plan.Prefix) }
        else { $objects = @(foreach ($k in $Plan.Keys) { Get-SemS3ObjectHead -Entry $entry -Key $k }) }
        $kinds = @($objects | ForEach-Object { (Get-SemS3DataKind $_.key).Ext } | Select-Object -Unique)
        if ($kinds.Count -gt 1) { throw ('The prefix mixes file kinds (' + ($kinds -join ', ') + '); import one kind at a time.') }
        $ext = [string]$kinds[0]
        $total = [long]0
        foreach ($o in $objects) {
            if ($o.size -gt $MaxBytes) { throw ('s3://' + $entry.Bucket + '/' + $o.key + ' is larger than the ' + [long]($MaxBytes / 1MB) + ' MB limit (s3.maxObjectMb).') }
            $total += [long]$o.size
        }
        $State.totalBytes = $total; $State.objectCount = $objects.Count
        try {
            $free = (New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($dir))).AvailableFreeSpace
            if ($free -lt [long]($total * 1.1)) { throw ('Not enough disk space for the download: it needs about ' + [long]($total / 1MB) + ' MB in ' + $dir + '.') }
        } catch [ArgumentException] { }
        $State.phase = 'downloading'
        $files = New-Object 'System.Collections.Generic.List[string]'
        $i = 0
        foreach ($o in $objects) {
            $i++
            $kind = Get-SemS3DataKind $o.key
            $part = [IO.Path]::Combine($dir, ('part-{0:D4}.{1}' -f $i, $ext))
            $raw = if ($kind.Gzip) { $part + '.gz' } else { $part }
            [void](Save-SemS3Object -Entry $entry -Key $o.key -ETag $o.etag -Size $o.size -OutFile $raw -MaxBytes $MaxBytes -State $State)
            if ($kind.Gzip) { [void](Expand-SemGzipFile -Path $raw -OutFile $part -MaxBytes $MaxBytes); [IO.File]::Delete($raw) }
            $files.Add($part)
            $State.objects = $i
        }
        $State.phase = 'importing'
        $label = Get-SemS3SourceLabel -Bucket $entry.Bucket -Objects $objects -Prefix $Plan.Prefix
        $args0 = @{ HomeDir = $HomeDir; Table = $Plan.Table; SourceLabel = $label }
        if ($Plan.Sheet) { $args0.Sheet = $Plan.Sheet }
        $rows = [long]0; $result = $null
        if ($files.Count -gt 1 -and (($script:SemS3HeaderJoin + $script:SemS3LineJoin) -contains $ext)) {
            $joined = [IO.Path]::Combine($dir, 'joined.' + $ext)
            Join-SemS3Parts -Files $files.ToArray() -Ext $ext -OutFile $joined
            foreach ($f in $files) { [IO.File]::Delete($f) }
            $files.Clear(); $files.Add($joined)
        }
        $first = $true
        foreach ($f in $files) {
            # Parts that cannot be joined as text (Parquet, Excel) go in one by one: the first replaces when asked (or, when
            # not, gets a free name such as orders_2), the rest are appended to the table the first one made.
            $a = $args0.Clone(); $a.Path = $f
            if ($first) { if ($Plan.Replace) { $a.Replace = $true } }
            else { $a.Table = [string]$result.Table; $a.Append = $true }
            $result = Import-SemLocalFile @a
            $rows += [long]$result.Rows
            $first = $false
        }
        $State.table = [string]$result.Table; $State.rows = $rows; $State.columns = $result.Columns
        $State.ms = [long]$clock.ElapsedMilliseconds
        $State.phase = 'done'; $State.state = 'done'
        Write-SemLog 'INFO' ('S3 import {0}: {1} object(s), {2} bytes from s3://{3} into {4} ({5} rows) in {6} ms' -f $State.job, $objects.Count, $State.bytes, $entry.Bucket, $State.table, $rows, $State.ms)
    } catch {
        $State.state = 'failed'; $State.phase = 'failed'
        $State.error = Get-SemLakeSafeText ([string]$_.Exception.Message)
        Write-SemLog 'WARN' ('S3 import {0} failed: {1}' -f $State.job, $State.error)
    } finally {
        $State.finished = [datetime]::UtcNow
        try { if ([IO.Directory]::Exists($dir)) { [IO.Directory]::Delete($dir, $true) } } catch { Write-SemLog 'WARN' ('S3 import ' + $State.job + ': could not remove ' + $dir) }
    }
}

$script:SemS3JobScript = @'
param($Plan, $Ctx, $State, $MaxBytes)
if (-not (Get-Command Invoke-SemQueryRequest -ErrorAction SilentlyContinue)) {
    . $Ctx.CommonPath
    . $Ctx.HttpPath
    . $Ctx.RoutesPath
    . $Ctx.QueryPath
    . $Ctx.IntelligencePath
    . $Ctx.LakePath
    . $Ctx.VaultPath
    . $Ctx.ConnectorsPath
    if ($Ctx.LocalDbPath) { . $Ctx.LocalDbPath }   # the real Import-SemLocalFile, before S3.ps1 would define its stub
    . $Ctx.S3Path
}
$script:SemLogPath = $Ctx.LogPath
try {
    $State.state = 'running'; $State.phase = 'signing in'
    Set-SemVaultRequest (Get-SemAwsVaultContext -Settings $Ctx.AwsSettings -Purpose 's3-import')
    $ve = Get-SemVaultError
    if ($ve) { $State.state = 'failed'; $State.phase = 'failed'; $State.error = $ve.Message; $State.finished = [datetime]::UtcNow; return }
    Invoke-SemS3ImportJob -Plan $Plan -HomeDir $Ctx.Home -State $State -MaxBytes $MaxBytes
} catch {
    $State.state = 'failed'; $State.phase = 'failed'; $State.error = 'The import stopped: ' + (Get-SemLakeSafeText ([string]$_.Exception.Message)); $State.finished = [datetime]::UtcNow
} finally {
    Clear-SemVaultRequest
}
'@

function ConvertTo-SemS3JobJson {
    param($State)
    return [ordered]@{
        job = $State.job; state = $State.state; phase = $State.phase; what = $State.what
        bytes = [long]$State.bytes; totalBytes = [long]$State.totalBytes; objects = [int]$State.objects; objectCount = [int]$State.objectCount
        table = $State.table; rows = $State.rows; columns = $State.columns; ms = $State.ms; error = $State.error
    }
}

function Start-SemS3Import {
    # POST /api/s3/import (main loop): checks the body against the allowlist, then runs the import on the worker pool,
    # unattached to the request, and answers 202 with the job id at once.
    param($Req)
    $config = Get-SemS3Config $script:Sem.AwsSettings
    $plan = Get-SemS3ImportPlan -Body $Req.Json -Config $config
    if ($plan.ContainsKey('Error')) { Send-SemError $plan.Error.Status $plan.Error.Code $plan.Error.Message; return }
    if ($null -eq $script:Sem.S3Jobs) { $script:Sem.S3Jobs = [hashtable]::Synchronized(@{}) }
    foreach ($s in @($script:Sem.S3Jobs.Values)) { if (@('queued', 'running') -contains $s.state) { Send-SemError 409 's3-busy' ('An S3 import is already running (' + $s.what + '). Wait for it to finish.'); return } }
    # Keep the newest finished jobs only.
    $old = @($script:Sem.S3Jobs.Values | Sort-Object { $_.started } -Descending | Select-Object -Skip ($script:SemS3MaxJobs - 1))
    foreach ($s in $old) { $script:Sem.S3Jobs.Remove($s.job) }
    $id = -join ((New-SemToken).ToCharArray() | Where-Object { $_ -match '[A-Za-z0-9]' } | Select-Object -First 16)
    $state = New-SemS3JobState -Id $id -Plan $plan
    $script:Sem.S3Jobs[$id] = $state
    $ctx = $script:Sem.WorkerContext.Clone()
    $ps = [powershell]::Create()
    $ps.RunspacePool = $script:Sem.Pool
    [void]$ps.AddScript($script:SemS3JobScript).AddArgument($plan).AddArgument($ctx).AddArgument($state).AddArgument([long]$config.MaxObjectBytes)
    $handle = $ps.BeginInvoke()
    $script:Sem.Workers.Add(@{ PS = $ps; Handle = $handle; Path = '/api/s3/import'; Client = $null; Clock = [Diagnostics.Stopwatch]::StartNew(); DeadlineSec = $script:SemS3JobDeadlineSec; TimedOut = $false })
    Write-SemLog 'INFO' ('S3 import {0} started: {1} into {2}' -f $id, $state.what, $plan.Table)
    Send-SemJson 202 (ConvertTo-SemS3JobJson $state)
}

function Invoke-SemS3StatusRoute {
    # GET /api/s3/import-status/<job> (main loop).
    param([string]$Path)
    $id = $Path.Substring([Math]::Min($Path.Length, '/api/s3/import-status/'.Length))
    $state = $null
    if ($id -cmatch '\A[A-Za-z0-9]{1,32}\z' -and $null -ne $script:Sem.S3Jobs) { $state = $script:Sem.S3Jobs[$id] }
    if ($null -eq $state) { Send-SemError 404 'not-found' 'No such import (imports are forgotten when Semaphore stops).'; return }
    Send-SemJson 200 (ConvertTo-SemS3JobJson $state)
}

function Get-SemS3BucketList {
    # GET /api/s3/buckets: the allowlist as the page shows it. No AWS call, never a key.
    $config = Get-SemS3Config $script:Sem.AwsSettings
    return [ordered]@{
        buckets = @($config.Buckets | ForEach-Object { [ordered]@{ bucket = $_.Bucket; region = $_.Region; prefix = $_.Prefix; label = $_.Label } })
        maxObjectMb = $config.MaxObjectMb; maxPrefixObjects = $script:SemS3MaxPrefixObjects; problems = @($config.Problems)
    }
}

# ---------------------------------------------------------------------------
# The AWS session for S3 and RDS discovery, and the worker routes
# ---------------------------------------------------------------------------
function Get-SemAwsVaultContext {
    # Worker: the request's vault context for the "aws.vault" block of the settings ($null when there is none: the
    # environment's session is used), or @{ Error }.
    param($Settings, [string]$Purpose = 'aws')
    $config = Get-SemS3Config $Settings
    if ($null -eq $config.Vault) { return $null }
    $raw = [pscustomobject]@{ vault = $config.Vault }
    $bad = Test-SemVaultBlock -Raw $raw -Provider 'athena'
    if ($bad) { return @{ Error = @{ Status = 400; Code = 'vault-config'; Message = ('aws.vault in config\settings.json: ' + $bad) } } }
    $src = [pscustomobject]@{ id = ('settings ' + ($Purpose -replace '[^A-Za-z0-9/_-]', '')); provider = 'athena'; raw = $raw }
    $r = Resolve-SemVaultSecrets -Source $src
    if ($r.ContainsKey('Error')) { return @{ Error = $r.Error } }
    if ($null -eq $r.Values) { return $null }
    return @{ Values = $r.Values; Notes = @($r.Notes) }
}

function Get-SemQueryParam {
    # One value from a request's query string ('' when absent). + is a space; values are percent-decoded.
    param([string]$Query, [string]$Name)
    if (-not $Query) { return '' }
    foreach ($pair in $Query.Split('&')) {
        $eq = $pair.IndexOf('=')
        $k = if ($eq -ge 0) { $pair.Substring(0, $eq) } else { $pair }
        if ([Uri]::UnescapeDataString($k.Replace('+', ' ')) -ceq $Name) {
            if ($eq -lt 0) { return '' }
            try { return [Uri]::UnescapeDataString($pair.Substring($eq + 1).Replace('+', ' ')) } catch { return '' }
        }
    }
    return ''
}

function Invoke-SemAwsWorkerRequest {
    # Worker: GET /api/s3/list and GET /api/rds/discover.
    param($Req, $Settings)
    $ve = Get-SemVaultError
    if ($ve) { Send-SemError $ve.Status $ve.Code $ve.Message; return }
    $config = Get-SemS3Config $Settings
    if ($Req.Path -eq '/api/s3/list') {
        $bucket = Get-SemQueryParam $Req.Query 'bucket'
        $prefix = Get-SemQueryParam $Req.Query 'prefix'
        $token = Get-SemQueryParam $Req.Query 'token'
        if (-not $bucket) { Send-SemError 400 'bad-request' 'Name the bucket.'; return }
        if (-not (Test-SemS3Key $prefix -AllowEmpty) -or $token.Length -gt 4096 -or $token -match '[\x00-\x1F]') { Send-SemError 400 'bad-request' 'The prefix or continuation token is not valid.'; return }
        if (-not $prefix) { $e0 = @($config.Buckets | Where-Object { $_.Bucket -ceq $bucket } | Select-Object -First 1); if ($e0.Count) { $prefix = $e0[0].Prefix } }
        $f = Find-SemS3Entry -Config $config -Bucket $bucket -Key $prefix
        if ($f.ContainsKey('Error')) { Send-SemError $f.Error.Status $f.Error.Code $f.Error.Message; return }
        try {
            $page = Invoke-SemS3ListPage -Entry $f.Entry -Prefix $prefix -Token $token -Delimiter '/' -MaxKeys 1000
            Send-SemJson 200 ([ordered]@{ bucket = $bucket; prefix = $prefix; root = $f.Entry.Prefix; folders = @($page.Folders); objects = @($page.Objects); nextToken = $page.NextToken })
        } catch { Send-SemError 502 's3-list' (Get-SemLakeSafeText ([string]$_.Exception.Message)) }
        return
    }
    if ($Req.Path -eq '/api/rds/discover') {
        $region = Get-SemQueryParam $Req.Query 'region'
        if (-not (Test-SemAwsRegion $region)) { Send-SemError 400 'bad-request' 'Give a region such as us-gov-west-1.'; return }
        try {
            $found = @(Find-SemRdsDatabases -Region $region -Fips ([bool]$config.Fips))
            Send-SemJson 200 ([ordered]@{ region = $region; databases = $found; note = 'Copy an entry into sources.json in the Semaphore folder; Semaphore does not write sources.json. Rename the vault share names to the ones you share in Lazarette.' })
        } catch {
            $m = Get-SemLakeSafeText ([string]$_.Exception.Message)
            if ($m -match 'AccessDenied|not authorized') { $m += ' The AWS session needs rds:DescribeDBInstances and rds:DescribeDBClusters.' }
            Send-SemError 502 'rds-discover' $m
        }
        return
    }
    Send-SemError 404 'not-found' 'Unknown API route.'
}
