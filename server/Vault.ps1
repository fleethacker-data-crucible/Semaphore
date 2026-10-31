#requires -Version 5.1
# =============================================================================
# The Lazarette vault bridge: database secrets and AWS sessions come from the vault, not from
# files or the environment.
#
# A source in <home>\sources.json names a vault ITEM, never a secret:
#   { "id": "maint", "kind": "postgres", "provider": "odbc", "connection": "Driver={PostgreSQL Unicode};Server=db;Database=maint",
#     "vault": { "item": "maint-db" } }
#   { "id": "lake", "kind": "aws-athena", "provider": "athena", "region": "us-gov-west-1", "database": "maint",
#     "vault": { "item": "aws-semaphore" } }
# "vault.fields" renames the item's fields per role, e.g. { "user": "Login", "password": "Token" }.
# Roles and their default fields (the item's own secret is the password):
#   odbc / oledb : password = the item's secret; user = field "Username" (optional; used when the connection has no UID)
#   athena       : accessKeyId = "AccessKeyId", secretAccessKey = "SecretAccessKey", sessionToken = "SessionToken" (optional)
#
# Lazarette contract (Lazarette docs/INTEGRATION.md): lib\Arc.ps1 is dot-sourced once per process (by Start-Semaphore, only
# when a source uses the vault) and
# Get-ArcSecret reads the item. Unlocking is interactive by design, so a source that uses the vault
# needs `Launch-Semaphore.bat --console` (the passphrase is asked in that console, never in the
# browser). The vault is open only in the main runspace, so the main loop resolves the secrets for
# the one source a request names and hands the values to the worker with that request. They live in
# memory for that request only, are never logged, returned or written, and are scrubbed from error text.
# =============================================================================

$script:SemVaultState = @{ Loaded = $false; Problem = $null }
# Worker side: the values the main loop resolved for this request: role -> string. $null when the source uses no vault.
$script:SemVaultRequest = $null
$script:SemVaultItemRx = '\A[A-Za-z0-9][A-Za-z0-9 ._@:/\-]{0,127}\z'
$script:SemVaultFieldRx = '\A[A-Za-z0-9][A-Za-z0-9 _.\-]{0,63}\z'

# Roles per provider. Field = $null means the item's own secret. Optional roles are skipped when the item lacks the field.
$script:SemVaultRoles = @{
    odbc   = @(@{ Role = 'password'; Field = $null; Optional = $false }, @{ Role = 'user'; Field = 'Username'; Optional = $true })
    oledb  = @(@{ Role = 'password'; Field = $null; Optional = $false }, @{ Role = 'user'; Field = 'Username'; Optional = $true })
    athena = @(@{ Role = 'accessKeyId'; Field = 'AccessKeyId'; Optional = $false }, @{ Role = 'secretAccessKey'; Field = 'SecretAccessKey'; Optional = $false }, @{ Role = 'sessionToken'; Field = 'SessionToken'; Optional = $true })
}

function Register-SemVaultRoles {
    # Lets a connector declare which roles its provider needs from the vault item.
    param([string]$Provider, [object[]]$Roles)
    $script:SemVaultRoles[$Provider.ToLowerInvariant()] = @($Roles)
}

# ---------------------------------------------------------------------------
# sources.json: the vault block
# ---------------------------------------------------------------------------
function Test-SemVaultBlock {
    # $null when the vault block of a sources.json entry is acceptable, else the reason it is refused.
    param($Vault, [string]$Provider)
    if ($null -eq $Vault) { return $null }
    if ($Vault -isnot [Management.Automation.PSCustomObject]) { return 'The vault setting must be an object like { "item": "name" }.' }
    $item = Get-SemJsonProp $Vault 'item'
    if ($item -isnot [string] -or $item -cnotmatch $script:SemVaultItemRx) { return 'The vault setting needs "item": the name of a Lazarette item (letters, digits, space and . _ @ : / -).' }
    if (-not $script:SemVaultRoles.ContainsKey($Provider)) { return "The $Provider provider does not use the vault." }
    $fields = Get-SemJsonProp $Vault 'fields'
    if ($null -ne $fields) {
        if ($fields -isnot [Management.Automation.PSCustomObject]) { return 'vault.fields must map a role to a field name.' }
        $known = @($script:SemVaultRoles[$Provider] | ForEach-Object { $_.Role })
        foreach ($p in $fields.PSObject.Properties) {
            if ($known -cnotcontains $p.Name) { return ('vault.fields has an unknown role "' + $p.Name + '" (use ' + ($known -join ', ') + ').') }
            if ($p.Value -isnot [string] -or $p.Value -cnotmatch $script:SemVaultFieldRx) { return ('vault.fields.' + $p.Name + ' is not a valid field name.') }
        }
    }
    foreach ($p in $Vault.PSObject.Properties) { if (@('item', 'fields') -cnotcontains $p.Name) { return ('Unknown vault setting "' + $p.Name + '". A vault block holds only "item" and "fields", never a secret.') } }
    return $null
}

