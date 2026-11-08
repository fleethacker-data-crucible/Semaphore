#requires -Version 5.1
# =============================================================================
# Semaphore alerts: "tell me when labor cost goes red". One file per alert in <home>\alerts\<id>.json
# (src/core/alerts.ts Alert): the reviewed flag (entryId), the measure and its red rule, who asked, the
# state (unknown, normal, red) and the firings, newest last.
#
#   GET    /api/alerts                 every alert, as one JSON array
#   GET    /api/alerts/<id>            one alert
#   PUT    /api/alerts/<id>            save one (the page sets it up, marks firings seen or briefed)
#   DELETE /api/alerts/<id>            moved to .trash
#   POST   /api/alerts/check { source: page|refresh, readings: [{ entryId, metric, value, asOf }] }
#          applies each reading to the alerts on that flag and measure (Update-SemAlertState, the same rules
#          as src/core/alerts.ts stepAlert) and saves the ones that changed -> { fired: [{ alertId, event }], alerts }
#
# The page works out the values (snapshots hold partial sums only its planner re-adds) and posts them from
# every place data refreshes: a snapshot refresh on an open page, page open, and the headless refresh run
# (Start-Semaphore.ps1 --refresh). The server applies the rules, so two pages never fire the same change
# twice. A pipeline's Publish step (Pipeline.ps1) has no values, so it marks the alerts on the flags it
# made out of date as pending with a note (Set-SemAlertsPending); the check happens on the next refresh
# or page open.
# =============================================================================

$script:SemAlertEventsKept = 50
$script:SemAlertMaxBytes = 262144
$script:SemAlertMaxCount = 500

function Get-SemAlertDir {
    param([string]$HomeDir = $script:Sem.Home)
    $d = Join-Path $HomeDir 'alerts'
    if (-not [IO.Directory]::Exists($d)) { [void][IO.Directory]::CreateDirectory($d) }
    return $d
}

