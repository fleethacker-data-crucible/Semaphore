# Pester 5. Lifecycle rules without a browser: loopback-only listener, presence and auto-stop,
# busy flag, runtime files and stopping instances without knowing PIDs.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    . ([IO.Path]::Combine($server, 'Common.ps1'))
    . ([IO.Path]::Combine($server, 'Http.ps1'))
    . ([IO.Path]::Combine($server, 'Routes.ps1'))
    . ([IO.Path]::Combine($server, 'Query.ps1'))
    $script:T0 = [datetime]'2026-10-26T12:00:00'
}

Describe 'Worker deadlines' {
    BeforeAll {
        function script:New-SocketPair {
            # A connected pair on loopback: Server stands in for a request's client in the worker list, Peer is the browser.
            $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start()
            $peer = New-Object Net.Sockets.TcpClient
            $peer.Connect([Net.IPAddress]::Loopback, ([Net.IPEndPoint]$l.LocalEndpoint).Port)
            $srv = $l.AcceptTcpClient(); $l.Stop()
            return @{ Server = $srv; Peer = $peer }
        }
        function script:Read-PeerText([Net.Sockets.TcpClient]$Peer) {
            $s = $Peer.GetStream(); $s.ReadTimeout = 3000
            $ms = New-Object IO.MemoryStream; $buf = New-Object byte[] 4096
            try { while (($n = $s.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n) } } catch { }
            return [Text.Encoding]::UTF8.GetString($ms.ToArray())
        }
    }
    BeforeEach {
        $script:SemLogPath = Join-Path $TestDrive ('wk-' + [guid]::NewGuid().ToString('N') + '.log')
        Initialize-SemWorkers -Size 2
    }
    AfterEach { Close-SemWorkers; $script:Sem.Workers = $null }

    It 'takes the deadline from the query plan plus a margin, else 300 s' {
        Get-SemWorkerDeadlineSec @{ Path = '/api/query'; Json = ([pscustomobject]@{ timeoutSec = 45 }) } | Should -Be 105
        Get-SemWorkerDeadlineSec @{ Path = '/api/query'; Json = $null } | Should -Be 120
        Get-SemWorkerDeadlineSec @{ Path = '/api/query'; Json = ([pscustomobject]@{ timeoutSec = 9999 }) } | Should -Be 360
        Get-SemWorkerDeadlineSec @{ Path = '/api/profile'; Json = $null } | Should -Be 300
        Get-SemWorkerDeadlineSec @{ Path = '/api/ai/v1/chat/completions'; Json = $null } | Should -Be 300
    }

    It 'answers 504, asks the pipeline to stop and stops counting a worker past its deadline' {
        $pair = New-SocketPair
        $ps = [powershell]::Create(); $ps.RunspacePool = $script:Sem.Pool
        [void]$ps.AddScript({ Start-Sleep -Seconds 60 })
        $item = @{ PS = $ps; Handle = $ps.BeginInvoke(); Path = '/api/query'; Client = $pair.Server; Clock = [Diagnostics.Stopwatch]::StartNew(); DeadlineSec = 0; TimedOut = $false }
        $script:Sem.Workers.Add($item)
        Test-SemBusy | Should -BeTrue
        Start-Sleep -Milliseconds 50
        Update-SemWorkers
        $item.TimedOut | Should -BeTrue
        Test-SemBusy | Should -BeFalse -Because 'a worker given up on must not keep the server alive'
        Get-SemActiveWorkerCount | Should -Be 0
        $text = Read-PeerText $pair.Peer
        $text | Should -Match '^HTTP/1\.1 504 Gateway Timeout'
        $text | Should -Match '"code":"timeout"'
        $text | Should -Match 'given up'
        [IO.File]::ReadAllText($script:SemLogPath) | Should -Match 'gave up after'
        # The pipeline was asked to stop; Start-Sleep obeys, so it is reaped on a later tick.
        $sw = [Diagnostics.Stopwatch]::StartNew()
        while ($script:Sem.Workers.Count -gt 0 -and $sw.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 50; Update-SemWorkers }
        $script:Sem.Workers.Count | Should -Be 0
        $pair.Peer.Close()
    }

    It 'leaves a worker inside its deadline alone' {
        $ps = [powershell]::Create(); $ps.RunspacePool = $script:Sem.Pool
        [void]$ps.AddScript({ Start-Sleep -Milliseconds 300 })
        $item = @{ PS = $ps; Handle = $ps.BeginInvoke(); Path = '/api/profile'; Client = $null; Clock = [Diagnostics.Stopwatch]::StartNew(); DeadlineSec = 300; TimedOut = $false }
        $script:Sem.Workers.Add($item)
        Update-SemWorkers
        $item.TimedOut | Should -BeFalse
        Test-SemBusy | Should -BeTrue
        $sw = [Diagnostics.Stopwatch]::StartNew()
        while ($script:Sem.Workers.Count -gt 0 -and $sw.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 50; Update-SemWorkers }
        $script:Sem.Workers.Count | Should -Be 0
    }

    It 'closes the pool within its bounded wait even with a worker still running' {
        $ps = [powershell]::Create(); $ps.RunspacePool = $script:Sem.Pool
        [void]$ps.AddScript({ Start-Sleep -Seconds 60 })
        $script:Sem.Workers.Add(@{ PS = $ps; Handle = $ps.BeginInvoke(); Path = '/api/query'; Client = $null; Clock = [Diagnostics.Stopwatch]::StartNew(); DeadlineSec = 300; TimedOut = $false })
        $sw = [Diagnostics.Stopwatch]::StartNew()
        Close-SemWorkers -WaitMs 2000
        $sw.ElapsedMilliseconds | Should -BeLessThan 6000
        $script:Sem.Pool | Should -BeNullOrEmpty
        $script:Sem.Workers.Count | Should -Be 0
    }
}

