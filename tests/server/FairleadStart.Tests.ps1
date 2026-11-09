# Pester 5. Starting Fairlead when drafting or the assistant needs it, as TalkForge is started for speech:
# finding the Fairlead folder, the settings switch, exactly what would run (Windows PowerShell running
# Fairlead's own start script, hidden, through the shell, nothing secret on the command line), never starting
# twice, and a request that finds Fairlead down waiting for it instead of failing.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Intelligence.ps1', 'Lazarette.Client.ps1', 'Vault.ps1', 'Connectors.ps1') { . ([IO.Path]::Combine($server, $f)) }

    function script:New-SemRoot {
        # A Semaphore folder (config\) inside a parent; returns the root.
        $parent = Join-Path $TestDrive ('p-' + [guid]::NewGuid().ToString('N'))
        $root = Join-Path $parent 'Semaphore'
        [void][IO.Directory]::CreateDirectory((Join-Path $root 'config'))
        return $root
    }
    function script:New-FakeFairlead {
        # A folder with scripts\Start-Fairlead.ps1 that only records that it ran, and its arguments.
        param([string]$Dir)
        [void][IO.Directory]::CreateDirectory((Join-Path $Dir 'scripts'))
        [IO.File]::WriteAllText((Join-Path $Dir 'scripts\Start-Fairlead.ps1'), "[IO.File]::WriteAllText((Join-Path `$PSScriptRoot 'ran.txt'), (`$args -join ' '))")
        return $Dir
    }
    function script:Set-SemSettingsFile {
        param([string]$Root, [hashtable]$Settings)
        [IO.File]::WriteAllText((Join-Path $Root 'config\settings.json'), ($Settings | ConvertTo-Json -Depth 5))
    }
    function script:Get-FreePort {
        $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start(); $p = ([Net.IPEndPoint]$l.LocalEndpoint).Port; $l.Stop(); return $p
    }
}

Describe 'Finding Fairlead' {
    BeforeEach { $env:SEMAPHORE_FAIRLEAD_FOLDER = $null; $script:SemFairlead.StartedAt = [datetime]::MinValue; $script:SemFairlead.Message = '' }
    AfterEach { $env:SEMAPHORE_FAIRLEAD_FOLDER = $null }

    It 'finds a Fairlead folder next to the Semaphore folder' {
        $root = New-SemRoot
        $fl = New-FakeFairlead (Join-Path (Split-Path -Parent $root) 'Fairlead')
        (Get-SemFairleadSettings -Root $root).Folder | Should -Be $fl
    }

    It 'uses a configured folder only, and refuses a relative one' {
        $root = New-SemRoot
        [void](New-FakeFairlead (Join-Path (Split-Path -Parent $root) 'Fairlead'))
        $mine = New-FakeFairlead (Join-Path $TestDrive ('elsewhere-' + [guid]::NewGuid().ToString('N')))
        Set-SemSettingsFile $root @{ fairlead = @{ folder = $mine } }
        (Get-SemFairleadSettings -Root $root).Folder | Should -Be $mine
        Set-SemSettingsFile $root @{ fairlead = @{ folder = '..\Fairlead' } }
        $s = Get-SemFairleadSettings -Root $root
        $s.Folder | Should -Be ''
        $s.FolderProblem | Should -Match 'full path'
    }

    It 'takes the folder of a pinned fairleadPath' {
        $root = New-SemRoot
        $fl = New-FakeFairlead (Join-Path $TestDrive ('pinned-' + [guid]::NewGuid().ToString('N')))
        Set-SemSettingsFile $root @{ fairleadPath = (Join-Path $fl 'scripts\Start-Fairlead.ps1') }
        (Get-SemFairleadSettings -Root $root).Folder | Should -Be $fl
    }

    It 'SEMAPHORE_FAIRLEAD_FOLDER wins over settings, and autoStart is on unless turned off' {
        $root = New-SemRoot
        $env:SEMAPHORE_FAIRLEAD_FOLDER = (New-FakeFairlead (Join-Path $TestDrive ('env-' + [guid]::NewGuid().ToString('N'))))
        Set-SemSettingsFile $root @{ fairlead = @{ folder = 'C:\nowhere\Fairlead' } }
        $s = Get-SemFairleadSettings -Root $root
        $s.Folder | Should -Be $env:SEMAPHORE_FAIRLEAD_FOLDER
        $s.FolderSource | Should -Be 'environment'
        $s.AutoStart | Should -BeTrue
        Set-SemSettingsFile $root @{ fairlead = @{ autoStart = $false } }
        (Get-SemFairleadSettings -Root $root).AutoStart | Should -BeFalse
    }
}

