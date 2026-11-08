#requires -Version 5.1
# =============================================================================
# Semaphore local database: big local files queried with SQL on the server, in the SQLite engine
# that ships with Windows (C:\Windows\System32\winsqlite3.dll). The engine and the importers are
# C# (LocalDb.cs, compiled once per process); this file holds the folder, the settings for big
# data, the import entry point, table management, the path rules and the import jobs.
#
#   <home>\local\warehouse.sqlite   the database (WAL, 8 KB pages, temp_store=FILE)
#   <home>\local\temp               SQLite's temp files (large sorts and DISTINCT spill here)
#   <home>\local\incoming           uploads while they arrive and import (deleted afterwards)
#   <home>\local\jobs\<job>.json    progress of an import, read by GET /api/local/import-status/<job>
#
# Built-in source { id: 'local', kind: 'local', provider: 'local' } (Query.ps1 Get-SemSources): the
# query and profile path opens the file read-only (LocalDb.cs: SQLITE_OPEN_READONLY, query_only,
# no ATTACH, an authorizer that allows only reads), and Test-SemSqlGuard still applies.
#
# Parquet and Arrow: Columnar.cs (namespace SemColumnar) is compiled in its own Add-Type call. LocalDb.cs never
# names it at compile time: LocalImport.Columnar and LocalExport.Columnar find SemColumnar.ColumnarFiles in the loaded
# assemblies and call Open / WriteParquet / WriteArrow by reflection, reading rows through a delegate bound to
# ITableReader.Next, so the row loop stays in C# and either file compiles without the other.
#
# Network paths: \\host\share is opened only when host is listed in settings localShares, because
# opening it sends the user's Windows sign-in (NTLM) to that host. Mapped and subst drives and
# symbolic links or junctions are resolved first and the target is checked the same way.
# =============================================================================

$script:SemLocalCsPath = Join-Path $PSScriptRoot 'LocalDb.cs'
$script:SemLocalColumnarPath = Join-Path $PSScriptRoot 'Columnar.cs'
$script:SemLocalExtensions = @('.csv', '.tsv', '.txt', '.tab', '.xlsx', '.xlsm', '.sqlite', '.sqlite3', '.db', '.parquet', '.pq', '.arrow', '.feather', '.ipc')
$script:SemLocalJobIdRx = '\A[a-f0-9]{32}\z'
$script:SemLocalTableRx = '\A[A-Za-z_][A-Za-z0-9_]{0,63}\z'

function Initialize-SemLocalTypes {
    # Compiles LocalDb.cs once per process (a runspace sees the types another one compiled), and
    # Columnar.cs beside it when that file exists: two separate assemblies, found at run time.
    if (-not ('SemLocal.LocalConnection' -as [type])) {
        $refs = @('System.Data', 'System.Xml', 'System.IO.Compression', 'System.IO.Compression.FileSystem')
        Add-Type -Path $script:SemLocalCsPath -ReferencedAssemblies $refs -ErrorAction Stop
    }
    if ([IO.File]::Exists($script:SemLocalColumnarPath) -and -not ('SemColumnar.ColumnarFiles' -as [type])) {
        try {
            Add-Type -Path $script:SemLocalColumnarPath -ReferencedAssemblies @('System.Data', 'System.Xml', 'System.IO.Compression', 'System.IO.Compression.FileSystem', 'System.Numerics') -ErrorAction Stop
        } catch {
            Write-SemLog 'WARN' ('Columnar.cs did not compile; Parquet and Arrow imports are off: ' + $_.Exception.Message)
        }
    }
}

function Get-SemLocalDir {
    param([Parameter(Mandatory = $true)][string]$HomeDir, [string]$Child = '')
    $d = Join-Path $HomeDir 'local'
    if ($Child) { $d = Join-Path $d $Child }
    if (-not [IO.Directory]::Exists($d)) { [void][IO.Directory]::CreateDirectory($d) }
    return $d
}

function Get-SemLocalDbPath {
    param([Parameter(Mandatory = $true)][string]$HomeDir)
    return (Join-Path (Get-SemLocalDir -HomeDir $HomeDir) 'warehouse.sqlite')
}

function Initialize-SemLocalDb {
    # Creates the folders and the database (8 KB pages, WAL) when missing and points SQLite's temp files at
    # <home>\local\temp. -Cleanup (server start): drops staging tables of imports that never finished and
    # job files older than a day.
    param([Parameter(Mandatory = $true)][string]$HomeDir, [switch]$Cleanup)
    Initialize-SemLocalTypes
    $temp = Get-SemLocalDir -HomeDir $HomeDir -Child 'temp'
    [void](Get-SemLocalDir -HomeDir $HomeDir -Child 'incoming')
    [void](Get-SemLocalDir -HomeDir $HomeDir -Child 'jobs')
    [SemLocal.LocalConnection]::SetTempDirectory($temp)
    $db = Get-SemLocalDbPath -HomeDir $HomeDir
    $isNew = -not [IO.File]::Exists($db)
    $c = New-Object SemLocal.LocalConnection ('Data Source=' + $db + ';Mode=ReadWrite')
    $c.Open()
    try {
        if ($isNew) { $c.Execute('PRAGMA page_size = 8192') }
        $c.Execute('PRAGMA journal_mode = WAL')
        [SemLocal.LocalImport]::EnsureMeta($c)
        if ($Cleanup) {
            $n = [SemLocal.LocalImport]::DropStagingTables($c)
            if ($n -gt 0) { Write-SemLog 'INFO' ("Local database: dropped {0} table(s) of imports that did not finish" -f $n) }
        }
    } finally { $c.Dispose() }
    if ($Cleanup) {
        $cut = (Get-Date).AddDays(-1)
        foreach ($f in @(Get-ChildItem -LiteralPath (Get-SemLocalDir -HomeDir $HomeDir -Child 'jobs') -File -ErrorAction SilentlyContinue)) { if ($f.LastWriteTime -lt $cut) { try { $f.Delete() } catch { } } }
        foreach ($f in @(Get-ChildItem -LiteralPath (Get-SemLocalDir -HomeDir $HomeDir -Child 'incoming') -File -ErrorAction SilentlyContinue)) { if ($f.LastWriteTime -lt $cut) { try { $f.Delete() } catch { } } }
    }
    return $db
}

