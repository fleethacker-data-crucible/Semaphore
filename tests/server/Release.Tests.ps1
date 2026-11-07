# Pester 5. The release scripts in build\: they parse, are ASCII, use no PowerShell 7-only syntax,
# and the zip smoke test reads the launcher's output and the served page correctly.
BeforeAll {
    $script:Root = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..'))
    $script:Build = [IO.Path]::Combine($script:Root, 'build')
    $script:Scripts = @(Get-ChildItem -LiteralPath $script:Build -File -Filter '*.ps1')
    . ([IO.Path]::Combine($script:Build, 'Test-SemaphoreZip.ps1'))
}

Describe 'Release scripts' {
    It 'finds the build and smoke scripts' {
        $names = @($script:Scripts | ForEach-Object { $_.Name })
        $names | Should -Contain 'Build-Semaphore.ps1'
        $names | Should -Contain 'Test-SemaphoreZip.ps1'
    }

    It 'every script parses, is ASCII and uses no PowerShell 7-only syntax' {
        $ps7Tokens = @('QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot', 'QuestionLBracket', 'AndAnd', 'OrOr', 'QuestionMark')
        $found = @()
        foreach ($f in $script:Scripts) {
            $tokens = $null; $errs = $null
            [void][Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
            foreach ($e in @($errs)) { $found += ('{0}:{1} {2}' -f $f.Name, $e.Extent.StartLineNumber, $e.Message) }
            foreach ($t in $tokens) { if ($ps7Tokens -contains [string]$t.Kind) { $found += ('{0}:{1} {2}' -f $f.Name, $t.Extent.StartLineNumber, $t.Kind) } }
            foreach ($b in [IO.File]::ReadAllBytes($f.FullName)) { if ($b -gt 127) { $found += ($f.Name + ' is not ASCII'); break } }
        }
        $found | Should -BeNullOrEmpty
    }

    It 'the build checks that every asset build.json names reached the bundle' {
        $text = [IO.File]::ReadAllText([IO.Path]::Combine($script:Build, 'Build-Semaphore.ps1'))
        $text | Should -Match 'build\.json'
        $text | Should -Match 'manifest\.chunks'
    }
}

Describe 'Zip smoke test helpers' {
    It 'reads the session link Start-Semaphore.ps1 --no-browser prints' {
        $out = "Semaphore 0.3.0 is running at http://127.0.0.1:8801/. It keeps running after the tab closes.`r`nSession link (works once, for 10 minutes): http://127.0.0.1:8801/?launch=AbC_12-x`r`n"
        Get-SmokeSessionLink $out | Should -Be 'http://127.0.0.1:8801/?launch=AbC_12-x'
        Get-SmokeSessionLink 'Semaphore is starting' | Should -Be ''
        Get-SmokeLaunchCode 'http://127.0.0.1:8801/?launch=AbC_12-x&view=ask' | Should -Be 'AbC_12-x'
        Get-SmokeLaunchCode 'http://127.0.0.1:8801/' | Should -Be ''
    }

    It 'tells the app page from the "not built" page' {
        $app = '<!doctype html><html><body><div id="root"></div><script type="module" src="assets/app-ABCD1234.js"></script></body></html>'
        Test-SmokeAppPage $app | Should -BeNullOrEmpty
        Test-SmokeAppPage '<h1>Semaphore</h1><p>This copy of Semaphore has no browser interface</p>' | Should -Match 'not built'
        Test-SmokeAppPage '<div id="root"></div><script src="assets/app.js"></script>' | Should -Match 'module script'
        Test-SmokeAppPage '' | Should -Match 'empty'
    }

    It 'finds a free port in 8800-8802 or reports none' {
        $p = Get-SmokeFreePort
        @(0, 8800, 8801, 8802) | Should -Contain $p
    }

    It 'reads a file another process still has open for writing' {
        $f = Join-Path ([IO.Path]::GetTempPath()) ('smoke-' + [guid]::NewGuid().ToString('N') + '.txt')
        $w = New-Object IO.FileStream($f, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        try {
            $bytes = [Text.Encoding]::ASCII.GetBytes('Session link')
            $w.Write($bytes, 0, $bytes.Length); $w.Flush()
            Read-SmokeText $f | Should -Be 'Session link'
        } finally { $w.Dispose(); Remove-Item -LiteralPath $f -Force }
        Read-SmokeText $f | Should -Be ''
    }
}
