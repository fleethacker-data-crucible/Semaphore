# Pester 5. Briefing delivery (server/Mail.ps1). Outlook is never started here: the COM layer is replaced by a
# stand-in that records what was set and fails the test if Send is ever called. Covers a missing Outlook, COM
# blocked by policy, the draft itself (subject, body, recipients, attachment, saved not sent), the .eml file, the
# saved recipients and schedule, and the weekly tick that drafts at the set time and never sends.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Vault.ps1', 'Connectors.ps1', 'Alerts.ps1', 'Mail.ps1') { . (Join-Path $server $f) }

    $script:TestHome = Join-Path ([IO.Path]::GetTempPath()) ('sem-mail-' + [guid]::NewGuid().ToString('N'))
    $script:Sem.Port = 8800
    $script:Sem.Token = New-SemToken
    $script:Sem.Version = '0.3.0'
    $script:Sem.Home = Resolve-SemHome -Settings @{ home = $script:TestHome } -Create
    Initialize-SemPresence -AutoStop $true
    $script:RealProbe = $script:SemOutlookProbe
    $script:RealFactory = $script:SemOutlookFactory

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

    # A stand-in Outlook: CreateItem gives a mail item that records what Semaphore set on it.
    function script:Use-FakeOutlook {
        $global:SemFakeOutlook = [pscustomobject]@{ Items = (New-Object System.Collections.Generic.List[object]) }
        $script:SemOutlookProbe = { [string] }
        $script:SemOutlookFactory = {
            $app = [pscustomobject]@{ Log = $global:SemFakeOutlook }
            $app | Add-Member -MemberType ScriptMethod -Name CreateItem -Value {
                param($kind)
                $att = [pscustomobject]@{ Paths = (New-Object System.Collections.Generic.List[string]) }
                $att | Add-Member -MemberType ScriptMethod -Name Add -Value { param($p) $this.Paths.Add([string]$p); return $p }
                $item = [pscustomobject]@{ Kind = $kind; Subject = ''; HTMLBody = ''; To = ''; Attachments = $att; Saved = 0; Displayed = 0; Sent = 0 }
                $item | Add-Member -MemberType ScriptMethod -Name Save -Value { $this.Saved++ }
                $item | Add-Member -MemberType ScriptMethod -Name Display -Value { param($modal) $this.Displayed++ }
                $item | Add-Member -MemberType ScriptMethod -Name Send -Value { $this.Sent++; throw 'Send must never be called' }
                $this.Log.Items.Add($item)
                return $item
            }
            return $app
        }
    }
    function script:Restore-Outlook { $script:SemOutlookProbe = $script:RealProbe; $script:SemOutlookFactory = $script:RealFactory }
}

AfterAll {
    Restore-Outlook
    Remove-Item -LiteralPath $script:TestHome -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Finding Outlook' {
    AfterEach { Restore-Outlook }

    It 'says so when Outlook is not installed, without starting anything' {
        $script:SemOutlookProbe = { $null }
        $script:SemOutlookFactory = { throw 'the factory must not be called when Outlook is missing' }
        $t = Test-SemOutlook
        $t.available | Should -BeFalse
        $t.code | Should -Be 'outlook-missing'
        $r = New-SemOutlookDraft -Subject 's' -Html '<p>x</p>'
        $r.ok | Should -BeFalse
        $r.code | Should -Be 'outlook-missing'
        $r.error | Should -Match 'not installed'
    }

    It 'says so when Outlook is installed but COM is blocked' {
        $script:SemOutlookProbe = { [string] }
        $script:SemOutlookFactory = { throw 'Retrieving the COM class factory failed: 80070005 Access is denied.' }
        $r = New-SemOutlookDraft -Subject 's' -Html '<p>x</p>'
        $r.ok | Should -BeFalse
        $r.code | Should -Be 'outlook-blocked'
        $r.error | Should -Match 'COM may be blocked'
    }

    It 'the real probe only looks the class up (no New-Object in it)' {
        $script:RealProbe.ToString() | Should -Match 'GetTypeFromProgID'
        $script:RealProbe.ToString() | Should -Not -Match 'New-Object'
    }

    It 'reports the Outlook state on GET /api/mail' {
        $script:SemOutlookProbe = { $null }
        $j = (Send 'GET' '/api/mail').Body | ConvertFrom-Json
        $j.outlook.available | Should -BeFalse
        $j.outlook.code | Should -Be 'outlook-missing'
        $j.settings.schedule.enabled | Should -BeFalse
    }
}

