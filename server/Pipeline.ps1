#requires -Version 5.1
# =============================================================================
# Semaphore data-prep pipelines: an ordered list of steps that rebuilds tidy tables in the local database.
#
#   import   a file (a path, or a network share listed in localShares), an upload kept in <home>\local\sources,
#            or an S3 object or prefix from the allowlist; swapped in with -Replace; skipped when the source is
#            unchanged (size and modified time, or the S3 ETags) unless the run is forced
#   script   a saved script (LocalScript.ps1), run in one transaction
#   pull     IMPORT INTO from a live source: one guarded SELECT, rows swapped in
#   publish  marks the playbook snapshots that read the outputs as out of date (invalidatedAt), so whoever can reach
#            the local database refreshes them next (an open page, or "refresh run" headless); report editions read
#            the tables as they are when they are produced
#
# Files (<home>\pipelines):
#   <id>.json                 the pipeline (validated, at most 256 KB)
#   state\<id>.json           last run, last scheduled time, each import step's source fingerprint
#   runs\<id>\<run>.json      one run's log: per step state, rows, ms, warnings, error (the newest 30 are kept)
#   .running.json             the run in progress (pid, pipeline, run): one run at a time, across processes
#
# A run stops at the first failed step with its message. Every table a step builds is swapped in whole (imports and
# pulls stage and rename in one transaction; a script commits or rolls back), so a failed run never leaves half a
# table: the tables of the steps before it are complete, the failed step's are as they were.
#
# Schedule: { every: off | hourly | daily | weekly, minute (hourly), time "HH:mm" (daily, weekly), days [mon..sun]
# (weekly), catchUp }. The running server checks it on a tick (Invoke-SemPipelineTick from Update-SemWorkers);
# a time missed while the server was down runs once at start-up when catchUp is set. Without the server, Windows
# Task Scheduler can run "Semaphore-CLI.bat pipeline run --id <id>" (docs/PIPELINES.md).
# =============================================================================

$script:SemPipelineIdRx = '\A[a-z0-9][a-z0-9_-]{0,63}\z'
$script:SemPipelineMaxBytes = 262144
$script:SemPipelineMaxSteps = 50
$script:SemPipelineRunsKept = 30
$script:SemPipelineDays = @('sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat')
$script:SemPipelineKinds = @('import', 'script', 'pull', 'publish')

function Get-SemPipelineDir {
    param([Parameter(Mandatory = $true)][string]$HomeDir, [string]$Child = '')
    $d = Join-Path $HomeDir 'pipelines'
    if ($Child) { $d = Join-Path $d $Child }
    if (-not [IO.Directory]::Exists($d)) { [void][IO.Directory]::CreateDirectory($d) }
    return $d
}