function Open-SemLocalConnection {
    # Read-only unless -Write. Write connections get the settings for big imports.
    param([Parameter(Mandatory = $true)][string]$HomeDir, [switch]$Write, [int]$BusyMs = 5000)
    $db = Get-SemLocalDbPath -HomeDir $HomeDir
    if (-not [IO.File]::Exists($db) -or -not ('SemLocal.LocalConnection' -as [type])) { [void](Initialize-SemLocalDb -HomeDir $HomeDir) }
    $mode = 'ReadOnly'; if ($Write) { $mode = 'ReadWrite' }
    $c = New-Object SemLocal.LocalConnection ('Data Source=' + $db + ';Mode=' + $mode + ';BusyTimeout=' + $BusyMs)
    $c.Open()
    if ($Write) {
        try { $c.Execute('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -262144; PRAGMA temp_store = 1; PRAGMA foreign_keys = 0') }
        catch { $c.Dispose(); throw }
    }
    return $c
}

function Get-SemLocalSourceEntry {
    # The built-in source, in the shape Get-SemSources returns. The connection string names the file; it is never sent to the page.
    param([Parameter(Mandatory = $true)][string]$HomeDir)
    $db = Join-Path (Join-Path $HomeDir 'local') 'warehouse.sqlite'
    return [pscustomobject]@{ id = 'local'; label = 'Local database'; kind = 'local'; provider = 'local'; connection = ('Data Source=' + $db + ';Mode=ReadOnly'); raw = $null; home = $HomeDir }
}

function New-SemLocalQueryConnection {
    # New-SemConnection for the local source: read-only, opened on the worker.
    param([Parameter(Mandatory = $true)]$Source)
    $db = Get-SemLocalDbPath -HomeDir $Source.home
    if (-not [IO.File]::Exists($db) -or -not ('SemLocal.LocalConnection' -as [type])) { [void](Initialize-SemLocalDb -HomeDir $Source.home) }
    $c = New-Object SemLocal.LocalConnection ([string]$Source.connection)
    $c.Open()
    return $c
}

# ---------------------------------------------------------------------------
# Formats
# ---------------------------------------------------------------------------
function Get-SemLocalFormat {
    # csv | xlsx | sqlite | columnar, from the first bytes when they say, else from the extension. Gzip: 'gzip'.
    param([Parameter(Mandatory = $true)][string]$Path, [string]$Name = '')
    if (-not $Name) { $Name = $Path }
    $head = New-Object byte[] 16
    $n = 0
    $fs = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
    try { $n = $fs.Read($head, 0, 16) } finally { $fs.Dispose() }
    if ($n -ge 2 -and $head[0] -eq 0x1F -and $head[1] -eq 0x8B) { return 'gzip' }
    $ascii = [Text.Encoding]::ASCII.GetString($head, 0, $n)
    if ($ascii.StartsWith('SQLite format 3')) { return 'sqlite' }
    if ($ascii.StartsWith('PAR1') -or $ascii.StartsWith('ARROW1') -or $ascii.StartsWith('FEA1')) { return 'columnar' }
    $ext = [IO.Path]::GetExtension($Name).ToLowerInvariant()
    if ($n -ge 4 -and $head[0] -eq 0x50 -and $head[1] -eq 0x4B -and $head[2] -eq 3 -and $head[3] -eq 4) {
        if (@('.xlsx', '.xlsm') -contains $ext -or $ext -notin @('.parquet', '.pq', '.arrow', '.feather', '.ipc')) { return 'xlsx' }
    }
    switch ($ext) {
        { @('.xlsx', '.xlsm') -contains $_ } { return 'xlsx' }
        { @('.sqlite', '.sqlite3', '.db') -contains $_ } { return 'sqlite' }
        { @('.parquet', '.pq', '.arrow', '.feather', '.ipc') -contains $_ } { return 'columnar' }
    }
    if ($ext -eq '.xls') { throw 'Old Excel files (.xls) cannot be read: save the sheet as .xlsx or CSV.' }
    return 'csv'
}

function Test-SemLocalExtension {
    # $true when the file name has an extension the local database imports (a trailing .gz is allowed).
    param([string]$Name)
    $n = ([string]$Name).ToLowerInvariant()
    if ($n.EndsWith('.gz')) { $n = $n.Substring(0, $n.Length - 3) }
    return ($script:SemLocalExtensions -contains [IO.Path]::GetExtension($n))
}

function Expand-SemLocalGzip {
    # Decompresses a .gz to <home>\local\temp and returns the new file's path.
    param([string]$HomeDir, [string]$Path, [string]$Name)
    $inner = [IO.Path]::GetFileNameWithoutExtension($Name)
    if (-not [IO.Path]::GetExtension($inner)) { $inner += '.csv' }
    $out = Join-Path (Get-SemLocalDir -HomeDir $HomeDir -Child 'temp') ([guid]::NewGuid().ToString('N') + '-' + ($inner -replace '[^A-Za-z0-9._-]', '_'))
    $src = [IO.File]::OpenRead($Path)
    try {
        $gz = New-Object IO.Compression.GZipStream($src, [IO.Compression.CompressionMode]::Decompress)
        $dst = [IO.File]::Create($out)
        try { $gz.CopyTo($dst, 1048576) } finally { $dst.Dispose(); $gz.Dispose() }
    } finally { $src.Dispose() }
    return $out
}

# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------
function Import-SemLocalFile {
    <#
      Imports one file into the local database and returns @{ Table; Rows; Columns; Ms } (plus Tables,
      Types, Names and Warnings), or throws a message for a person. The format comes from the content and
      the extension: csv/tsv/txt (delimiter sniffed), xlsx (-Sheet, else the first sheet), sqlite/db
      (-Sheet names the table inside the file, else every table), parquet/arrow/feather (Columnar.cs).
      *.gz is decompressed transparently. An existing table name is never overwritten or added to by default: the new
      table gets a unique suffix (orders_2). -Append adds the rows to an existing table, columns matched by name (columns
      the file lacks are NULL; columns the table lacks are an error naming them), in one transaction, creating the table
      when it does not exist. -Replace swaps an existing table of that name in one
      transaction (the data goes to a staging table first), so a re-import never leaves half a table.
      A metadata row in _semaphore_tables records source label, path, time, rows, file size and ETag.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$HomeDir,
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Table,
        [string]$Sheet,
        [string]$SourceLabel,
        [switch]$Replace,
        [switch]$Append,
        [string]$ETag,
        [string]$FileName,
        [scriptblock]$Progress,
        $Options
    )
    Initialize-SemLocalTypes
    if (-not [IO.File]::Exists($Path)) { throw ('No such file: ' + $Path) }
    if (-not $FileName) { $FileName = [IO.Path]::GetFileName($Path) }
    if ($Table -and $Table -cnotmatch $script:SemLocalTableRx) { throw 'A table name has 1 to 64 letters, digits or _, and starts with a letter or _.' }
    $o = $Options
    if ($null -eq $o) { $o = New-Object SemLocal.ImportOptions }
    if ($Table) { $o.Table = $Table }
    if ($Replace -and $Append) { throw 'Choose -Replace or -Append, not both.' }
    $o.Replace = [bool]$Replace
    $o.Append = [bool]$Append
    if ($SourceLabel) { $o.SourceLabel = $SourceLabel } elseif (-not $o.SourceLabel) { $o.SourceLabel = $FileName }
    if ($ETag) { $o.ETag = $ETag }
    if (-not $o.SourcePath) { $o.SourcePath = $Path }
    if ($o.FileBytes -lt 0) { $o.FileBytes = (New-Object IO.FileInfo $Path).Length }
    if ($Progress) { $o.Progress = [Action[SemLocal.ImportProgress]]$Progress }

    $work = $Path; $name = $FileName; $expanded = $null
    $format = Get-SemLocalFormat -Path $work -Name $name
    if ($format -eq 'gzip') {
        $inner = $name; if ($inner.ToLowerInvariant().EndsWith('.gz')) { $inner = $inner.Substring(0, $inner.Length - 3) }
        $innerExt = [IO.Path]::GetExtension($inner).ToLowerInvariant()
        if (@('.xlsx', '.xlsm', '.sqlite', '.sqlite3', '.db', '.parquet', '.pq', '.arrow', '.feather', '.ipc') -contains $innerExt) {
            $expanded = Expand-SemLocalGzip -HomeDir $HomeDir -Path $work -Name $name
            $work = $expanded; $name = $inner
            $format = Get-SemLocalFormat -Path $work -Name $name
        } else {
            $format = 'csv'; $name = $inner   # LocalImport.Csv reads gzip as it streams
        }
    }
    $nameForTable = $name
    $o.Format = $format
    if ($format -eq 'csv') {
        $e = [IO.Path]::GetExtension($name).ToLowerInvariant()
        if ($e -eq '.tsv' -or $e -eq '.tab') { $o.Format = 'tsv' }
    }
    $conn = Open-SemLocalConnection -HomeDir $HomeDir -Write -BusyMs 60000
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        $results = @()
        $o.NameHint = $nameForTable
        switch ($format) {
            'csv' { $results = @([SemLocal.LocalImport]::Csv($conn, $work, $o.Table, $o)) }
            'xlsx' { $results = @([SemLocal.LocalImport]::Xlsx($conn, $work, $Sheet, $o.Table, $o)) }
            'sqlite' {
                $pick = @(); if ($Sheet) { $pick = @($Sheet) }
                $results = @([SemLocal.LocalImport]::Sqlite($conn, $work, [string[]]$pick, $o))
            }
            'columnar' { $results = @([SemLocal.LocalImport]::Columnar($conn, $work, $o.Table, $o)) }
        }
    } catch {
        throw (ConvertTo-SemLocalMessage $_.Exception)
    } finally {
        $conn.Dispose()
        if ($expanded) { try { [IO.File]::Delete($expanded) } catch { } }
    }
    if ($results.Count -eq 0) { throw 'Nothing was imported: the file has no tables.' }
    $first = $results[0]
    $rows = [long]0; foreach ($r in $results) { $rows += $r.Rows }
    $warnings = @(); foreach ($r in $results) { $warnings += @($r.Warnings) }
    Write-SemLog 'INFO' ("Local database: imported {0} ({1} rows) from {2} in {3} ms" -f (@($results | ForEach-Object { $_.Table }) -join ', '), $rows, $FileName, $clock.ElapsedMilliseconds)
    return @{
        Table = $first.Table; Rows = $rows; Columns = [int]$first.Columns; Ms = [long]$clock.ElapsedMilliseconds
        Tables = @($results | ForEach-Object { [ordered]@{ name = $_.Table; rows = $_.Rows; columns = $_.Columns } })
        Names = @($first.Names); Types = @($first.Types); Warnings = $warnings; Format = $format
        TotalRows = [long]$first.TotalRows; Appended = [bool]$first.Appended
    }
}

