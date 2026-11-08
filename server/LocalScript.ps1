#requires -Version 5.1
# =============================================================================
# Semaphore local database: SQL scripts, pulls from live sources, saved scripts and dataset exports.
# A separate, write-capable path: the read-only query path (/api/query, LocalDb.ps1 New-SemLocalQueryConnection)
# is never used for any of this, and nothing here touches a live database except through the guarded SELECT.
#
#   Scripts      the page compiles a script (src/core/script.ts) into a plan; Invoke-SemLocalScript checks
#                the plan's shape again here (never trusting the page), and LocalScript.cs runs it in one
#                transaction on its own ReadWrite connection with an authorizer (see the header there).
#   IMPORT INTO  a plan node that runs one SELECT on a live source through Test-SemSqlGuard and the normal
#                read-only connection (New-SemConnection), writes the rows to a temp CSV and loads them with
#                Import-SemLocalFile -Replace (or -Append). Writes to live sources are refused.
#   Library      <home>\scripts\<id>.json  { version: 1, name, dialect, text, plan, target, updated }
#   Exports      a whole local table as CSV, Parquet, Arrow, a one-table SQLite file or Excel (xlsx).
#
# Routes (Routes.ps1 hands these here after the session gate):
#   GET    /api/local/scripts                 [{ id, name, dialect, updated }]
#   GET    /api/local/scripts/<id>            the saved script
#   PUT    /api/local/scripts/<id>            save (the plan is checked first)
#   DELETE /api/local/scripts/<id>            moved to scripts\.trash
#   POST   /api/local/script-run { plan, params?, label? } | { id, params? }   -> { ok, results, error?, ms, tables }
#   POST   /api/local/export { table, format }  -> the file (Content-Disposition: attachment), temp removed after
#   GET    /api/local/sources                 files kept in <home>\local\sources (uploads a pipeline imports)
# The run and the export go to the local job pool (LocalDb.ps1) with the connection handed over, so a long
# script never holds the server.
# =============================================================================

