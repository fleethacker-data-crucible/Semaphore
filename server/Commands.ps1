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
    '/api/client-log'                = 'The page reports its own script errors to the server log; a CLI reports its errors itself.'
    '/api/vault/pair'                = 'The Settings screen''s pairing box; the CLI equivalent is "vault pair", which reads the code without showing it.'
    '/api/vault/unpair'              = 'The Settings screen''s Unpair button; the CLI equivalent is "vault unpair".'
    '/api/voice'                     = 'The Settings screen''s spoken answers card: the TalkForge address and where the token comes from.'
    '/api/voice/speak'               = 'Relay for the page''s spoken answers: needs the browser session token and returns audio.'
    '/api/local/import'              = 'Streams a file the analyst picks or drops on the page into the local database; the CLI reads files where they are with "local import".'
    '/api/local/import-cancel'       = 'The Stop button of an import running on the server; a CLI import runs in the foreground and stops with Ctrl+C.'
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
    & $add 'vault status' '/api/vault' 'GET' 'Whether Semaphore is paired with Lazarette, whether Lazarette is running and unlocked, which source reads which share, and which shares Lazarette has for Semaphore. Names only, never a secret.' @() $false 'VaultStatus'
    & $add 'vault pair' '(asks for the pairing code)' 'POST' 'Pair Semaphore with Lazarette: paste the code from Lazarette (Settings > Tools > Pair tool). It is read without echo and kept DPAPI-protected for this Windows account.' @() $false 'VaultPair'
    & $add 'vault unpair' '(removes the pairing file)' 'POST' 'Forget the Lazarette pairing on this computer (pair again with "vault pair"). Remove Semaphore in Lazarette (Settings > Tools) too.' @() $false 'VaultUnpair'
    & $add 'ai status' '/api/ai' 'GET' 'Whether drafting goes through Fairlead, the address and which key source is used. Never prints the key.' @() $false 'AiStatus'
    & $add 'local list' '/api/local/tables' 'GET' 'The tables in the local database: rows, columns, size and the file each came from.' @() $false 'LocalList'
    & $add 'local import' '/api/local/import-path' 'POST' 'Import a CSV, TSV, Excel, SQLite, Parquet or Arrow file (also .gz) into the local database. Network paths only on shares listed in settings localShares.' @((New-SemCommandInput 'file' 'string' $true 'The file to import.'), (New-SemCommandInput 'table' 'string' $false 'The table name (default: from the file name).'), (New-SemCommandInput 'sheet' 'string' $false 'The Excel sheet, or the table inside a SQLite file.'), (New-SemCommandInput 'replace' 'string' $false 'yes: replace a table of that name in one step.'), (New-SemCommandInput 'append' 'string' $false 'yes: add the rows to a table of that name (columns matched by name).')) $false 'LocalImport'
    & $add 'local sheets' '/api/local/sheets' 'POST' 'The sheets of an Excel workbook, or the tables of a SQLite file.' @((New-SemCommandInput 'file' 'string' $true 'The workbook or SQLite file.')) $false 'LocalSheets'
    & $add 'local status' '/api/local/import-status/{id}' 'GET' 'Progress of an import the page started (rows so far, table, error).' @((New-SemCommandInput 'id' 'string' $true 'The import job id.')) $false 'LocalStatus'
    & $add 'local rename' '/api/local/tables/{id}/rename' 'POST' 'Rename a table in the local database (flags that read the old name need their catalog updated).' @((New-SemCommandInput 'id' 'string' $true 'The table.'), (New-SemCommandInput 'to' 'string' $true 'The new name.')) $false 'LocalRename'
    & $add 'local delete' '/api/local/tables/{id}' 'DELETE' 'Drop a table from the local database. It cannot be undone: import the file again to get it back.' @((New-SemCommandInput 'id' 'string' $true 'The table.')) $true 'LocalDelete'
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
                # Result is the parsed object for callers in this process; Raw is the stored text, which the CLI
                # prints and writes unchanged (ConvertTo-Json would cut deep documents at its depth and respell the rest).
                $text = Read-SemDoc -Dir (Get-SemDocDir -Kind $kind -HomeDir $HomeDir) -Id $id
                if ($null -eq $text) { return (& $r $false $null "No $noun0 '$id'." '' $false) }
                $out = & $r $true ($text | ConvertFrom-Json) '' '' $false
                $out.Raw = $text.TrimStart([char]0xFEFF).Trim()
                return $out
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
                $text = [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8)
                $out = & $r $true ($text | ConvertFrom-Json) '' '' $false
                $out.Raw = $text.TrimStart([char]0xFEFF).Trim()
                return $out
            }
            'VaultStatus' { return (& $r $true (Get-SemVaultStatus -HomeDir $HomeDir) '' '' $false) }
            'VaultPair' {
                # Read-Host -AsSecureString: the code is not echoed and never reaches a transcript, a log or the output.
                $code = Read-Host -Prompt 'Pairing code from Lazarette (Settings > Tools > Pair tool)' -AsSecureString
                if ($null -eq $code -or $code.Length -eq 0) { return (& $r $false $null 'No pairing code was entered.' '' $false) }
                try { $path = Register-SemVaultPairing -Code $code } finally { $code.Dispose() }
                return (& $r $true ([ordered]@{ paired = $true; file = $path }) '' ('Semaphore is paired with Lazarette. Now share each item a source names with Semaphore in Lazarette (Settings > Tools), then run: Semaphore-CLI.bat vault status') $false)
            }
            'VaultUnpair' {
                $gone = Unregister-SemVaultPairing
                return (& $r $true ([ordered]@{ removed = $gone }) '' $(if ($gone) { 'The Lazarette pairing is removed from this computer.' } else { 'There was no Lazarette pairing on this computer.' }) $false)
            }
            'AiStatus' { return (& $r $true (Get-SemAiStatus) '' '' $false) }
            'LocalList' { return (& $r $true (Get-SemLocalTables -HomeDir $HomeDir) '' '' $false) }
            'LocalImport' {
                $shares = @((Read-SemSettings -Root $Root).localShares)
                $res = Resolve-SemLocalPath -Path ([string]$Options['file']) -Shares $shares -HomeDir $HomeDir
                if ($res.ContainsKey('Error')) { return (& $r $false $null $res.Error '' $false) }
                $a = @{ HomeDir = $HomeDir; Path = $res.Path; SourceLabel = $res.Path }
                if ($Options['table']) { $a.Table = [string]$Options['table'] }
                if ($Options['sheet']) { $a.Sheet = [string]$Options['sheet'] }
                if (@('yes', 'true', '1') -contains ([string]$Options['replace']).ToLowerInvariant()) { $a.Replace = $true }
                if (@('yes', 'true', '1') -contains ([string]$Options['append']).ToLowerInvariant()) { $a.Append = $true }
                $imp = Import-SemLocalFile @a
                return (& $r $true ([ordered]@{ table = $imp.Table; rows = $imp.Rows; columns = $imp.Columns; ms = $imp.Ms; tables = $imp.Tables; warnings = $imp.Warnings }) '' ("Imported {0} rows into {1} in {2:N1} s." -f $imp.Rows, $imp.Table, ($imp.Ms / 1000.0)) $false)
            }
            'LocalSheets' {
                $res = Resolve-SemLocalPath -Path ([string]$Options['file']) -Shares @((Read-SemSettings -Root $Root).localShares) -HomeDir $HomeDir
                if ($res.ContainsKey('Error')) { return (& $r $false $null $res.Error '' $false) }
                return (& $r $true (Get-SemLocalSheets -HomeDir $HomeDir -Path $res.Path) '' '' $false)
            }
            'LocalStatus' {
                $text = Read-SemLocalJobStatus -HomeDir $HomeDir -Job $id
                if ($null -eq $text) { return (& $r $false $null "No import '$id'." '' $false) }
                return (& $r $true ($text | ConvertFrom-Json) '' '' $false)
            }
            'LocalRename' {
                $ok = Rename-SemLocalTable -HomeDir $HomeDir -Name $id -NewName ([string]$Options['to'])
                if (-not $ok) { return (& $r $false $null "No table '$id'." '' $false) }
                return (& $r $true ([ordered]@{ name = [string]$Options['to'] }) '' ("Renamed {0} to {1}." -f $id, $Options['to']) $false)
            }
            'LocalDelete' {
                if (-not (Remove-SemLocalTable -HomeDir $HomeDir -Name $id)) { return (& $r $false $null "No table '$id'." '' $false) }
                return (& $r $true ([ordered]@{ name = $id; dropped = $true }) '' "Dropped table '$id'." $false)
            }
            'RefreshRun' {
                if (@(Get-SemInstances -Root $Root).Count -gt 0) { return (& $r $false $null 'Semaphore is open on this computer; it refreshes snapshots itself. Close it first, or use it.' '' $false) }
                $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'server\Start-Semaphore.ps1'), '--refresh') -Wait -PassThru -WindowStyle Hidden
                $code = [int]$p.ExitCode
                $why = ''
                if ($code -eq 3) { $why = 'Another Semaphore was already running on this computer, so nothing was refreshed. Close it first, or use it.' }
                elseif ($code -ne 0) { $why = "The refresh run exited with code $code." }
                return (& $r ($code -eq 0) ([ordered]@{ exitCode = $code }) $why 'The refresh run finished. See "refresh report".' $false)
            }
            'SessionStop' {
                $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'server\Stop-Semaphore.ps1')) -Wait -PassThru -WindowStyle Hidden
                return (& $r ($p.ExitCode -eq 0) ([ordered]@{ exitCode = $p.ExitCode }) $(if ($p.ExitCode -ne 0) { "Stop-Semaphore.ps1 exited with code $($p.ExitCode)." } else { '' }) 'Stopped.' $false)
            }
        }
    } catch { return (& $r $false $null $_.Exception.Message '' $false) }
    return (& $r $false $null "No handler for '$($Command.name)'." '' $false)
}
