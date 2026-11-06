# Pester 5. AI drafting through Fairlead: settings, the DPAPI key file, the forwarder against a fake
# Fairlead on loopback, the port owner check (#65, with a stub PID lookup) and the /api/ai routes. The key must never reach a response, the status or a message.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    . ([IO.Path]::Combine($server, 'Common.ps1'))
    . ([IO.Path]::Combine($server, 'Http.ps1'))
    . ([IO.Path]::Combine($server, 'Routes.ps1'))
    . ([IO.Path]::Combine($server, 'Intelligence.ps1'))

    $script:Key = 'fl-test0123456789abcdef'
    $script:EnvNames = @('SEMAPHORE_AI_URL', 'SEMAPHORE_AI_MODEL', 'SEMAPHORE_AI_PRIVACY', 'SEMAPHORE_AI_KEY')

    function script:Start-FakeFairlead {
        # Answers each request with the next canned reply; records what it received.
        param([object[]]$Replies)
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $seen = [hashtable]::Synchronized(@{ Requests = (New-Object Collections.ArrayList) })
        $ps = [powershell]::Create()
        [void]$ps.AddScript({
            param($Listener, $Replies, $Seen)
            foreach ($reply in $Replies) {
                $c = $Listener.AcceptTcpClient()
                try {
                    $s = $c.GetStream(); $s.ReadTimeout = 5000
                    $buf = New-Object byte[] 65536; $text = ''
                    do { $n = $s.Read($buf, 0, $buf.Length); $text += [Text.Encoding]::UTF8.GetString($buf, 0, $n) } while ($n -gt 0 -and $text -notmatch "`r`n`r`n")
                    if ($text -match 'Content-Length: (\d+)') {
                        $want = [int]$Matches[1]; $body = $text.Substring($text.IndexOf("`r`n`r`n") + 4)
                        while ([Text.Encoding]::UTF8.GetByteCount($body) -lt $want) { $n = $s.Read($buf, 0, $buf.Length); if ($n -le 0) { break }; $body += [Text.Encoding]::UTF8.GetString($buf, 0, $n); $text += [Text.Encoding]::UTF8.GetString($buf, 0, $n) }
                    }
                    [void]$Seen.Requests.Add($text)
                    if ($reply.Delay) { Start-Sleep -Milliseconds $reply.Delay }
                    $bytes = [Text.Encoding]::UTF8.GetBytes($reply.Body)
                    $head = "HTTP/1.1 $($reply.Status) X`r`nContent-Type: application/json`r`nContent-Length: $($bytes.Length)`r`n"
                    if ($reply.Target) { $head += "X-Fairlead-Target: $($reply.Target)`r`n" }
                    $head = [Text.Encoding]::ASCII.GetBytes($head + "Connection: close`r`n`r`n")
                    $s.Write($head, 0, $head.Length); $s.Write($bytes, 0, $bytes.Length); $s.Flush()
                } catch { } finally { $c.Close() }
            }
        }).AddArgument($listener).AddArgument($Replies).AddArgument($seen)
        $handle = $ps.BeginInvoke()
        $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
        return @{ Listener = $listener; PS = $ps; Handle = $handle; Seen = $seen; Url = "http://127.0.0.1:$port/v1" }
    }
    function script:Stop-FakeFairlead {
        param($Fake)
        # Close the listener first: a fake still waiting in AcceptTcpClient (a reply that was never
        # asked for) is released by it, and PowerShell.Stop() would otherwise wait for it forever.
        try { $Fake.Listener.Stop() } catch { }
        try { [void]$Fake.Handle.AsyncWaitHandle.WaitOne(3000) } catch { }
        try { $Fake.PS.BeginStop($null, $null) | Out-Null } catch { }
        try { $Fake.PS.Dispose() } catch { }
    }
    function script:New-Settings {
        param([string]$Url, [string]$Model = 'local', [bool]$PrivacyLocal = $true)
        return @{ Url = $Url; Model = $Model; PrivacyLocal = $PrivacyLocal; Key = $script:Key; KeySource = 'environment'; Problem = $null }
    }
    function script:Invoke-Route {
        # Runs Invoke-SemAiRequest with a captured stream; returns @{ Status; Head; Body }.
        param([string]$Path, $Json, [string]$Root)
        $raw = if ($null -eq $Json) { '' } else { $Json | ConvertTo-Json -Depth 8 -Compress }
        $req = @{ Method = 'POST'; Path = $Path; Body = [Text.Encoding]::UTF8.GetBytes($raw); Json = $(if ($raw) { $raw | ConvertFrom-Json } else { $null }) }
        $ms = New-Object IO.MemoryStream
        $script:Sem.Stream = $ms
        try { Invoke-SemAiRequest -Req $req -Root $Root } finally { $script:Sem.Stream = $null }
        $text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
        $split = $text.IndexOf("`r`n`r`n")
        return @{ Status = [int]($text.Substring(9, 3)); Head = $text.Substring(0, $split); Body = $text.Substring($split + 4) }
    }
}