$script:SemScriptIdRx = '\A[a-z0-9][a-z0-9_-]{0,63}\z'
$script:SemScriptNameRx = '\A[A-Za-z_][A-Za-z0-9_]{0,63}\z'
$script:SemScriptOps = @('sql', 'declare', 'assign', 'if', 'while', 'break', 'continue', 'try', 'raise', 'print', 'return', 'import')
$script:SemScriptMaxNodes = 5000
$script:SemScriptMaxSql = 102400
$script:SemScriptMaxDoc = 2097152
$script:SemExportFormats = [ordered]@{
    csv = @{ Ext = '.csv'; Type = 'text/csv; charset=utf-8' }
    parquet = @{ Ext = '.parquet'; Type = 'application/vnd.apache.parquet' }
    arrow = @{ Ext = '.arrow'; Type = 'application/vnd.apache.arrow.file' }
    sqlite = @{ Ext = '.sqlite'; Type = 'application/vnd.sqlite3' }
    xlsx = @{ Ext = '.xlsx'; Type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
}

# ---------------------------------------------------------------------------
# The plan: shape checks and conversion to SemLocal.ScriptNode
# ---------------------------------------------------------------------------
function Get-SemPlanProp {
    param($Object, [string]$Name)
    if ($null -eq $Object -or $Object -isnot [Management.Automation.PSCustomObject]) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

function ConvertTo-SemScriptNodes {
    <#
      Checks a list of plan nodes (src/core/script.ts PlanNode) and returns a List[SemLocal.ScriptNode], or throws a
      message. Only the known ops, SQL text under 100 KB, variable and table names of letters, digits and _, at most
      16 levels and 5000 nodes, and IMPORT only at the top level. What the SQL may do is decided by the authorizer
      when it runs, not here.
    #>
    param($Nodes, [int]$Depth = 0, [hashtable]$Count = @{ N = 0 }, [int]$MaxLoop = 100000)
    if ($Depth -gt 16) { throw 'The script nests blocks more than 16 deep.' }
    $list = New-Object 'System.Collections.Generic.List[SemLocal.ScriptNode]'
    if ($null -eq $Nodes) { return , $list }
    foreach ($n in @($Nodes)) {
        $Count.N++
        if ($Count.N -gt $script:SemScriptMaxNodes) { throw ('The script has more than ' + $script:SemScriptMaxNodes + ' steps.') }
        if ($n -isnot [Management.Automation.PSCustomObject]) { throw 'Each step of the plan is an object.' }
        $op = [string](Get-SemPlanProp $n 'op')
        if ($script:SemScriptOps -notcontains $op) { throw ("Unknown step '" + $op + "' in the plan.") }
        $node = New-Object SemLocal.ScriptNode
        $node.Op = $op
        $line = 0; [void][int]::TryParse([string](Get-SemPlanProp $n 'line'), [ref]$line); $node.Line = [Math]::Max(0, $line)
        $sqlField = switch ($op) { 'if' { 'cond' } 'while' { 'cond' } 'break' { 'cond' } 'continue' { 'cond' } default { 'sql' } }
        $sql = Get-SemPlanProp $n $sqlField
        if ($null -ne $sql) {
            if ($sql -isnot [string]) { throw ('Step ' + $op + ' on line ' + $node.Line + ': its SQL must be text.') }
            if ($sql.Length -gt $script:SemScriptMaxSql) { throw ('Step on line ' + $node.Line + ': a statement may be at most 100 KB.') }
            $node.Sql = $sql
        }
        $needsSql = @('sql', 'assign', 'if', 'while', 'raise', 'print', 'import')
        if ($needsSql -contains $op -and -not $node.Sql) { throw ('Step ' + $op + ' on line ' + $node.Line + ' has no SQL.') }
        switch ($op) {
            'declare' {
                $name = [string](Get-SemPlanProp $n 'name')
                if ($name -cnotmatch $script:SemScriptNameRx) { throw ('Line ' + $node.Line + ': a variable name has letters, digits and _.') }
                $node.Names = [string[]]@($name.ToLowerInvariant())
            }
            'assign' {
                $names = @(Get-SemPlanProp $n 'names')
                if ($names.Count -eq 0) { throw ('Line ' + $node.Line + ': an assignment names its variables.') }
                foreach ($x in $names) { if ([string]$x -cnotmatch $script:SemScriptNameRx) { throw ('Line ' + $node.Line + ': a variable name has letters, digits and _.') } }
                $node.Names = [string[]]@($names | ForEach-Object { ([string]$_).ToLowerInvariant() })
                $mode = [string](Get-SemPlanProp $n 'mode'); if ($mode -ne 'one') { $mode = 'last' }
                $node.Mode = $mode
            }
            'if' {
                $node.Body = ConvertTo-SemScriptNodes -Nodes (Get-SemPlanProp $n 'then') -Depth ($Depth + 1) -Count $Count -MaxLoop $MaxLoop
                $node.Else = ConvertTo-SemScriptNodes -Nodes (Get-SemPlanProp $n 'else') -Depth ($Depth + 1) -Count $Count -MaxLoop $MaxLoop
            }
            'while' {
                $max = 10000; [void][int]::TryParse([string](Get-SemPlanProp $n 'max'), [ref]$max)
                $node.Max = [Math]::Max(1, [Math]::Min($MaxLoop, $max))
                $node.Body = ConvertTo-SemScriptNodes -Nodes (Get-SemPlanProp $n 'body') -Depth ($Depth + 1) -Count $Count -MaxLoop $MaxLoop
                $node.Step = ConvertTo-SemScriptNodes -Nodes (Get-SemPlanProp $n 'step') -Depth ($Depth + 1) -Count $Count -MaxLoop $MaxLoop
            }
            'try' {
                $node.Body = ConvertTo-SemScriptNodes -Nodes (Get-SemPlanProp $n 'body') -Depth ($Depth + 1) -Count $Count -MaxLoop $MaxLoop
                $node.Else = ConvertTo-SemScriptNodes -Nodes (Get-SemPlanProp $n 'catch') -Depth ($Depth + 1) -Count $Count -MaxLoop $MaxLoop
            }
            'import' {
                if ($Depth -gt 0) { throw ('Line ' + $node.Line + ': IMPORT INTO runs only at the top of a script.') }
                $table = [string](Get-SemPlanProp $n 'table')
                if ($table -cnotmatch '\A[A-Za-z_][A-Za-z0-9_]{0,63}\z' -or $table -match '(?i)\A(sqlite_|_semaphore)') { throw ('Line ' + $node.Line + ': IMPORT INTO needs a table name of letters, digits and _.') }
                $node.Table = $table
                $node.Source = [string](Get-SemPlanProp $n 'source')
                $mode = [string](Get-SemPlanProp $n 'mode'); if ($mode -ne 'append') { $mode = 'replace' }
                $node.Mode = $mode
            }
        }
        $list.Add($node)
    }
    return , $list
}

function Test-SemScriptPlan {
    # $null when the plan has the right shape, else why not.
    param($Plan)
    if ($Plan -isnot [Management.Automation.PSCustomObject]) { return 'The plan must be an object.' }
    if ([string](Get-SemPlanProp $Plan 'version') -ne '1') { return 'The plan must have "version": 1.' }
    try { [void](ConvertTo-SemScriptNodes -Nodes (Get-SemPlanProp $Plan 'nodes')) } catch { return $_.Exception.Message }
    return $null
}

function ConvertTo-SemScriptValue {
    # A parameter value from the page: number, text, true / false, null; dates stay text (yyyy-MM-dd).
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [bool]) { if ($Value) { return [long]1 } else { return [long]0 } }
    if ($Value -is [int] -or $Value -is [long]) { return [long]$Value }
    if ($Value -is [double] -or $Value -is [decimal]) { $d = [double]$Value; if ([Math]::Floor($d) -eq $d -and [Math]::Abs($d) -lt 9e15) { return [long]$d }; return $d }
    if ($Value -is [datetime]) { return $Value.ToString('yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture) }
    $s = [string]$Value
    if ($s.Length -gt 100000) { $s = $s.Substring(0, 100000) }
    return $s
}

function ConvertTo-SemScriptCell {
    param($Value)
    if ($null -eq $Value -or $Value -is [DBNull]) { return $null }
    if ($Value -is [byte[]]) { return ('(' + $Value.Length + ' bytes)') }
    if ($Value -is [double] -and ([double]::IsNaN($Value) -or [double]::IsInfinity($Value))) { return $null }
    return $Value
}

function ConvertFrom-SemScriptResults {
    param($Runner)
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($r in $Runner.Results) {
        $one = [ordered]@{ line = [int]$r.Line; kind = [string]$r.Kind; ms = [long]$r.Ms }
        if ($r.Sql) { $s = [string]$r.Sql; if ($s.Length -gt 4000) { $s = $s.Substring(0, 4000) + ' ...' }; $one.sql = $s }
        if ($r.Kind -eq 'rows') {
            $one.columns = @($r.Columns)
            $rows = New-Object System.Collections.Generic.List[object]
            foreach ($row in $r.Rows) { $rows.Add(@($row | ForEach-Object { ConvertTo-SemScriptCell $_ })) }
            $one.rows = $rows.ToArray()
            $one.truncated = [bool]$r.Truncated
        } elseif ($r.Kind -eq 'changes') { $one.changes = [long]$r.Changes }
        else { $one.message = [string]$r.Message }
        $out.Add($one)
    }
    return , $out.ToArray()
}

# ---------------------------------------------------------------------------
# Running a script
# ---------------------------------------------------------------------------
function Invoke-SemLocalScript {
    <#
      Runs a plan in the local database. Returns @{ ok; results; error = @{ message; line; sql }?; ms; tables; dropped;
      resultsDropped }. Top-level IMPORT INTO steps split the script: what came before is committed, the rows are pulled
      and swapped in (Invoke-SemLocalPull), and the rest runs in a new transaction. -Params: name -> value for the plan's
      parameters. Never throws for a script error; throws for a plan that is not a plan.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$HomeDir,
        [Parameter(Mandatory = $true)]$Plan,
        $Params = $null,
        [string]$Label = 'script',
        [int]$RowCap = 500,
        [int]$TimeoutSec = 900,
        [string[]]$Shares = @(),
        [scriptblock]$OnRunner = $null
    )
    Initialize-SemLocalTypes
    $why = Test-SemScriptPlan $Plan
    if ($why) { throw $why }
    $nodes = ConvertTo-SemScriptNodes -Nodes (Get-SemPlanProp $Plan 'nodes')
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $conn = Open-SemLocalConnection -HomeDir $HomeDir -Write -BusyMs 60000
    $runner = $null
    $result = [ordered]@{ ok = $true; results = @(); ms = 0; tables = @(); dropped = @(); resultsDropped = 0; label = $Label }
    try {
        $runner = New-Object SemLocal.ScriptRunner $conn
        $runner.Label = $Label
        $runner.RowCap = [Math]::Max(1, [Math]::Min(5000, $RowCap))
        $runner.TimeoutSec = [Math]::Max(1, $TimeoutSec)
        if ($OnRunner) { & $OnRunner $runner }
        # Parameters: the plan's list, values from the page (anything else is ignored).
        foreach ($p in @(Get-SemPlanProp $Plan 'params')) {
            $name = ([string](Get-SemPlanProp $p 'name')).ToLowerInvariant()
            if ($name -cnotmatch $script:SemScriptNameRx) { continue }
            $value = $null
            if ($Params -is [hashtable]) { if ($Params.ContainsKey($name)) { $value = $Params[$name] } }
            elseif ($Params -is [Management.Automation.PSCustomObject]) { $value = Get-SemPlanProp $Params $name }
            $runner.SetVar($name, (ConvertTo-SemScriptValue $value))
        }
        $segment = New-Object 'System.Collections.Generic.List[SemLocal.ScriptNode]'
        $all = @($nodes) + @($null)   # a $null at the end flushes the last segment
        foreach ($n in $all) {
            if ($null -ne $n -and $n.Op -ne 'import') { $segment.Add($n); continue }
            if ($segment.Count -gt 0) {
                $runner.RunSegment($segment)
                $segment = New-Object 'System.Collections.Generic.List[SemLocal.ScriptNode]'
                if ($runner.Returned) { break }
            }
            if ($null -eq $n) { break }
            # IMPORT INTO local_table FROM SOURCE id AS (SELECT ...)
            $t0 = [Diagnostics.Stopwatch]::StartNew()
            try { $pull = Invoke-SemLocalPull -HomeDir $HomeDir -Source $n.Source -Sql $n.Sql -Table $n.Table -Mode $n.Mode }
            catch { throw (New-Object SemLocal.ScriptException (('Line ' + $n.Line + ': IMPORT INTO ' + $n.Table + ': ' + (ConvertTo-SemLocalMessage $_.Exception)), $n.Line, $n.Sql, $true, 1)) }
            $r = New-Object SemLocal.ScriptResult
            $r.Line = $n.Line; $r.Kind = 'changes'; $r.Changes = [long]$pull.Rows; $r.Ms = $t0.ElapsedMilliseconds; $r.Sql = ('IMPORT INTO ' + $n.Table + ' FROM SOURCE ' + $n.Source)
            $runner.Results.Add($r)
            [void]$runner.Written.Add($pull.Table)
        }
    } catch {
        $e = $_.Exception
        while ($null -ne $e.InnerException -and $e -isnot [SemLocal.ScriptException]) { $e = $e.InnerException }
        $result.ok = $false
        if ($e -is [SemLocal.ScriptException]) { $result.error = [ordered]@{ message = [string]$e.Message; line = [int]$e.Line; sql = [string]$e.Sql } }
        else { $result.error = [ordered]@{ message = (ConvertTo-SemLocalMessage $_.Exception); line = 0; sql = '' } }
    } finally {
        if ($null -ne $runner) {
            $result.results = ConvertFrom-SemScriptResults $runner
            $result.resultsDropped = [int]$runner.ResultsDropped
            $result.tables = @($runner.Written | Sort-Object)
            $result.dropped = @($runner.Dropped | Sort-Object)
            $runner.Dispose()
        }
        $conn.Dispose()
    }
    $result.ms = [long]$clock.ElapsedMilliseconds
    $state = 'ran'; if (-not $result.ok) { $state = 'failed' }
    Write-SemLog 'INFO' ("Local script {0} {1} in {2} ms ({3} result(s))" -f (ConvertTo-SemLogText $Label 80), $state, $result.ms, @($result.results).Count)
    return $result
}

# ---------------------------------------------------------------------------
# IMPORT INTO: one SELECT on a live source, through the guarded read path, into a local table
# ---------------------------------------------------------------------------
function Export-SemLiveRowsToCsv {
    # Runs $Sql on the source's read-only connection and writes the rows to $Path as CSV (ISO dates). Returns the rows.
    # Tests replace this function with a mock.
    param([Parameter(Mandatory = $true)]$Source, [Parameter(Mandatory = $true)][string]$Sql, [Parameter(Mandatory = $true)][string]$Path, [long]$MaxRows = 5000000, [int]$TimeoutSec = 600)
    $conn = New-SemConnection -Source $Source -TimeoutSec $TimeoutSec
    $inv = [Globalization.CultureInfo]::InvariantCulture
    $n = [long]0
    try {
        $cmd = $conn.CreateCommand(); $cmd.CommandText = $Sql; $cmd.CommandTimeout = $TimeoutSec
        $reader = $cmd.ExecuteReader()
        $w = New-Object IO.StreamWriter($Path, $false, (New-Object Text.UTF8Encoding $false), 65536)
        try {
            $cell = {
                param($v)
                if ($null -eq $v -or $v -is [DBNull]) { return '' }
                if ($v -is [datetime]) { $s = $v.ToString('yyyy-MM-dd HH:mm:ss', $inv); if ($s.EndsWith(' 00:00:00')) { $s = $s.Substring(0, 10) } }
                elseif ($v -is [bool]) { if ($v) { $s = 'true' } else { $s = 'false' } }
                elseif ($v -is [IFormattable]) { $s = $v.ToString($null, $inv) }
                else { $s = [string]$v }
                if ($s -eq '' -or $s.IndexOfAny([char[]]@(',', '"', "`r", "`n")) -ge 0) { return ('"' + $s.Replace('"', '""') + '"') }
                return $s
            }
            $names = @(for ($i = 0; $i -lt $reader.FieldCount; $i++) { & $cell ($reader.GetName($i)) })
            $w.WriteLine(($names -join ','))
            $vals = New-Object object[] $reader.FieldCount
            while ($reader.Read()) {
                if ($n -ge $MaxRows) { throw ('The SELECT returns more than ' + $MaxRows + ' rows (settings localPullMaxRows); narrow it with WHERE.') }
                [void]$reader.GetValues($vals)
                $w.WriteLine((@($vals | ForEach-Object { & $cell $_ }) -join ','))
                $n++
            }
        } finally { $w.Dispose(); $reader.Dispose(); $cmd.Dispose() }
    } finally { $conn.Dispose() }
    return $n
}

function Invoke-SemLocalPull {
    # IMPORT INTO $Table FROM SOURCE $Source AS ($Sql): returns @{ Table; Rows; Ms }. Throws a message for a person.
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Sql, [Parameter(Mandatory = $true)][string]$Table, [ValidateSet('replace', 'append')][string]$Mode = 'replace')
    if ($Table -cnotmatch '\A[A-Za-z_][A-Za-z0-9_]{0,63}\z') { throw 'A table name has 1 to 64 letters, digits or _, and starts with a letter or _.' }
    if ($Source -eq 'local') { throw 'IMPORT INTO reads from a live source; the local database is already here (use INSERT ... SELECT).' }
    $src = Find-SemSource -HomeDir $HomeDir -Id $Source
    if ($null -eq $src) { throw ("There is no source '" + $Source + "' in sources.json.") }
    $why = Test-SemSqlGuard -Sql $Sql
    if ($why) { throw ('the SELECT was refused: ' + $why + ' Live databases stay read-only; writes to a source are not allowed (an administrator may allow them per source in a later version).') }
    if (@('athena', 'redshift-data', 'foundry') -contains [string]$src.provider) { throw ("IMPORT INTO reads ODBC and OLE DB sources; '" + $Source + "' (" + $src.provider + ') is not supported yet. Export it to a file or S3 and import that.') }
    $bad = Test-SemSourceConnection $src
    if ($bad) { throw $bad }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $csv = Join-Path (Get-SemLocalDir -HomeDir $HomeDir -Child 'temp') ('pull-' + [guid]::NewGuid().ToString('N') + '.csv')
    $vaultSet = $false
    try {
        if (Get-Command Get-SemVaultForRequest -ErrorAction SilentlyContinue) {
            Set-SemVaultRequest (Get-SemVaultForRequest -Req @{ Json = [pscustomobject]@{ source = $Source } } -HomeDir $HomeDir)
            $vaultSet = $true
            $ve = Get-SemVaultError
            if ($ve) { throw [string]$ve.Message }
        }
        $max = [long]5000000
        if ($script:Sem.LocalPullMaxRows -gt 0) { $max = [long]$script:Sem.LocalPullMaxRows }
        try { $n = Export-SemLiveRowsToCsv -Source $src -Sql $Sql -Path $csv -MaxRows $max }
        catch {
            $e = Get-SemQueryError -Exception $_.Exception -Source $src -Stage 'query'
            throw $e.Message
        }
        if ($vaultSet) { Clear-SemVaultRequest; $vaultSet = $false }
        $label = 'source ' + $Source
        $a = @{ HomeDir = $HomeDir; Path = $csv; Table = $Table; SourceLabel = $label; FileName = ($Table + '.csv') }
        if ($Mode -eq 'append') { $a.Append = $true } else { $a.Replace = $true }
        if ($n -eq 0) {
            # An empty result still makes (or empties) the table, so later steps can read it.
            $imp = $null
            try { $imp = Import-SemLocalFile @a } catch { throw ('the SELECT on ' + $Source + ' returned no rows, so the table could not be built: ' + $_.Exception.Message) }
        } else { $imp = Import-SemLocalFile @a }
        Write-SemLog 'INFO' ("Local pull from {0} into {1}: {2} rows in {3} ms" -f $Source, $imp.Table, $n, $clock.ElapsedMilliseconds)
        return @{ Table = [string]$imp.Table; Rows = [long]$imp.Rows; Ms = [long]$clock.ElapsedMilliseconds; Warnings = @($imp.Warnings) }
    } finally {
        if ($vaultSet) { Clear-SemVaultRequest }
        if ([IO.File]::Exists($csv)) { try { [IO.File]::Delete($csv) } catch { } }
    }
}

# ---------------------------------------------------------------------------
# Saved scripts: <home>\scripts\<id>.json
# ---------------------------------------------------------------------------
function Get-SemScriptDir {
    param([Parameter(Mandatory = $true)][string]$HomeDir)
    $d = Join-Path $HomeDir 'scripts'
    if (-not [IO.Directory]::Exists($d)) { [void][IO.Directory]::CreateDirectory($d) }
    return $d
}

function ConvertTo-SemScriptId {
    # A file-safe id from a script's name: lower case letters, digits, _ and -.
    param([string]$Name)
    $s = ([string]$Name).ToLowerInvariant() -replace '[^a-z0-9_-]+', '-'
    $s = $s.Trim('-', '_')
    if ($s.Length -gt 64) { $s = $s.Substring(0, 64).Trim('-', '_') }
    if (-not $s) { $s = 'script' }
    return $s
}

function Test-SemScriptDoc {
    # $null when the bytes are a saved script Semaphore accepts, else why not.
    param([byte[]]$Bytes)
    if ($Bytes.Length -gt $script:SemScriptMaxDoc) { return 'A saved script may be at most 2 MB.' }
    try { $j = (New-Object Text.UTF8Encoding $false).GetString($Bytes).TrimStart([char]0xFEFF) | ConvertFrom-Json -ErrorAction Stop } catch { return 'The script is not valid JSON.' }
    if ($j -isnot [Management.Automation.PSCustomObject]) { return 'The script must be a JSON object.' }
    if ([string](Get-SemPlanProp $j 'version') -ne '1') { return 'The script must have "version": 1.' }
    $name = Get-SemPlanProp $j 'name'
    if ($name -isnot [string] -or $name.Trim().Length -eq 0 -or $name.Length -gt 100 -or $name -match '[\x00-\x1f]') { return 'A script has a name of 1 to 100 characters.' }
    $text = Get-SemPlanProp $j 'text'
    if ($null -ne $text -and $text -isnot [string]) { return 'text must be the script as written.' }
    $dialect = [string](Get-SemPlanProp $j 'dialect')
    if (@('postgres', 'oracle', 'access', 'tsql', 'synapse', 'spark', 'mysql', 'sqlite', 'ansi') -notcontains $dialect) { return 'dialect must be one of Semaphore''s SQL languages.' }
    $plan = Get-SemPlanProp $j 'plan'
    if ($null -ne $plan) { $why = Test-SemScriptPlan $plan; if ($why) { return ('The plan is not valid: ' + $why) } }
    return $null
}

function Get-SemScriptList {
    param([Parameter(Mandatory = $true)][string]$HomeDir)
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($f in @(Get-ChildItem -LiteralPath (Get-SemScriptDir -HomeDir $HomeDir) -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name)) {
        $id = [IO.Path]::GetFileNameWithoutExtension($f.Name)
        if ($id -cnotmatch $script:SemScriptIdRx) { continue }
        try { $j = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { continue }
        $out.Add([ordered]@{ id = $id; name = [string](Get-SemPlanProp $j 'name'); dialect = [string](Get-SemPlanProp $j 'dialect'); updated = $f.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ssZ'); runnable = ($null -ne (Get-SemPlanProp $j 'plan')) })
    }
    return $out.ToArray()
}

function Read-SemScript {
    # The saved script's JSON text, or $null.
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Id)
    if ($Id -cnotmatch $script:SemScriptIdRx) { return $null }
    $f = Join-Path (Get-SemScriptDir -HomeDir $HomeDir) ($Id + '.json')
    if (-not [IO.File]::Exists($f)) { return $null }
    return [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8)
}

function Save-SemScript {
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Id, [Parameter(Mandatory = $true)][byte[]]$Bytes)
    if ($Id -cnotmatch $script:SemScriptIdRx) { throw 'A script id has lower-case letters, digits, _ and - (1 to 64).' }
    $why = Test-SemScriptDoc -Bytes $Bytes
    if ($why) { throw $why }
    Save-SemDoc -Dir (Get-SemScriptDir -HomeDir $HomeDir) -Id $Id -Bytes $Bytes
}

function Remove-SemScript {
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Id)
    if ($Id -cnotmatch $script:SemScriptIdRx) { return $false }
    return (Remove-SemDoc -Dir (Get-SemScriptDir -HomeDir $HomeDir) -Id $Id)
}

function Invoke-SemSavedScript {
    # Runs a saved script by id (the pipeline's Script step and "script run"). Throws when it has no plan.
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Id, $Params = $null, [string]$Label = '')
    $text = Read-SemScript -HomeDir $HomeDir -Id $Id
    if ($null -eq $text) { throw ("There is no saved script '" + $Id + "'.") }
    $doc = $text | ConvertFrom-Json
    $plan = Get-SemPlanProp $doc 'plan'
    if ($null -eq $plan) { throw ("The saved script '" + $Id + "' has no plan: open it in the SQL desk's Script mode and save it once.") }
    if (-not $Label) { $Label = 'script ' + [string](Get-SemPlanProp $doc 'name') }
    $defaults = Get-SemPlanProp $doc 'params'
    if ($null -eq $Params) { $Params = $defaults }
    return (Invoke-SemLocalScript -HomeDir $HomeDir -Plan $plan -Params $Params -Label $Label)
}

