# Pester 5. Page snapshots (/api/page-snapshots, server/Routes.ps1): save, list, read back byte for
# byte, delete to .trash; ids, names, kinds and sizes checked; one automatic snapshot per 10 minutes;
# the last 30 automatic ones kept with every named one. Requests are dispatched in memory.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Vault.ps1', 'Connectors.ps1') { . (Join-Path $server $f) }

    $script:TestHome = Join-Path ([IO.Path]::GetTempPath()) ('sem-snap-' + [guid]::NewGuid().ToString('N'))
    $script:Sem.Port = 8800
    $script:Sem.Token = New-SemToken
    $script:Sem.Version = '0.2.0'
    $script:Sem.Home = Resolve-SemHome -Settings @{ home = $script:TestHome } -Create
    Initialize-SemPresence -AutoStop $true

    function script:Send([string]$Method = 'GET', [string]$Path, [string]$Body = '') {
        $h = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        $h['Host'] = '127.0.0.1:8800'
        $h['X-Semaphore-Session'] = $script:Sem.Token
        $bytes = (New-Object Text.UTF8Encoding $false).GetBytes($Body)
        $req = @{ Method = $Method; Path = $Path; Query = ''; Headers = $h; ContentLength = $bytes.Length; Body = $bytes; Json = $null; RemoteAddress = [Net.IPAddress]::Loopback; Client = $null }
        $ms = New-Object IO.MemoryStream
        $script:Sem.Stream = $ms
        Invoke-SemRequest -Req $req
        $script:Sem.Stream = $null
        $text = (New-Object Text.UTF8Encoding $false).GetString($ms.ToArray())
        $split = $text.IndexOf("`r`n`r`n")
        [pscustomobject]@{ Status = [int]($text.Substring(0, $split).Split(' ')[1]); Body = $text.Substring($split + 4) }
    }
    # The same route with the clock set, for the 10-minute rule and the pruning.
    function script:SendAt([string]$HoistId, [string]$Body, [datetime]$Now) {
        $bytes = (New-Object Text.UTF8Encoding $false).GetBytes($Body)
        $req = @{ Method = 'POST'; Path = "/api/page-snapshots/$HoistId"; Body = $bytes; Json = ($Body | ConvertFrom-Json) }
        $ms = New-Object IO.MemoryStream
        $script:Sem.Stream = $ms
        Invoke-SemSnapRoute -Req $req -HoistId $HoistId -SnapId $null -Now $Now
        $script:Sem.Stream = $null
        $text = (New-Object Text.UTF8Encoding $false).GetString($ms.ToArray())
        $split = $text.IndexOf("`r`n`r`n")
        [pscustomobject]@{ Status = [int]($text.Substring(0, $split).Split(' ')[1]); Body = $text.Substring($split + 4) }
    }
    # Windows PowerShell's ConvertFrom-Json gives a JSON array as one object: unroll it.
    function script:List([string]$HoistId) {
        $j = (Send 'GET' "/api/page-snapshots/$HoistId").Body | ConvertFrom-Json
        return @($j | ForEach-Object { $_ })
    }
    function script:Page([string]$Id, [string]$Title = 'Fleet') {
        return ('{"version":1,"id":"' + $Id + '","title":"' + $Title + '","flags":[{"id":"a"},{"id":"b"}],"updated":"2026-11-08T10:00:00.000Z"}')
    }
    function script:Body([string]$Kind, [string]$HoistText, [hashtable]$Extra = @{}) {
        $o = [ordered]@{ kind = $Kind; hoist = $HoistText }
        foreach ($k in $Extra.Keys) { $o[$k] = $Extra[$k] }
        return (ConvertTo-Json -InputObject $o -Compress -Depth 4)
    }
}