function ConvertTo-SemLocalMessage {
    # A person's message for an import failure (the innermost exception's text, without .NET wrappers).
    param($Exception)
    $e = $Exception
    while ($null -ne $e.InnerException -and ($e -is [Management.Automation.MethodInvocationException] -or $e -is [Management.Automation.RuntimeException] -or $e -is [Reflection.TargetInvocationException])) { $e = $e.InnerException }
    $m = [string]$e.Message
    if ($e -is [IO.FileNotFoundException]) { return 'The file was not found.' }
    if ($e -is [UnauthorizedAccessException]) { return 'Semaphore may not read that file (access denied).' }
    if ($e -is [IO.IOException] -and $m -match '(?i)being used by another process') { return 'The file is open in another program with a lock; close it there and try again.' }
    if ($e -is [IO.InvalidDataException]) { return 'The file is damaged or is not the kind its name says (' + $m + ').' }
    if ($m -match '(?i)database is locked|database table is locked') { return 'Another import is writing to the local database; try again when it finishes.' }
    if ($m -match '(?i)disk is full|database or disk is full') { return 'The disk is full: free some space and import again.' }
    return $m
}

# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------
function Get-SemLocalTables {
    # [{ name, rows, columns, bytes, source, path, format, importedAt, etag }] of the user's tables, by name.
    param([Parameter(Mandatory = $true)][string]$HomeDir)
    $c = Open-SemLocalConnection -HomeDir $HomeDir
    try {
        $meta = @{}
        $cmd = $c.CreateCommand()
        $cmd.CommandText = 'SELECT name, source, path, format, imported_at, rows, columns, table_bytes, etag, file_bytes FROM _semaphore_tables'
        $r = $cmd.ExecuteReader()
        try {
            while ($r.Read()) {
                $row = @{}
                for ($i = 0; $i -lt $r.FieldCount; $i++) { $v = $r.GetValue($i); if ($v -is [DBNull]) { $v = $null }; $row[$r.GetName($i)] = $v }
                $meta[([string]$row.name).ToLowerInvariant()] = $row
            }
        } finally { $r.Dispose(); $cmd.Dispose() }
        $out = New-Object System.Collections.Generic.List[object]
        foreach ($t in $c.UserTables()) {
            $name = [string]$t[0]
            $m = $meta[$name.ToLowerInvariant()]
            $cols = @($c.TableColumns($name) | ForEach-Object { [ordered]@{ name = [string]$_[0]; type = [string]$_[1] } })
            $rows = $null; $bytes = $null; $source = $null; $path = $null; $format = $null; $at = $null; $etag = $null; $fileBytes = $null
            if ($m) { $rows = $m.rows; $bytes = $m.table_bytes; $source = $m.source; $path = $m.path; $format = $m.format; $at = $m.imported_at; $etag = $m.etag; $fileBytes = $m.file_bytes }
            $out.Add([ordered]@{ name = $name; type = $t[1].ToLowerInvariant(); rows = $rows; columns = $cols; bytes = $bytes; source = $source; path = $path; format = $format; importedAt = $at; etag = $etag; fileBytes = $fileBytes })
        }
        $dbBytes = [long]0
        foreach ($f in @((Get-SemLocalDbPath -HomeDir $HomeDir), ((Get-SemLocalDbPath -HomeDir $HomeDir) + '-wal'))) { if ([IO.File]::Exists($f)) { $dbBytes += (New-Object IO.FileInfo $f).Length } }
        return [ordered]@{ tables = $out.ToArray(); databaseBytes = $dbBytes; engine = ('SQLite ' + [SemLocal.LocalConnection]::Version); columnar = [bool][SemLocal.LocalImport]::ColumnarAvailable }
    } finally { $c.Dispose() }
}

function Assert-SemLocalTableName {
    param([string]$Name)
    if ([string]$Name -cnotmatch $script:SemLocalTableRx) { throw 'A table name has 1 to 64 letters, digits or _, and starts with a letter or _.' }
    $bad = [SemLocal.LocalImport]::CheckTableName($Name)
    if ($bad) { throw $bad }
}

function Remove-SemLocalTable {
    # Drops a table (or view) and its metadata row. $false when there is no such table.
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Name)
    Assert-SemLocalTableName $Name
    $c = Open-SemLocalConnection -HomeDir $HomeDir -Write -BusyMs 3000
    try {
        $type = $null
        foreach ($t in $c.UserTables()) { if ([string]::Equals($t[0], $Name, [StringComparison]::OrdinalIgnoreCase)) { $type = $t[1]; $Name = $t[0] } }
        if (-not $type) { return $false }
        $c.Execute('BEGIN IMMEDIATE')
        try {
            $kw = 'TABLE'; if ($type -eq 'VIEW') { $kw = 'VIEW' }
            $c.Execute('DROP ' + $kw + ' ' + [SemLocal.LocalConnection]::Quote($Name))
            $cmd = $c.CreateCommand(); $cmd.CommandText = 'DELETE FROM _semaphore_tables WHERE name = ?'
            [void]$cmd.Parameters.Add((New-Object SemLocal.LocalParameter 'n', $Name)); [void]$cmd.ExecuteNonQuery(); $cmd.Dispose()
            $c.Execute('COMMIT')
        } catch { try { $c.Execute('ROLLBACK') } catch { }; throw }
        Write-SemLog 'INFO' ("Local database: dropped {0}" -f $Name)
        return $true
    } catch { throw (ConvertTo-SemLocalMessage $_.Exception) } finally { $c.Dispose() }
}

