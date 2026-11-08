#requires -Version 5.1
# =============================================================================
# Database secrets and AWS sessions from Lazarette, read BY NAME over this computer's loopback
# (Lazarette docs/TOOLS.md). Semaphore never loads the Lazarette engine and never holds the vault key:
# server/Lazarette.Client.ps1 (a copy of Lazarette's tools/Lazarette.Client.ps1) sends a one-time HMAC
# proof to POST /peer/tools/v1/secrets on the running Lazarette and opens the sealed answer.
#
# Set up once: Lazarette > Settings > Tools > Pair tool "Semaphore", then `Semaphore-CLI.bat vault pair`
# (the code is read without echo and kept DPAPI-protected for this Windows account). In Lazarette,
# share each item with Semaphore under the variable name a source asks for.
#
# A source in <home>\sources.json names one shared VARIABLE per role, never a secret and never an item:
#   { "id": "maint", "kind": "postgres", "provider": "odbc", "connection": "Driver={PostgreSQL Unicode};Server=db;Database=maint",
#     "vault": { "password": "SMDATS_PASSWORD", "user": "SMDATS_USER" } }
#   { "id": "lake", "kind": "aws-athena", "provider": "athena", "region": "us-gov-west-1", "database": "maint",
#     "vault": { "accessKeyId": "AWS_ACCESS_KEY_ID", "secretAccessKey": "AWS_SECRET_ACCESS_KEY", "sessionToken": "AWS_SESSION_TOKEN" } }
# Roles per provider ($script:SemVaultRoles). A required role with no value stops the request with a sentence;
# an optional role with no value leaves a note (in the log, on the query answer and on a connect error).
#
# Lazarette Lite fallback (secret-only, docs/VAULT.md): when Lazarette is not running, Resolve-SemVaultSecrets
# falls back to Lazarette Lite by variable name (Get-SemVaultLiteSecrets below). Only the
# vault-unavailable error falls back; pairing, lock, rate-limit and seal errors never do.
# The main loop reads the secrets for the one source a request names (Resolve-SemVaultSecrets, the one seam)
# and hands the values to the worker with that request. They live in memory for that request only, are
# never logged, returned or written, and are scrubbed from error text (Get-SemVaultSafeText).
# =============================================================================

. (Join-Path $PSScriptRoot 'Lazarette.Client.ps1')

# The name Semaphore is paired under in Lazarette (Settings > Tools) and the pairing file's name.
$script:SemVaultTool = 'Semaphore'
# Worker side: the values the main loop resolved for this request: @{ Values = @{ role = string }; Notes = @() }. $null when the source uses no vault.
$script:SemVaultRequest = $null
# A share name as Lazarette accepts it (lib/integrations/Tools.ps1): an environment-variable name.
$script:SemVaultNameRx = '\A[A-Za-z_][A-Za-z0-9_]{0,79}\z'

# Roles per provider (synapse sources are odbc by the time they are checked). Optional roles may be left out of the block.
$script:SemVaultDbRoles = @(@{ Role = 'password'; Optional = $false }, @{ Role = 'user'; Optional = $true })
$script:SemVaultAwsRoles = @(@{ Role = 'accessKeyId'; Optional = $false }, @{ Role = 'secretAccessKey'; Optional = $false }, @{ Role = 'sessionToken'; Optional = $true })
$script:SemVaultRoles = @{
    odbc            = $script:SemVaultDbRoles
    oledb           = $script:SemVaultDbRoles
    athena          = $script:SemVaultAwsRoles
    'redshift-data' = $script:SemVaultAwsRoles
    foundry         = @(@{ Role = 'token'; Optional = $false })
}

# ---------------------------------------------------------------------------
# sources.json: the vault block
# ---------------------------------------------------------------------------
function Get-SemRawVault {
    # The "vault" block of a sources.json entry (a PSCustomObject), or $null.
    param($Raw)
    return (Get-SemJsonProp $Raw 'vault')
}