Describe 'Starting Fairlead' {
    BeforeEach { $script:SemFairlead.StartedAt = [datetime]::MinValue; $script:SemFairlead.Message = '' }

    It 'runs Fairlead''s own start script hidden, through the shell, without the browser and with nothing secret' {
        $si = New-SemFairleadStartInfo -Folder 'C:\Tools\Fairlead'
        $si.FileName | Should -Match '\\WindowsPowerShell\\v1\.0\\powershell\.exe$'
        $si.Arguments | Should -Be '-STA -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Tools\Fairlead\scripts\Start-Fairlead.ps1" --no-browser'
        $si.UseShellExecute | Should -BeTrue
        $si.WindowStyle | Should -Be ([Diagnostics.ProcessWindowStyle]::Hidden)
        $si.WorkingDirectory | Should -Be 'C:\Tools\Fairlead'
    }

    It 'does nothing when something already listens on Fairlead''s port' {
        $port = Get-FreePort
        $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port); $l.Start()
        try {
            $r = Start-SemFairlead -Root (New-SemRoot) -Settings @{ Url = "http://127.0.0.1:$port/v1" }
            $r.State | Should -Be 'running'
        } finally { $l.Stop() }
    }

    It 'says why when starting it is off or Fairlead is not found, and never starts on another address' {
        $root = New-SemRoot
        Set-SemSettingsFile $root @{ fairlead = @{ autoStart = $false } }
        $port = Get-FreePort
        (Start-SemFairlead -Root $root -Settings @{ Url = "http://127.0.0.1:$port/v1" }).Message | Should -Match 'fairlead\.autoStart'
        Set-SemSettingsFile $root @{ fairlead = @{ autoStart = $true } }
        (Start-SemFairlead -Root $root -Settings @{ Url = "http://127.0.0.1:$port/v1" }).Message | Should -Match 'port 8776'
    }

    It 'starts the found Fairlead once, and a second ask within a minute only says it is starting' -Skip:(Test-SemFairleadListening -Url 'http://127.0.0.1:8776/v1') {
        $root = New-SemRoot
        $fl = New-FakeFairlead (Join-Path (Split-Path -Parent $root) 'Fairlead')
        $s = @{ Url = 'http://127.0.0.1:8776/v1' }
        (Start-SemFairlead -Root $root -Settings $s).State | Should -Be 'starting'
        $ran = Join-Path $fl 'scripts\ran.txt'
        for ($i = 0; $i -lt 100 -and -not (Test-Path -LiteralPath $ran); $i++) { Start-Sleep -Milliseconds 100 }
        Get-Content -LiteralPath $ran -Raw | Should -Be '--no-browser'
        Remove-Item -LiteralPath $ran
        (Start-SemFairlead -Root $root -Settings $s).State | Should -Be 'starting'
        Start-Sleep -Milliseconds 1500
        Test-Path -LiteralPath $ran | Should -BeFalse
    }
}

Describe 'A request that finds Fairlead down' {
    It 'starts Fairlead and waits until it is verified' {
        $script:calls = 0
        Mock Start-SemFairlead { @{ State = 'starting'; Message = 'Fairlead is starting.' } }
        Mock Test-SemAiIdentity { $script:calls++; if ($script:calls -lt 3) { @{ Code = 'ai-down'; Error = 'down' } } else { $null } }
        $r = Wait-SemFairleadIdentity -Settings @{ Url = 'http://127.0.0.1:8776/v1' } -Root (New-SemRoot) -Seconds 10
        $r | Should -BeNullOrEmpty
        Should -Invoke Start-SemFairlead -Times 1 -Exactly
    }

    It 'returns the reason when Fairlead cannot be started, without waiting' {
        Mock Start-SemFairlead { @{ State = 'unavailable'; Message = 'Fairlead was not found.' } }
        Mock Test-SemAiIdentity { throw 'not reached' }
        $r = Wait-SemFairleadIdentity -Settings @{ Url = 'http://127.0.0.1:8776/v1' } -Root (New-SemRoot) -Seconds 10
        $r.Code | Should -Be 'ai-down'
        $r.Error | Should -Be 'Fairlead was not found.'
    }

    It 'gives up after the wait with a sentence that says where to look' {
        Mock Start-SemFairlead { @{ State = 'starting'; Message = '' } }
        Mock Test-SemAiIdentity { @{ Code = 'ai-down'; Error = 'down' } }
        $r = Wait-SemFairleadIdentity -Settings @{ Url = 'http://127.0.0.1:8776/v1' } -Root (New-SemRoot) -Seconds 1
        $r.Error | Should -Match 'did not answer .* within 1 s'
    }
}
