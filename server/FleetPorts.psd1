# FleetHacker port blocks: ONE declaration per tool. APPROVED 2026-10-25; see PORTS.md.
# Start = default port. Size = contiguous ports the tool may walk upward through when busy. Blocks never overlap.
# Policy: reuse | restart | multi | exclusive (see CONVENTIONS.md "Port blocks and self-detection").
@{
    'phoenix-lai-api'    = @{ Start = 1234;  Size = 1;  Policy = 'exclusive' }
    'data-noodler'       = @{ Start = 8079;  Size = 3;  Policy = 'reuse' }
    'lasso'              = @{ Start = 8765;  Size = 2;  Policy = 'reuse' }
    'synapse'            = @{ Start = 8767;  Size = 1;  Policy = 'reuse' }
    'lasso-dev'          = @{ Start = 8768;  Size = 1;  Policy = 'restart' }
    'keystone'           = @{ Start = 8769;  Size = 2;  Policy = 'reuse' }
    'mailhawk'           = @{ Start = 8771;  Size = 3;  Policy = 'exclusive' }
    'semaphore'          = @{ Start = 8774;  Size = 3;  Policy = 'reuse' }
    'phoenix-lai-server' = @{ Start = 8780;  Size = 10; Policy = 'exclusive' }
    'phoenix-lai-client' = @{ Start = 8790;  Size = 9;  Policy = 'multi' }
    'phoenix-lai-dev'    = @{ Start = 8799;  Size = 1;  Policy = 'restart' }
    'talkforge'          = @{ Start = 25000; Size = 10; Policy = 'reuse' }
}