function Test-SemVaultBlock {
    # $null when the vault settings of a sources.json entry are acceptable, else the reason the source is refused.
    param($Raw, [string]$Provider)
    if ($null -ne (Get-SemJsonProp $Raw 'vaultItem')) { return '"vaultItem" is no longer read: Semaphore reads the secrets Lazarette shares with it, by variable name. Write "vault": { "password": "SMDATS_PASSWORD", "user": "SMDATS_USER" } (docs/VAULT.md).' }
    $vault = Get-SemRawVault $Raw
    if ($null -eq $vault) { return $null }
    $roles = $script:SemVaultRoles[$Provider]
    if ($null -eq $roles) { return "The $Provider provider does not use Lazarette." }
    $known = @($roles | ForEach-Object { $_.Role })
    if ($vault -isnot [Management.Automation.PSCustomObject]) { return ('The vault setting must be an object that names a Lazarette share per role, like { "' + $known[0] + '": "SMDATS_PASSWORD" }.') }
    $seen = @{}
    foreach ($p in $vault.PSObject.Properties) {
        if (@('item', 'fields') -ccontains $p.Name) { return 'vault.item and vault.fields are no longer read: name the variable each role is shared under in Lazarette, like { "password": "SMDATS_PASSWORD", "user": "SMDATS_USER" } (docs/VAULT.md).' }
        if ($known -cnotcontains $p.Name) { return ('Unknown vault role "' + $p.Name + '" for the ' + $Provider + ' provider (use ' + ($known -join ', ') + ').') }
        if ($p.Value -isnot [string] -or $p.Value -cnotmatch $script:SemVaultNameRx) { return ('vault.' + $p.Name + ' must be the variable name the item is shared under in Lazarette: letters, digits and _, not starting with a digit (for example SMDATS_PASSWORD). Never the secret itself.') }
        $u = $p.Value.ToUpperInvariant()
        if ($seen.ContainsKey($u)) { return ('vault.' + $p.Name + ' and vault.' + $seen[$u] + ' name the same share; each role needs its own.') }
        $seen[$u] = $p.Name
    }
    foreach ($r in $roles) {
        if (-not $r.Optional -and $null -eq $vault.PSObject.Properties[$r.Role]) { return ('The vault block needs "' + $r.Role + '": the variable name Lazarette shares it under.') }
    }
    return $null
}

function Get-SemSourceVault {
    # The vault block of a source from Get-SemSources (already checked), or $null.
    param($Source)
    if ($null -eq $Source -or $null -eq $Source.raw) { return $null }
    return (Get-SemRawVault $Source.raw)
}

function Get-SemVaultNeeds {
    # What the source reads from Lazarette: @{ Roles = @(@{ Role; Name; Optional }) } for the roles its block names, or $null.
    param($Source)
    $vault = Get-SemSourceVault $Source
    if ($null -eq $vault) { return $null }
    $roles = foreach ($r in @($script:SemVaultRoles[[string]$Source.provider])) {
        $name = Get-SemJsonProp $vault $r.Role
        if ($name) { @{ Role = $r.Role; Name = [string]$name; Optional = [bool]$r.Optional } }
    }
    return @{ Roles = @($roles) }
}

# ---------------------------------------------------------------------------
# The Lazarette client (main runspace)
# ---------------------------------------------------------------------------
function Test-SemVaultPaired {
    # $true when this Windows account holds a Semaphore pairing code (it is not checked against Lazarette here).
    try { return [bool](Test-LazaretteToolPairing -Tool $script:SemVaultTool) } catch { return $false }
}

function Test-SemVaultRunning {
    # $true when something listens on Lazarette's loopback port (LAZARETTE_PORT, else 8765). Sends nothing.
    $tcp = New-Object Net.Sockets.TcpClient
    try {
        $ar = $tcp.BeginConnect('127.0.0.1', (Get-LzClientPort), $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne(500)) { return $false }
        $tcp.EndConnect($ar)
        return [bool]$tcp.Connected
    } catch { return $false } finally { $tcp.Close() }
}