# ---------------------------------------------------------------------------
# Dataset exports
# ---------------------------------------------------------------------------
function Export-SemLocalDataset {
    <#
      Writes the whole local table $Name to $Path as csv, parquet, arrow, sqlite or xlsx. Returns @{ Rows; Ms; Path; Format;
      Note }. Excel stops at 1,048,575 rows (its sheet limit with the header) and says so in Note.
    #>
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Format)
    $Format = $Format.ToLowerInvariant()
    if (-not $script:SemExportFormats.Contains($Format)) { throw 'Export as csv, parquet, arrow, sqlite or xlsx.' }
    if ($Format -eq 'parquet' -or $Format -eq 'arrow') {
        $r = Export-SemLocalTable -HomeDir $HomeDir -Name $Name -Path $Path -Format $Format
        return @{ Rows = $r.Rows; Ms = $r.Ms; Path = $Path; Format = $Format; Note = '' }
    }
    Assert-SemLocalTableName $Name
    $c = Open-SemLocalConnection -HomeDir $HomeDir
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $note = ''
    try {
        switch ($Format) {
            'csv' { $n = [SemLocal.LocalTableExport]::Csv($c, $Name, $Path) }
            'sqlite' { $n = [SemLocal.LocalTableExport]::Sqlite($c, $Name, $Path) }
            'xlsx' {
                $cut = $false
                $n = [SemLocal.LocalTableExport]::Xlsx($c, $Name, $Path, [ref]$cut)
                if ($cut) { $note = ('Excel holds at most 1,048,576 rows on a sheet: the first {0:N0} rows were written. Export as CSV, Parquet or SQLite for all of them.' -f $n) }
            }
        }
    } catch { throw (ConvertTo-SemLocalMessage $_.Exception) }
    finally { $c.Dispose() }
    return @{ Rows = [long]$n; Ms = [long]$clock.ElapsedMilliseconds; Path = $Path; Format = $Format; Note = $note }
}

