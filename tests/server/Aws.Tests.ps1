# Pester 5. Amazon RDS / Aurora sources (server/Aws.ps1): SigV4 presigning against AWS's published examples, the RDS
# IAM auth token against the AWS SDK's own test vector and a fixed-date GovCloud token with a session, endpoints for
# GovCloud and FIPS, settings, driver detection and the missing-driver sentences, the ODBC connection string per engine
# (TLS on), read-only session statements, "Find RDS databases" from XML fixtures, and that no token or password reaches
# a message. No database and no AWS call: the driver list and the HTTP seam (Open-SemAwsResponse) are mocked.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Lake.ps1', 'Vault.ps1', 'Connectors.ps1', 'S3.ps1') { . ([IO.Path]::Combine($server, $f)) }
    $script:Inv = [Globalization.CultureInfo]::InvariantCulture
    function script:At([string]$Stamp) { return [datetime]::ParseExact($Stamp, "yyyyMMdd'T'HHmmss'Z'", $script:Inv, [Globalization.DateTimeStyles]::AdjustToUniversal) }
    function script:Raw([hashtable]$H) { return ($H | ConvertTo-Json -Depth 5 | ConvertFrom-Json) }
    function script:Rds([hashtable]$Extra = @{}) {
        $h = @{ id = 'maint'; kind = 'aws-rds'; provider = 'odbc'; engine = 'postgres'; host = 'maint.abc123.us-gov-west-1.rds.amazonaws.com'; database = 'maint'; region = 'us-gov-west-1'; auth = 'iam'; user = 'semaphore_ro' }
        foreach ($k in $Extra.Keys) { if ($null -eq $Extra[$k]) { $h.Remove($k) } else { $h[$k] = $Extra[$k] } }
        return (Raw $h)
    }
    function script:New-Home([object[]]$Sources) {
        $dir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir | Out-Null
        Set-Content -LiteralPath (Join-Path $dir 'sources.json') -Value (ConvertTo-Json -InputObject @($Sources) -Depth 6) -Encoding UTF8
        return $dir
    }
    function script:First-Source($Raw) { return @(Get-SemSources -HomeDir (New-Home @($Raw)))[0] }
    function script:Fake-Response([int]$Status, [string]$Text) {
        return @{ Status = $Status; Headers = @{ 'content-length' = [string][Text.Encoding]::UTF8.GetByteCount($Text) }; Stream = (New-Object IO.MemoryStream (, [Text.Encoding]::UTF8.GetBytes($Text))); Response = $null }
    }
    $script:Installed = @('SQL Server', 'PostgreSQL Unicode', 'PostgreSQL Unicode(x64)', 'PostgreSQL ANSI(x64)', 'MySQL ODBC 8.0 Unicode Driver', 'MySQL ODBC 8.4 Unicode Driver', 'MySQL ODBC 8.4 ANSI Driver', 'MariaDB ODBC 3.1 Driver', 'ODBC Driver 17 for SQL Server', 'ODBC Driver 18 for SQL Server', 'Oracle in instantclient_19_21', 'Oracle in instantclient_21_9')
    $script:Cred = @{ AccessKey = 'AKIDEXAMPLE'; SecretKey = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'; SessionToken = 'FQoGZXIvYXdzEXAMPLE/token+=' }
}

Describe 'SigV4 presigned query strings' {
    It 'matches the AWS documentation example for a presigned S3 GET (UNSIGNED-PAYLOAD)' {
        # "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)", examplebucket/test.txt.
        $p = New-SemAwsPresignedQuery -HostHeader 'examplebucket.s3.amazonaws.com' -Path '/test.txt' -Service 's3' -Region 'us-east-1' -AccessKey 'AKIAIOSFODNN7EXAMPLE' -SecretKey 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' -Now (At '20130524T000000Z') -ExpiresSec 86400 -PayloadHash 'UNSIGNED-PAYLOAD'
        $p.Signature | Should -Be 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
        $p.Query | Should -BeLike 'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=*'
    }
    It 'refuses an expiry outside 1 s to 7 days' {
        { New-SemAwsPresignedQuery -HostHeader 'h' -Service 's3' -Region 'us-east-1' -AccessKey 'a' -SecretKey 'b' -ExpiresSec 604801 } | Should -Throw '*7 days*'
    }
}

