#requires -Version 5.1
# =============================================================================
# Semaphore API routes. They run after the gate in Http.ps1 has checked the caller, Host, Origin
# and the session token. JSON in and out, UTF-8. Errors: { error: "message", code: "..." }.
#
#   GET    /api/commands                  the command registry the CLI uses (Commands.ps1)
#   GET    /api/info                      tool, version, pid, port, home, autoStop, stay, sources
#   POST   /api/heartbeat   { tab }       presence
#   POST   /api/leaving     { token, tab} (Http.ps1: token in the body, sendBeacon)
#   POST   /api/end                       responds, then stops cleanly
#   GET    /api/hoists | /api/catalogs              [{ id, title, updated }]
#   GET    /api/hoists/<id>                         the file's JSON verbatim, header ETag: "<sha256 hex of the file>"
#   PUT    /api/hoists/<id>   hoist JSON            atomic write -> { ok: true, etag }
#          With If-Match: "<hex>" and a stored file of another hash: 409 { code: "version", etag } and
#          nothing is written (someone else saved since). No If-Match: written (CLI, first save).
#   DELETE /api/hoists/<id>                         moved to .trash with a timestamp suffix
#   The same four routes serve /api/team (style overrides, away notices), /api/playbook (accepted answers), /api/snapshots (their saved
#   results) and /api/questions (leadership's question queue). GET /api/<kind>?full=1 returns
#   the documents themselves instead of { id, title, updated } (playbook and questions only).
#   POST   /api/client-log { level, message, stack?, view? }   a browser error, one log line -> 204
#          (4 KB at most, 20 a minute, then 429; only message, stack and view are written)
#   POST   /api/refresh-report { refreshed, skipped, failed: [{ id, title, error }] }
#          logged and kept as <home>\snapshots\.last-refresh.json; GET returns it (404 before the first)
#   POST   /api/query    { source, sql, params, rowCap, timeoutSec }   (Query.ps1, worker pool)
#   POST   /api/profile  { source, table? }                           (Query.ps1, worker pool)
#   GET    /api/vault                     Lazarette bridge status, never a secret (Vault.ps1)
#   GET    /api/ai                        AI status, never the key            (Intelligence.ps1)
#   POST   /api/ai/check                  is Fairlead reachable with the key  (Intelligence.ps1, worker pool)
#   POST   /api/ai/v1/chat/completions    drafting request passed to Fairlead (Intelligence.ps1, worker pool)
# =============================================================================

$script:SemDocMaxBytes = 2097152      # 2 MB per hoist or catalog
$script:SemClientLogMaxBytes = 4096   # one browser error report
$script:SemClientLogPerMinute = 20
$script:SemClientLogTimes = New-Object System.Collections.Generic.List[datetime]