function Send-SemFileDownload {
    # Streams $Path to the client with Content-Disposition: attachment (the body never sits in memory).
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$FileName, [Parameter(Mandatory = $true)][string]$ContentType, [string[]]$ExtraHeaders = @())
    $stream = $script:Sem.Stream
    if ($null -eq $stream) { return }
    $len = (New-Object IO.FileInfo $Path).Length
    $ascii = ($FileName -replace '[^A-Za-z0-9._-]', '_')
    $lines = @('HTTP/1.1 200 OK', ('Content-Type: ' + $ContentType), ('Content-Length: ' + $len), 'Connection: close', ('Content-Disposition: attachment; filename="' + $ascii + '"'))
    $lines += (Get-SemSecurityHeaders -NoStore $true)
    $lines += $ExtraHeaders
    $head = [Text.Encoding]::ASCII.GetBytes(($lines -join "`r`n") + "`r`n`r`n")
    $stream.Write($head, 0, $head.Length)
    $fs = [IO.File]::OpenRead($Path)
    try { $fs.CopyTo($stream, 1048576) } finally { $fs.Dispose() }
    $stream.Flush()
    $script:Sem.Responded = $true
}

function Invoke-SemExportTask {
    # Runs in a local job runspace with the client handed over: writes the export to <home>\local\temp, streams it, deletes it.
    param([hashtable]$Spec)
    $fmt = $script:SemExportFormats[$Spec.Format]
    $tmp = Join-Path (Get-SemLocalDir -HomeDir $Spec.Home -Child 'temp') ('export-' + [guid]::NewGuid().ToString('N') + $fmt.Ext)
    try {
        $r = Export-SemLocalDataset -HomeDir $Spec.Home -Name $Spec.Table -Path $tmp -Format $Spec.Format
        $extra = @(('X-Semaphore-Rows: ' + $r.Rows))
        if ($r.Note) { $extra += ('X-Semaphore-Note: ' + [Uri]::EscapeDataString($r.Note)) }
        Send-SemFileDownload -Path $tmp -FileName ($Spec.Table + $fmt.Ext) -ContentType $fmt.Type -ExtraHeaders $extra
        Write-SemLog 'INFO' ("Local export of {0} as {1}: {2} rows in {3} ms" -f $Spec.Table, $Spec.Format, $r.Rows, $r.Ms)
    } catch {
        $msg = ConvertTo-SemLocalMessage $_.Exception
        Write-SemLog 'WARN' ('Local export of ' + $Spec.Table + ' failed: ' + $msg)
        if (-not $script:Sem.Responded) { $status = 422; if ($msg -match '^No table') { $status = 404 }; Send-SemError $status 'export-failed' $msg }
    } finally {
        if ([IO.File]::Exists($tmp)) { try { [IO.File]::Delete($tmp) } catch { } }
    }
}

