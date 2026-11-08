#requires -Version 5.1
# =============================================================================
# Briefing delivery without network services: Semaphore never sends mail. It creates an unsent draft in
# Outlook on this computer (Outlook COM, Outlook.Application) for the person to check and send themselves,
# or writes the same message as an .eml file (X-Unsent: 1) that the default mail app opens as a draft.
# No SMTP, no Graph, no webhooks.
#
#   GET  /api/mail                      { outlook: { available, code, reason }, settings, latest: { at, subject } | null, outbox }
#   PUT  /api/mail/settings { recipients: [..], schedule: { enabled, weekday 0-6, time "HH:mm", open } }
#        this person's saved list and weekly schedule (<home>\mail\<user>.json); the schedule is off until they turn it on
#   PUT  /api/mail/briefing { subject, html, text, attachment: { name, html } }
#        the latest briefing the page produced (<home>\mail\latest-briefing.json), for the weekly schedule
#   POST /api/mail/outlook-draft { subject, html, to: [..], attachment: { name, html }, open }
#        -> { ok: true, saved: 'Drafts' } or { ok: false, code: outlook-missing | outlook-blocked | outlook-failed, error }
#        The attachment is written to <home>\mail\outbox first. The draft is saved to Drafts (and shown when open is
#        true); Send is never called.
#
# The weekly schedule (Invoke-SemMailTick, from the server loop): at the set weekday and time, the latest briefing
# becomes an Outlook draft for this person's saved list, or an .eml in the outbox when Outlook is not there. Never sent.
# =============================================================================

$script:SemMailMaxRecipients = 50
$script:SemMailEmailRx = '\A[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+\z'
# How Outlook is found and started. Tests replace these; nothing here starts Outlook to find out whether it exists.
$script:SemOutlookProbe = { [Type]::GetTypeFromProgID('Outlook.Application') }
$script:SemOutlookFactory = { New-Object -ComObject 'Outlook.Application' }

function Get-SemMailDir {
    param([string]$HomeDir = $script:Sem.Home, [string]$Child = '')
    $d = Join-Path $HomeDir 'mail'
    if ($Child) { $d = Join-Path $d $Child }
    if (-not [IO.Directory]::Exists($d)) { [void][IO.Directory]::CreateDirectory($d) }
    return $d
}

function Get-SemMailUserId {
    param([string]$User = [string]$env:USERNAME)
    $s = ($User.ToLowerInvariant() -replace '[^a-z0-9_-]', '_')
    if (-not $s) { $s = 'someone' }
    if ($s.Length -gt 40) { $s = $s.Substring(0, 40) }
    return ('user-' + $s)
}