function Get-SemJsonProp {
    param($Json, [string]$Name)
    if ($Json -isnot [Management.Automation.PSCustomObject]) { return $null }
    $p = $Json.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

function Test-SemDocId {
    param([string]$Id)
    return ($Id -cmatch '\A[A-Za-z0-9_-]{1,64}\z')
}

# ---------------------------------------------------------------------------
# Document store: <home>\hoists and <home>\catalogs, one <id>.json per document
# ---------------------------------------------------------------------------
function Get-SemDocDir {
    param([ValidateSet('hoists', 'catalogs', 'playbook', 'snapshots', 'questions', 'team')][string]$Kind, [string]$HomeDir = $script:Sem.Home)
    $d = Join-Path $HomeDir $Kind
    if (-not (Test-Path -LiteralPath $d)) { [void][IO.Directory]::CreateDirectory($d) }
    return $d
}

function Get-SemDocList {
    # [{ id, title, updated }] from <dir>\*.json; unreadable or invalid files are skipped.
    param([Parameter(Mandatory = $true)][string]$Dir)
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($f in @(Get-ChildItem -LiteralPath $Dir -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name)) {
        $id = [IO.Path]::GetFileNameWithoutExtension($f.Name)
        if (-not (Test-SemDocId $id)) { continue }
        if ($f.Length -gt $script:SemDocMaxBytes) { continue }
        try {
            $text = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8)
            if (-not $text.TrimStart().StartsWith('{')) { continue }
            $j = $text | ConvertFrom-Json -ErrorAction Stop
        } catch { continue }
        if ($j -isnot [Management.Automation.PSCustomObject]) { continue }
        $title = $id
        foreach ($k in @('title', 'label', 'name')) {
            $v = Get-SemJsonProp $j $k
            if ($v -is [string] -and $v.Trim() -ne '') { $title = $v.Trim(); break }
        }
        $updated = Get-SemJsonProp $j 'updated'
        if ($updated -is [datetime]) { $updated = $updated.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
        if ($updated -isnot [string] -or $updated -eq '') { $updated = $f.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
        $out.Add([ordered]@{ id = $id; title = $title; updated = $updated })
    }
    return , $out.ToArray()
}

function Get-SemDocFullList {
    # Every valid document in <dir>, as one JSON array text (documents verbatim), for small kinds.
    param([Parameter(Mandatory = $true)][string]$Dir, [int]$MaxCount = 2000)
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($f in @(Get-ChildItem -LiteralPath $Dir -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name)) {
        if ($parts.Count -ge $MaxCount) { break }
        $id = [IO.Path]::GetFileNameWithoutExtension($f.Name)
        if (-not (Test-SemDocId $id)) { continue }
        if ($f.Length -gt $script:SemDocMaxBytes) { continue }
        try {
            $text = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8)
            if (-not $text.TrimStart([char]0xFEFF, ' ', "`t", "`r", "`n").StartsWith('{')) { continue }
            $null = $text | ConvertFrom-Json -ErrorAction Stop
        } catch { continue }
        $parts.Add($text.TrimStart([char]0xFEFF))
    }
    return '[' + ($parts -join ',') + ']'
}

function Read-SemDoc {
    # The file's text, or $null when it does not exist.
    param([string]$Dir, [string]$Id)
    $f = Join-Path $Dir ($Id + '.json')
    if (-not [IO.File]::Exists($f)) { return $null }
    return [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8)
}

function Test-SemDocBody {
    # Returns $null when the bytes are a JSON object with version 1 and at most 2 MB, else an error message.
    param([byte[]]$Bytes)
    if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return 'The body is empty.' }
    if ($Bytes.Length -gt $script:SemDocMaxBytes) { return 'too-large' }
    $text = (New-Object Text.UTF8Encoding $false).GetString($Bytes)
    if (-not $text.TrimStart([char]0xFEFF, ' ', "`t", "`r", "`n").StartsWith('{')) { return 'The body must be a JSON object.' }
    try { $j = $text | ConvertFrom-Json -ErrorAction Stop } catch { return 'The body is not valid JSON.' }
    if ($j -isnot [Management.Automation.PSCustomObject]) { return 'The body must be a JSON object.' }
    $v = Get-SemJsonProp $j 'version'
    if (-not ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal]) -or $v -ne 1) { return 'The document must have "version": 1.' }
    return $null
}

function Get-SemSha256Hex {
    param([byte[]]$Bytes)
    if ($null -eq $Bytes) { $Bytes = New-Object byte[] 0 }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $h = $sha.ComputeHash($Bytes) } finally { $sha.Dispose() }
    return ([BitConverter]::ToString($h).Replace('-', '').ToLowerInvariant())
}

function Get-SemDocEtag {
    # The sha256 hex of the stored file's bytes, or $null when there is no file.
    param([string]$Dir, [string]$Id)
    $f = Join-Path $Dir ($Id + '.json')
    if (-not [IO.File]::Exists($f)) { return $null }
    return (Get-SemSha256Hex ([IO.File]::ReadAllBytes($f)))
}

function Get-SemIfMatch {
    # The entity tag of an If-Match header without quotes or W/, '*' for any, or $null without one.
    param($Headers)
    if ($null -eq $Headers -or -not $Headers.ContainsKey('If-Match')) { return $null }
    $v = ([string]$Headers['If-Match']).Trim()
    if ($v.StartsWith('W/')) { $v = $v.Substring(2) }
    return $v.Trim('"')
}

