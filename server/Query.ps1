#requires -Version 5.1
# =============================================================================
# Semaphore data connectors: /api/query and /api/profile.
#
# Sources are declared in <home>\sources.json:
#   [{ "id": "maint", "label": "Maintenance warehouse", "kind": "postgres",
#      "provider": "odbc", "connection": "DSN=MaintWarehouse" }]
# Providers: odbc (System.Data.Odbc) and oledb (System.Data.OleDb, e.g. Access through the ACE
# provider already on the machine). Both ship with .NET Framework: no third-party DLLs.
# A connection string with PWD= or Password= is refused: credentials belong in the DSN, integrated
# authentication or Lazarette (a "vault" block names the shares Lazarette gives Semaphore; see Vault.ps1). Connection strings are never logged or returned.
#
# SQL comes from Semaphore's own planner; the guard below is defence in depth: one SELECT, no ';',
# '--' or '/*', at most 100 KB and 2000 parameters. Values are always bound ('?' placeholders).
# Requests run on a runspace pool (Initialize-SemWorkers) so a slow source never blocks the loop.
# =============================================================================

$script:SemSqlMaxChars = 102400
$script:SemMaxParams = 2000
$script:SemIdentifierRx = '\A[A-Za-z_][A-Za-z0-9_ ]{0,127}(\.[A-Za-z_][A-Za-z0-9_ ]{0,127})?\z'

# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------
function Test-SemConnectionString {
    # $null when acceptable, else the reason it is refused.
    param([string]$Connection)
    if ([string]::IsNullOrWhiteSpace($Connection)) { return 'The source has no connection string.' }
    if ($Connection -match '(?i)(^|;)\s*(PWD|Password)\s*=') {
        return 'The connection string contains a password (PWD= or Password=). Semaphore refuses it: keep credentials in the ODBC DSN, use integrated authentication, or share the password from Lazarette with a "vault" block (docs/VAULT.md).'
    }
    return $null
}

function Get-SemSources {
    # Valid entries of <home>\sources.json (invalid ones are skipped and logged). Never returned to the browser whole.
    param([string]$HomeDir)
    $f = Join-Path $HomeDir 'sources.json'
    if (-not [IO.File]::Exists($f)) { return @() }
    try { $j = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop }
    catch { Write-SemLog 'WARN' 'sources.json is not valid JSON; no sources loaded'; return @() }
    $out = New-Object System.Collections.Generic.List[object]
    $seen = @{}
    foreach ($s in @($j)) {
        if ($s -isnot [Management.Automation.PSCustomObject]) { continue }
        $id = [string]$s.id
        if ($id -cnotmatch '\A[A-Za-z0-9_-]{1,64}\z') { Write-SemLog 'WARN' 'sources.json: skipping a source with an invalid id'; continue }
        if ($seen.ContainsKey($id)) { Write-SemLog 'WARN' "sources.json: duplicate source id '$id' skipped"; continue }
        $provider = ([string]$s.provider).ToLowerInvariant()
        $raw = $provider
        if (@('odbc', 'oledb', 'athena', 'redshift-data', 'foundry', 'synapse') -notcontains $provider) { Write-SemLog 'WARN' "sources.json: source '$id' has an unknown provider (use odbc, oledb, athena, redshift-data, foundry or synapse)"; continue }
        if ($provider -eq 'athena') { try { [void](Get-SemLakeSettings $s) } catch { Write-SemLog 'WARN' ("sources.json: lake source '$id' skipped: " + $_.Exception.Message); continue } }
        $connection = [string]$s.connection
        try {
            if ($provider -eq 'redshift-data') { [void](Get-SemRedshiftSettings $s) }
            elseif ($provider -eq 'foundry') { [void](Get-SemFoundrySettings $s) }
            elseif ($provider -eq 'synapse') { $connection = New-SemSynapseConnection $s; $provider = 'odbc' }   # an ODBC source from here on
        } catch { Write-SemLog 'WARN' ("sources.json: source '$id' skipped: " + $_.Exception.Message); continue }
        $badVault = Test-SemVaultBlock -Raw $s -Provider $provider
        if ($badVault) { Write-SemLog 'WARN' ("sources.json: source '$id' skipped: " + $badVault); continue }
        $label = [string]$s.label; if (-not $label) { $label = $id }
        $kind = ([string]$s.kind).ToLowerInvariant(); if (-not $kind) { $kind = 'other' }
        if ($raw -eq 'synapse' -and $kind -eq 'other') { $kind = 'azure-synapse' }
        $seen[$id] = $true
        # raw keeps the entry for providers with their own settings (athena); it is never sent to the browser.
        $out.Add([pscustomobject]@{ id = $id; label = $label; kind = $kind; provider = $provider; connection = $connection; raw = $s })
    }
    return $out.ToArray()
}

function Find-SemSource {
    param([string]$HomeDir, [string]$Id)
    foreach ($s in @(Get-SemSources -HomeDir $HomeDir)) { if ($s.id -ceq $Id) { return $s } }
    return $null
}

# ---------------------------------------------------------------------------
# Guard, parameters, identifiers
# ---------------------------------------------------------------------------
# Statement keywords that never belong in a read. T-SQL (SQL Server, Synapse) needs no ';' between statements, so
# "SELECT 1 EXEC sp_who" is two statements: these are refused wherever they stand outside a quoted string or a
# quoted identifier. The database's read-only login is the real control (docs/VAULT.md); this is defence in depth.
$script:SemSqlRefusedWordsRx = '(?i)\b(EXEC|EXECUTE|DROP|ALTER|CREATE|INSERT|UPDATE|DELETE|MERGE|TRUNCATE|GRANT|REVOKE|DENY|BACKUP|RESTORE|DBCC|GO|INTO)\b'

function Remove-SemSqlQuoted {
    # The SQL with the inside of every 'string', "name", [name] and `name` blanked (doubled closers stay inside),
    # so a keyword check sees only the statement itself.
    param([string]$Sql)
    $sb = New-Object Text.StringBuilder $Sql.Length
    $close = [char]0
    foreach ($ch in $Sql.ToCharArray()) {
        if ($close -ne [char]0) {
            if ($ch -eq $close) { $close = [char]0; [void]$sb.Append($ch) } else { [void]$sb.Append(' ') }
            continue
        }
        if ($ch -eq "'" -or $ch -eq '"' -or $ch -eq '`') { $close = $ch }
        elseif ($ch -eq '[') { $close = ']' }
        [void]$sb.Append($ch)
    }
    return $sb.ToString()
}

