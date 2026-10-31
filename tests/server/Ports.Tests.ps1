# Pester 5. Semaphore's port block is 8800-8802, clear of Eight Bells (8774), Scrimshaw (8775) and Fairlead
# (8776), and the launcher walks only that block. Foreign listeners on loopback stand in for other programs; no
# Semaphore server is started.
BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    Import-Module ([IO.Path]::Combine($server, 'FleetPort.psm1')) -Force
    $script:Registry = [IO.Path]::Combine($server, 'FleetPorts.psd1')
    function script:Open-Foreign([int[]]$Ports) {
        $open = @()
        foreach ($p in $Ports) {
            $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $p)
            try { $l.Start(); $open += $l } catch { foreach ($o in $open) { $o.Stop() }; return $null }
        }
        return , $open
    }
}

Describe 'Semaphore port block' {
    It 'is 8800-8802 with the reuse policy' {
        $b = Get-FleetPortBlock -Tool 'semaphore' -RegistryPath $script:Registry
        $b.Start | Should -Be 8800
        $b.End | Should -Be 8802
        $b.Policy | Should -Be 'reuse'
    }
    It 'does not touch the ports Eight Bells, Scrimshaw and Fairlead use' {
        $b = Get-FleetPortBlock -Tool 'semaphore' -RegistryPath $script:Registry
        foreach ($taken in 8774, 8775, 8776) { ($taken -ge $b.Start -and $taken -le $b.End) | Should -BeFalse -Because "$taken belongs to another tool" }
    }
    It 'sends AI drafting to Fairlead on 127.0.0.1:8776 by default' {
        $src = Get-Content -LiteralPath ([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server', 'Intelligence.ps1')) -Raw
        $src | Should -Match "SemAiDefaultUrl = 'http://127\.0\.0\.1:8776/v1'"
    }
    It 'names no other Semaphore port in the launcher' {
        $src = Get-Content -LiteralPath ([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server', 'Start-Semaphore.ps1')) -Raw
        $src | Should -Not -Match '877[4-6]'
        $src | Should -Match '8800-8802'
    }
}

Describe 'Startup port walk' {
    It 'takes the next port in the block when the first is held by another program' {
        $held = Open-Foreign @(8800)
        if ($null -eq $held) { Set-ItResult -Skipped -Because 'port 8800 is in use on this machine'; return }
        try {
            $r = Resolve-FleetPort -Tool 'semaphore' -Version '0.3.0' -RegistryPath $script:Registry -NoListener -ProbeTimeoutMs 300
            $r.Port | Should -Be 8801
        } finally { foreach ($l in $held) { $l.Stop() } }
    }
    It 'stops with a message naming the block, and never tries 8774-8776 or 8803, when all three are held' {
        $held = Open-Foreign @(8800, 8801, 8802)
        if ($null -eq $held) { Set-ItResult -Skipped -Because 'a port in 8800-8802 is in use on this machine'; return }
        try {
            $msg = ''
            try { [void](Resolve-FleetPort -Tool 'semaphore' -Version '0.3.0' -RegistryPath $script:Registry -NoListener -ProbeTimeoutMs 300) } catch { $msg = $_.Exception.Message }
            $msg | Should -BeLike 'Port block 8800-8802 for semaphore is full*'
            $msg | Should -Match '8800: in use'
            $msg | Should -Match '8801: in use'
            $msg | Should -Match '8802: in use'
            $msg | Should -Not -Match '877[4-6]|8803'
        } finally { foreach ($l in $held) { $l.Stop() } }
    }
}
