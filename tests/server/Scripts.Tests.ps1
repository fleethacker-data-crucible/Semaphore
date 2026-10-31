# Pester 5. Static checks on the server scripts: they parse, are ASCII, use no PowerShell 7-only
# syntax, and the launcher, version, settings and port block are in place. Runs on Windows
# PowerShell 5.1 and pwsh.
BeforeAll {
    $script:Root = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..'))
    $script:Server = [IO.Path]::Combine($script:Root, 'server')
    $script:Scripts = @(
        Get-ChildItem -LiteralPath $script:Server -File
        Get-ChildItem -LiteralPath $PSScriptRoot -File
    ) | Where-Object { @('.ps1', '.psm1', '.psd1') -contains $_.Extension.ToLowerInvariant() }
    . ([IO.Path]::Combine($script:Server, 'Common.ps1'))
}

Describe 'Server scripts' {
    It 'finds the server scripts' {
        $names = @($script:Scripts | ForEach-Object { $_.Name })
        foreach ($n in @('Start-Semaphore.ps1', 'Stop-Semaphore.ps1', 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Intelligence.ps1', 'Lake.ps1', 'Set-SemaphoreAiKey.ps1', 'FleetPort.psm1', 'FleetPorts.psd1')) {
            $names | Should -Contain $n
        }
    }

    It 'every script parses' {
        $errors = @()
        foreach ($f in $script:Scripts) {
            $tokens = $null; $errs = $null
            [void][Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
            foreach ($e in @($errs)) { $errors += ('{0}:{1} {2}' -f $f.Name, $e.Extent.StartLineNumber, $e.Message) }
        }
        $errors | Should -BeNullOrEmpty
    }

    It 'every script is ASCII only' {
        $bad = @()
        foreach ($f in $script:Scripts) {
            foreach ($b in [IO.File]::ReadAllBytes($f.FullName)) { if ($b -gt 127) { $bad += $f.Name; break } }
        }
        $bad | Should -BeNullOrEmpty
    }

    It 'uses no PowerShell 7-only syntax or commands' {
        $ps7Tokens = @('QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot', 'QuestionLBracket', 'AndAnd', 'OrOr', 'QuestionMark')
        $found = @()
        foreach ($f in $script:Scripts) {
            $tokens = $null; $errs = $null
            $ast = [Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
            foreach ($t in $tokens) { if ($ps7Tokens -contains [string]$t.Kind) { $found += ('{0}:{1} {2}' -f $f.Name, $t.Extent.StartLineNumber, $t.Kind) } }
            $cmds = $ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] }, $true)
            foreach ($c in $cmds) {
                $name = $c.GetCommandName()
                $params = @($c.CommandElements | Where-Object { $_ -is [Management.Automation.Language.CommandParameterAst] } | ForEach-Object { $_.ParameterName })
                if (@('Join-String', 'Get-Error', 'ForEach-Object -Parallel') -contains $name) { $found += "$($f.Name): $name" }
                if ($name -eq 'ConvertFrom-Json' -and $params -contains 'AsHashtable') { $found += "$($f.Name): ConvertFrom-Json -AsHashtable" }
                if (@('ForEach-Object', '%', 'foreach') -contains $name -and $params -contains 'Parallel') { $found += "$($f.Name): ForEach-Object -Parallel" }
            }
        }
        $found | Should -BeNullOrEmpty
    }

    It 'entry scripts set ErrorActionPreference to Stop' {
        foreach ($n in @('Start-Semaphore.ps1', 'Stop-Semaphore.ps1')) {
            [IO.File]::ReadAllText([IO.Path]::Combine($script:Server, $n)) | Should -Match "\`$ErrorActionPreference = 'Stop'"
        }
    }

    It 'never binds a wildcard or LAN address' {
        foreach ($f in $script:Scripts) {
            if ($f.Name -like '*.Tests.ps1' -or $f.Name -eq 'FleetPort.psm1') { continue }   # FleetPort.psm1: suite copy, binds localhost itself
            $t = [IO.File]::ReadAllText($f.FullName)
            $t | Should -Not -Match 'IPAddress\]::Any|IPv6Any|0\.0\.0\.0|http://\+:|http://\*:'
        }
    }
}