Describe 'RDS IAM auth token' {
    It 'matches the AWS SDK test vector (botocore generate_db_auth_token)' {
        $t = New-SemRdsAuthToken -Hostname 'prod-instance.us-east-1.rds.amazonaws.com' -Port 3306 -DbUser 'someusername' -Region 'us-east-1' -Credentials @{ AccessKey = 'akid'; SecretKey = 'skid'; SessionToken = '' } -Now (At '20161107T173933Z')
        $t | Should -BeLike 'prod-instance.us-east-1.rds.amazonaws.com:3306/?Action=connect&DBUser=someusername&*'
        $t | Should -Match 'X-Amz-Expires=900&'
        $t | Should -Match 'X-Amz-Credential=akid%2F20161107%2Fus-east-1%2Frds-db%2Faws4_request&'
        $t | Should -Match '&X-Amz-Signature=d1138cdbc0ca63eec012ec0fc6c2267e03642168f5884a7795320d4c18374c61$'
    }
    It 'signs a GovCloud token with a session token at a fixed date (checked against an independent SigV4 implementation)' {
        $t = New-SemRdsAuthToken -Hostname 'maint.abc123.us-gov-west-1.rds.amazonaws.com' -Port 5432 -DbUser 'semaphore_ro' -Region 'us-gov-west-1' -Credentials $script:Cred -Now (At '20261108T120000Z')
        $t | Should -Be 'maint.abc123.us-gov-west-1.rds.amazonaws.com:5432/?Action=connect&DBUser=semaphore_ro&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20261108%2Fus-gov-west-1%2Frds-db%2Faws4_request&X-Amz-Date=20261108T120000Z&X-Amz-Expires=900&X-Amz-Security-Token=FQoGZXIvYXdzEXAMPLE%2Ftoken%2B%3D&X-Amz-SignedHeaders=host&X-Amz-Signature=6837a533b2389064dbd8ea19edaf3616bc528a07e320ab559f1968f31b83442d'
        $t | Should -Not -Match '^https?:'
    }
    It 'changes with the clock, the user and the port (no reuse across sign-ins)' {
        $a = New-SemRdsAuthToken -Hostname 'h.example.com' -Port 5432 -DbUser 'u' -Region 'us-east-1' -Credentials $script:Cred -Now (At '20261108T120000Z')
        $b = New-SemRdsAuthToken -Hostname 'h.example.com' -Port 5432 -DbUser 'u' -Region 'us-east-1' -Credentials $script:Cred -Now (At '20261108T120001Z')
        $c = New-SemRdsAuthToken -Hostname 'h.example.com' -Port 5433 -DbUser 'u' -Region 'us-east-1' -Credentials $script:Cred -Now (At '20261108T120000Z')
        @($a, $b, $c | Select-Object -Unique).Count | Should -Be 3
    }
}

Describe 'Endpoints for GovCloud and FIPS' {
    It 'builds regional, FIPS and China hosts' {
        Get-SemAwsServiceHost -Service 'rds' -Region 'us-gov-west-1' | Should -Be 'rds.us-gov-west-1.amazonaws.com'
        Get-SemAwsServiceHost -Service 'rds' -Region 'us-gov-east-1' -Fips $true | Should -Be 'rds-fips.us-gov-east-1.amazonaws.com'
        Get-SemAwsServiceHost -Service 's3' -Region 'us-gov-west-1' -Fips $true | Should -Be 's3-fips.us-gov-west-1.amazonaws.com'
        Get-SemAwsServiceHost -Service 's3' -Region 'cn-north-1' | Should -Be 's3.cn-north-1.amazonaws.com.cn'
    }
    It 'refuses a bad region and FIPS in China' {
        { Get-SemAwsServiceHost -Service 'rds' -Region 'us-gov-west' } | Should -Throw '*not an AWS region*'
        { Get-SemAwsServiceHost -Service 'rds' -Region 'evil.com/x' } | Should -Throw
        { Get-SemAwsServiceHost -Service 's3' -Region 'cn-north-1' -Fips $true } | Should -Throw '*FIPS*'
    }
}