function Save-SemDoc {
    <#
      Atomic write: the bytes go to a temp file in the same folder, which then replaces the document
      ([IO.File]::Replace), so a reader or a crash never sees half a file. Where Replace is refused
      (some network shares), the old file is moved aside, the temp file moved in, and the old one
      deleted; when the move in fails the old file is put back.
    #>
    param([string]$Dir, [string]$Id, [byte[]]$Bytes)
    $f = Join-Path $Dir ($Id + '.json')
    $tmp = Join-Path $Dir ('.' + $Id + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllBytes($tmp, $Bytes)
    try {
        if (-not [IO.File]::Exists($f)) { [IO.File]::Move($tmp, $f); return }
        $replaced = $false
        try { [IO.File]::Replace($tmp, $f, [NullString]::Value); $replaced = $true } catch { $replaced = $false }
        if ($replaced) { return }
        if (-not [IO.File]::Exists($f)) { [IO.File]::Move($tmp, $f); return }   # Replace failed after moving the old file away
        $old = Join-Path $Dir ('.' + $Id + '.' + [guid]::NewGuid().ToString('N') + '.old')
        [IO.File]::Move($f, $old)
        try { [IO.File]::Move($tmp, $f) }
        catch { [IO.File]::Move($old, $f); throw }
        try { [IO.File]::Delete($old) } catch { }
    } finally {
        if ([IO.File]::Exists($tmp)) { try { [IO.File]::Delete($tmp) } catch { } }
    }
}

function Remove-SemDoc {
    # Moves <id>.json into <dir>\.trash\<id>-yyyyMMdd-HHmmss[-n].json. $false when it does not exist.
    param([string]$Dir, [string]$Id, [datetime]$Now = (Get-Date))
    $f = Join-Path $Dir ($Id + '.json')
    if (-not [IO.File]::Exists($f)) { return $false }
    $trash = Join-Path $Dir '.trash'
    if (-not (Test-Path -LiteralPath $trash)) { [void][IO.Directory]::CreateDirectory($trash) }
    $stamp = $Now.ToString('yyyyMMdd-HHmmss')
    $dest = Join-Path $trash ('{0}-{1}.json' -f $Id, $stamp)
    $n = 1
    while ([IO.File]::Exists($dest)) { $n++; $dest = Join-Path $trash ('{0}-{1}-{2}.json' -f $Id, $stamp, $n) }
    [IO.File]::Move($f, $dest)
    return $true
}

function Invoke-SemDocRoute {
    param($Req, [string]$Kind, $Id)
    $dir = Get-SemDocDir -Kind $Kind
    $noun = @{ hoists = 'hoist'; catalogs = 'catalog'; playbook = 'playbook entry'; snapshots = 'snapshot'; questions = 'question'; team = 'team note' }[$Kind]
    if ($null -eq $Id) {
        if ($Req.Method -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        if (($Kind -eq 'playbook' -or $Kind -eq 'questions' -or $Kind -eq 'team') -and [string]$Req.Query -match '(^|&)full=1(&|$)') {
            Send-SemJsonText 200 (Get-SemDocFullList -Dir $dir)
            return
        }
        Send-SemJson 200 (Get-SemDocList -Dir $dir)
        return
    }
    if (-not (Test-SemDocId $Id)) { Send-SemError 400 'bad-id' ('Invalid ' + $noun + ' id: use 1 to 64 letters, digits, _ or -.'); return }
    switch ($Req.Method) {
        'GET' {
            $f = Join-Path $dir ($Id + '.json')
            if (-not [IO.File]::Exists($f)) { Send-SemError 404 'not-found' ("No $noun '$Id'."); return }
            $bytes = [IO.File]::ReadAllBytes($f)
            $text = (New-Object Text.UTF8Encoding $false).GetString($bytes).TrimStart([char]0xFEFF)
            Send-SemBytes -Status 200 -ContentType 'application/json; charset=utf-8' -Bytes ((New-Object Text.UTF8Encoding $false).GetBytes($text)) -ExtraHeaders @('ETag: "' + (Get-SemSha256Hex $bytes) + '"')
        }
        'PUT' {
            $problem = Test-SemDocBody -Bytes $Req.Body
            if ($problem -eq 'too-large') { Send-SemError 413 'too-large' ("A $noun may be at most 2 MB."); return }
            if ($problem) { Send-SemError 400 'invalid' $problem; return }
            # Optimistic concurrency (#88): the main loop serves one request at a time, so nothing in
            # this process can save between the check and the write.
            $want = Get-SemIfMatch $Req.Headers
            if ($null -ne $want -and $want -ne '*') {
                $current = Get-SemDocEtag -Dir $dir -Id $Id
                if ($null -ne $current -and -not $current.Equals($want, [StringComparison]::OrdinalIgnoreCase)) {
                    Write-SemLog 'INFO' "Did not save $noun ${Id}: it changed since this copy was opened"
                    Send-SemJson 409 ([ordered]@{ error = ("Someone else saved this $noun after you opened it. Load their version, or save yours as a copy."); code = 'version'; etag = $current })
                    return
                }
            }
            $script:Sem.SyncBusy = $true
            try { Save-SemDoc -Dir $dir -Id $Id -Bytes $Req.Body } finally { $script:Sem.SyncBusy = $false }
            Write-SemLog 'INFO' "Saved $noun $Id ($($Req.Body.Length) bytes)"
            Send-SemJson 200 ([ordered]@{ ok = $true; etag = (Get-SemSha256Hex $Req.Body) })
        }
        'DELETE' {
            $script:Sem.SyncBusy = $true
            try { $done = Remove-SemDoc -Dir $dir -Id $Id } finally { $script:Sem.SyncBusy = $false }
            if (-not $done) { Send-SemError 404 'not-found' ("No $noun '$Id'."); return }
            Write-SemLog 'INFO' "Moved $noun $Id to .trash"
            Send-SemJson 200 ([ordered]@{ ok = $true })
        }
        default { Send-SemError 405 'method' 'Method not allowed.' }
    }
}

# ---------------------------------------------------------------------------
# Client error log (#89): the page reports its own errors; one line each in the server log.
# ---------------------------------------------------------------------------
function ConvertTo-SemLogText {
    # One log-safe line: CR, LF and every other control or line-separator character become a space
    # (a stack's line breaks become " | "), so a message can never start a forged log line.
    param($Value, [int]$Max)
    if ($Value -isnot [string]) { return '' }
    $t = [regex]::Replace($Value, '\s*(\r\n|\r|\n|\u2028|\u2029|\u0085)\s*', ' | ')
    $t = [regex]::Replace($t, '[\x00-\x1F\x7F-\x9F\u2028\u2029]', ' ').Trim()
    if ($t.Length -gt $Max) { $t = $t.Substring(0, $Max) + '...' }
    return $t
}

function Test-SemClientLogRate {
    # $true while fewer than 20 reports arrived in the last minute (the report is then counted).
    param([datetime]$Now = (Get-Date))
    $times = $script:SemClientLogTimes
    while ($times.Count -gt 0 -and ($Now - $times[0]).TotalSeconds -ge 60) { $times.RemoveAt(0) }
    if ($times.Count -ge $script:SemClientLogPerMinute) { return $false }
    $times.Add($Now)
    return $true
}

function Invoke-SemClientLog {
    # POST /api/client-log { level: "error"|"warn", message, stack?, view? } -> 204. Only those three
    # texts reach the log, never the rest of the body.
    param($Req)
    if ($Req.Body.Length -gt $script:SemClientLogMaxBytes) { Send-SemError 413 'too-large' 'An error report may be at most 4 KB.'; return }
    if ($Req.Json -isnot [Management.Automation.PSCustomObject]) { Send-SemError 400 'bad-json' 'The body must be a JSON object.'; return }
    $level = Get-SemJsonProp $Req.Json 'level'
    if ($level -cne 'error' -and $level -cne 'warn') { Send-SemError 400 'invalid' 'level must be "error" or "warn".'; return }
    $message = ConvertTo-SemLogText (Get-SemJsonProp $Req.Json 'message') 500
    if (-not $message) { Send-SemError 400 'invalid' 'message must be a non-empty string.'; return }
    if (-not (Test-SemClientLogRate)) { Send-SemError 429 'rate' 'Too many error reports from the page; the next ones are kept after a minute.'; return }
    $line = 'Page ' + $level + ': ' + $message
    $view = ConvertTo-SemLogText (Get-SemJsonProp $Req.Json 'view') 64
    if ($view) { $line += ' (view: ' + $view + ')' }
    $stack = ConvertTo-SemLogText (Get-SemJsonProp $Req.Json 'stack') 2000
    if ($stack) { $line += ' stack: ' + $stack }
    $logLevel = 'WARN'; if ($level -ceq 'error') { $logLevel = 'ERROR' }
    Write-SemLog $logLevel $line
    Send-SemNoContent
}

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------
function Get-SemInfo {
    $sources = @()
    foreach ($s in @(Get-SemSources -HomeDir $script:Sem.Home)) {
        $sources += [ordered]@{ id = $s.id; label = $s.label; kind = $s.kind; provider = $s.provider; placeholders = 'question'; vault = [bool](Get-SemSourceVault $s) }
    }
    return [ordered]@{
        tool = 'semaphore'; version = $script:Sem.Version; pid = $PID; port = $script:Sem.Port; home = $script:Sem.Home
        autoStop = [bool]$script:Sem.Presence.AutoStop; stay = [bool]$script:Sem.Stay; sources = $sources
        user = [string]$env:USERNAME; reviewer = [string]$script:Sem.Reviewer; view = [string]$script:Sem.View
        skin = [string]$script:Sem.Skin
    }
}

function Invoke-SemRoute {
    param($Req)
    $p = $Req.Path; $m = $Req.Method
    if ($p -eq '/api/commands') {
        if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Send-SemJson 200 (Get-SemCommandList); return
    }
    if ($p -eq '/api/info') {
        if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Send-SemJson 200 (Get-SemInfo); return
    }
    if ($p -eq '/api/heartbeat') {
        if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        $tab = Get-SemJsonProp $Req.Json 'tab'
        if ($null -eq $tab) { $tab = 'default' }
        $tab = [string]$tab
        if ($tab -cnotmatch '\A[A-Za-z0-9_-]{1,64}\z') { Send-SemError 400 'bad-tab' 'Invalid tab id.'; return }
        Register-SemPresence -Tab $tab
        Send-SemJson 200 ([ordered]@{ ok = $true }); return
    }
    if ($p -eq '/api/end') {
        if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Send-SemJson 200 ([ordered]@{ ok = $true })
        Write-SemLog 'INFO' 'End session requested from the browser'
        Request-SemStop 'end'
        return
    }
    if ($p -match '^/api/(hoists|catalogs|playbook|snapshots|questions|team)(?:/([^/]*))?$') {
        $kind = $Matches[1]; $id = $null
        if ($p -ne "/api/$kind") { $id = $Matches[2]; if ($null -eq $id) { $id = '' } }
        Invoke-SemDocRoute -Req $Req -Kind $kind -Id $id
        return
    }
    if ($p -eq '/api/client-log') {
        if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Invoke-SemClientLog -Req $Req
        return
    }
    if ($p -eq '/api/refresh-report') {
        $file = Join-Path (Get-SemDocDir -Kind 'snapshots') '.last-refresh.json'
        if ($m -eq 'GET') {
            if (-not [IO.File]::Exists($file)) { Send-SemError 404 'not-found' 'No refresh has run yet.'; return }
            Send-SemJsonText 200 ([IO.File]::ReadAllText($file, [Text.Encoding]::UTF8)); return
        }
        if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        if ($Req.Json -isnot [Management.Automation.PSCustomObject]) { Send-SemError 400 'bad-json' 'The body must be a JSON object.'; return }
        $n = 0; $refreshed = 0; $skipped = 0
        if ([int]::TryParse([string](Get-SemJsonProp $Req.Json 'refreshed'), [ref]$n)) { $refreshed = $n }
        if ([int]::TryParse([string](Get-SemJsonProp $Req.Json 'skipped'), [ref]$n)) { $skipped = $n }
        $failed = @()
        foreach ($f in @(Get-SemJsonProp $Req.Json 'failed') | Select-Object -First 200) {
            if ($f -isnot [Management.Automation.PSCustomObject]) { continue }
            $failed += [ordered]@{ id = ([string](Get-SemJsonProp $f 'id')).Substring(0, [Math]::Min(64, ([string](Get-SemJsonProp $f 'id')).Length)); title = [string](Get-SemJsonProp $f 'title'); error = [string](Get-SemJsonProp $f 'error') }
        }
        $report = [ordered]@{ version = 1; at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); by = [string]$env:USERNAME; computer = [string]$env:COMPUTERNAME; view = [string]$script:Sem.View; refreshed = $refreshed; skipped = $skipped; failed = $failed }
        $script:Sem.SyncBusy = $true
        try { Save-SemDoc -Dir (Get-SemDocDir -Kind 'snapshots') -Id '.last-refresh' -Bytes ([Text.Encoding]::UTF8.GetBytes((ConvertTo-SemJson $report))) } finally { $script:Sem.SyncBusy = $false }
        Write-SemLog 'INFO' ("Snapshots refreshed: {0} done, {1} skipped (source not reachable here), {2} failed" -f $refreshed, $skipped, $failed.Count)
        foreach ($f in $failed) { Write-SemLog 'WARN' ("Snapshot failed: {0}: {1}" -f $f.id, $f.error) }
        Send-SemJson 200 ([ordered]@{ ok = $true }); return
    }
    if ($p -eq '/api/query' -or $p -eq '/api/profile') {
        if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        if ($Req.Json -isnot [Management.Automation.PSCustomObject]) { Send-SemError 400 'bad-json' 'The body must be a JSON object.'; return }
        Start-SemWorkerRequest -Req $Req
        return
    }
    if ($p -eq '/api/vault') {
        if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        [void](Initialize-SemVault -Root $script:Sem.Root)
        Send-SemJson 200 (Get-SemVaultStatus -HomeDir $script:Sem.Home); return
    }
    if ($p -eq '/api/ai') {
        if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Send-SemJson 200 (Get-SemAiStatus); return
    }
    if ($p -eq '/api/ai/check' -or $p -eq '/api/ai/v1/chat/completions') {
        # Intelligence.ps1, on the worker pool: a model can take a minute and must not block heartbeats.
        if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Start-SemWorkerRequest -Req $Req
        return
    }
    Send-SemError 404 'not-found' 'Unknown API route.'
}