# ---------------------------------------------------------------------------
# Tasks on the local job pool (LocalDb.ps1's runspaces): script runs, exports, pipeline runs
# ---------------------------------------------------------------------------
$script:SemLocalTaskScript = @'
param($Kind, $Spec, $Client, $Ctx)
if (-not (Get-Command Invoke-SemLocalScript -ErrorAction SilentlyContinue)) {
    foreach ($p in $Ctx.Paths) { . $p }
}
$script:SemLogPath = $Ctx.LogPath
$script:Sem.Version = $Ctx.Version
$script:Sem.Home = $Ctx.Home
$script:Sem.LocalShares = $Ctx.LocalShares
$script:Sem.LocalPullMaxRows = $Ctx.LocalPullMaxRows
$script:Sem.AwsSettings = $Ctx.AwsSettings
$script:Sem.Root = $Ctx.Root
$script:Sem.Responded = $false
$script:Sem.Stream = $null
try {
    if ($null -ne $Client) { $Client.SendTimeout = 600000; $script:Sem.Stream = $Client.GetStream() }
    switch ($Kind) {
        'script' {
            $r = $null
            try {
                if ($Spec.Id) { $r = Invoke-SemSavedScript -HomeDir $Ctx.Home -Id $Spec.Id -Params $Spec.Params }
                else { $r = Invoke-SemLocalScript -HomeDir $Ctx.Home -Plan $Spec.Plan -Params $Spec.Params -Label $Spec.Label -RowCap $Spec.RowCap }
                Send-SemJson 200 $r
            } catch { Send-SemError 400 'script-refused' (ConvertTo-SemLocalMessage $_.Exception) }
        }
        'export' { Invoke-SemExportTask -Spec $Spec }
        'pipeline' { Invoke-SemPipelineRun @Spec }
    }
} catch {
    Write-SemLog 'ERROR' ('Local task ' + $Kind + ': ' + $_.Exception.Message)
    if ($null -ne $Client -and -not $script:Sem.Responded) { try { Send-SemError 500 'internal' 'Internal server error.' } catch { } }
} finally {
    $script:Sem.Stream = $null
    if ($null -ne $Client) { try { $Client.Close() } catch { } }
}
'@

