#requires -Version 5.1
<#
.SYNOPSIS
  Semaphore from the command line (Fleet CLI parity): the headless actions of the browser UI, by name.
.DESCRIPTION
  Started by Semaphore-CLI.bat:
    Semaphore-CLI.bat <noun> <verb> [--option value ...] [--json] [--out <file>] [--yes] [--dry-run]
    Semaphore-CLI.bat commands [--json]
  The commands work in this process on the Semaphore folder (documents, sources, snapshots), so no running server and
  no session token are needed. The list is the same one the server serves at GET /api/commands (server\Commands.ps1).
  --json      print one JSON document (schema semaphore.result/1, or semaphore.commands/1 for commands)
  --out FILE  write that JSON to FILE as UTF-8 without a BOM (Windows PowerShell 5.1's > would write UTF-16)
  --yes       required for commands that change saved data (put, delete, session stop)
  --dry-run   check the command and its options and show what it would do, without doing it
  Exit codes: 0 success, 1 the command failed, 2 a usage error. Nothing waits on a dialog. ASCII only.
#>
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path -Parent $here
$cliArgs = @($args | ForEach-Object { [string]$_ })
foreach ($f in 'Common.ps1', 'Http.ps1', 'Routes.ps1', 'Query.ps1', 'Intelligence.ps1', 'Lake.ps1', 'Vault.ps1', 'Connectors.ps1', 'LocalDb.ps1', 'S3.ps1', 'LocalScript.ps1', 'Pipeline.ps1', 'Alerts.ps1', 'Mail.ps1', 'Commands.ps1') { . (Join-Path $here $f) }
$utf8 = New-Object System.Text.UTF8Encoding $false

$words = New-Object System.Collections.Generic.List[string]
$i = 0
while ($i -lt $cliArgs.Count -and -not $cliArgs[$i].StartsWith('--')) { $words.Add($cliArgs[$i].ToLowerInvariant()); $i++ }
$global = @{ json = $false; yes = $false; 'dry-run' = $false; out = $null; help = $false }
$options = @{}
$rest = @(if ($i -lt $cliArgs.Count) { $cliArgs[$i..($cliArgs.Count - 1)] })

function Write-SemCliOutput([object]$Document, [int]$Code, [string]$Text, [string]$RawResult = '') {
    # $RawResult: a stored document's own JSON text, spliced in as "result" unchanged (no depth cut, no respelling).
    $json = ConvertTo-Json -InputObject $Document -Depth 15 -Compress
    if ($RawResult) { $json = $json.Substring(0, $json.Length - 1) + ',"result":' + $RawResult + '}' }
    if ($global.out) {
        [IO.File]::WriteAllText([IO.Path]::GetFullPath([string]$global.out), $json, $utf8)
        if (-not $global.json) { Write-Host ('Wrote ' + [IO.Path]::GetFullPath([string]$global.out)) }
    }
    if ($global.json -and -not $global.out) { [Console]::Out.WriteLine($json) }
    elseif (-not $global.json -and $Text) { Write-Host $Text }
    exit $Code
}
function Exit-SemUsage([string]$Message) {
    if ($global.json -or $global.out) { Write-SemCliOutput ([ordered]@{ schema = 'semaphore.result/1'; command = ('semaphore ' + ($words -join ' ')).Trim(); ok = $false; error = $Message }) 2 '' }
    [Console]::Error.WriteLine($Message)
    [Console]::Error.WriteLine('Run: Semaphore-CLI.bat commands')
    exit 2
}

$boolFlags = @('json', 'yes', 'dry-run', 'help')
for ($j = 0; $j -lt $rest.Count; $j++) {
    $tok = $rest[$j]
    if (-not $tok.StartsWith('--')) { Exit-SemUsage "Unexpected argument '$tok'. Options look like --name value." }
    $key = $tok.Substring(2); $val = $null
    $eq = $key.IndexOf('=')
    if ($eq -ge 0) { $val = $key.Substring($eq + 1); $key = $key.Substring(0, $eq) }
    elseif ($boolFlags -contains $key) { $val = $true }
    else {
        if ($j + 1 -ge $rest.Count) { Exit-SemUsage "--$key needs a value." }
        $j++; $val = $rest[$j]
    }
    if ($global.ContainsKey($key)) { $global[$key] = $val } else { $options[$key] = $val }
}
foreach ($k in @('json', 'yes', 'dry-run', 'help')) { $global[$k] = ($global[$k] -eq $true -or [string]$global[$k] -match '^(1|true|yes)$') }

if ($words.Count -eq 0 -or $words[0] -eq 'help') {
    $words.Clear(); $words.Add('commands')
}
if ($words.Count -eq 1 -and $words[0] -eq 'commands') {
    $doc = Get-SemCommandList
    $text = ($doc.commands | ForEach-Object {
            $flags = ($_.inputs | ForEach-Object { if ($_.required) { $_.flag + ' <' + $_.type + '>' } else { '[' + $_.flag + ']' } }) -join ' '
            '  ' + $_.name.Substring(10).PadRight(20) + $_.summary + $(if ($flags) { "`r`n" + (' ' * 24) + $flags } else { '' }) + $(if ($_.destructive) { '  (needs --yes)' } else { '' })
        }) -join "`r`n"
    Write-SemCliOutput $doc 0 ("Semaphore commands (Semaphore-CLI.bat <noun> <verb> [options]; add --json, --out <file>, --yes, --dry-run):`r`n" + $text)
}

$command = Find-SemCommand ($words -join ' ')
if (-not $command -and $words.Count -ge 3 -and -not $options.ContainsKey('id')) {
    # "pipeline run nightly": a last word that is not part of the command is its --id.
    $c2 = Find-SemCommand (($words | Select-Object -First ($words.Count - 1)) -join ' ')
    if ($c2 -and @($c2.inputs | Where-Object { $_.flag -eq 'id' }).Count -gt 0) { $command = $c2; $options['id'] = $cliArgs[$words.Count - 1] }
}
if (-not $command) { Exit-SemUsage "Unknown command '$($words -join ' ')'." }
$settings = Read-SemSettings -Root $root
$homeDir = Resolve-SemHome -Settings $settings -Create
$script:Sem.Root = $root
$res = Invoke-SemCommand -Command $command -Options $options -Yes $global.yes -DryRun $global['dry-run'] -HomeDir $homeDir -Root $root
if ($res.Usage) { Exit-SemUsage $res.Error }
$doc = [ordered]@{ schema = 'semaphore.result/1'; command = $command.name; ok = $res.Ok }
$raw = ''
if ($res.Ok -and $res.ContainsKey('Raw') -and $res.Raw) { $raw = [string]$res.Raw }   # "get": the stored text itself
elseif ($res.Ok) { $doc.result = $res.Result } else { $doc.error = $res.Error }
$text = if ($res.Ok) { if ($res.Text) { $res.Text } elseif ($raw) { $raw } else { ConvertTo-Json -InputObject $res.Result -Depth 6 } } else { '' }
if (-not $res.Ok -and -not $global.json -and -not $global.out) { [Console]::Error.WriteLine('Semaphore: ' + $res.Error) }
Write-SemCliOutput $doc $(if ($res.Ok) { 0 } else { 1 }) $text $raw
