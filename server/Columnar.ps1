# Parquet and Arrow IPC files for the local database. Dot-source this file, then call
# Import-SemColumnar: it compiles server/Columnar.cs once per session (namespace SemColumnar) and
# does nothing when [SemColumnar.ColumnarFiles] already exists, for example because LocalDb.cs and
# Columnar.cs were compiled together in one Add-Type call.
#
#   $r = [SemColumnar.ColumnarFiles]::Open($path)      # Parquet or Arrow, by magic bytes
#   $row = New-Object object[] $r.Names.Length
#   while ($r.Next($row)) { ... }                       # values: long, double, string, bool, byte[], $null
#   $r.Dispose()
#   [SemColumnar.ColumnarFiles]::WriteParquet($path, $names, $types, $rows)   # $rows: IEnumerable[object[]]

$script:SemColumnarSource = Join-Path $PSScriptRoot 'Columnar.cs'

function Import-SemColumnar {
    if ('SemColumnar.ColumnarFiles' -as [type]) { return }
    $source = $script:SemColumnarSource
    if (-not $source -or -not (Test-Path -LiteralPath $source)) {
        $source = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.ScriptBlock.File) 'Columnar.cs'
    }
    Add-Type -Path $source
}