function Get-SemLocalTaskPaths {
    $here = $PSScriptRoot
    return @(foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Intelligence.ps1', 'Lake.ps1', 'Vault.ps1', 'Connectors.ps1', 'LocalDb.ps1', 'S3.ps1', 'LocalScript.ps1', 'Pipeline.ps1', 'Alerts.ps1') { $p = Join-Path $here $f; if ([IO.File]::Exists($p)) { $p } })
}

function Start-SemLocalTask {
    # Starts a script run, an export or a pipeline run on the local job pool; with -Client the task answers the request.
    param([Parameter(Mandatory = $true)][ValidateSet('script', 'export', 'pipeline')][string]$Kind, [Parameter(Mandatory = $true)][hashtable]$Spec, $Client = $null)
    if ($null -eq $script:Sem.LocalJobs) { $script:Sem.LocalJobs = New-Object System.Collections.Generic.List[object] }
    if ($null -eq $script:Sem.LocalPool) {
        $pool = [runspacefactory]::CreateRunspacePool(1, 3)
        $pool.Open()
        $script:Sem.LocalPool = $pool
    }
    $ctx = @{ Paths = (Get-SemLocalTaskPaths); LogPath = $script:SemLogPath; Version = $script:Sem.Version; Home = $script:Sem.Home; LocalShares = @($script:Sem.LocalShares); LocalPullMaxRows = $script:Sem.LocalPullMaxRows; AwsSettings = $script:Sem.AwsSettings; Root = $script:Sem.Root }
    $ps = [powershell]::Create()
    $ps.RunspacePool = $script:Sem.LocalPool
    [void]$ps.AddScript($script:SemLocalTaskScript).AddArgument($Kind).AddArgument($Spec).AddArgument($Client).AddArgument($ctx)
    $handle = $ps.BeginInvoke()
    $script:Sem.LocalJobs.Add(@{ PS = $ps; Handle = $handle; Job = ($Kind + ' ' + [guid]::NewGuid().ToString('N').Substring(0, 8)) })
    if ($null -ne $Client) { $script:Sem.Deferred = $true; $script:Sem.Responded = $true }
}

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
function Get-SemLocalSourceFiles {
    # The uploads kept for pipelines: <home>\local\sources\*.
    param([Parameter(Mandatory = $true)][string]$HomeDir)
    $d = Get-SemLocalDir -HomeDir $HomeDir -Child 'sources'
    return @(Get-ChildItem -LiteralPath $d -File -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object { [ordered]@{ name = $_.Name; bytes = [long]$_.Length; modified = $_.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ssZ') } })
}

function Invoke-SemLocalScriptRoute {
    param($Req)
    $p = $Req.Path; $m = $Req.Method; $homeDir = $script:Sem.Home
    try { Initialize-SemLocalTypes } catch { Send-SemError 501 'local-unavailable' ('The local database is not available on this computer: ' + $_.Exception.Message); return }
    if ($p -eq '/api/local/sources') {
        if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Send-SemJson 200 ([ordered]@{ files = @(Get-SemLocalSourceFiles -HomeDir $homeDir) }); return
    }
    if ($p -eq '/api/local/scripts') {
        if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Send-SemJson 200 @(Get-SemScriptList -HomeDir $homeDir); return
    }
    if ($p -match '^/api/local/scripts/([^/]+)$') {
        $id = $Matches[1]
        if ($id -cnotmatch $script:SemScriptIdRx) { Send-SemError 400 'bad-id' 'A script id has lower-case letters, digits, _ and - (1 to 64).'; return }
        if ($m -eq 'GET') {
            $text = Read-SemScript -HomeDir $homeDir -Id $id
            if ($null -eq $text) { Send-SemError 404 'not-found' ("No script '" + $id + "'."); return }
            Send-SemJsonText 200 $text; return
        }
        if ($m -eq 'PUT') {
            $script:Sem.SyncBusy = $true
            try { Save-SemScript -HomeDir $homeDir -Id $id -Bytes $Req.Body } catch { Send-SemError 400 'bad-script' $_.Exception.Message; return } finally { $script:Sem.SyncBusy = $false }
            Send-SemJson 200 ([ordered]@{ ok = $true; id = $id }); return
        }
        if ($m -eq 'DELETE') {
            if (-not (Remove-SemScript -HomeDir $homeDir -Id $id)) { Send-SemError 404 'not-found' ("No script '" + $id + "'."); return }
            Send-SemJson 200 ([ordered]@{ ok = $true }); return
        }
        Send-SemError 405 'method' 'Method not allowed.'; return
    }
    if ($p -eq '/api/local/script-run') {
        if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        $j = $Req.Json
        if ($j -isnot [Management.Automation.PSCustomObject]) { Send-SemError 400 'bad-json' 'The body must be a JSON object.'; return }
        $id = Get-SemPlanProp $j 'id'
        $plan = Get-SemPlanProp $j 'plan'
        $spec = @{ Params = (Get-SemPlanProp $j 'params'); Label = 'SQL desk'; RowCap = 500 }
        $label = Get-SemPlanProp $j 'label'
        if ($label -is [string] -and $label.Trim()) { $spec.Label = (ConvertTo-SemLogText $label 80) }
        if ($null -ne $id) {
            if ($id -isnot [string] -or $id -cnotmatch $script:SemScriptIdRx) { Send-SemError 400 'bad-id' 'Not a saved script id.'; return }
            $spec.Id = $id
        } else {
            $why = Test-SemScriptPlan $plan
            if ($why) { Send-SemError 400 'bad-plan' $why; return }
            $spec.Plan = $plan
        }
        Start-SemLocalTask -Kind 'script' -Spec $spec -Client $Req.Client
        return
    }
    if ($p -eq '/api/local/export') {
        if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        $table = [string](Get-SemPlanProp $Req.Json 'table')
        $format = ([string](Get-SemPlanProp $Req.Json 'format')).ToLowerInvariant()
        if ($table -cnotmatch $script:SemLocalTableRx) { Send-SemError 400 'bad-table' 'Not a table name.'; return }
        if (-not $script:SemExportFormats.Contains($format)) { Send-SemError 400 'bad-format' 'Export as csv, parquet, arrow, sqlite or xlsx.'; return }
        Start-SemLocalTask -Kind 'export' -Spec @{ Home = $homeDir; Table = $table; Format = $format } -Client $Req.Client
        return
    }
    Send-SemError 404 'not-found' 'Unknown API route.'
}