function Test-SemSqlGuard {
    # $null when the SQL may run, else the reason it is refused.
    param([string]$Sql)
    if ($null -eq $Sql) { return 'No SQL.' }
    $t = $Sql.Trim()
    if ($t.Length -eq 0) { return 'No SQL.' }
    if ($t.Length -gt $script:SemSqlMaxChars) { return 'The SQL is longer than 100 KB.' }
    if ($t -notmatch '^(?i)select\b') { return 'Only a single SELECT statement is allowed.' }
    if ($t.Contains(';')) { return 'The SQL may not contain ";".' }
    if ($t.Contains('--')) { return 'The SQL may not contain "--".' }
    if ($t.Contains('/*')) { return 'The SQL may not contain "/*".' }
    # SELECT ... INTO creates a table in SQL Server and Access, and T-SQL runs "SELECT 1 DROP TABLE t" as two
    # statements without a ';': refuse every statement keyword that stands outside quotes.
    $bare = Remove-SemSqlQuoted $t
    $m = [regex]::Match($bare, $script:SemSqlRefusedWordsRx)
    if ($m.Success) {
        $word = $m.Groups[1].Value.ToUpperInvariant()
        if ($word -eq 'INTO') { return 'The SQL may not contain INTO: Semaphore only reads.' }
        return ('The SQL may not contain ' + $word + ': Semaphore only reads, one SELECT at a time.')
    }
    return $null
}

function ConvertTo-SemParamValue {
    # { value, type } -> @{ Type; Value } with a typed .NET value (DBNull for null). Throws a readable message.
    param($Param, [int]$Index = 0)
    $n = $Index + 1
    if ($Param -isnot [Management.Automation.PSCustomObject]) { throw "Parameter $n must be an object { value, type }." }
    $type = ([string](Get-SemJsonProp $Param 'type')).ToLowerInvariant()
    $raw = Get-SemJsonProp $Param 'value'
    if (@('date', 'number', 'boolean', 'string') -notcontains $type) { throw "Parameter $n has an unknown type (use date, number, boolean or string)." }
    if ($null -eq $raw) { return @{ Type = $type; Value = [DBNull]::Value } }
    $inv = [Globalization.CultureInfo]::InvariantCulture
    switch ($type) {
        'date' {
            if ($raw -is [datetime]) { return @{ Type = $type; Value = [datetime]::SpecifyKind($raw, [DateTimeKind]::Unspecified) } }
            $d = [datetime]::MinValue
            $formats = [string[]]@('yyyy-MM-dd', 'yyyy-MM-ddTHH:mm:ss', 'yyyy-MM-ddTHH:mm:ss.fff', 'yyyy-MM-ddTHH:mm:ssZ', 'yyyy-MM-ddTHH:mm:ss.fffZ')
            if (-not [datetime]::TryParseExact([string]$raw, $formats, $inv, [Globalization.DateTimeStyles]::None, [ref]$d)) { throw "Parameter $n is not a date (yyyy-MM-dd)." }
            return @{ Type = $type; Value = $d }
        }
        'number' {
            if ($raw -is [bool]) { throw "Parameter $n is not a number." }
            $x = 0.0
            if ($raw -is [string]) {
                if (-not [double]::TryParse($raw, [Globalization.NumberStyles]::Float, $inv, [ref]$x)) { throw "Parameter $n is not a number." }
            } else {
                try { $x = [double]$raw } catch { throw "Parameter $n is not a number." }
            }
            if ([double]::IsNaN($x) -or [double]::IsInfinity($x)) { throw "Parameter $n is not a finite number." }
            return @{ Type = $type; Value = $x }
        }
        'boolean' {
            if ($raw -is [bool]) { return @{ Type = $type; Value = [bool]$raw } }
            if ($raw -is [string] -and @('true', 'false') -contains $raw.ToLowerInvariant()) { return @{ Type = $type; Value = ($raw.ToLowerInvariant() -eq 'true') } }
            throw "Parameter $n is not a boolean."
        }
        default {
            if ($raw -isnot [string] -and $raw -isnot [ValueType]) { throw "Parameter $n is not a string." }
            if ($raw -is [datetime]) { return @{ Type = $type; Value = $raw.ToString('yyyy-MM-ddTHH:mm:ss', $inv) } }
            return @{ Type = $type; Value = [Convert]::ToString($raw, $inv) }
        }
    }
}

function Test-SemIdentifier {
    # Same rule as isIdentifier() in src/core/catalog.ts.
    param([string]$Name)
    return ($Name -cmatch $script:SemIdentifierRx)
}

function Get-SemQuotedName {
    # Quotes a (possibly schema-qualified) name: [a].[b] for OLE DB / Access, "a"."b" otherwise.
    param([string]$Name, [bool]$Brackets)
    $parts = @(foreach ($part in ($Name -split '\.')) {
        if ($Brackets) { '[' + $part.Replace(']', ']]') + ']' } else { '"' + $part.Replace('"', '""') + '"' }
    })
    return ($parts -join '.')
}

function Get-SemQuotedColumn {
    # A column name reported by the database (never split on '.').
    param([string]$Name, [bool]$Brackets)
    if ($Brackets) { return ('[' + $Name.Replace(']', ']]') + ']') }
    return ('"' + $Name.Replace('"', '""') + '"')
}

function Test-SemUsesBrackets {
    param($Source)
    return ($Source.provider -eq 'oledb' -or $Source.kind -eq 'access')
}

function Get-SemBoundedInt {
    param($Value, [int]$Default, [int]$Min, [int]$Max)
    if ($null -eq $Value) { return $Default }
    $n = 0
    try { $n = [int][double]$Value } catch { return $Default }
    if ($n -lt $Min) { return $Min }
    if ($n -gt $Max) { return $Max }
    return $n
}

function Get-SemSafeMessage {
    # A driver message with the connection string (and anything password-like) removed.
    param([string]$Message, $Source)
    if (-not $Message) { return 'The source reported an error.' }
    $m = Get-SemVaultSafeText $Message
    if ($Source -and $Source.connection) { $m = $m.Replace([string]$Source.connection, '<connection>') }
    $m = [regex]::Replace($m, '(?i)(PWD|Password|UID|User ID)\s*=\s*[^;\s]*', '$1=***')
    $m = $m.Trim()
    if ($m.Length -gt 600) { $m = $m.Substring(0, 600) + '...' }
    return $m
}

