#requires -Version 5.1
<#
.SYNOPSIS
  Smoke-tests a built Semaphore-<version>.zip the way the workstation runs it.
.DESCRIPTION
  Extracts the zip into a new folder, starts server\Start-Semaphore.ps1 --no-browser --stay on a free
  loopback port in 8800-8802 with a temporary SEMAPHORE_HOME, reads the session link it prints, and
  checks that:
    - GET / is the app's index.html (a module script under assets/), not the "not built" page,
      and every asset web\dist\build.json names is in the zip and served;
    - POST /api/launch trades the link's code for the session token;
    - GET /api/info answers 200 for Semaphore with the zip's version.
  Then it stops the server with server\Stop-Semaphore.ps1 and removes the folder.
  Exit code 0 when every check passed.
.PARAMETER ZipPath
  The zip to test (dist\Semaphore-<version>.zip).
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File build\Test-SemaphoreZip.ps1 -ZipPath dist\Semaphore-0.4.1.zip
#>
[CmdletBinding()]
param(
    [string]$ZipPath = '',
    [int]$TimeoutSec = 60
)
$ErrorActionPreference = 'Stop'

function Get-SmokeFreePort {
    # The first port in 8800-8802 nothing listens on, or 0.
    foreach ($p in @(8800, 8801, 8802)) {
        $l = $null
        try {
            $l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $p)
            $l.Start()
            return $p
        } catch {
            continue
        } finally {
            if ($null -ne $l) { try { $l.Stop() } catch { } }
        }
    }
    return 0
}

function Get-SmokeSessionLink {
    # The session link Start-Semaphore.ps1 --no-browser prints, or '' when it is not there yet.
    param([string]$Text)
    $m = [regex]::Match([string]$Text, 'Session link \(works once, for 10 minutes\): (http://127\.0\.0\.1:\d+/\?launch=[A-Za-z0-9_-]+)')
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

function Get-SmokeLaunchCode {
    param([string]$Link)
    $m = [regex]::Match([string]$Link, '[?&]launch=([A-Za-z0-9_-]+)')
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

function Read-SmokeText {
    # A file another process is still writing (the server's redirected console), or '' when absent.
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $fs = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $sr = New-Object IO.StreamReader($fs)
        return $sr.ReadToEnd()
    } finally { $fs.Dispose() }
}

function Test-SmokeAppPage {
    # $null when the HTML is the built app page, else why not.
    param([string]$Html)
    if ([string]::IsNullOrEmpty($Html)) { return 'the page is empty' }
    if ($Html -match 'has not been built' -or $Html -match 'has no browser interface') { return 'the server served the "UI not built" page' }
    if ($Html -notmatch '<script type="module" src="assets/[A-Za-z0-9._-]+\.js"') { return 'the page has no module script under assets/' }
    if ($Html -notmatch '<div id="root">') { return 'the page has no #root element' }
    return $null
}

function Invoke-SmokeHttp {
    # One loopback request with no proxy. Returns @{ Status; Body; ContentType }; Status 0 when nothing answered.
    param([string]$Url, [string]$Method = 'GET', [string]$Body = '', [hashtable]$Headers = @{})
    $req = [Net.HttpWebRequest]::Create($Url)
    $req.Proxy = $null
    $req.Method = $Method
    $req.Timeout = 10000
    foreach ($k in $Headers.Keys) { $req.Headers[$k] = [string]$Headers[$k] }
    if ($Body) {
        $bytes = (New-Object Text.UTF8Encoding $false).GetBytes($Body)
        $req.ContentType = 'application/json'
        $req.ContentLength = $bytes.Length
        $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
    }
    $resp = $null
    try { $resp = $req.GetResponse() }
    catch [Net.WebException] {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ Status = 0; Body = ''; ContentType = '' } }
    }
    try {
        $sr = New-Object IO.StreamReader($resp.GetResponseStream())
        $text = $sr.ReadToEnd(); $sr.Dispose()
        return @{ Status = [int]$resp.StatusCode; Body = $text; ContentType = [string]$resp.ContentType }
    } finally { $resp.Close() }
}

# Dot-sourced (tests) or run with no zip: only the functions above are defined.
if (-not $ZipPath) { return }