function Initialize-SemVault {
    # The pairing state, for the status route: @{ Paired; Problem }.
    param([string]$Root = '')
    $paired = Test-SemVaultPaired
    $problem = $null
    if (-not $paired) { $problem = 'Semaphore is not paired with Lazarette. In Lazarette open Settings > Tools, pair a tool named Semaphore, then run Semaphore-CLI.bat vault pair and paste the code.' }
    return @{ Paired = $paired; Problem = $problem }
}

function ConvertTo-SemVaultError {
    # A message thrown by Lazarette.Client.ps1 as @{ Status; Code; Message } with a sentence the analyst can act on.
    param([string]$Message, [string]$SourceId = '')
    $m = [string]$Message
    $who = 'Semaphore'; if ($SourceId) { $who = "Source '$SourceId'" }
    $pairHow = 'In Lazarette open Settings > Tools, pair Semaphore again, then run Semaphore-CLI.bat vault pair.'
    if ($m -like 'Lazarette is not running*') {
        return @{ Status = 501; Code = 'vault-unavailable'; Message = "$who takes its secrets from Lazarette, which is not running on this computer. Start Lazarette, unlock it, and try again." }
    }
    if ($m -like 'No Lazarette pairing*') {
        return @{ Status = 424; Code = 'vault-not-paired'; Message = "$who takes its secrets from Lazarette, but Semaphore is not paired with it yet. In Lazarette open Settings > Tools, pair a tool named Semaphore, then run Semaphore-CLI.bat vault pair." }
    }
    if ($m -match '\(locked\)') {
        return @{ Status = 423; Code = 'vault-locked'; Message = "$who takes its secrets from Lazarette, which is locked. Unlock Lazarette in its window and try again." }
    }
    if ($m -match '\(not-paired\)') {
        return @{ Status = 424; Code = 'vault-not-paired'; Message = "Lazarette does not know Semaphore's pairing (it was removed or paired again). $pairHow" }
    }
    if ($m -match '\(peer-unverified\)' -and $m -like '*different program*') {
        return @{ Status = 424; Code = 'vault-other-program'; Message = "Lazarette refused: a different program used Semaphore's pairing first. $pairHow" }
    }
    $safe = Get-SemVaultSafeText $m
    if ($m -match '\(rate-limited\)') { return @{ Status = 424; Code = 'vault-refused'; Message = ('Lazarette is refusing requests for a while after several failed ones: ' + $safe) } }
    if ($m -match '\(clock\)') { return @{ Status = 424; Code = 'vault-refused'; Message = "Lazarette refused the request because this computer's clock looks wrong. Check the time and try again." } }
    $for = 'Semaphore'; if ($SourceId) { $for = "source '$SourceId'" }
    return @{ Status = 424; Code = 'vault-error'; Message = ("Lazarette could not give the secrets for {0}: {1}" -f $for, $safe) }
}

function Get-SemVaultStateText {
    # Why a share has no value, from the answer's per-name state.
    param([string]$State)
    switch ($State) {
        'not-shared' { return 'it is not shared with Semaphore' }
        'empty' { return 'the shared item has no value, was deleted, or is marked PHI, PII, CUI or endpoint' }
        default { return 'Lazarette did not return it' }
    }
}

function Get-SemVaultEmptyNote {
    # The note left when an optional role resolves empty. Names the share, never a value.
    param([string]$SourceId, [string]$Role, [string]$Name, [string]$State)
    $why = Get-SemVaultStateText $State
    switch ($Role) {
        'user' { return ("Lazarette has no user for source '{0}' ({1}: {2}), so it signs in with the user in its DSN or with Windows authentication." -f $SourceId, $Name, $why) }
        'sessionToken' { return ("Lazarette has no session token for source '{0}' ({1}: {2}), so AWS requests are signed with the key pair alone." -f $SourceId, $Name, $why) }
        default { return ("Lazarette has no {0} for source '{1}' ({2}: {3}); it goes on without it." -f $Role, $SourceId, $Name, $why) }
    }
}

function Get-SemVaultPurpose {
    # The purpose Lazarette logs with each read (at most 120 characters, no control characters).
    param([string]$SourceId)
    $p = 'Semaphore query on source ' + $SourceId
    if ($p.Length -gt 120) { $p = $p.Substring(0, 120) }
    return $p
}