Describe 'RDS source settings' {
    It 'reads an IAM PostgreSQL source with the default port' {
        $r = Get-SemRdsSettings (Rds)
        $r.Family | Should -Be 'postgres'; $r.Port | Should -Be 5432; $r.Auth | Should -Be 'iam'; $r.User | Should -Be 'semaphore_ro'
    }
    It 'gives each engine family its default port' {
        (Get-SemRdsSettings (Rds @{ engine = 'aurora-mysql' })).Port | Should -Be 3306
        (Get-SemRdsSettings (Rds @{ engine = 'sqlserver'; auth = 'password'; vault = @{ password = 'RDS_PASSWORD'; user = 'RDS_USER' } })).Port | Should -Be 1433
        (Get-SemRdsSettings (Rds @{ engine = 'oracle'; auth = 'password'; vault = @{ password = 'RDS_PASSWORD' } })).Port | Should -Be 1521
    }
    It 'refuses what does not belong or does not fit' {
        { Get-SemRdsSettings (Rds @{ engine = 'db2' }) } | Should -Throw '*engine*'
        { Get-SemRdsSettings (Rds @{ connection = 'Driver={x};Server=y' }) } | Should -Throw '*no "connection"*'
        { Get-SemRdsSettings (Rds @{ password = 'hunter2' }) } | Should -Throw '*do not belong in sources.json*'
        { Get-SemRdsSettings (Rds @{ secretAccessKey = 'x' }) } | Should -Throw '*do not belong in sources.json*'
        { Get-SemRdsSettings (Rds @{ host = 'bad host;Server=evil' }) } | Should -Throw '*"host"*'
        { Get-SemRdsSettings (Rds @{ port = 70000 }) } | Should -Throw '*port*'
        { Get-SemRdsSettings (Rds @{ database = 'x;UID=sa' }) } | Should -Throw '*database*'
        { Get-SemRdsSettings (Rds @{ region = 'mars-1' }) } | Should -Throw '*region*'
        { Get-SemRdsSettings (Rds @{ engine = 'sqlserver' }) } | Should -Throw '*PostgreSQL, MySQL and MariaDB engines only*'
        { Get-SemRdsSettings (Rds @{ user = $null }) } | Should -Throw '*database user*'
        { Get-SemRdsSettings (Rds @{ auth = 'password' }) } | Should -Throw '*"vault" block*'
        { Get-SemRdsSettings (Rds @{ tcps = $true }) } | Should -Throw '*Oracle sources only*'
        { Get-SemRdsSettings (Rds @{ caBundle = 'relative.pem' }) } | Should -Throw '*full path*'
    }
    It 'lists valid aws-rds sources with their engine and skips invalid ones' {
        $homeDir = New-Home @(
            (Rds), (Rds @{ id = 'bad'; engine = 'nosql' }), (Rds @{ id = 'ole'; provider = 'oledb' }),
            (Rds @{ id = 'iamv'; vault = @{ accessKeyId = 'AWS_ACCESS_KEY_ID'; secretAccessKey = 'AWS_SECRET_ACCESS_KEY'; user = 'RDS_IAM_USER' } }),
            (Rds @{ id = 'pw'; engine = 'mariadb'; auth = 'password'; user = $null; vault = @{ password = 'RDS_PASSWORD'; user = 'RDS_USER' } }),
            (Rds @{ id = 'pwbad'; auth = 'password'; vault = @{ accessKeyId = 'AWS_ACCESS_KEY_ID'; secretAccessKey = 'X'; password = 'P' } }))
        $s = @(Get-SemSources -HomeDir $homeDir | Where-Object { $_.id -ne 'local' })   # the built-in local database is always last
        @($s | ForEach-Object { $_.id }) | Should -Be @('maint', 'iamv', 'pw')
        $s[0].engine | Should -Be 'postgres'; $s[0].kind | Should -Be 'aws-rds'; $s[0].provider | Should -Be 'odbc'
        (Test-SemSourceConnection $s[0]) | Should -BeNullOrEmpty -Because 'an aws-rds source builds its connection string itself'
        @((Get-SemVaultNeeds $s[1]).Roles | ForEach-Object { $_.Role }) | Should -Be @('accessKeyId', 'secretAccessKey', 'user')
        @((Get-SemVaultNeeds $s[2]).Roles | ForEach-Object { $_.Role }) | Should -Be @('password', 'user')
    }
    It 'tells the page the engine on /api/info, and nothing secret' {
        $script:Sem.Home = New-Home @((Rds), (Raw @{ id = 'plain'; kind = 'postgres'; provider = 'odbc'; connection = 'DSN=x' }))
        $info = Get-SemInfo
        $info.sources[0].engine | Should -Be 'postgres'
        $info.sources[1].Contains('engine') | Should -BeFalse
        $json = ConvertTo-Json $info -Depth 6
        $json | Should -Not -Match 'rds\.amazonaws\.com|semaphore_ro|DSN=' -Because 'the page gets id, label, kind, engine and provider only'
    }
}