$zip = [IO.Path]::GetFullPath($ZipPath)
if (-not (Test-Path -LiteralPath $zip)) { throw ('No zip at ' + $zip) }
$work = Join-Path ([IO.Path]::GetTempPath()) ('semaphore-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$folder = Join-Path $work 'Semaphore'
$homeDir = Join-Path $work 'home'
$out = Join-Path $work 'server-out.txt'
$err = Join-Path $work 'server-err.txt'
New-Item -ItemType Directory -Force $folder, $homeDir | Out-Null
$failures = New-Object System.Collections.Generic.List[string]
function Fail([string]$m) { $failures.Add($m); Write-Host ('FAIL ' + $m) -ForegroundColor Red }
function Pass([string]$m) { Write-Host ('PASS ' + $m) -ForegroundColor Green }

$proc = $null
$previousHome = $env:SEMAPHORE_HOME
try {
    Expand-Archive -LiteralPath $zip -DestinationPath $folder
    $version = (Get-Content -LiteralPath (Join-Path $folder 'VERSION') -Raw).Trim()
    foreach ($rel in @('Launch-Semaphore.bat', 'server\Start-Semaphore.ps1', 'server\Stop-Semaphore.ps1', 'web\dist\index.html', 'web\dist\build.json')) {
        if (Test-Path -LiteralPath (Join-Path $folder $rel)) { Pass ('zip holds ' + $rel) } else { Fail ('zip is missing ' + $rel) }
    }
    $manifest = Get-Content -LiteralPath (Join-Path $folder 'web\dist\build.json') -Raw | ConvertFrom-Json
    $assets = New-Object System.Collections.Generic.List[string]
    foreach ($rel in (@($manifest.entry, $manifest.css, $manifest.worker, $manifest.report) + @($manifest.chunks) + @($manifest.preload))) {
        if ($rel -and -not $assets.Contains([string]$rel)) { $assets.Add([string]$rel) }
    }
    foreach ($rel in $assets) {
        if (-not (Test-Path -LiteralPath (Join-Path $folder ('web\dist\' + $rel.Replace('/', '\'))))) { Fail ('zip is missing web\dist\' + $rel + ' (named in build.json)') }
    }

    $port = Get-SmokeFreePort
    if ($port -eq 0) { throw 'No free loopback port in 8800-8802.' }
    $env:SEMAPHORE_HOME = $homeDir
    $start = Join-Path $folder 'server\Start-Semaphore.ps1'
    $argLine = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $start + '" --no-browser --stay -Port ' + $port
    $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argLine -WorkingDirectory $folder -RedirectStandardOutput $out -RedirectStandardError $err -PassThru

    $link = ''
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt $TimeoutSec -and -not $link) {
        Start-Sleep -Milliseconds 500
        $link = Get-SmokeSessionLink (Read-SmokeText $out)
        if ($proc.HasExited) { break }
    }
    if (-not $link) {
        $text = (Read-SmokeText $out) + (Read-SmokeText $err)
        throw ('Semaphore printed no session link within ' + $TimeoutSec + ' s: ' + $text)
    }
    Pass ('Semaphore started on port ' + $port)
    $base = 'http://127.0.0.1:' + $port + '/'

    $page = Invoke-SmokeHttp -Url $base
    $why = Test-SmokeAppPage $page.Body
    if ($page.Status -ne 200) { Fail ('GET / answered ' + $page.Status) }
    elseif ($why) { Fail ('GET /: ' + $why) }
    else { Pass 'GET / is the app page' }
    foreach ($rel in $assets) {
        $r = Invoke-SmokeHttp -Url ($base + $rel)
        if ($r.Status -eq 200) { Pass ('GET /' + $rel) } else { Fail ('GET /' + $rel + ' answered ' + $r.Status) }
    }

    $code = Get-SmokeLaunchCode $link
    $launch = Invoke-SmokeHttp -Url ($base + 'api/launch') -Method 'POST' -Body ('{"code":"' + $code + '"}')
    $token = ''
    if ($launch.Status -eq 200) { $token = [string]($launch.Body | ConvertFrom-Json).token }
    if (-not $token) { Fail ('POST /api/launch answered ' + $launch.Status) } else { Pass 'POST /api/launch traded the code for the session' }
    $again = Invoke-SmokeHttp -Url ($base + 'api/launch') -Method 'POST' -Body ('{"code":"' + $code + '"}')
    if ($again.Status -eq 401) { Pass 'a used launch code is refused' } else { Fail ('a used launch code answered ' + $again.Status) }

    $info = Invoke-SmokeHttp -Url ($base + 'api/info') -Headers @{ 'X-Semaphore-Session' = $token }
    if ($info.Status -ne 200) { Fail ('GET /api/info answered ' + $info.Status) }
    else {
        $j = $info.Body | ConvertFrom-Json
        if ($j.tool -eq 'semaphore' -and $j.version -eq $version) { Pass ('GET /api/info: Semaphore ' + $j.version) } else { Fail ('GET /api/info: unexpected ' + $info.Body) }
    }
    $anon = Invoke-SmokeHttp -Url ($base + 'api/info')
    if ($anon.Status -eq 401) { Pass 'GET /api/info without the token is refused' } else { Fail ('GET /api/info without the token answered ' + $anon.Status) }
} catch {
    Fail $_.Exception.Message
} finally {
    $env:SEMAPHORE_HOME = $previousHome
    try { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $folder 'server\Stop-Semaphore.ps1') 2>&1 | ForEach-Object { Write-Host $_ } } catch { Fail ('Stop-Semaphore.ps1: ' + $_.Exception.Message) }
    if ($null -ne $proc) {
        if (-not $proc.WaitForExit(20000)) { Fail 'the server was still running 20 s after Stop-Semaphore.ps1'; try { $proc.Kill() } catch { } }
        else { Pass 'Stop-Semaphore.ps1 stopped the server' }
    }
    Start-Sleep -Milliseconds 500
    try { Remove-Item -LiteralPath $work -Recurse -Force } catch { Write-Host ('Could not remove ' + $work) -ForegroundColor Yellow }
}

if ($failures.Count -gt 0) {
    Write-Host ('{0} smoke check(s) failed.' -f $failures.Count) -ForegroundColor Red
    exit 1
}
Write-Host 'Smoke test passed.' -ForegroundColor Green
exit 0
