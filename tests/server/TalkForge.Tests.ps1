# Pester 5. TalkForge setup, as in Lazarette PRs 141, 142 and 144: finding the TalkForge folder,
# starting TalkForge when speech is needed (reusing one that already answers, the token only in the
# child's environment, stopped with Semaphore only when Semaphore started it), the voice list read
# from the models folder (Piper configs with keys that differ only by case), the /stt/ files for voice
# input (fixed names only), and the microphone and WebAssembly headers.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Intelligence.ps1', 'Lazarette.Client.ps1', 'Vault.ps1', 'Connectors.ps1') { . ([IO.Path]::Combine($server, $f)) }
    $script:Token = 'tf-test-token-0123456789'
    $script:Node = Find-SemNode

    function script:New-SemRoot {
        # A Semaphore folder (config\) inside a parent; returns the root.
        $parent = Join-Path $TestDrive ('p-' + [guid]::NewGuid().ToString('N'))
        $root = Join-Path $parent 'Semaphore'
        [void][IO.Directory]::CreateDirectory((Join-Path $root 'config'))
        return $root
    }
    function script:Set-SemVoiceSettingsFile {
        param([string]$Root, $Voice)
        [IO.File]::WriteAllText((Join-Path $Root 'config\settings.json'), (@{ voice = $Voice } | ConvertTo-Json -Depth 5))
    }
    function script:New-FakeTalkForge {
        # A TalkForge folder whose tools\talkforge.mjs serves the heartbeat on --port, saying "talkforge" only
        # when TALKFORGE_TOKEN is the test token and no argument carries it; it records its argv and the
        # environment names it saw. Exits by itself after 60 s.
        param([string]$Dir)
        [void][IO.Directory]::CreateDirectory((Join-Path $Dir 'tools'))
        $js = @'
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const a = process.argv; const port = Number(a[a.indexOf('--port') + 1]);
const ok = process.env.TALKFORGE_TOKEN === 'tf-test-token-0123456789' && a.includes('--idle-timeout') && a[a.indexOf('--idle-timeout') + 1] === '30' && !a.some((x) => x.includes('tf-test-token'));
writeFileSync(new URL('./seen.json', import.meta.url), JSON.stringify({ argv: a.slice(2), env: Object.keys(process.env).filter((k) => /TOKEN|KEY|LAZARETTE_ITEM/i.test(k)) }));
createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ ok: true, tool: ok ? 'talkforge' : 'wrong' })); }).listen(port, '127.0.0.1');
setTimeout(() => process.exit(0), 60000);
'@
        [IO.File]::WriteAllText((Join-Path $Dir 'tools\talkforge.mjs'), $js)
        return $Dir
    }
    function script:Get-FreePort {
        $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start(); $p = ([Net.IPEndPoint]$l.LocalEndpoint).Port; $l.Stop(); return $p
    }
    function script:Start-HeartbeatServer {
        # A node process answering /__fleethacker/heartbeat on Port with tool = Tool (talkforge, or something else).
        param([int]$Port, [string]$Tool)
        $js = Join-Path $TestDrive ('hb-' + [guid]::NewGuid().ToString('N') + '.mjs')
        [IO.File]::WriteAllText($js, ("import {{ createServer }} from 'node:http'; createServer((q, r) => {{ r.writeHead(200, {{ 'content-type': 'application/json' }}); r.end(JSON.stringify({{ ok: true, tool: '{0}' }})); }}).listen({1}, '127.0.0.1'); setTimeout(() => process.exit(0), 60000);" -f $Tool, $Port))
        $p = Start-Process -FilePath $script:Node -ArgumentList ('"{0}"' -f $js) -PassThru -WindowStyle Hidden
        for ($i = 0; $i -lt 50 -and (Test-SemTalkForgeHeartbeat -Port $Port) -eq 'none'; $i++) { Start-Sleep -Milliseconds 100 }
        return $p
    }
    function script:Invoke-StaticRequest {
        param([string]$Path)
        $h = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        $h['Host'] = '127.0.0.1:8800'
        $req = @{ Method = 'GET'; Path = $Path; Query = ''; Headers = $h; ContentLength = 0; Body = (New-Object byte[] 0); Json = $null; RemoteAddress = [Net.IPAddress]::Loopback; Client = $null }
        $ms = New-Object IO.MemoryStream
        $script:Sem.Stream = $ms
        try { Invoke-SemRequest -Req $req } finally { $script:Sem.Stream = $null }
        $bytes = $ms.ToArray()
        $text = [Text.Encoding]::UTF8.GetString($bytes)
        $split = $text.IndexOf("`r`n`r`n")
        return [pscustomobject]@{ Status = [int]($text.Substring(9, 3)); Head = $text.Substring(0, $split); Body = $text.Substring($split + 4) }
    }
    $script:Sem.Port = 8800
    $script:Sem.Token = New-SemToken
}

