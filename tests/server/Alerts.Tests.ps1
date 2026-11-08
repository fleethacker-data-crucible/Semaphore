# Pester 5. Alerts (server/Alerts.ps1): stored one file per alert in the home folder through /api/alerts, kept
# across restarts; /api/alerts/check applies the same rules as src/core/alerts.ts stepAlert (fires once per change
# into red, optionally once back to normal, older readings ignored); a pipeline's Publish step marks the alerts on
# the flags it made out of date as pending with a note. Requests are dispatched in memory.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Vault.ps1', 'Connectors.ps1', 'LocalDb.ps1', 'LocalScript.ps1', 'Pipeline.ps1', 'Alerts.ps1', 'Mail.ps1') { . (Join-Path $server $f) }

    $script:TestHome = Join-Path ([IO.Path]::GetTempPath()) ('sem-alerts-' + [guid]::NewGuid().ToString('N'))
    $script:Sem.Port = 8800
    $script:Sem.Token = New-SemToken
    $script:Sem.Version = '0.3.0'
    $script:Sem.Home = Resolve-SemHome -Settings @{ home = $script:TestHome } -Create
    Initialize-SemPresence -AutoStop $true

    function script:Send([string]$Method = 'GET', [string]$Path, [string]$Body = '') {
        $h = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        $h['Host'] = '127.0.0.1:8800'
        $h['X-Semaphore-Session'] = $script:Sem.Token
        if ($Body) { $h['Content-Type'] = 'application/json' }
        $bytes = (New-Object Text.UTF8Encoding $false).GetBytes($Body)
        $req = @{ Method = $Method; Path = $Path; Query = ''; Headers = $h; ContentLength = $bytes.Length; Body = $bytes; Json = $null; RemoteAddress = [Net.IPAddress]::Loopback; Client = $null }
        $ms = New-Object IO.MemoryStream
        $script:Sem.Stream = $ms
        Invoke-SemRequest -Req $req
        $script:Sem.Stream = $null
        $text = (New-Object Text.UTF8Encoding $false).GetString($ms.ToArray())
        $split = $text.IndexOf("`r`n`r`n")
        [pscustomobject]@{ Status = [int]($text.Substring(0, $split).Split(' ')[1]); Body = $text.Substring($split + 4) }
    }
    function script:AlertJson([string]$Id, [string]$State = 'normal', [bool]$Clear = $false, [string]$Entry = 'fleet--kpi-cost') {
        return ('{"version":1,"kind":"alert","id":"' + $Id + '","entryId":"' + $Entry + '","title":"Labor cost","metric":"labor_cost","metricLabel":"Labor cost","rule":{"metric":"labor_cost","op":"gt","value":5000000,"tone":"bad"},"who":"lee","notifyClear":' + $Clear.ToString().ToLowerInvariant() + ',"speak":false,"brief":true,"state":"' + $State + '","lastAsOf":"2026-11-08T08:00:00.000Z","events":[],"created":"2026-11-08T08:00:00.000Z","updated":"2026-11-08T08:00:00.000Z"}')
    }
    function script:Check([string]$Value, [string]$AsOf, [string]$Source = 'refresh', [string]$Entry = 'fleet--kpi-cost') {
        $r = Send 'POST' '/api/alerts/check' ('{"source":"' + $Source + '","readings":[{"entryId":"' + $Entry + '","metric":"labor_cost","value":' + $Value + ',"asOf":"' + $AsOf + '"}]}')
        $r.Status | Should -Be 200
        return ($r.Body | ConvertFrom-Json)
    }
    function script:Stored([string]$Id) { return ([IO.File]::ReadAllText((Join-Path $script:Sem.Home ('alerts\' + $Id + '.json'))) | ConvertFrom-Json) }
}

AfterAll {
    Remove-Item -LiteralPath $script:TestHome -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Alert storage routes' {
    It 'saves an alert in the home folder, lists it, reads it back and moves it to .trash on delete' {
        (Send 'PUT' '/api/alerts/alert-a1' (AlertJson 'alert-a1')).Status | Should -Be 200
        [IO.File]::Exists((Join-Path $script:Sem.Home 'alerts\alert-a1.json')) | Should -BeTrue
        $list = @((Send 'GET' '/api/alerts').Body | ConvertFrom-Json | ForEach-Object { $_ })
        $list.Count | Should -Be 1
        $list[0].id | Should -Be 'alert-a1'
        $list[0].events.GetType().IsArray | Should -BeTrue
        ((Send 'GET' '/api/alerts/alert-a1').Body | ConvertFrom-Json).rule.value | Should -Be 5000000
        (Send 'DELETE' '/api/alerts/alert-a1').Status | Should -Be 200
        (Send 'GET' '/api/alerts/alert-a1').Status | Should -Be 404
        @(Get-ChildItem (Join-Path $script:Sem.Home 'alerts\.trash') -Filter 'alert-a1-*.json').Count | Should -Be 1
    }

    It 'refuses an alert without a red rule, a bad id or the wrong method' {
        $bad = (AlertJson 'alert-b1').Replace('"op":"gt"', '"op":"between"')
        $r = Send 'PUT' '/api/alerts/alert-b1' $bad
        $r.Status | Should -Be 400
        ($r.Body | ConvertFrom-Json).error | Should -Match 'lt, lte, gt or gte'
        (Send 'PUT' '/api/alerts/bad.id' (AlertJson 'x')).Status | Should -Be 400
        (Send 'POST' '/api/alerts').Status | Should -Be 405
        (Send 'GET' '/api/alerts/check').Status | Should -Be 405
    }

    It 'keeps alerts across a restart: they are files, read again by a new process' {
        (Send 'PUT' '/api/alerts/alert-keep' (AlertJson 'alert-keep')).Status | Should -Be 200
        $again = @(Read-SemAlerts -HomeDir $script:Sem.Home | Where-Object { $_.id -eq 'alert-keep' })
        $again.Count | Should -Be 1
        $again[0].who | Should -Be 'lee'
        [void](Send 'DELETE' '/api/alerts/alert-keep')
    }
}

Describe 'Server-side alert evaluation' {
    BeforeEach {
        Get-ChildItem (Join-Path $script:Sem.Home 'alerts') -Filter '*.json' -File -ErrorAction SilentlyContinue | Remove-Item -Force
    }

    It 'fires once on the change into red, records time, value and as-of, and not again while red' {
        [void](Send 'PUT' '/api/alerts/alert-c1' (AlertJson 'alert-c1'))
        $r = Check '4000000' '2026-11-08T09:00:00.000Z'
        @($r.fired).Count | Should -Be 0
        $r = Check '12348641' '2026-11-08T10:00:00.000Z'
        @($r.fired).Count | Should -Be 1
        $r.fired[0].alertId | Should -Be 'alert-c1'
        $r.fired[0].event.kind | Should -Be 'red'
        $r.fired[0].event.value | Should -Be 12348641
        $r.fired[0].event.asOf | Should -Be '2026-11-08T10:00:00.000Z'
        $r.fired[0].event.source | Should -Be 'refresh'
        $r.fired[0].event.at | Should -Match '^\d{4}-\d{2}-\d{2}T'
        $s = Stored 'alert-c1'
        $s.state | Should -Be 'red'
        @($s.events).Count | Should -Be 1
        $r = Check '13000000' '2026-11-08T11:00:00.000Z' 'page'
        @($r.fired).Count | Should -Be 0
        @((Stored 'alert-c1').events).Count | Should -Be 1
    }

    It 'fires back to normal only when the alert asks for it' {
        [void](Send 'PUT' '/api/alerts/alert-c2' (AlertJson 'alert-c2' 'red' $true))
        [void](Send 'PUT' '/api/alerts/alert-c3' (AlertJson 'alert-c3' 'red' $false))
        $r = Check '1000' '2026-11-08T12:00:00.000Z'
        @($r.fired).Count | Should -Be 1
        $r.fired[0].alertId | Should -Be 'alert-c2'
        $r.fired[0].event.kind | Should -Be 'clear'
        (Stored 'alert-c3').state | Should -Be 'normal'
    }

    It 'ignores a reading older than the last one, and a reading without a value changes nothing but the check time' {
        [void](Send 'PUT' '/api/alerts/alert-c4' (AlertJson 'alert-c4'))
        $r = Check '9000000' '2026-11-08T07:00:00.000Z'
        @($r.fired).Count | Should -Be 0
        (Stored 'alert-c4').state | Should -Be 'normal'
        $r = Check 'null' '2026-11-08T09:00:00.000Z'
        @($r.fired).Count | Should -Be 0
        $s = Stored 'alert-c4'
        $s.state | Should -Be 'normal'
        $s.lastChecked | Should -Not -BeNullOrEmpty
    }

    It 'an alert made without a reading fires on its first red reading' {
        [void](Send 'PUT' '/api/alerts/alert-c5' ((AlertJson 'alert-c5' 'unknown').Replace(',"lastAsOf":"2026-11-08T08:00:00.000Z"', '')))
        $r = Check '6000000' '2026-11-08T09:00:00.000Z'
        @($r.fired).Count | Should -Be 1
    }

    It 'keeps at most 50 firings' {
        [void](Send 'PUT' '/api/alerts/alert-c6' (AlertJson 'alert-c6' 'normal' $true))
        $a = Stored 'alert-c6'
        $t0 = [datetime]'2026-11-09T00:00:00Z'
        for ($i = 0; $i -lt 60; $i++) {
            $v = 1000; if ($i % 2 -eq 0) { $v = 9000000 }
            [void](Update-SemAlertState -Alert $a -Value ([double]$v) -AsOf ($t0.AddMinutes($i).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) -Now $t0.AddMinutes($i))
        }
        @($a.events).Count | Should -Be 50
    }

    It 'a pipeline Publish marks the alerts on the snapshots it made out of date as pending, with a note' {
        [void](Send 'PUT' '/api/alerts/alert-p1' (AlertJson 'alert-p1' 'normal' $false 'fleet--local-cost'))
        [void](Send 'PUT' '/api/alerts/alert-p2' (AlertJson 'alert-p2' 'normal' $false 'fleet--other'))
        $snaps = Join-Path $script:Sem.Home 'snapshots'
        [void][IO.Directory]::CreateDirectory($snaps)
        [IO.File]::WriteAllText((Join-Path $snaps 'fleet--local-cost.json'), '{"version":1,"id":"fleet--local-cost","title":"Local cost","entryId":"fleet--local-cost","asOf":"2026-11-08T08:00:00.000Z","plan":{"source":"local","table":"work_orders","joins":[]},"rows":[]}')
        $marked = Invoke-SemPipelinePublish -HomeDir $script:Sem.Home -Tables @('work_orders')
        $marked | Should -Contain 'Local cost'
        $p = Stored 'alert-p1'
        $p.pending.note | Should -Match 'rebuilt the tables'
        $p.pending.note | Should -Match 'next refreshed'
        (Stored 'alert-p2').PSObject.Properties['pending'] | Should -BeNullOrEmpty
        # The next check clears the note.
        $r = Send 'POST' '/api/alerts/check' '{"source":"page","readings":[{"entryId":"fleet--local-cost","metric":"labor_cost","value":1,"asOf":"2026-11-08T09:00:00.000Z"}]}'
        $r.Status | Should -Be 200
        (Stored 'alert-p1').PSObject.Properties['pending'] | Should -BeNullOrEmpty
    }
}
