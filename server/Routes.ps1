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
#   GET    /api/page-snapshots/<hoistId>            saved states of one page, newest first: [{ id, kind, name, note, author, created, ... }]
#   POST   /api/page-snapshots/<hoistId>  { kind: named|auto|restore, name?, note?, reason?, catalogVersion?, hoist: "<hoist JSON>" }
#          -> { ok, snapshot }; an automatic one within 10 minutes of the last automatic one -> { ok, skipped: "recent" }
#   GET    /api/page-snapshots/<hoistId>/<snapId>   { snapshot: {...}, hoist: {...} }
#   DELETE /api/page-snapshots/<hoistId>/<snapId>   both files moved to that page's .trash
#          Stored as <home>\snapshots\<hoistId>\<snapId>.json (what it is) and <snapId>.hoist.json (the page,
#          verbatim). The last 30 automatic ones (auto and restore) are kept, and every named one (200 at most).
#   GET/POST /api/widgets, GET/DELETE /api/widgets/<id>   the team widget library (below)
#   POST   /api/client-log { level, message, stack?, view? }   a browser error, one log line -> 204
#          (4 KB at most, 20 a minute, then 429; only message, stack and view are written)
#   POST   /api/refresh-report { refreshed, skipped, failed: [{ id, title, error }] }
#          logged and kept as <home>\snapshots\.last-refresh.json; GET returns it (404 before the first)
#   POST   /api/query    { source, sql, params, rowCap, timeoutSec }   (Query.ps1, worker pool)
#   POST   /api/profile  { source, table? }                           (Query.ps1, worker pool)
#   GET    /api/vault                     Lazarette bridge status, never a secret (Vault.ps1)
#   POST   /api/vault/pair   { code }     stores a pairing code from Settings; the code is never logged or returned
#   POST   /api/vault/unpair              forgets the pairing on this computer
#   GET    /api/ai                        AI status, never the key            (Intelligence.ps1)
#   POST   /api/ai/check                  is Fairlead reachable with the key  (Intelligence.ps1, worker pool)
#   POST   /api/ai/v1/chat/completions    drafting request passed to Fairlead (Intelligence.ps1, worker pool)
#   The local database (LocalDb.ps1, docs/LOCAL-DATABASE.md):
#   GET    /api/local/tables                         { tables: [{ name, rows, columns, bytes, source, importedAt }], ... }
#   POST   /api/local/import          raw file body  X-File-Name (percent-encoded), X-Table?, X-Sheet?, X-Replace: 1?
#          streamed to <home>\local\incoming by an import job (never held in memory) -> 202 { job }
#   POST   /api/local/import-path { path, sheet?, table?, replace? }   reads the file in place -> 202 { job }
#   POST   /api/local/sheets  { path }               the sheets of a workbook or the tables of a SQLite file
#   GET    /api/local/import-status/<job>            { state, rows, bytes, totalBytes, table, error, ... }
#   POST   /api/local/import-cancel { job }          stops a running import (nothing is published)
#   DELETE /api/local/tables/<name>                  drops the table
#   POST   /api/local/tables/<name>/rename { name }  renames it
#   SQL scripts and exports (LocalScript.ps1): GET /api/local/scripts, GET|PUT|DELETE /api/local/scripts/<id>,
#   POST /api/local/script-run { plan | id, params }, POST /api/local/export { table, format }, GET /api/local/sources
#   Pipelines (Pipeline.ps1, docs/PIPELINES.md): GET /api/pipelines, GET|PUT|DELETE /api/pipelines/<id>,
#   POST /api/pipelines/<id>/run { from?, force? }, GET /api/pipelines/<id>/runs[/<run>]
#   Alerts (Alerts.ps1): GET /api/alerts, GET|PUT|DELETE /api/alerts/<id>, POST /api/alerts/check { source, readings }
#   Briefing delivery (Mail.ps1, never sends): GET /api/mail, PUT /api/mail/settings, PUT /api/mail/briefing,
#   POST /api/mail/outlook-draft { subject, html, to, attachment, open }
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
    # -Json: the object the gate already parsed from these bytes (Http.ps1), so the document is parsed once.
    param([byte[]]$Bytes, $Json = $null)
    if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return 'The body is empty.' }
    if ($Bytes.Length -gt $script:SemDocMaxBytes) { return 'too-large' }
    $j = $Json
    if ($null -eq $j) {
        $text = (New-Object Text.UTF8Encoding $false).GetString($Bytes)
        if (-not $text.TrimStart([char]0xFEFF, ' ', "`t", "`r", "`n").StartsWith('{')) { return 'The body must be a JSON object.' }
        try { $j = $text | ConvertFrom-Json -ErrorAction Stop } catch { return 'The body is not valid JSON.' }
    }
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
            $problem = Test-SemDocBody -Bytes $Req.Body -Json $Req.Json
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
# Team widget library: <home>\widgets\<id>.json, one custom chart widget each (src/core/widget.ts).
#   GET    /api/widgets          [{ id, name, description, by, updated }], by name
#   GET    /api/widgets/<id>     the stored widget verbatim
#   POST   /api/widgets  { name, code, css?, description?, id? }
#          A new widget gets an id made from its name (a -2, -3 ... suffix when taken); with id, that
#          widget is replaced (404 when there is none). -> { ok: true, widget }
#   DELETE /api/widgets/<id>     moved to .trash with a timestamp suffix
# The code is stored and handed back as text, never run here: it runs only in the page's sandboxed
# frame (Http.ps1 $script:SemSandboxCsp).
# ---------------------------------------------------------------------------
$script:SemWidgetCodeMax = 65536      # bytes of code (src/core/widget.ts WIDGET_LIMITS.codeBytes)
$script:SemWidgetCssMax = 16384       # bytes of CSS
$script:SemWidgetNameMax = 80
$script:SemWidgetDescriptionMax = 500
$script:SemWidgetMaxCount = 500