function Rename-SemLocalTable {
    # Renames a table and its metadata row. $false when there is no such table; throws when the new name is taken.
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][string]$NewName)
    Assert-SemLocalTableName $Name
    Assert-SemLocalTableName $NewName
    $c = Open-SemLocalConnection -HomeDir $HomeDir -Write -BusyMs 3000
    try {
        $found = $null
        foreach ($t in $c.UserTables()) { if ([string]::Equals($t[0], $Name, [StringComparison]::OrdinalIgnoreCase) -and $t[1] -eq 'TABLE') { $found = $t[0] } }
        if (-not $found) { return $false }
        if (-not [string]::Equals($found, $NewName, [StringComparison]::OrdinalIgnoreCase) -and $c.TableExists($NewName)) { throw ('A table named "' + $NewName + '" is already in the local database.') }
        $c.Execute('BEGIN IMMEDIATE')
        try {
            $c.Execute('ALTER TABLE ' + [SemLocal.LocalConnection]::Quote($found) + ' RENAME TO ' + [SemLocal.LocalConnection]::Quote($NewName))
            $cmd = $c.CreateCommand(); $cmd.CommandText = 'UPDATE _semaphore_tables SET name = ? WHERE name = ?'
            [void]$cmd.Parameters.Add((New-Object SemLocal.LocalParameter 'a', $NewName)); [void]$cmd.Parameters.Add((New-Object SemLocal.LocalParameter 'b', $found))
            [void]$cmd.ExecuteNonQuery(); $cmd.Dispose()
            $c.Execute('COMMIT')
        } catch { try { $c.Execute('ROLLBACK') } catch { }; throw }
        Write-SemLog 'INFO' ("Local database: renamed {0} to {1}" -f $found, $NewName)
        return $true
    } catch { throw (ConvertTo-SemLocalMessage $_.Exception) } finally { $c.Dispose() }
}

function Export-SemLocalTable {
    # Writes a local table to a Parquet or Arrow file with Columnar.cs's writers; returns @{ Rows; Ms; Path }.
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][string]$Path, [ValidateSet('parquet', 'arrow')][string]$Format = 'parquet')
    Assert-SemLocalTableName $Name
    $c = Open-SemLocalConnection -HomeDir $HomeDir
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try { $n = [SemLocal.LocalExport]::Columnar($c, $Name, $Path, $Format) }
    catch { throw (ConvertTo-SemLocalMessage $_.Exception) }
    finally { $c.Dispose() }
    return @{ Rows = [long]$n; Ms = [long]$clock.ElapsedMilliseconds; Path = $Path }
}

function Get-SemLocalSheets {
    # The sheets of a workbook, or the tables of a SQLite file, so the page can offer a choice.
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Path)
    Initialize-SemLocalTypes
    $format = Get-SemLocalFormat -Path $Path
    try {
        if ($format -eq 'xlsx') { return [ordered]@{ format = 'xlsx'; sheets = @([SemLocal.LocalImport]::XlsxSheets($Path)) } }
        if ($format -eq 'sqlite') {
            $c = Open-SemLocalConnection -HomeDir $HomeDir -Write
            try { return [ordered]@{ format = 'sqlite'; sheets = @([SemLocal.LocalImport]::SqliteTables($c, $Path)) } } finally { $c.Dispose() }
        }
    } catch { throw (ConvertTo-SemLocalMessage $_.Exception) }
    return [ordered]@{ format = $format; sheets = @() }
}

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
function Resolve-SemLocalPath {
    # @{ Path = <the file to open> } or @{ Error = <why not> }. No network host is contacted before its
    # name is checked against -Shares (settings localShares).
    param([string]$Path, [string[]]$Shares = @(), [string]$HomeDir = '')
    Initialize-SemLocalTypes
    try { $p = [SemLocal.LocalPaths]::Resolve($Path, [string[]]@($Shares)) }
    catch {
        $e = $_.Exception; while ($null -ne $e.InnerException -and $e -isnot [SemLocal.LocalPathException]) { $e = $e.InnerException }
        return @{ Error = [string]$e.Message }
    }
    if ($HomeDir) {
        $mine = [IO.Path]::GetFullPath((Join-Path $HomeDir 'local')).TrimEnd('\') + '\'
        if ($p.StartsWith($mine, [StringComparison]::OrdinalIgnoreCase)) { return @{ Error = "That file is part of Semaphore's own local database." } }
    }
    if (-not (Test-SemLocalExtension ([IO.Path]::GetFileName($p)))) { return @{ Error = 'Semaphore imports .csv, .tsv, .txt, .xlsx, .sqlite, .db, .parquet, .arrow and .feather files (also gzipped).' } }
    return @{ Path = $p }
}

# ---------------------------------------------------------------------------
# Import jobs: each runs on its own runspace (not the query pool), so a long import never blocks
# the server or other queries; progress goes to <home>\local\jobs\<job>.json.
# ---------------------------------------------------------------------------
function Write-SemLocalJobStatus {
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Job, [Parameter(Mandatory = $true)]$Status)
    $dir = Get-SemLocalDir -HomeDir $HomeDir -Child 'jobs'
    $f = Join-Path $dir ($Job + '.json')
    $tmp = Join-Path $dir ('.' + $Job + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($tmp, (ConvertTo-Json -InputObject $Status -Depth 6 -Compress), (New-Object Text.UTF8Encoding $false))
    try {
        if ([IO.File]::Exists($f)) { [IO.File]::Replace($tmp, $f, [NullString]::Value) } else { [IO.File]::Move($tmp, $f) }
    } catch {
        try { [IO.File]::Copy($tmp, $f, $true) } catch { }
    } finally { if ([IO.File]::Exists($tmp)) { try { [IO.File]::Delete($tmp) } catch { } } }
}

function Read-SemLocalJobStatus {
    # The job's status JSON text, or $null.
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Job)
    if ($Job -cnotmatch $script:SemLocalJobIdRx) { return $null }
    $f = Join-Path (Get-SemLocalDir -HomeDir $HomeDir -Child 'jobs') ($Job + '.json')
    for ($i = 0; $i -lt 3; $i++) {
        try { if ([IO.File]::Exists($f)) { return [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8) } else { return $null } }
        catch { Start-Sleep -Milliseconds 30 }
    }
    return $null
}

