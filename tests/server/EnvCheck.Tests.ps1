# Pester 5. tools\env-check\Check-Environment.ps1: it parses under Windows PowerShell 5.1, is ASCII, uses no PowerShell 7-only syntax,
# binds loopback only, and a run (no browser, no real Semaphore start) writes a log with one verdict per known failure.
# Compare mode lists only the differences between two logs.
BeforeAll {
    $script:Root = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..'))
    $script:Tool = [IO.Path]::Combine($script:Root, 'tools', 'env-check', 'Check-Environment.ps1')
    $script:Bat = [IO.Path]::Combine($script:Root, 'tools', 'env-check', 'Check-Environment.bat')
    $ps = if ($PSVersionTable.PSEdition -eq 'Desktop') { (Get-Process -Id $PID).Path } else { 'powershell.exe' }
    $script:Ps = $ps
    $script:Out = Join-Path $TestDrive 'out'
    New-Item -ItemType Directory -Path $script:Out | Out-Null
    $script:Output = & $script:Ps -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script:Tool -NoBrowser -NoSemaphoreRun -OutDir $script:Out 2>&1 | Out-String
    $script:Logs = @(Get-ChildItem -LiteralPath (Join-Path $script:Out 'logs') -Filter '*.log' -ErrorAction SilentlyContinue)
}

Describe 'Environment check tool' {
    It 'parses' {
        $errs = $null
        [void][Management.Automation.Language.Parser]::ParseFile($script:Tool, [ref]$null, [ref]$errs)
        @($errs) | Should -BeNullOrEmpty
    }
    It 'is ASCII only (script and launcher)' {
        foreach ($f in $script:Tool, $script:Bat) {
            @([IO.File]::ReadAllBytes($f) | Where-Object { $_ -gt 127 }).Count | Should -Be 0
        }
    }
    It 'uses no PowerShell 7-only syntax' {
        $tokens = $null; $errs = $null
        [void][Management.Automation.Language.Parser]::ParseFile($script:Tool, [ref]$tokens, [ref]$errs)
        $bad = @($tokens | Where-Object { @('QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot', 'QuestionLBracket', 'AndAnd', 'OrOr', 'QuestionMark') -contains [string]$_.Kind })
        $bad | Should -BeNullOrEmpty
    }
    It 'never binds a wildcard or LAN address' {
        [IO.File]::ReadAllText($script:Tool) | Should -Not -Match 'IPAddress\]::Any|IPv6Any|0\.0\.0\.0|http://\+:|http://\*:'
    }
    It 'launcher runs the script with Windows PowerShell and no elevation' {
        $t = [IO.File]::ReadAllText($script:Bat)
        $t | Should -Match 'powershell\.exe'
        $t | Should -Match 'Check-Environment\.ps1'
        $t | Should -Not -Match '(?i)runas|Start-Process.*-Verb'
    }
}

Describe 'A run' {
    It 'writes exactly one log' {
        $script:Logs.Count | Should -Be 1
    }
    It 'logs every known failure as a verdict' {
        $text = [IO.File]::ReadAllText($script:Logs[0].FullName)
        foreach ($v in 'ZIP-EXTRACT', 'LAUNCH', 'NOT-BUILT', 'PORTS', 'BLANK-PAGE') { $text | Should -Match ('\[(PASS|FAIL|INFO)\] verdict\.' + $v + ' \|') }
    }
    It 'proves a zip made here can be created, read and extracted' {
        $text = [IO.File]::ReadAllText($script:Logs[0].FullName)
        $text | Should -Match '\[PASS\] zip\.signature \| real zip'
        $text | Should -Match '\[PASS\] zip\.read-dotnet'
        $text | Should -Match '\[PASS\] zip\.expand-archive'
    }
    It 'proves loopback works' {
        $text = [IO.File]::ReadAllText($script:Logs[0].FullName)
        $text | Should -Match '\[PASS\] http\.raw-tcp'
    }
    It 'replaces the user name and keeps the log ASCII' {
        $text = [IO.File]::ReadAllText($script:Logs[0].FullName)
        if ($env:USERNAME.Length -gt 1) { $text | Should -Not -Match ([regex]::Escape('\' + $env:USERNAME + '\')) }
        @([IO.File]::ReadAllBytes($script:Logs[0].FullName) | Where-Object { $_ -gt 127 }).Count | Should -Be 0
    }
}

Describe 'The zip classifier' {
    It 'recognises a tar file named .zip, an empty file and a real zip' {
        $tarZip = Join-Path $TestDrive 'fake.zip'
        $src = Join-Path $TestDrive 'src'; New-Item -ItemType Directory -Path $src | Out-Null
        [IO.File]::WriteAllText((Join-Path $src 'a.txt'), 'hello')
        $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
        if (-not $tar) { Set-ItResult -Skipped -Because 'tar.exe is not available'; return }
        & tar.exe --format=ustar -cf $tarZip -C $src a.txt
        $empty = Join-Path $TestDrive 'empty.zip'; [IO.File]::WriteAllBytes($empty, [byte[]]@())
        $real = Join-Path $TestDrive 'real.zip'
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::CreateFromDirectory($src, $real)
        $r = & $script:Ps -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script:Tool -NoBrowser -NoSemaphoreRun -OutDir $script:Out -ZipPath "$tarZip,$empty,$real" 2>&1 | Out-String
        $r | Should -Match 'fake\.zip \| .*TAR archive named \.zip'
        $r | Should -Match 'empty\.zip \| .*empty file'
        $r | Should -Match 'real\.zip \| .*real zip'
    }
}

Describe 'Compare mode' {
    It 'prints only the differences and ignores run.* keys' {
        $a = Join-Path $TestDrive 'a.log'; $b = Join-Path $TestDrive 'b.log'
        [IO.File]::WriteAllLines($a, @('[INFO] run.started | 1', '[PASS] zip.signature | real zip', '[PASS] ports.bind.8800 | ok', '[INFO] same.key | x'))
        [IO.File]::WriteAllLines($b, @('[INFO] run.started | 2', '[FAIL] zip.signature | TAR archive named .zip', '[PASS] ports.bind.8800 | ok', '[INFO] same.key | x'))
        $r = & $script:Ps -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script:Tool -Compare $a $b 2>&1 | Out-String
        $r | Should -Match 'zip\.signature'
        $r | Should -Match '1 differences, 2 identical'
        $r | Should -Not -Match 'run\.started'
    }
}