Describe 'Listener' {
    It 'binds 127.0.0.1 only' {
        $l = New-SemListener -Port 0
        try {
            $ep = [Net.IPEndPoint]$l.LocalEndpoint
            [Net.IPAddress]::IsLoopback($ep.Address) | Should -BeTrue
            $ep.Address.ToString() | Should -Be '127.0.0.1'
        } finally { $l.Stop() }
    }

    It 'refuses to bind <A>' -TestCases @(@{ A = '0.0.0.0' }, @{ A = '::' }, @{ A = '192.168.1.10' }) {
        { New-SemListener -Port 0 -Address $A } | Should -Throw -ExpectedMessage '*Bind rule*'
    }
}

Describe 'Presence and auto-stop' {
    BeforeEach {
        $script:Sem.SyncBusy = $false
        $script:Sem.Workers = $null
        Initialize-SemPresence -AutoStop $true -TimeoutSec 20 -GraceSec 5 -FirstSec 120 -Now $script:T0
    }

    It 'keeps running while heartbeats arrive and stops 20 s after the last one' {
        Register-SemPresence -Tab 'a' -Now $script:T0
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(19) | Should -BeFalse
        Register-SemPresence -Tab 'a' -Now $script:T0.AddSeconds(15)
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(34) | Should -BeFalse
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(35) | Should -BeTrue
    }

    It 'defaults to 90 s after the last heartbeat and keeps the 5 s leaving grace' {
        # Edge and Chrome wake a hidden tab's timers about once a minute: 90 s survives that (#80).
        (Get-SemDefaultSettings).heartbeatTimeoutSec | Should -Be 90
        (Get-SemDefaultSettings).leavingGraceSec | Should -Be 5
        Initialize-SemPresence -AutoStop $true -Now $script:T0
        Register-SemPresence -Tab 'a' -Now $script:T0
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(65) | Should -BeFalse
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(89) | Should -BeFalse
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(90) | Should -BeTrue
        Register-SemPresence -Tab 'a' -Now $script:T0.AddSeconds(100)
        Register-SemPresence -Tab 'a' -Leaving $true -Now $script:T0.AddSeconds(101)
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(106) | Should -BeTrue
    }

    It 'stops 5 s after a leaving signal with no new heartbeat' {
        Register-SemPresence -Tab 'a' -Now $script:T0
        Register-SemPresence -Tab 'a' -Leaving $true -Now $script:T0.AddSeconds(1)
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(5) | Should -BeFalse
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(6) | Should -BeTrue
    }

    It 'survives a reload: the new page heartbeats inside the grace period' {
        Register-SemPresence -Tab 'a' -Now $script:T0
        Register-SemPresence -Tab 'a' -Leaving $true -Now $script:T0.AddSeconds(1)
        Register-SemPresence -Tab 'b' -Now $script:T0.AddSeconds(2)
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(10) | Should -BeFalse
        Get-SemLiveTabCount -Now $script:T0.AddSeconds(10) | Should -Be 1
    }

    It 'keeps running while another tab is alive' {
        Register-SemPresence -Tab 'a' -Now $script:T0
        Register-SemPresence -Tab 'b' -Now $script:T0
        Register-SemPresence -Tab 'a' -Leaving $true -Now $script:T0.AddSeconds(1)
        Register-SemPresence -Tab 'b' -Now $script:T0.AddSeconds(10)
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(20) | Should -BeFalse
    }

    It 'never stops while a query or save is running, then stops on the next tick' {
        Register-SemPresence -Tab 'a' -Now $script:T0
        $script:Sem.SyncBusy = $true
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(60) | Should -BeFalse
        $script:Sem.SyncBusy = $false
        $script:Sem.Workers = New-Object System.Collections.Generic.List[object]
        $script:Sem.Workers.Add(@{ Path = '/api/query' })
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(60) | Should -BeFalse
        $script:Sem.Workers.Clear()
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(60) | Should -BeTrue
    }

    It 'counts silence from the end of a slow request, not from before it' {
        Register-SemPresence -Tab 'a' -Now $script:T0
        Register-SemBusyEnd -Now $script:T0.AddSeconds(30)
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(40) | Should -BeFalse
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(50) | Should -BeTrue
    }

    It 'stops when no tab ever connected within the first-heartbeat window' {
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(119) | Should -BeFalse
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(120) | Should -BeTrue
    }

    It 'never auto-stops with --stay or SEMAPHORE_AUTO_STOP=0' {
        Initialize-SemPresence -AutoStop $false -Now $script:T0
        Register-SemPresence -Tab 'a' -Leaving $true -Now $script:T0
        Test-SemShouldAutoStop -Now $script:T0.AddHours(5) | Should -BeFalse
    }

    It 'ignores a leaving signal from a tab it never saw' {
        Register-SemPresence -Tab 'a' -Now $script:T0
        Register-SemPresence -Tab 'zz' -Leaving $true -Now $script:T0.AddSeconds(1)
        Test-SemShouldAutoStop -Now $script:T0.AddSeconds(10) | Should -BeFalse
    }
}