Describe 'Outlook drafts (COM mocked)' {
    BeforeEach { Use-FakeOutlook }
    AfterEach { Restore-Outlook }

    It 'fills a mail item, attaches the report, saves it to Drafts and never sends it' {
        $att = Join-Path $script:TestHome 'r.html'
        [IO.File]::WriteAllText($att, '<p>report</p>')
        $r = New-SemOutlookDraft -Subject 'Leadership briefing' -Html '<h1>Hi</h1>' -To @('a@example.org', 'bad', 'b@example.org') -AttachmentPath $att
        $r.ok | Should -BeTrue
        $r.saved | Should -Be 'Drafts'
        $global:SemFakeOutlook.Items.Count | Should -Be 1
        $m = $global:SemFakeOutlook.Items[0]
        $m.Kind | Should -Be 0
        $m.Subject | Should -Be 'Leadership briefing'
        $m.HTMLBody | Should -Be '<h1>Hi</h1>'
        $m.To | Should -Be 'a@example.org; b@example.org'
        @($m.Attachments.Paths) | Should -Be @($att)
        $m.Saved | Should -Be 1
        $m.Displayed | Should -Be 0
        $m.Sent | Should -Be 0
    }

    It 'POST /api/mail/outlook-draft writes the attachment to the outbox and can open the draft' {
        $body = '{"subject":"Briefing","html":"<p>b</p>","to":["x@example.org"],"attachment":{"name":"../../evil name.html","html":"<p>shared report</p>"},"open":true}'
        $r = Send 'POST' '/api/mail/outlook-draft' $body
        $r.Status | Should -Be 200
        ($r.Body | ConvertFrom-Json).ok | Should -BeTrue
        $m = $global:SemFakeOutlook.Items[0]
        $m.Displayed | Should -Be 1
        $m.Sent | Should -Be 0
        $path = @($m.Attachments.Paths)[0]
        $path | Should -BeLike (Join-Path $script:Sem.Home 'mail\outbox\*-evil name.html')
        [IO.File]::ReadAllText($path) | Should -Be '<p>shared report</p>'
    }

    It 'refuses a draft without a subject or body' {
        (Send 'POST' '/api/mail/outlook-draft' '{"subject":"","html":"x"}').Status | Should -Be 400
        $global:SemFakeOutlook.Items.Count | Should -Be 0
    }

    It 'a COM error while filling the draft is reported, not thrown' {
        $script:SemOutlookFactory = { $a = [pscustomobject]@{}; $a | Add-Member -MemberType ScriptMethod -Name CreateItem -Value { throw 'The operation failed.' }; return $a }
        $r = New-SemOutlookDraft -Subject 's' -Html 'h'
        $r.ok | Should -BeFalse
        $r.code | Should -Be 'outlook-failed'
    }
}

Describe '.eml output' {
    It 'is an unsent draft with a text and an HTML part and the report attached' {
        $eml = ConvertTo-SemEml -To @('a@example.org', 'A@example.org', 'nope') -Subject 'Caf' -Html '<p>Hi</p>' -Text 'Hi' -AttachmentName 'briefing.html' -AttachmentHtml '<p>report</p>' -Date ([datetime]'2026-11-09T08:00:00Z').ToUniversalTime() -Boundary 'b1'
        $lines = $eml -split "`r`n"
        $lines[0] | Should -Be 'To: a@example.org'
        $lines | Should -Contain 'X-Unsent: 1'
        $lines | Should -Contain 'Date: Mon, 09 Nov 2026 08:00:00 +0000'
        $lines | Should -Contain 'Content-Type: multipart/mixed; boundary="b1-mixed"'
        $lines | Should -Contain 'Content-Disposition: attachment; filename="briefing.html"'
        @($lines | Where-Object { $_ -match '^From:' }).Count | Should -Be 0
        $eml | Should -Match ([regex]::Escape([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('<p>report</p>'))))
        $eml.TrimEnd() | Should -Match '--b1-mixed--$'
        @($lines | Where-Object { $_.Length -gt 998 }).Count | Should -Be 0
    }

    It 'encodes a subject that is not plain ASCII' {
        $s = ConvertTo-SemMailHeader ('Caf' + [char]0xE9)
        $s | Should -Match '^=\?UTF-8\?B\?'
        [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s.Substring(10, $s.Length - 12))) | Should -Be ('Caf' + [char]0xE9)
    }
}