# ---------------------------------------------------------------------------
# Lazarette Lite fallback (secret-only, docs/VAULT.md)
# ---------------------------------------------------------------------------
# When Lazarette is not running, secret-only sources can resolve from Lazarette Lite
# (Windows Credential Manager) instead of failing with 501 vault-unavailable. Lite is
# found only through LAZARETTE_PATH, pointing at the Lite folder (LazaretteLite.psd1 at
# its root, lib\Lazarette.ps1 the shim). The shim is dot-sourced and read by variable
# name: Get-LazaretteSecret -Service <name> (the user defaults to the service, the
# Fairlead convention: a Lite item is named by the variable itself, e.g. SMDATS_PASSWORD).
# One secret per item, at most 2,560 bytes, no custom fields. Each Athena/Redshift role
# is a separate variable name in this architecture (accessKeyId, secretAccessKey,
# sessionToken), so the old -Field objection does not apply: no -Field is ever passed.
# A pairing, lock, rate-limit or seal error NEVER falls back: only 'Lazarette is not
# running' does, the same predicate ConvertTo-SemVaultError maps to 501 vault-unavailable.
function Get-SemVaultLiteRoot {
    # The Lazarette Lite folder LAZARETTE_PATH names, or $null when it does not point at one.
    $root = $env:LAZARETTE_PATH
    if (-not $root) { return $null }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'LazaretteLite.psd1'))) { return $null }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'lib\Lazarette.ps1'))) { return $null }
    return $root
}

function Get-SemVaultLiteSecrets {
    # @{ Values = @{ role = string }; Notes = @(); Store = 'lite' } from Lite, @{ Error = ... }
    # when Lite is present but a required name is missing, or $null when there is no Lite
    # here (the caller then keeps the Lazarette error). A Get-LazaretteSecret throw means the
    # name is missing in Lite (Lite throws on missing, ambiguous or empty); that is the same
    # per-name handling as the peer path: optional role -> note, required role -> absent error.
    param($Needs, [string]$SourceId)
    $root = Get-SemVaultLiteRoot
    if ($null -eq $root) { return $null }
    try { . (Join-Path $root 'lib\Lazarette.ps1') } catch { return $null }
    $values = @{}
    $notes = New-Object System.Collections.Generic.List[string]
    $absent = New-Object System.Collections.Generic.List[string]
    foreach ($r in $Needs.Roles) {
        $v = $null
        try { $v = Get-LazaretteSecret -Service $r.Name } catch { $v = $null }
        if ($null -ne $v -and ([string]$v).Length -gt 0) { $values[$r.Role] = [string]$v; continue }
        if ($r.Optional) { $notes.Add((Get-SemVaultEmptyNote -SourceId $SourceId -Role $r.Role -Name $r.Name -State 'missing')) }
        else { $absent.Add(('{0} ({1})' -f $r.Name, (Get-SemVaultStateText 'missing'))) }
    }
    if ($absent.Count -gt 0) {
        return @{ Error = @{ Status = 424; Code = 'vault-not-shared'; Message = ("Source '{0}' needs {1} from Lazarette Lite. Put the item in Lazarette Lite under that name (LAZARETTE_PATH points at the Lite folder)." -f $SourceId, ($absent -join ', ')) } }
    }
    Write-SemLog 'INFO' ("Source '{0}' read its secrets from Lazarette Lite (Lazarette is not running)." -f $SourceId)
    foreach ($n in $notes) { Write-SemLog 'WARN' $n }
    return @{ Values = $values; Notes = $notes.ToArray(); Store = 'lite' }
}

function Get-SemVaultLiteNames {
    # The variable names Lazarette Lite has (names only, never a value), or @() when there is
    # no Lite folder here or the shim will not load. For GET /api/vault.
    $root = Get-SemVaultLiteRoot
    if ($null -eq $root) { return @() }
    try { . (Join-Path $root 'lib\Lazarette.ps1') } catch { return @() }
    try { return @((Get-LiteItemNames) | ForEach-Object { [string]$_.Service }) } catch { return @() }
}

