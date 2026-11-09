# Pester 5. Spoken answers (Intelligence.ps1, as in Lazarette PR 140): the TalkForge address is loopback
# only and set on this computer, the page chooses only voice and speed, and the token goes to the
# configured TalkForge with no proxy or redirect, and never into a response or the log.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Intelligence.ps1', 'Lazarette.Client.ps1', 'Vault.ps1') { . ([IO.Path]::Combine($server, $f)) }
    $script:Token = 'tf-test-token-0123456789'

    function script:Start-FakeTalkForge {
        # Answers one request with $Status and $Body; records the request text.
        param([int]$Status = 200, [string]$ContentType = 'audio/wav', [byte[]]$Body = [byte[]](82, 73, 70, 70, 1, 2, 3, 4))
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $seen = [hashtable]::Synchronized(@{ Text = '' })
        $ps = [powershell]::Create()
        [void]$ps.AddScript({
            param($Listener, $Status, $ContentType, $Body, $Seen)
            try { $c = $Listener.AcceptTcpClient() } catch { return }
            try {
                $s = $c.GetStream(); $s.ReadTimeout = 5000
                $buf = New-Object byte[] 65536; $text = ''
                do { $n = $s.Read($buf, 0, $buf.Length); $text += [Text.Encoding]::UTF8.GetString($buf, 0, $n) } while ($n -gt 0 -and $text -notmatch "`r`n`r`n")
                if ($text -match 'Content-Length: (\d+)') {
                    $want = [int]$Matches[1]; $sofar = $text.Substring($text.IndexOf("`r`n`r`n") + 4)
                    while ([Text.Encoding]::UTF8.GetByteCount($sofar) -lt $want) { $n = $s.Read($buf, 0, $buf.Length); if ($n -le 0) { break }; $sofar += [Text.Encoding]::UTF8.GetString($buf, 0, $n) }
                    $text = $text.Substring(0, $text.IndexOf("`r`n`r`n") + 4) + $sofar
                }
                $Seen.Text = $text
                $head = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $Status X`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`n`r`n")
                $s.Write($head, 0, $head.Length); $s.Write($Body, 0, $Body.Length); $s.Flush()
            } catch { } finally { $c.Close() }
        }).AddArgument($listener).AddArgument($Status).AddArgument($ContentType).AddArgument($Body).AddArgument($seen)
        $handle = $ps.BeginInvoke()
        $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
        return @{ Listener = $listener; PS = $ps; Handle = $handle; Seen = $seen; Url = "http://127.0.0.1:$port" }
    }
    function script:Stop-FakeTalkForge {
        param($Fake)
        try { $Fake.Listener.Stop() } catch { }
        try { [void]$Fake.Handle.AsyncWaitHandle.WaitOne(3000) } catch { }
        try { $Fake.PS.BeginStop($null, $null) | Out-Null } catch { }
        try { $Fake.PS.Dispose() } catch { }
    }
    function script:Invoke-Speak {
        # Runs Invoke-SemVoiceSpeak with a captured stream; returns @{ Status; Head; Body (bytes); Text }.
        param($Json, [string]$Root)
        $raw = $Json | ConvertTo-Json -Compress
        $req = @{ Method = 'POST'; Path = '/api/voice/speak'; Body = [Text.Encoding]::UTF8.GetBytes($raw); Json = ($raw | ConvertFrom-Json) }
        $ms = New-Object IO.MemoryStream
        $script:Sem.Stream = $ms; $script:Sem.Responded = $false
        try { Invoke-SemVoiceSpeak -Req $req -Root $Root } finally { $script:Sem.Stream = $null }
        $bytes = $ms.ToArray()
        $text = [Text.Encoding]::UTF8.GetString($bytes)
        $split = $text.IndexOf("`r`n`r`n")
        $headBytes = [Text.Encoding]::UTF8.GetByteCount($text.Substring(0, $split + 4))
        $body = New-Object byte[] ($bytes.Length - $headBytes)
        [Array]::Copy($bytes, $headBytes, $body, 0, $body.Length)
        return @{ Status = [int]($text.Substring(9, 3)); Head = $text.Substring(0, $split); Body = $body; Text = [Text.Encoding]::UTF8.GetString($body) }
    }
}

