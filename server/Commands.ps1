#requires -Version 5.1
# =============================================================================
# Semaphore's command registry: every browser action that touches the server has a
# `semaphore <noun> <verb>` command, the same list is served at GET /api/commands, and the CLI
# (Invoke-SemaphoreCli.ps1, Semaphore-CLI.bat) runs them. Fleet CLI parity, as PacketRat and Bowerbird do it.
#
# The CLI works in-process on the same files and functions the server uses (the document store, the source
# list, the AI status): it needs no running server and no session token, which never leaves the server.
# Only headless work is offered: documents, sources, AI status, the snapshot refresh and stopping a running copy.
# Routes that exist only for the browser session are listed in $script:SemUiOnlyRoutes with the reason; the parity
# test (tests/server/Commands.Tests.ps1) fails when a route in Routes.ps1 or a /api path in the UI is in neither list.
# =============================================================================

$script:SemDocKinds = [ordered]@{ hoist = 'hoists'; catalog = 'catalogs'; playbook = 'playbook'; snapshot = 'snapshots'; question = 'questions'; team = 'team' }

# Routes the browser uses that have no command, and why. Each key is matched like a route in Routes.ps1.
$script:SemUiOnlyRoutes = [ordered]@{
    '/api/heartbeat'                 = 'Browser presence for auto-stop: a CLI is not a tab.'
    '/api/leaving'                   = 'Browser presence for auto-stop (sendBeacon on page close).'
    '/api/launch'                    = 'Trades the launch link''s single-use code for the browser session token.'
    '/api/end'                       = 'Ends a browser session; the CLI equivalent is "semaphore session stop".'
    '/api/query'                     = 'Runs SQL the page plans and holds the session token; the headless route is "refresh run".'
    '/api/profile'                   = 'Profiles a source for the page''s catalog editor.'
    '/api/ai/check'                  = 'Checks the Fairlead key from the page; "ai status" reports the same without sending the key.'
    '/api/ai/v1/chat/completions'    = 'Relay for the page''s drafting requests: needs the browser session token.'
}

function New-SemCommandInput {
    param([string]$Flag, [string]$Type = 'string', [bool]$Required = $false, [string]$Help = '')
    return [pscustomobject]@{ flag = $Flag; name = $Flag; type = $Type; required = $Required; help = $Help }
}