# ---------------------------------------------------------------------------
# Status (GET /api/vault, vault status): names and states only, never a value
# ---------------------------------------------------------------------------
function Get-SemVaultStatus {
    # paired / running / locked, which source reads which share, and which shares Lazarette has for Semaphore.
    # When paired and running it asks Lazarette once for every share the sources name; the values are dropped at once.
    param([string]$HomeDir)
    $sources = New-Object System.Collections.Generic.List[object]
    $names = New-Object System.Collections.Generic.List[string]
    foreach ($s in @(Get-SemSources -HomeDir $HomeDir)) {
        $n = Get-SemVaultNeeds $s
        if ($null -eq $n) { continue }
        $roles = [ordered]@{}
        foreach ($r in $n.Roles) {
            $roles[$r.Role] = $r.Name
            if (@($names | Where-Object { $_.ToUpperInvariant() -eq $r.Name.ToUpperInvariant() }).Count -eq 0) { $names.Add($r.Name) }
        }
        $sources.Add([ordered]@{ id = $s.id; shares = $roles })
    }
    $init = Initialize-SemVault
    $out = [ordered]@{ tool = $script:SemVaultTool; paired = [bool]$init.Paired; running = (Test-SemVaultRunning); locked = $null; lite = $false; store = $null; problem = $init.Problem; sources = $sources.ToArray(); shared = @(); notShared = @() }
    if (-not $out.running) {
        $out.problem = 'Lazarette is not running on this computer. Start it and unlock it.'
        if (-not $out.paired) { $out.problem += ' ' + $init.Problem }
        # Lazarette Lite fallback: when Lite answers for the names the sources name, say so
        # (shared/notShared from Lite, store 'lite'). The values are never read here.
        $liteNames = Get-SemVaultLiteNames
        if ($liteNames.Count -gt 0 -and $names.Count -gt 0) {
            $out.lite = $true
            $out.store = 'lite'
            $liteShared = New-Object System.Collections.Generic.List[string]
            $liteMissing = New-Object System.Collections.Generic.List[object]
            foreach ($n in $names) {
                if (@($liteNames | Where-Object { $_.ToUpperInvariant() -eq $n.ToUpperInvariant() }).Count -gt 0) { $liteShared.Add($n) } else { $liteMissing.Add([ordered]@{ name = $n; state = 'missing' }) }
            }
            $out.shared = $liteShared.ToArray()
            $out.notShared = $liteMissing.ToArray()
            $out.problem += ' Lazarette Lite is answering for some of these names.'
        }
    }
    if (-not $out.paired -or -not $out.running -or $names.Count -eq 0) { return $out }
    $shared = New-Object System.Collections.Generic.List[string]
    $missing = New-Object System.Collections.Generic.List[object]
    for ($i = 0; $i -lt $names.Count; $i += 32) {
        $chunk = @($names.GetRange($i, [Math]::Min(32, $names.Count - $i)))
        $got = $null
        try { $got = Get-LazaretteToolSecrets -Tool $script:SemVaultTool -Names $chunk -Purpose 'Semaphore status check' }
        catch {
            $e = ConvertTo-SemVaultError -Message ([string]$_.Exception.Message)
            $out.locked = ($e.Code -eq 'vault-locked')
            if ($e.Code -eq 'vault-unavailable') { $out.running = $false }
            $out.problem = $e.Message
            return $out
        }
        foreach ($n in $chunk) {
            $state = [string]$got['__state'][$n]
            if ($state -eq 'ok') { $shared.Add($n) } else { $missing.Add([ordered]@{ name = $n; state = $state }) }
        }
        $got = $null
    }
    $out.locked = $false
    $out.problem = $null
    $out.store = 'lazarette'
    $out.shared = $shared.ToArray()
    $out.notShared = $missing.ToArray()
    return $out
}