AfterAll {
    Remove-Item -LiteralPath $script:TestHome -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Saving, listing, reading and deleting a page snapshot' {
    It 'saves a named snapshot with its note, lists it with time and author, and gives the page back byte for byte' {
        $page = Page 'fleet-a' ('Fleet \"A\" ' + [char]0xE9)
        $r = Send 'POST' '/api/page-snapshots/fleet-a' (Body 'named' $page @{ name = 'Before the review'; note = 'As sent to the CO'; catalogVersion = 'a1b2c3d4' })
        $r.Status | Should -Be 200
        $saved = ($r.Body | ConvertFrom-Json).snapshot
        $saved.id | Should -Match '^\d{17}-[0-9a-f]{6}$'
        $saved.kind | Should -Be 'named'
        $saved.author | Should -Be ([string]$env:USERNAME)
        $saved.flags | Should -Be 2
        $saved.catalogVersion | Should -Be 'a1b2c3d4'
        $list = @(List 'fleet-a')
        $list.Count | Should -Be 1
        $list[0].name | Should -Be 'Before the review'
        $list[0].note | Should -Be 'As sent to the CO'
        [string]$list[0].created | Should -Not -BeNullOrEmpty
        $one = Send 'GET' "/api/page-snapshots/fleet-a/$($saved.id)"
        $one.Status | Should -Be 200
        $one.Body.EndsWith('"hoist":' + $page + '}') | Should -BeTrue
        ($one.Body | ConvertFrom-Json).hoist.title | Should -Be ('Fleet "A" ' + [char]0xE9)
        [IO.File]::ReadAllText([IO.Path]::Combine($script:Sem.Home, 'snapshots', 'fleet-a', "$($saved.id).hoist.json")) | Should -Be $page
    }

    It 'lists newest first and keeps each page apart, and lists nothing for a page with none' {
        $null = Send 'POST' '/api/page-snapshots/fleet-b' (Body 'named' (Page 'fleet-b') @{ name = 'one' })
        Start-Sleep -Milliseconds 20
        $null = Send 'POST' '/api/page-snapshots/fleet-b' (Body 'named' (Page 'fleet-b') @{ name = 'two' })
        $list = @(List 'fleet-b')
        @($list | ForEach-Object { $_.name }) | Should -Be @('two', 'one')
        (Send 'GET' '/api/page-snapshots/never-saved').Body | Should -Be '[]'
    }

    It 'moves a deleted snapshot (both files) to .trash, and then answers 404' {
        $id = ((Send 'POST' '/api/page-snapshots/fleet-c' (Body 'named' (Page 'fleet-c') @{ name = 'gone soon' })).Body | ConvertFrom-Json).snapshot.id
        (Send 'DELETE' "/api/page-snapshots/fleet-c/$id").Status | Should -Be 200
        (Send 'GET' "/api/page-snapshots/fleet-c/$id").Status | Should -Be 404
        (Send 'DELETE' "/api/page-snapshots/fleet-c/$id").Status | Should -Be 404
        $trash = [IO.Path]::Combine($script:Sem.Home, 'snapshots', 'fleet-c', '.trash')
        @(Get-ChildItem -LiteralPath $trash -File).Count | Should -Be 2
        (Send 'GET' '/api/page-snapshots/fleet-c').Body | Should -Be '[]'
    }

    It 'does not show page snapshots among the playbook snapshots' {
        $list = @((Send 'GET' '/api/snapshots').Body | ConvertFrom-Json | ForEach-Object { $_ })
        @($list | Where-Object { $_.id -like 'fleet-*' }).Count | Should -Be 0
    }
}

Describe 'What a snapshot request may hold' {
    It 'refuses a bad hoist id, a bad snapshot id and other methods' {
        (Send 'GET' '/api/page-snapshots/bad.id').Status | Should -Be 400
        (Send 'GET' '/api/page-snapshots/fleet-a/..').Status | Should -Be 400
        (Send 'GET' '/api/page-snapshots/fleet-a/20261108-nope').Status | Should -Be 400
        (Send 'PUT' '/api/page-snapshots/fleet-a' (Body 'named' (Page 'fleet-a') @{ name = 'x' })).Status | Should -Be 405
        (Send 'POST' '/api/page-snapshots/fleet-a/20261108100000000-abcdef' '{}').Status | Should -Be 405
    }

    It 'refuses <Why>' -TestCases @(
        @{ Why = 'an unknown kind'; B = '{"kind":"later","hoist":"{\"version\":1,\"id\":\"fleet-v\"}"}' }
        @{ Why = 'a named one without a name'; B = '{"kind":"named","name":"  	 ","hoist":"{\"version\":1,\"id\":\"fleet-v\"}"}' }
        @{ Why = 'a page that is not JSON text'; B = '{"kind":"auto","hoist":{"version":1,"id":"fleet-v"}}' }
        @{ Why = 'a page without version 1'; B = '{"kind":"auto","hoist":"{\"id\":\"fleet-v\"}"}' }
        @{ Why = 'a page that is not JSON'; B = '{"kind":"auto","hoist":"{\"id\":"}' }
        @{ Why = 'another hoist'; B = '{"kind":"auto","hoist":"{\"version\":1,\"id\":\"someone-else\"}"}' }
    ) {
        $r = Send 'POST' '/api/page-snapshots/fleet-v' $B
        $r.Status | Should -Be 400
        ($r.Body | ConvertFrom-Json).error | Should -Not -BeNullOrEmpty
        Test-Path -LiteralPath ([IO.Path]::Combine($script:Sem.Home, 'snapshots', 'fleet-v')) | Should -BeFalse
    }

    It 'refuses a page over 2 MB, and a body over 3 MB before it is parsed' {
        $big = '{"version":1,"id":"fleet-big","pad":"' + ('x' * 2100000) + '"}'
        (Send 'POST' '/api/page-snapshots/fleet-big' (Body 'auto' $big)).Status | Should -Be 413
        $huge = '{"kind":"auto","hoist":"' + ('x' * 3200000) + '"}'
        (Send 'POST' '/api/page-snapshots/fleet-big' $huge).Status | Should -Be 413
    }

    It 'keeps a name and a note to one line and their caps, and drops a catalog version that is not hex' {
        $name = "Line one`r`nline two" + [char]0x2028 + ('n' * 200)
        $r = Send 'POST' '/api/page-snapshots/fleet-n' (Body 'named' (Page 'fleet-n') @{ name = $name; note = ("a`tb" + [char]7 + ('z' * 900)); catalogVersion = '../../etc' })
        $r.Status | Should -Be 200
        $s = ($r.Body | ConvertFrom-Json).snapshot
        $s.name | Should -Match '^Line one line two n+$'
        $s.name.Length | Should -Be 80
        $s.note.Length | Should -Be 500
        $s.note | Should -Match '^a b z'
        $s.catalogVersion | Should -Be ''
    }
}

