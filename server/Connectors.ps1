#requires -Version 5.1
# =============================================================================
# Three more connectors, all BCL only, none needing a driver the analyst installs, none needing admin.
#
#   Redshift   "provider": "redshift-data"   Amazon Redshift Data API, SigV4 signed (the Athena signer in Lake.ps1).
#   Synapse    "provider": "synapse"         Azure Synapse / Azure SQL through ODBC Driver 17/18 for SQL Server; this
#                                            file only builds the safe connection string, Query.ps1 runs it as ODBC.
#   Foundry    "provider": "foundry"         Palantir Foundry SQL queries API (POST /api/v2/sqlQueries/execute, getStatus,
#                                            getResults as CSV), bearer token from the Lazarette vault.
#
# Sources in <home>\sources.json:
#   { "id": "wh", "kind": "aws-redshift", "provider": "redshift-data", "region": "us-gov-west-1", "database": "dev",
#     "clusterId": "maint-cluster", "dbUser": "semaphore_ro", "vault": { "item": "aws-semaphore" } }
#       (serverless: "workgroup": "maint-wg" instead of clusterId/dbUser; or "secretArn" instead of dbUser)
#   { "id": "syn", "kind": "azure-synapse", "provider": "synapse", "server": "ws-ondemand.sql.azuresynapse.net",
#     "database": "maint", "authentication": "ActiveDirectoryIntegrated" }
#   { "id": "fnd", "kind": "foundry", "provider": "foundry", "host": "https://acme.palantirfoundry.com",
#     "branch": "master", "datasets": { "ops.work_orders": "/Acme/Maintenance/work_orders" },
#     "vault": { "item": "foundry-token" } }
# Secrets are never in sources.json: see Vault.ps1 and docs/VAULT.md. Every connector is tested here against a
# simulated service only (docs/CONNECTORS.md lists what still needs a real account).
# =============================================================================

Register-SemVaultRoles -Provider 'redshift-data' -Roles @(@{ Role = 'accessKeyId'; Field = 'AccessKeyId'; Optional = $false }, @{ Role = 'secretAccessKey'; Field = 'SecretAccessKey'; Optional = $false }, @{ Role = 'sessionToken'; Field = 'SessionToken'; Optional = $true })
Register-SemVaultRoles -Provider 'foundry' -Roles @(@{ Role = 'token'; Field = $null; Optional = $false })

$script:SemSynapseHostRx = '\A[A-Za-z0-9][A-Za-z0-9-]{0,62}(\.[A-Za-z0-9-]{1,63}){1,5}\z'
$script:SemSynapseSuffixes = @('.sql.azuresynapse.net', '.sql.azuresynapse.usgovcloudapi.net', '.database.windows.net', '.database.usgovcloudapi.net', '.sql.azuresynapse.azure.cn', '.database.chinacloudapi.cn')

function Test-SemHttpsBase {
    # $true for https, or http on loopback (a simulator), without user info.
    param([string]$Url)
    $u = $null
    return ([Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$u) -and ($u.Scheme -eq 'https' -or ($u.Scheme -eq 'http' -and $u.IsLoopback)) -and -not $u.UserInfo -and -not $u.Query -and -not $u.Fragment)
}

# ---------------------------------------------------------------------------
# Synapse
# ---------------------------------------------------------------------------
function New-SemSynapseConnection {
    # The ODBC connection string for a synapse source entry (a PSCustomObject). Throws a readable message.
    # Encrypted, certificate checked, read intent. A password-based sign-in needs a vault block (user and password).
    param($Raw)
    $server = [string](Get-SemJsonProp $Raw 'server')
    $okHost = $server -cmatch $script:SemSynapseHostRx
    if ($okHost) { $okHost = $false; foreach ($s in $script:SemSynapseSuffixes) { if ($server.ToLowerInvariant().EndsWith($s)) { $okHost = $true } } }
    if (-not $okHost) { throw 'The Synapse source needs "server": a host ending in .sql.azuresynapse.net or .database.windows.net (or the US Gov equivalents).' }
    $database = [string](Get-SemJsonProp $Raw 'database')
    if ($database -cnotmatch '\A[A-Za-z0-9_ -]{1,128}\z') { throw 'The Synapse source needs "database" (letters, digits, space, _ and -).' }
    $auth = [string](Get-SemJsonProp $Raw 'authentication'); if (-not $auth) { $auth = 'ActiveDirectoryIntegrated' }
    $allowed = @('ActiveDirectoryIntegrated', 'ActiveDirectoryInteractive', 'ActiveDirectoryMsi', 'ActiveDirectoryPassword', 'SqlPassword')
    if ($allowed -cnotcontains $auth) { throw ('Synapse "authentication" must be one of: ' + ($allowed -join ', ') + '.') }
    $needsPassword = @('ActiveDirectoryPassword', 'SqlPassword') -ccontains $auth
    if ($needsPassword -and $null -eq (Get-SemJsonProp $Raw 'vault')) { throw ($auth + ' needs a "vault" block: the user and password come from Lazarette, never from sources.json.') }
    $driver = [string](Get-SemJsonProp $Raw 'driver'); if (-not $driver) { $driver = 'ODBC Driver 18 for SQL Server' }
    if ($driver -cnotmatch '\AODBC Driver (17|18) for SQL Server\z') { throw 'The Synapse "driver" must be "ODBC Driver 17 for SQL Server" or "ODBC Driver 18 for SQL Server".' }
    foreach ($forbidden in @('password', 'pwd', 'uid', 'user', 'secret')) { if ($Raw.PSObject.Properties[$forbidden]) { throw 'Credentials do not belong in sources.json. Use a "vault" block.' } }
    $cs = "Driver={$driver};Server=tcp:$server,1433;Database={$database};Encrypt=yes;TrustServerCertificate=no;ApplicationIntent=ReadOnly;Connection Timeout=30"
    if ($auth -ne 'SqlPassword') { $cs += ";Authentication=$auth" }
    return $cs
}