function Get-SemMailProp {
    param($Object, [string]$Name)
    if ($null -eq $Object -or $Object -isnot [Management.Automation.PSCustomObject]) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

function ConvertTo-SemRecipients {
    # The addresses that look like addresses, without repeats, at most 50 (src/core/briefing-mail.ts cleanRecipients).
    param($List)
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($r in @($List)) {
        if ($r -isnot [string]) { continue }
        $a = $r.Trim()
        if ($a -cnotmatch $script:SemMailEmailRx) { continue }
        $dup = $false; foreach ($x in $out) { if ($x.Equals($a, [StringComparison]::OrdinalIgnoreCase)) { $dup = $true } }
        if (-not $dup) { $out.Add($a) }
        if ($out.Count -ge $script:SemMailMaxRecipients) { break }
    }
    return $out.ToArray()
}

function Read-SemMailSettings {
    param([string]$HomeDir = $script:Sem.Home, [string]$User = [string]$env:USERNAME)
    $f = Join-Path (Get-SemMailDir -HomeDir $HomeDir) ((Get-SemMailUserId $User) + '.json')
    $s = [ordered]@{ version = 1; recipients = @(); schedule = [ordered]@{ enabled = $false; weekday = 1; time = '08:00'; open = $false }; lastScheduled = ''; lastResult = '' }
    if (-not [IO.File]::Exists($f)) { return $s }
    try { $j = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json -ErrorAction Stop } catch { return $s }
    $s.recipients = @(ConvertTo-SemRecipients (Get-SemMailProp $j 'recipients'))
    $sch = Get-SemMailProp $j 'schedule'
    if ($sch -is [Management.Automation.PSCustomObject]) {
        $s.schedule.enabled = ((Get-SemMailProp $sch 'enabled') -eq $true)
        $wd = 0; if ([int]::TryParse([string](Get-SemMailProp $sch 'weekday'), [ref]$wd) -and $wd -ge 0 -and $wd -le 6) { $s.schedule.weekday = $wd }
        $t = [string](Get-SemMailProp $sch 'time'); if ($t -cmatch '\A([01][0-9]|2[0-3]):[0-5][0-9]\z') { $s.schedule.time = $t }
        $s.schedule.open = ((Get-SemMailProp $sch 'open') -eq $true)
    }
    $s.lastScheduled = [string](Get-SemMailProp $j 'lastScheduled')
    $s.lastResult = [string](Get-SemMailProp $j 'lastResult')
    return $s
}

function Save-SemMailSettings {
    param($Settings, [string]$HomeDir = $script:Sem.Home, [string]$User = [string]$env:USERNAME)
    $o = [ordered]@{ version = 1; recipients = @($Settings.recipients); schedule = $Settings.schedule; lastScheduled = [string]$Settings.lastScheduled; lastResult = [string]$Settings.lastResult }
    $text = ConvertTo-Json -InputObject $o -Depth 5 -Compress
    Save-SemDoc -Dir (Get-SemMailDir -HomeDir $HomeDir) -Id (Get-SemMailUserId $User) -Bytes ((New-Object Text.UTF8Encoding $false).GetBytes($text))
}

# ---------------------------------------------------------------------------
# Outlook
# ---------------------------------------------------------------------------
function Test-SemOutlook {
    # Whether Outlook is registered on this computer, without starting it.
    try { $t = & $script:SemOutlookProbe } catch { return [ordered]@{ available = $false; code = 'outlook-blocked'; reason = ('Windows would not say whether Outlook is installed: ' + $_.Exception.Message) } }
    if ($null -eq $t) { return [ordered]@{ available = $false; code = 'outlook-missing'; reason = 'Outlook is not installed on this computer (there is no Outlook.Application), so no draft can be made. Save the briefing as an email file instead.' } }
    return [ordered]@{ available = $true; code = 'ok'; reason = '' }
}

function Get-SemSafeFileName {
    param([string]$Name, [string]$Default = 'briefing.html')
    $n = [IO.Path]::GetFileName([string]$Name)
    $n = ($n -replace '[^A-Za-z0-9 ._-]', '_').Trim()
    if (-not $n -or $n.StartsWith('.')) { $n = $Default }
    if ($n.Length -gt 100) { $n = $n.Substring($n.Length - 100) }
    if (-not $n.ToLowerInvariant().EndsWith('.html')) { $n = $n + '.html' }
    return $n
}

function Write-SemOutboxFile {
    # Writes text to <home>\mail\outbox\<stamp>-<name> and returns the full path.
    param([string]$HomeDir, [string]$Name, [string]$Text, [datetime]$Now = (Get-Date))
    $dir = Get-SemMailDir -HomeDir $HomeDir -Child 'outbox'
    $path = Join-Path $dir ($Now.ToString('yyyyMMdd-HHmmss') + '-' + $Name)
    [IO.File]::WriteAllText($path, $Text, (New-Object Text.UTF8Encoding $false))
    return $path
}

function New-SemOutlookDraft {
    <#
      Creates an Outlook mail item, fills it and saves it to Drafts. Never calls Send: the person sends it from
      Outlook. -Display also opens it for them. Returns { ok, code, error?, saved? }.
    #>
    param([string]$Subject, [string]$Html, [string[]]$To = @(), [string]$AttachmentPath = '', [switch]$Display)
    $probe = Test-SemOutlook
    if (-not $probe.available) { return [ordered]@{ ok = $false; code = $probe.code; error = $probe.reason } }
    $ol = $null; $mail = $null
    try {
        try { $ol = & $script:SemOutlookFactory } catch { return [ordered]@{ ok = $false; code = 'outlook-blocked'; error = ('Outlook is installed but Semaphore could not start it on this computer (COM may be blocked by policy): ' + $_.Exception.Message) } }
        if ($null -eq $ol) { return [ordered]@{ ok = $false; code = 'outlook-blocked'; error = 'Outlook is installed but did not answer.' } }
        $mail = $ol.CreateItem(0)   # olMailItem
        $mail.Subject = $Subject
        $mail.HTMLBody = $Html
        $clean = @(ConvertTo-SemRecipients $To)
        if ($clean.Count -gt 0) { $mail.To = ($clean -join '; ') }
        if ($AttachmentPath -and [IO.File]::Exists($AttachmentPath)) { [void]$mail.Attachments.Add($AttachmentPath) }
        $mail.Save()
        if ($Display) { $mail.Display($false) }
        Write-SemLog 'INFO' ('Outlook draft saved (not sent) for ' + $clean.Count + ' recipient(s)')
        return [ordered]@{ ok = $true; code = 'ok'; saved = 'Drafts' }
    } catch {
        return [ordered]@{ ok = $false; code = 'outlook-failed'; error = ('Outlook did not make the draft: ' + $_.Exception.Message) }
    } finally {
        foreach ($o in @($mail, $ol)) { if ($null -ne $o -and [Runtime.InteropServices.Marshal]::IsComObject($o)) { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($o) } catch { } } }
    }
}