Describe 'Finding TalkForge and its settings' {
    BeforeEach {
        $script:SavedFolder = [Environment]::GetEnvironmentVariable('SEMAPHORE_VOICE_FOLDER'); [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_FOLDER', $null)
        $script:SavedProfile = $env:USERPROFILE; $env:USERPROFILE = Join-Path $TestDrive 'nobody'
    }
    AfterEach { [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_FOLDER', $script:SavedFolder); $env:USERPROFILE = $script:SavedProfile }

    It 'defaults to auto start and voice input on, and finds a TalkForge folder next to Semaphore only when it has tools\talkforge.mjs' {
        $root = New-SemRoot
        $tf = Join-Path (Split-Path -Parent $root) 'TalkForge'
        [void][IO.Directory]::CreateDirectory($tf)
        $s = Get-SemTalkForgeSettings -Root $root
        $s.AutoStart | Should -BeTrue
        $s.Input | Should -BeTrue
        $s.Folder | Should -Be ''
        [void](New-FakeTalkForge $tf)
        (Get-SemTalkForgeSettings -Root $root).Folder | Should -Be $tf
    }

    It 'reads voice.autoStart, voice.input and voice.folder from settings, and SEMAPHORE_VOICE_FOLDER wins' {
        $root = New-SemRoot
        $mine = New-FakeTalkForge (Join-Path $TestDrive 'Tools\TalkForge')
        Set-SemVoiceSettingsFile -Root $root -Voice @{ autoStart = $false; input = $false; folder = ($mine + '\') }
        $s = Get-SemTalkForgeSettings -Root $root
        $s.AutoStart | Should -BeFalse
        $s.Input | Should -BeFalse
        $s.Folder | Should -Be $mine
        $s.FolderSource | Should -Be 'settings'
        $other = New-FakeTalkForge (Join-Path $TestDrive 'Other\TalkForge')
        [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_FOLDER', $other)
        $s = Get-SemTalkForgeSettings -Root $root
        $s.Folder | Should -Be $other
        $s.FolderSource | Should -Be 'environment'
    }

    It 'never falls back when the configured folder is wrong, and refuses a relative one' {
        $root = New-SemRoot
        [void](New-FakeTalkForge (Join-Path (Split-Path -Parent $root) 'TalkForge'))
        Set-SemVoiceSettingsFile -Root $root -Voice @{ folder = (Join-Path $TestDrive 'nowhere') }
        (Get-SemTalkForgeSettings -Root $root).Folder | Should -Be ''
        Set-SemVoiceSettingsFile -Root $root -Voice @{ folder = '..\TalkForge' }
        $s = Get-SemTalkForgeSettings -Root $root
        $s.Folder | Should -Be ''
        $s.FolderProblem | Should -Match 'full path'
    }

    It 'reads the port only from an http://127.0.0.1:<port> address' {
        Get-SemVoicePort 'http://127.0.0.1:25009' | Should -Be 25009
        Get-SemVoicePort 'http://127.0.0.1:25009/' | Should -Be 25009
        Get-SemVoicePort 'http://[::1]:25009' | Should -Be 0
        Get-SemVoicePort 'http://localhost:25009' | Should -Be 0
        Get-SemVoicePort '' | Should -Be 0
    }
}

Describe 'Starting TalkForge when speech is needed' {
    BeforeEach {
        $script:Saved = @{}
        foreach ($n in 'SEMAPHORE_VOICE_URL', 'SEMAPHORE_VOICE_TOKEN', 'SEMAPHORE_VOICE_FOLDER') { $script:Saved[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $null) }
        $script:SemTalkForge.Process = $null; $script:SemTalkForge.Message = ''; $script:SemTalkForge.Port = 0
        $script:Root = New-SemRoot
        $script:Port = Get-FreePort
        [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_URL', "http://127.0.0.1:$($script:Port)")
        [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_TOKEN', $script:Token)
        $script:LogLines = New-Object Collections.ArrayList
        Mock Write-SemLog { param($Level, $Text) [void]$script:LogLines.Add("$Level $Text") }
    }
    AfterEach {
        [void](Stop-SemTalkForgeChild)
        foreach ($n in $script:Saved.Keys) { [Environment]::SetEnvironmentVariable($n, $script:Saved[$n]) }
    }

    It 'uses a TalkForge that already answers on the address (one Lazarette started) and starts no second copy' {
        $tf = New-FakeTalkForge (Join-Path $TestDrive ('tf-' + [guid]::NewGuid().ToString('N')))
        Set-SemVoiceSettingsFile -Root $script:Root -Voice @{ folder = $tf }
        $other = Start-HeartbeatServer -Port $script:Port -Tool 'talkforge'
        try {
            (Get-SemTalkForgeState -Root $script:Root).state | Should -Be 'ready'
            $s = Start-SemTalkForge -Root $script:Root
            $s.state | Should -Be 'ready'
            $s.startedHere | Should -BeFalse
            $script:SemTalkForge.Process | Should -BeNullOrEmpty
            Test-Path (Join-Path $tf 'tools\seen.json') | Should -BeFalse   # the folder's TalkForge never ran
            Stop-SemTalkForgeChild | Should -BeFalse                          # and stopping Semaphore leaves Lazarette's alone
            $other.HasExited | Should -BeFalse
        } finally { try { $other.Kill() } catch { } }
    }

    It 'starts TalkForge with the token in its environment only, reports starting then ready, and stops it with Semaphore' {
        $tf = New-FakeTalkForge (Join-Path $TestDrive ('tf-' + [guid]::NewGuid().ToString('N')))
        Set-SemVoiceSettingsFile -Root $script:Root -Voice @{ folder = $tf }
        [Environment]::SetEnvironmentVariable('SEMAPHORE_AI_KEY', 'ai-key-should-not-travel')
        try {
            (Get-SemTalkForgeState -Root $script:Root).state | Should -Be 'offline'
            $s = Start-SemTalkForge -Root $script:Root
            $s.state | Should -Be 'starting'
            $s.message | Should -Match 'Getting the voice ready'
            (Start-SemTalkForge -Root $script:Root).state | Should -BeIn @('starting', 'ready')   # never a second copy
            for ($i = 0; $i -lt 60 -and $s.state -eq 'starting'; $i++) { Start-Sleep -Milliseconds 250; $s = Get-SemTalkForgeState -Root $script:Root }
            $s.state | Should -Be 'ready'   # the stand-in says "talkforge" only with the right token and no token in argv
            $s.startedHere | Should -BeTrue
            $seen = Get-Content -Raw (Join-Path $tf 'tools\seen.json') | ConvertFrom-Json
            ($seen.argv -join ' ') | Should -Be ('serve --port {0} --idle-timeout 30' -f $script:Port)
            @($seen.env) | Should -Contain 'TALKFORGE_TOKEN'
            @($seen.env) | Should -Not -Contain 'SEMAPHORE_VOICE_TOKEN'
            @($seen.env) | Should -Not -Contain 'SEMAPHORE_AI_KEY'
            $p = $script:SemTalkForge.Process
            # What process creation auditing records: the command line, which never holds the token.
            $cmd = (Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $p.Id)).CommandLine
            $cmd | Should -Not -BeLike "*$($script:Token)*"
            $cmd | Should -BeLike '*talkforge.mjs*'
            ($script:LogLines -join "`n") | Should -Not -Match 'tf-test-token'
            $childId = $p.Id
            Stop-SemTalkForgeChild | Should -BeTrue
            Get-Process -Id $childId -ErrorAction SilentlyContinue | Should -BeNullOrEmpty
            (Get-SemTalkForgeState -Root $script:Root).state | Should -Be 'offline'
        } finally { [Environment]::SetEnvironmentVariable('SEMAPHORE_AI_KEY', $null) }
    }

    It 'builds the start info with the token in the environment and never in the arguments' {
        $si = New-SemTalkForgeStartInfo -Node 'C:\node\node.exe' -Folder 'C:\TF' -Port 25009 -Token $script:Token
        $si.Arguments | Should -Be '"C:\TF\tools\talkforge.mjs" serve --port 25009 --idle-timeout 30'
        $si.Arguments | Should -Not -Match 'tf-test-token'
        $si.EnvironmentVariables['TALKFORGE_TOKEN'] | Should -Be $script:Token
        $si.EnvironmentVariables.ContainsKey('SEMAPHORE_VOICE_TOKEN') | Should -BeFalse
        $si.CreateNoWindow | Should -BeTrue
        $si.UseShellExecute | Should -BeFalse
    }

    It 'says so plainly when auto start is off' {
        $tf = New-FakeTalkForge (Join-Path $TestDrive ('tf-' + [guid]::NewGuid().ToString('N')))
        Set-SemVoiceSettingsFile -Root $script:Root -Voice @{ folder = $tf; autoStart = $false }
        $s = Start-SemTalkForge -Root $script:Root
        $s.state | Should -Be 'unavailable'
        $s.message | Should -Match 'automatically is off'
        $script:SemTalkForge.Process | Should -BeNullOrEmpty
        (Get-SemTalkForgeState -Root $script:Root).state | Should -Be 'unavailable'
    }

    It 'says so plainly when the folder is missing' {
        Set-SemVoiceSettingsFile -Root $script:Root -Voice @{ folder = (Join-Path $TestDrive 'nowhere') }
        $s = Start-SemTalkForge -Root $script:Root
        $s.state | Should -Be 'unavailable'
        $s.message | Should -Match 'not found'
    }

    It 'says so plainly when node is missing' {
        $tf = New-FakeTalkForge (Join-Path $TestDrive ('tf-' + [guid]::NewGuid().ToString('N')))
        Set-SemVoiceSettingsFile -Root $script:Root -Voice @{ folder = $tf }
        Mock Find-SemNode { return '' }
        $s = Start-SemTalkForge -Root $script:Root
        $s.state | Should -Be 'unavailable'
        $s.message | Should -Match 'Node.js 18 or newer'
        $script:SemTalkForge.Process | Should -BeNullOrEmpty
    }

    It 'refuses a short token and a non-loopback address, and never starts on a port another program holds' {
        $tf = New-FakeTalkForge (Join-Path $TestDrive ('tf-' + [guid]::NewGuid().ToString('N')))
        Set-SemVoiceSettingsFile -Root $script:Root -Voice @{ folder = $tf }
        [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_TOKEN', 'short')
        (Start-SemTalkForge -Root $script:Root).message | Should -Match '16 or more'
        [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_TOKEN', $script:Token)
        [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_URL', 'http://[::1]:25009')
        (Start-SemTalkForge -Root $script:Root).message | Should -Match '127\.0\.0\.1'
        [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_URL', "http://127.0.0.1:$($script:Port)")
        $other = Start-HeartbeatServer -Port $script:Port -Tool 'something-else'
        try {
            $s = Start-SemTalkForge -Root $script:Root
            $s.state | Should -Be 'unavailable'
            $s.message | Should -Match 'Another program'
            $script:SemTalkForge.Process | Should -BeNullOrEmpty
        } finally { try { $other.Kill() } catch { } }
    }

    It 'asks for the Lazarette share when no token is set, without starting anything' {
        $tf = New-FakeTalkForge (Join-Path $TestDrive ('tf-' + [guid]::NewGuid().ToString('N')))
        Set-SemVoiceSettingsFile -Root $script:Root -Voice @{ folder = $tf }
        [Environment]::SetEnvironmentVariable('SEMAPHORE_VOICE_TOKEN', $null)
        Mock Get-LazaretteToolSecrets { return @{ TALKFORGE_TOKEN = $null } }
        $s = Start-SemTalkForge -Root $script:Root
        $s.state | Should -Be 'unavailable'
        $s.message | Should -Match 'TALKFORGE_TOKEN'
        $script:SemTalkForge.Process | Should -BeNullOrEmpty
    }
}

Describe 'The installed voices' {
    It 'lists each model that has its config, the default first, read field by field from Piper configs' {
        $root = New-SemRoot
        $tf = New-FakeTalkForge (Join-Path $TestDrive ('tf-' + [guid]::NewGuid().ToString('N')))
        Set-SemVoiceSettingsFile -Root $root -Voice @{ folder = $tf }
        [IO.File]::WriteAllText((Join-Path $tf 'tools\node-engine.mjs'), "export const DEFAULT_VOICE = 'en_US-libritts-high';")
        $models = Join-Path $tf 'assets\models'
        [void][IO.Directory]::CreateDirectory($models)
        # Keys that differ only by case, as Piper's phoneme maps have: PowerShell 5.1's ConvertFrom-Json refuses these.
        $cfg = '{{"dataset":"{0}","num_speakers":904,"audio":{{"quality":"{1}","sample_rate":22050}},"language":{{"name_english":"English","country_english":"United States"}},"phoneme_id_map":{{"A":[1],"a":[2],"B":[3],"b":[4]}}}}'
        foreach ($v in @(@('en_US-libritts_r-medium', 'libritts_r', 'medium'), @('en_US-libritts-high', 'libritts', 'high'))) {
            [IO.File]::WriteAllText((Join-Path $models ($v[0] + '.onnx')), 'x')
            [IO.File]::WriteAllText((Join-Path $models ($v[0] + '.onnx.json')), ($cfg -f $v[1], $v[2]))
        }
        [IO.File]::WriteAllText((Join-Path $models 'en_US-amy-medium.onnx'), 'x')      # no config: not listed
        [IO.File]::WriteAllText((Join-Path $models 'en_GB-vctk-medium.onnx.json'), '{}') # no model: not listed
        { (Get-Content -Raw (Join-Path $models 'en_US-libritts-high.onnx.json')) | ConvertFrom-Json } | Should -Throw
        $r = Get-SemTalkForgeVoices -Root $root
        $r.found | Should -BeTrue
        $r.default | Should -Be 'en_US-libritts-high'
        @($r.voices | ForEach-Object { $_.id }) | Should -Be @('en_US-libritts-high', 'en_US-libritts_r-medium')
        $r.voices[0].default | Should -BeTrue
        $r.voices[0].quality | Should -Be 'high'
        $r.voices[1].quality | Should -Be 'medium'
        $r.voices[1].speakers | Should -Be 904
        $r.voices[1].dataset | Should -Be 'libritts_r'
        $r.voices[1].language | Should -Be 'English, United States'
        $r.message | Should -Be ''
    }

    It 'says when TalkForge is not found, or has no voices' {
        $root = New-SemRoot
        Set-SemVoiceSettingsFile -Root $root -Voice @{ folder = (Join-Path $TestDrive 'nowhere') }
        $r = Get-SemTalkForgeVoices -Root $root
        $r.found | Should -BeFalse
        @($r.voices).Count | Should -Be 0
        $r.message | Should -Match 'not found'
        $tf = New-FakeTalkForge (Join-Path $TestDrive ('tf-' + [guid]::NewGuid().ToString('N')))
        Set-SemVoiceSettingsFile -Root $root -Voice @{ folder = $tf }
        (Get-SemTalkForgeVoices -Root $root).message | Should -Match 'populate-assets'
    }
}

Describe 'Voice input files and headers' {
    BeforeAll {
        $script:SttRoot = New-SemRoot
        $script:Tf = New-FakeTalkForge (Join-Path $TestDrive 'stt-tf')
        Set-SemVoiceSettingsFile -Root $script:SttRoot -Voice @{ folder = $script:Tf }
        $whisper = Join-Path $script:Tf 'assets\stt\models\whisper-tiny.en'
        [void][IO.Directory]::CreateDirectory($whisper)
        [void][IO.Directory]::CreateDirectory((Join-Path $script:Tf 'assets\vendor\onnx'))
        [IO.File]::WriteAllText((Join-Path $whisper 'config.json'), '{"model_type":"whisper"}')
        [IO.File]::WriteAllBytes((Join-Path $script:Tf 'assets\vendor\onnx\ort-wasm-simd-threaded.jsep.wasm'), [byte[]](0, 97, 115, 109))
        [IO.File]::WriteAllText((Join-Path $script:Tf 'assets\secret.txt'), 'not for the page')
        $script:Web = Join-Path $TestDrive 'web'
        [void][IO.Directory]::CreateDirectory((Join-Path $script:Web 'assets'))
        [IO.File]::WriteAllText((Join-Path $script:Web 'index.html'), '<!doctype html><title>t</title>')
        [IO.File]::WriteAllText((Join-Path $script:Web 'assets\stt.0123456789.js'), 'self.onmessage = null;')
        [IO.File]::WriteAllText((Join-Path $script:Web 'assets\app-ABCDEFGH.js'), 'console.log(1)')
        $script:Sem.WebRoot = $script:Web
        $script:Sem.Root = $script:SttRoot
    }
    AfterAll { $script:Sem.VoiceInput = $false; $script:Sem.Root = '' }

    It 'serves only the fixed Whisper files from the TalkForge assets folder, with their types' {
        $script:Sem.VoiceInput = $true
        $r = Invoke-StaticRequest '/stt/models/whisper-tiny.en/config.json'
        $r.Status | Should -Be 200
        $r.Head | Should -Match 'Content-Type: application/json'
        $r.Body | Should -Be '{"model_type":"whisper"}'
        $w = Invoke-StaticRequest '/stt/onnx/ort-wasm-simd-threaded.jsep.wasm'
        $w.Status | Should -Be 200
        $w.Head | Should -Match 'Content-Type: application/wasm'
        $m = Invoke-StaticRequest '/stt/transformers.min.js'
        $m.Status | Should -Be 404
        $m.Body | Should -Match 'stt-missing'
    }

    It 'refuses every other path: <P>' -TestCases @(
        @{ P = '/stt/../secret.txt' }, @{ P = '/stt/secret.txt' }, @{ P = '/stt/models/whisper-tiny.en/../../secret.txt' },
        @{ P = '/stt/%2e%2e/secret.txt' }, @{ P = '/stt/..%5csecret.txt' }, @{ P = '/stt/tools/talkforge.mjs' },
        @{ P = '/stt/MODELS/whisper-tiny.en/config.json' }, @{ P = '/stt/models/whisper-tiny.en/config.json/' }, @{ P = '/stt/' }
    ) {
        $script:Sem.VoiceInput = $true
        $r = Invoke-StaticRequest $P
        $r.Status | Should -Be 404
        $r.Body | Should -Not -Match 'not for the page'
    }

    It 'reports which Whisper files are missing' {
        $s = Get-SemSttStatus -Root $script:SttRoot
        $s.ready | Should -BeFalse
        $s.missing | Should -Contain 'transformers.min.js'
        $s.missing | Should -Not -Contain 'models/whisper-tiny.en/config.json'
        $s.message | Should -Match "populate-assets.ps1 -Only 'stt/\*'"
    }

    It 'allows the microphone and the worker''s WebAssembly only while voice input is on' {
        $script:Sem.VoiceInput = $true
        $page = Invoke-StaticRequest '/'
        $page.Head | Should -Match 'Permissions-Policy: camera=\(\), microphone=\(self\), geolocation=\(\)'
        $page.Head | Should -Match ('Content-Security-Policy: ' + [regex]::Escape($script:SemCsp) + "`r")
        $worker = Invoke-StaticRequest '/assets/stt.0123456789.js'
        $worker.Head | Should -Match ('Content-Security-Policy: ' + [regex]::Escape($script:SemSttCsp))
        (Invoke-StaticRequest '/assets/app-ABCDEFGH.js').Head | Should -Not -Match 'wasm-unsafe-eval'
        $script:SemSttCsp | Should -Be ($script:SemCsp.Replace("script-src 'self';", "script-src 'self' 'wasm-unsafe-eval';"))
        $script:SemCsp | Should -Not -Match "script-src[^;]*unsafe"
        @(Get-SemSecurityHeaders -Sandbox | Where-Object { $_ -like 'Permissions-Policy:*' }) | Should -Be @('Permissions-Policy: ' + $script:SemPermissionsPolicy)

        $script:Sem.VoiceInput = $false
        (Invoke-StaticRequest '/').Head | Should -Match 'microphone=\(\),'
        (Invoke-StaticRequest '/assets/stt.0123456789.js').Head | Should -Not -Match 'wasm-unsafe-eval'
        (Invoke-StaticRequest '/stt/models/whisper-tiny.en/config.json').Status | Should -Be 404
    }

    It 'answers the dictation status only while voice input is on' {
        $h = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        $h['Host'] = '127.0.0.1:8800'; $h['X-Semaphore-Session'] = $script:Sem.Token
        $call = {
            $req = @{ Method = 'GET'; Path = '/api/voice/dictation/status'; Query = ''; Headers = $h; ContentLength = 0; Body = (New-Object byte[] 0); Json = $null; RemoteAddress = [Net.IPAddress]::Loopback; Client = $null }
            $ms = New-Object IO.MemoryStream; $script:Sem.Stream = $ms
            try { Invoke-SemRequest -Req $req } finally { $script:Sem.Stream = $null }
            [Text.Encoding]::UTF8.GetString($ms.ToArray())
        }
        $script:Sem.VoiceInput = $false
        (& $call) | Should -Match '^HTTP/1.1 403'
        $script:Sem.VoiceInput = $true
        Mock Get-SemSttStatus { return [ordered]@{ ready = $true; missing = @(); message = 'Voice input is ready.' } }
        (& $call) | Should -Match '"ready":true'
    }
}
