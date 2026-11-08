#requires -Version 5.1
# =============================================================================
# AWS pieces shared by the lake (Lake.ps1), Amazon RDS / Aurora sources and the S3 browser (S3.ps1). BCL only.
#
#   * SigV4 presigned query strings (New-SemAwsPresignedQuery) and the RDS IAM auth token built from one
#     (New-SemRdsAuthToken): service rds-db, Action=connect, DBUser, 900 s, host:port as the signed host.
#   * Endpoints for the aws, aws-us-gov (GovCloud) and aws-cn partitions, with the FIPS variants.
#   * RDS sources: settings, the ODBC driver already on this computer, the connection string per engine
#     (TLS required), and "Find RDS databases" (DescribeDBInstances / DescribeDBClusters).
#   * The one HTTP seam for S3 (Open-SemAwsResponse): signed request, response stream handed back unread, so
#     a download goes to a file and never sits in memory. Tests mock it.
#
# An RDS source in <home>\sources.json (provider odbc, as every ODBC source):
#   { "id": "maint", "label": "Maintenance (RDS)", "kind": "aws-rds", "provider": "odbc", "engine": "postgres",
#     "host": "maint.abc123.us-gov-west-1.rds.amazonaws.com", "port": 5432, "database": "maint",
#     "region": "us-gov-west-1", "auth": "iam", "user": "semaphore_ro",
#     "vault": { "accessKeyId": "AWS_ACCESS_KEY_ID", "secretAccessKey": "AWS_SECRET_ACCESS_KEY", "sessionToken": "AWS_SESSION_TOKEN" } }
#   "auth": "password" reads the password (and optionally the user) from Lazarette: "vault": { "password": "...", "user": "..." }.
# No connection string, password or key is ever written in sources.json (refused). Tokens and passwords live in
# memory for one request; they are scrubbed from every message (Get-SemVaultSafeText) and never logged.
# =============================================================================

$script:SemAwsEmptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
$script:SemAwsRegionRx = '\A[a-z]{2}(-gov)?-[a-z]+-\d\z'
$script:SemRdsHostRx = '\A[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*\z'
$script:SemRdsTokenExpiresSec = 900

# Engines a source may name, and the family that decides the driver, the TLS keyword and the SQL dialect.
$script:SemRdsEngines = [ordered]@{
    'postgres' = 'postgres'; 'aurora-postgresql' = 'postgres'
    'mysql' = 'mysql'; 'mariadb' = 'mysql'; 'aurora-mysql' = 'mysql'
    'sqlserver' = 'sqlserver'; 'oracle' = 'oracle'
}
$script:SemRdsDefaultPorts = @{ postgres = 5432; mysql = 3306; sqlserver = 1433; oracle = 1521 }

# ---------------------------------------------------------------------------
# Endpoints (aws, aws-us-gov, aws-cn; FIPS where asked)
# ---------------------------------------------------------------------------
function Test-SemAwsRegion {
    param([string]$Region)
    return ($Region -cmatch $script:SemAwsRegionRx)
}

function Get-SemAwsDnsSuffix {
    param([string]$Region)
    if ($Region.StartsWith('cn-')) { return 'amazonaws.com.cn' }
    return 'amazonaws.com'
}

function Get-SemAwsServiceHost {
    # The regional host of an AWS API: rds.us-gov-west-1.amazonaws.com, rds-fips.us-gov-west-1.amazonaws.com,
    # s3.us-east-1.amazonaws.com, s3-fips.us-gov-east-1.amazonaws.com. GovCloud regions live in the aws-us-gov partition
    # under the same amazonaws.com suffix; China regions use amazonaws.com.cn (and have no FIPS endpoints).
    param([string]$Service, [string]$Region, [bool]$Fips = $false)
    if (-not (Test-SemAwsRegion $Region)) { throw ('"' + $Region + '" is not an AWS region (for example us-gov-west-1).') }
    $name = $Service
    if ($Fips) {
        if ($Region.StartsWith('cn-')) { throw 'The China regions have no FIPS endpoints.' }
        $name = $Service + '-fips'
    }
    return ('{0}.{1}.{2}' -f $name, $Region, (Get-SemAwsDnsSuffix $Region))
}

# ---------------------------------------------------------------------------
# SigV4 presigned query strings (query-string authentication)
# ---------------------------------------------------------------------------
function ConvertTo-SemAwsCanonicalQuery {
    # name=value pairs, both URI-encoded, sorted by encoded name in byte order (ordinal), joined with &.
    param([hashtable]$Query)
    $pairs = New-Object 'System.Collections.Generic.List[string]'
    foreach ($k in $Query.Keys) { $pairs.Add((ConvertTo-SemUriEncoded ([string]$k)) + '=' + (ConvertTo-SemUriEncoded ([string]$Query[$k]))) }
    $arr = $pairs.ToArray()
    [Array]::Sort($arr, [StringComparer]::Ordinal)
    return ($arr -join '&')
}