function Get-SemSourceVault {
    # The validated vault block of a source from Get-SemSources, or $null.
    param($Source)
    if ($null -eq $Source -or $null -eq $Source.raw) { return $null }
    return (Get-SemJsonProp $Source.raw 'vault')
}

function Get-SemVaultNeeds {
    # What the source needs from its vault item: @{ Item; Roles = @(@{ Role; Field; Optional }) }, or $null.
    param($Source)
    $vault = Get-SemSourceVault $Source
    if ($null -eq $vault) { return $null }
    $fields = Get-SemJsonProp $vault 'fields'
    $roles = foreach ($r in $script:SemVaultRoles[[string]$Source.provider]) {
        $f = $r.Field
        $over = Get-SemJsonProp $fields $r.Role
        if ($over) { $f = [string]$over }
        @{ Role = $r.Role; Field = $f; Optional = $r.Optional }
    }
    return @{ Item = [string](Get-SemJsonProp $vault 'item'); Roles = @($roles) }
}

# ---------------------------------------------------------------------------
# Finding and opening Lazarette (main runspace)
# ---------------------------------------------------------------------------
function Find-SemArcRoot {
    # Lazarette's own search order (docs/INTEGRATION.md), plus the folder name it ships under.
    param([string]$Root = '')
    $cands = New-Object System.Collections.Generic.List[string]
    foreach ($n in 'ARC_PATH', 'ARC_ROOT', 'ARC_HOME') { $v = [Environment]::GetEnvironmentVariable($n); if ($v) { $cands.Add($v) } }
    if ($Root) { $parent = Split-Path -Parent $Root; foreach ($n in 'Lazarette', 'arc') { $cands.Add((Join-Path $parent $n)) } }
    if ($env:USERPROFILE) { foreach ($n in 'Lazarette', 'arc') { $cands.Add((Join-Path (Join-Path $env:USERPROFILE 'Projects') $n)) } }
    foreach ($c in $cands) {
        if ($c -and [IO.File]::Exists([IO.Path]::Combine($c, 'lib', 'Arc.ps1'))) { return [IO.Path]::GetFullPath($c) }
    }
    return $null
}

function Get-SemArcLibPath {
    # Path of Lazarette's lib\Arc.ps1, or $null. The caller dot-sources it at script scope (a function cannot:
    # what a function dot-sources disappears when it returns):  $lib = Get-SemArcLibPath -Root $root; if ($lib) { . $lib }
    param([string]$Root = '')
    $arc = Find-SemArcRoot -Root $Root
    if ($arc) { return [IO.Path]::Combine($arc, 'lib', 'Arc.ps1') }
    return $null
}

function Initialize-SemVault {
    # Records whether Lazarette's functions are loaded in this runspace. Returns the state.
    param([string]$Root = '')
    $st = $script:SemVaultState
    if (Get-Command Get-ArcSecret -ErrorAction SilentlyContinue) { $st.Loaded = $true; $st.Problem = $null; return $st }
    $st.Loaded = $false
    if (Get-SemArcLibPath -Root $Root) { $st.Problem = 'Lazarette was found but is not loaded in this Semaphore process.' }
    else { $st.Problem = 'Lazarette was not found. Set ARC_PATH to the Lazarette folder (the one with lib\Arc.ps1), or keep it next to the Semaphore folder.' }
    return $st
}

function Test-SemVaultOpen {
    $st = $script:SemVaultState
    if (-not $st.Loaded) { return $false }
    try { return [bool](Test-ArcVaultUnlocked) } catch { return $false }
}