Describe 'ODBC drivers already on this computer' {
    It 'picks the best installed driver per engine' {
        (Get-SemRdsDriverCandidates -Engine 'postgres' -Installed $script:Installed)[0] | Should -Be 'PostgreSQL Unicode(x64)'
        (Get-SemRdsDriverCandidates -Engine 'aurora-mysql' -Installed $script:Installed)[0] | Should -Be 'MySQL ODBC 8.4 Unicode Driver'
        (Get-SemRdsDriverCandidates -Engine 'mariadb' -Installed $script:Installed)[0] | Should -Be 'MariaDB ODBC 3.1 Driver'
        (Get-SemRdsDriverCandidates -Engine 'sqlserver' -Installed $script:Installed)[0] | Should -Be 'ODBC Driver 18 for SQL Server'
        (Get-SemRdsDriverCandidates -Engine 'oracle' -Installed $script:Installed)[0] | Should -Be 'Oracle in instantclient_21_9'
        @(Get-SemRdsDriverCandidates -Engine 'postgres' -Installed $script:Installed) | Should -Not -Contain 'PostgreSQL ANSI(x64)'
        @(Get-SemRdsDriverCandidates -Engine 'mysql' -Installed $script:Installed) | Should -Not -Contain 'MySQL ODBC 8.4 ANSI Driver'
        @(Get-SemRdsDriverCandidates -Engine 'sqlserver' -Installed @('SQL Server')).Count | Should -Be 0 -Because 'the old inbox driver has no TLS 1.2 certificate checks'
    }
    It 'says which driver is missing, per engine, and that Semaphore installs nothing' {
        foreach ($case in @(@('postgres', 'PostgreSQL Unicode(x64)'), @('mysql', 'MySQL ODBC 8.x Unicode Driver'), @('sqlserver', 'ODBC Driver 18 for SQL Server'), @('oracle', 'Oracle in instantclient'))) {
            $rds = Get-SemRdsSettings (Rds @{ engine = $case[0]; auth = 'password'; vault = @{ password = 'P_X' } })
            $e = $null
            try { [void](Find-SemRdsDriver -Rds $rds -Installed @('SQL Server')) } catch { $e = $_.Exception.Message }
            $e | Should -BeLike 'provider-unavailable: *'
            $e | Should -BeLike "*$($case[1])*"
            $e | Should -BeLike '*never installs drivers*'
        }
    }
    It 'uses a named driver only when it is installed and fits the engine' {
        $rds = Get-SemRdsSettings (Rds @{ driver = 'PostgreSQL Unicode' })
        Find-SemRdsDriver -Rds $rds -Installed $script:Installed | Should -Be 'PostgreSQL Unicode'
        { Find-SemRdsDriver -Rds (Get-SemRdsSettings (Rds @{ driver = 'PostgreSQL Unicode(x64) 17' })) -Installed $script:Installed } | Should -Throw '*not installed on this computer*'
        { Find-SemRdsDriver -Rds (Get-SemRdsSettings (Rds @{ driver = 'ODBC Driver 18 for SQL Server' })) -Installed $script:Installed } | Should -Throw '*does not reach postgres*'
    }
    It 'reads the registry list without failing (whatever is installed here)' {
        { @(Get-SemOdbcDriverNames) } | Should -Not -Throw
    }
}