# ---------------------------------------------------------------------------
# Redshift Data API
# ---------------------------------------------------------------------------
function Get-SemRedshiftSettings {
    param($Raw)
    $region = [string](Get-SemJsonProp $Raw 'region')
    if ($region -cnotmatch '\A[a-z]{2}(-gov)?-[a-z]+-\d\z') { throw 'The Redshift source needs a region such as us-gov-west-1.' }
    $database = [string](Get-SemJsonProp $Raw 'database')
    if ($database -cnotmatch '\A[A-Za-z0-9_$-]{1,127}\z') { throw 'The Redshift source needs "database" (letters, digits, _ $ -).' }
    $cluster = [string](Get-SemJsonProp $Raw 'clusterId'); $workgroup = [string](Get-SemJsonProp $Raw 'workgroup')
    if (($cluster -and $workgroup) -or (-not $cluster -and -not $workgroup)) { throw 'The Redshift source needs exactly one of "clusterId" (provisioned) or "workgroup" (serverless).' }
    foreach ($n in @($cluster, $workgroup)) { if ($n -and $n -cnotmatch '\A[A-Za-z0-9-]{1,63}\z') { throw 'The Redshift clusterId or workgroup has an invalid name.' } }
    $dbUser = [string](Get-SemJsonProp $Raw 'dbUser'); $secretArn = [string](Get-SemJsonProp $Raw 'secretArn')
    if ($dbUser -and $dbUser -cnotmatch '\A[A-Za-z_][A-Za-z0-9_$-]{0,127}\z') { throw 'The Redshift dbUser is not a valid user name.' }
    if ($secretArn -and $secretArn -cnotmatch '\Aarn:aws(-us-gov|-cn)?:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}\z') { throw 'The Redshift secretArn is not a Secrets Manager ARN.' }
    if ($dbUser -and $secretArn) { throw 'The Redshift source takes "dbUser" or "secretArn", not both.' }
    if ($cluster -and -not $dbUser -and -not $secretArn) { throw 'A provisioned Redshift source needs "dbUser" (temporary credentials) or "secretArn".' }
    if ($workgroup -and $dbUser) { throw 'A serverless Redshift source signs in as the IAM identity; remove "dbUser" or use "secretArn".' }
    $endpoint = [string](Get-SemJsonProp $Raw 'endpoint')
    if ($endpoint) { if (-not (Test-SemHttpsBase $endpoint)) { throw 'The Redshift endpoint must be https (or http on 127.0.0.1 for a simulator) without user info.' }; $endpoint = $endpoint.TrimEnd('/') }
    foreach ($forbidden in @('accessKey', 'accessKeyId', 'secretKey', 'secretAccessKey', 'sessionToken', 'password')) { if ($Raw.PSObject.Properties[$forbidden]) { throw 'Keys and passwords do not belong in sources.json. Use a "vault" block or the environment.' } }
    return @{ Region = $region; Database = $database; ClusterId = $cluster; Workgroup = $workgroup; DbUser = $dbUser; SecretArn = $secretArn; Endpoint = $endpoint }
}

function Convert-SemQuestionMarks {
    # Rewrites each ? outside quotes with $Replace.Invoke(index). Skips 'text', "name" and `name`.
    param([string]$Sql, [scriptblock]$Replace)
    $sb = New-Object Text.StringBuilder; $q = [char]0; $i = 0; $n = 0
    foreach ($ch in $Sql.ToCharArray()) {
        if ($q -ne [char]0) { [void]$sb.Append($ch); if ($ch -eq $q) { $q = [char]0 }; continue }
        if ($ch -eq "'" -or $ch -eq '"' -or $ch -eq '`') { $q = $ch; [void]$sb.Append($ch); continue }
        if ($ch -eq '?') { $n++; [void]$sb.Append([string](& $Replace $n)); continue }
        [void]$sb.Append($ch)
    }
    return @{ Sql = $sb.ToString(); Count = $n }
}