function New-SemAwsPresignedQuery {
    <#
      The query string of a SigV4 presigned request (X-Amz-Algorithm .. X-Amz-Signature), signing only the host
      header. Pure: the clock and keys are parameters. $HostHeader is the host as signed (host:port when the port is
      not the default; the RDS token always signs host:port). $PayloadHash is the empty-body hash except for S3,
      whose presigned URLs sign UNSIGNED-PAYLOAD. Returns @{ Query (the full query string); Signature }.
    #>
    param(
        [string]$Method = 'GET', [string]$HostHeader, [string]$Path = '/', [hashtable]$Query = @{},
        [string]$Service, [string]$Region, [string]$AccessKey, [string]$SecretKey, [string]$SessionToken = '',
        [datetime]$Now = [datetime]::UtcNow, [int]$ExpiresSec = 900, [string]$PayloadHash = $script:SemAwsEmptySha
    )
    if ($ExpiresSec -lt 1 -or $ExpiresSec -gt 604800) { throw 'A presigned request expires after 1 s to 7 days.' }
    $amzDate = $Now.ToString("yyyyMMdd'T'HHmmss'Z'", [Globalization.CultureInfo]::InvariantCulture)
    $day = $amzDate.Substring(0, 8)
    $scope = "$day/$Region/$Service/aws4_request"
    $q = @{}
    foreach ($k in $Query.Keys) { $q[$k] = [string]$Query[$k] }
    $q['X-Amz-Algorithm'] = 'AWS4-HMAC-SHA256'
    $q['X-Amz-Credential'] = "$AccessKey/$scope"
    $q['X-Amz-Date'] = $amzDate
    $q['X-Amz-Expires'] = [string]$ExpiresSec
    $q['X-Amz-SignedHeaders'] = 'host'
    if ($SessionToken) { $q['X-Amz-Security-Token'] = $SessionToken }
    $canonicalQuery = ConvertTo-SemAwsCanonicalQuery $q
    $canonicalPath = if ($Service -eq 's3') { ConvertTo-SemUriEncoded $Path -KeepSlash } else { ConvertTo-SemUriEncoded (ConvertTo-SemUriEncoded $Path -KeepSlash) -KeepSlash }
    if (-not $canonicalPath) { $canonicalPath = '/' }
    $canonical = "$Method`n$canonicalPath`n$canonicalQuery`nhost:$($HostHeader.Trim())`n`nhost`n$PayloadHash"
    $toSign = "AWS4-HMAC-SHA256`n$amzDate`n$scope`n" + (Get-SemSha256Hex ([Text.Encoding]::UTF8.GetBytes($canonical)))
    $k = Get-SemHmac ([Text.Encoding]::UTF8.GetBytes('AWS4' + $SecretKey)) $day
    $k = Get-SemHmac $k $Region
    $k = Get-SemHmac $k $Service
    $k = Get-SemHmac $k 'aws4_request'
    $sig = -join ((Get-SemHmac $k $toSign) | ForEach-Object { $_.ToString('x2') })
    return @{ Query = ($canonicalQuery + '&X-Amz-Signature=' + $sig); Signature = $sig }
}