function Get-SemCommandRegistry {
    $list = New-Object System.Collections.Generic.List[object]
    $add = {
        param([string]$Name, [string]$Route, [string]$Method, [string]$Summary, [object[]]$Inputs = @(), [bool]$Destructive = $false, [string]$Handler)
        $list.Add([pscustomobject]@{ name = "semaphore $Name"; route = $Route; method = $Method; summary = $Summary; inputs = @($Inputs); destructive = $Destructive; handler = $Handler })
    }
    & $add 'commands' '/api/commands' 'GET' 'List every command, with its options. Add --json for the versioned schema.' @() $false 'Commands'
    & $add 'info show' '/api/info' 'GET' 'Version, the Semaphore folder and the sources named in sources.json (never a connection string or a secret).' @() $false 'Info'
    & $add 'source list' '/api/info' 'GET' 'The sources in sources.json: id, label, kind and provider.' @() $false 'Sources'
    foreach ($noun in $script:SemDocKinds.Keys) {
        $kind = $script:SemDocKinds[$noun]
        & $add "$noun list" "/api/$kind" 'GET' "List saved $kind (id, title, updated)." @() $false 'DocList'
        & $add "$noun get" "/api/$kind/{id}" 'GET' "Print one saved $noun as JSON." @((New-SemCommandInput 'id' 'string' $true "The $noun id.")) $false 'DocGet'
        & $add "$noun put" "/api/$kind/{id}" 'PUT' "Save a $noun from a JSON file (an object with `"version`": 1, at most 2 MB). Replaces a $noun with the same id." @((New-SemCommandInput 'id' 'string' $true "The $noun id."), (New-SemCommandInput 'file' 'string' $true 'The JSON file to save.')) $true 'DocPut'
        & $add "$noun delete" "/api/$kind/{id}" 'DELETE' "Remove a $noun. It is moved to the .trash folder, not erased." @((New-SemCommandInput 'id' 'string' $true "The $noun id.")) $true 'DocDelete'
    }
    & $add 'refresh run' '(starts Start-Semaphore.ps1 --refresh)' 'POST' 'Refresh every playbook snapshot headless and stop (the same run as --refresh). Needs a machine that can reach the sources; it refuses when Semaphore is already open.' @() $false 'RefreshRun'
    & $add 'refresh report' '/api/refresh-report' 'GET' 'The report of the last snapshot refresh.' @() $false 'RefreshReport'
    & $add 'vault status' '/api/vault' 'GET' 'Whether Lazarette is found for sources that name a vault item, and which source names which item. Never a secret. (A running Semaphore also says whether the vault is unlocked.)' @() $false 'VaultStatus'
    & $add 'ai status' '/api/ai' 'GET' 'Whether drafting goes through Fairlead, the address and which key source is used. Never prints the key.' @() $false 'AiStatus'
    & $add 'session stop' '(runs Stop-Semaphore.ps1)' 'POST' 'Stop every running copy of Semaphore on this computer.' @() $true 'SessionStop'
    return $list.ToArray()
}

function Get-SemCommandList {
    # The shape of GET /api/commands and of `commands --json` (schema semaphore.commands/1).
    $cmds = @(Get-SemCommandRegistry | ForEach-Object {
            [ordered]@{ name = $_.name; route = $_.route; method = $_.method; summary = $_.summary; destructive = $_.destructive; inputs = @($_.inputs | ForEach-Object { [ordered]@{ flag = '--' + $_.flag; type = $_.type; required = $_.required; help = $_.help } }) }
        })
    $ui = @($script:SemUiOnlyRoutes.Keys | ForEach-Object { [ordered]@{ route = $_; reason = $script:SemUiOnlyRoutes[$_] } })
    return [ordered]@{ schema = 'semaphore.commands/1'; commands = $cmds; uiOnly = $ui }
}

function Find-SemCommand {
    param([string]$Name)
    $n = ('semaphore ' + $Name.Trim().ToLowerInvariant()).Trim()
    foreach ($c in (Get-SemCommandRegistry)) { if ($c.name -eq $n) { return $c } }
    return $null
}

function Test-SemRouteCovered {
    # $true when $Route (a path as the UI or the dispatcher writes it, {id} or a literal id inside) is a command route or UI-only.
    param([string]$Route)
    foreach ($c in (Get-SemCommandRegistry)) {
        if ($c.route -eq $Route) { return $true }
        $rx = '^' + [regex]::Escape($c.route).Replace('\{id}', '[^/]+') + '$'
        if ($c.route.StartsWith('/api/') -and $Route -match $rx) { return $true }
    }
    return $script:SemUiOnlyRoutes.Contains($Route)
}

function ConvertTo-SemCommandResult {
    param([bool]$Ok, $Result = $null, [string]$Error = '', [string]$Text = '')
    return @{ Ok = $Ok; Result = $Result; Error = $Error; Text = $Text }
}

function Invoke-SemCommand {
    <#
      Runs one command in this process. Returns @{ Ok; Result; Error; Text; Usage } where Usage is $true for a
      mistake in the command line (exit code 2). Nothing is written without --yes for destructive commands, and
      --dry-run only reports what would be done.
    #>
    param([Parameter(Mandatory = $true)]$Command, [hashtable]$Options = @{}, [bool]$Yes = $false, [bool]$DryRun = $false, [string]$HomeDir, [string]$Root = (Get-SemRoot))
    $r = { param($ok, $result, $err, $text, $usage) @{ Ok = $ok; Result = $result; Error = $err; Text = $text; Usage = $usage } }
    foreach ($i in $Command.inputs) {
        if ($i.required -and -not $Options.ContainsKey($i.flag)) { return (& $r $false $null "'$($Command.name)' needs --$($i.flag)." '' $true) }
    }
    foreach ($k in $Options.Keys) {
        if (@($Command.inputs | Where-Object { $_.flag -eq $k }).Count -eq 0) { return (& $r $false $null "'$($Command.name)' has no option --$k." '' $true) }
    }
    $id = [string]$Options['id']
    if ($Options.ContainsKey('id') -and -not (Test-SemDocId $id)) { return (& $r $false $null 'Invalid id: use 1 to 64 letters, digits, _ or -.' '' $true) }
    if ($Command.destructive -and -not $Yes -and -not $DryRun) { return (& $r $false $null "'$($Command.name)' changes saved data. Add --yes to go ahead, or --dry-run to see what it would do." '' $true) }
    if ($DryRun) {
        $shown = [ordered]@{}; foreach ($k in $Options.Keys) { $shown[$k] = $Options[$k] }
        return (& $r $true ([ordered]@{ dryRun = $true; route = $Command.route; method = $Command.method; options = $shown; destructive = $Command.destructive }) '' ("Would run '$($Command.name)'.") $false)
    }
    $script:Sem.Home = $HomeDir
    $kind = $null
    foreach ($noun in $script:SemDocKinds.Keys) { if ($Command.name -like "semaphore $noun *") { $kind = $script:SemDocKinds[$noun]; $noun0 = $noun } }
    try {
        switch ($Command.handler) {
            'Commands' { return (& $r $true (Get-SemCommandList) '' '' $false) }
            'Info' {
                $src = @(Get-SemSources -HomeDir $HomeDir | ForEach-Object { [ordered]@{ id = $_.id; label = $_.label; kind = $_.kind; provider = $_.provider } })
                return (& $r $true ([ordered]@{ tool = 'semaphore'; version = (Get-SemVersion -Root $Root); home = $HomeDir; sources = $src }) '' '' $false)
            }
            'Sources' { return (& $r $true @(Get-SemSources -HomeDir $HomeDir | ForEach-Object { [ordered]@{ id = $_.id; label = $_.label; kind = $_.kind; provider = $_.provider } }) '' '' $false) }
            'DocList' { $docs = Get-SemDocList -Dir (Get-SemDocDir -Kind $kind -HomeDir $HomeDir); return (& $r $true $docs '' '' $false) }
            'DocGet' {
                $text = Read-SemDoc -Dir (Get-SemDocDir -Kind $kind -HomeDir $HomeDir) -Id $id
                if ($null -eq $text) { return (& $r $false $null "No $noun0 '$id'." '' $false) }
                return (& $r $true ($text | ConvertFrom-Json) '' '' $false)
            }
            'DocPut' {
                $path = [IO.Path]::GetFullPath([string]$Options['file'])
                if (-not [IO.File]::Exists($path)) { return (& $r $false $null "No file $path." '' $true) }
                $bytes = [IO.File]::ReadAllBytes($path)
                if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $bytes = $bytes[3..($bytes.Length - 1)] }
                $problem = Test-SemDocBody -Bytes $bytes
                if ($problem -eq 'too-large') { return (& $r $false $null "A $noun0 may be at most 2 MB." '' $false) }
                if ($problem) { return (& $r $false $null $problem '' $false) }
                Save-SemDoc -Dir (Get-SemDocDir -Kind $kind -HomeDir $HomeDir) -Id $id -Bytes $bytes
                return (& $r $true ([ordered]@{ id = $id; saved = $true }) '' "Saved $noun0 '$id'." $false)
            }
            'DocDelete' {
                if (-not (Remove-SemDoc -Dir (Get-SemDocDir -Kind $kind -HomeDir $HomeDir) -Id $id)) { return (& $r $false $null "No $noun0 '$id'." '' $false) }
                return (& $r $true ([ordered]@{ id = $id; movedToTrash = $true }) '' "Removed $noun0 '$id' (kept in .trash)." $false)
            }
            'RefreshReport' {
                $file = Join-Path (Get-SemDocDir -Kind 'snapshots' -HomeDir $HomeDir) '.last-refresh.json'
                if (-not [IO.File]::Exists($file)) { return (& $r $false $null 'No refresh has run yet.' '' $false) }
                return (& $r $true ([IO.File]::ReadAllText($file, [Text.Encoding]::UTF8) | ConvertFrom-Json) '' '' $false)
            }
            'VaultStatus' {
                $uses = @(Get-SemSources -HomeDir $HomeDir | ForEach-Object { $n = Get-SemVaultNeeds $_; if ($n) { '{0} -> {1}' -f $_.id, $n.Item } })
                return (& $r $true ([ordered]@{ lazarette = [bool](Get-SemLazaretteLibPath -Root $Root); unlocked = $false; sources = $uses; note = 'A command-line run never unlocks the vault; unlock it in the console that starts Semaphore.' }) '' '' $false)
            }
            'AiStatus' { return (& $r $true (Get-SemAiStatus) '' '' $false) }
            'RefreshRun' {
                if (@(Get-SemInstances -Root $Root).Count -gt 0) { return (& $r $false $null 'Semaphore is open on this computer; it refreshes snapshots itself. Close it first, or use it.' '' $false) }
                $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'server\Start-Semaphore.ps1'), '--refresh') -Wait -PassThru -WindowStyle Hidden
                return (& $r ($p.ExitCode -eq 0) ([ordered]@{ exitCode = $p.ExitCode }) $(if ($p.ExitCode -ne 0) { "The refresh run exited with code $($p.ExitCode)." } else { '' }) 'The refresh run finished. See "refresh report".' $false)
            }
            'SessionStop' {
                $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'server\Stop-Semaphore.ps1')) -Wait -PassThru -WindowStyle Hidden
                return (& $r ($p.ExitCode -eq 0) ([ordered]@{ exitCode = $p.ExitCode }) $(if ($p.ExitCode -ne 0) { "Stop-Semaphore.ps1 exited with code $($p.ExitCode)." } else { '' }) 'Stopped.' $false)
            }
        }
    } catch { return (& $r $false $null $_.Exception.Message '' $false) }
    return (& $r $false $null "No handler for '$($Command.name)'." '' $false)
}