function ConvertTo-SemRedshiftStatement {
    # Positional ? -> named :p1.. with a cast per type (Data API values are strings). Null becomes the NULL literal.
    param([string]$Sql, [object[]]$Params)
    $list = New-Object System.Collections.Generic.List[hashtable]
    $inv = [Globalization.CultureInfo]::InvariantCulture
    $conv = Convert-SemQuestionMarks -Sql $Sql -Replace {
        param($n)
        $p = $Params[$n - 1]
        if ($null -eq $p) { throw 'The SQL has more ? markers than parameters.' }
        $v = $p.Value
        if ($v -is [DBNull] -or $null -eq $v) { return 'NULL' }
        switch ($p.Type) {
            'number' { $list.Add(@{ name = "p$n"; value = ([double]$v).ToString('R', $inv) }); return "CAST(:p$n AS DOUBLE PRECISION)" }
            'boolean' { $list.Add(@{ name = "p$n"; value = $(if ([bool]$v) { 'true' } else { 'false' }) }); return "CAST(:p$n AS BOOLEAN)" }
            'date' { $list.Add(@{ name = "p$n"; value = ([datetime]$v).ToString('yyyy-MM-dd HH:mm:ss', $inv) }); return "CAST(:p$n AS TIMESTAMP)" }
            default { $list.Add(@{ name = "p$n"; value = [string]$v }); return ":p$n" }
        }
    }
    if ($conv.Count -ne @($Params).Count) { throw 'The SQL has fewer ? markers than parameters.' }
    return @{ Sql = $conv.Sql; Parameters = $list.ToArray() }
}

function Get-SemRedshiftTarget {
    param([hashtable]$Rs)
    $t = @{ Database = $Rs.Database }
    if ($Rs.ClusterId) { $t.ClusterIdentifier = $Rs.ClusterId } else { $t.WorkgroupName = $Rs.Workgroup }
    if ($Rs.DbUser) { $t.DbUser = $Rs.DbUser }
    if ($Rs.SecretArn) { $t.SecretArn = $Rs.SecretArn }
    return $t
}

function Invoke-SemRedshiftJson {
    param([hashtable]$Rs, [string]$Operation, [hashtable]$Payload, [int]$TimeoutSec = 30)
    return (Invoke-SemAwsJson -Lake $Rs -Service 'redshift-data' -Target ('RedshiftData.' + $Operation) -Payload $Payload -TimeoutSec $TimeoutSec)
}

function ConvertFrom-SemRedshiftCell {
    param($Cell, [string]$Type)
    if ($null -eq $Cell -or $Cell -isnot [Management.Automation.PSCustomObject] -or $true -eq (Get-SemJsonProp $Cell 'isNull')) { return 'null' }
    $inv = [Globalization.CultureInfo]::InvariantCulture
    $long = Get-SemJsonProp $Cell 'longValue'; if ($null -ne $long) { return ([double]$long).ToString('R', $inv) }
    $dbl = Get-SemJsonProp $Cell 'doubleValue'; if ($null -ne $dbl) { return ([double]$dbl).ToString('R', $inv) }
    $bool = Get-SemJsonProp $Cell 'booleanValue'; if ($null -ne $bool) { if ($bool) { return 'true' } else { return 'false' } }
    $text = [string](Get-SemJsonProp $Cell 'stringValue')
    switch -Regex ($Type) {
        '^(int2|int4|int8|int|integer|bigint|smallint|float4|float8|float|double|real|numeric|decimal)' { $x = 0.0; if ([double]::TryParse($text, [Globalization.NumberStyles]::Float, $inv, [ref]$x)) { return $x.ToString('R', $inv) } else { return 'null' } }
        '^bool' { if ($text -in @('true', 't', '1')) { return 'true' } elseif ($text -in @('false', 'f', '0')) { return 'false' } else { return 'null' } }
        '^(date|timestamp)' { return (ConvertTo-SemJsonString ($text.Replace(' ', 'T') -replace '\.\d+$', '' -replace '(?<=:\d\d)([+-]\d\d(:?\d\d)?|Z)$', '')) }
        default { return (ConvertTo-SemJsonString $text) }
    }
}