function Get-SemPipeProp {
    param($Object, [string]$Name)
    if ($null -eq $Object -or $Object -isnot [Management.Automation.PSCustomObject]) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

# ---------------------------------------------------------------------------
# Validation (the same rules as src/core/pipeline.ts validatePipeline)
# ---------------------------------------------------------------------------
function Test-SemPipeline {
    # $null when $Doc (a parsed pipeline) is valid, else the first problem in words.
    param($Doc)
    if ($Doc -isnot [Management.Automation.PSCustomObject]) { return 'A pipeline is a JSON object.' }
    if ([string](Get-SemPipeProp $Doc 'version') -ne '1') { return 'A pipeline has "version": 1.' }
    $name = Get-SemPipeProp $Doc 'name'
    if ($name -isnot [string] -or $name.Trim().Length -eq 0 -or $name.Length -gt 100 -or $name -match '[\x00-\x1f]') { return 'A pipeline has a name of 1 to 100 characters.' }
    $steps = @(Get-SemPipeProp $Doc 'steps')
    if ($null -eq (Get-SemPipeProp $Doc 'steps') -or $steps.Count -eq 0) { return 'A pipeline has at least one step.' }
    if ($steps.Count -gt $script:SemPipelineMaxSteps) { return ('A pipeline has at most ' + $script:SemPipelineMaxSteps + ' steps.') }
    $ids = @{}
    $i = 0
    foreach ($s in $steps) {
        $i++
        $where = 'Step ' + $i
        if ($s -isnot [Management.Automation.PSCustomObject]) { return ($where + ' is not an object.') }
        $id = [string](Get-SemPipeProp $s 'id')
        if ($id -cnotmatch $script:SemPipelineIdRx) { return ($where + ': an id has lower-case letters, digits, _ and - (1 to 64).') }
        if ($ids.ContainsKey($id)) { return ($where + ': the id "' + $id + '" is used twice.') }
        $ids[$id] = $true
        $kind = [string](Get-SemPipeProp $s 'kind')
        if ($script:SemPipelineKinds -notcontains $kind) { return ($where + ': kind is import, script, pull or publish.') }
        $sn = Get-SemPipeProp $s 'name'
        if ($null -ne $sn -and ($sn -isnot [string] -or $sn.Length -gt 100)) { return ($where + ': name is text of at most 100 characters.') }
        $table = Get-SemPipeProp $s 'table'
        if ($kind -eq 'import' -or $kind -eq 'pull') {
            if ($table -isnot [string] -or $table -cnotmatch '\A[A-Za-z_][A-Za-z0-9_]{0,63}\z' -or $table -match '(?i)\A(sqlite_|_semaphore)') { return ($where + ': table has letters, digits and _ (not starting with sqlite_ or _semaphore).') }
        }
        switch ($kind) {
            'import' {
                $path = Get-SemPipeProp $s 'path'; $upload = Get-SemPipeProp $s 'upload'; $s3 = Get-SemPipeProp $s 's3'
                $given = @(@($path, $upload, $s3) | Where-Object { $null -ne $_ -and $_ -ne '' }).Count
                if ($given -ne 1) { return ($where + ': an import reads one of path, upload or s3.') }
                if ($null -ne $path -and $path -ne '' -and ($path -isnot [string] -or $path.Length -gt 1024 -or $path -match '[\x00-\x1f]')) { return ($where + ': path is the file path as text.') }
                if ($null -ne $upload -and $upload -ne '' -and ($upload -isnot [string] -or $upload -ne [IO.Path]::GetFileName($upload) -or $upload.Length -gt 200 -or $upload -match '[\x00-\x1f\\/:]')) { return ($where + ': upload is the name of a file in the local sources folder.') }
                if ($null -ne $s3) {
                    if ($s3 -isnot [Management.Automation.PSCustomObject]) { return ($where + ': s3 is { bucket, key } or { bucket, prefix }.') }
                    $b = Get-SemPipeProp $s3 'bucket'; $k = Get-SemPipeProp $s3 'key'; $px = Get-SemPipeProp $s3 'prefix'
                    if ($b -isnot [string] -or -not $b) { return ($where + ': s3 names the bucket.') }
                    if (@(@($k, $px) | Where-Object { $null -ne $_ }).Count -ne 1) { return ($where + ': s3 has a key or a prefix, not both.') }
                }
                $sheet = Get-SemPipeProp $s 'sheet'
                if ($null -ne $sheet -and ($sheet -isnot [string] -or $sheet.Length -gt 100)) { return ($where + ': sheet is text.') }
                $force = Get-SemPipeProp $s 'force'
                if ($null -ne $force -and $force -isnot [bool]) { return ($where + ': force is true or false.') }
            }
            'script' {
                $sc = Get-SemPipeProp $s 'script'
                if ($sc -isnot [string] -or $sc -cnotmatch '\A[a-z0-9][a-z0-9_-]{0,63}\z') { return ($where + ': script is the id of a saved script.') }
            }
            'pull' {
                $src = Get-SemPipeProp $s 'source'
                if ($src -isnot [string] -or $src -cnotmatch '\A[A-Za-z0-9_-]{1,64}\z' -or $src -eq 'local') { return ($where + ': source is the id of a live source.') }
                $sql = Get-SemPipeProp $s 'sql'
                if ($sql -isnot [string] -or -not $sql.Trim()) { return ($where + ': sql is the SELECT to run on the source.') }
                $why = Test-SemSqlGuard -Sql $sql
                if ($why) { return ($where + ': ' + $why) }
                $mode = Get-SemPipeProp $s 'mode'
                if ($null -ne $mode -and @('replace', 'append') -notcontains $mode) { return ($where + ': mode is replace or append.') }
            }
            'publish' {
                $tables = Get-SemPipeProp $s 'tables'
                if ($null -ne $tables) { foreach ($t in @($tables)) { if ($t -isnot [string] -or $t -cnotmatch '\A[A-Za-z_][A-Za-z0-9_]{0,63}\z') { return ($where + ': tables lists table names.') } } }
            }
        }
    }
    $sch = Get-SemPipeProp $Doc 'schedule'
    if ($null -ne $sch) {
        if ($sch -isnot [Management.Automation.PSCustomObject]) { return 'schedule is an object.' }
        $every = [string](Get-SemPipeProp $sch 'every')
        if (@('off', 'hourly', 'daily', 'weekly') -notcontains $every) { return 'schedule.every is off, hourly, daily or weekly.' }
        if ($every -eq 'hourly') {
            $m = Get-SemPipeProp $sch 'minute'; $n = -1
            if ($null -ne $m -and (-not [int]::TryParse([string]$m, [ref]$n) -or $n -lt 0 -or $n -gt 59)) { return 'schedule.minute is 0 to 59.' }
        }
        if ($every -eq 'daily' -or $every -eq 'weekly') {
            $t = [string](Get-SemPipeProp $sch 'time')
            if ($t -cnotmatch '\A([01][0-9]|2[0-3]):[0-5][0-9]\z') { return 'schedule.time is HH:mm (24 hours).' }
        }
        if ($every -eq 'weekly') {
            $days = @(Get-SemPipeProp $sch 'days')
            if ($days.Count -eq 0) { return 'A weekly schedule names its days.' }
            foreach ($d in $days) { if ($script:SemPipelineDays -notcontains [string]$d) { return 'schedule.days are mon, tue, wed, thu, fri, sat, sun.' } }
        }
        $cu = Get-SemPipeProp $sch 'catchUp'
        if ($null -ne $cu -and $cu -isnot [bool]) { return 'schedule.catchUp is true or false.' }
    }
    return $null
}

function Test-SemPipelineBytes {
    param([byte[]]$Bytes)
    if ($Bytes.Length -gt $script:SemPipelineMaxBytes) { return 'A pipeline may be at most 256 KB.' }
    try { $j = (New-Object Text.UTF8Encoding $false).GetString($Bytes).TrimStart([char]0xFEFF) | ConvertFrom-Json -ErrorAction Stop } catch { return 'The pipeline is not valid JSON.' }
    return (Test-SemPipeline $j)
}

# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------
function Read-SemPipeline {
    # The parsed pipeline, or $null.
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Id)
    if ($Id -cnotmatch $script:SemPipelineIdRx) { return $null }
    $f = Join-Path (Get-SemPipelineDir -HomeDir $HomeDir) ($Id + '.json')
    if (-not [IO.File]::Exists($f)) { return $null }
    return ([IO.File]::ReadAllText($f, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json)
}

function Read-SemPipelineState {
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Id)
    $f = Join-Path (Get-SemPipelineDir -HomeDir $HomeDir -Child 'state') ($Id + '.json')
    $st = @{ fingerprints = @{}; lastScheduled = $null; lastRun = $null; steps = @{} }
    if ([IO.File]::Exists($f)) {
        try {
            $j = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8) | ConvertFrom-Json
            $fp = Get-SemPipeProp $j 'fingerprints'; if ($fp) { foreach ($p in $fp.PSObject.Properties) { $st.fingerprints[$p.Name] = [string]$p.Value } }
            $sp = Get-SemPipeProp $j 'steps'; if ($sp) { foreach ($p in $sp.PSObject.Properties) { $st.steps[$p.Name] = $p.Value } }
            $st.lastScheduled = Get-SemPipeProp $j 'lastScheduled'
            $st.lastRun = Get-SemPipeProp $j 'lastRun'
        } catch { }
    }
    return $st
}