Describe 'Spoken answers' {
    BeforeEach {
        $script:SavedEnv = @{}
        foreach ($n in 'SEMAPHORE_VOICE_URL', 'SEMAPHORE_VOICE_TOKEN') { $script:SavedEnv[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $null) }
        $script:Root = Join-Path $TestDrive ('voice-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path (Join-Path $script:Root 'config') -Force | Out-Null
        $script:LogLines = New-Object Collections.ArrayList
        Mock Write-SemLog { param($Level, $Message) [void]$script:LogLines.Add("$Level $Message") }
        Mock Get-SemTalkForgeLocalTokenPath { return (Join-Path $TestDrive 'no-talkforge\local-token') }
    }
    AfterEach {
        foreach ($n in $script:SavedEnv.Keys) { [Environment]::SetEnvironmentVariable($n, $script:SavedEnv[$n]) }
    }

    It 'accepts only a loopback address by number' {
        Test-SemVoiceUrl 'http://127.0.0.1:25009' | Should -Be ''
        Test-SemVoiceUrl 'http://[::1]:25009/' | Should -Be ''
        foreach ($bad in 'http://localhost:25009', 'https://127.0.0.1:25009', 'http://127.0.0.1:25009/v1', 'http://user@127.0.0.1:25009', 'http://10.0.0.5:25009', 'http://127.0.0.1:70000', '') {
            Test-SemVoiceUrl $bad | Should -Not -Be '' -Because $bad
        }
    }

    It 'reports the address and where the token comes from, never the token' {
        [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_TOKEN', $script:Token)
        $s = Get-SemVoiceStatus -Root $script:Root
        $s.url | Should -Be 'http://127.0.0.1:25009'
        $s.tokenSource | Should -Be 'environment'
        ($s | ConvertTo-Json) | Should -Not -BeLike "*$($script:Token)*"
        [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_TOKEN', $null)
        (Get-SemVoiceStatus -Root $script:Root).tokenSource | Should -Be 'lazarette'
    }

    It 'lets the page choose only text, voice and speed, within limits' {
        (Read-SemVoiceSpeakBody -Json ('{"text":"  "}' | ConvertFrom-Json)).Error | Should -Match 'characters'
        (Read-SemVoiceSpeakBody -Json (@{ text = ('x' * 4001) } | ConvertTo-Json | ConvertFrom-Json)).Error | Should -Match 'characters'
        (Read-SemVoiceSpeakBody -Json ('{"text":"Hi.","voice":"../etc"}' | ConvertFrom-Json)).Error | Should -Match 'voice'
        $ok = Read-SemVoiceSpeakBody -Json ('{"text":"Hi.","voice":"en_US-libritts-high","speed":9,"url":"http://10.0.0.1"}' | ConvertFrom-Json)
        $ok.Voice | Should -Be 'en_US-libritts-high'
        $ok.Speed | Should -Be 2
        $ok.ContainsKey('Url') | Should -BeFalse
    }

    It 'relays to TalkForge with the token and returns its audio, with nothing secret in the reply or the log' {
        $fake = Start-FakeTalkForge
        try {
            [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_URL', $fake.Url)
            [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_TOKEN', $script:Token)
            $r = Invoke-Speak -Json @{ text = 'Hello there.'; voice = 'en_US-libritts-high'; speed = 1.25 } -Root $script:Root
            $r.Status | Should -Be 200
            $r.Head | Should -Match 'Content-Type: audio/wav'
            $r.Body[0..3] | Should -Be @(82, 73, 70, 70)
            $sent = $fake.Seen.Text
            $sent | Should -Match '^POST /v1/audio/speech '
            $sent | Should -Match "Authorization: Bearer $($script:Token)"
            $sent | Should -Not -Match '(?im)^Origin:'
            $sent | Should -Match '"voice":"en_US-libritts-high"'
            $sent | Should -Match '"speed":1.25'
            $r.Head | Should -Not -Match $script:Token
            ($script:LogLines -join "`n") | Should -Not -Match 'Hello there|tf-test-token'
        } finally { Stop-FakeTalkForge $fake }
    }

    It 'says plainly when TalkForge is not running, refuses the token, or answers with something other than audio' {
        $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start(); $port = ([Net.IPEndPoint]$l.LocalEndpoint).Port; $l.Stop()
        [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_URL', "http://127.0.0.1:$port")
        [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_TOKEN', $script:Token)
        $off = Invoke-Speak -Json @{ text = 'Hi.' } -Root $script:Root
        $off.Status | Should -Be 503
        $off.Text | Should -Match 'TalkForge is not running'

        $refuse = Start-FakeTalkForge -Status 401 -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes('{"error":"bad token"}'))
        try {
            [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_URL', $refuse.Url)
            $r = Invoke-Speak -Json @{ text = 'Hi.' } -Root $script:Root
            $r.Status | Should -Be 502
            $r.Text | Should -Match 'refused the token'
        } finally { Stop-FakeTalkForge $refuse }

        $html = Start-FakeTalkForge -ContentType 'text/html' -Body ([Text.Encoding]::UTF8.GetBytes('<html></html>'))
        try {
            [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_URL', $html.Url)
            $r = Invoke-Speak -Json @{ text = 'Hi.' } -Root $script:Root
            $r.Status | Should -Be 502
            $r.Text | Should -Match 'not with audio'
        } finally { Stop-FakeTalkForge $html }
    }

    It 'refuses a misconfigured address before anything is sent' {
        [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_URL', 'http://example.com:25009')
        [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_TOKEN', $script:Token)
        $r = Invoke-Speak -Json @{ text = 'Hi.' } -Root $script:Root
        $r.Status | Should -Be 400
        $r.Text | Should -Match '127.0.0.1'
    }

    It 'asks for the Lazarette share when no token is set and Lazarette has none to give' {
        Mock Test-LazaretteToolPairing { return $true }
        Mock Get-LazaretteToolSecrets { return @{ TALKFORGE_TOKEN = $null; '__state' = @{ TALKFORGE_TOKEN = 'not-shared' } } }
        $r = Invoke-Speak -Json @{ text = 'Hi.' } -Root $script:Root
        $r.Status | Should -Be 424
        $r.Text | Should -Match 'TALKFORGE_TOKEN'
    }
}