function Invoke-SemRedshiftQuery {
    # Runs $Plan (Source, Sql, Params, RowCap, TimeoutSec) through the Data API; the response JSON has the providers' shape.
    param([hashtable]$Rs, [hashtable]$Plan, [Diagnostics.Stopwatch]$Clock = ([Diagnostics.Stopwatch]::StartNew()), [int]$PollMs = 500)
    $stmt = ConvertTo-SemRedshiftStatement -Sql $Plan.Sql -Params $Plan.Params
    $payload = Get-SemRedshiftTarget $Rs
    $payload.Sql = $stmt.Sql
    if (@($stmt.Parameters).Count) { $payload.Parameters = @($stmt.Parameters) }
    $start = Invoke-SemRedshiftJson -Rs $Rs -Operation 'ExecuteStatement' -Payload $payload
    $id = [string](Get-SemJsonProp $start 'Id')
    if ($id -cnotmatch '\A[A-Za-z0-9-]{1,128}\z') { throw 'Redshift did not return a statement id.' }
    $state = ''; $desc = $null
    while ($true) {
        $desc = Invoke-SemRedshiftJson -Rs $Rs -Operation 'DescribeStatement' -Payload @{ Id = $id }
        $state = [string](Get-SemJsonProp $desc 'Status')
        if (@('FINISHED', 'FAILED', 'ABORTED') -contains $state) { break }
        if ($Clock.Elapsed.TotalSeconds -gt $Plan.TimeoutSec) {
            try { [void](Invoke-SemRedshiftJson -Rs $Rs -Operation 'CancelStatement' -Payload @{ Id = $id }) } catch { }
            throw "Redshift did not finish within $($Plan.TimeoutSec) s; the statement was cancelled."
        }
        Start-Sleep -Milliseconds $PollMs
    }
    if ($state -ne 'FINISHED') { throw ('Redshift ' + $state.ToLowerInvariant() + ' the statement: ' + (Get-SemLakeSafeText ([string](Get-SemJsonProp $desc 'Error')))) }
    $sb = New-Object Text.StringBuilder 65536
    [void]$sb.Append('{"columns":[')
    $names = $null; $types = $null; $count = 0; $truncated = $false; $token = $null
    do {
        $p = @{ Id = $id }; if ($token) { $p.NextToken = $token }
        $res = Invoke-SemRedshiftJson -Rs $Rs -Operation 'GetStatementResult' -Payload $p -TimeoutSec 60
        if ($null -eq $names) {
            $meta = @(Get-SemJsonProp $res 'ColumnMetadata')
            $names = @($meta | ForEach-Object { $l = [string](Get-SemJsonProp $_ 'label'); if ($l) { $l } else { [string](Get-SemJsonProp $_ 'name') } })
            $types = @($meta | ForEach-Object { ([string](Get-SemJsonProp $_ 'typeName')).ToLowerInvariant() })
            [void]$sb.Append((@($names | ForEach-Object { ConvertTo-SemJsonString $_ }) -join ',')).Append('],"rows":[')
        }
        foreach ($rec in @(Get-SemJsonProp $res 'Records')) {
            if ($count -ge $Plan.RowCap) { $truncated = $true; break }
            $cells = @($rec)
            if ($count -gt 0) { [void]$sb.Append(',') }
            [void]$sb.Append('{')
            for ($c = 0; $c -lt $names.Count; $c++) {
                if ($c -gt 0) { [void]$sb.Append(',') }
                $cell = if ($c -lt $cells.Count) { $cells[$c] } else { $null }
                [void]$sb.Append((ConvertTo-SemJsonString $names[$c])).Append(':').Append((ConvertFrom-SemRedshiftCell $cell $types[$c]))
            }
            [void]$sb.Append('}')
            $count++
        }
        $token = [string](Get-SemJsonProp $res 'NextToken')
    } while ($token -and -not $truncated)
    if ($null -eq $names) { [void]$sb.Append('],"rows":[') }
    [void]$sb.Append('],"truncated":').Append($(if ($truncated) { 'true' } else { 'false' }))
    [void]$sb.Append(',"ms":').Append([string][long]$Clock.ElapsedMilliseconds).Append('}')
    return $sb.ToString()
}

function Get-SemRedshiftProfile {
    # /api/profile from the Data API's own catalog calls: no table is scanned.
    param([hashtable]$Rs, [string]$Table)
    $map = { param($t) $t = $t.ToLowerInvariant(); if ($t -match '^(int|integer|smallint|bigint|float|double|real|numeric|decimal)') { 'number' } elseif ($t -match '^(date|timestamp)') { 'date' } elseif ($t -match '^bool') { 'boolean' } else { 'string' } }
    $target = Get-SemRedshiftTarget $Rs
    if (-not $Table) {
        $target.MaxResults = 100
        $r = Invoke-SemRedshiftJson -Rs $Rs -Operation 'ListTables' -Payload $target
        return [ordered]@{ tables = @(@(Get-SemJsonProp $r 'Tables') | ForEach-Object { $s = [string](Get-SemJsonProp $_ 'schema'); $n = [string](Get-SemJsonProp $_ 'name'); if ($n) { $(if ($s) { "$s.$n" } else { $n }) } } | Where-Object { $_ }) }
    }
    $schema = ''; $name = $Table
    if ($Table.Contains('.')) { $schema = $Table.Substring(0, $Table.IndexOf('.')); $name = $Table.Substring($Table.IndexOf('.') + 1) }
    $target.Table = $name; if ($schema) { $target.Schema = $schema }
    $r = Invoke-SemRedshiftJson -Rs $Rs -Operation 'DescribeTable' -Payload $target
    $cols = @(@(Get-SemJsonProp $r 'ColumnList') | ForEach-Object { [ordered]@{ name = [string](Get-SemJsonProp $_ 'name'); type = (& $map ([string](Get-SemJsonProp $_ 'typeName'))); distinct = $null; samples = @() } })
    return [ordered]@{ table = $Table; rows = $null; columns = $cols; note = 'From the Redshift catalog: no data was read.' }
}