# ---------------------------------------------------------------------------
# .eml (the same layout as src/core/briefing-mail.ts composeEml)
# ---------------------------------------------------------------------------
function ConvertTo-SemBase64Lines {
    param([string]$Text)
    $b = [Convert]::ToBase64String((New-Object Text.UTF8Encoding $false).GetBytes($Text))
    $sb = New-Object Text.StringBuilder
    for ($i = 0; $i -lt $b.Length; $i += 76) { [void]$sb.Append($b.Substring($i, [Math]::Min(76, $b.Length - $i))).Append("`r`n") }
    return $sb.ToString()
}

function ConvertTo-SemMailHeader {
    param([string]$Value)
    $v = ($Value -replace '[\r\n]+', ' ')
    if ($v -cmatch '\A[\x20-\x7e]*\z') { return $v }
    return ('=?UTF-8?B?' + [Convert]::ToBase64String((New-Object Text.UTF8Encoding $false).GetBytes($v)) + '?=')
}

function ConvertTo-SemEml {
    param([string[]]$To = @(), [string]$Subject, [string]$Html, [string]$Text = '', [string]$AttachmentName = '', [string]$AttachmentHtml = '', [datetime]$Date = (Get-Date), [string]$Boundary = '')
    if (-not $Boundary) { $Boundary = 'sem-' + [guid]::NewGuid().ToString('N').Substring(0, 10) }
    $mixed = $Boundary + '-mixed'; $alt = $Boundary + '-alt'
    $lines = New-Object System.Collections.Generic.List[string]
    $clean = @(ConvertTo-SemRecipients $To)
    if ($clean.Count -gt 0) { $lines.Add('To: ' + ($clean -join ', ')) }
    $lines.Add('Subject: ' + (ConvertTo-SemMailHeader $Subject))
    $lines.Add('Date: ' + $Date.ToUniversalTime().ToString('ddd, dd MMM yyyy HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture) + ' +0000')
    $lines.Add('X-Unsent: 1'); $lines.Add('MIME-Version: 1.0'); $lines.Add('Content-Type: multipart/mixed; boundary="' + $mixed + '"'); $lines.Add('')
    $lines.Add('This is a multi-part message in MIME format.'); $lines.Add('')
    $lines.Add('--' + $mixed); $lines.Add('Content-Type: multipart/alternative; boundary="' + $alt + '"'); $lines.Add('')
    $lines.Add('--' + $alt); $lines.Add('Content-Type: text/plain; charset=utf-8'); $lines.Add('Content-Transfer-Encoding: base64'); $lines.Add(''); $lines.Add((ConvertTo-SemBase64Lines $Text))
    $lines.Add('--' + $alt); $lines.Add('Content-Type: text/html; charset=utf-8'); $lines.Add('Content-Transfer-Encoding: base64'); $lines.Add(''); $lines.Add((ConvertTo-SemBase64Lines $Html))
    $lines.Add('--' + $alt + '--'); $lines.Add('')
    if ($AttachmentName) {
        $n = $AttachmentName -replace '["\\\r\n]', '_'
        $lines.Add('--' + $mixed); $lines.Add('Content-Type: text/html; charset=utf-8; name="' + $n + '"'); $lines.Add('Content-Transfer-Encoding: base64'); $lines.Add('Content-Disposition: attachment; filename="' + $n + '"'); $lines.Add(''); $lines.Add((ConvertTo-SemBase64Lines $AttachmentHtml))
    }
    $lines.Add('--' + $mixed + '--'); $lines.Add('')
    return ($lines -join "`r`n")
}

# ---------------------------------------------------------------------------
# The weekly schedule
# ---------------------------------------------------------------------------
function Get-SemMailDue {
    # The most recent scheduled time (local) on or before $Now for { weekday, time }.
    param($Schedule, [datetime]$Now)
    $parts = ([string]$Schedule.time).Split(':')
    $today = $Now.Date.AddHours([int]$parts[0]).AddMinutes([int]$parts[1])
    $back = ((([int]$Now.DayOfWeek) - [int]$Schedule.weekday) + 7) % 7
    $due = $today.AddDays(-$back)
    if ($due -gt $Now) { $due = $due.AddDays(-7) }
    return $due
}

function Invoke-SemMailTick {
    <#
      At the set weekday and time (opt-in), the latest saved briefing becomes an Outlook draft for this person's
      saved list; when Outlook is not there or is blocked, an .eml in <home>\mail\outbox instead. Once per scheduled
      time, within a day of it. Never sends. Returns a line for the log, or $null when nothing was due.
    #>
    param([string]$HomeDir = $script:Sem.Home, $Now = $null, [string]$User = [string]$env:USERNAME)
    if (-not $HomeDir) { return $null }
    if ($null -eq $Now) {
        $clock = $script:Sem.MailTickClock
        if ($null -ne $clock -and $clock.ElapsedMilliseconds -lt 60000) { return $null }
        $script:Sem.MailTickClock = [Diagnostics.Stopwatch]::StartNew()
        $Now = Get-Date
    }
    if (-not [IO.Directory]::Exists((Join-Path $HomeDir 'mail'))) { return $null }
    $s = Read-SemMailSettings -HomeDir $HomeDir -User $User
    if (-not $s.schedule.enabled) { return $null }
    $due = Get-SemMailDue -Schedule $s.schedule -Now $Now
    $dueText = $due.ToString('yyyy-MM-ddTHH:mm')
    if ($s.lastScheduled -and [string]::CompareOrdinal($s.lastScheduled, $dueText) -ge 0) { return $null }
    if (($Now - $due).TotalHours -gt 24) { return $null }
    $s.lastScheduled = $dueText
    $latest = Join-Path (Get-SemMailDir -HomeDir $HomeDir) 'latest-briefing.json'
    $b = $null
    if ([IO.File]::Exists($latest)) { try { $b = [IO.File]::ReadAllText($latest, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json -ErrorAction Stop } catch { $b = $null } }
    if ($null -eq $b) {
        $s.lastResult = 'No briefing has been saved yet: open the Leadership view or run a refresh, then it is drafted next week.'
    } else {
        $att = Get-SemMailProp $b 'attachment'
        $attPath = ''
        $attName = ''
        if ($att -is [Management.Automation.PSCustomObject] -and [string](Get-SemMailProp $att 'html')) {
            $attName = Get-SemSafeFileName ([string](Get-SemMailProp $att 'name'))
            $attPath = Write-SemOutboxFile -HomeDir $HomeDir -Name $attName -Text ([string](Get-SemMailProp $att 'html')) -Now $Now
        }
        $r = New-SemOutlookDraft -Subject ([string]$b.subject) -Html ([string]$b.html) -To @($s.recipients) -AttachmentPath $attPath -Display:($s.schedule.open)
        if ($r.ok) { $s.lastResult = ('Outlook draft made ' + $Now.ToString('yyyy-MM-dd HH:mm') + ' for ' + @($s.recipients).Count + ' recipient(s); not sent.') }
        else {
            $html = ''; if ($attPath) { $html = [string](Get-SemMailProp $att 'html') }
            $eml = ConvertTo-SemEml -To @($s.recipients) -Subject ([string]$b.subject) -Html ([string]$b.html) -Text ([string](Get-SemMailProp $b 'text')) -AttachmentName $attName -AttachmentHtml $html -Date $Now
            $p = Write-SemOutboxFile -HomeDir $HomeDir -Name 'briefing.eml' -Text $eml -Now $Now
            $s.lastResult = ($r.error + ' Saved as an email file instead: ' + $p)
        }
    }
    Save-SemMailSettings -Settings $s -HomeDir $HomeDir -User $User
    Write-SemLog 'INFO' ('Weekly briefing: ' + $s.lastResult)
    return $s.lastResult
}

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
function Invoke-SemMailRoute {
    param($Req)
    $p = $Req.Path; $m = $Req.Method; $homeDir = $script:Sem.Home
    if ($p -eq '/api/mail') {
        if ($m -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        $latest = $null
        $f = Join-Path (Get-SemMailDir -HomeDir $homeDir) 'latest-briefing.json'
        if ([IO.File]::Exists($f)) { try { $j = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8) | ConvertFrom-Json; $latest = [ordered]@{ at = [string](Get-SemMailProp $j 'at'); subject = [string](Get-SemMailProp $j 'subject') } } catch { $latest = $null } }
        $s = Read-SemMailSettings -HomeDir $homeDir
        $text = ConvertTo-Json -InputObject ([ordered]@{ outlook = (Test-SemOutlook); settings = $s; latest = $latest; outbox = (Get-SemMailDir -HomeDir $homeDir -Child 'outbox') }) -Depth 6 -Compress
        Send-SemJsonText 200 $text; return
    }
    if ($p -eq '/api/mail/settings') {
        if ($m -ne 'PUT') { Send-SemError 405 'method' 'Method not allowed.'; return }
        if ($Req.Json -isnot [Management.Automation.PSCustomObject]) { Send-SemError 400 'bad-json' 'The body must be a JSON object.'; return }
        $s = Read-SemMailSettings -HomeDir $homeDir
        $s.recipients = @(ConvertTo-SemRecipients (Get-SemJsonProp $Req.Json 'recipients'))
        $sch = Get-SemJsonProp $Req.Json 'schedule'
        if ($sch -is [Management.Automation.PSCustomObject]) {
            $wd = 0; $t = [string](Get-SemJsonProp $sch 'time')
            if (-not [int]::TryParse([string](Get-SemJsonProp $sch 'weekday'), [ref]$wd) -or $wd -lt 0 -or $wd -gt 6) { Send-SemError 400 'invalid' 'schedule.weekday is 0 (Sunday) to 6 (Saturday).'; return }
            if ($t -cnotmatch '\A([01][0-9]|2[0-3]):[0-5][0-9]\z') { Send-SemError 400 'invalid' 'schedule.time is HH:mm (24 hours).'; return }
            $s.schedule = [ordered]@{ enabled = ((Get-SemJsonProp $sch 'enabled') -eq $true); weekday = $wd; time = $t; open = ((Get-SemJsonProp $sch 'open') -eq $true) }
        }
        Save-SemMailSettings -Settings $s -HomeDir $homeDir
        Send-SemJson 200 ([ordered]@{ ok = $true }); return
    }
    if ($p -eq '/api/mail/briefing') {
        if ($m -ne 'PUT') { Send-SemError 405 'method' 'Method not allowed.'; return }
        $j = $Req.Json
        if ($j -isnot [Management.Automation.PSCustomObject] -or [string](Get-SemJsonProp $j 'subject') -eq '' -or [string](Get-SemJsonProp $j 'html') -eq '') { Send-SemError 400 'invalid' 'A briefing has a subject and an HTML body.'; return }
        $o = [ordered]@{ version = 1; at = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'); by = [string]$env:USERNAME; subject = [string]$j.subject; html = [string]$j.html; text = [string](Get-SemJsonProp $j 'text'); attachment = (Get-SemJsonProp $j 'attachment') }
        $script:Sem.SyncBusy = $true
        try { Save-SemDoc -Dir (Get-SemMailDir -HomeDir $homeDir) -Id 'latest-briefing' -Bytes ((New-Object Text.UTF8Encoding $false).GetBytes((ConvertTo-Json -InputObject $o -Depth 4 -Compress))) } finally { $script:Sem.SyncBusy = $false }
        Send-SemJson 200 ([ordered]@{ ok = $true }); return
    }
    if ($p -eq '/api/mail/outlook-draft') {
        if ($m -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        $j = $Req.Json
        if ($j -isnot [Management.Automation.PSCustomObject] -or [string](Get-SemJsonProp $j 'subject') -eq '' -or [string](Get-SemJsonProp $j 'html') -eq '') { Send-SemError 400 'invalid' 'A draft has a subject and an HTML body.'; return }
        $attPath = ''
        $att = Get-SemJsonProp $j 'attachment'
        if ($att -is [Management.Automation.PSCustomObject] -and [string](Get-SemJsonProp $att 'html')) {
            $attPath = Write-SemOutboxFile -HomeDir $homeDir -Name (Get-SemSafeFileName ([string](Get-SemJsonProp $att 'name'))) -Text ([string](Get-SemJsonProp $att 'html'))
        }
        $r = New-SemOutlookDraft -Subject ([string]$j.subject) -Html ([string]$j.html) -To @(Get-SemJsonProp $j 'to' | Where-Object { $_ -is [string] }) -AttachmentPath $attPath -Display:((Get-SemJsonProp $j 'open') -eq $true)
        Send-SemJson 200 $r; return
    }
    Send-SemError 404 'not-found' 'Unknown API route.'
}