# ---------------------------------------------------------------------------
# Resolving a request's secrets (main runspace) and using them (worker)
# ---------------------------------------------------------------------------
function Resolve-SemVaultSecrets {
    # @{ Values = @{ role = string }; Notes = @(string) } for a source that uses Lazarette, @{ Values = $null } for one that does not,
    # or @{ Error = @{ Status; Code; Message } }. Messages and notes name shares, never a value.
    param($Source)
    $needs = Get-SemVaultNeeds $Source
    if ($null -eq $needs) { return @{ Values = $null } }
    $id = [string]$Source.id
    $names = @($needs.Roles | ForEach-Object { $_.Name })
    $got = $null
    try { $got = Get-LazaretteToolSecrets -Tool $script:SemVaultTool -Names $names -Purpose (Get-SemVaultPurpose $id) }
    catch {
        $msg = [string]$_.Exception.Message
        # Lazarette Lite fallback (secret-only): only when Lazarette is not running at all
        # (ConvertTo-SemVaultError maps 'Lazarette is not running*' to 501 vault-unavailable).
        # A pairing, lock, rate-limit or seal error never falls back: falling back there would
        # hide a real Lazarette problem behind a different store's answer.
        if ($msg -like 'Lazarette is not running*') {
            $lite = Get-SemVaultLiteSecrets -Needs $needs -SourceId $id
            if ($null -ne $lite) { return $lite }
        }
        return @{ Error = (ConvertTo-SemVaultError -Message $msg -SourceId $id) }
    }
    $values = @{}
    $notes = New-Object System.Collections.Generic.List[string]
    $absent = New-Object System.Collections.Generic.List[string]
    try {
        foreach ($r in $needs.Roles) {
            $v = $got[$r.Name]
            $state = 'missing'
            if ($null -ne $got['__state'] -and $got['__state'].ContainsKey($r.Name)) { $state = [string]$got['__state'][$r.Name] }
            if ($null -ne $v -and ([string]$v).Length -gt 0) { $values[$r.Role] = [string]$v; continue }
            if ($r.Optional) { $notes.Add((Get-SemVaultEmptyNote -SourceId $id -Role $r.Role -Name $r.Name -State $state)) }
            else { $absent.Add(('{0} ({1})' -f $r.Name, (Get-SemVaultStateText $state))) }
        }
    } finally { $got = $null }
    if ($absent.Count -gt 0) {
        $values = $null
        return @{ Error = @{ Status = 424; Code = 'vault-not-shared'; Message = ("Source '{0}' needs {1} from Lazarette. In Lazarette open Settings > Tools > Semaphore and share the item under that name." -f $id, ($absent -join ', ')) } }
    }
    foreach ($n in $notes) { Write-SemLog 'WARN' $n }
    return @{ Values = $values; Notes = $notes.ToArray() }
}

function Get-SemVaultForRequest {
    # Main loop: the vault part of a worker context for a /api/query or /api/profile request. $null when none is needed.
    param($Req, [string]$HomeDir)
    $id = [string](Get-SemJsonProp $Req.Json 'source')
    if (-not $id) { return $null }
    $src = Find-SemSource -HomeDir $HomeDir -Id $id
    if ($null -eq $src) { return $null }
    $r = Resolve-SemVaultSecrets -Source $src
    if ($r.ContainsKey('Error')) { return @{ Error = $r.Error } }
    if ($null -eq $r.Values) { return $null }
    return @{ Values = $r.Values; Notes = @($r.Notes) }
}

function Set-SemVaultRequest {
    # Worker: install the request's vault context ($null clears it).
    param($Context)
    $script:SemVaultRequest = $Context
}

function Get-SemVaultValue {
    param([string]$Role)
    $c = $script:SemVaultRequest
    if ($null -eq $c -or $null -eq $c.Values -or -not $c.Values.ContainsKey($Role)) { return $null }
    return [string]$c.Values[$Role]
}

function Get-SemVaultError {
    # Worker: the error to send when the main loop could not resolve the secrets, else $null.
    $c = $script:SemVaultRequest
    if ($null -ne $c -and $c.ContainsKey('Error')) { return $c.Error }
    return $null
}