# ---------------------------------------------------------------------------
# Palantir Foundry SQL
# ---------------------------------------------------------------------------
function Get-SemFoundrySettings {
    param($Raw)
    $host_ = ([string](Get-SemJsonProp $Raw 'host')).TrimEnd('/')
    if (-not $host_ -or -not (Test-SemHttpsBase $host_)) { throw 'The Foundry source needs "host": the https address of the Foundry stack (http only on 127.0.0.1 for a simulator).' }
    $branch = [string](Get-SemJsonProp $Raw 'branch')
    if ($branch -and $branch -cnotmatch '\A[A-Za-z0-9._/-]{1,128}\z') { throw 'The Foundry "branch" is not a valid branch name.' }
    $datasets = @{}
    $ds = Get-SemJsonProp $Raw 'datasets'
    if ($null -ne $ds) {
        if ($ds -isnot [Management.Automation.PSCustomObject]) { throw 'Foundry "datasets" must map a table name to a dataset path or RID.' }
        foreach ($p in $ds.PSObject.Properties) {
            if (-not (Test-SemIdentifier $p.Name)) { throw ('Foundry dataset name "' + $p.Name + '" is not a valid table name.') }
            if ($p.Value -isnot [string] -or $p.Value -cnotmatch '\A[A-Za-z0-9_/. :-]{1,512}\z') { throw ('Foundry dataset "' + $p.Name + '" needs a path or RID (letters, digits, _ / . : - and space).') }
            $datasets[$p.Name] = $p.Value
        }
    }
    foreach ($forbidden in @('token', 'accessToken', 'password', 'apiKey')) { if ($Raw.PSObject.Properties[$forbidden]) { throw 'Tokens do not belong in sources.json. Use a "vault" block.' } }
    return @{ Host = $host_; Branch = $branch; Datasets = $datasets }
}