Describe 'Saved recipients and the weekly schedule' {
    BeforeEach {
        Remove-Item -LiteralPath (Join-Path $script:Sem.Home 'mail') -Recurse -Force -ErrorAction SilentlyContinue
        Use-FakeOutlook
    }
    AfterEach { Restore-Outlook }

    It 'keeps this person''s recipients and schedule; the schedule is off until turned on' {
        (Read-SemMailSettings).schedule.enabled | Should -BeFalse
        $r = Send 'PUT' '/api/mail/settings' '{"recipients":["cdr@example.org","junk","cdr@example.org"],"schedule":{"enabled":true,"weekday":1,"time":"07:30"}}'
        $r.Status | Should -Be 200
        $s = Read-SemMailSettings
        @($s.recipients) | Should -Be @('cdr@example.org')
        $s.schedule.enabled | Should -BeTrue
        $s.schedule.time | Should -Be '07:30'
        $j = (Send 'GET' '/api/mail').Body | ConvertFrom-Json
        @($j.settings.recipients) | Should -Be @('cdr@example.org')
        (Send 'PUT' '/api/mail/settings' '{"recipients":[],"schedule":{"enabled":true,"weekday":9,"time":"07:30"}}').Status | Should -Be 400
        (Send 'PUT' '/api/mail/settings' '{"recipients":[],"schedule":{"enabled":true,"weekday":1,"time":"7am"}}').Status | Should -Be 400
    }

    It 'at the set time drafts the latest briefing in Outlook once, never sent, and not again until next week' {
        [void](Send 'PUT' '/api/mail/settings' '{"recipients":["cdr@example.org"],"schedule":{"enabled":true,"weekday":1,"time":"07:30"}}')
        (Send 'PUT' '/api/mail/briefing' '{"subject":"Leadership briefing","html":"<p>b</p>","text":"b","attachment":{"name":"briefing.html","html":"<p>r</p>"}}').Status | Should -Be 200
        $monday = [datetime]'2026-11-09T07:00:00'   # a Monday, local time
        Invoke-SemMailTick -HomeDir $script:Sem.Home -Now $monday | Should -BeNullOrEmpty   # before 07:30
        $line = Invoke-SemMailTick -HomeDir $script:Sem.Home -Now $monday.AddMinutes(45)
        $line | Should -Match 'not sent'
        $global:SemFakeOutlook.Items.Count | Should -Be 1
        $global:SemFakeOutlook.Items[0].Sent | Should -Be 0
        $global:SemFakeOutlook.Items[0].Saved | Should -Be 1
        $global:SemFakeOutlook.Items[0].To | Should -Be 'cdr@example.org'
        @($global:SemFakeOutlook.Items[0].Attachments.Paths).Count | Should -Be 1
        Invoke-SemMailTick -HomeDir $script:Sem.Home -Now $monday.AddHours(3) | Should -BeNullOrEmpty
        $global:SemFakeOutlook.Items.Count | Should -Be 1
        [void](Invoke-SemMailTick -HomeDir $script:Sem.Home -Now $monday.AddDays(7).AddMinutes(45))
        $global:SemFakeOutlook.Items.Count | Should -Be 2
    }

    It 'without Outlook, writes an .eml to the outbox instead and says so' {
        $script:SemOutlookProbe = { $null }
        [void](Send 'PUT' '/api/mail/settings' '{"recipients":["cdr@example.org"],"schedule":{"enabled":true,"weekday":1,"time":"07:30"}}')
        [void](Send 'PUT' '/api/mail/briefing' '{"subject":"Leadership briefing","html":"<p>b</p>","text":"b","attachment":{"name":"briefing.html","html":"<p>r</p>"}}')
        $line = Invoke-SemMailTick -HomeDir $script:Sem.Home -Now ([datetime]'2026-11-09T08:00:00')
        $line | Should -Match 'not installed'
        $line | Should -Match 'Saved as an email file'
        $eml = @(Get-ChildItem (Join-Path $script:Sem.Home 'mail\outbox') -Filter '*.eml')
        $eml.Count | Should -Be 1
        [IO.File]::ReadAllText($eml[0].FullName) | Should -Match 'X-Unsent: 1'
    }

    It 'does nothing when the schedule is off, or a day after the time has passed' {
        [void](Send 'PUT' '/api/mail/settings' '{"recipients":["cdr@example.org"],"schedule":{"enabled":false,"weekday":1,"time":"07:30"}}')
        [void](Send 'PUT' '/api/mail/briefing' '{"subject":"s","html":"<p>b</p>"}')
        Invoke-SemMailTick -HomeDir $script:Sem.Home -Now ([datetime]'2026-11-09T08:00:00') | Should -BeNullOrEmpty
        [void](Send 'PUT' '/api/mail/settings' '{"recipients":["cdr@example.org"],"schedule":{"enabled":true,"weekday":1,"time":"07:30"}}')
        Invoke-SemMailTick -HomeDir $script:Sem.Home -Now ([datetime]'2026-11-11T08:00:00') | Should -BeNullOrEmpty
        $global:SemFakeOutlook.Items.Count | Should -Be 0
    }
}