function Get-SemAlertProp {
    param($Object, [string]$Name)
    if ($null -eq $Object -or $Object -isnot [Management.Automation.PSCustomObject]) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

function Set-SemAlertProp {
    param($Object, [string]$Name, $Value)
    if ($null -eq $Object.PSObject.Properties[$Name]) { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
    else { $Object.$Name = $Value }
}

function Test-SemAlert {
    # $null when $A (a parsed alert) has the shape the page and the check read, else the problem in words.
    param($A)
    if ($A -isnot [Management.Automation.PSCustomObject]) { return 'An alert is a JSON object.' }
    if ([string](Get-SemAlertProp $A 'version') -ne '1') { return 'An alert has "version": 1.' }
    if ([string](Get-SemAlertProp $A 'kind') -ne 'alert') { return 'An alert has "kind": "alert".' }
    foreach ($k in @('entryId', 'metric', 'who')) {
        $v = Get-SemAlertProp $A $k
        if ($v -isnot [string] -or $v.Length -eq 0 -or $v.Length -gt 200) { return ('An alert names its ' + $k + '.') }
    }
    $rule = Get-SemAlertProp $A 'rule'
    if ($rule -isnot [Management.Automation.PSCustomObject]) { return 'An alert has its red rule.' }
    if (@('lt', 'lte', 'gt', 'gte') -notcontains [string](Get-SemAlertProp $rule 'op')) { return 'The rule op is lt, lte, gt or gte.' }
    $rv = Get-SemAlertProp $rule 'value'
    if (-not ($rv -is [int] -or $rv -is [long] -or $rv -is [double] -or $rv -is [decimal])) { return 'The rule value is a number.' }
    if (@('unknown', 'normal', 'red') -notcontains [string](Get-SemAlertProp $A 'state')) { return 'state is unknown, normal or red.' }
    if ($null -eq $A.PSObject.Properties['events']) { return 'An alert has its list of events.' }
    return $null
}

function Read-SemAlerts {
    # Every valid alert in the folder, as parsed objects.
    param([string]$HomeDir = $script:Sem.Home)
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($f in @(Get-ChildItem -LiteralPath (Get-SemAlertDir -HomeDir $HomeDir) -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name)) {
        if ($out.Count -ge $script:SemAlertMaxCount) { break }
        if ($f.Name.StartsWith('.') -or $f.Length -gt $script:SemAlertMaxBytes) { continue }
        $id = [IO.Path]::GetFileNameWithoutExtension($f.Name)
        if ($id -cnotmatch '\A[A-Za-z0-9_-]{1,64}\z') { continue }
        try { $j = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        if (Test-SemAlert $j) { continue }
        Set-SemAlertProp $j 'id' $id
        $out.Add($j)
    }
    return $out.ToArray()
}

function ConvertTo-SemAlertText {
    param($Alert)
    # Events always an array, even with one item (Windows PowerShell would write one object).
    $events = @(Get-SemAlertProp $Alert 'events')
    $Alert.events = $null
    $text = ConvertTo-Json -InputObject $Alert -Depth 8 -Compress
    $evText = '[' + ((@($events | Where-Object { $null -ne $_ } | ForEach-Object { ConvertTo-Json -InputObject $_ -Depth 4 -Compress })) -join ',') + ']'
    $Alert.events = $events
    return $text.Replace('"events":null', ('"events":' + $evText))
}

function Save-SemAlert {
    param($Alert, [string]$HomeDir = $script:Sem.Home)
    $bytes = (New-Object Text.UTF8Encoding $false).GetBytes((ConvertTo-SemAlertText $Alert))
    Save-SemDoc -Dir (Get-SemAlertDir -HomeDir $HomeDir) -Id ([string]$Alert.id) -Bytes $bytes
}

function Test-SemAlertRed {
    param($Rule, [double]$Value)
    $limit = [double](Get-SemAlertProp $Rule 'value')
    switch ([string](Get-SemAlertProp $Rule 'op')) {
        'lt' { return ($Value -lt $limit) }
        'lte' { return ($Value -le $limit) }
        'gt' { return ($Value -gt $limit) }
        default { return ($Value -ge $limit) }
    }
}

function Update-SemAlertState {
    <#
      One check, the rules of src/core/alerts.ts stepAlert: a reading older than the last is ignored; no value
      notes the check time only; a change into red (from normal or unknown) fires 'red'; a change from red to
      normal fires 'clear' when the alert asks for it. Clears any pending note. Returns
      @{ Changed = bool; Fired = the event or $null }; the alert object is updated in place.
    #>
    param([Parameter(Mandatory = $true)]$Alert, $Value, [string]$AsOf, [string]$Source = 'page', [datetime]$Now = [datetime]::UtcNow)
    $last = [string](Get-SemAlertProp $Alert 'lastAsOf')
    if ($last -and [string]::CompareOrdinal($AsOf, $last) -lt 0) { return @{ Changed = $false; Fired = $null } }
    $at = $Now.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    if ($null -ne $Alert.PSObject.Properties['pending']) { $Alert.PSObject.Properties.Remove('pending') }
    Set-SemAlertProp $Alert 'lastChecked' $at
    $num = 0.0
    $isNum = ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal])
    if ($isNum) { $num = [double]$Value }
    if (-not $isNum -or [double]::IsNaN($num) -or [double]::IsInfinity($num)) { return @{ Changed = $true; Fired = $null } }
    $prev = [string](Get-SemAlertProp $Alert 'state')
    $next = 'normal'
    if (Test-SemAlertRed -Rule $Alert.rule -Value $num) { $next = 'red' }
    $stamp = $Now.ToUniversalTime().ToString('yyyyMMddHHmmssfff')
    $fired = $null
    if ($next -eq 'red' -and $prev -ne 'red') { $fired = [ordered]@{ id = ($stamp + '-r'); kind = 'red'; at = $at; value = $num; asOf = $AsOf; source = $Source } }
    elseif ($next -eq 'normal' -and $prev -eq 'red' -and (Get-SemAlertProp $Alert 'notifyClear') -eq $true) { $fired = [ordered]@{ id = ($stamp + '-c'); kind = 'clear'; at = $at; value = $num; asOf = $AsOf; source = $Source } }
    $Alert.state = $next
    Set-SemAlertProp $Alert 'lastValue' $num
    Set-SemAlertProp $Alert 'lastAsOf' $AsOf
    if ($null -ne $fired) {
        $events = @(@(Get-SemAlertProp $Alert 'events') | Where-Object { $null -ne $_ }) + @([pscustomobject]$fired)
        if ($events.Count -gt $script:SemAlertEventsKept) { $events = $events[($events.Count - $script:SemAlertEventsKept)..($events.Count - 1)] }
        $Alert.events = $events
        Set-SemAlertProp $Alert 'updated' $at
    }
    return @{ Changed = $true; Fired = $fired }
}

function Invoke-SemAlertCheck {
    # Applies readings [{ entryId, metric, value, asOf }] to every alert on that flag and measure; saves the changed ones.
    param([Parameter(Mandatory = $true)][string]$HomeDir, $Readings, [string]$Source = 'page', [datetime]$Now = [datetime]::UtcNow)
    if (@('page', 'refresh') -notcontains $Source) { $Source = 'page' }
    $fired = New-Object System.Collections.Generic.List[object]
    $alerts = @(Read-SemAlerts -HomeDir $HomeDir)
    foreach ($r in @($Readings | Select-Object -First 500)) {
        if ($r -isnot [Management.Automation.PSCustomObject]) { continue }
        $entry = [string](Get-SemAlertProp $r 'entryId'); $metric = [string](Get-SemAlertProp $r 'metric'); $asOf = [string](Get-SemAlertProp $r 'asOf')
        if (-not $entry -or -not $metric -or $asOf -cnotmatch '\A\d{4}-\d{2}-\d{2}T[0-9:.]+Z\z') { continue }
        foreach ($a in $alerts) {
            if ([string]$a.entryId -cne $entry -or [string]$a.metric -cne $metric) { continue }
            $res = Update-SemAlertState -Alert $a -Value (Get-SemAlertProp $r 'value') -AsOf $asOf -Source $Source -Now $Now
            if ($res.Changed) { Save-SemAlert -Alert $a -HomeDir $HomeDir }
            if ($null -ne $res.Fired) {
                $fired.Add([ordered]@{ alertId = [string]$a.id; event = $res.Fired })
                Write-SemLog 'INFO' ('Alert ' + [string]$a.id + ' fired: ' + $res.Fired.kind + ' (' + $Source + ')')
            }
        }
    }
    return @{ Fired = $fired.ToArray(); Alerts = $alerts }
}

function Set-SemAlertsPending {
    # A pipeline rebuilt the tables behind these flags: their alerts are checked at the next refresh or page open.
    param([Parameter(Mandatory = $true)][string]$HomeDir, [string[]]$EntryIds = @(), [string]$Note = '', [datetime]$Now = [datetime]::UtcNow)
    $want = @{}; foreach ($e in $EntryIds) { if ($e) { $want[$e] = $true } }
    $n = 0
    if ($want.Count -eq 0) { return 0 }
    if (-not [IO.Directory]::Exists((Join-Path $HomeDir 'alerts'))) { return 0 }
    foreach ($a in @(Read-SemAlerts -HomeDir $HomeDir)) {
        if (-not $want.ContainsKey([string]$a.entryId)) { continue }
        Set-SemAlertProp $a 'pending' ([pscustomobject][ordered]@{ note = $Note; at = $Now.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') })
        Save-SemAlert -Alert $a -HomeDir $HomeDir
        $n++
    }
    return $n
}

function Invoke-SemAlertRoute {
    param($Req, $Id, [datetime]$Now = [datetime]::UtcNow)
    $homeDir = $script:Sem.Home
    $dir = Get-SemAlertDir -HomeDir $homeDir
    if ($null -eq $Id) {
        if ($Req.Method -ne 'GET') { Send-SemError 405 'method' 'Method not allowed.'; return }
        $parts = @(Read-SemAlerts -HomeDir $homeDir | ForEach-Object { ConvertTo-SemAlertText $_ })
        Send-SemJsonText 200 ('[' + ($parts -join ',') + ']')
        return
    }
    if ($Id -eq 'check') {
        if ($Req.Method -ne 'POST') { Send-SemError 405 'method' 'Method not allowed.'; return }
        if ($Req.Json -isnot [Management.Automation.PSCustomObject]) { Send-SemError 400 'bad-json' 'The body must be a JSON object.'; return }
        $script:Sem.SyncBusy = $true
        try { $res = Invoke-SemAlertCheck -HomeDir $homeDir -Readings (Get-SemJsonProp $Req.Json 'readings') -Source ([string](Get-SemJsonProp $Req.Json 'source')) -Now $Now } finally { $script:Sem.SyncBusy = $false }
        $fired = '[' + ((@($res.Fired | ForEach-Object { ConvertTo-Json -InputObject $_ -Depth 5 -Compress })) -join ',') + ']'
        $alerts = '[' + ((@($res.Alerts | ForEach-Object { ConvertTo-SemAlertText $_ })) -join ',') + ']'
        Send-SemJsonText 200 ('{"fired":' + $fired + ',"alerts":' + $alerts + '}')
        return
    }
    if ($Id -cnotmatch '\A[A-Za-z0-9_-]{1,64}\z') { Send-SemError 400 'bad-id' 'Invalid alert id: use 1 to 64 letters, digits, _ or -.'; return }
    switch ($Req.Method) {
        'GET' {
            $text = Read-SemDoc -Dir $dir -Id $Id
            if ($null -eq $text) { Send-SemError 404 'not-found' ("No alert '$Id'."); return }
            Send-SemJsonText 200 $text.TrimStart([char]0xFEFF)
        }
        'PUT' {
            if ($null -eq $Req.Body -or $Req.Body.Length -gt $script:SemAlertMaxBytes) { Send-SemError 413 'too-large' 'An alert may be at most 256 KB.'; return }
            $j = $Req.Json
            if ($null -eq $j) { try { $j = (New-Object Text.UTF8Encoding $false).GetString($Req.Body) | ConvertFrom-Json -ErrorAction Stop } catch { $j = $null } }
            $why = Test-SemAlert $j
            if ($why) { Send-SemError 400 'invalid' $why; return }
            $count = @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File -ErrorAction SilentlyContinue).Count
            if ($count -ge $script:SemAlertMaxCount -and -not [IO.File]::Exists((Join-Path $dir ($Id + '.json')))) { Send-SemError 400 'too-many' ('At most ' + $script:SemAlertMaxCount + ' alerts are kept.'); return }
            $script:Sem.SyncBusy = $true
            try { Save-SemDoc -Dir $dir -Id $Id -Bytes $Req.Body } finally { $script:Sem.SyncBusy = $false }
            Write-SemLog 'INFO' "Saved alert $Id"
            Send-SemJson 200 ([ordered]@{ ok = $true })
        }
        'DELETE' {
            $script:Sem.SyncBusy = $true
            try { $done = Remove-SemDoc -Dir $dir -Id $Id } finally { $script:Sem.SyncBusy = $false }
            if (-not $done) { Send-SemError 404 'not-found' ("No alert '$Id'."); return }
            Write-SemLog 'INFO' "Moved alert $Id to .trash"
            Send-SemJson 200 ([ordered]@{ ok = $true })
        }
        default { Send-SemError 405 'method' 'Method not allowed.' }
    }
}