function Format-SemSparkLiteral {
    # A typed parameter as a Spark SQL literal. Foundry takes no bound values, so each is checked and written inline.
    param([hashtable]$Typed)
    $v = $Typed.Value
    if ($v -is [DBNull] -or $null -eq $v) { return 'NULL' }
    $inv = [Globalization.CultureInfo]::InvariantCulture
    switch ($Typed.Type) {
        'number' { $x = [double]$v; if ([double]::IsNaN($x) -or [double]::IsInfinity($x)) { throw 'A number parameter is not finite.' }; return $x.ToString('R', $inv) }
        'boolean' { if ([bool]$v) { return 'true' } else { return 'false' } }
        'date' { $d = [datetime]$v; if ($d.TimeOfDay -eq [TimeSpan]::Zero) { return "DATE'" + $d.ToString('yyyy-MM-dd', $inv) + "'" } else { return "TIMESTAMP'" + $d.ToString('yyyy-MM-dd HH:mm:ss', $inv) + "'" } }
        default {
            $s = [string]$v
            if ($s -cmatch '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]') { throw 'A text parameter contains control characters and cannot be written into the query.' }
            $s = $s.Replace('\', '\\').Replace("'", "\'").Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
            return "'" + $s + "'"
        }
    }
}

function ConvertTo-SemFoundryQuery {
    # The Spark SQL text to send: parameters written inline, catalog table names swapped for dataset paths or RIDs.
    param([string]$Sql, [object[]]$Params, [hashtable]$Foundry)
    $conv = Convert-SemQuestionMarks -Sql $Sql -Replace { param($n) $p = $Params[$n - 1]; if ($null -eq $p) { throw 'The SQL has more ? markers than parameters.' }; Format-SemSparkLiteral $p }
    if ($conv.Count -ne @($Params).Count) { throw 'The SQL has fewer ? markers than parameters.' }
    $out = $conv.Sql
    foreach ($name in ($Foundry.Datasets.Keys | Sort-Object { $_.Length } -Descending)) {
        $quoted = (@($name -split '\.') | ForEach-Object { '`' + $_ + '`' }) -join '.'
        $out = $out.Replace($quoted, '`' + $Foundry.Datasets[$name] + '`')
    }
    return $out
}

function Invoke-SemFoundryRequest {
    # One bearer-token call. Returns @{ Status; Text }. Throws a token-free message on network failure.
    param([hashtable]$Foundry, [string]$Method, [string]$Path, [string]$Body = '', [int]$TimeoutSec = 70)
    $token = Get-SemVaultValue 'token'
    if (-not $token) { $token = [Environment]::GetEnvironmentVariable('FOUNDRY_TOKEN') }
    if (-not $token) { throw 'No Foundry token: name a Lazarette item with a "vault" block, or set FOUNDRY_TOKEN in the environment that started Semaphore.' }
    $req = [Net.HttpWebRequest]::Create($Foundry.Host + $Path)
    $req.Method = $Method; $req.Timeout = $TimeoutSec * 1000; $req.ReadWriteTimeout = $TimeoutSec * 1000
    $req.AllowAutoRedirect = $false; $req.UserAgent = 'Semaphore'
    $req.Headers['Authorization'] = 'Bearer ' + $token
    $resp = $null
    try {
        if ($Method -eq 'POST') {
            $bytes = [Text.Encoding]::UTF8.GetBytes($Body); $req.ContentType = 'application/json'; $req.ContentLength = $bytes.Length
            $s = $req.GetRequestStream(); try { $s.Write($bytes, 0, $bytes.Length) } finally { $s.Dispose() }
        }
        try { $resp = $req.GetResponse() } catch [Net.WebException] { if ($null -eq $_.Exception.Response) { throw }; $resp = $_.Exception.Response }
        $r = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
        try { $text = $r.ReadToEnd() } finally { $r.Dispose() }
        return @{ Status = [int]$resp.StatusCode; Text = $text }
    } catch [Net.WebException] {
        throw ('Foundry could not be reached: ' + (Get-SemVaultSafeText ([string]$_.Exception.Message) @($token)))
    } finally { if ($null -ne $resp) { try { $resp.Close() } catch { } } }
}

function Get-SemFoundryErrorText {
    param($Response, [string]$Token)
    $msg = ''
    try { $j = $Response.Text | ConvertFrom-Json -ErrorAction Stop; $msg = [string](Get-SemJsonProp $j 'errorName'); $d = [string](Get-SemJsonProp $j 'errorDescription'); if ($d) { $msg += ': ' + $d } } catch { }
    $text = ('Foundry answered {0}' -f $Response.Status) + $(if ($msg) { ' (' + $msg + ')' } else { '' })
    return (Get-SemVaultSafeText $text @($Token))
}

function ConvertFrom-SemCsvText {
    # RFC 4180: quoted fields, doubled quotes, embedded commas and newlines. Returns @{ Header; Rows } (rows are string[]); stops at $MaxRows data rows.
    param([string]$Text, [int]$MaxRows = 200000)
    $rows = New-Object System.Collections.Generic.List[string[]]
    $field = New-Object Text.StringBuilder; $row = New-Object System.Collections.Generic.List[string]
    $inQ = $false; $truncated = $false; $i = 0; $n = $Text.Length
    if ($n -gt 0 -and $Text[0] -eq [char]0xFEFF) { $i = 1 }
    while ($i -lt $n) {
        $ch = $Text[$i]
        if ($inQ) {
            if ($ch -eq '"') { if ($i + 1 -lt $n -and $Text[$i + 1] -eq '"') { [void]$field.Append('"'); $i++ } else { $inQ = $false } }
            else { [void]$field.Append($ch) }
        } elseif ($ch -eq '"') { $inQ = $true }
        elseif ($ch -eq ',') { $row.Add($field.ToString()); [void]$field.Clear() }
        elseif ($ch -eq "`r" -or $ch -eq "`n") {
            if ($ch -eq "`r" -and $i + 1 -lt $n -and $Text[$i + 1] -eq "`n") { $i++ }
            $row.Add($field.ToString()); [void]$field.Clear()
            if ($row.Count -gt 1 -or $row[0] -ne '') { $rows.Add($row.ToArray()) }
            $row = New-Object System.Collections.Generic.List[string]
            if ($rows.Count -gt $MaxRows) { $truncated = $true; break }
        } else { [void]$field.Append($ch) }
        $i++
    }
    if (-not $truncated -and ($field.Length -gt 0 -or $row.Count -gt 0)) { $row.Add($field.ToString()); $rows.Add($row.ToArray()) }
    if ($rows.Count -eq 0) { return @{ Header = @(); Rows = @(); Truncated = $false } }
    $header = $rows[0]; $rows.RemoveAt(0)
    if ($rows.Count -gt $MaxRows) { $rows.RemoveRange($MaxRows, $rows.Count - $MaxRows); $truncated = $true }
    return @{ Header = $header; Rows = $rows.ToArray(); Truncated = $truncated }
}

function Get-SemCsvColumnKind {
    # number when every non-empty cell is a plain number (no leading zeros), date when every one is a date or timestamp, else string.
    param([string[]]$Values)
    $num = $true; $date = $true; $seen = 0
    foreach ($v in $Values) {
        if ($null -eq $v -or $v -eq '') { continue }
        $seen++
        if ($num -and $v -cnotmatch '\A-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?\z') { $num = $false }
        if ($date -and $v -cnotmatch '\A\d{4}-\d\d-\d\d([ T]\d\d:\d\d:\d\d(\.\d+)?)?Z?\z') { $date = $false }
        if (-not $num -and -not $date) { return 'string' }
    }
    if ($seen -eq 0) { return 'string' }
    if ($num) { return 'number' }
    return 'date'
}

function ConvertTo-SemFoundryResultJson {
    # CSV from getResults -> the providers' response JSON. Empty cells are null.
    param([string]$Csv, [int]$RowCap, [Diagnostics.Stopwatch]$Clock)
    $inv = [Globalization.CultureInfo]::InvariantCulture
    $parsed = ConvertFrom-SemCsvText -Text $Csv -MaxRows ($RowCap + 1)
    $rows = @($parsed.Rows); $truncated = $parsed.Truncated -or ($rows.Count -gt $RowCap)
    if ($rows.Count -gt $RowCap) { $rows = @($rows[0..($RowCap - 1)]) }
    $names = @($parsed.Header)
    $kinds = for ($c = 0; $c -lt $names.Count; $c++) { Get-SemCsvColumnKind -Values @($rows | ForEach-Object { if ($c -lt $_.Length) { $_[$c] } else { '' } }) }
    $sb = New-Object Text.StringBuilder 65536
    [void]$sb.Append('{"columns":[').Append((@($names | ForEach-Object { ConvertTo-SemJsonString $_ }) -join ',')).Append('],"rows":[')
    for ($r = 0; $r -lt $rows.Count; $r++) {
        if ($r -gt 0) { [void]$sb.Append(',') }
        [void]$sb.Append('{')
        for ($c = 0; $c -lt $names.Count; $c++) {
            if ($c -gt 0) { [void]$sb.Append(',') }
            $cell = if ($c -lt $rows[$r].Length) { $rows[$r][$c] } else { '' }
            if ($cell -eq '') { $out = 'null' }
            elseif (@($kinds)[$c] -eq 'number') { $out = ([double]::Parse($cell, [Globalization.NumberStyles]::Float, $inv)).ToString('R', $inv) }
            elseif (@($kinds)[$c] -eq 'date') { $out = ConvertTo-SemJsonString (($cell.Replace(' ', 'T') -replace '\.\d+', '') -replace 'Z$', '') }
            else { $out = ConvertTo-SemJsonString $cell }
            [void]$sb.Append((ConvertTo-SemJsonString $names[$c])).Append(':').Append($out)
        }
        [void]$sb.Append('}')
    }
    [void]$sb.Append('],"truncated":').Append($(if ($truncated) { 'true' } else { 'false' })).Append(',"ms":').Append([string][long]$Clock.ElapsedMilliseconds).Append('}')
    return $sb.ToString()
}

function Invoke-SemFoundryQuery {
    # Execute (CSV), poll getStatus, fetch getResults. $Plan: Source, Sql, Params, RowCap, TimeoutSec.
    param([hashtable]$Foundry, [hashtable]$Plan, [Diagnostics.Stopwatch]$Clock = ([Diagnostics.Stopwatch]::StartNew()), [int]$PollMs = 500)
    $query = ConvertTo-SemFoundryQuery -Sql $Plan.Sql -Params $Plan.Params -Foundry $Foundry
    $body = @{ query = $query; serializationFormat = 'CSV' }
    if ($Foundry.Branch) { $body.fallbackBranchIds = @($Foundry.Branch) }
    $token = Get-SemVaultValue 'token'
    $r = Invoke-SemFoundryRequest -Foundry $Foundry -Method 'POST' -Path '/api/v2/sqlQueries/execute' -Body (ConvertTo-Json -InputObject $body -Compress)
    if ($r.Status -ne 200) { throw (Get-SemFoundryErrorText $r $token) }
    $status = $r.Text | ConvertFrom-Json
    $id = ''
    while ($true) {
        foreach ($variant in 'succeeded', 'running', 'failed', 'canceled') {
            $v = Get-SemJsonProp $status $variant
            if ($null -ne $v) {
                $q = [string](Get-SemJsonProp $v 'queryId'); if ($q) { $id = $q }
                if ($variant -eq 'failed') { throw ('Foundry failed the query: ' + (Get-SemVaultSafeText ([string](Get-SemJsonProp $v 'errorMessage')) @($token))) }
                if ($variant -eq 'canceled') { throw 'Foundry cancelled the query.' }
                if ($variant -eq 'succeeded') { $state = 'succeeded' } else { $state = 'running' }
            }
        }
        if (-not $id) { $q = [string](Get-SemJsonProp $status 'queryId'); if ($q) { $id = $q } }
        if ($state -eq 'succeeded') { break }
        if (-not $id) { throw 'Foundry did not return a query id.' }
        if ($Clock.Elapsed.TotalSeconds -gt $Plan.TimeoutSec) { throw "Foundry did not finish within $($Plan.TimeoutSec) s." }
        Start-Sleep -Milliseconds $PollMs
        $r = Invoke-SemFoundryRequest -Foundry $Foundry -Method 'GET' -Path ('/api/v2/sqlQueries/' + [Uri]::EscapeDataString($id) + '/getStatus')
        if ($r.Status -ne 200) { throw (Get-SemFoundryErrorText $r $token) }
        $status = $r.Text | ConvertFrom-Json; $state = ''
    }
    if (-not $id) { throw 'Foundry did not return a query id.' }
    $r = Invoke-SemFoundryRequest -Foundry $Foundry -Method 'GET' -Path ('/api/v2/sqlQueries/' + [Uri]::EscapeDataString($id) + '/getResults')
    if ($r.Status -ne 200) { throw (Get-SemFoundryErrorText $r $token) }
    return (ConvertTo-SemFoundryResultJson -Csv $r.Text -RowCap $Plan.RowCap -Clock $Clock)
}

function Get-SemFoundryProfile {
    # No catalog call is assumed: the table is sampled with LIMIT 200 and typed from the sample.
    param([hashtable]$Foundry, [string]$Table)
    if (-not $Table) { return [ordered]@{ tables = @($Foundry.Datasets.Keys | Sort-Object); note = 'Foundry lists no datasets here: add them under "datasets" in sources.json.' } }
    $quoted = (@($Table -split '\.') | ForEach-Object { '`' + $_ + '`' }) -join '.'
    $plan = @{ Sql = "SELECT * FROM $quoted LIMIT 200"; Params = @(); RowCap = 200; TimeoutSec = 120 }
    $json = Invoke-SemFoundryQuery -Foundry $Foundry -Plan $plan | ConvertFrom-Json
    $cols = @($json.columns | ForEach-Object {
        $name = [string]$_
        $vals = @($json.rows | ForEach-Object { $_.$name } | Where-Object { $null -ne $_ })
        $kind = 'string'
        if ($vals.Count) { if (@($vals | Where-Object { $_ -isnot [double] -and $_ -isnot [int] -and $_ -isnot [long] -and $_ -isnot [decimal] }).Count -eq 0) { $kind = 'number' } elseif (@($vals | Where-Object { $_ -isnot [string] -or $_ -notmatch '^\d{4}-\d\d-\d\dT?' }).Count -eq 0) { $kind = 'date' } elseif (@($vals | Where-Object { $_ -isnot [bool] }).Count -eq 0) { $kind = 'boolean' } }
        [ordered]@{ name = $name; type = $kind; distinct = @($vals | Select-Object -Unique).Count; samples = @($vals | Select-Object -Unique -First 5 | ForEach-Object { [string]$_ }) }
    })
    return [ordered]@{ table = $Table; rows = $null; columns = $cols; note = 'Typed from a sample of up to 200 rows.' }
}

# ---------------------------------------------------------------------------
# Request handlers (run inside a worker runspace), called from Query.ps1
# ---------------------------------------------------------------------------
function Invoke-SemConnectorQueryRequest {
    param([hashtable]$Plan)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $src = $Plan.Source
    try {
        if ($src.provider -eq 'redshift-data') {
            try { [void](Get-SemAwsCredentials) } catch { Send-SemError 401 'redshift-no-session' $_.Exception.Message; return }
            $json = Invoke-SemRedshiftQuery -Rs (Get-SemRedshiftSettings $src.raw) -Plan $Plan -Clock $clock
        } else {
            $json = Invoke-SemFoundryQuery -Foundry (Get-SemFoundrySettings $src.raw) -Plan $Plan -Clock $clock
        }
        Write-SemLog 'INFO' ("Query on '{0}' ({1}): {2} ms" -f $src.id, $src.provider, $clock.ElapsedMilliseconds)
        Send-SemJsonText 200 $json
    } catch {
        Write-SemLog 'WARN' ("Query on '{0}' ({1}) failed" -f $src.id, $src.provider)
        Send-SemError 502 'connector-query' (Get-SemLakeSafeText $_.Exception.Message)
    }
}

function Invoke-SemConnectorProfileRequest {
    param($Source, [string]$Table)
    try {
        if ($Source.provider -eq 'redshift-data') { Send-SemJson 200 (Get-SemRedshiftProfile -Rs (Get-SemRedshiftSettings $Source.raw) -Table $Table) }
        else { Send-SemJson 200 (Get-SemFoundryProfile -Foundry (Get-SemFoundrySettings $Source.raw) -Table $Table) }
    } catch { Send-SemError 502 'connector-profile' (Get-SemLakeSafeText $_.Exception.Message) }
}
