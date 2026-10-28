# Pester 5. Skins (docs/SKINS.md): the "skin" setting and the config\skin.css override served as /skin.css.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    . ([IO.Path]::Combine($server, 'Common.ps1'))
    . ([IO.Path]::Combine($server, 'Http.ps1'))
}

Describe 'Skins' {
    BeforeEach {
        $script:Root = Join-Path ([IO.Path]::GetTempPath()) ('sem-skin-' + [guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory((Join-Path $script:Root 'config'))
        $script:SemLogPath = Join-Path $script:Root 'test.log'
    }
    AfterEach { Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue }

    Context 'settings.json "skin"' {
        It 'defaults to no fixed skin' {
            (Get-SemDefaultSettings).skin | Should -Be ''
        }

        It 'accepts <Skin>' -TestCases @(@{ Skin = 'fleet' }, @{ Skin = 'classic' }, @{ Skin = 'event-2026' }, @{ Skin = '' }) {
            $f = Join-Path $script:Root 'settings.json'
            [IO.File]::WriteAllText($f, (@{ skin = $Skin } | ConvertTo-Json))
            $s = Get-SemDefaultSettings
            [void](Merge-SemSettingsFile -Settings $s -Path $f)
            $s.skin | Should -Be $Skin
        }

        It 'ignores an unsafe skin name: <Skin>' -TestCases @(@{ Skin = 'Fleet' }, @{ Skin = 'x"><script>' }, @{ Skin = ('a' * 40) }, @{ Skin = 'two words' }) {
            $f = Join-Path $script:Root 'settings.json'
            [IO.File]::WriteAllText($f, (@{ skin = $Skin } | ConvertTo-Json))
            $s = Get-SemDefaultSettings
            [void](Merge-SemSettingsFile -Settings $s -Path $f)
            $s.skin | Should -Be ''
        }
    }

    Context 'config\skin.css' {
        It 'is not used when absent' {
            Get-SemSkinFile -Root $script:Root | Should -BeNullOrEmpty
        }

        It 'is served when present' {
            $css = Join-Path $script:Root 'config\skin.css'
            [IO.File]::WriteAllText($css, ':root { --accent: #ff0000; }')
            Get-SemSkinFile -Root $script:Root | Should -Be $css
        }

        It 'is ignored above 256 KB' {
            [IO.File]::WriteAllText((Join-Path $script:Root 'config\skin.css'), ('/*' + ('x' * 262200) + '*/'))
            Get-SemSkinFile -Root $script:Root | Should -BeNullOrEmpty
        }

        It 'replaces /skin.css, as CSS, ahead of the build''s empty file' {
            [IO.File]::WriteAllText((Join-Path $script:Root 'config\skin.css'), ':root { --accent: #ff0000; }')
            $script:Sem.Root = $script:Root
            $script:Sem.WebRoot = Join-Path $script:Root 'dist'
            $ms = New-Object IO.MemoryStream
            $script:Sem.Stream = $ms
            try { Send-SemStatic -Req @{ Method = 'GET'; Path = '/skin.css' } } finally { $script:Sem.Stream = $null }
            $text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
            $text | Should -Match '^HTTP/1\.1 200'
            $text | Should -Match 'Content-Type: text/css'
            $text | Should -Match '--accent: #ff0000'
        }
    }
}