function Save-SemPipelineState {
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Id, [Parameter(Mandatory = $true)][hashtable]$State)
    $doc = [ordered]@{ version = 1; lastScheduled = $State.lastScheduled; lastRun = $State.lastRun; fingerprints = $State.fingerprints; steps = $State.steps }
    Save-SemDoc -Dir (Get-SemPipelineDir -HomeDir $HomeDir -Child 'state') -Id $Id -Bytes ([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $doc -Depth 8 -Compress)))
}

function Get-SemPipelineList {
    param([Parameter(Mandatory = $true)][string]$HomeDir)
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($f in @(Get-ChildItem -LiteralPath (Get-SemPipelineDir -HomeDir $HomeDir) -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name)) {
        $id = [IO.Path]::GetFileNameWithoutExtension($f.Name)
        if ($id -cnotmatch $script:SemPipelineIdRx) { continue }
        try { $p = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { continue }
        $st = Read-SemPipelineState -HomeDir $HomeDir -Id $id
        $out.Add([ordered]@{ id = $id; name = [string](Get-SemPipeProp $p 'name'); steps = @(Get-SemPipeProp $p 'steps').Count; schedule = (Get-SemPipeProp $p 'schedule'); lastRun = $st.lastRun; running = (Test-SemPipelineRunning -HomeDir $HomeDir -Id $id) })
    }
    return $out.ToArray()
}

function Save-SemPipeline {
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Id, [Parameter(Mandatory = $true)][byte[]]$Bytes)
    if ($Id -cnotmatch $script:SemPipelineIdRx) { throw 'A pipeline id has lower-case letters, digits, _ and - (1 to 64).' }
    $why = Test-SemPipelineBytes -Bytes $Bytes
    if ($why) { throw $why }
    Save-SemDoc -Dir (Get-SemPipelineDir -HomeDir $HomeDir) -Id $Id -Bytes $Bytes
    # A new or changed schedule counts from now: no run for a time that passed before it was saved.
    $st = Read-SemPipelineState -HomeDir $HomeDir -Id $Id
    if (-not $st.lastScheduled) { $st.lastScheduled = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); Save-SemPipelineState -HomeDir $HomeDir -Id $Id -State $st }
}

function Remove-SemPipeline {
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Id)
    if ($Id -cnotmatch $script:SemPipelineIdRx) { return $false }
    return (Remove-SemDoc -Dir (Get-SemPipelineDir -HomeDir $HomeDir) -Id $Id)
}

# ---------------------------------------------------------------------------
# One run at a time: <home>\pipelines\.running.json
# ---------------------------------------------------------------------------
function Get-SemPipelineLock {
    # The lock's content when a live run holds it, else $null (a lock left by a stopped process is ignored).
    param([Parameter(Mandatory = $true)][string]$HomeDir)
    $f = Join-Path (Get-SemPipelineDir -HomeDir $HomeDir) '.running.json'
    if (-not [IO.File]::Exists($f)) { return $null }
    try { $j = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { return $null }
    $procId = 0; [void][int]::TryParse([string](Get-SemPipeProp $j 'pid'), [ref]$procId)
    $alive = $false
    try { $alive = ($null -ne (Get-Process -Id $procId -ErrorAction Stop)) } catch { $alive = $false }
    $started = [datetime]::MinValue
    [void][datetime]::TryParse([string](Get-SemPipeProp $j 'started'), [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal, [ref]$started)
    if (-not $alive -or ([datetime]::UtcNow - $started).TotalHours -gt 12) { return $null }
    return $j
}

function Enter-SemPipelineLock {
    # Takes the lock for $Run; $false when another run holds it. The same run may take it again (the task after the route).
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Id, [Parameter(Mandatory = $true)][string]$Run)
    $held = Get-SemPipelineLock -HomeDir $HomeDir
    if ($null -ne $held -and [string](Get-SemPipeProp $held 'run') -ne $Run) { return $false }
    $f = Join-Path (Get-SemPipelineDir -HomeDir $HomeDir) '.running.json'
    $doc = [ordered]@{ pid = $PID; pipeline = $Id; run = $Run; started = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ') }
    [IO.File]::WriteAllText($f, (ConvertTo-Json -InputObject $doc -Compress), (New-Object Text.UTF8Encoding $false))
    return $true
}

function Exit-SemPipelineLock {
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Run)
    $f = Join-Path (Get-SemPipelineDir -HomeDir $HomeDir) '.running.json'
    try {
        if ([IO.File]::Exists($f)) {
            $j = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8) | ConvertFrom-Json
            if ([string](Get-SemPipeProp $j 'run') -eq $Run) { [IO.File]::Delete($f) }
        }
    } catch { }
}