Describe 'Semaphore intelligence' {
BeforeEach {
    Mock Read-SemAiCredential { return $null }
    # The port owner check is a stub here: the fake Fairlead "is" PID 4168 unless a test says otherwise.
    Mock Initialize-SemAiPortCheck { return $null }
    Mock Get-SemAiListenerPids { return 4168 }
    Clear-SemAiIdentityCache
    $script:Saved = @{}
    foreach ($n in $script:EnvNames) { $script:Saved[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $null) }
    $script:Root = Join-Path ([IO.Path]::GetTempPath()) ('sem-ai-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory((Join-Path $script:Root 'config'))
    $script:KeyFile = Join-Path $script:Root 'fairlead-key.dat'
    $script:SemLogPath = Join-Path $script:Root 'test.log'
}
AfterEach {
    foreach ($n in $script:EnvNames) { [Environment]::SetEnvironmentVariable($n, $script:Saved[$n]) }
    Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue
}

Context 'Settings' {
    It 'defaults to Fairlead on loopback, the local route, privacy on and no key' {
        $s = Get-SemAiSettings -Root $script:Root -KeyPath $script:KeyFile
        $s.Url | Should -Be 'http://127.0.0.1:8776/v1'
        $s.Model | Should -Be 'local'
        $s.PrivacyLocal | Should -BeTrue
        $s.Key | Should -BeNullOrEmpty
        $s.KeySource | Should -Be 'none'
        $s.Problem | Should -BeNullOrEmpty
    }

    It 'reads overrides from config\semaphore.env' {
        [IO.File]::WriteAllLines((Join-Path $script:Root 'config\semaphore.env'), @('SEMAPHORE_AI_URL=http://localhost:9999/v1/', 'SEMAPHORE_AI_MODEL=fast', 'SEMAPHORE_AI_PRIVACY=off', "SEMAPHORE_AI_KEY=$($script:Key)"))
        $s = Get-SemAiSettings -Root $script:Root -KeyPath $script:KeyFile
        $s.Url | Should -Be 'http://localhost:9999/v1'
        $s.Model | Should -Be 'fast'
        $s.PrivacyLocal | Should -BeFalse
        $s.KeySource | Should -Be 'environment'
    }

    It 'refuses an AI address that is not on this machine: <Url>' -TestCases @(
        @{ Url = 'https://api.example.com/v1' }, @{ Url = 'http://192.168.1.20:8776/v1' }, @{ Url = 'http://user:pw@127.0.0.1:8776/v1' }, @{ Url = 'ftp://127.0.0.1/v1' }, @{ Url = 'not a url' }
    ) {
        $env:SEMAPHORE_AI_URL = $Url
        (Get-SemAiSettings -Root $script:Root -KeyPath $script:KeyFile).Problem | Should -Not -BeNullOrEmpty
    }

    It 'replaces an unsafe model name with the local route' {
        $env:SEMAPHORE_AI_MODEL = 'local; rm -rf'
        (Get-SemAiSettings -Root $script:Root -KeyPath $script:KeyFile).Model | Should -Be 'local'
    }

    It 'checks the key shape: <Key> -> <Ok>' -TestCases @(
        @{ Key = 'fl-abcdefgh12'; Ok = $true }, @{ Key = 'sk-abcdefgh12'; Ok = $false }, @{ Key = 'fl-short'; Ok = $false }, @{ Key = "fl-abcdefgh12`n"; Ok = $false }, @{ Key = ''; Ok = $false }
    ) {
        Test-SemAiKeyShape $Key | Should -Be $Ok
    }

    It 'never puts the key in the status' {
        $env:SEMAPHORE_AI_KEY = $script:Key
        $status = Get-SemAiStatus -Settings (Get-SemAiSettings -Root $script:Root -KeyPath $script:KeyFile)
        $status.configured | Should -BeTrue
        ($status | ConvertTo-Json -Compress) | Should -Not -Match ([regex]::Escape($script:Key))
    }

    It 'scrubs the key from provider text and caps its length' {
        $t = Get-SemAiSafeText ("bad key $($script:Key)`r`n" + ('x' * 500)) $script:Key
        $t | Should -Not -Match ([regex]::Escape($script:Key))
        $t | Should -Match '\[key\]'
        $t.Length | Should -BeLessOrEqual 303
    }
}

Context 'Key file (DPAPI)' -Skip:($env:OS -ne 'Windows_NT') {
    It 'round-trips the key without storing it in clear text' {
        $secure = ConvertTo-SecureString $script:Key -AsPlainText -Force
        Save-SemAiKeyFile -Key $secure -Path $script:KeyFile
        [IO.File]::ReadAllText($script:KeyFile) | Should -Not -Match 'fl-'
        Read-SemAiKeyFile -Path $script:KeyFile | Should -Be $script:Key
        $s = Get-SemAiSettings -Root $script:Root -KeyPath $script:KeyFile
        $s.KeySource | Should -Be 'file'
        $s.Key | Should -Be $script:Key
    }

    It 'refuses to store something that is not a Fairlead client key' {
        { Save-SemAiKeyFile -Key (ConvertTo-SecureString 'sk-not-a-fairlead-key' -AsPlainText -Force) -Path $script:KeyFile } | Should -Throw -ExpectedMessage '*Fairlead client key*'
        [IO.File]::Exists($script:KeyFile) | Should -BeFalse
    }

    It 'treats an unreadable file as no key' {
        [IO.File]::WriteAllText($script:KeyFile, 'not dpapi')
        Read-SemAiKeyFile -Path $script:KeyFile | Should -BeNullOrEmpty
    }
}

Context 'Windows Credential Manager selection' {
    It 'round-trips a synthetic credential under a unique test target' -Skip:($env:OS -ne 'Windows_NT') {
        $target = 'Fairlead/Semaphore-test-' + [guid]::NewGuid().ToString('N')
        try {
            Save-SemAiCredential -Key (ConvertTo-SecureString $script:Key -AsPlainText -Force) -Target $target
            [SemaphoreAiCredential]::Read($target) | Should -Be $script:Key
        } finally { Remove-SemAiCredential -Target $target }
        [SemaphoreAiCredential]::Read($target) | Should -BeNullOrEmpty
    }
    It 'uses the app credential by default without exposing it in status' {
        Mock Read-SemAiCredential { return $script:Key }
        $s = Get-SemAiSettings -Root $script:Root
        $s.KeySource | Should -Be 'credential-manager'
        $s.Key | Should -Be $script:Key
        (Get-SemAiStatus -Settings $s | ConvertTo-Json) | Should -Not -Match ([regex]::Escape($script:Key))
    }
    It 'keeps the environment override ahead of Credential Manager' {
        $env:SEMAPHORE_AI_KEY = $script:Key
        $s = Get-SemAiSettings -Root $script:Root
        $s.KeySource | Should -Be 'environment'
        Should -Invoke Read-SemAiCredential -Times 0 -Exactly
    }
    It 'does not read a user credential for an explicit isolated key-file path' {
        Get-SemAiSettings -Root $script:Root -KeyPath $script:KeyFile | Out-Null
        Should -Invoke Read-SemAiCredential -Times 0 -Exactly
    }
    It 'falls back to the legacy key file when Credential Manager cannot be read' {
        Mock Read-SemAiCredential { throw 'Add-Type was refused' }
        Mock Get-SemAiKeyPath { return $script:KeyFile }
        Save-SemAiKeyFile -Key (ConvertTo-SecureString $script:Key -AsPlainText -Force) -Path $script:KeyFile
        $s = Get-SemAiSettings -Root $script:Root
        $s.Key | Should -Be $script:Key
        $s.KeySource | Should -Be 'file'
        $s.Problem | Should -BeNullOrEmpty
    }
    It 'says why when Credential Manager cannot be read and there is no key file' {
        Mock Read-SemAiCredential { throw 'Add-Type was refused' }
        Mock Get-SemAiKeyPath { return $script:KeyFile }
        $s = Get-SemAiSettings -Root $script:Root
        $s.Key | Should -BeNullOrEmpty
        $s.KeySource | Should -Be 'none'
        $s.Problem | Should -Match 'Credential Manager'
    }
    It 'rejects malformed input before touching the Windows store' {
        { Save-SemAiCredential -Key (ConvertTo-SecureString 'invalid' -AsPlainText -Force) } | Should -Throw '*Fairlead client key*'
    }
}

Context 'Forwarding to Fairlead' {
    It 'sends the key, the privacy header and the body, and returns the answer and target' {
        $fake = Start-FakeFairlead -Replies @(@{ Status = 200; Body = '{"ok":1}'; Target = 'ollama/qwen3.8' })
        try {
            $body = [Text.Encoding]::UTF8.GetBytes('{"model":"local","messages":[]}')
            $r = Invoke-SemAiForward -Settings (New-Settings -Url $fake.Url) -Method POST -RelPath '/chat/completions' -Body $body -TimeoutSec 10
            $r.Status | Should -Be 200
            [Text.Encoding]::UTF8.GetString($r.Bytes) | Should -Be '{"ok":1}'
            $r.Target | Should -Be 'ollama/qwen3.8'
            $sent = [string]$fake.Seen.Requests[0]
            $sent | Should -Match '^POST /v1/chat/completions HTTP/1\.1'
            $sent | Should -Match ('Authorization: Bearer ' + [regex]::Escape($script:Key))
            $sent | Should -Match 'X-Fairlead-Privacy: local'
            $sent | Should -Match '"model":"local"'
        } finally { Stop-FakeFairlead $fake }
    }

    It 'leaves the privacy header out when privacy is off' {
        $fake = Start-FakeFairlead -Replies @(@{ Status = 200; Body = '{"data":[]}' })
        try {
            $null = Invoke-SemAiForward -Settings (New-Settings -Url $fake.Url -PrivacyLocal $false) -Method GET -RelPath '/models' -TimeoutSec 10
            [string]$fake.Seen.Requests[0] | Should -Not -Match 'X-Fairlead-Privacy'
        } finally { Stop-FakeFairlead $fake }
    }

    It 'returns error answers with their status instead of throwing' {
        $fake = Start-FakeFairlead -Replies @(@{ Status = 401; Body = '{"error":{"message":"bad"}}' })
        try {
            $r = Invoke-SemAiForward -Settings (New-Settings -Url $fake.Url) -Method GET -RelPath '/models' -TimeoutSec 10
            $r.Status | Should -Be 401
            Get-SemAiErrorText $r.Bytes $script:Key | Should -Be 'bad'
        } finally { Stop-FakeFairlead $fake }
    }

    It 'reports Fairlead not running' {
        $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start(); $port = ([Net.IPEndPoint]$l.LocalEndpoint).Port; $l.Stop()
        $r = Invoke-SemAiForward -Settings (New-Settings -Url "http://127.0.0.1:$port/v1") -Method GET -RelPath '/models' -TimeoutSec 5
        $r.Status | Should -Be 0
        $r.Code | Should -Be 'ai-down'
        $r.Error | Should -Match 'Launch-Fairlead'
    }

    It 'gives up when Fairlead is too slow' {
        $fake = Start-FakeFairlead -Replies @(@{ Status = 200; Body = '{}'; Delay = 3000 })
        try {
            $r = Invoke-SemAiForward -Settings (New-Settings -Url $fake.Url) -Method GET -RelPath '/models' -TimeoutSec 1
            $r.Status | Should -Be 0
            $r.Code | Should -Be 'ai-timeout'
        } finally { Stop-FakeFairlead $fake }
    }
}

Context 'Port owner check (the key goes only to the process that holds the port)' {
    BeforeAll {
        $script:Chat = @{ model = 'local'; messages = @(@{ role = 'user'; content = 'hi' }) }
    }

    It 'does not send the key when the id answer names another PID than the port owner' {
        Mock Get-SemAiListenerPids { return 999 }
        $fake = Start-FakeFairlead -Replies @(@{ Status = 200; Body = '{"tool":"fairlead","version":"0.1.0","pid":4168}' }, @{ Status = 200; Body = '{}' })
        try {
            $env:SEMAPHORE_AI_URL = $fake.Url; $env:SEMAPHORE_AI_KEY = $script:Key
            $r = Invoke-Route -Path '/api/ai/v1/chat/completions' -Json $script:Chat -Root $script:Root
            $r.Status | Should -Be 502
            $j = $r.Body | ConvertFrom-Json
            $j.code | Should -Be 'ai-not-fairlead'
            $j.error | Should -Match '^Something other than Fairlead is answering on port \d+; the key was not sent\.$'
            $fake.Seen.Requests.Count | Should -Be 1
            [string]$fake.Seen.Requests[0] | Should -Match '^GET /__fleethacker/id '
            [string]$fake.Seen.Requests[0] | Should -Not -Match ([regex]::Escape($script:Key))
        } finally { Stop-FakeFairlead $fake }
    }

    It 'does not send the key when the id answer has no PID' {
        $fake = Start-FakeFairlead -Replies @(@{ Status = 200; Body = '{"tool":"fairlead","version":"0.1.0"}' }, @{ Status = 200; Body = '{}' })
        try {
            $env:SEMAPHORE_AI_URL = $fake.Url; $env:SEMAPHORE_AI_KEY = $script:Key
            $r = Invoke-Route -Path '/api/ai/v1/chat/completions' -Json $script:Chat -Root $script:Root
            $r.Status | Should -Be 502
            ($r.Body | ConvertFrom-Json).error | Should -Match 'the key was not sent'
            $fake.Seen.Requests.Count | Should -Be 1
        } finally { Stop-FakeFairlead $fake }
    }

    It 'asks nothing and sends nothing when two processes listen on the port' {
        Mock Get-SemAiListenerPids { return @(4168, 5000) }
        $fake = Start-FakeFairlead -Replies @(@{ Status = 200; Body = '{"tool":"fairlead","pid":4168}' })
        try {
            $env:SEMAPHORE_AI_URL = $fake.Url; $env:SEMAPHORE_AI_KEY = $script:Key
            $r = Invoke-Route -Path '/api/ai/v1/chat/completions' -Json $script:Chat -Root $script:Root
            $r.Status | Should -Be 502
            ($r.Body | ConvertFrom-Json).error | Should -Match 'Something other than Fairlead'
            $fake.Seen.Requests.Count | Should -Be 0
        } finally { Stop-FakeFairlead $fake }
    }

    It 'reports Fairlead not running when nothing listens on the port' {
        Mock Get-SemAiListenerPids { return @() }
        $env:SEMAPHORE_AI_URL = 'http://127.0.0.1:9/v1'; $env:SEMAPHORE_AI_KEY = $script:Key
        $r = Invoke-Route -Path '/api/ai/v1/chat/completions' -Json $script:Chat -Root $script:Root
        $r.Status | Should -Be 503
        ($r.Body | ConvertFrom-Json).code | Should -Be 'ai-down'
    }

    It 'fails closed when the TCP table cannot be read' {
        Mock Get-SemAiListenerPids { throw 'GetExtendedTcpTable failed' }
        $env:SEMAPHORE_AI_URL = 'http://127.0.0.1:9/v1'; $env:SEMAPHORE_AI_KEY = $script:Key
        $r = Invoke-Route -Path '/api/ai/v1/chat/completions' -Json $script:Chat -Root $script:Root
        $r.Status | Should -Be 503
        $j = $r.Body | ConvertFrom-Json
        $j.code | Should -Be 'ai-port-check'
        $j.error | Should -Match 'was not sent'
    }

    It 'fails closed, and says so in the AI status, when Add-Type is refused' {
        $why = 'Windows did not let Semaphore compile its port check (Add-Type was refused), so the key is not sent.'
        Mock Initialize-SemAiPortCheck { return $why }
        $env:SEMAPHORE_AI_URL = 'http://127.0.0.1:9/v1'; $env:SEMAPHORE_AI_KEY = $script:Key
        $r = Invoke-Route -Path '/api/ai/check' -Json @{} -Root $script:Root
        $j = $r.Body | ConvertFrom-Json
        $j.ok | Should -BeFalse
        $j.code | Should -Be 'ai-port-check'
        $j.detail | Should -Be $why
        Should -Invoke Get-SemAiListenerPids -Times 0 -Exactly
        $status = Get-SemAiStatus -Settings (Get-SemAiSettings -Root $script:Root -KeyPath $script:KeyFile)
        $status.configured | Should -BeFalse
        $status.problem | Should -Be $why
    }

    It 'does not run the port check for the status when no key is stored' {
        Mock Initialize-SemAiPortCheck { return 'unused' }
        $status = Get-SemAiStatus -Settings (Get-SemAiSettings -Root $script:Root -KeyPath $script:KeyFile)
        $status.problem | Should -BeNullOrEmpty
        Should -Invoke Initialize-SemAiPortCheck -Times 0 -Exactly
    }

    It 'remembers a verified Fairlead process and asks again when the listener changes' {
        # This test process stands in for Fairlead: its PID has a readable start time, so it is cached.
        Mock Get-SemAiListenerPids { return $PID }
        $id = @{ Status = 200; Body = ('{"tool":"fairlead","version":"0.1.0","pid":' + $PID + '}') }
        $answer = @{ Status = 200; Body = '{"choices":[]}' }
        $fake = Start-FakeFairlead -Replies @($id, $answer, $answer, $id, $answer)
        try {
            $env:SEMAPHORE_AI_URL = $fake.Url; $env:SEMAPHORE_AI_KEY = $script:Key
            (Invoke-Route -Path '/api/ai/v1/chat/completions' -Json $script:Chat -Root $script:Root).Status | Should -Be 200
            (Invoke-Route -Path '/api/ai/v1/chat/completions' -Json $script:Chat -Root $script:Root).Status | Should -Be 200
            $fake.Seen.Requests.Count | Should -Be 3
            [string]$fake.Seen.Requests[2] | Should -Match '^POST /v1/chat/completions '
            # Another process now holds the port: the cache does not apply, and it fails the PID check.
            Mock Get-SemAiListenerPids { return 4168 }
            (Invoke-Route -Path '/api/ai/v1/chat/completions' -Json $script:Chat -Root $script:Root).Status | Should -Be 502
            $fake.Seen.Requests.Count | Should -Be 4
            [string]$fake.Seen.Requests[3] | Should -Match '^GET /__fleethacker/id '
        } finally { Stop-FakeFairlead $fake }
    }
}

Context '/api/ai routes' {
    BeforeAll {
        # Every route asks /__fleethacker/id first (port authority); a real Fairlead answers like this.
        $script:Id = @{ Status = 200; Body = '{"tool":"fairlead","version":"0.1.0","pid":4168}' }
    }

    It 'answers 409 with setup steps when no key is stored' {
        # The real key file of this machine (if any) must not count: look in an empty folder instead.
        $saved = $env:LOCALAPPDATA
        $env:LOCALAPPDATA = $script:Root
        try {
            $r = Invoke-Route -Path '/api/ai/check' -Json @{} -Root $script:Root
            $r.Status | Should -Be 409
            $r.Body | Should -Match 'Set-SemaphoreAiKey'
        } finally { $env:LOCALAPPDATA = $saved }
    }

    It 'passes a draft request through and adds the target, without the key anywhere' {
        $answer = '{"choices":[{"message":{"content":"{\"kind\":\"bar\"}"}}]}'
        $fake = Start-FakeFairlead -Replies @($script:Id, @{ Status = 200; Body = $answer; Target = 'ollama/qwen3.8' })
        try {
            $env:SEMAPHORE_AI_URL = $fake.Url; $env:SEMAPHORE_AI_KEY = $script:Key
            $r = Invoke-Route -Path '/api/ai/v1/chat/completions' -Json @{ model = 'local'; messages = @(@{ role = 'user'; content = 'hi' }) } -Root $script:Root
            $r.Status | Should -Be 200
            $r.Body | Should -Be $answer
            $r.Head | Should -Match 'X-Fairlead-Target: ollama/qwen3\.8'
            ($r.Head + $r.Body) | Should -Not -Match ([regex]::Escape($script:Key))
            [string]$fake.Seen.Requests[0] | Should -Match '^GET /__fleethacker/id '
            [string]$fake.Seen.Requests[0] | Should -Not -Match 'Authorization'
        } finally { Stop-FakeFairlead $fake }
    }

    It 'never sends the key to a port that is not Fairlead: <Why>' -TestCases @(
        @{ Why = 'another tool'; Reply = @{ Status = 200; Body = '{"tool":"semaphore","version":"0.3.0","pid":1}' } },
        @{ Why = 'no id endpoint'; Reply = @{ Status = 404; Body = '{"error":"not found"}' } },
        @{ Why = 'not JSON'; Reply = @{ Status = 200; Body = 'hello' } }
    ) {
        $fake = Start-FakeFairlead -Replies @($Reply, @{ Status = 200; Body = '{}' })
        try {
            $env:SEMAPHORE_AI_URL = $fake.Url; $env:SEMAPHORE_AI_KEY = $script:Key
            $r = Invoke-Route -Path '/api/ai/v1/chat/completions' -Json @{ model = 'local'; messages = @(@{ role = 'user'; content = 'hi' }) } -Root $script:Root
            $r.Status | Should -Be 502
            ($r.Body | ConvertFrom-Json).code | Should -Be 'ai-not-fairlead'
            ($r.Body | ConvertFrom-Json).error | Should -Match 'not sent'
            $fake.Seen.Requests.Count | Should -Be 1
            [string]$fake.Seen.Requests[0] | Should -Not -Match ([regex]::Escape($script:Key))
        } finally { Stop-FakeFairlead $fake }
    }

    It 'reports a check against a port that is not Fairlead without sending the key' {
        $fake = Start-FakeFairlead -Replies @(@{ Status = 200; Body = '{"tool":"eight-bells","version":"2.0.0","pid":1}' })
        try {
            $env:SEMAPHORE_AI_URL = $fake.Url; $env:SEMAPHORE_AI_KEY = $script:Key
            $j = (Invoke-Route -Path '/api/ai/check' -Json @{} -Root $script:Root).Body | ConvertFrom-Json
            $j.ok | Should -BeFalse
            $j.detail | Should -Match '"eight-bells", not Fairlead'
            $fake.Seen.Requests.Count | Should -Be 1
        } finally { Stop-FakeFairlead $fake }
    }

    It 'refuses a request for another model before calling Fairlead' {
        $env:SEMAPHORE_AI_URL = 'http://127.0.0.1:9/v1'; $env:SEMAPHORE_AI_KEY = $script:Key
        $r = Invoke-Route -Path '/api/ai/v1/chat/completions' -Json @{ model = 'smart'; messages = @(@{ role = 'user'; content = 'hi' }) } -Root $script:Root
        $r.Status | Should -Be 400
        $r.Body | Should -Match 'configured model'
    }

    It 'refuses streaming and empty message lists' -TestCases @(
        @{ J = @{ model = 'local'; messages = @(); } }, @{ J = @{ model = 'local'; stream = $true; messages = @(@{ role = 'user'; content = 'x' }) } }
    ) {
        $env:SEMAPHORE_AI_URL = 'http://127.0.0.1:9/v1'; $env:SEMAPHORE_AI_KEY = $script:Key
        (Invoke-Route -Path '/api/ai/v1/chat/completions' -Json $J -Root $script:Root).Status | Should -Be 400
    }

    It 'turns a refused key into setup advice' {
        $fake = Start-FakeFairlead -Replies @($script:Id, @{ Status = 401; Body = ('{"error":{"message":"Missing key ' + $script:Key + '"}}') })
        try {
            $env:SEMAPHORE_AI_URL = $fake.Url; $env:SEMAPHORE_AI_KEY = $script:Key
            $r = Invoke-Route -Path '/api/ai/v1/chat/completions' -Json @{ model = 'local'; messages = @(@{ role = 'user'; content = 'hi' }) } -Root $script:Root
            $r.Status | Should -Be 502
            ($r.Body | ConvertFrom-Json).error | Should -Match 'Fairlead > Clients'
            $r.Body | Should -Not -Match ([regex]::Escape($script:Key))
        } finally { Stop-FakeFairlead $fake }
    }

    It 'checks the key and lists the models' {
        $fake = Start-FakeFairlead -Replies @($script:Id, @{ Status = 200; Body = '{"data":[{"id":"local"},{"id":"auto"}]}' })
        try {
            $env:SEMAPHORE_AI_URL = $fake.Url; $env:SEMAPHORE_AI_KEY = $script:Key
            $r = Invoke-Route -Path '/api/ai/check' -Json @{} -Root $script:Root
            $r.Status | Should -Be 200
            $j = $r.Body | ConvertFrom-Json
            $j.ok | Should -BeTrue
            @($j.models) -join ',' | Should -Be 'local,auto'
        } finally { Stop-FakeFairlead $fake }
    }
}
}

Describe 'Port owner lookup on Windows (GetExtendedTcpTable)' -Skip:($env:OS -ne 'Windows_NT') {
    It 'compiles and finds this process as the owner of a loopback listener' {
        Initialize-SemAiPortCheck | Should -BeNullOrEmpty
        $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        $l.Start()
        try {
            $port = ([Net.IPEndPoint]$l.LocalEndpoint).Port
            @(Get-SemAiListenerPids -Port $port) | Should -Be @($PID)
        } finally { $l.Stop() }
        @(Get-SemAiListenerPids -Port $port) | Should -BeNullOrEmpty
    }
}
