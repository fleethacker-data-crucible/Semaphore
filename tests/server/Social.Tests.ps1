# Pester 5. The social feature switches (docs/PLAYBOOK.md): signalBook, impact, teamLog, showAskers
# and bz in settings.json, passed to the page as /api/info "social".
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    . ([IO.Path]::Combine($server, 'Common.ps1'))
}

Describe 'Social settings' {
    BeforeEach {
        $script:Root = Join-Path ([IO.Path]::GetTempPath()) ('sem-social-' + [guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($script:Root)
        $script:SemLogPath = Join-Path $script:Root 'test.log'
    }
    AfterEach { Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue }

    It 'are all on by default' {
        $s = Get-SemDefaultSettings
        foreach ($k in @('signalBook', 'impact', 'teamLog', 'showAskers', 'bz')) { $s[$k] | Should -BeTrue }
    }

    It 'can each be switched off' {
        $f = Join-Path $script:Root 'settings.json'
        [IO.File]::WriteAllText($f, '{ "signalBook": false, "showAskers": false, "bz": false }')
        $s = Get-SemDefaultSettings
        [void](Merge-SemSettingsFile -Settings $s -Path $f)
        $s.signalBook | Should -BeFalse
        $s.showAskers | Should -BeFalse
        $s.bz | Should -BeFalse
        $s.impact | Should -BeTrue
        $s.teamLog | Should -BeTrue
    }

    It 'ignore values that are not true or false' {
        $f = Join-Path $script:Root 'settings.json'
        [IO.File]::WriteAllText($f, '{ "impact": "no", "teamLog": 0, "bz": null }')
        $s = Get-SemDefaultSettings
        [void](Merge-SemSettingsFile -Settings $s -Path $f)
        $s.impact | Should -BeTrue
        $s.teamLog | Should -BeTrue
        $s.bz | Should -BeTrue
    }

    It 'reach the page as one object of booleans' {
        $s = Get-SemDefaultSettings
        $s.teamLog = $false
        $social = Get-SemSocialSettings -Settings $s
        @($social.Keys) | Should -Be @('signalBook', 'impact', 'teamLog', 'showAskers', 'bz')
        $social.teamLog | Should -BeFalse
        $social.signalBook | Should -BeTrue
    }

    It 'the tracked config\settings.json lists every switch' {
        $repo = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..'))
        $j = [IO.File]::ReadAllText([IO.Path]::Combine($repo, 'config', 'settings.json')) | ConvertFrom-Json
        $names = @($j.PSObject.Properties | ForEach-Object { $_.Name })
        foreach ($k in @('signalBook', 'impact', 'teamLog', 'showAskers', 'bz')) { $names | Should -Contain $k }
    }
}