function Test-SemPipelineRunning {
    param([Parameter(Mandatory = $true)][string]$HomeDir, [string]$Id = '')
    $l = Get-SemPipelineLock -HomeDir $HomeDir
    if ($null -eq $l) { return $false }
    if ($Id) { return ([string](Get-SemPipeProp $l 'pipeline') -eq $Id) }
    return $true
}

function New-SemPipelineRunId {
    return ([datetime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
}

# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------
function Write-SemPipelineRun {
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)]$Run)
    $dir = Get-SemPipelineDir -HomeDir $HomeDir -Child ('runs\' + $Run.pipeline)
    Save-SemDoc -Dir $dir -Id $Run.run -Bytes ([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Run -Depth 8 -Compress)))
}

function Get-SemPipelineRuns {
    # The newest runs first (summary of each), at most $Last.
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Id, [int]$Last = 30)
    $dir = Get-SemPipelineDir -HomeDir $HomeDir -Child ('runs\' + $Id)
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($f in @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First $Last)) {
        try { $j = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { continue }
        $out.Add($j)
    }
    return $out.ToArray()
}

function Read-SemPipelineRun {
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Id, [Parameter(Mandatory = $true)][string]$Run)
    if ($Run -cnotmatch '\A[0-9]{8}-[0-9]{6}-[a-f0-9]{6}\z') { return $null }
    $f = Join-Path (Get-SemPipelineDir -HomeDir $HomeDir -Child ('runs\' + $Id)) ($Run + '.json')
    if (-not [IO.File]::Exists($f)) { return $null }
    return [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8)
}

function Remove-SemPipelineOldRuns {
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Id)
    $dir = Get-SemPipelineDir -HomeDir $HomeDir -Child ('runs\' + $Id)
    foreach ($f in @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -Skip $script:SemPipelineRunsKept)) { try { $f.Delete() } catch { } }
}

function Get-SemFileFingerprint {
    param([string]$Path)
    $fi = New-Object IO.FileInfo $Path
    return ('file:' + $fi.Length + ':' + $fi.LastWriteTimeUtc.Ticks)
}

function Resolve-SemPipelineImport {
    # The file an import step reads: @{ Path; Label; Fingerprint } (path or upload), or @{ S3 = plan; Label; Fingerprint }.
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)]$Step)
    $path = Get-SemPipeProp $Step 'path'; $upload = Get-SemPipeProp $Step 'upload'; $s3 = Get-SemPipeProp $Step 's3'
    if ($path) {
        $res = Resolve-SemLocalPath -Path ([string]$path) -Shares @($script:Sem.LocalShares) -HomeDir $HomeDir
        if ($res.ContainsKey('Error')) { throw $res.Error }
        if (-not [IO.File]::Exists($res.Path)) { throw ('The file ' + $res.Path + ' is not there.') }
        return @{ Path = $res.Path; Label = $res.Path; Fingerprint = (Get-SemFileFingerprint $res.Path) }
    }
    if ($upload) {
        $f = Join-Path (Get-SemLocalDir -HomeDir $HomeDir -Child 'sources') ([IO.Path]::GetFileName([string]$upload))
        if (-not [IO.File]::Exists($f)) { throw ('The uploaded file ' + $upload + ' is not in the local sources folder any more: upload it again with "Keep for pipelines".') }
        return @{ Path = $f; Label = ([string]$upload + ' (uploaded)'); Fingerprint = (Get-SemFileFingerprint $f) }
    }
    if (-not (Get-Command Get-SemS3ImportPlan -ErrorAction SilentlyContinue)) { throw 'Amazon S3 is not available in this copy (server\S3.ps1).' }
    $body = [pscustomobject]@{ bucket = [string](Get-SemPipeProp $s3 'bucket'); table = [string](Get-SemPipeProp $Step 'table'); replace = $true }
    $k = Get-SemPipeProp $s3 'key'; $px = Get-SemPipeProp $s3 'prefix'
    if ($null -ne $k) { $body | Add-Member -NotePropertyName key -NotePropertyValue ([string]$k) } else { $body | Add-Member -NotePropertyName prefix -NotePropertyValue ([string]$px) }
    $sheet = Get-SemPipeProp $Step 'sheet'; if ($sheet) { $body | Add-Member -NotePropertyName sheet -NotePropertyValue ([string]$sheet) }
    $plan = Get-SemS3ImportPlan -Body $body -Config (Get-SemS3Config $script:Sem.AwsSettings)
    if ($plan.ContainsKey('Error')) { throw $plan.Error.Message }
    $plan.Replace = $true
    $objects = @()
    if ($null -ne $plan.Prefix) { $objects = @(Get-SemS3PrefixObjects -Entry $plan.Entry -Prefix $plan.Prefix) }
    else { $objects = @(foreach ($key in $plan.Keys) { Get-SemS3ObjectHead -Entry $plan.Entry -Key $key }) }
    $fp = 's3:' + (@($objects | ForEach-Object { [string]$_.key + '=' + [string]$_.etag + ':' + [string]$_.size }) -join '|')
    return @{ S3 = $plan; Label = ('s3://' + $plan.Bucket); Fingerprint = $fp }
}