function Get-SemWidgetDir {
    param([string]$HomeDir = $script:Sem.Home)
    $d = Join-Path $HomeDir 'widgets'
    if (-not (Test-Path -LiteralPath $d)) { [void][IO.Directory]::CreateDirectory($d) }
    return $d
}

function ConvertTo-SemWidgetText {
    # One line of plain text: control and line-separator characters become spaces, runs of space one,
    # trimmed, at most $Max characters (never half a surrogate pair). '' for anything but a string.
    param($Value, [int]$Max)
    if ($Value -isnot [string]) { return '' }
    $t = [regex]::Replace($Value, '[\x00-\x1F\x7F-\x9F\u2028\u2029]', ' ')
    $t = [regex]::Replace($t, '\s+', ' ').Trim()
    if ($t.Length -gt $Max) {
        $cut = $Max
        if ([char]::IsHighSurrogate($t[$cut - 1])) { $cut-- }
        $t = $t.Substring(0, $cut).Trim()
    }
    return $t
}

function ConvertTo-SemWidgetName {
    # The name rule of src/core/widget.ts sanitizeWidgetName.
    param($Value)
    return (ConvertTo-SemWidgetText $Value $script:SemWidgetNameMax)
}

function ConvertTo-SemWidgetId {
    # The id rule of src/core/widget.ts widgetIdFor: lower-case letters, digits and dashes, 48 at most.
    param([string]$Name)
    $s = [regex]::Replace($Name.ToLowerInvariant(), '[^a-z0-9]+', '-').Trim('-')
    if ($s.Length -gt 48) { $s = $s.Substring(0, 48).TrimEnd('-') }
    if (-not $s) { $s = 'widget' }
    return $s
}