function New-SemRdsAuthToken {
    # An RDS IAM authentication token: host:port/?Action=connect&DBUser=..&X-Amz-...&X-Amz-Signature=.., valid 900 s.
    # It is the database password for one sign-in; it lives in memory only and is never logged or returned.
    param(
        [Parameter(Mandatory = $true)][string]$Hostname, [Parameter(Mandatory = $true)][int]$Port, [Parameter(Mandatory = $true)][string]$DbUser,
        [Parameter(Mandatory = $true)][string]$Region, [Parameter(Mandatory = $true)][hashtable]$Credentials, [datetime]$Now = [datetime]::UtcNow
    )
    $hostPort = '{0}:{1}' -f $Hostname, $Port
    $p = New-SemAwsPresignedQuery -Method 'GET' -HostHeader $hostPort -Path '/' -Query @{ Action = 'connect'; DBUser = $DbUser } -Service 'rds-db' -Region $Region `
        -AccessKey $Credentials.AccessKey -SecretKey $Credentials.SecretKey -SessionToken ([string]$Credentials.SessionToken) -Now $Now -ExpiresSec $script:SemRdsTokenExpiresSec
    return ($hostPort + '/?' + $p.Query)
}

# ---------------------------------------------------------------------------
# RDS sources: settings
# ---------------------------------------------------------------------------
function Get-SemRdsFamily {
    # postgres | mysql | sqlserver | oracle for an engine name, else $null.
    param([string]$Engine)
    if (-not $Engine) { return $null }
    $e = $Engine.ToLowerInvariant()
    if ($script:SemRdsEngines.Contains($e)) { return $script:SemRdsEngines[$e] }
    return $null
}

function Get-SemRdsSettings {
    # The RDS fields of a sources.json entry (a PSCustomObject), checked. Throws a readable message.
    param($Raw)
    foreach ($forbidden in @('connection', 'password', 'pwd', 'secret', 'token', 'accessKey', 'accessKeyId', 'secretKey', 'secretAccessKey', 'sessionToken')) {
        if ($Raw.PSObject.Properties[$forbidden]) {
            if ($forbidden -eq 'connection') { throw 'An aws-rds source has no "connection": Semaphore builds it from engine, host, port and database, with TLS on.' }
            throw 'Passwords and keys do not belong in sources.json. Share them from Lazarette with a "vault" block (docs/VAULT.md).'
        }
    }
    $engine = ([string](Get-SemJsonProp $Raw 'engine')).ToLowerInvariant()
    $family = Get-SemRdsFamily $engine
    if (-not $family) { throw ('An aws-rds source needs "engine": one of ' + (@($script:SemRdsEngines.Keys) -join ', ') + '.') }
    $hostName = [string](Get-SemJsonProp $Raw 'host')
    if ($hostName.Length -gt 253 -or $hostName -cnotmatch $script:SemRdsHostRx -or $hostName -notmatch '\.') { throw 'An aws-rds source needs "host": the instance or cluster endpoint, such as maint.abc123.us-gov-west-1.rds.amazonaws.com.' }
    $port = $script:SemRdsDefaultPorts[$family]
    $rawPort = Get-SemJsonProp $Raw 'port'
    if ($null -ne $rawPort) {
        $n = 0
        if (-not [int]::TryParse([string]$rawPort, [ref]$n) -or $n -lt 1 -or $n -gt 65535) { throw 'The aws-rds "port" must be a number from 1 to 65535.' }
        $port = $n
    }
    $database = [string](Get-SemJsonProp $Raw 'database')
    if ($database -cnotmatch '\A[A-Za-z0-9_$-][A-Za-z0-9_$ .-]{0,127}\z') { throw 'An aws-rds source needs "database" (letters, digits, _ $ - . and space; for Oracle the service name).' }
    $region = [string](Get-SemJsonProp $Raw 'region')
    if (-not (Test-SemAwsRegion $region)) { throw 'An aws-rds source needs "region", such as us-gov-west-1.' }
    $auth = [string](Get-SemJsonProp $Raw 'auth'); if (-not $auth) { $auth = 'password' }
    $auth = $auth.ToLowerInvariant()
    if (@('password', 'iam') -cnotcontains $auth) { throw 'The aws-rds "auth" must be "password" or "iam".' }
    if ($auth -eq 'iam' -and @('postgres', 'mysql') -notcontains $family) { throw ('RDS IAM database authentication works with PostgreSQL, MySQL and MariaDB engines only; use "auth": "password" for ' + $engine + '.') }
    $user = [string](Get-SemJsonProp $Raw 'user')
    if ($user -and $user -cnotmatch '\A[A-Za-z_][A-Za-z0-9_$.@-]{0,127}\z') { throw 'The aws-rds "user" is not a valid database user name.' }
    $vault = Get-SemJsonProp $Raw 'vault'
    if ($auth -eq 'iam') {
        if (-not $user -and -not ($vault -and (Get-SemJsonProp $vault 'user'))) { throw 'IAM sign-in needs the database user: "user": "semaphore_ro" (a user granted rds_iam / AWSAuthenticationPlugin), or a vault "user" share.' }
    } else {
        if ($null -eq $vault -or -not (Get-SemJsonProp $vault 'password')) { throw 'Password sign-in needs a "vault" block naming the Lazarette share of the password (and the user, or "user" here): { "password": "RDS_PASSWORD", "user": "RDS_USER" }.' }
    }
    $driver = [string](Get-SemJsonProp $Raw 'driver')
    if ($driver -and $driver -cnotmatch '\A[A-Za-z0-9 ._()+-]{1,100}\z') { throw 'The aws-rds "driver" must be the name of an installed ODBC driver.' }
    $ca = [string](Get-SemJsonProp $Raw 'caBundle')
    if ($ca -and ($ca -match '[\x00-\x1F;{}]' -or -not [IO.Path]::IsPathRooted($ca))) { throw 'The aws-rds "caBundle" must be a full path to the RDS certificate bundle (.pem).' }
    $tcps = [bool](Get-SemJsonProp $Raw 'tcps')
    if ($tcps -and $family -ne 'oracle') { throw '"tcps" is for Oracle sources only; the other engines always use TLS.' }
    return @{
        Engine = $engine; Family = $family; Host = $hostName; Port = [int]$port; Database = $database; Region = $region
        Auth = $auth; User = $user; Driver = $driver; CaBundle = $ca; Tcps = $tcps
    }
}

# ---------------------------------------------------------------------------
# ODBC drivers already on this computer (never installed by Semaphore)
# ---------------------------------------------------------------------------
function Get-SemOdbcDriverNames {
    # The ODBC drivers registered for this process's bitness: machine-wide (HKLM) and for this user (HKCU),
    # from ODBCINST.INI\ODBC Drivers, the list the ODBC administrator shows. The one seam tests mock.
    $names = New-Object 'System.Collections.Generic.List[string]'
    foreach ($hive in @([Microsoft.Win32.Registry]::LocalMachine, [Microsoft.Win32.Registry]::CurrentUser)) {
        $key = $null
        try { $key = $hive.OpenSubKey('SOFTWARE\ODBC\ODBCINST.INI\ODBC Drivers') } catch { $key = $null }
        if ($null -eq $key) { continue }
        try {
            foreach ($n in $key.GetValueNames()) { if (-not $names.Contains($n) -and [string]$key.GetValue($n) -eq 'Installed') { $names.Add($n) } }
        } finally { $key.Close() }
    }
    return $names.ToArray()
}

function Get-SemDriverVersionKey {
    # Sort key for "MySQL ODBC 8.4 Unicode Driver" / "Oracle in instantclient_21_9": the numbers, zero padded.
    param([string]$Name)
    return (-join ([regex]::Matches($Name, '\d+') | ForEach-Object { $_.Value.PadLeft(6, '0') }))
}

function Get-SemRdsDriverCandidates {
    # The installed drivers that can reach this engine, best first.
    param([string]$Engine, [string[]]$Installed)
    $family = Get-SemRdsFamily $Engine
    $pick = {
        param([string]$Rx)
        @($Installed | Where-Object { $_ -match $Rx } | Sort-Object -Property @{ Expression = { Get-SemDriverVersionKey $_ }; Descending = $true })
    }
    switch ($family) {
        'postgres' { return @(& $pick '\APostgreSQL Unicode\(x64\)\z') + @(& $pick '\APostgreSQL Unicode\z') }
        'mysql' {
            $mysql = @(& $pick '\AMySQL ODBC \d+\.\d+ Unicode Driver\z')
            $maria = @(& $pick '\AMariaDB ODBC \d+\.\d+ Driver\z')
            if ($Engine -eq 'mariadb') { return $maria + $mysql }
            return $mysql + $maria
        }
        'sqlserver' { return @(& $pick '\AODBC Driver 18 for SQL Server\z') + @(& $pick '\AODBC Driver 17 for SQL Server\z') }
        'oracle' { return @(& $pick '\AOracle in instantclient') + @(& $pick '\AOracle in (?!instantclient)') }
    }
    return @()
}

function Get-SemRdsMissingDriverText {
    param([string]$Engine)
    $family = Get-SemRdsFamily $Engine
    $tail = ' Ask IT to install it (64-bit, to match Windows PowerShell); Semaphore never installs drivers. The ODBC Data Sources (64-bit) tool lists what is installed.'
    switch ($family) {
        'postgres' { return ('No PostgreSQL ODBC driver is installed on this computer: Semaphore looked for "PostgreSQL Unicode(x64)" and "PostgreSQL Unicode" (psqlODBC) for the ' + $Engine + ' source.' + $tail) }
        'mysql' { return ('No MySQL or MariaDB ODBC driver is installed on this computer: Semaphore looked for "MySQL ODBC 8.x Unicode Driver" (Connector/ODBC 8 or later) and "MariaDB ODBC 3.x Driver" for the ' + $Engine + ' source.' + $tail) }
        'sqlserver' { return ('No SQL Server ODBC driver is installed on this computer: Semaphore looked for "ODBC Driver 18 for SQL Server" and "ODBC Driver 17 for SQL Server".' + $tail) }
        'oracle' { return ('No Oracle ODBC driver is installed on this computer: Semaphore looked for "Oracle in instantclient_..." (Oracle Instant Client with its ODBC package, registered with odbc_install.exe) or "Oracle in OraClient...".' + $tail) }
    }
    return 'No ODBC driver for this engine is installed on this computer.'
}

function Find-SemRdsDriver {
    # The driver to use: the source's "driver" when it is installed and fits the engine, else the best installed one.
    # Throws 'provider-unavailable: <which driver is missing>' (a 501 with that sentence) when there is none.
    param([Parameter(Mandatory = $true)][hashtable]$Rds, [string[]]$Installed = $null)
    if ($null -eq $Installed) { $Installed = @(Get-SemOdbcDriverNames) }
    $candidates = @(Get-SemRdsDriverCandidates -Engine $Rds.Engine -Installed $Installed)
    if ($Rds.Driver) {
        if ($candidates -ccontains $Rds.Driver) { return $Rds.Driver }
        if ($Installed -ccontains $Rds.Driver) { throw ('provider-unavailable: The driver "' + $Rds.Driver + '" is installed but does not reach ' + $Rds.Engine + ' databases. Remove "driver" to let Semaphore pick one.') }
        throw ('provider-unavailable: The driver "' + $Rds.Driver + '" named in sources.json is not installed on this computer. ' + (Get-SemRdsMissingDriverText $Rds.Engine))
    }
    if ($candidates.Count -eq 0) { throw ('provider-unavailable: ' + (Get-SemRdsMissingDriverText $Rds.Engine)) }
    return [string]$candidates[0]
}

# ---------------------------------------------------------------------------
# RDS connection strings (TLS required)
# ---------------------------------------------------------------------------
function New-SemRdsConnectionString {
    <#
      The ODBC connection string for an RDS source and driver. TLS is always on:
        postgres   SSLmode=require (verify-full with the RDS bundle when "caBundle" is set)
        mysql      SSLMODE=REQUIRED (VERIFY_IDENTITY with "caBundle"); MariaDB driver FORCETLS=1 (SSLVERIFY=1 with "caBundle")
        sqlserver  Encrypt=yes;TrustServerCertificate=no;ApplicationIntent=ReadOnly
        oracle     TCPS when "tcps" is set (else the listener's own encryption, configured in the RDS option group)
      $User and $Password (a Lazarette password or an IAM token) are added last as UID/PWD in braces; the string lives in
      memory for one connection and is never logged or returned.
    #>
    param([Parameter(Mandatory = $true)][hashtable]$Rds, [Parameter(Mandatory = $true)][string]$Driver, [string]$User = '', [string]$Password = '')
    $h = $Rds.Host; $p = $Rds.Port; $db = $Rds.Database
    $d = '{' + $Driver + '}'
    $ca = $Rds.CaBundle
    switch ($Rds.Family) {
        'postgres' {
            $cs = "Driver=$d;Server=$h;Port=$p;Database=$db"
            if ($ca) { $cs += ";SSLmode=verify-full;pqopt={sslrootcert=$ca}" } else { $cs += ';SSLmode=require' }
        }
        'mysql' {
            $cs = "Driver=$d;Server=$h;Port=$p;Database=$db"
            if ($Driver -like 'MariaDB*') {
                $cs += ';FORCETLS=1'
                if ($ca) { $cs += ";SSLCA={$ca};SSLVERIFY=1" }
            } else {
                if ($ca) { $cs += ";SSLMODE=VERIFY_IDENTITY;SSLCA={$ca}" } else { $cs += ';SSLMODE=REQUIRED' }
                if ($Rds.Auth -eq 'iam') { $cs += ';ENABLE_CLEARTEXT_PLUGIN=1' }   # the token goes as a cleartext password, inside TLS
            }
        }
        'sqlserver' {
            $cs = "Driver=$d;Server=tcp:$h,$p;Database=$db;Encrypt=yes;TrustServerCertificate=no;ApplicationIntent=ReadOnly;Connection Timeout=30"
        }
        'oracle' {
            if ($Rds.Tcps) { $cs = "Driver=$d;Dbq=(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=$h)(PORT=$p))(CONNECT_DATA=(SERVICE_NAME=$db)))" }
            else { $cs = "Driver=$d;Dbq=//${h}:$p/$db" }
        }
        default { throw 'Unknown RDS engine family.' }
    }
    $values = @{}
    if ($User) { $values['user'] = $User }
    if ($Password) { $values['password'] = $Password }
    return (Add-SemVaultToConnectionString -ConnectionString $cs -Provider 'odbc' -Values $values)
}

function Register-SemRequestSecret {
    # Adds a secret made for this request (an IAM token) to the request's vault values, so every message is scrubbed
    # of it (Get-SemVaultSafeText) and Clear-SemVaultRequest overwrites it when the request ends.
    param([string]$Name, [string]$Value)
    if ($null -eq $script:SemVaultRequest) { Set-SemVaultRequest @{ Values = @{}; Notes = @() } }
    if ($null -eq $script:SemVaultRequest.Values) { $script:SemVaultRequest.Values = @{} }
    $script:SemVaultRequest.Values['__' + $Name] = $Value
}

function Get-SemRdsConnectionString {
    # The string handed to the driver for an aws-rds source, in memory only: the installed driver, TLS, and the
    # password from Lazarette or a fresh IAM token signed with the AWS session (Lazarette, else the environment).
    param([Parameter(Mandatory = $true)]$Source, [string[]]$Installed = $null, [datetime]$Now = [datetime]::UtcNow)
    $rds = Get-SemRdsSettings $Source.raw
    $driver = Find-SemRdsDriver -Rds $rds -Installed $Installed
    $user = Get-SemVaultValue 'user'
    if (-not $user) { $user = $rds.User }
    if ($rds.Auth -eq 'iam') {
        if (-not $user) { throw ("Source '" + $Source.id + "' signs in with IAM but names no database user.") }
        $token = New-SemRdsAuthToken -Hostname $rds.Host -Port $rds.Port -DbUser $user -Region $rds.Region -Credentials (Get-SemAwsCredentials) -Now $Now
        Register-SemRequestSecret -Name 'rdsToken' -Value $token
        return (New-SemRdsConnectionString -Rds $rds -Driver $driver -User $user -Password $token)
    }
    return (New-SemRdsConnectionString -Rds $rds -Driver $driver -User $user -Password ([string](Get-SemVaultValue 'password')))
}

function Get-SemRdsSessionStatements {
    # What runs once a connection is open: a read-only session where the engine has one, UTC, and (MySQL) ANSI quotes,
    # so the double-quoted names of Semaphore's profile and SQL work. SQL Server asks ApplicationIntent=ReadOnly in the
    # string; Oracle has no session switch, so the SQL guard and a read-only login are the control.
    param([string]$Family)
    switch ($Family) {
        'postgres' { return @('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY', "SET TIME ZONE 'UTC'") }
        'mysql' { return @('SET SESSION TRANSACTION READ ONLY', "SET time_zone = '+00:00'", "SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',ANSI_QUOTES')") }
    }
    return @()
}

# ---------------------------------------------------------------------------
# One signed HTTP request with the response stream handed back (the seam for S3 downloads)
# ---------------------------------------------------------------------------
function Open-SemAwsResponse {
    <#
      Sends one SigV4-signed request and returns @{ Status; Headers (hashtable, lower-case names); Stream; Response }
      without reading the body. $Origin is scheme://host[:port]; $Path is the raw (unencoded) path, encoded once here
      for the URL and for the signature. The caller reads Stream and calls Close-SemAwsResponse. Throws a key-free message
      on network failures. Tests mock this function.
    #>
    param([string]$Region, [string]$Service, [string]$Method = 'GET', [string]$Origin, [string]$Path = '/', [hashtable]$Query = @{}, [hashtable]$Headers = @{}, [int]$TimeoutSec = 60)
    $cred = Get-SemAwsCredentials
    $u = [Uri]($Origin.TrimEnd('/') + '/')
    $hostHeader = if ($u.IsDefaultPort) { $u.Host } else { "$($u.Host):$($u.Port)" }
    $sign = @{ host = $hostHeader }
    foreach ($k in $Headers.Keys) { $sign[$k] = $Headers[$k] }
    $sig = New-SemAwsSignature -Method $Method -Path $Path -Query $Query -Headers $sign -Service $Service -Region $Region -AccessKey $cred.AccessKey -SecretKey $cred.SecretKey -SessionToken $cred.SessionToken
    $qs = ConvertTo-SemAwsCanonicalQuery $Query
    $url = $Origin.TrimEnd('/') + (ConvertTo-SemUriEncoded $Path -KeepSlash) + $(if ($qs) { '?' + $qs } else { '' })
    $req = [Net.HttpWebRequest]::Create($url)
    $req.Method = $Method; $req.Timeout = $TimeoutSec * 1000; $req.ReadWriteTimeout = [Math]::Max(300, $TimeoutSec) * 1000
    $req.AllowAutoRedirect = $false; $req.UserAgent = 'Semaphore'; $req.AutomaticDecompression = [Net.DecompressionMethods]::None
    foreach ($k in $Headers.Keys) { if ($k -ieq 'if-match') { $req.Headers['If-Match'] = $Headers[$k] } else { $req.Headers[$k] = $Headers[$k] } }
    foreach ($k in $sig.Keys) { $req.Headers[$k] = $sig[$k] }
    $resp = $null
    try {
        try { $resp = $req.GetResponse() } catch [Net.WebException] { if ($null -eq $_.Exception.Response) { throw }; $resp = $_.Exception.Response }
    } catch [Net.WebException] {
        throw ('AWS could not be reached (' + $Service + '): ' + (Get-SemLakeSafeText $_.Exception.Message))
    }
    $h = @{}
    foreach ($n in $resp.Headers.AllKeys) { $h[$n.ToLowerInvariant()] = [string]$resp.Headers[$n] }
    return @{ Status = [int]$resp.StatusCode; Headers = $h; Stream = $resp.GetResponseStream(); Response = $resp }
}

function Close-SemAwsResponse {
    param($Response)
    if ($null -eq $Response) { return }
    try { if ($null -ne $Response.Stream) { $Response.Stream.Dispose() } } catch { }
    try { if ($null -ne $Response.Response) { $Response.Response.Close() } } catch { }
}

function Read-SemAwsResponseText {
    # The whole body of a (small) response as text, capped at $MaxBytes; closes the response.
    param($Response, [int]$MaxBytes = 16777216)
    try {
        $ms = New-Object IO.MemoryStream
        $buf = New-Object byte[] 65536
        while ($true) {
            $n = $Response.Stream.Read($buf, 0, $buf.Length)
            if ($n -le 0) { break }
            if ($ms.Length + $n -gt $MaxBytes) { throw 'AWS sent a larger answer than expected.' }
            $ms.Write($buf, 0, $n)
        }
        return [Text.Encoding]::UTF8.GetString($ms.ToArray())
    } finally { Close-SemAwsResponse $Response }
}

function New-SemXmlDocument {
    # An XmlDocument from AWS text with no DTD or external entities.
    param([string]$Text)
    $settings = New-Object Xml.XmlReaderSettings
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $sr = New-Object IO.StringReader $Text
    $reader = [Xml.XmlReader]::Create($sr, $settings)
    try { $x = New-Object Xml.XmlDocument; $x.XmlResolver = $null; $x.Load($reader); return $x } finally { $reader.Dispose(); $sr.Dispose() }
}

function Get-SemAwsXmlError {
    # "Code: Message" from an AWS XML error body (S3 <Error>, query APIs <ErrorResponse><Error>), scrubbed.
    param([string]$Text)
    try {
        $x = New-SemXmlDocument $Text
        $code = $x.SelectSingleNode("//*[local-name()='Code']"); $msg = $x.SelectSingleNode("//*[local-name()='Message']")
        $t = (@($code, $msg) | Where-Object { $_ } | ForEach-Object { $_.InnerText }) -join ': '
        return (Get-SemLakeSafeText $t)
    } catch { return '' }
}

# ---------------------------------------------------------------------------
# Find RDS databases (DescribeDBInstances, DescribeDBClusters; query protocol, XML)
# ---------------------------------------------------------------------------
function ConvertTo-SemRdsEngine {
    # The engine name a sources.json entry takes for an RDS engine value, or $null for engines Semaphore does not read.
    param([string]$Engine)
    $e = ([string]$Engine).ToLowerInvariant()
    if ($script:SemRdsEngines.Contains($e)) { return $e }
    if ($e -eq 'aurora') { return 'aurora-mysql' }
    if ($e -like 'sqlserver-*' -or $e -like 'custom-sqlserver-*') { return 'sqlserver' }
    if ($e -like 'oracle-*' -or $e -like 'custom-oracle-*') { return 'oracle' }
    return $null
}

function New-SemRdsSuggestion {
    # A sources.json entry to copy for one endpoint (share names are placeholders the admin renames).
    param([string]$Id, [string]$Engine, [string]$HostName, [int]$Port, [string]$Database, [string]$Region, [bool]$Iam)
    $cleanId = (($Id.ToLowerInvariant() -replace '[^a-z0-9_-]', '-') -replace '-+', '-').Trim('-')
    if (-not $cleanId) { $cleanId = 'rds' }
    if ($cleanId.Length -gt 64) { $cleanId = $cleanId.Substring(0, 64) }
    $db = $Database
    if (-not $db) { $db = switch (Get-SemRdsFamily $Engine) { 'postgres' { 'postgres' } 'sqlserver' { 'master' } 'oracle' { 'ORCL' } default { 'mysql' } } }
    $s = [ordered]@{ id = $cleanId; label = $Id; kind = 'aws-rds'; provider = 'odbc'; engine = $Engine; host = $HostName; port = $Port; database = $db; region = $Region }
    if ($Iam -and @('postgres', 'mysql') -contains (Get-SemRdsFamily $Engine)) {
        $s.auth = 'iam'; $s.user = 'semaphore_ro'
        $s.vault = [ordered]@{ accessKeyId = 'AWS_ACCESS_KEY_ID'; secretAccessKey = 'AWS_SECRET_ACCESS_KEY'; sessionToken = 'AWS_SESSION_TOKEN' }
    } else {
        $s.auth = 'password'
        $s.vault = [ordered]@{ password = 'RDS_PASSWORD'; user = 'RDS_USER' }
    }
    return $s
}

function ConvertFrom-SemRdsDescribeXml {
    # The databases in one DescribeDBInstances or DescribeDBClusters answer: @{ Items; Marker }. Pure (tests use fixtures).
    param([string]$Text, [ValidateSet('instances', 'clusters')][string]$What, [string]$Region)
    $x = New-SemXmlDocument $Text
    $items = New-Object System.Collections.Generic.List[object]
    $node = if ($What -eq 'instances') { 'DBInstance' } else { 'DBCluster' }
    $get = { param($n, [string]$path) $v = $n.SelectSingleNode($path); if ($v) { [string]$v.InnerText } else { '' } }
    foreach ($n in $x.SelectNodes("//*[local-name()='$node']")) {
        $engine = ConvertTo-SemRdsEngine (& $get $n "*[local-name()='Engine']")
        if (-not $engine) { continue }
        $iam = (& $get $n "*[local-name()='IAMDatabaseAuthenticationEnabled']") -eq 'true'
        if ($What -eq 'instances') {
            $id = & $get $n "*[local-name()='DBInstanceIdentifier']"
            if (& $get $n "*[local-name()='DBClusterIdentifier']") { continue }   # an Aurora member: its cluster's endpoints are listed instead
            $hostName = & $get $n "*[local-name()='Endpoint']/*[local-name()='Address']"
            $portText = & $get $n "*[local-name()='Endpoint']/*[local-name()='Port']"
            $db = & $get $n "*[local-name()='DBName']"
            $reader = ''
        } else {
            $id = & $get $n "*[local-name()='DBClusterIdentifier']"
            $hostName = & $get $n "*[local-name()='Endpoint']"
            $reader = & $get $n "*[local-name()='ReaderEndpoint']"
            $portText = & $get $n "*[local-name()='Port']"
            $db = & $get $n "*[local-name()='DatabaseName']"
        }
        if (-not $hostName) { continue }
        $port = 0; [void][int]::TryParse($portText, [ref]$port)
        if ($port -le 0) { $port = $script:SemRdsDefaultPorts[(Get-SemRdsFamily $engine)] }
        # Read through the reader endpoint where a cluster has one: Semaphore only reads.
        $useHost = if ($reader) { $reader } else { $hostName }
        $items.Add([ordered]@{
            type = $(if ($What -eq 'instances') { 'instance' } else { 'cluster' }); id = $id; engine = $engine
            engineRaw = (& $get $n "*[local-name()='Engine']"); version = (& $get $n "*[local-name()='EngineVersion']")
            host = $hostName; readerHost = $reader; port = $port; database = $db; iam = $iam
            status = $(if ($What -eq 'instances') { & $get $n "*[local-name()='DBInstanceStatus']" } else { & $get $n "*[local-name()='Status']" })
            suggested = (New-SemRdsSuggestion -Id $id -Engine $engine -HostName $useHost -Port $port -Database $db -Region $Region -Iam $iam)
        })
    }
    $marker = $x.SelectSingleNode("//*[local-name()='Marker']")
    return @{ Items = $items.ToArray(); Marker = $(if ($marker -and $marker.InnerText) { [string]$marker.InnerText } else { $null }) }
}

function Invoke-SemRdsDescribe {
    # Every page of one Describe call (at most 20 pages of 100). Throws AWS's message on an error answer.
    param([string]$Region, [bool]$Fips = $false, [string]$Endpoint = '', [ValidateSet('instances', 'clusters')][string]$What)
    $origin = if ($Endpoint) { $Endpoint.TrimEnd('/') } else { 'https://' + (Get-SemAwsServiceHost -Service 'rds' -Region $Region -Fips $Fips) }
    $action = if ($What -eq 'instances') { 'DescribeDBInstances' } else { 'DescribeDBClusters' }
    $all = New-Object System.Collections.Generic.List[object]
    $marker = $null; $pages = 0
    do {
        $q = @{ Action = $action; Version = '2014-10-31'; MaxRecords = '100' }
        if ($marker) { $q.Marker = $marker }
        $r = Open-SemAwsResponse -Region $Region -Service 'rds' -Method 'GET' -Origin $origin -Path '/' -Query $q -TimeoutSec 30
        $status = $r.Status
        $text = Read-SemAwsResponseText $r
        if ($status -ne 200) { throw ("{0} answered {1}: {2}" -f $action, $status, (Get-SemAwsXmlError $text)) }
        $page = ConvertFrom-SemRdsDescribeXml -Text $text -What $What -Region $Region
        foreach ($i in $page.Items) { $all.Add($i) }
        $marker = $page.Marker; $pages++
    } while ($marker -and $pages -lt 20)
    return $all.ToArray()
}

function Find-SemRdsDatabases {
    # "Find RDS databases": instances and clusters in one region, with a sources.json entry to copy for each.
    param([string]$Region, [bool]$Fips = $false, [string]$Endpoint = '')
    if (-not (Test-SemAwsRegion $Region)) { throw 'Give a region such as us-gov-west-1.' }
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($w in @('clusters', 'instances')) { foreach ($i in @(Invoke-SemRdsDescribe -Region $Region -Fips $Fips -Endpoint $Endpoint -What $w)) { $out.Add($i) } }
    return $out.ToArray()
}