function Get-SemVaultNotes {
    # Worker: the notes about optional roles that resolved empty (no values in them).
    $c = $script:SemVaultRequest
    if ($null -eq $c -or -not $c.ContainsKey('Notes') -or $null -eq $c.Notes) { return @() }
    return @($c.Notes)
}

function Get-SemVaultNoteText {
    # The notes as one sentence to append to an error message ('' when there are none).
    $n = @(Get-SemVaultNotes)
    if ($n.Count -eq 0) { return '' }
    return (' ' + ($n -join ' '))
}

function Get-SemVaultSecretValues {
    # Every secret of the current request (for scrubbing messages); short values are skipped so ordinary words survive.
    $c = $script:SemVaultRequest
    if ($null -eq $c -or $null -eq $c.Values) { return @() }
    return @($c.Values.Values | Where-Object { $_ -and ([string]$_).Length -ge 4 })
}

function Get-SemVaultSafeText {
    # Removes the request's secret values (and any given extra ones) from text that may reach a log or the browser.
    param([string]$Text, [string[]]$Extra = $null)
    if (-not $Text) { return '' }
    $all = @(Get-SemVaultSecretValues) + @($Extra | Where-Object { $_ -and $_.Length -ge 4 })
    foreach ($v in ($all | Sort-Object { $_.Length } -Descending)) { $Text = $Text.Replace([string]$v, '***') }
    return $Text
}

# ---------------------------------------------------------------------------
# Pairing (semaphore vault pair / unpair)
# ---------------------------------------------------------------------------
function Register-SemVaultPairing {
    # Stores the pairing code from a SecureString, DPAPI-protected the way Lazarette.Client.ps1 does it. The code is never echoed or returned.
    param([Parameter(Mandatory = $true)][Security.SecureString]$Code)
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Code)
    $plain = $null
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        if (-not $plain -or $plain.Trim() -notmatch '^lztl1\.') { throw 'That is not a Lazarette tool pairing code. In Lazarette open Settings > Tools, pair Semaphore and copy the code that starts with lztl1.' }
        return (Register-LazaretteToolPairing -Tool $script:SemVaultTool -Code $plain)
    } finally {
        $plain = $null
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Unregister-SemVaultPairing {
    return [bool](Unregister-LazaretteToolPairing -Tool $script:SemVaultTool)
}

# ---------------------------------------------------------------------------
# Connection strings
# ---------------------------------------------------------------------------
function Test-SemSecretText {
    # Credentials go into a connection string, so refuse anything that could end one entry and start another or break a line.
    param([string]$Text)
    return ($Text -cnotmatch '[\x00-\x1F\x7F]')
}

function Add-SemVaultToConnectionString {
    # Appends UID/PWD (ODBC, values in braces with } doubled) or User ID/Password (OLE DB, values in double quotes with " doubled)
    # from the vault values. The connection string in sources.json never holds a password; this one lives in memory for the call.
    param([string]$ConnectionString, [string]$Provider, [hashtable]$Values)
    if ($null -eq $Values -or $Values.Count -eq 0) { return $ConnectionString }
    $cs = $ConnectionString.TrimEnd().TrimEnd(';')
    $user = $Values['user']; $pass = $Values['password']
    foreach ($v in @($user, $pass)) { if ($v -and -not (Test-SemSecretText $v)) { throw 'A value from Lazarette contains control characters and cannot be used in a connection string.' } }
    if ($Provider -eq 'odbc') {
        if ($user -and $cs -notmatch '(?i)(^|;)\s*(UID|User ID)\s*=') { $cs += ';UID={' + $user.Replace('}', '}}') + '}' }
        if ($pass) { $cs += ';PWD={' + $pass.Replace('}', '}}') + '}' }
    } else {
        if ($user -and $cs -notmatch '(?i)(^|;)\s*User ID\s*=') { $cs += ';User ID="' + $user.Replace('"', '""') + '"' }
        if ($pass) { $cs += ';Password="' + $pass.Replace('"', '""') + '"' }
    }
    return $cs
}