function Invoke-SemLocalJobBody {
    # Runs inside the job runspace: receives an upload (when there is one), imports, and keeps the status file current.
    param([hashtable]$Spec, $Client)
    $homeDir = $Spec.Home
    $job = $Spec.Job
    $status = [ordered]@{ job = $job; state = 'starting'; file = $Spec.FileName; phase = ''; rows = 0; bytes = 0; totalBytes = [long]$Spec.TotalBytes; table = $null; tables = @(); columns = 0; ms = 0; error = $null; warnings = @(); startedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); finishedAt = $null }
    Write-SemLocalJobStatus -HomeDir $homeDir -Job $job -Status $status
    $path = $Spec.Path
    $cleanup = $null
    try {
        if ($null -ne $Client) {
            # The upload: Content-Length bytes straight to <home>\local\incoming, never held in memory.
            $status.state = 'receiving'
            Write-SemLocalJobStatus -HomeDir $homeDir -Job $job -Status $status
            $cleanup = $path
            $Client.ReceiveTimeout = 60000
            $Client.SendTimeout = 30000
            $stream = $Client.GetStream()
            $script:Sem.Stream = $stream
            $total = [long]$Spec.TotalBytes
            $buf = New-Object byte[] 1048576
            $got = [long]0
            $tick = [Diagnostics.Stopwatch]::StartNew()
            $fs = New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 1048576)
            try {
                while ($got -lt $total) {
                    $want = [int][Math]::Min([long]$buf.Length, $total - $got)
                    $n = $stream.Read($buf, 0, $want)
                    if ($n -le 0) { break }
                    $fs.Write($buf, 0, $n)
                    $got += $n
                    if ($tick.ElapsedMilliseconds -ge 500) { $tick.Restart(); $status.bytes = $got; Write-SemLocalJobStatus -HomeDir $homeDir -Job $job -Status $status }
                }
            } finally { $fs.Dispose() }
            if ($got -ne $total) { throw 'The upload stopped before the whole file arrived.' }
            $status.bytes = $got
            Send-SemJson 202 ([ordered]@{ job = $job; file = $Spec.FileName; bytes = $got })
            try { $Client.Close() } catch { }
            $script:Sem.Stream = $null
            $Client = $null
        }
        $status.state = 'importing'
        Write-SemLocalJobStatus -HomeDir $homeDir -Job $job -Status $status
        $opts = New-Object SemLocal.ImportOptions
        [SemLocal.LocalJobs]::Register($job, $opts)
        # The progress callback runs on this thread, called from C#; it finds the job by dynamic scope.
        $semLocalJobRef = @{ Status = $status; Home = $homeDir; Job = $job }
        $progress = {
            param($p)
            $semLocalJobRef.Status.phase = [string]$p.Phase; $semLocalJobRef.Status.rows = [long]$p.Rows
            if ($p.TotalBytes -gt 0) { $semLocalJobRef.Status.bytes = [long]$p.Bytes; $semLocalJobRef.Status.totalBytes = [long]$p.TotalBytes }
            if ($p.Table) { $semLocalJobRef.Status.table = [string]$p.Table }
            Write-SemLocalJobStatus -HomeDir $semLocalJobRef.Home -Job $semLocalJobRef.Job -Status $semLocalJobRef.Status
        }
        $args2 = @{ HomeDir = $homeDir; Path = $path; FileName = $Spec.FileName; Options = $opts; Progress = $progress; SourceLabel = $Spec.SourceLabel }
        if ($Spec.Table) { $args2.Table = $Spec.Table }
        if ($Spec.Sheet) { $args2.Sheet = $Spec.Sheet }
        if ($Spec.Replace) { $args2.Replace = $true }
        if ($Spec.Append) { $args2.Append = $true }
        $r = Import-SemLocalFile @args2
        $status.state = 'done'; $status.table = $r.Table; $status.rows = $r.Rows; $status.columns = $r.Columns; $status.ms = $r.Ms
        $status.tables = @($r.Tables); $status.warnings = @($r.Warnings)
    } catch {
        $status.state = 'failed'
        $status.error = ConvertTo-SemLocalMessage $_.Exception
        Write-SemLog 'WARN' ('Local import {0} failed: {1}' -f $Spec.FileName, $status.error)
        if ($null -ne $Client) { try { Send-SemError 400 'import-failed' $status.error } catch { } }
    } finally {
        try { [SemLocal.LocalJobs]::Unregister($job) } catch { }
        $status.finishedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        Write-SemLocalJobStatus -HomeDir $homeDir -Job $job -Status $status
        if ($null -ne $Client) { try { $Client.Close() } catch { } }
        $script:Sem.Stream = $null
        if ($cleanup) { try { [IO.File]::Delete($cleanup) } catch { } }
    }
}

$script:SemLocalJobScript = @'
param($Spec, $Client, $Ctx)
if (-not (Get-Command Invoke-SemLocalJobBody -ErrorAction SilentlyContinue)) {
    . $Ctx.CommonPath
    . $Ctx.HttpPath
    . $Ctx.RoutesPath
    . $Ctx.LocalDbPath
}
$script:SemLogPath = $Ctx.LogPath
$script:Sem.Version = $Ctx.Version
$script:Sem.Responded = $false
Invoke-SemLocalJobBody -Spec $Spec -Client $Client
'@

function Start-SemLocalJob {
    # Starts an import job on its own runspace; with -Client the job reads the upload body and answers 202 { job }.
    param([Parameter(Mandatory = $true)][hashtable]$Spec, $Client = $null)
    if ($null -eq $script:Sem.LocalJobs) { $script:Sem.LocalJobs = New-Object System.Collections.Generic.List[object] }
    if ($null -eq $script:Sem.LocalPool) {
        $pool = [runspacefactory]::CreateRunspacePool(1, 3)
        $pool.Open()
        $script:Sem.LocalPool = $pool
    }
    $here = $PSScriptRoot
    $ctx = @{ CommonPath = (Join-Path $here 'Common.ps1'); HttpPath = (Join-Path $here 'Http.ps1'); RoutesPath = (Join-Path $here 'Routes.ps1'); LocalDbPath = (Join-Path $here 'LocalDb.ps1'); LogPath = $script:SemLogPath; Version = $script:Sem.Version }
    $ps = [powershell]::Create()
    $ps.RunspacePool = $script:Sem.LocalPool
    [void]$ps.AddScript($script:SemLocalJobScript).AddArgument($Spec).AddArgument($Client).AddArgument($ctx)
    $handle = $ps.BeginInvoke()
    $script:Sem.LocalJobs.Add(@{ PS = $ps; Handle = $handle; Job = $Spec.Job })
    if ($null -ne $Client) { $script:Sem.Deferred = $true; $script:Sem.Responded = $true }
}