Describe 'Launcher, version, settings and port block' {
    It 'Launch-Semaphore.bat runs Start-Semaphore.ps1 with Windows PowerShell' {
        $bat = [IO.File]::ReadAllText([IO.Path]::Combine($script:Root, 'Launch-Semaphore.bat'))
        $bat | Should -Match 'powershell\.exe -STA -NoLogo -NoProfile -ExecutionPolicy Bypass'
        $bat | Should -Match '-File "%~dp0server\\Start-Semaphore\.ps1" %\*'
    }

    It 'VERSION is semver' {
        Get-SemVersion -Root $script:Root | Should -Match '^\d+\.\d+\.\d+'
        Get-SemVersion -Root $script:Root | Should -Not -Be '0.0.0'
    }

    It 'FleetPorts.psd1 gives semaphore 8800-8802 with the reuse policy, disjoint from every other block' {
        $reg = Import-PowerShellDataFile ([IO.Path]::Combine($script:Server, 'FleetPorts.psd1'))
        $reg.ContainsKey('semaphore') | Should -BeTrue
        $reg['semaphore'].Start | Should -Be 8800
        $reg['semaphore'].Size | Should -Be 3
        $reg['semaphore'].Policy | Should -Be 'reuse'
        $seen = @{}
        foreach ($k in $reg.Keys) {
            for ($p = [int]$reg[$k].Start; $p -lt [int]$reg[$k].Start + [int]$reg[$k].Size; $p++) {
                $seen.ContainsKey($p) | Should -BeFalse -Because "port $p is in both $($seen[$p]) and $k"
                $seen[$p] = $k
            }
        }
    }

    It 'config/settings.json parses and settings.local.json overrides it key by key' {
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ('sem-set-' + [guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory((Join-Path $tmp 'config'))
        try {
            Copy-Item ([IO.Path]::Combine($script:Root, 'config', 'settings.json')) (Join-Path $tmp 'config')
            $s = Read-SemSettings -Root $tmp
            $s.browser | Should -Be 'auto'
            $s.heartbeatTimeoutSec | Should -Be 20
            [IO.File]::WriteAllText([IO.Path]::Combine($tmp, 'config', 'settings.local.json'), '{ "browser": "chrome", "leavingGraceSec": 7, "queryWorkers": "x" }')
            $s = Read-SemSettings -Root $tmp
            $s.browser | Should -Be 'chrome'
            $s.leavingGraceSec | Should -Be 7
            $s.heartbeatTimeoutSec | Should -Be 20
            $s.queryWorkers | Should -Be 4
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force }
    }

    It 'SEMAPHORE_AUTO_STOP=0 turns auto-stop off (environment variable or config\semaphore.env)' {
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ('sem-env-' + [guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory((Join-Path $tmp 'config'))
        $old = $env:SEMAPHORE_AUTO_STOP
        try {
            $env:SEMAPHORE_AUTO_STOP = $null
            Test-SemAutoStopEnabled -Root $tmp | Should -BeTrue
            [IO.File]::WriteAllText([IO.Path]::Combine($tmp, 'config', 'semaphore.env'), "# off switch`nSEMAPHORE_AUTO_STOP=0`n")
            Test-SemAutoStopEnabled -Root $tmp | Should -BeFalse
            Remove-Item -LiteralPath ([IO.Path]::Combine($tmp, 'config', 'semaphore.env'))
            $env:SEMAPHORE_AUTO_STOP = '0'
            Test-SemAutoStopEnabled -Root $tmp | Should -BeFalse
        } finally { $env:SEMAPHORE_AUTO_STOP = $old; Remove-Item -LiteralPath $tmp -Recurse -Force }
    }
}