function Request-SemVaultUnlock {
    # At start-up, with a console: asks Lazarette's own prompt (passphrase or smart card PIN, then the authenticator code).
    # Without a console nothing is asked and the vault sources report 'vault-locked'. Returns $true when the vault is open.
    param([string]$Root = '', [bool]$Interactive = $true)
    $st = Initialize-SemVault -Root $Root
    if (-not $st.Loaded) { return $false }
    if (Test-SemVaultOpen) { return $true }
    if (-not $Interactive) { return $false }
    try { $ok = [bool](Unlock-ArcVaultInteractive) } catch { $ok = $false }
    return $ok
}

function Get-SemVaultStatus {
    # For GET /api/vault: never names an item's value.
    param([string]$HomeDir)
    $st = $script:SemVaultState
    $items = New-Object System.Collections.Generic.List[string]
    foreach ($s in @(Get-SemSources -HomeDir $HomeDir)) { $n = Get-SemVaultNeeds $s; if ($n) { $items.Add(('{0} -> {1}' -f $s.id, $n.Item)) } }
    return [ordered]@{ found = [bool]$st.Loaded; unlocked = (Test-SemVaultOpen); problem = $st.Problem; sources = @($items) }
}

# ---------------------------------------------------------------------------
# Resolving a request's secrets (main runspace) and using them (worker)
# ---------------------------------------------------------------------------
function Resolve-SemVaultSecrets {
    # @{ Values = @{ role = string } } for a source that uses the vault, @{ Values = $null } for one that does not,
    # or @{ Error = @{ Status; Code; Message } }. Messages never contain a secret.
    param($Source)
    $needs = Get-SemVaultNeeds $Source
    if ($null -eq $needs) { return @{ Values = $null } }
    $st = $script:SemVaultState
    if (-not $st.Loaded) {
        $st = Initialize-SemVault -Root (Split-Path -Parent $PSScriptRoot)
        if (-not $st.Loaded) { return @{ Error = @{ Status = 501; Code = 'vault-unavailable'; Message = [string]$st.Problem } } }
    }
    if (-not (Test-SemVaultOpen)) {
        return @{ Error = @{ Status = 423; Code = 'vault-locked'; Message = "Source '$($Source.id)' takes its secret from Lazarette, which is locked. Start Semaphore with Launch-Semaphore.bat --console and unlock Lazarette when it asks." } }
    }
    $values = @{}
    foreach ($r in $needs.Roles) {
        try {
            if ($r.Field) { $v = Get-ArcSecret -Service $needs.Item -Field $r.Field } else { $v = Get-ArcSecret -Service $needs.Item }
        } catch {
            if ($r.Optional) { continue }
            return @{ Error = @{ Status = 424; Code = 'vault-item'; Message = ("Lazarette could not give '{0}' for source '{1}': {2}" -f $needs.Item, $Source.id, (Get-SemVaultSafeText ([string]$_.Exception.Message) @())) } }
        }
        if ($null -ne $v -and "$v".Length -gt 0) { $values[$r.Role] = [string]$v }
        elseif (-not $r.Optional) { return @{ Error = @{ Status = 424; Code = 'vault-item'; Message = ("Lazarette's item '{0}' has no value for the {1}." -f $needs.Item, $r.Role) } } }
    }
    return @{ Values = $values }
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
    return @{ Values = $r.Values }
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
    foreach ($v in @($user, $pass)) { if ($v -and -not (Test-SemSecretText $v)) { throw 'A vault value contains control characters and cannot be used in a connection string.' } }
    if ($Provider -eq 'odbc') {
        if ($user -and $cs -notmatch '(?i)(^|;)\s*(UID|User ID)\s*=') { $cs += ';UID={' + $user.Replace('}', '}}') + '}' }
        if ($pass) { $cs += ';PWD={' + $pass.Replace('}', '}}') + '}' }
    } else {
        if ($user -and $cs -notmatch '(?i)(^|;)\s*User ID\s*=') { $cs += ';User ID="' + $user.Replace('"', '""') + '"' }
        if ($pass) { $cs += ';Password="' + $pass.Replace('"', '""') + '"' }
    }
    return $cs
}