function Update-SemLocalJobs {
    $w = $script:Sem.LocalJobs
    if ($null -eq $w) { return }
    foreach ($item in @($w.ToArray())) {
        if (-not $item.Handle.IsCompleted) { continue }
        try { [void]$item.PS.EndInvoke($item.Handle) } catch { Write-SemLog 'ERROR' ('Local import job ' + $item.Job + ': ' + $_.Exception.Message) }
        try { $item.PS.Dispose() } catch { }
        [void]$w.Remove($item)
    }
}

function Stop-SemLocalJobs {
    # Server stop: cancels running imports (their staging tables are dropped) and waits a bounded time.
    param([int]$WaitMs = 3000)
    try { [SemLocal.LocalJobs]::CancelAll() } catch { }
    $w = $script:Sem.LocalJobs
    if ($null -ne $w) {
        $clock = [Diagnostics.Stopwatch]::StartNew()
        foreach ($item in @($w.ToArray())) {
            $left = [Math]::Max(0, $WaitMs - [int]$clock.ElapsedMilliseconds)
            try { [void]$item.Handle.AsyncWaitHandle.WaitOne($left) } catch { }
            if ($item.Handle.IsCompleted) { try { $item.PS.Dispose() } catch { } }
        }
        $w.Clear()
    }
    if ($null -ne $script:Sem.LocalPool) { try { $script:Sem.LocalPool.Close(); $script:Sem.LocalPool.Dispose() } catch { } }
    $script:Sem.LocalPool = $null
}

function Get-SemLocalRunningJobCount {
    $w = $script:Sem.LocalJobs
    if ($null -eq $w) { return 0 }
    $n = 0
    foreach ($item in @($w.ToArray())) { if (-not $item.Handle.IsCompleted) { $n++ } }
    return $n
}