Describe 'Connection strings per engine (TLS on)' {
    It 'PostgreSQL and Aurora PostgreSQL: SSLmode=require, or verify-full with the RDS bundle' {
        $cs = New-SemRdsConnectionString -Rds (Get-SemRdsSettings (Rds @{ engine = 'aurora-postgresql'; port = 5433 })) -Driver 'PostgreSQL Unicode(x64)' -User 'semaphore_ro' -Password 'tok}en'
        $cs | Should -Be 'Driver={PostgreSQL Unicode(x64)};Server=maint.abc123.us-gov-west-1.rds.amazonaws.com;Port=5433;Database=maint;SSLmode=require;UID={semaphore_ro};PWD={tok}}en}'
        $cs = New-SemRdsConnectionString -Rds (Get-SemRdsSettings (Rds @{ caBundle = 'C:\certs\global-bundle.pem' })) -Driver 'PostgreSQL Unicode(x64)'
        $cs | Should -BeLike '*;SSLmode=verify-full;pqopt={sslrootcert=C:\certs\global-bundle.pem}'
    }
    It 'MySQL and Aurora MySQL: SSLMODE=REQUIRED, the cleartext plugin for IAM tokens, VERIFY_IDENTITY with a bundle' {
        $cs = New-SemRdsConnectionString -Rds (Get-SemRdsSettings (Rds @{ engine = 'aurora-mysql' })) -Driver 'MySQL ODBC 8.4 Unicode Driver' -User 'u' -Password 'p'
        $cs | Should -Be 'Driver={MySQL ODBC 8.4 Unicode Driver};Server=maint.abc123.us-gov-west-1.rds.amazonaws.com;Port=3306;Database=maint;SSLMODE=REQUIRED;ENABLE_CLEARTEXT_PLUGIN=1;UID={u};PWD={p}'
        $pw = New-SemRdsConnectionString -Rds (Get-SemRdsSettings (Rds @{ engine = 'mysql'; auth = 'password'; vault = @{ password = 'P_X' }; caBundle = 'C:\certs\b.pem' })) -Driver 'MySQL ODBC 8.0 Unicode Driver'
        $pw | Should -BeLike '*;SSLMODE=VERIFY_IDENTITY;SSLCA={C:\certs\b.pem}'
        $pw | Should -Not -Match 'CLEARTEXT' -Because 'a password sign-in needs no cleartext plugin'
    }
    It 'MariaDB driver: FORCETLS=1 (and SSLVERIFY with a bundle)' {
        $cs = New-SemRdsConnectionString -Rds (Get-SemRdsSettings (Rds @{ engine = 'mariadb'; auth = 'password'; vault = @{ password = 'P_X' } })) -Driver 'MariaDB ODBC 3.1 Driver'
        $cs | Should -Be 'Driver={MariaDB ODBC 3.1 Driver};Server=maint.abc123.us-gov-west-1.rds.amazonaws.com;Port=3306;Database=maint;FORCETLS=1'
    }
    It 'SQL Server: encrypted, certificate checked, read intent' {
        $cs = New-SemRdsConnectionString -Rds (Get-SemRdsSettings (Rds @{ engine = 'sqlserver'; auth = 'password'; user = $null; vault = @{ password = 'P_X'; user = 'U_X' } })) -Driver 'ODBC Driver 18 for SQL Server' -User 'reader' -Password 'pw'
        $cs | Should -Be 'Driver={ODBC Driver 18 for SQL Server};Server=tcp:maint.abc123.us-gov-west-1.rds.amazonaws.com,1433;Database=maint;Encrypt=yes;TrustServerCertificate=no;ApplicationIntent=ReadOnly;Connection Timeout=30;UID={reader};PWD={pw}'
    }
    It 'Oracle: EZConnect, or a TCPS descriptor when "tcps" is set' {
        $o = Get-SemRdsSettings (Rds @{ engine = 'oracle'; auth = 'password'; database = 'ORCL'; vault = @{ password = 'P_X' } })
        New-SemRdsConnectionString -Rds $o -Driver 'Oracle in instantclient_21_9' | Should -Be 'Driver={Oracle in instantclient_21_9};Dbq=//maint.abc123.us-gov-west-1.rds.amazonaws.com:1521/ORCL'
        $t = Get-SemRdsSettings (Rds @{ engine = 'oracle'; auth = 'password'; database = 'ORCL'; port = 2484; tcps = $true; vault = @{ password = 'P_X' } })
        New-SemRdsConnectionString -Rds $t -Driver 'Oracle in instantclient_21_9' | Should -BeLike 'Driver={Oracle in instantclient_21_9};Dbq=(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=maint.abc123.us-gov-west-1.rds.amazonaws.com)(PORT=2484))(CONNECT_DATA=(SERVICE_NAME=ORCL)))*'
    }
    It 'refuses Lazarette values with control characters' {
        { New-SemRdsConnectionString -Rds (Get-SemRdsSettings (Rds)) -Driver 'PostgreSQL Unicode' -User 'u' -Password "a`r`nb" } | Should -Throw '*control characters*'
    }
    It 'sets a read-only session where the engine has one' {
        Get-SemRdsSessionStatements 'postgres' | Should -Contain 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY'
        Get-SemRdsSessionStatements 'mysql' | Should -Contain 'SET SESSION TRANSACTION READ ONLY'
        (Get-SemRdsSessionStatements 'mysql') -join ' ' | Should -Match 'ANSI_QUOTES'
        @(Get-SemRdsSessionStatements 'sqlserver').Count | Should -Be 0 -Because 'ApplicationIntent=ReadOnly is in the string'
        @(Get-SemRdsSessionStatements 'oracle').Count | Should -Be 0
    }
}