function Invoke-SemPipelinePublish {
    # Marks the playbook snapshots that read any of $Tables from the local database as out of date (invalidatedAt),
    # so they are refreshed next time Semaphore can reach the local database. Returns the snapshot titles marked.
    param([Parameter(Mandatory = $true)][string]$HomeDir, [string[]]$Tables = @())
    $want = @{}; foreach ($t in $Tables) { if ($t) { $want[$t.ToLowerInvariant()] = $true } }
    $marked = New-Object System.Collections.Generic.List[string]
    if ($want.Count -eq 0) { return , $marked.ToArray() }
    $dir = Join-Path $HomeDir 'snapshots'
    if (-not [IO.Directory]::Exists($dir)) { return , $marked.ToArray() }
    $now = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    foreach ($f in @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
        if ($f.Name.StartsWith('.')) { continue }
        $text = $null
        try { $text = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF); $j = $text | ConvertFrom-Json } catch { continue }
        $plan = Get-SemPipeProp $j 'plan'
        if ([string](Get-SemPipeProp $plan 'source') -ne 'local') { continue }
        $reads = @([string](Get-SemPipeProp $plan 'table')) + @(@(Get-SemPipeProp $plan 'joins') | ForEach-Object { [string](Get-SemPipeProp $_ 'table') })
        $hit = $false; foreach ($r in $reads) { if ($r -and $want.ContainsKey($r.ToLowerInvariant())) { $hit = $true } }
        if (-not $hit) { continue }
        # One top-level field, written into the text so the rest of the document is kept byte for byte.
        if ($text -match '"invalidatedAt"\s*:\s*"[^"]*"') { $text = [regex]::Replace($text, '"invalidatedAt"\s*:\s*"[^"]*"', ('"invalidatedAt":"' + $now + '"'), 'None', [TimeSpan]::FromSeconds(5)) }
        else { $text = '{"invalidatedAt":"' + $now + '",' + $text.Substring($text.IndexOf('{') + 1) }
        Save-SemDoc -Dir $dir -Id ([IO.Path]::GetFileNameWithoutExtension($f.Name)) -Bytes ((New-Object Text.UTF8Encoding $false).GetBytes($text))
        $marked.Add([string](Get-SemPipeProp $j 'title'))
    }
    return , $marked.ToArray()
}