# ---------------------------------------------------------------------------
# Routes (Routes.ps1 hands /api/local/* here, after the session gate)
# ---------------------------------------------------------------------------
function Get-SemLocalUploadName {
    # The X-File-Name header (percent-encoded UTF-8) as a bare file name, or $null.
    param($Headers)
    if ($null -eq $Headers -or -not $Headers.ContainsKey('X-File-Name')) { return $null }
    $raw = [string]$Headers['X-File-Name']
    try { $name = [Uri]::UnescapeDataString($raw) } catch { return $null }
    $name = [IO.Path]::GetFileName($name.Replace('/', '\'))
    if (-not $name -or $name.Length -gt 200 -or $name -match '[\x00-\x1f]') { return $null }
    return $name
}

function Invoke-SemLocalUpload {
    # POST /api/local/import: raw file body (Content-Length bytes), X-File-Name, optional X-Table, X-Sheet, X-Replace: 1 or X-Append: 1.
    param($Req)
    $homeDir = $script:Sem.Home
    $name = Get-SemLocalUploadName $Req.Headers
    if (-not $name) { Send-SemError 400 'bad-name' 'The upload needs an X-File-Name header with the file name.'; return }
    if (-not (Test-SemLocalExtension $name)) { Send-SemError 415 'unsupported' 'Semaphore imports .csv, .tsv, .txt, .xlsx, .sqlite, .db, .parquet, .arrow and .feather files (also gzipped).'; return }
    $len = [long]$Req.ContentLength
    if ($len -le 0) { Send-SemError 400 'empty' 'The file is empty.'; return }
    $table = $null; $sheet = $null
    if ($Req.Headers.ContainsKey('X-Table')) { $table = [string]$Req.Headers['X-Table']; if ($table -cnotmatch $script:SemLocalTableRx) { Send-SemError 400 'bad-table' 'A table name has 1 to 64 letters, digits or _, and starts with a letter or _.'; return } }
    if ($Req.Headers.ContainsKey('X-Sheet')) { try { $sheet = [Uri]::UnescapeDataString([string]$Req.Headers['X-Sheet']) } catch { $sheet = $null } }
    $replace = ($Req.Headers.ContainsKey('X-Replace') -and [string]$Req.Headers['X-Replace'] -eq '1')
    $append = ($Req.Headers.ContainsKey('X-Append') -and [string]$Req.Headers['X-Append'] -eq '1')
    if ($replace -and $append) { Send-SemError 400 'bad-mode' 'Choose replace or append, not both.'; return }
    $incoming = Get-SemLocalDir -HomeDir $homeDir -Child 'incoming'
    try {
        $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($incoming))
        if ($drive.AvailableFreeSpace -lt ($len * 2 + 104857600)) { Send-SemError 507 'disk-full' ('Not enough free disk space for this file: the upload and the imported table need about {0:N1} GB on {1}.' -f (($len * 2) / 1GB), $drive.Name); return }
    } catch { }
    $job = [guid]::NewGuid().ToString('N')
    $safe = ($name -replace '[^A-Za-z0-9._-]', '_')
    $spec = @{ Home = $homeDir; Job = $job; Path = (Join-Path $incoming ($job + '-' + $safe)); FileName = $name; TotalBytes = $len; Table = $table; Sheet = $sheet; Replace = $replace; Append = $append; SourceLabel = ($name + ' (uploaded)') }
    Write-SemLog 'INFO' ("Local import {0}: receiving {1} ({2} bytes)" -f $job, $name, $len)
    Start-SemLocalJob -Spec $spec -Client $Req.Client
}

function Invoke-SemLocalPathImport {
    # POST /api/local/import-path { path, sheet?, table?, replace?, append? }: reads the file where it is.
    param($Req)
    $j = $Req.Json
    if ($j -isnot [Management.Automation.PSCustomObject]) { Send-SemError 400 'bad-json' 'The body must be a JSON object.'; return }
    $raw = Get-SemJsonProp $j 'path'
    if ($raw -isnot [string] -or -not $raw.Trim()) { Send-SemError 400 'bad-path' 'Give the path of a file.'; return }
    $table = Get-SemJsonProp $j 'table'
    if ($null -ne $table -and $table -ne '' -and ($table -isnot [string] -or $table -cnotmatch $script:SemLocalTableRx)) { Send-SemError 400 'bad-table' 'A table name has 1 to 64 letters, digits or _, and starts with a letter or _.'; return }
    $sheet = Get-SemJsonProp $j 'sheet'
    if ($null -ne $sheet -and $sheet -isnot [string]) { Send-SemError 400 'bad-sheet' 'sheet must be a string.'; return }
    $res = Resolve-SemLocalPath -Path $raw -Shares @($script:Sem.LocalShares) -HomeDir $script:Sem.Home
    if ($res.ContainsKey('Error')) { Send-SemError 403 'path-refused' $res.Error; return }
    $job = [guid]::NewGuid().ToString('N')
    $label = [IO.Path]::GetFileName($res.Path)
    $spec = @{ Home = $script:Sem.Home; Job = $job; Path = $res.Path; FileName = $label; TotalBytes = (New-Object IO.FileInfo $res.Path).Length; Table = [string]$table; Sheet = [string]$sheet; Replace = ((Get-SemJsonProp $j 'replace') -eq $true); Append = ((Get-SemJsonProp $j 'append') -eq $true); SourceLabel = $res.Path }
    if ($spec.Replace -and $spec.Append) { Send-SemError 400 'bad-mode' 'Choose replace or append, not both.'; return }
    Write-SemLog 'INFO' ("Local import {0}: reading {1} in place" -f $job, $label)
    Start-SemLocalJob -Spec $spec
    Send-SemJson 202 ([ordered]@{ job = $job; file = $label; path = $res.Path })
}

function Invoke-SemLocalRoute {
    param($Req)
    $p = $Req.Path; $m = $Req.Method; $homeDir = $script:Sem.Home
    try { Initialize-SemLocalTypes } catch { Send-SemError 501 'local-unavailable' ('The local database is not available on this computer: ' + $_.Exception.Message); return }
    if ($p -eq '/api/local/import') {
        if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Invoke-SemLocalUpload -Req $Req; return
    }
    if ($p -eq '/api/local/import-path') {
        if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Invoke-SemLocalPathImport -Req $Req; return
    }
    if ($p -eq '/api/local/sheets') {
        if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        $raw = Get-SemJsonProp $Req.Json 'path'
        if ($raw -isnot [string]) { Send-SemError 400 'bad-path' 'Give the path of a file.'; return }
        $res = Resolve-SemLocalPath -Path $raw -Shares @($script:Sem.LocalShares) -HomeDir $homeDir
        if ($res.ContainsKey('Error')) { Send-SemError 403 'path-refused' $res.Error; return }
        try { Send-SemJson 200 (Get-SemLocalSheets -HomeDir $homeDir -Path $res.Path) } catch { Send-SemError 422 'unreadable' $_.Exception.Message }
        return
    }
    if ($p -eq '/api/local/tables') {
        if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        try { Send-SemJson 200 (Get-SemLocalTables -HomeDir $homeDir) } catch { Send-SemError 500 'local-db' (ConvertTo-SemLocalMessage $_.Exception) }
        return
    }
    if ($p -match '^/api/local/import-status/([^/]+)$') {
        if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        $text = Read-SemLocalJobStatus -HomeDir $homeDir -Job $Matches[1]
        if ($null -eq $text) { Send-SemError 404 'not-found' 'No such import.'; return }
        Send-SemJsonText 200 $text; return
    }
    if ($p -eq '/api/local/import-cancel') {
        if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        $job = [string](Get-SemJsonProp $Req.Json 'job')
        $done = $false
        if ($job -cmatch $script:SemLocalJobIdRx) { $done = [SemLocal.LocalJobs]::Cancel($job) }
        Send-SemJson 200 ([ordered]@{ ok = $true; cancelled = $done }); return
    }
    if ($p -match '^/api/local/tables/([^/]+)(/rename)?$') {
        $name = $Matches[1]; $rename = [bool]$Matches[2]
        if ($name -cnotmatch $script:SemLocalTableRx) { Send-SemError 400 'bad-table' 'Not a table name.'; return }
        try {
            if ($rename) {
                if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
                $to = Get-SemJsonProp $Req.Json 'name'
                if ($to -isnot [string] -or $to -cnotmatch $script:SemLocalTableRx) { Send-SemError 400 'bad-table' 'A table name has 1 to 64 letters, digits or _, and starts with a letter or _.'; return }
                $script:Sem.SyncBusy = $true
                try { $ok = Rename-SemLocalTable -HomeDir $homeDir -Name $name -NewName $to } finally { $script:Sem.SyncBusy = $false }
                if (-not $ok) { Send-SemError 404 'not-found' ("No table '$name'."); return }
                Send-SemJson 200 ([ordered]@{ ok = $true; name = $to }); return
            }
            if ($m -ne 'DELETE') { Send-SemError 405 'method' 'Method not allowed.'; return }
            $script:Sem.SyncBusy = $true
            try { $ok = Remove-SemLocalTable -HomeDir $homeDir -Name $name } finally { $script:Sem.SyncBusy = $false }
            if (-not $ok) { Send-SemError 404 'not-found' ("No table '$name'."); return }
            Send-SemJson 200 ([ordered]@{ ok = $true }); return
        } catch {
            $msg = [string]$_.Exception.Message
            $status = 400; if ($msg -match 'Another import') { $status = 409 }
            Send-SemError $status 'local-db' $msg; return
        }
    }
    Send-SemError 404 'not-found' 'Unknown API route.'
}