Describe 'The connection string for a request, and secrets' {
    BeforeEach {
        Mock Get-SemOdbcDriverNames { return $script:Installed }
        $script:SavedEnv = @{}
        foreach ($n in 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN') { $script:SavedEnv[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $null) }
    }
    AfterEach { Clear-SemVaultRequest; foreach ($n in $script:SavedEnv.Keys) { [Environment]::SetEnvironmentVariable($n, $script:SavedEnv[$n]) } }
    It 'signs a fresh IAM token with the session Lazarette shared, and scrubs it from messages' {
        $src = (First-Source (Rds @{ vault = @{ accessKeyId = 'AWS_ACCESS_KEY_ID'; secretAccessKey = 'AWS_SECRET_ACCESS_KEY'; sessionToken = 'AWS_SESSION_TOKEN' } }))
        Set-SemVaultRequest @{ Values = @{ accessKeyId = 'AKIDEXAMPLE'; secretAccessKey = 'SECRETSECRETSECRET'; sessionToken = 'SESSIONSESSION' }; Notes = @() }
        $cs = Get-SemEffectiveConnectionString -Source $src
        $cs | Should -Match '^Driver=\{PostgreSQL Unicode\(x64\)\};Server=maint\.abc123\.us-gov-west-1\.rds\.amazonaws\.com;Port=5432;Database=maint;SSLmode=require;UID=\{semaphore_ro\};PWD=\{maint\.abc123\.us-gov-west-1\.rds\.amazonaws\.com:5432/\?Action=connect&DBUser=semaphore_ro&'
        $cs | Should -Match 'X-Amz-Security-Token=SESSIONSESSION'
        $token = ([regex]::Match($cs, 'PWD=\{(.*)\}$')).Groups[1].Value
        $cs | Should -Not -Match 'SECRETSECRETSECRET'
        $msg = Get-SemSafeMessage -Message ('[psqlODBC] FATAL: PAM authentication failed for token ' + $token) -Source $src
        $msg | Should -Not -Match ([regex]::Escape($token))
        $msg | Should -Not -Match 'X-Amz-Signature'
        Clear-SemVaultRequest
        $script:SemVaultRequest | Should -BeNullOrEmpty
    }
    It 'uses the environment session when the source has no vault block' {
        [Environment]::SetEnvironmentVariable('AWS_ACCESS_KEY_ID', 'AKIDENV'); [Environment]::SetEnvironmentVariable('AWS_SECRET_ACCESS_KEY', 'ENVSECRETENVSECRET')
        $src = (First-Source (Rds @{ engine = 'mysql' }))
        $cs = Get-SemEffectiveConnectionString -Source $src
        $cs | Should -Match 'X-Amz-Credential=AKIDENV%2F'
        $cs | Should -Match 'ENABLE_CLEARTEXT_PLUGIN=1'
        (Get-SemVaultSafeText $cs) | Should -Not -Match 'X-Amz-Signature' -Because 'the token was registered for scrubbing even without a vault block'
    }
    It 'puts the Lazarette password in for password sign-in' {
        $src = (First-Source (Rds @{ engine = 'sqlserver'; auth = 'password'; user = $null; vault = @{ password = 'RDS_PASSWORD'; user = 'RDS_USER' } }))
        Set-SemVaultRequest @{ Values = @{ password = 'Pa;ss}word'; user = 'reader' }; Notes = @() }
        Get-SemEffectiveConnectionString -Source $src | Should -BeLike '*ApplicationIntent=ReadOnly;Connection Timeout=30;UID={reader};PWD={Pa;ss}}word}'
    }
    It 'answers 501 with the missing driver when connecting, without the connection string or a secret' {
        Mock Get-SemOdbcDriverNames { return @('SQL Server') }
        $src = (First-Source (Rds @{ engine = 'aurora-postgresql' }))
        [Environment]::SetEnvironmentVariable('AWS_ACCESS_KEY_ID', 'AKIDENV'); [Environment]::SetEnvironmentVariable('AWS_SECRET_ACCESS_KEY', 'ENVSECRETENVSECRET')
        $err = $null
        try { $c = New-SemConnection -Source $src } catch { $err = Get-SemQueryError -Exception $_.Exception -Source $src -Stage 'connect' }
        $err.Status | Should -Be 501
        $err.Code | Should -Be 'provider-unavailable'
        $err.Message | Should -BeLike '*PostgreSQL Unicode(x64)*psqlODBC*'
        $err.Message | Should -Not -Match 'ENVSECRET|Driver='
    }
}

Describe 'Find RDS databases' {
    BeforeAll {
        $script:InstancesXml = @'
<DescribeDBInstancesResponse xmlns="http://rds.amazonaws.com/doc/2014-10-31/"><DescribeDBInstancesResult><DBInstances>
<DBInstance><DBInstanceIdentifier>supply-sql</DBInstanceIdentifier><Engine>sqlserver-se</Engine><EngineVersion>16.00.4135.4.v1</EngineVersion><DBInstanceStatus>available</DBInstanceStatus><MasterUsername>admin</MasterUsername><Endpoint><Address>supply-sql.abc123.us-gov-west-1.rds.amazonaws.com</Address><Port>1433</Port></Endpoint><IAMDatabaseAuthenticationEnabled>false</IAMDatabaseAuthenticationEnabled></DBInstance>
<DBInstance><DBInstanceIdentifier>maint-aurora-1</DBInstanceIdentifier><DBClusterIdentifier>maint-aurora</DBClusterIdentifier><Engine>aurora-postgresql</Engine><Endpoint><Address>maint-aurora-1.abc123.us-gov-west-1.rds.amazonaws.com</Address><Port>5432</Port></Endpoint></DBInstance>
<DBInstance><DBInstanceIdentifier>parts-pg</DBInstanceIdentifier><Engine>postgres</Engine><EngineVersion>16.4</EngineVersion><DBName>parts</DBName><Endpoint><Address>parts-pg.abc123.us-gov-west-1.rds.amazonaws.com</Address><Port>5432</Port></Endpoint><IAMDatabaseAuthenticationEnabled>true</IAMDatabaseAuthenticationEnabled></DBInstance>
<DBInstance><DBInstanceIdentifier>creating</DBInstanceIdentifier><Engine>mysql</Engine></DBInstance>
</DBInstances><Marker>page2</Marker></DescribeDBInstancesResult></DescribeDBInstancesResponse>
'@
        $script:Instances2Xml = '<DescribeDBInstancesResponse xmlns="http://rds.amazonaws.com/doc/2014-10-31/"><DescribeDBInstancesResult><DBInstances><DBInstance><DBInstanceIdentifier>hr-maria</DBInstanceIdentifier><Engine>mariadb</Engine><Endpoint><Address>hr.abc123.us-gov-west-1.rds.amazonaws.com</Address><Port>3306</Port></Endpoint></DBInstance></DBInstances></DescribeDBInstancesResult></DescribeDBInstancesResponse>'
        $script:ClustersXml = @'
<DescribeDBClustersResponse xmlns="http://rds.amazonaws.com/doc/2014-10-31/"><DescribeDBClustersResult><DBClusters>
<DBCluster><DBClusterIdentifier>maint-aurora</DBClusterIdentifier><Engine>aurora-postgresql</Engine><EngineVersion>16.4</EngineVersion><Status>available</Status><DatabaseName>maint</DatabaseName><Endpoint>maint-aurora.cluster-abc123.us-gov-west-1.rds.amazonaws.com</Endpoint><ReaderEndpoint>maint-aurora.cluster-ro-abc123.us-gov-west-1.rds.amazonaws.com</ReaderEndpoint><Port>5432</Port><IAMDatabaseAuthenticationEnabled>true</IAMDatabaseAuthenticationEnabled></DBCluster>
<DBCluster><DBClusterIdentifier>docs</DBClusterIdentifier><Engine>docdb</Engine><Endpoint>docs.cluster-abc123.us-gov-west-1.docdb.amazonaws.com</Endpoint><Port>27017</Port></DBCluster>
</DBClusters></DescribeDBClustersResult></DescribeDBClustersResponse>
'@
    }
    It 'reads instances: cluster members and engines Semaphore does not read are left out' {
        $p = ConvertFrom-SemRdsDescribeXml -Text $script:InstancesXml -What 'instances' -Region 'us-gov-west-1'
        @($p.Items | ForEach-Object { $_.id }) | Should -Be @('supply-sql', 'parts-pg')
        $p.Marker | Should -Be 'page2'
        $p.Items[0].engine | Should -Be 'sqlserver'; $p.Items[0].suggested.auth | Should -Be 'password'; $p.Items[0].suggested.database | Should -Be 'master'
        $p.Items[1].suggested.auth | Should -Be 'iam'; $p.Items[1].suggested.database | Should -Be 'parts'
        $p.Items[1].suggested.vault.accessKeyId | Should -Be 'AWS_ACCESS_KEY_ID'
        (ConvertTo-Json $p.Items -Depth 6) | Should -Not -Match 'admin' -Because 'the master user name is not passed on'
    }
    It 'reads clusters and suggests the reader endpoint' {
        $p = ConvertFrom-SemRdsDescribeXml -Text $script:ClustersXml -What 'clusters' -Region 'us-gov-west-1'
        @($p.Items).Count | Should -Be 1
        $p.Items[0].readerHost | Should -Be 'maint-aurora.cluster-ro-abc123.us-gov-west-1.rds.amazonaws.com'
        $p.Items[0].suggested.host | Should -Be 'maint-aurora.cluster-ro-abc123.us-gov-west-1.rds.amazonaws.com'
        $p.Items[0].suggested.engine | Should -Be 'aurora-postgresql'
        $p.Marker | Should -BeNullOrEmpty
        # The suggestion is a valid aws-rds entry as it stands.
        { Get-SemRdsSettings (Raw ([hashtable]$p.Items[0].suggested)) } | Should -Not -Throw
    }
    It 'refuses an XML answer with a DTD' {
        { ConvertFrom-SemRdsDescribeXml -Text '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///c:/windows/win.ini">]><x>&e;</x>' -What 'instances' -Region 'us-east-1' } | Should -Throw
    }
    It 'pages with Marker over the FIPS endpoint, signing service rds, and lists clusters and instances' {
        $script:Calls = New-Object Collections.ArrayList
        Mock Open-SemAwsResponse {
            [void]$script:Calls.Add(@{ Origin = $Origin; Service = $Service; Region = $Region; Query = $Query.Clone() })
            if ($Query.Action -eq 'DescribeDBClusters') { return (Fake-Response 200 $script:ClustersXml) }
            if ($Query.Marker -eq 'page2') { return (Fake-Response 200 $script:Instances2Xml) }
            return (Fake-Response 200 $script:InstancesXml)
        }
        $found = @(Find-SemRdsDatabases -Region 'us-gov-west-1' -Fips $true)
        @($found | ForEach-Object { $_.id }) | Should -Be @('maint-aurora', 'supply-sql', 'parts-pg', 'hr-maria')
        $script:Calls.Count | Should -Be 3
        $script:Calls[0].Origin | Should -Be 'https://rds-fips.us-gov-west-1.amazonaws.com'
        $script:Calls[0].Service | Should -Be 'rds'
        $script:Calls[2].Query.Marker | Should -Be 'page2'
        $script:Calls[1].Query.Version | Should -Be '2014-10-31'
    }
    It 'passes on AWS''s error, scrubbed' {
        Mock Open-SemAwsResponse { return (Fake-Response 403 '<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>User is not authorized to perform: rds:DescribeDBClusters</Message></Error></ErrorResponse>') }
        { Find-SemRdsDatabases -Region 'us-gov-west-1' } | Should -Throw '*DescribeDBClusters answered 403: AccessDenied: User is not authorized*'
    }
}