function Get-SemWidgetList {
    # [{ id, name, description, by, updated }] from <dir>\*.json, by name; unreadable files are skipped.
    param([Parameter(Mandatory = $true)][string]$Dir)
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($f in @(Get-ChildItem -LiteralPath $Dir -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name)) {
        if ($out.Count -ge $script:SemWidgetMaxCount) { break }
        $id = [IO.Path]::GetFileNameWithoutExtension($f.Name)
        if (-not (Test-SemDocId $id)) { continue }
        if ($f.Length -gt 524288) { continue }
        try { $j = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        if ($j -isnot [Management.Automation.PSCustomObject]) { continue }
        $name = ConvertTo-SemWidgetName (Get-SemJsonProp $j 'name')
        if (-not $name) { $name = $id }
        $updated = Get-SemJsonProp $j 'updated'
        if ($updated -is [datetime]) { $updated = $updated.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
        if ($updated -isnot [string] -or $updated -eq '') { $updated = $f.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
        $out.Add([ordered]@{ id = $id; name = $name; description = (ConvertTo-SemWidgetText (Get-SemJsonProp $j 'description') $script:SemWidgetDescriptionMax); by = (ConvertTo-SemWidgetText (Get-SemJsonProp $j 'by') 64); updated = $updated })
    }
    return , @($out.ToArray() | Sort-Object -Property @{ Expression = { $_.name } })
}

function Test-SemWidgetBody {
    <#
      Checks a POST body. Returns @{ Status; Code; Error } for a refusal, else @{ Widget } with the cleaned
      fields (name, description, code, css, id or $null).
    #>
    param($Json)
    if ($Json -isnot [Management.Automation.PSCustomObject]) { return @{ Status = 400; Code = 'bad-json'; Error = 'The body must be a JSON object.' } }
    $name = ConvertTo-SemWidgetName (Get-SemJsonProp $Json 'name')
    if (-not $name) { return @{ Status = 400; Code = 'invalid'; Error = 'Give the widget a name (letters, digits, spaces; at most 80 characters).' } }
    $code = Get-SemJsonProp $Json 'code'
    if ($code -isnot [string] -or $code.Trim() -eq '') { return @{ Status = 400; Code = 'invalid'; Error = 'The widget has no code.' } }
    if ([Text.Encoding]::UTF8.GetByteCount($code) -gt $script:SemWidgetCodeMax) { return @{ Status = 413; Code = 'too-large'; Error = 'A widget''s code may be at most 64 KB.' } }
    $css = Get-SemJsonProp $Json 'css'
    if ($null -eq $css) { $css = '' }
    if ($css -isnot [string]) { return @{ Status = 400; Code = 'invalid'; Error = 'The CSS must be text.' } }
    if ([Text.Encoding]::UTF8.GetByteCount($css) -gt $script:SemWidgetCssMax) { return @{ Status = 413; Code = 'too-large'; Error = 'A widget''s CSS may be at most 16 KB.' } }
    $id = Get-SemJsonProp $Json 'id'
    if ($null -ne $id -and ($id -isnot [string] -or -not (Test-SemDocId $id))) { return @{ Status = 400; Code = 'bad-id'; Error = 'Invalid widget id: use 1 to 64 letters, digits, _ or -.' } }
    return @{ Widget = @{ name = $name; description = (ConvertTo-SemWidgetText (Get-SemJsonProp $Json 'description') $script:SemWidgetDescriptionMax); code = $code; css = $css; id = $id } }
}

function Invoke-SemWidgetRoute {
    param($Req, $Id)
    $dir = Get-SemWidgetDir
    if ($null -eq $Id) {
        if ($Req.Method -eq 'GET') { Send-SemJson 200 (Get-SemWidgetList -Dir $dir); return }
        if ($Req.Method -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        $check = Test-SemWidgetBody $Req.Json
        if ($check.ContainsKey('Status')) { Send-SemError $check.Status $check.Code $check.Error; return }
        $w = $check.Widget
        $id = $w.id
        if ($null -ne $id) {
            if (-not [IO.File]::Exists((Join-Path $dir ($id + '.json')))) { Send-SemError 404 'not-found' ("No library widget '$id'."); return }
        } else {
            $count = @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File -ErrorAction SilentlyContinue).Count
            if ($count -ge $script:SemWidgetMaxCount) { Send-SemError 409 'full' ('The team library holds ' + $script:SemWidgetMaxCount + ' widgets at most. Remove some first.'); return }
            $stem = ConvertTo-SemWidgetId $w.name
            $id = $stem; $n = 1
            while ([IO.File]::Exists((Join-Path $dir ($id + '.json')))) { $n++; $id = $stem + '-' + $n }
        }
        $doc = [ordered]@{ version = 1; id = $id; name = $w.name; description = $w.description; code = $w.code; css = $w.css; by = (ConvertTo-SemWidgetText ([string]$env:USERNAME) 64); updated = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
        $bytes = (New-Object Text.UTF8Encoding $false).GetBytes((ConvertTo-SemJson $doc))
        $script:Sem.SyncBusy = $true
        try { Save-SemDoc -Dir $dir -Id $id -Bytes $bytes } finally { $script:Sem.SyncBusy = $false }
        Write-SemLog 'INFO' ("Saved library widget $id ($($bytes.Length) bytes)")
        Send-SemJson 200 ([ordered]@{ ok = $true; widget = $doc })
        return
    }
    if (-not (Test-SemDocId $Id)) { Send-SemError 400 'bad-id' 'Invalid widget id: use 1 to 64 letters, digits, _ or -.'; return }
    switch ($Req.Method) {
        'GET' {
            $f = Join-Path $dir ($Id + '.json')
            if (-not [IO.File]::Exists($f)) { Send-SemError 404 'not-found' ("No library widget '$Id'."); return }
            $text = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
            Send-SemJsonText 200 $text
        }
        'DELETE' {
            $script:Sem.SyncBusy = $true
            try { $done = Remove-SemDoc -Dir $dir -Id $Id } finally { $script:Sem.SyncBusy = $false }
            if (-not $done) { Send-SemError 404 'not-found' ("No library widget '$Id'."); return }
            Write-SemLog 'INFO' "Moved library widget $Id to .trash"
            Send-SemJson 200 ([ordered]@{ ok = $true })
        }
        default { Send-SemError 405 'method' 'Method not allowed.' }
    }
}

# ---------------------------------------------------------------------------
# Page snapshots: a named or automatic copy of one hoist, to look at again or restore. The page is
# kept byte for byte as it was sent (never re-serialised), next to a small file saying what it is.
# ---------------------------------------------------------------------------
$script:SemSnapMaxBodyBytes = 3145728   # the page as a JSON string, escaped, plus its name and note
$script:SemSnapKeepAuto = 30
$script:SemSnapMaxNamed = 200
$script:SemSnapAutoGapSeconds = 600
$script:SemSnapKinds = @('named', 'auto', 'restore')

function Test-SemSnapId {
    # yyyyMMddHHmmssfff-<6 hex>: sorts by time.
    param([string]$Id)
    return ($Id -cmatch '\A\d{17}-[0-9a-f]{6}\z')
}

function Get-SemSnapDir {
    param([string]$HoistId, [string]$HomeDir = $script:Sem.Home, [switch]$Create)
    $d = Join-Path (Join-Path $HomeDir 'snapshots') $HoistId
    if ($Create -and -not (Test-Path -LiteralPath $d)) { [void][IO.Directory]::CreateDirectory($d) }
    return $d
}

function ConvertTo-SemSnapText {
    # One trimmed line: control and line-separator characters become spaces, runs of space one space.
    param($Value, [int]$Max)
    if ($Value -isnot [string]) { return '' }
    $t = [regex]::Replace($Value, '[\x00-\x1F\x7F-\x9F\u2028\u2029]', ' ')
    $t = [regex]::Replace($t, '\s+', ' ').Trim()
    if ($t.Length -gt $Max) { $t = $t.Substring(0, $Max).Trim() }
    return $t
}

function Get-SemSnapList {
    # The snapshots of one page, newest first. Unreadable files are skipped.
    param([string]$Dir)
    $out = New-Object System.Collections.Generic.List[object]
    if (-not (Test-Path -LiteralPath $Dir)) { return , $out.ToArray() }
    foreach ($f in @(Get-ChildItem -LiteralPath $Dir -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) {
        $id = [IO.Path]::GetFileNameWithoutExtension($f.Name)
        if (-not (Test-SemSnapId $id)) { continue }
        if ($f.Length -gt 65536) { continue }
        try { $j = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        if ($j -isnot [Management.Automation.PSCustomObject]) { continue }
        $out.Add($j)
    }
    return , $out.ToArray()
}

function Remove-SemSnap {
    # -Trash moves both files to <dir>\.trash (a delete the analyst asked for); without it they are erased (pruning).
    param([string]$Dir, [string]$Id, [switch]$Trash)
    $meta = Join-Path $Dir ($Id + '.json')
    if (-not [IO.File]::Exists($meta)) { return $false }
    if ($Trash) {
        [void](Remove-SemDoc -Dir $Dir -Id ($Id + '.hoist'))
        [void](Remove-SemDoc -Dir $Dir -Id $Id)
        return $true
    }
    foreach ($f in @($meta, (Join-Path $Dir ($Id + '.hoist.json')))) { if ([IO.File]::Exists($f)) { [IO.File]::Delete($f) } }
    return $true
}

function Test-SemSnapRecent {
    # $true when the newest automatic snapshot in $List was taken less than 10 minutes before $Now.
    param($List, [datetime]$Now)
    $last = @($List | Where-Object { $_.kind -ceq 'auto' } | Select-Object -First 1)
    if ($last.Count -eq 0) { return $false }
    $at = [datetime]::MinValue
    $styles = [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal
    $created = $last[0].created
    if ($created -is [datetime]) { $at = $created.ToUniversalTime() }
    elseif (-not [datetime]::TryParse([string]$created, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$at)) { return $false }
    return (($Now - $at).TotalSeconds -lt $script:SemSnapAutoGapSeconds)
}

function Invoke-SemSnapRoute {
    param($Req, [string]$HoistId, $SnapId, [datetime]$Now = (Get-Date).ToUniversalTime())
    if (-not (Test-SemDocId $HoistId)) { Send-SemError 400 'bad-id' 'Invalid hoist id: use 1 to 64 letters, digits, _ or -.'; return }
    if ($null -ne $SnapId -and -not (Test-SemSnapId $SnapId)) { Send-SemError 400 'bad-id' 'Invalid snapshot id.'; return }
    $dir = Get-SemSnapDir -HoistId $HoistId
    if ($null -ne $SnapId) {
        $meta = Join-Path $dir ($SnapId + '.json')
        $page = Join-Path $dir ($SnapId + '.hoist.json')
        if ($Req.Method -eq 'GET') {
            if (-not [IO.File]::Exists($meta) -or -not [IO.File]::Exists($page)) { Send-SemError 404 'not-found' 'No such snapshot.'; return }
            $metaText = [IO.File]::ReadAllText($meta, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF).Trim()
            $pageText = [IO.File]::ReadAllText($page, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF).Trim()
            Send-SemJsonText 200 ('{"snapshot":' + $metaText + ',"hoist":' + $pageText + '}')
            return
        }
        if ($Req.Method -eq 'DELETE') {
            $script:Sem.SyncBusy = $true
            try { $done = Remove-SemSnap -Dir $dir -Id $SnapId -Trash } finally { $script:Sem.SyncBusy = $false }
            if (-not $done) { Send-SemError 404 'not-found' 'No such snapshot.'; return }
            Write-SemLog 'INFO' "Moved snapshot $SnapId of hoist $HoistId to .trash"
            Send-SemJson 200 ([ordered]@{ ok = $true })
            return
        }
        Send-SemError 405 'method' 'Method not allowed.'
        return
    }
    if ($Req.Method -eq 'GET') { Send-SemJson 200 (Get-SemSnapList -Dir $dir); return }
    if ($Req.Method -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
    if ($Req.Body.Length -gt $script:SemSnapMaxBodyBytes) { Send-SemError 413 'too-large' 'A snapshot may be at most 2 MB.'; return }
    $j = $Req.Json
    if ($j -isnot [Management.Automation.PSCustomObject]) { Send-SemError 400 'bad-json' 'The body must be a JSON object.'; return }
    $kind = Get-SemJsonProp $j 'kind'
    if ($kind -isnot [string] -or $script:SemSnapKinds -cnotcontains $kind) { Send-SemError 400 'invalid' 'kind must be "named", "auto" or "restore".'; return }
    $name = ConvertTo-SemSnapText (Get-SemJsonProp $j 'name') 80
    if ($kind -ceq 'named' -and $name -eq '') { Send-SemError 400 'invalid' 'A named snapshot needs a name.'; return }
    $hoistText = Get-SemJsonProp $j 'hoist'
    if ($hoistText -isnot [string]) { Send-SemError 400 'invalid' 'hoist must be the page as JSON text.'; return }
    $hoistBytes = (New-Object Text.UTF8Encoding $false).GetBytes($hoistText)
    $problem = Test-SemDocBody -Bytes $hoistBytes
    if ($problem -eq 'too-large') { Send-SemError 413 'too-large' 'A snapshot may be at most 2 MB.'; return }
    if ($problem) { Send-SemError 400 'invalid' $problem; return }
    $hoist = $hoistText | ConvertFrom-Json
    if ((Get-SemJsonProp $hoist 'id') -cne $HoistId) { Send-SemError 400 'invalid' 'The page in the snapshot is another hoist.'; return }
    $all = Get-SemSnapList -Dir $dir   # an array already (no @(): it would wrap it in another)
    $autos = @($all | Where-Object { $_.kind -cne 'named' })
    # At most one automatic snapshot every 10 minutes; the one taken before a restore always counts.
    if ($kind -ceq 'auto' -and (Test-SemSnapRecent -List $autos -Now $Now)) {
        Send-SemJson 200 ([ordered]@{ ok = $true; skipped = 'recent' })
        return
    }
    if ($kind -ceq 'named' -and @($all | Where-Object { $_.kind -ceq 'named' }).Count -ge $script:SemSnapMaxNamed) {
        Send-SemError 409 'too-many' ('A page keeps at most {0} named snapshots. Delete one first.' -f $script:SemSnapMaxNamed)
        return
    }
    $id = $Now.ToString('yyyyMMddHHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
    $catalogVersion = [string](Get-SemJsonProp $j 'catalogVersion')
    if ($catalogVersion -cnotmatch '\A[0-9a-f]{8,64}\z') { $catalogVersion = '' }
    $flagList = Get-SemJsonProp $hoist 'flags'
    $flagCount = 0
    if ($null -ne $flagList) { $flagCount = @($flagList).Count }
    $meta = [ordered]@{
        version = 1; id = $id; hoistId = $HoistId; kind = $kind; name = $name
        note = (ConvertTo-SemSnapText (Get-SemJsonProp $j 'note') 500)
        reason = (ConvertTo-SemSnapText (Get-SemJsonProp $j 'reason') 120)
        author = (ConvertTo-SemSnapText ([string]$env:USERNAME) 64)
        created = $Now.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
        catalogVersion = $catalogVersion
        title = (ConvertTo-SemSnapText (Get-SemJsonProp $hoist 'title') 120)
        flags = $flagCount
        bytes = $hoistBytes.Length
    }
    $dir = Get-SemSnapDir -HoistId $HoistId -Create
    $script:Sem.SyncBusy = $true
    try {
        Save-SemDoc -Dir $dir -Id ($id + '.hoist') -Bytes $hoistBytes
        Save-SemDoc -Dir $dir -Id $id -Bytes ((New-Object Text.UTF8Encoding $false).GetBytes((ConvertTo-SemJson $meta)))
        # Keep the newest automatic ones; named ones stay until the analyst deletes them.
        if ($kind -cne 'named') {
            foreach ($o in @($autos | Select-Object -Skip ($script:SemSnapKeepAuto - 1))) {
                if (Test-SemSnapId ([string]$o.id)) { [void](Remove-SemSnap -Dir $dir -Id ([string]$o.id)) }
            }
        }
    } finally { $script:Sem.SyncBusy = $false }
    Write-SemLog 'INFO' ("Snapshot {0} ({1}) of hoist {2}, {3} bytes" -f $id, $kind, $HoistId, $hoistBytes.Length)
    Send-SemJson 200 ([ordered]@{ ok = $true; snapshot = $meta })
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
        $one = [ordered]@{ id = $s.id; label = $s.label; kind = $s.kind; provider = $s.provider; placeholders = 'question'; vault = [bool](Get-SemSourceVault $s) }
        if ($s.engine) { $one.engine = $s.engine }   # aws-rds: the engine picks the SQL dialect (dialectForSource)
        $sources += $one
    }
    return [ordered]@{
        tool = 'semaphore'; version = $script:Sem.Version; pid = $PID; port = $script:Sem.Port; home = $script:Sem.Home
        autoStop = [bool]$script:Sem.Presence.AutoStop; stay = [bool]$script:Sem.Stay; sources = $sources
        user = [string]$env:USERNAME; reviewer = [string]$script:Sem.Reviewer; view = [string]$script:Sem.View
        skin = [string]$script:Sem.Skin; social = $script:Sem.Social
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
    if ($p -match '^/api/page-snapshots/([^/]+)(?:/([^/]+))?$') {
        Invoke-SemSnapRoute -Req $Req -HoistId $Matches[1] -SnapId $Matches[2]
        return
    }
    if ($p -match '^/api/(widgets)(?:/([^/]*))?$') {
        $id = $null
        if ($p -ne '/api/widgets') { $id = $Matches[2]; if ($null -eq $id) { $id = '' } }
        Invoke-SemWidgetRoute -Req $Req -Id $id
        return
    }
    if ($p -eq '/api/alerts/check') {
        # The page's values from refreshed snapshots, checked against every alert on those flags (Alerts.ps1).
        Invoke-SemAlertRoute -Req $Req -Id 'check'
        return
    }
    if ($p -match '^/api/(alerts)(?:/([^/]*))?$') {
        # Alerts on reviewed flags (Alerts.ps1).
        $id = $null
        if ($p -ne '/api/alerts') { $id = $Matches[2]; if ($null -eq $id) { $id = '' } }
        Invoke-SemAlertRoute -Req $Req -Id $id
        return
    }
    if ($p -eq '/api/mail' -or $p -eq '/api/mail/settings' -or $p -eq '/api/mail/briefing' -or $p -eq '/api/mail/outlook-draft') {
        # Briefing delivery: Outlook drafts and the weekly schedule (Mail.ps1). Never sends.
        Invoke-SemMailRoute -Req $Req
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
        # id, title and error come from the page: one log-safe line each, capped, before the log and the saved report (#89 rule).
        $failed = @()
        foreach ($f in @(Get-SemJsonProp $Req.Json 'failed') | Select-Object -First 200) {
            if ($f -isnot [Management.Automation.PSCustomObject]) { continue }
            $failed += [ordered]@{ id = (ConvertTo-SemLogText ([string](Get-SemJsonProp $f 'id')) 64); title = (ConvertTo-SemLogText ([string](Get-SemJsonProp $f 'title')) 200); error = (ConvertTo-SemLogText ([string](Get-SemJsonProp $f 'error')) 500) }
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
    if ($p -eq '/api/vault/pair') {
        if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        [void](Initialize-SemVault -Root $script:Sem.Root)
        Invoke-SemVaultPairRoute -Req $Req; return
    }
    if ($p -eq '/api/vault/unpair') {
        if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        [void](Initialize-SemVault -Root $script:Sem.Root)
        [void](Unregister-SemVaultPairing)
        Send-SemJson 200 (Get-SemVaultStatus -HomeDir $script:Sem.Home); return
    }
    if ($p -eq '/api/s3/buckets') {
        # S3.ps1: the allowlisted buckets from config\settings.json; no AWS call.
        if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Send-SemJson 200 (Get-SemS3BucketList); return
    }
    if ($p -eq '/api/s3/list' -or $p -eq '/api/rds/discover') {
        # S3.ps1 / Aws.ps1, on the worker pool: AWS can take seconds, and the AWS session is read from Lazarette there.
        if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Start-SemWorkerRequest -Req $Req
        return
    }
    if ($p -eq '/api/s3/import') {
        if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        if ($Req.Json -isnot [Management.Automation.PSCustomObject]) { Send-SemError 400 'bad-json' 'The body must be a JSON object.'; return }
        Start-SemS3Import -Req $Req; return
    }
    if ($p -eq '/api/s3/import-status' -or $p.StartsWith('/api/s3/import-status/')) {
        if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Invoke-SemS3StatusRoute -Path $p; return
    }
    if ($p -eq '/api/voice') {
        if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Send-SemJson 200 (Get-SemVoiceStatus); return
    }
    if ($p -eq '/api/voice/speak' -or $p -eq '/api/voice/start') {
        # Intelligence.ps1, on the worker pool: TalkForge can take seconds per sentence, and starting it
        # reads the token from Lazarette.
        if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Start-SemWorkerRequest -Req $Req
        return
    }
    if ($p -eq '/api/voice/status') {
        # On the worker pool too: the loopback probe can take a second on a closed port, and the page asks
        # often while TalkForge starts.
        if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Start-SemWorkerRequest -Req $Req
        return
    }
    if ($p -eq '/api/voice/voices') {
        # The voices in the TalkForge folder, read from disk; TalkForge need not run.
        if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        Send-SemJson 200 (Get-SemTalkForgeVoices); return
    }
    if ($p -eq '/api/voice/dictation/status') {
        # Http.ps1: whether TalkForge's Whisper files are there for voice input (speech-to-text runs in the page).
        if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        if ($script:Sem.VoiceInput -ne $true) { Send-SemError 403 'voice-input-off' 'Voice input is turned off for this Semaphore (voice.input in config\settings.json).'; return }
        Send-SemJson 200 (Get-SemSttStatus); return
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
    if ($p -eq '/api/local/scripts' -or $p -eq '/api/local/script-run' -or $p -eq '/api/local/export' -or $p -eq '/api/local/sources' -or $p.StartsWith('/api/local/scripts/')) {
        # SQL scripts, saved scripts and dataset exports (LocalScript.ps1): runs and exports go to the local job pool.
        Invoke-SemLocalScriptRoute -Req $Req
        return
    }
    if ($p -eq '/api/pipelines' -or $p.StartsWith('/api/pipelines/')) {
        # Data-prep pipelines (Pipeline.ps1): runs go to the local job pool, one at a time.
        Invoke-SemPipelineRoute -Req $Req
        return
    }
    if ($p -eq '/api/local/tables' -or $p -eq '/api/local/import' -or $p -eq '/api/local/import-path' -or $p -eq '/api/local/sheets' -or $p -eq '/api/local/import-cancel' -or $p.StartsWith('/api/local/')) {
        # The local database (LocalDb.ps1): imports run on their own runspaces, the rest is quick.
        Invoke-SemLocalRoute -Req $Req
        return
    }
    Send-SemError 404 'not-found' 'Unknown API route.'
}