# ---------------------------------------------------------------------------
# JSON writer for data readers (C# via Add-Type, with a PowerShell fallback)
# ---------------------------------------------------------------------------
$script:SemJsonSource = @'
using System;
using System.Data;
using System.Globalization;
using System.Text;

public static class SemaphoreJson
{
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public static string Quote(string s)
    {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                default:
                    if (c < 0x20 || c == (char)0x2028 || c == (char)0x2029 || c == '<' || c == '>' || c == '&')
                        sb.Append("\\u").Append(((int)c).ToString("x4", Inv));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    public static string Date(DateTime d)
    {
        if (d.TimeOfDay == TimeSpan.Zero) return d.ToString("yyyy-MM-dd", Inv);
        return d.ToString("yyyy-MM-dd'T'HH:mm:ss", Inv);
    }

    public static string Value(object v)
    {
        if (v == null || v is DBNull) return "null";
        if (v is string) return Quote((string)v);
        if (v is bool) return ((bool)v) ? "true" : "false";
        if (v is DateTime) return Quote(Date((DateTime)v));
        if (v is DateTimeOffset) return Quote(Date(((DateTimeOffset)v).DateTime));
        if (v is double)
        {
            double x = (double)v;
            if (double.IsNaN(x) || double.IsInfinity(x)) return "null";
            return x.ToString("R", Inv);
        }
        if (v is float)
        {
            float f = (float)v;
            if (float.IsNaN(f) || float.IsInfinity(f)) return "null";
            return ((double)f).ToString("R", Inv);
        }
        if (v is decimal) return ((decimal)v).ToString(Inv);
        if (v is int || v is long || v is short || v is byte || v is sbyte || v is uint || v is ulong || v is ushort)
            return Convert.ToString(v, Inv);
        if (v is byte[]) return "null";
        if (v is TimeSpan) return Quote(((TimeSpan)v).ToString("c", Inv));
        IFormattable fm = v as IFormattable;
        if (fm != null) return Quote(fm.ToString(null, Inv));
        return Quote(v.ToString());
    }

    // Text for a profile sample: dates in ISO form, numbers invariant, null for DBNull.
    public static string Text(object v)
    {
        if (v == null || v is DBNull || v is byte[]) return null;
        if (v is string) return (string)v;
        if (v is DateTime) return Date((DateTime)v);
        if (v is DateTimeOffset) return Date(((DateTimeOffset)v).DateTime);
        if (v is bool) return ((bool)v) ? "true" : "false";
        IFormattable fm = v as IFormattable;
        if (fm != null) return fm.ToString(null, Inv);
        return v.ToString();
    }

    // Writes {"columns":[...],"rows":[...],"truncated":b, then the caller adds "ms" and "}".
    // Reads at most cap rows; truncated is true when another row was waiting.
    public static bool WriteResult(IDataReader r, int cap, StringBuilder sb)
    {
        int n = r.FieldCount;
        string[] keys = new string[n];
        sb.Append("{\"columns\":[");
        for (int i = 0; i < n; i++)
        {
            string name = r.GetName(i);
            if (i > 0) sb.Append(',');
            sb.Append(Quote(name));
            keys[i] = Quote(name) + ":";
        }
        sb.Append("],\"rows\":[");
        int count = 0;
        bool truncated = false;
        while (r.Read())
        {
            if (count >= cap) { truncated = true; break; }
            if (count > 0) sb.Append(',');
            sb.Append('{');
            for (int i = 0; i < n; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(keys[i]);
                object v;
                try { v = r.GetValue(i); } catch { v = null; }
                sb.Append(Value(v));
            }
            sb.Append('}');
            count++;
        }
        sb.Append("],\"truncated\":").Append(truncated ? "true" : "false");
        return truncated;
    }
}
'@

$script:SemJsonMode = ''

function Initialize-SemJsonWriter {
    # 'csharp' when the helper compiled (or already exists in this AppDomain), else 'powershell'.
    param([switch]$ForcePowerShell)
    if ($ForcePowerShell) { $script:SemJsonMode = 'powershell'; return $script:SemJsonMode }
    if ('SemaphoreJson' -as [type]) { $script:SemJsonMode = 'csharp'; return $script:SemJsonMode }
    try {
        Add-Type -TypeDefinition $script:SemJsonSource -Language CSharp -ReferencedAssemblies @('System.Data') -ErrorAction Stop
        $script:SemJsonMode = 'csharp'
    } catch {
        try {
            Add-Type -TypeDefinition $script:SemJsonSource -Language CSharp -ErrorAction Stop
            $script:SemJsonMode = 'csharp'
        } catch {
            Write-SemLog 'WARN' ('C# JSON helper unavailable (' + $_.Exception.Message + '); using the slower PowerShell writer')
            $script:SemJsonMode = 'powershell'
        }
    }
    return $script:SemJsonMode
}

function ConvertTo-SemJsonString {
    param([string]$Text)
    if ($null -eq $Text) { return 'null' }
    $sb = New-Object Text.StringBuilder ($Text.Length + 2)
    [void]$sb.Append('"')
    foreach ($c in $Text.ToCharArray()) {
        $code = [int]$c
        switch ($c) {
            '"' { [void]$sb.Append('\"'); continue }
            '\' { [void]$sb.Append('\\'); continue }
            "`n" { [void]$sb.Append('\n'); continue }
            "`r" { [void]$sb.Append('\r'); continue }
            "`t" { [void]$sb.Append('\t'); continue }
            default {
                if ($code -lt 32 -or $code -eq 0x2028 -or $code -eq 0x2029 -or $c -eq '<' -or $c -eq '>' -or $c -eq '&') { [void]$sb.Append('\u' + $code.ToString('x4')) }
                else { [void]$sb.Append($c) }
            }
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Format-SemDate {
    param([datetime]$D)
    $inv = [Globalization.CultureInfo]::InvariantCulture
    if ($D.TimeOfDay -eq [TimeSpan]::Zero) { return $D.ToString('yyyy-MM-dd', $inv) }
    return $D.ToString("yyyy-MM-dd'T'HH:mm:ss", $inv)
}

function ConvertTo-SemJsonValue {
    param($V)
    if ($script:SemJsonMode -eq 'csharp') { return [SemaphoreJson]::Value($V) }
    $inv = [Globalization.CultureInfo]::InvariantCulture
    if ($null -eq $V -or $V -is [DBNull]) { return 'null' }
    if ($V -is [string]) { return (ConvertTo-SemJsonString $V) }
    if ($V -is [bool]) { if ($V) { return 'true' } else { return 'false' } }
    if ($V -is [datetime]) { return (ConvertTo-SemJsonString (Format-SemDate $V)) }
    if ($V -is [DateTimeOffset]) { return (ConvertTo-SemJsonString (Format-SemDate $V.DateTime)) }
    if ($V -is [double] -or $V -is [single]) {
        $x = [double]$V
        if ([double]::IsNaN($x) -or [double]::IsInfinity($x)) { return 'null' }
        return $x.ToString('R', $inv)
    }
    if ($V -is [decimal]) { return $V.ToString($inv) }
    if ($V -is [int] -or $V -is [long] -or $V -is [int16] -or $V -is [byte] -or $V -is [sbyte] -or $V -is [uint32] -or $V -is [uint64] -or $V -is [uint16]) { return [Convert]::ToString($V, $inv) }
    if ($V -is [byte[]]) { return 'null' }
    if ($V -is [TimeSpan]) { return (ConvertTo-SemJsonString $V.ToString('c', $inv)) }
    if ($V -is [IFormattable]) { return (ConvertTo-SemJsonString $V.ToString($null, $inv)) }
    return (ConvertTo-SemJsonString $V.ToString())
}

function ConvertTo-SemSampleText {
    param($V)
    if ($script:SemJsonMode -eq 'csharp') { return [SemaphoreJson]::Text($V) }
    if ($null -eq $V -or $V -is [DBNull] -or $V -is [byte[]]) { return $null }
    if ($V -is [string]) { return $V }
    if ($V -is [datetime]) { return (Format-SemDate $V) }
    if ($V -is [DateTimeOffset]) { return (Format-SemDate $V.DateTime) }
    if ($V -is [bool]) { if ($V) { return 'true' } else { return 'false' } }
    if ($V -is [IFormattable]) { return $V.ToString($null, [Globalization.CultureInfo]::InvariantCulture) }
    return $V.ToString()
}

function Write-SemReaderResult {
    # Appends {"columns":[...],"rows":[...],"truncated":b to $Sb; returns truncated.
    param([Parameter(Mandatory = $true)][Data.IDataReader]$Reader, [int]$RowCap, [Parameter(Mandatory = $true)][Text.StringBuilder]$Sb)
    if (-not $script:SemJsonMode) { [void](Initialize-SemJsonWriter) }
    if ($script:SemJsonMode -eq 'csharp') { return [SemaphoreJson]::WriteResult($Reader, $RowCap, $Sb) }
    $n = $Reader.FieldCount
    $keys = New-Object string[] $n
    [void]$Sb.Append('{"columns":[')
    for ($i = 0; $i -lt $n; $i++) {
        $q = ConvertTo-SemJsonString $Reader.GetName($i)
        if ($i -gt 0) { [void]$Sb.Append(',') }
        [void]$Sb.Append($q)
        $keys[$i] = $q + ':'
    }
    [void]$Sb.Append('],"rows":[')
    $count = 0; $truncated = $false
    while ($Reader.Read()) {
        if ($count -ge $RowCap) { $truncated = $true; break }
        if ($count -gt 0) { [void]$Sb.Append(',') }
        [void]$Sb.Append('{')
        for ($i = 0; $i -lt $n; $i++) {
            if ($i -gt 0) { [void]$Sb.Append(',') }
            [void]$Sb.Append($keys[$i])
            $v = $null
            try { $v = $Reader.GetValue($i) } catch { $v = $null }
            [void]$Sb.Append((ConvertTo-SemJsonValue $v))
        }
        [void]$Sb.Append('}')
        $count++
    }
    [void]$Sb.Append('],"truncated":')
    if ($truncated) { [void]$Sb.Append('true') } else { [void]$Sb.Append('false') }
    return $truncated
}

# ---------------------------------------------------------------------------
# Connections and commands
# ---------------------------------------------------------------------------
function Get-SemEffectiveConnectionString {
    # The string handed to the driver: sources.json's connection (never a password), read-only flags, and the
    # user and password Lazarette shares for the source. Lives in memory for the call; never logged or returned.
    param([Parameter(Mandatory = $true)]$Source)
    $cs = [string]$Source.connection
    if ($Source.provider -eq 'odbc') {
        if ($Source.kind -eq 'access' -and $cs -notmatch '(?i)(^|;)\s*ReadOnly\s*=') { $cs = $cs.TrimEnd(';') + ';ReadOnly=1' }
    } elseif ($Source.provider -eq 'oledb') {
        if ($cs -notmatch '(?i)(^|;)\s*Mode\s*=') { $cs = $cs.TrimEnd(';') + ';Mode=Read' }
    }
    $vals = $null
    if ($null -ne $script:SemVaultRequest) { $vals = $script:SemVaultRequest.Values }
    if ($null -ne (Get-SemSourceVault $Source)) {
        if ($null -eq $vals) { throw 'The Lazarette secrets for this source were not resolved.' }
        $cs = Add-SemVaultToConnectionString -ConnectionString $cs -Provider ([string]$Source.provider) -Values $vals
    }
    return $cs
}

function New-SemConnection {
    # An open, read-only-where-possible connection. Throws 'provider-unavailable:' when the provider type is missing.
    param([Parameter(Mandatory = $true)]$Source, [int]$TimeoutSec = 30)
    $cs = Get-SemEffectiveConnectionString -Source $Source
    $conn = $null
    if ($Source.provider -eq 'odbc') {
        if (-not ('System.Data.Odbc.OdbcConnection' -as [type])) { try { Add-Type -AssemblyName System.Data } catch { } }
        if (-not ('System.Data.Odbc.OdbcConnection' -as [type])) { throw 'provider-unavailable: System.Data.Odbc is not available in this PowerShell.' }
        $conn = New-Object System.Data.Odbc.OdbcConnection $cs
        try { $conn.ConnectionTimeout = [Math]::Min(60, $TimeoutSec) } catch { }
    } else {
        if (-not ('System.Data.OleDb.OleDbConnection' -as [type])) { try { Add-Type -AssemblyName System.Data } catch { } }
        if (-not ('System.Data.OleDb.OleDbConnection' -as [type])) { throw 'provider-unavailable: System.Data.OleDb is not available in this PowerShell.' }
        $conn = New-Object System.Data.OleDb.OleDbConnection $cs
    }
    $conn.Open()
    if ($Source.kind -eq 'postgres') {
        # Read-only session, and UTC so date_trunc on timestamptz matches the planner's UTC buckets.
        foreach ($stmt in @('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY', "SET TIME ZONE 'UTC'")) {
            try { $c = $conn.CreateCommand(); $c.CommandText = $stmt; $c.CommandTimeout = 10; [void]$c.ExecuteNonQuery(); $c.Dispose() } catch { }
        }
    }
    return $conn
}

function Add-SemCommandParameter {
    param([Parameter(Mandatory = $true)]$Command, [Parameter(Mandatory = $true)][hashtable]$Typed, [int]$Index)
    $p = $Command.CreateParameter()
    $p.ParameterName = 'p' + ($Index + 1)
    $isOdbc = $Command.GetType().FullName -eq 'System.Data.Odbc.OdbcCommand'
    $isOleDb = $Command.GetType().FullName -eq 'System.Data.OleDb.OleDbCommand'
    switch ($Typed.Type) {
        'date' {
            if ($isOleDb) { $p.OleDbType = [System.Data.OleDb.OleDbType]::Date }
            elseif ($isOdbc) { $p.OdbcType = [System.Data.Odbc.OdbcType]::DateTime }
            else { $p.DbType = [Data.DbType]::DateTime }
        }
        'number' {
            if ($isOleDb) { $p.OleDbType = [System.Data.OleDb.OleDbType]::Double }
            elseif ($isOdbc) { $p.OdbcType = [System.Data.Odbc.OdbcType]::Double }
            else { $p.DbType = [Data.DbType]::Double }
        }
        'boolean' {
            if ($isOleDb) { $p.OleDbType = [System.Data.OleDb.OleDbType]::Boolean }
            elseif ($isOdbc) { $p.OdbcType = [System.Data.Odbc.OdbcType]::Bit }
            else { $p.DbType = [Data.DbType]::Boolean }
        }
        default {
            if ($isOleDb) { $p.OleDbType = [System.Data.OleDb.OleDbType]::VarWChar }
            elseif ($isOdbc) { $p.OdbcType = [System.Data.Odbc.OdbcType]::NVarChar }
            else { $p.DbType = [Data.DbType]::String }
            $len = 1
            if ($Typed.Value -is [string]) { $len = [Math]::Max(1, $Typed.Value.Length) }
            $p.Size = $len
        }
    }
    $p.Value = $Typed.Value
    [void]$Command.Parameters.Add($p)
}

function Get-SemQueryError {
    # Maps an exception to @{ Status; Code; Message } without leaking the connection string.
    param($Exception, $Source, [string]$Stage)
    $msg = [string]$Exception.Message
    while ($Exception.InnerException -and ($Exception -is [Management.Automation.MethodInvocationException] -or $Exception -is [Management.Automation.RuntimeException])) {
        $Exception = $Exception.InnerException
        $msg = [string]$Exception.Message
    }
    if ($msg.StartsWith('provider-unavailable:')) { return @{ Status = 501; Code = 'provider-unavailable'; Message = $msg.Substring(21).Trim() } }
    if ($msg -match '(?i)time\s*out|timed out|timeout expired|operation cancelled|canceled') { return @{ Status = 504; Code = 'timeout'; Message = 'The query took longer than its time limit.' } }
    $safe = Get-SemSafeMessage -Message $msg -Source $Source
    if ($Stage -eq 'connect') { return @{ Status = 502; Code = 'source-unavailable'; Message = ("Could not connect to source '{0}': {1}" -f $Source.id, $safe) + (Get-SemVaultNoteText) } }
    return @{ Status = 422; Code = 'query-failed'; Message = ("The source rejected the query: {0}" -f $safe) }
}

# ---------------------------------------------------------------------------
# /api/query
# ---------------------------------------------------------------------------
function Get-SemQueryPlan {
    # Validates a /api/query body. Returns @{ Error = @{Status;Code;Message} } or @{ Source; Sql; Params; RowCap; TimeoutSec }.
    param($Body, [string]$HomeDir)
    $sourceId = [string](Get-SemJsonProp $Body 'source')
    if (-not $sourceId) { return @{ Error = @{ Status = 400; Code = 'bad-request'; Message = 'No source given.' } } }
    $src = Find-SemSource -HomeDir $HomeDir -Id $sourceId
    if ($null -eq $src) { return @{ Error = @{ Status = 404; Code = 'unknown-source'; Message = "Unknown source '$sourceId'." } } }
    $bad = Test-SemConnectionString -Connection $src.connection
    if ($bad) { return @{ Error = @{ Status = 400; Code = 'credentials-in-connection'; Message = $bad } } }
    $sql = Get-SemJsonProp $Body 'sql'
    if ($sql -isnot [string]) { return @{ Error = @{ Status = 400; Code = 'sql-refused'; Message = 'No SQL.' } } }
    $why = Test-SemSqlGuard -Sql $sql
    if ($why) { return @{ Error = @{ Status = 400; Code = 'sql-refused'; Message = $why } } }
    $rawParams = Get-SemJsonProp $Body 'params'
    $list = @()
    if ($null -ne $rawParams) { $list = @($rawParams) }
    if ($list.Count -gt $script:SemMaxParams) { return @{ Error = @{ Status = 400; Code = 'too-many-params'; Message = 'At most 2000 parameters.' } } }
    $typed = New-Object System.Collections.Generic.List[hashtable]
    for ($i = 0; $i -lt $list.Count; $i++) {
        try { $typed.Add((ConvertTo-SemParamValue -Param $list[$i] -Index $i)) }
        catch { return @{ Error = @{ Status = 400; Code = 'bad-param'; Message = $_.Exception.Message } } }
    }
    return @{
        Source = $src; Sql = $sql.Trim(); Params = $typed.ToArray()
        RowCap = (Get-SemBoundedInt (Get-SemJsonProp $Body 'rowCap') 50000 1 200000)
        TimeoutSec = (Get-SemBoundedInt (Get-SemJsonProp $Body 'timeoutSec') 60 1 300)
    }
}

function Invoke-SemQueryOnConnection {
    # Runs the plan on an open DbConnection and returns the response JSON text.
    param([Parameter(Mandatory = $true)]$Connection, [Parameter(Mandatory = $true)][hashtable]$Plan, [Diagnostics.Stopwatch]$Clock = ([Diagnostics.Stopwatch]::StartNew()))
    $cmd = $Connection.CreateCommand()
    try {
        $cmd.CommandText = $Plan.Sql
        $cmd.CommandTimeout = $Plan.TimeoutSec
        for ($i = 0; $i -lt $Plan.Params.Count; $i++) { Add-SemCommandParameter -Command $cmd -Typed $Plan.Params[$i] -Index $i }
        $reader = $cmd.ExecuteReader()
        $sb = New-Object Text.StringBuilder 65536
        try {
            $truncated = Write-SemReaderResult -Reader $reader -RowCap $Plan.RowCap -Sb $sb
            if ($truncated) { try { $cmd.Cancel() } catch { } }   # do not drain the rest of the rows
        } finally { $reader.Dispose() }
        $notes = @(Get-SemVaultNotes)   # optional Lazarette roles that came back empty (Vault.ps1)
        if ($notes.Count -gt 0) { [void]$sb.Append(',"notes":[').Append((@($notes | ForEach-Object { ConvertTo-SemJsonString $_ }) -join ',')).Append(']') }
        [void]$sb.Append(',"ms":').Append([string][long]$Clock.ElapsedMilliseconds).Append('}')
        return $sb.ToString()
    } finally { $cmd.Dispose() }
}

# ---------------------------------------------------------------------------
# /api/profile
# ---------------------------------------------------------------------------
function Get-SemFieldKind {
    param([Type]$Type)
    if ($null -eq $Type) { return 'string' }
    switch ($Type.FullName) {
        'System.Boolean' { return 'boolean' }
        'System.DateTime' { return 'date' }
        'System.DateTimeOffset' { return 'date' }
        { @('System.Byte', 'System.SByte', 'System.Int16', 'System.UInt16', 'System.Int32', 'System.UInt32', 'System.Int64', 'System.UInt64', 'System.Single', 'System.Double', 'System.Decimal') -contains $_ } { return 'number' }
    }
    return 'string'
}

function Get-SemProfileTables {
    # { tables: [{ name, schema }] } from GetSchema("Tables"): user tables and views, at most 500.
    param([Parameter(Mandatory = $true)]$Connection)
    $t = $Connection.GetSchema('Tables')
    $cols = @($t.Columns | ForEach-Object { $_.ColumnName })
    $schemaCol = $null
    foreach ($c in @('TABLE_SCHEM', 'TABLE_SCHEMA', 'TABLE_OWNER')) { if ($cols -contains $c) { $schemaCol = $c; break } }
    $system = @('information_schema', 'pg_catalog', 'pg_toast', 'sys', 'system', 'ctxsys', 'mdsys', 'olapsys', 'xdb', 'wmsys', 'outln', 'dbsnmp', 'appqossys', 'audsys', 'gsmadmin_internal', 'lbacsys', 'ojvmsys', 'ordsys', 'ordplugins', 'dvsys', 'si_informtn_schema', 'apex_public_user')
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($row in $t.Rows) {
        if ($out.Count -ge 500) { break }
        $type = ''
        if ($cols -contains 'TABLE_TYPE') { $type = ([string]$row['TABLE_TYPE']).ToUpperInvariant() }
        if (@('TABLE', 'VIEW', 'LINK', 'BASE TABLE') -notcontains $type) { continue }
        $name = [string]$row['TABLE_NAME']
        if (-not $name -or $name.StartsWith('MSys') -or $name.StartsWith('~')) { continue }
        $schema = $null
        if ($schemaCol -and $row[$schemaCol] -isnot [DBNull]) { $schema = [string]$row[$schemaCol]; if ($schema -eq '') { $schema = $null } }
        if ($schema -and ($system -contains $schema.ToLowerInvariant() -or $schema.StartsWith('APEX_'))) { continue }
        $out.Add([ordered]@{ name = $name; schema = $schema })
    }
    return [ordered]@{ tables = $out.ToArray() }
}

function Invoke-SemScalar {
    param($Connection, [string]$Sql, [int]$TimeoutSec = 30)
    $c = $Connection.CreateCommand()
    try {
        $c.CommandText = $Sql
        $c.CommandTimeout = $TimeoutSec
        $v = $c.ExecuteScalar()
        if ($null -eq $v -or $v -is [DBNull]) { return $null }
        return [long]$v
    } finally { $c.Dispose() }
}

function Get-SemProfileTable {
    # { table, rows, columns: [{ name, type, distinct, samples }] } for one table (at most 200 columns).
    param([Parameter(Mandatory = $true)]$Connection, [Parameter(Mandatory = $true)]$Source, [Parameter(Mandatory = $true)][string]$Table)
    $br = Test-SemUsesBrackets $Source
    $q = Get-SemQuotedName -Name $Table -Brackets $br
    $rows = $null
    try { $rows = Invoke-SemScalar -Connection $Connection -Sql ('SELECT COUNT(*) FROM ' + $q) -TimeoutSec 30 } catch { $rows = $null }
    # Column names and types, plus up to 5 sample rows, from one reader that is cancelled early.
    $cmd = $Connection.CreateCommand()
    $columns = New-Object System.Collections.Generic.List[object]
    try {
        $cmd.CommandText = 'SELECT * FROM ' + $q
        $cmd.CommandTimeout = 30
        $reader = $cmd.ExecuteReader()
        try {
            $n = [Math]::Min(200, $reader.FieldCount)
            $samples = @{}
            for ($i = 0; $i -lt $n; $i++) {
                $columns.Add([ordered]@{ name = $reader.GetName($i); type = (Get-SemFieldKind $reader.GetFieldType($i)); distinct = $null; samples = @() })
                $samples[$i] = New-Object System.Collections.Generic.List[string]
            }
            $seen = 0
            while ($seen -lt 50 -and $reader.Read()) {
                $seen++
                for ($i = 0; $i -lt $n; $i++) {
                    if ($samples[$i].Count -ge 5) { continue }
                    $v = $null; try { $v = $reader.GetValue($i) } catch { $v = $null }
                    $s = ConvertTo-SemSampleText $v
                    if ($null -ne $s) {
                        if ($s.Length -gt 200) { $s = $s.Substring(0, 200) }
                        if (-not $samples[$i].Contains($s)) { $samples[$i].Add($s) }
                    }
                }
            }
            try { $cmd.Cancel() } catch { }
            for ($i = 0; $i -lt $n; $i++) { $columns[$i].samples = $samples[$i].ToArray() }
        } finally { $reader.Dispose() }
    } finally { $cmd.Dispose() }
    # Distinct counts for string, date and boolean columns; 30 s each, skipped on error.
    $alias = ' AS d'
    if ($Source.kind -eq 'oracle') { $alias = ' d' }
    foreach ($col in $columns) {
        if ($col.type -eq 'number') { continue }
        $name = [string]$col.name
        if ($name -match '[\x00-\x1f]') { continue }
        $qc = Get-SemQuotedColumn -Name $name -Brackets $br
        try { $col.distinct = Invoke-SemScalar -Connection $Connection -Sql ('SELECT COUNT(*) FROM (SELECT DISTINCT ' + $qc + ' FROM ' + $q + ')' + $alias) -TimeoutSec 30 } catch { $col.distinct = $null }
    }
    return [ordered]@{ table = $Table; rows = $rows; columns = $columns.ToArray() }
}

# ---------------------------------------------------------------------------
# Request handlers (run inside a worker runspace)
# ---------------------------------------------------------------------------
function Invoke-SemQueryRequest {
    param($Req, [string]$HomeDir)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $plan = Get-SemQueryPlan -Body $Req.Json -HomeDir $HomeDir
    if ($plan.ContainsKey('Error')) { Send-SemError $plan.Error.Status $plan.Error.Code $plan.Error.Message; return }
    $vaultError = Get-SemVaultError
    if ($vaultError) { Send-SemError $vaultError.Status $vaultError.Code $vaultError.Message; return }
    if ($plan.Source.provider -eq 'athena') { Invoke-SemLakeRequest -Req $Req -Plan $plan -HomeDir $HomeDir; return }
    if (@('redshift-data', 'foundry') -contains $plan.Source.provider) { Invoke-SemConnectorQueryRequest -Plan $plan; return }
    $conn = $null
    try { $conn = New-SemConnection -Source $plan.Source -TimeoutSec $plan.TimeoutSec }
    catch { $e = Get-SemQueryError -Exception $_.Exception -Source $plan.Source -Stage 'connect'; Write-SemLog 'WARN' ("Query on '{0}': {1}" -f $plan.Source.id, $e.Code); Send-SemError $e.Status $e.Code $e.Message; return }
    try {
        $json = Invoke-SemQueryOnConnection -Connection $conn -Plan $plan -Clock $clock
        Write-SemLog 'INFO' ("Query on '{0}': {1} ms" -f $plan.Source.id, $clock.ElapsedMilliseconds)
        Send-SemJsonText 200 $json
    } catch {
        $e = Get-SemQueryError -Exception $_.Exception -Source $plan.Source -Stage 'query'
        Write-SemLog 'WARN' ("Query on '{0}': {1}" -f $plan.Source.id, $e.Code)
        Send-SemError $e.Status $e.Code $e.Message
    } finally { try { $conn.Dispose() } catch { } }
}

function Invoke-SemProfileRequest {
    param($Req, [string]$HomeDir)
    $sourceId = [string](Get-SemJsonProp $Req.Json 'source')
    $src = $null
    if ($sourceId) { $src = Find-SemSource -HomeDir $HomeDir -Id $sourceId }
    if ($null -eq $src) { Send-SemError 404 'unknown-source' "Unknown source '$sourceId'."; return }
    $bad = Test-SemConnectionString -Connection $src.connection
    if ($bad) { Send-SemError 400 'credentials-in-connection' $bad; return }
    $vaultError = Get-SemVaultError
    if ($vaultError) { Send-SemError $vaultError.Status $vaultError.Code $vaultError.Message; return }
    $table = Get-SemJsonProp $Req.Json 'table'
    if ($null -ne $table -and ($table -isnot [string] -or -not (Test-SemIdentifier $table))) { Send-SemError 400 'bad-identifier' 'The table name is not a valid identifier.'; return }
    if ($src.provider -eq 'athena') {
        try { Send-SemJson 200 (Get-SemLakeProfile -Lake (Get-SemLakeSettings $src.raw) -Table ([string]$table)) }
        catch { Send-SemError 502 'lake-profile' (Get-SemLakeSafeText $_.Exception.Message) }
        return
    }
    if (@('redshift-data', 'foundry') -contains $src.provider) { Invoke-SemConnectorProfileRequest -Source $src -Table ([string]$table); return }
    $conn = $null
    try { $conn = New-SemConnection -Source $src -TimeoutSec 30 }
    catch { $e = Get-SemQueryError -Exception $_.Exception -Source $src -Stage 'connect'; Send-SemError $e.Status $e.Code $e.Message; return }
    try {
        if ($null -eq $table -or $table -eq '') { $result = Get-SemProfileTables -Connection $conn }
        else { $result = Get-SemProfileTable -Connection $conn -Source $src -Table $table }
        Send-SemJson 200 $result
    } catch {
        $e = Get-SemQueryError -Exception $_.Exception -Source $src -Stage 'query'
        Send-SemError $e.Status $e.Code $e.Message
    } finally { try { $conn.Dispose() } catch { } }
}

# ---------------------------------------------------------------------------
# Worker pool: the main loop hands the connection over; the worker answers and closes it.
# ---------------------------------------------------------------------------
$script:SemWorkerScript = @'
param($Client, $Req, $Ctx)
if (-not (Get-Command Invoke-SemQueryRequest -ErrorAction SilentlyContinue)) {
    . $Ctx.CommonPath
    . $Ctx.HttpPath
    . $Ctx.RoutesPath
    . $Ctx.QueryPath
    . $Ctx.IntelligencePath
    . $Ctx.LakePath
    . $Ctx.VaultPath
    . $Ctx.ConnectorsPath
}
Clear-SemVaultRequest
$script:SemLogPath = $Ctx.LogPath
$script:Sem.Version = $Ctx.Version
$script:Sem.Port = $Ctx.Port
$script:SemJsonMode = $Ctx.JsonMode
$script:Sem.Responded = $false
try {
    $Client.SendTimeout = 30000
    $script:Sem.Stream = $Client.GetStream()
    # Lazarette is asked here, in the worker, so a slow or locked vault never holds the main loop (Vault.ps1, the one seam).
    if ($Req.Path -eq '/api/query' -or $Req.Path -eq '/api/profile') { Set-SemVaultRequest (Get-SemVaultForRequest -Req $Req -HomeDir $Ctx.Home) }
    if ($Req.Path -eq '/api/query') { Invoke-SemQueryRequest -Req $Req -HomeDir $Ctx.Home }
    elseif ($Req.Path.StartsWith('/api/ai/')) { $Client.SendTimeout = 200000; Invoke-SemAiRequest -Req $Req -Root $Ctx.Root }
    else { Invoke-SemProfileRequest -Req $Req -HomeDir $Ctx.Home }
} catch {
    Write-SemLog 'ERROR' ('{0}: {1}' -f $Req.Path, $_.Exception.Message)
    if (-not $script:Sem.Responded) { try { Send-SemError 500 'internal' 'Internal server error.' } catch { } }
} finally {
    Clear-SemVaultRequest   # the secrets of this request do not wait in the idle runspace for the next one
    $script:Sem.Stream = $null
    try { $Client.Close() } catch { }
}
'@

function Initialize-SemWorkers {
    param([int]$Size = 4)
    $script:Sem.Workers = New-Object System.Collections.Generic.List[object]
    [void](Initialize-SemJsonWriter)
    $pool = [runspacefactory]::CreateRunspacePool(1, [Math]::Max(1, $Size))
    $pool.Open()
    $script:Sem.Pool = $pool
    $here = $PSScriptRoot
    $script:Sem.WorkerContext = @{
        CommonPath = (Join-Path $here 'Common.ps1'); HttpPath = (Join-Path $here 'Http.ps1')
        RoutesPath = (Join-Path $here 'Routes.ps1'); QueryPath = (Join-Path $here 'Query.ps1')
        IntelligencePath = (Join-Path $here 'Intelligence.ps1'); LakePath = (Join-Path $here 'Lake.ps1'); VaultPath = (Join-Path $here 'Vault.ps1'); ConnectorsPath = (Join-Path $here 'Connectors.ps1'); Root = (Split-Path -Parent $here)
        Home = $script:Sem.Home; LogPath = $script:SemLogPath; Version = $script:Sem.Version; JsonMode = $script:SemJsonMode
        Port = 0
    }
}

$script:SemWorkerDefaultDeadlineSec = 300
$script:SemWorkerDeadlineMarginSec = 60

function Get-SemWorkerDeadlineSec {
    # How long a worker may run before the main loop gives up on it: the query plan's time limit plus a margin
    # (the connect, the vault read and writing the rows), else 300 s (a profile walks many columns; a model can be slow).
    param($Req)
    if ($null -ne $Req -and $Req.Path -eq '/api/query') {
        return ((Get-SemBoundedInt (Get-SemJsonProp $Req.Json 'timeoutSec') 60 1 300) + $script:SemWorkerDeadlineMarginSec)
    }
    return $script:SemWorkerDefaultDeadlineSec
}

function Start-SemWorkerRequest {
    # The main loop hands the connection to a worker and goes on; the worker resolves the request's Lazarette
    # secrets itself (the worker script), so nothing slow runs here.
    param($Req)
    $ctx = $script:Sem.WorkerContext.Clone()
    $ctx.Port = $script:Sem.Port
    $ps = [powershell]::Create()
    $ps.RunspacePool = $script:Sem.Pool
    [void]$ps.AddScript($script:SemWorkerScript).AddArgument($Req.Client).AddArgument($Req).AddArgument($ctx)
    $handle = $ps.BeginInvoke()
    $script:Sem.Workers.Add(@{ PS = $ps; Handle = $handle; Path = $Req.Path; Client = $Req.Client; Clock = [Diagnostics.Stopwatch]::StartNew(); DeadlineSec = (Get-SemWorkerDeadlineSec $Req); TimedOut = $false })
    $script:Sem.Deferred = $true
    $script:Sem.Responded = $true
}

function Stop-SemWorkerLate {
    # A worker past its deadline: its client gets a 504 (when the socket is still open) and is closed, the
    # pipeline is asked to stop without waiting for it, and the item stays in the list, marked, until the
    # pipeline really ends (then Update-SemWorkers reaps it). Returns $true when the client was answered.
    param([hashtable]$Item)
    $Item.TimedOut = $true
    $answered = $false
    $client = $Item.Client
    if ($null -ne $client) {
        try {
            if ($client.Connected) {
                $msg = 'The request took longer than {0} s and was given up; the source may still be working on it.' -f $Item.DeadlineSec
                Send-SemError 504 'timeout' $msg -Stream ($client.GetStream())
                $answered = $true
            }
        } catch { }
        try { $client.Close() } catch { }
    }
    try { [void]$Item.PS.BeginStop($null, $null) } catch { }
    Write-SemLog 'WARN' ('Worker {0}: gave up after {1} s (deadline {2} s); the pipeline was asked to stop' -f $Item.Path, [int]$Item.Clock.Elapsed.TotalSeconds, $Item.DeadlineSec)
    return $answered
}

function Update-SemWorkers {
    # Reaps finished workers and gives up on those past their deadline (Stop-SemWorkerLate).
    $w = $script:Sem.Workers
    if ($null -eq $w) { return }
    foreach ($item in @($w.ToArray())) {
        if (-not $item.Handle.IsCompleted) {
            if (-not $item.TimedOut -and $null -ne $item.DeadlineSec -and $null -ne $item.Clock -and $item.Clock.Elapsed.TotalSeconds -gt $item.DeadlineSec) { [void](Stop-SemWorkerLate -Item $item) }
            continue
        }
        if (-not $item.TimedOut) { try { [void]$item.PS.EndInvoke($item.Handle) } catch { Write-SemLog 'ERROR' ('Worker ' + $item.Path + ': ' + $_.Exception.Message) } }
        try { $item.PS.Dispose() } catch { }
        [void]$w.Remove($item)
    }
}

function Close-SemWorkers {
    # Asks every pipeline to stop and waits a bounded time (never Stop(), which waits as long as a stuck driver
    # call does), then disposes what stopped and leaves the rest to end with the process.
    param([int]$WaitMs = 3000)
    $w = $script:Sem.Workers
    if ($null -ne $w) {
        $stops = New-Object System.Collections.Generic.List[object]
        foreach ($item in @($w.ToArray())) {
            try { $client = $item.Client; if ($null -ne $client) { $client.Close() } } catch { }
            try { $stops.Add(@{ Item = $item; Ar = $item.PS.BeginStop($null, $null) }) } catch { }
        }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        foreach ($s in $stops) {
            $left = [Math]::Max(0, $WaitMs - [int]$clock.ElapsedMilliseconds)
            $done = $false
            try { $done = $s.Ar.AsyncWaitHandle.WaitOne($left) } catch { $done = $false }
            if ($done) { try { $s.Item.PS.Dispose() } catch { } }
            else { Write-SemLog 'WARN' ('Worker ' + $s.Item.Path + ' did not stop within ' + $WaitMs + ' ms; left to end with the process') }
        }
        $w.Clear()
    }
    if ($null -ne $script:Sem.Pool) {
        try {
            $ar = $script:Sem.Pool.BeginClose($null, $null)
            if ($ar.AsyncWaitHandle.WaitOne($WaitMs)) { $script:Sem.Pool.EndClose($ar); $script:Sem.Pool.Dispose() }
        } catch { }
    }
    $script:Sem.Pool = $null
}