Describe 'Runtime files and Stop-Semaphore' {
    BeforeAll {
        $script:FakeRoot = Join-Path ([IO.Path]::GetTempPath()) ('sem-root-' + [guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory((Join-Path $script:FakeRoot 'logs'))
    }
    AfterAll { Remove-Item -LiteralPath $script:FakeRoot -Recurse -Force -ErrorAction SilentlyContinue }

    It 'writes the runtime file without the token and removes it' {
        $script:Sem.Port = 8800; $script:Sem.Version = '0.2.0'; $script:Sem.Token = New-SemToken; $script:Sem.ScriptPath = 'x'
        $f = Write-SemRuntimeFile -Root $script:FakeRoot
        $f | Should -Match ('semaphore-server-' + $PID + '\.json$')
        $text = [IO.File]::ReadAllText($f)
        $text | Should -Not -Match ([regex]::Escape($script:Sem.Token))
        $j = $text | ConvertFrom-Json
        $j.pid | Should -Be $PID
        $j.port | Should -Be 8800
        $j.url | Should -Be 'http://127.0.0.1:8800/'
        Remove-SemRuntimeFile
        Test-Path -LiteralPath $f | Should -BeFalse
    }

    It 'deletes a stale runtime file whose process is gone' {
        $stale = [IO.Path]::Combine($script:FakeRoot, 'logs', 'semaphore-server-999999.json')
        [IO.File]::WriteAllText($stale, '{"pid":999999,"port":8800,"url":"http://127.0.0.1:8800/","startedAt":"2026-01-01T00:00:00Z"}')
        @(Get-SemInstances -Root $script:FakeRoot | Where-Object { $_.File }).Count | Should -Be 0
        Test-Path -LiteralPath $stale | Should -BeFalse
    }

    It 'finds and stops a running instance from its runtime file, without a PID from the caller' {
        $exe = (Get-Process -Id $PID).Path
        $sp = @{ FilePath = $exe; ArgumentList = @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 60'); PassThru = $true }
        if (Test-SemIsWindows) { $sp.WindowStyle = 'Hidden' }
        $p = Start-Process @sp
        try {
            Start-Sleep -Milliseconds 300
            $file = [IO.Path]::Combine($script:FakeRoot, 'logs', ('semaphore-server-{0}.json' -f $p.Id))
            $started = (Get-Date).ToUniversalTime().AddSeconds(1).ToString('o')
            [IO.File]::WriteAllText($file, ('{{"pid":{0},"port":0,"url":"","startedAt":"{1}"}}' -f $p.Id, $started))
            $found = @(Get-SemInstances -Root $script:FakeRoot | Where-Object { $_.Pid -eq $p.Id })
            $found.Count | Should -Be 1
            $stopped = @(Stop-SemInstances -Root $script:FakeRoot)
            @($stopped | Where-Object { $_.Pid -eq $p.Id }).Count | Should -Be 1
            $p.WaitForExit(5000) | Should -BeTrue
            Test-Path -LiteralPath $file | Should -BeFalse
        } finally { if (-not $p.HasExited) { $p.Kill() } }
    }

    It 'compares versions' {
        Compare-SemVersion '0.2.0' '0.2.0' | Should -Be 0
        Compare-SemVersion '0.10.0' '0.9.9' | Should -Be 1
        Compare-SemVersion 'v0.1.0' '0.2.0' | Should -Be -1
        Compare-SemVersion 'abc' '0.2.0' | Should -BeNullOrEmpty
    }
}