function Invoke-SemPipelineRun {
    <#
      Runs a pipeline from the first step (or -From a step id) and returns the run record. Each step's state, rows,
      ms, warnings and error go to runs\<id>\<run>.json as it goes. Stops at the first failed step. -Force reimports
      unchanged sources. Holds the pipeline lock for the run (another run at the same time is refused).
    #>
    param([Parameter(Mandatory = $true)][string]$HomeDir, [Parameter(Mandatory = $true)][string]$Id, [string]$From = '', [bool]$Force = $false, [string]$Trigger = 'manual', [string]$RunId = '')
    if (-not $RunId) { $RunId = New-SemPipelineRunId }
    $doc = Read-SemPipeline -HomeDir $HomeDir -Id $Id
    if ($null -eq $doc) { throw ("There is no pipeline '" + $Id + "'.") }
    $why = Test-SemPipeline $doc
    if ($why) { throw ('The pipeline is not valid: ' + $why) }
    if (-not (Enter-SemPipelineLock -HomeDir $HomeDir -Id $Id -Run $RunId)) { $l = Get-SemPipelineLock -HomeDir $HomeDir; throw ("Another pipeline run is going (" + [string](Get-SemPipeProp $l 'pipeline') + "); one runs at a time.") }
    Initialize-SemLocalTypes
    $steps = @(Get-SemPipeProp $doc 'steps')
    $startAt = 0
    if ($From) {
        $startAt = -1
        for ($i = 0; $i -lt $steps.Count; $i++) { if ([string]$steps[$i].id -eq $From) { $startAt = $i } }
        if ($startAt -lt 0) { Exit-SemPipelineLock -HomeDir $HomeDir -Run $RunId; throw ("The pipeline has no step '" + $From + "'.") }
    }
    $run = [ordered]@{
        version = 1; run = $RunId; pipeline = $Id; name = [string]$doc.name; trigger = $Trigger; from = $From; force = $Force
        started = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'); finished = $null; state = 'running'; error = $null; ms = 0; outputs = @()
        steps = @(for ($i = 0; $i -lt $steps.Count; $i++) { [ordered]@{ id = [string]$steps[$i].id; kind = [string]$steps[$i].kind; name = [string](Get-SemPipeProp $steps[$i] 'name'); state = $(if ($i -lt $startAt) { 'kept' } else { 'pending' }); rows = $null; ms = $null; warnings = @(); error = $null; tables = @() } })
    }
    $state = Read-SemPipelineState -HomeDir $HomeDir -Id $Id
    $outputs = New-Object System.Collections.Generic.List[string]
    foreach ($s in $steps) { $t = [string](Get-SemPipeProp $s 'table'); if ($t -and -not $outputs.Contains($t)) { $outputs.Add($t) } }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    Write-SemLog 'INFO' ("Pipeline {0}: run {1} started ({2})" -f $Id, $RunId, $Trigger)
    try {
        Write-SemPipelineRun -HomeDir $HomeDir -Run $run
        for ($i = $startAt; $i -lt $steps.Count; $i++) {
            $s = $steps[$i]; $log = $run.steps[$i]
            $log.state = 'running'
            Write-SemPipelineRun -HomeDir $HomeDir -Run $run
            $t0 = [Diagnostics.Stopwatch]::StartNew()
            try {
                switch ([string]$s.kind) {
                    'import' {
                        $src = Resolve-SemPipelineImport -HomeDir $HomeDir -Step $s
                        $table = [string]$s.table
                        $force = $Force -or ((Get-SemPipeProp $s 'force') -eq $true)
                        $prev = $state.fingerprints[[string]$s.id]
                        $exists = $false
                        $c = Open-SemLocalConnection -HomeDir $HomeDir; try { $exists = $c.TableExists($table) } finally { $c.Dispose() }
                        if (-not $force -and $exists -and $prev -and $prev -eq $src.Fingerprint) {
                            $log.state = 'skipped'; $log.warnings = @('The source has not changed since the last run (use Force to import it again).'); $log.tables = @($table)
                            break
                        }
                        if ($src.ContainsKey('S3')) {
                            $jobState = New-SemS3JobState -Id ('pipe' + [guid]::NewGuid().ToString('N').Substring(0, 10)) -Plan $src.S3
                            Set-SemVaultRequest (Get-SemAwsVaultContext -Settings $script:Sem.AwsSettings -Purpose '/api/s3/import')
                            try { Invoke-SemS3ImportJob -Plan $src.S3 -HomeDir $HomeDir -State $jobState -MaxBytes ([long](Get-SemS3Config $script:Sem.AwsSettings).MaxObjectBytes) } finally { Clear-SemVaultRequest }
                            if ($jobState.state -ne 'done') { throw [string]$jobState.error }
                            $log.rows = [long]$jobState.rows; $log.tables = @([string]$jobState.table)
                        } else {
                            $a = @{ HomeDir = $HomeDir; Path = $src.Path; Table = $table; Replace = $true; SourceLabel = $src.Label }
                            $sheet = Get-SemPipeProp $s 'sheet'; if ($sheet) { $a.Sheet = [string]$sheet }
                            $imp = Import-SemLocalFile @a
                            $log.rows = [long]$imp.Rows; $log.warnings = @($imp.Warnings); $log.tables = @([string]$imp.Table)
                        }
                        $state.fingerprints[[string]$s.id] = $src.Fingerprint
                        $log.state = 'done'
                    }
                    'script' {
                        $r = Invoke-SemSavedScript -HomeDir $HomeDir -Id ([string]$s.script) -Params (Get-SemPipeProp $s 'params') -Label ('pipeline ' + $Id)
                        if (-not $r.ok) { throw ([string]$r.error.message) }
                        $n = [long]0; foreach ($x in @($r.results)) { if ($x.kind -eq 'changes') { $n += [long]$x.changes } }
                        $log.rows = $n; $log.tables = @($r.tables)
                        foreach ($t in @($r.tables)) { if (-not $outputs.Contains($t)) { $outputs.Add($t) } }
                        if ([int]$r.resultsDropped -gt 0) { $log.warnings = @(('{0} result(s) were not kept.' -f $r.resultsDropped)) }
                        $log.state = 'done'
                    }
                    'pull' {
                        $mode = [string](Get-SemPipeProp $s 'mode'); if ($mode -ne 'append') { $mode = 'replace' }
                        $p = Invoke-SemLocalPull -HomeDir $HomeDir -Source ([string]$s.source) -Sql ([string]$s.sql) -Table ([string]$s.table) -Mode $mode
                        $log.rows = [long]$p.Rows; $log.warnings = @($p.Warnings); $log.tables = @([string]$p.Table)
                        $log.state = 'done'
                    }
                    'publish' {
                        $tables = @(Get-SemPipeProp $s 'tables')
                        if ($null -eq (Get-SemPipeProp $s 'tables') -or $tables.Count -eq 0) { $tables = $outputs.ToArray() }
                        $marked = @(Invoke-SemPipelinePublish -HomeDir $HomeDir -Tables ([string[]]$tables))
                        $log.rows = $marked.Count
                        $log.warnings = @($(if ($marked.Count -gt 0) { ('Marked for refresh: ' + (($marked | Select-Object -First 10) -join ', ') + $(if ($marked.Count -gt 10) { ' and ' + ($marked.Count - 10) + ' more' } else { '' })) } else { 'No saved snapshot reads these tables.' }))
                        $log.tables = @($tables)
                        $log.state = 'done'
                    }
                }
            } catch {
                $log.state = 'failed'
                $log.error = ConvertTo-SemLocalMessage $_.Exception
            }
            $log.ms = [long]$t0.ElapsedMilliseconds
            $state.steps[[string]$s.id] = [ordered]@{ state = $log.state; rows = $log.rows; ms = $log.ms; at = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'); error = $log.error }
            Write-SemPipelineRun -HomeDir $HomeDir -Run $run
            if ($log.state -eq 'failed') {
                $run.state = 'failed'
                $run.error = ('Step {0} ({1}) failed: {2}' -f ($i + 1), $(if ($log.name) { $log.name } else { $log.id }), $log.error)
                for ($k = $i + 1; $k -lt $steps.Count; $k++) { $run.steps[$k].state = 'not run' }
                break
            }
        }
        if ($run.state -eq 'running') { $run.state = 'done' }
    } catch {
        $run.state = 'failed'
        $run.error = ConvertTo-SemLocalMessage $_.Exception
    } finally {
        $run.finished = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
        $run.ms = [long]$clock.ElapsedMilliseconds
        $run.outputs = @($outputs)
        try { Write-SemPipelineRun -HomeDir $HomeDir -Run $run } catch { }
        $state.lastRun = [ordered]@{ run = $RunId; state = $run.state; started = $run.started; finished = $run.finished; ms = $run.ms; error = $run.error; trigger = $Trigger }
        try { Save-SemPipelineState -HomeDir $HomeDir -Id $Id -State $state } catch { }
        try { Remove-SemPipelineOldRuns -HomeDir $HomeDir -Id $Id } catch { }
        Exit-SemPipelineLock -HomeDir $HomeDir -Run $RunId
        Write-SemLog 'INFO' ("Pipeline {0}: run {1} {2} in {3} ms{4}" -f $Id, $RunId, $run.state, $run.ms, $(if ($run.error) { ': ' + (ConvertTo-SemLogText $run.error 300) } else { '' }))
    }
    return $run
}

# ---------------------------------------------------------------------------
# Schedule
# ---------------------------------------------------------------------------
function Get-SemPipelineLastDue {
    # The latest scheduled time at or before $Now (local time), or $null for no schedule.
    param($Schedule, [datetime]$Now = (Get-Date))
    if ($null -eq $Schedule) { return $null }
    $every = [string](Get-SemPipeProp $Schedule 'every')
    switch ($every) {
        'hourly' {
            $m = 0; [void][int]::TryParse([string](Get-SemPipeProp $Schedule 'minute'), [ref]$m)
            $t = (New-Object DateTime $Now.Year, $Now.Month, $Now.Day, $Now.Hour, 0, 0).AddMinutes($m)
            if ($t -gt $Now) { $t = $t.AddHours(-1) }
            return $t
        }
        { $_ -eq 'daily' -or $_ -eq 'weekly' } {
            $hm = ([string](Get-SemPipeProp $Schedule 'time')).Split(':')
            if ($hm.Count -ne 2) { return $null }
            $days = @()
            if ($every -eq 'weekly') { $days = @(Get-SemPipeProp $Schedule 'days' | ForEach-Object { [string]$_ }) }
            for ($d = 0; $d -le 7; $d++) {
                $day = $Now.Date.AddDays(-$d)
                $t = $day.AddHours([int]$hm[0]).AddMinutes([int]$hm[1])
                if ($t -gt $Now) { continue }
                if ($every -eq 'weekly' -and $days -notcontains $script:SemPipelineDays[[int]$day.DayOfWeek]) { continue }
                return $t
            }
            return $null
        }
    }
    return $null
}

function Invoke-SemPipelineTick {
    <#
      The scheduler (the server's loop calls this through Update-SemWorkers; at most every 20 s unless -Now is given).
      Starts at most one due run per tick, and none while a run is going. A time that passed while the server was
      down (before -ServerStarted) runs once when the schedule has catchUp, and is skipped otherwise. -Start is how a
      run is started (default: Start-SemLocalTask on the local job pool); tests pass their own.
    #>
    param([string]$HomeDir = $script:Sem.Home, $Now = $null, $ServerStarted = $null, [scriptblock]$Start = $null)
    if (-not $HomeDir) { return $null }
    if ($null -eq $Now) {
        if (-not $script:Sem.PipelineScheduler) { return $null }
        $clock = $script:Sem.PipelineTickClock
        if ($null -ne $clock -and $clock.ElapsedMilliseconds -lt 20000) { return $null }
        $script:Sem.PipelineTickClock = [Diagnostics.Stopwatch]::StartNew()
        $Now = Get-Date
    }
    if ($null -eq $ServerStarted) { $ServerStarted = $script:Sem.StartedAt; if ($null -eq $ServerStarted) { $ServerStarted = $Now } }
    if ($null -eq $Start) { $Start = { param($id, $trigger, $run) Start-SemLocalTask -Kind 'pipeline' -Spec @{ HomeDir = $script:Sem.Home; Id = $id; Trigger = $trigger; RunId = $run } } }
    try {
        if (Test-SemPipelineRunning -HomeDir $HomeDir) { return $null }
        foreach ($p in @(Get-ChildItem -LiteralPath (Get-SemPipelineDir -HomeDir $HomeDir) -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name)) {
            $id = [IO.Path]::GetFileNameWithoutExtension($p.Name)
            if ($id -cnotmatch $script:SemPipelineIdRx) { continue }
            $doc = $null
            try { $doc = [IO.File]::ReadAllText($p.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { continue }
            $sch = Get-SemPipeProp $doc 'schedule'
            if ($null -eq $sch -or [string](Get-SemPipeProp $sch 'every') -eq 'off') { continue }
            $due = Get-SemPipelineLastDue -Schedule $sch -Now $Now
            if ($null -eq $due) { continue }
            $st = Read-SemPipelineState -HomeDir $HomeDir -Id $id
            $last = [datetime]::MinValue
            if (-not $st.lastScheduled -or -not [datetime]::TryParse([string]$st.lastScheduled, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$last)) {
                $st.lastScheduled = $Now.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); Save-SemPipelineState -HomeDir $HomeDir -Id $id -State $st; continue
            }
            if ($last -ge $due) { continue }
            $st.lastScheduled = $due.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            $missed = ($due -lt $ServerStarted)
            if ($missed -and (Get-SemPipeProp $sch 'catchUp') -ne $true) {
                Save-SemPipelineState -HomeDir $HomeDir -Id $id -State $st
                Write-SemLog 'INFO' ("Pipeline {0}: the run due at {1:yyyy-MM-dd HH:mm} was missed while Semaphore was not running (catch up is off)" -f $id, $due)
                continue
            }
            $trigger = 'schedule'; if ($missed) { $trigger = 'catch-up' }
            $run = New-SemPipelineRunId
            if (-not (Enter-SemPipelineLock -HomeDir $HomeDir -Id $id -Run $run)) { return $null }
            Save-SemPipelineState -HomeDir $HomeDir -Id $id -State $st
            $null = & $Start $id $trigger $run
            return @{ Id = $id; Trigger = $trigger; Run = $run; Due = $due }
        }
    } catch { Write-SemLog 'WARN' ('Pipeline scheduler: ' + $_.Exception.Message) }
    return $null
}

# ---------------------------------------------------------------------------
# Routes (Routes.ps1 hands /api/pipelines* here after the session gate)
# ---------------------------------------------------------------------------
function Invoke-SemPipelineRoute {
    param($Req)
    $p = $Req.Path; $m = $Req.Method; $homeDir = $script:Sem.Home
    if ($p -eq '/api/pipelines') {
        if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Send-SemJson 200 @(Get-SemPipelineList -HomeDir $homeDir); return
    }
    if ($p -notmatch '^/api/pipelines/([^/]+)(?:/(run|runs)(?:/([^/]+))?)?$') { Send-SemError 404 'not-found' 'Unknown API route.'; return }
    $id = $Matches[1]; $what = $Matches[2]; $runId = $Matches[3]
    if ($id -cnotmatch $script:SemPipelineIdRx) { Send-SemError 400 'bad-id' 'A pipeline id has lower-case letters, digits, _ and - (1 to 64).'; return }
    if (-not $what) {
        if ($m -eq 'GET') {
            $f = Join-Path (Get-SemPipelineDir -HomeDir $homeDir) ($id + '.json')
            if (-not [IO.File]::Exists($f)) { Send-SemError 404 'not-found' ("No pipeline '" + $id + "'."); return }
            $st = Read-SemPipelineState -HomeDir $homeDir -Id $id
            $text = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
            $extra = ConvertTo-Json -InputObject ([ordered]@{ lastRun = $st.lastRun; steps = $st.steps; running = (Test-SemPipelineRunning -HomeDir $homeDir -Id $id) }) -Depth 6 -Compress
            Send-SemJsonText 200 ('{"pipeline":' + $text + ',"state":' + $extra + '}'); return
        }
        if ($m -eq 'PUT') {
            $script:Sem.SyncBusy = $true
            try { Save-SemPipeline -HomeDir $homeDir -Id $id -Bytes $Req.Body } catch { Send-SemError 400 'bad-pipeline' $_.Exception.Message; return } finally { $script:Sem.SyncBusy = $false }
            Send-SemJson 200 ([ordered]@{ ok = $true; id = $id }); return
        }
        if ($m -eq 'DELETE') {
            if (Test-SemPipelineRunning -HomeDir $homeDir -Id $id) { Send-SemError 409 'pipeline-running' 'The pipeline is running; delete it when the run has finished.'; return }
            if (-not (Remove-SemPipeline -HomeDir $homeDir -Id $id)) { Send-SemError 404 'not-found' ("No pipeline '" + $id + "'."); return }
            Send-SemJson 200 ([ordered]@{ ok = $true }); return
        }
        Send-SemError 405 'method' 'Method not allowed.'; return
    }
    if ($what -eq 'run') {
        if ($m -ne 'POST' -or $runId) { Send-SemError 405 'method' 'Method not allowed.'; return }
        if ($null -eq (Read-SemPipeline -HomeDir $homeDir -Id $id)) { Send-SemError 404 'not-found' ("No pipeline '" + $id + "'."); return }
        $from = [string](Get-SemPipeProp $Req.Json 'from')
        if ($from -and $from -cnotmatch $script:SemPipelineIdRx) { Send-SemError 400 'bad-step' 'Not a step id.'; return }
        $force = ((Get-SemPipeProp $Req.Json 'force') -eq $true)
        $run = New-SemPipelineRunId
        if (-not (Enter-SemPipelineLock -HomeDir $homeDir -Id $id -Run $run)) { Send-SemError 409 'pipeline-busy' 'Another pipeline run is going; one runs at a time.'; return }
        Start-SemLocalTask -Kind 'pipeline' -Spec @{ HomeDir = $homeDir; Id = $id; From = $from; Force = $force; Trigger = 'manual'; RunId = $run }
        Send-SemJson 202 ([ordered]@{ run = $run; pipeline = $id }); return
    }
    if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
    if ($runId) {
        $text = Read-SemPipelineRun -HomeDir $homeDir -Id $id -Run $runId
        if ($null -eq $text) { Send-SemError 404 'not-found' 'No such run.'; return }
        Send-SemJsonText 200 $text; return
    }
    Send-SemJson 200 @(Get-SemPipelineRuns -HomeDir $homeDir -Id $id)
}