Describe 'Automatic snapshots' {
    It 'takes at most one automatic snapshot per 10 minutes, but always the one before a restore' {
        $t = [datetime]::new(2026, 11, 8, 10, 0, 0, [DateTimeKind]::Utc)
        (SendAt 'fleet-auto' (Body 'auto' (Page 'fleet-auto') @{ reason = 'Tidy up' }) $t).Status | Should -Be 200
        $again = SendAt 'fleet-auto' (Body 'auto' (Page 'fleet-auto') @{ reason = 'Redraft whole page' }) $t.AddMinutes(9)
        $again.Status | Should -Be 200
        ($again.Body | ConvertFrom-Json).skipped | Should -Be 'recent'
        (SendAt 'fleet-auto' (Body 'restore' (Page 'fleet-auto') @{ reason = 'Before restoring' }) $t.AddMinutes(9.5)).Body | Should -Match '"kind":"restore"'
        $later = SendAt 'fleet-auto' (Body 'auto' (Page 'fleet-auto') @{ reason = 'Layout' }) $t.AddMinutes(10)
        ($later.Body | ConvertFrom-Json).snapshot.reason | Should -Be 'Layout'
        @(List 'fleet-auto' | ForEach-Object { $_.kind }) | Should -Be @('auto', 'restore', 'auto')
    }

    It 'keeps the last 30 automatic snapshots and every named one' {
        $t = [datetime]::new(2026, 11, 9, 8, 0, 0, [DateTimeKind]::Utc)
        (SendAt 'fleet-keep' (Body 'named' (Page 'fleet-keep') @{ name = 'Keep me' }) $t).Status | Should -Be 200
        for ($i = 1; $i -le 34; $i++) {
            $kind = 'auto'; if ($i % 2 -eq 0) { $kind = 'restore' }
            (SendAt 'fleet-keep' (Body $kind (Page 'fleet-keep') @{ reason = "step $i" }) $t.AddMinutes(11 * $i)).Status | Should -Be 200
        }
        $list = @(List 'fleet-keep')
        @($list | Where-Object { $_.kind -ne 'named' }).Count | Should -Be 30
        @($list | Where-Object { $_.kind -eq 'named' }).Count | Should -Be 1
        $list[0].reason | Should -Be 'step 34'
        @($list | Where-Object { $_.kind -ne 'named' })[-1].reason | Should -Be 'step 5'
        # The pruned ones are gone, both files.
        @(Get-ChildItem -LiteralPath ([IO.Path]::Combine($script:Sem.Home, 'snapshots', 'fleet-keep')) -File).Count | Should -Be 62
    }

    It 'refuses a named snapshot past the cap with 409' {
        $was = $script:SemSnapMaxNamed
        $script:SemSnapMaxNamed = 2
        try {
            (Send 'POST' '/api/page-snapshots/fleet-cap' (Body 'named' (Page 'fleet-cap') @{ name = 'one' })).Status | Should -Be 200
            (Send 'POST' '/api/page-snapshots/fleet-cap' (Body 'named' (Page 'fleet-cap') @{ name = 'two' })).Status | Should -Be 200
            $r = Send 'POST' '/api/page-snapshots/fleet-cap' (Body 'named' (Page 'fleet-cap') @{ name = 'three' })
            $r.Status | Should -Be 409
            ($r.Body | ConvertFrom-Json).code | Should -Be 'too-many'
            (Send 'POST' '/api/page-snapshots/fleet-cap' (Body 'restore' (Page 'fleet-cap'))).Status | Should -Be 200
        } finally { $script:SemSnapMaxNamed = $was }
    }
}
