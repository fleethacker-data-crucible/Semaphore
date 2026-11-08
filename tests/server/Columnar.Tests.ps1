# Pester 5. server/Columnar.cs: Parquet and Arrow IPC readers and writers, and its Snappy codec.
# The golden files are built byte by byte below from the format specs (parquet-format thrift
# definitions, Arrow IPC flatbuffer schemas) by this file's own thrift, flatbuffer, bit-packing
# and delta encoders, with no code shared with Columnar.cs. Writer output is also checked by
# tests/helpers/columnar_verify.py (Python standard library only) when Python is installed.
BeforeDiscovery {
    $script:python = $null
    foreach ($cand in 'python', 'py') {
        $cmd = Get-Command $cand -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $cmd) { continue }
        try { $out = & $cmd.Source -c 'print(40+2)' 2>$null } catch { $out = $null }
        if ("$out".Trim() -eq '42') { $script:python = $cmd.Source; break }
    }
    $script:hasPython = [bool]$script:python
    $script:fuelArrow = 'C:\Users\Anthony\Projects\data-noodler\workspace\smpg\fleet-fuel-review\data\imported\FUEL_LOG\part-000000.arrow'
    $script:fuelCsv = 'C:\Users\Anthony\Projects\data-noodler\workspace\smpg\fleet-fuel-review\data\raw\fuel-log.csv'
    $script:hasFuel = (Test-Path -LiteralPath $script:fuelArrow) -and (Test-Path -LiteralPath $script:fuelCsv)
    $fx = [IO.Path]::Combine($PSScriptRoot, '..', 'fixtures', 'columnar')
    $script:fixtureCases = @(Get-ChildItem -LiteralPath $fx -Filter *.arrow | ForEach-Object { @{ Name = $_.BaseName } })
}

BeforeAll {
    $server = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..', 'server'))
    $script:columnarPs1 = [IO.Path]::Combine($server, 'Columnar.ps1')
    . $script:columnarPs1
    Import-SemColumnar
    $script:fixtures = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', 'fixtures', 'columnar'))
    $script:verifier = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', 'helpers', 'columnar_verify.py'))
    $script:tmp = Join-Path ([IO.Path]::GetTempPath()) ('sem-columnar-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:tmp | Out-Null
    $script:python = $null
    foreach ($cand in 'python', 'py') {
        $cmd = Get-Command $cand -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $cmd) { continue }
        try { $out = & $cmd.Source -c 'print(40+2)' 2>$null } catch { $out = $null }
        if ("$out".Trim() -eq '42') { $script:python = $cmd.Source; break }
    }
    $script:fuelArrow = 'C:\Users\Anthony\Projects\data-noodler\workspace\smpg\fleet-fuel-review\data\imported\FUEL_LOG\part-000000.arrow'
    $script:fuelCsv = 'C:\Users\Anthony\Projects\data-noodler\workspace\smpg\fleet-fuel-review\data\raw\fuel-log.csv'

    # Test kit in C#: generates and checks large row sets at compiled speed. It talks to the
    # readers through the public interface by reflection, so it does not reference Columnar.cs.
    if (-not ('ColumnarTestKit' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;

public static class ColumnarTestKit
{
    public static readonly string[] Names = { "id", "amount", "label", "day", "stamp", "flag", "payload" };
    public static readonly string[] Types = { "integer", "real", "text", "date", "datetime", "boolean", "blob" };
    static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    public static object[] Row(int i)
    {
        object[] r = new object[7];
        r[0] = i % 97 == 0 ? null : (object)((long)i * 7919L - 1000000L);
        r[1] = i % 89 == 0 ? null : (object)(i * 0.25 - 1000.125);
        r[2] = i % 5 == 0 ? null : (object)("label-" + (i % 40));
        r[3] = i % 7 == 0 ? null : (object)Epoch.AddDays(i % 30000 - 10000).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        DateTime t = Epoch.AddMilliseconds((long)i * 1234567L - 5000000000L);
        r[4] = i % 11 == 0 ? null : (object)(t.ToString(t.Millisecond == 0 ? "yyyy-MM-dd'T'HH:mm:ss" : "yyyy-MM-dd'T'HH:mm:ss.fff", CultureInfo.InvariantCulture) + "Z");
        r[5] = i % 13 == 0 ? null : (object)(i % 3 == 0);
        if (i % 3 == 0) r[6] = null;
        else
        {
            byte[] b = new byte[i % 17];
            for (int k = 0; k < b.Length; k++) b[k] = (byte)(i * 31 + k);
            r[6] = b;
        }
        return r;
    }

    public static IEnumerable<object[]> Rows(int n) { for (int i = 0; i < n; i++) yield return Row(i); }

    public static IEnumerable<object[]> Labels(int n, int distinct)
    {
        for (int i = 0; i < n; i++) yield return new object[] { (long)i, "category-" + (i % distinct) };
    }

    public static Func<object[], bool> NextOf(object reader)
    {
        Type it = reader.GetType().GetInterface("SemColumnar.ITableReader");
        return (Func<object[], bool>)Delegate.CreateDelegate(typeof(Func<object[], bool>), reader, it.GetMethod("Next"));
    }

    public static bool Same(object a, object b)
    {
        if (a == null || b == null) return a == null && b == null;
        byte[] x = a as byte[], y = b as byte[];
        if (x != null || y != null)
        {
            if (x == null || y == null || x.Length != y.Length) return false;
            for (int i = 0; i < x.Length; i++) if (x[i] != y[i]) return false;
            return true;
        }
        if (a is double && b is double) return BitConverter.DoubleToInt64Bits((double)a) == BitConverter.DoubleToInt64Bits((double)b);
        return a.GetType() == b.GetType() && a.Equals(b);
    }

    static string Show(object v)
    {
        if (v == null) return "null";
        byte[] b = v as byte[];
        if (b != null) return "bytes[" + b.Length + "]";
        return v.GetType().Name + ":" + Convert.ToString(v, CultureInfo.InvariantCulture);
    }

    // Reads every row and compares it with Row(i). Returns "ok" or the first difference. Disposes the reader.
    public static string Verify(object reader, int n)
    {
        try { return VerifyRows(reader, n); }
        finally { ((IDisposable)reader).Dispose(); }
    }

    static string VerifyRows(object reader, int n)
    {
        Func<object[], bool> next = NextOf(reader);
        object[] row = new object[7];
        int i = 0;
        while (next(row))
        {
            if (i >= n) return "more rows than written";
            object[] want = Row(i);
            for (int c = 0; c < 7; c++)
                if (!Same(row[c], want[c])) return "row " + i + " column " + Names[c] + ": got " + Show(row[c]) + ", want " + Show(want[c]);
            i++;
        }
        return i == n ? "ok" : ("read " + i + " rows, wrote " + n);
    }

    public static long Count(object reader, int width)
    {
        Func<object[], bool> next = NextOf(reader);
        object[] row = new object[width];
        long n = 0;
        try { while (next(row)) n++; }
        finally { ((IDisposable)reader).Dispose(); }
        return n;
    }

    public static List<object[]> ReadAll(object reader, int width)
    {
        Func<object[], bool> next = NextOf(reader);
        List<object[]> all = new List<object[]>();
        object[] row = new object[width];
        while (next(row)) { all.Add((object[])row.Clone()); }
        return all;
    }
}
'@
    }

    # ---------- general helpers ----------
    function script:New-ByteList { , (New-Object 'System.Collections.Generic.List[byte]') }
    function script:Join-Bytes {
        $o = New-Object 'System.Collections.Generic.List[byte]'
        foreach ($a in $args) { if ($null -ne $a) { $o.AddRange([byte[]]$a) } }
        , $o.ToArray()
    }
    function script:I32([int]$v) { , [BitConverter]::GetBytes($v) }
    function script:I64([long]$v) { , [BitConverter]::GetBytes($v) }
    function script:Utf8([string]$s) { , [Text.Encoding]::UTF8.GetBytes($s) }
    function script:Read-All($Reader) {
        $rows = [ColumnarTestKit]::ReadAll($Reader, $Reader.Names.Length)
        $Reader.Dispose()
        , $rows
    }
    function script:Get-ZigZag([long]$v) { if ($v -ge 0) { 2 * $v } else { -2 * $v - 1 } }
    function script:Get-Varint([long]$v) {
        $o = New-Object 'System.Collections.Generic.List[byte]'
        while ($v -ge 128) { $o.Add([byte](($v -band 127) -bor 128)); $v = $v -shr 7 }
        $o.Add([byte]$v)
        , $o.ToArray()
    }
    function script:Get-BitPacked([long[]]$Values, [int]$Width) {
        $bytes = New-Object byte[] ([int][Math]::Ceiling($Values.Count * $Width / 8.0))
        $bit = 0
        foreach ($v in $Values) {
            for ($k = 0; $k -lt $Width; $k++) {
                if (($v -shr $k) -band 1) { $bytes[$bit -shr 3] = $bytes[$bit -shr 3] -bor (1 -shl ($bit -band 7)) }
                $bit++
            }
        }
        , $bytes
    }
    function script:Get-BitWidth([long]$Max) { $w = 0; while ($Max -gt 0) { $w++; $Max = $Max -shr 1 }; $w }
    # Snappy with literals only (60 bytes each), from the format description.
    function script:Get-SnappyLiteral([byte[]]$B) {
        $o = New-Object 'System.Collections.Generic.List[byte]'
        $o.AddRange([byte[]](Get-Varint $B.Length))
        for ($i = 0; $i -lt $B.Length; $i += 60) {
            $n = [Math]::Min(60, $B.Length - $i)
            $o.Add([byte](($n - 1) -shl 2))
            for ($k = 0; $k -lt $n; $k++) { $o.Add($B[$i + $k]) }
        }
        , $o.ToArray()
    }
    function script:Get-Gzip([byte[]]$B) {
        $ms = New-Object IO.MemoryStream
        $gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionMode]::Compress, $true)
        $gz.Write($B, 0, $B.Length); $gz.Dispose()
        , $ms.ToArray()
    }
    # DELTA_BINARY_PACKED: blocks of 128 values in 4 miniblocks of 32.
    function script:Get-DeltaPacked([long[]]$Values) {
        $o = New-Object 'System.Collections.Generic.List[byte]'
        foreach ($x in (Get-Varint 128), (Get-Varint 4), (Get-Varint $Values.Count)) { $o.AddRange([byte[]]$x) }
        $first = if ($Values.Count) { $Values[0] } else { 0 }
        $o.AddRange([byte[]](Get-Varint (Get-ZigZag $first)))
        $deltas = New-Object 'System.Collections.Generic.List[long]'
        for ($i = 1; $i -lt $Values.Count; $i++) { $deltas.Add($Values[$i] - $Values[$i - 1]) }
        for ($b = 0; $b -lt $deltas.Count; $b += 128) {
            $blk = $deltas.GetRange($b, [Math]::Min(128, $deltas.Count - $b))
            $min = $blk[0]; foreach ($d in $blk) { if ($d -lt $min) { $min = $d } }
            $o.AddRange([byte[]](Get-Varint (Get-ZigZag $min)))
            $minis = @()
            for ($m = 0; $m -lt 4; $m++) {
                $s = $m * 32
                if ($s -ge $blk.Count) { $minis += , $null; continue }
                $vals = New-Object long[] 32
                $max = 0
                for ($k = 0; $k -lt 32 -and $s + $k -lt $blk.Count; $k++) { $vals[$k] = $blk[$s + $k] - $min; if ($vals[$k] -gt $max) { $max = $vals[$k] } }
                $minis += , @((Get-BitWidth $max), $vals)
            }
            foreach ($mb in $minis) { $o.Add([byte]$(if ($null -eq $mb) { 0 } else { $mb[0] })) }
            foreach ($mb in $minis) { if ($null -ne $mb -and $mb[0] -gt 0) { $o.AddRange([byte[]](Get-BitPacked $mb[1] $mb[0])) } }
        }
        , $o.ToArray()
    }

    # ---------- thrift compact protocol ----------
    function script:TS($Fields) { [pscustomobject]@{ Fields = @($Fields | Where-Object { $null -ne $_ }) } }
    function script:TF([int]$Id, [string]$T, $V) { [pscustomobject]@{ Id = $Id; T = $T; V = $V } }
    function script:TL([string]$Et, $Items) { [pscustomobject]@{ Et = $Et; Items = @($Items) } }
    function script:Get-TCode([string]$T, $V) {
        switch ($T) {
            'bool' { if ($V) { return 1 } else { return 2 } }
            'i8' { return 3 } 'i16' { return 4 } 'i32' { return 5 } 'i64' { return 6 }
            'bin' { return 8 } 'str' { return 8 } 'list' { return 9 } 'struct' { return 12 }
        }
        throw "unknown thrift type $T"
    }
    function script:Add-TValue($o, [string]$T, $V) {
        switch ($T) {
            'bool' { }
            'i8' { $o.Add([byte]$V) }
            'i16' { $o.AddRange([byte[]](Get-Varint (Get-ZigZag $V))) }
            'i32' { $o.AddRange([byte[]](Get-Varint (Get-ZigZag $V))) }
            'i64' { $o.AddRange([byte[]](Get-Varint (Get-ZigZag $V))) }
            'str' { $b = [Text.Encoding]::UTF8.GetBytes([string]$V); $o.AddRange([byte[]](Get-Varint $b.Length)); $o.AddRange($b) }
            'bin' { $b = [byte[]]$V; $o.AddRange([byte[]](Get-Varint $b.Length)); $o.AddRange($b) }
            'struct' { $o.AddRange([byte[]](Write-TStruct $V)) }
            'list' {
                $items = @($V.Items); $n = $items.Count; $c = Get-TCode $V.Et $true
                if ($n -lt 15) { $o.Add([byte](($n -shl 4) -bor $c)) } else { $o.Add([byte](0xF0 -bor $c)); $o.AddRange([byte[]](Get-Varint $n)) }
                foreach ($it in $items) { Add-TValue $o $V.Et $it }
            }
        }
    }
    function script:Write-TStruct($S) {
        $o = New-Object 'System.Collections.Generic.List[byte]'
        $last = 0
        foreach ($f in $S.Fields) {
            $code = Get-TCode $f.T $f.V
            $d = $f.Id - $last
            if ($d -gt 0 -and $d -le 15) { $o.Add([byte](($d -shl 4) -bor $code)) }
            else { $o.Add([byte]$code); $o.AddRange([byte[]](Get-Varint (Get-ZigZag $f.Id))) }
            $last = $f.Id
            Add-TValue $o $f.T $f.V
        }
        $o.Add(0)
        , $o.ToArray()
    }

    # ---------- Parquet file assembly ----------
    # A column: @{ Schema = TS; Physical; Codec; Pages = @(@{ Type; Sub = TS; USize; Body }); Encodings }
    function script:New-V1Page([byte[]]$Raw, [int]$Count, [int]$Encoding, [int]$Codec) {
        $body = switch ($Codec) { 0 { $Raw } 1 { Get-SnappyLiteral $Raw } 2 { Get-Gzip $Raw } }
        @{ Type = 0; USize = $Raw.Length; Body = [byte[]]$body; Sub = (TS @((TF 1 'i32' $Count), (TF 2 'i32' $Encoding), (TF 3 'i32' 3), (TF 4 'i32' 3))) }
    }
    function script:New-DictPage([byte[]]$Raw, [int]$Count, [int]$Encoding, [int]$Codec) {
        $body = switch ($Codec) { 0 { $Raw } 1 { Get-SnappyLiteral $Raw } 2 { Get-Gzip $Raw } }
        @{ Type = 2; USize = $Raw.Length; Body = [byte[]]$body; Sub = (TS @((TF 1 'i32' $Count), (TF 2 'i32' $Encoding))) }
    }
    function script:Get-DefLevels([int[]]$Defs) {
        # One bit-packed run (bit width 1) with a 4-byte length prefix, as data page v1 stores it.
        $groups = [int][Math]::Ceiling($Defs.Count / 8.0)
        $vals = New-Object long[] ($groups * 8)
        for ($i = 0; $i -lt $Defs.Count; $i++) { $vals[$i] = $Defs[$i] }
        $run = Join-Bytes (Get-Varint (($groups -shl 1) -bor 1)) (Get-BitPacked $vals 1)
        Join-Bytes (I32 $run.Length) $run
    }
    function script:New-ParquetBytes($Columns, [long]$Rows, $ExtraSchema) {
        $file = New-Object 'System.Collections.Generic.List[byte]'
        $file.AddRange([Text.Encoding]::ASCII.GetBytes('PAR1'))
        $chunks = @()
        $total = 0
        foreach ($col in $Columns) {
            $start = $file.Count; $dictOff = $null; $dataOff = $null; $u = 0; $c = 0
            foreach ($pg in $col.Pages) {
                $hid = switch ($pg.Type) { 0 { 5 } 2 { 7 } 3 { 8 } }
                $h = Write-TStruct (TS @((TF 1 'i32' $pg.Type), (TF 2 'i32' $pg.USize), (TF 3 'i32' $pg.Body.Length), (TF $hid 'struct' $pg.Sub)))
                if ($pg.Type -eq 2) { $dictOff = $file.Count } elseif ($null -eq $dataOff) { $dataOff = $file.Count }
                $file.AddRange([byte[]]$h); $file.AddRange([byte[]]$pg.Body)
                $u += $h.Length + $pg.USize; $c += $h.Length + $pg.Body.Length
            }
            $total += $u
            $name = ($col.Schema.Fields | Where-Object { $_.Id -eq 4 }).V
            $md = @((TF 1 'i32' $col.Physical), (TF 2 'list' (TL 'i32' $col.Encodings)), (TF 3 'list' (TL 'str' @($name))), (TF 4 'i32' $col.Codec),
                (TF 5 'i64' $Rows), (TF 6 'i64' $u), (TF 7 'i64' $c), (TF 9 'i64' $dataOff))
            if ($null -ne $dictOff) { $md += TF 11 'i64' $dictOff }
            $chunks += TS @((TF 2 'i64' $start), (TF 3 'struct' (TS $md)))
        }
        $schema = @(TS @((TF 4 'str' 'schema'), (TF 5 'i32' (@($Columns).Count + @($ExtraSchema | Where-Object { $_ -and $_.Top }).Count))))
        foreach ($col in $Columns) { $schema += $col.Schema }
        foreach ($x in @($ExtraSchema)) { if ($x) { $schema += $x.Schema } }
        $rg = TS @((TF 1 'list' (TL 'struct' $chunks)), (TF 2 'i64' $total), (TF 3 'i64' $Rows))
        $meta = Write-TStruct (TS @((TF 1 'i32' 1), (TF 2 'list' (TL 'struct' $schema)), (TF 3 'i64' $Rows), (TF 4 'list' (TL 'struct' @($rg))), (TF 6 'str' 'hand-built golden file')))
        $file.AddRange([byte[]]$meta)
        $file.AddRange([BitConverter]::GetBytes([int]$meta.Length))
        $file.AddRange([Text.Encoding]::ASCII.GetBytes('PAR1'))
        , $file.ToArray()
    }

    function script:Get-GoldenParquetColumns {
        $cols = @()
        # id: INT64 REQUIRED, PLAIN, uncompressed.
        $raw = Join-Bytes (I64 1) (I64 2) (I64 3) (I64 -4) (I64 9007199254740993)
        $cols += @{ Schema = (TS @((TF 1 'i32' 2), (TF 3 'i32' 0), (TF 4 'str' 'id'))); Physical = 2; Codec = 0; Encodings = @(0); Pages = @(New-V1Page $raw 5 0 0) }

        # name: BYTE_ARRAY OPTIONAL, converted UTF8, GZIP, PLAIN_DICTIONARY dictionary page + indices.
        $zolw = -join [char[]](0x17C, 0xF3, 0x142, 0x77)
        $dict = Join-Bytes (I32 5) (Utf8 'alpha') (I32 4) (Utf8 'beta') (I32 (Utf8 $zolw).Length) (Utf8 $zolw)
        $idx = Join-Bytes ([byte[]]@(2)) (Get-Varint 3) (Get-BitPacked @(0, 1, 0, 2, 0, 0, 0, 0) 2)
        $raw = Join-Bytes (Get-DefLevels @(1, 1, 0, 1, 1)) $idx
        $cols += @{ Schema = (TS @((TF 1 'i32' 6), (TF 3 'i32' 1), (TF 4 'str' 'name'), (TF 6 'i32' 0))); Physical = 6; Codec = 2; Encodings = @(2, 3)
            Pages = @((New-DictPage $dict 3 2 2), (New-V1Page $raw 5 2 2)) }

        # day: INT32 OPTIONAL, logical DATE, DELTA_BINARY_PACKED in a data page v2, Snappy.
        $vals = Get-DeltaPacked @(19000, 19001, 19005, 18990)
        $lv = Join-Bytes (Get-Varint 3) (Get-BitPacked @(1, 1, 0, 1, 1, 0, 0, 0) 1)
        $comp = Get-SnappyLiteral $vals
        $sub = TS @((TF 1 'i32' 5), (TF 2 'i32' 1), (TF 3 'i32' 5), (TF 4 'i32' 5), (TF 5 'i32' $lv.Length), (TF 6 'i32' 0))
        $cols += @{ Schema = (TS @((TF 1 'i32' 1), (TF 3 'i32' 1), (TF 4 'str' 'day'), (TF 10 'struct' (TS @(TF 6 'struct' (TS @())))))); Physical = 1; Codec = 1; Encodings = @(5, 3)
            Pages = @(@{ Type = 3; USize = $lv.Length + $vals.Length; Body = (Join-Bytes $lv $comp); Sub = $sub }) }

        # ts: INT96 OPTIONAL (legacy timestamps), PLAIN, Snappy.
        $epoch = New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc)
        $raw96 = New-ByteList
        foreach ($t in '2024-01-02T03:04:05.678Z', '1970-01-01T00:00:00Z', '1899-12-31T23:59:59Z', '2000-02-29T12:00:00.5Z') {
            $dt = [DateTime]::Parse($t, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]'AdjustToUniversal,AssumeUniversal')
            $raw96.AddRange([BitConverter]::GetBytes([long]($dt.TimeOfDay.Ticks * 100)))
            $raw96.AddRange([BitConverter]::GetBytes([int](($dt.Date - $epoch.Date).Days + 2440588)))
        }
        $raw = Join-Bytes (Get-DefLevels @(1, 0, 1, 1, 1)) $raw96.ToArray()
        $cols += @{ Schema = (TS @((TF 1 'i32' 3), (TF 3 'i32' 1), (TF 4 'str' 'ts'))); Physical = 3; Codec = 1; Encodings = @(0, 3); Pages = @(New-V1Page $raw 5 0 1) }

        # amount: FIXED_LEN_BYTE_ARRAY(5) REQUIRED, converted DECIMAL(9,2), big-endian two's complement.
        $fl = New-ByteList
        foreach ($v in [long]12345, [long]-100, [long]0, [long]99999999999, [long]-1) {
            $b = [BitConverter]::GetBytes($v); for ($k = 4; $k -ge 0; $k--) { $fl.Add($b[$k]) }
        }
        $cols += @{ Schema = (TS @((TF 1 'i32' 7), (TF 2 'i32' 5), (TF 3 'i32' 0), (TF 4 'str' 'amount'), (TF 6 'i32' 5), (TF 7 'i32' 2), (TF 8 'i32' 9))); Physical = 7; Codec = 0; Encodings = @(0)
            Pages = @(New-V1Page $fl.ToArray() 5 0 0) }

        # flag: BOOLEAN REQUIRED, PLAIN bits (LSB first).
        $cols += @{ Schema = (TS @((TF 1 'i32' 0), (TF 3 'i32' 0), (TF 4 'str' 'flag'))); Physical = 0; Codec = 0; Encodings = @(0); Pages = @(New-V1Page ([byte[]]@(0x0D)) 5 0 0) }

        # ratio: DOUBLE OPTIONAL, BYTE_STREAM_SPLIT.
        $d = @(0.5, -2.25, 1e300, 3.0)
        $bss = New-Object byte[] 32
        for ($i = 0; $i -lt 4; $i++) { $b = [BitConverter]::GetBytes([double]$d[$i]); for ($j = 0; $j -lt 8; $j++) { $bss[$j * 4 + $i] = $b[$j] } }
        $raw = Join-Bytes (Get-DefLevels @(1, 0, 1, 1, 1)) $bss
        $cols += @{ Schema = (TS @((TF 1 'i32' 5), (TF 3 'i32' 1), (TF 4 'str' 'ratio'))); Physical = 5; Codec = 0; Encodings = @(9, 3); Pages = @(New-V1Page $raw 5 9 0) }

        # u32: INT32 REQUIRED, converted UINT_32, data page v2 with is_compressed = false.
        $raw = Join-Bytes (I32 -1) (I32 0) (I32 1) (I32 ([int]::MinValue)) (I32 7)
        $sub = TS @((TF 1 'i32' 5), (TF 2 'i32' 0), (TF 3 'i32' 5), (TF 4 'i32' 0), (TF 5 'i32' 0), (TF 6 'i32' 0), (TF 7 'bool' $false))
        $cols += @{ Schema = (TS @((TF 1 'i32' 1), (TF 3 'i32' 0), (TF 4 'str' 'u32'), (TF 6 'i32' 13))); Physical = 1; Codec = 1; Encodings = @(0)
            Pages = @(@{ Type = 3; USize = $raw.Length; Body = $raw; Sub = $sub }) }

        # uid: FIXED_LEN_BYTE_ARRAY(16) OPTIONAL, logical UUID; definition levels as two RLE runs.
        $lv = Join-Bytes ([byte[]]@(0x02, 0x01, 0x08, 0x00))
        $raw = Join-Bytes (I32 $lv.Length) $lv ([byte[]](0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF))
        $cols += @{ Schema = (TS @((TF 1 'i32' 7), (TF 2 'i32' 16), (TF 3 'i32' 1), (TF 4 'str' 'uid'), (TF 10 'struct' (TS @(TF 14 'struct' (TS @())))))); Physical = 7; Codec = 0; Encodings = @(0, 3)
            Pages = @(New-V1Page $raw 5 0 0) }

        # tsm: INT64 OPTIONAL, logical TIMESTAMP(isAdjustedToUTC = false, MILLIS), Snappy.
        $raw = Join-Bytes (Get-DefLevels @(1, 0, 1, 1, 0)) (I64 1700000000123) (I64 -1) (I64 0)
        $lt = TS @(TF 8 'struct' (TS @((TF 1 'bool' $false), (TF 2 'struct' (TS @(TF 1 'struct' (TS @())))))))
        $cols += @{ Schema = (TS @((TF 1 'i32' 2), (TF 3 'i32' 1), (TF 4 'str' 'tsm'), (TF 10 'struct' $lt))); Physical = 2; Codec = 1; Encodings = @(0, 3); Pages = @(New-V1Page $raw 5 0 1) }

        # word: BYTE_ARRAY REQUIRED, logical STRING, DELTA_BYTE_ARRAY (prefix lengths, then suffixes).
        $raw = Join-Bytes (Get-DeltaPacked @(0, 4, 2, 0, 0)) (Get-DeltaPacked @(5, 1, 1, 1, 0)) (Utf8 'appleytb')
        $cols += @{ Schema = (TS @((TF 1 'i32' 6), (TF 3 'i32' 0), (TF 4 'str' 'word'), (TF 10 'struct' (TS @(TF 1 'struct' (TS @())))))); Physical = 6; Codec = 0; Encodings = @(7)
            Pages = @(New-V1Page $raw 5 7 0) }

        # qty: INT32 OPTIONAL, converted INT_16, PLAIN dictionary page + RLE_DICTIONARY indices as one RLE run.
        $raw = Join-Bytes (Get-DefLevels @(1, 1, 1, 1, 0)) ([byte[]]@(1)) (Get-Varint (4 -shl 1)) ([byte[]]@(0))
        $cols += @{ Schema = (TS @((TF 1 'i32' 1), (TF 3 'i32' 1), (TF 4 'str' 'qty'), (TF 6 'i32' 16))); Physical = 1; Codec = 0; Encodings = @(0, 8, 3)
            Pages = @((New-DictPage (I32 -7) 1 0 0), (New-V1Page $raw 5 8 0)) }

        # big: INT64 OPTIONAL, DELTA_BINARY_PACKED over 300 values (three blocks, wide deltas).
        $bigVals = New-Object long[] 300
        for ($i = 0; $i -lt 300; $i++) { $bigVals[$i] = [long]($i * $i * 1000003) - 40000000000 }
        $script:goldenBig = $bigVals
        $cols += @{ Schema = (TS @((TF 1 'i32' 2), (TF 3 'i32' 1), (TF 4 'str' 'big'))); Physical = 2; Codec = 0; Encodings = @(5, 3); Pages = @() ; Big = $true }
        , $cols
    }

    function script:Get-GoldenParquet {
        $cols = Get-GoldenParquetColumns
        # The 'big' column holds the first 5 of its values (one page of 5); the long delta run is in its own file.
        $vals = Get-DeltaPacked $script:goldenBig[0..4]
        $raw = Join-Bytes (Get-DefLevels @(1, 1, 1, 1, 1)) $vals
        $cols[-1].Pages = @(New-V1Page $raw 5 5 0)
        New-ParquetBytes $cols 5 $null
    }

    # ---------- flatbuffers (front-to-back, 8-byte fields first) ----------
    function script:FbT($Fields) { [pscustomobject]@{ K = 't'; F = @($Fields | Where-Object { $null -ne $_ }) } }
    function script:FbS([int]$I, [int]$Size, $V) { [pscustomobject]@{ I = $I; Size = $Size; V = $V; R = $null } }
    function script:FbR([int]$I, $Obj) { [pscustomobject]@{ I = $I; Size = 4; V = 0; R = $Obj } }
    function script:FbStr([string]$S) { [pscustomobject]@{ K = 's'; V = $S } }
    function script:FbVec($Items) { [pscustomobject]@{ K = 'v'; Items = @($Items | Where-Object { $null -ne $_ }) } }
    function script:FbStructs([byte[]]$Bytes, [int]$Count) { [pscustomobject]@{ K = 'sv'; V = $Bytes; N = $Count } }
    function script:Fb-Put([int]$Size, $V) { $b = [BitConverter]::GetBytes([long]$V); for ($i = 0; $i -lt $Size; $i++) { $script:fb.Add($b[$i]) } }
    function script:Fb-Patch([int]$At, [int]$V) { $b = [BitConverter]::GetBytes($V); for ($i = 0; $i -lt 4; $i++) { $script:fb[$At + $i] = $b[$i] } }
    function script:Fb-Align([int]$A) { while ($script:fb.Count % $A) { $script:fb.Add(0) } }
    function script:Fb-Place($O) {
        if ($O.K -eq 's') {
            Fb-Align 4; $p = $script:fb.Count
            $b = [Text.Encoding]::UTF8.GetBytes($O.V); Fb-Put 4 $b.Length; $script:fb.AddRange($b); $script:fb.Add(0)
            return $p
        }
        if ($O.K -eq 'sv') {
            while ((($script:fb.Count + 4) % 8) -ne 0) { $script:fb.Add(0) }
            $p = $script:fb.Count; Fb-Put 4 $O.N; if ($O.V.Length) { $script:fb.AddRange([byte[]]$O.V) }
            return $p
        }
        if ($O.K -eq 'v') {
            Fb-Align 4; $p = $script:fb.Count; Fb-Put 4 $O.Items.Count
            $slots = $script:fb.Count
            foreach ($it in $O.Items) { Fb-Put 4 0 }
            for ($i = 0; $i -lt $O.Items.Count; $i++) { $q = Fb-Place $O.Items[$i]; Fb-Patch ($slots + 4 * $i) ($q - ($slots + 4 * $i)) }
            return $p
        }
        $fs = @($O.F)
        $max = -1; foreach ($f in $fs) { if ($f.I -gt $max) { $max = $f.I } }
        $offs = New-Object int[] ($max + 1)
        $cur = 4
        $e8 = @($fs | Where-Object { $_.Size -eq 8 })
        if ($e8.Count) { $cur = 8 }
        foreach ($sz in 8, 4, 2, 1) { foreach ($f in @($fs | Where-Object { $_.Size -eq $sz })) { $offs[$f.I] = $cur; $cur += $sz } }
        Fb-Align 2
        $vt = $script:fb.Count
        Fb-Put 2 (4 + 2 * ($max + 1)); Fb-Put 2 $cur
        for ($i = 0; $i -le $max; $i++) { Fb-Put 2 $offs[$i] }
        Fb-Align 8
        $tp = $script:fb.Count
        Fb-Put 4 ($tp - $vt)
        for ($i = 4; $i -lt $cur; $i++) { $script:fb.Add(0) }
        foreach ($f in $fs) {
            if ($null -ne $f.R) { continue }
            $b = [BitConverter]::GetBytes([long]$f.V)
            for ($i = 0; $i -lt $f.Size; $i++) { $script:fb[$tp + $offs[$f.I] + $i] = $b[$i] }
        }
        foreach ($f in $fs) {
            if ($null -eq $f.R) { continue }
            $at = $tp + $offs[$f.I]
            $q = Fb-Place $f.R
            Fb-Patch $at ($q - $at)
        }
        return $tp
    }
    function script:Build-Fb($Root) {
        $script:fb = New-Object 'System.Collections.Generic.List[byte]'
        Fb-Put 4 0
        $r = Fb-Place $Root
        Fb-Patch 0 $r
        Fb-Align 8
        , $script:fb.ToArray()
    }

    # ---------- Arrow IPC assembly ----------
    function script:New-ArrowBody { [pscustomobject]@{ Bytes = (New-Object 'System.Collections.Generic.List[byte]'); Bufs = (New-Object 'System.Collections.Generic.List[long]') } }
    function script:Add-ArrowBuf($Body, [byte[]]$B) {
        $Body.Bufs.Add($Body.Bytes.Count); $Body.Bufs.Add($B.Length)
        $Body.Bytes.AddRange($B)
        while ($Body.Bytes.Count % 8) { $Body.Bytes.Add(0) }
    }
    function script:Get-Structs([long[]]$Values) { $o = New-ByteList; foreach ($v in $Values) { $o.AddRange([BitConverter]::GetBytes($v)) }; , $o.ToArray() }
    function script:New-RecordBatch([long]$Length, [long[]]$Nodes, $Body, $Compression) {
        FbT @((FbS 0 8 $Length), (FbR 1 (FbStructs (Get-Structs $Nodes) ($Nodes.Count / 2))), (FbR 2 (FbStructs (Get-Structs $Body.Bufs.ToArray()) ($Body.Bufs.Count / 2))), $Compression)
    }
    function script:Get-ArrowMessage([int]$HeaderType, $Header, [byte[]]$Body) {
        $meta = Build-Fb (FbT @((FbS 0 2 4), (FbS 1 1 $HeaderType), (FbR 2 $Header), (FbS 3 8 $Body.Length)))
        [pscustomobject]@{ Bytes = (Join-Bytes ([byte[]](0xFF, 0xFF, 0xFF, 0xFF)) (I32 $meta.Length) $meta $Body); MetaLen = $meta.Length + 8; BodyLen = $Body.Length }
    }
    function script:New-ArrowField([string]$Name, [int]$TypeId, $Type, $Dict, $Children) {
        FbT @((FbR 0 (FbStr $Name)), (FbS 1 1 1), (FbS 2 1 $TypeId), (FbR 3 $Type), $(if ($Dict) { FbR 4 $Dict }), (FbR 5 (FbVec $Children)))
    }
    function script:Get-ArrowGoldenSchema {
        FbT @((FbS 0 2 0), (FbR 1 (FbVec @(
            (New-ArrowField 'n' 2 (FbT @((FbS 0 4 32), (FbS 1 1 1))) $null @()),
            (New-ArrowField 'u8' 2 (FbT @((FbS 0 4 8), (FbS 1 1 0))) $null @()),
            (New-ArrowField 's' 5 (FbT @()) $null @()),
            (New-ArrowField 'ls' 20 (FbT @()) $null @()),
            (New-ArrowField 'd' 5 (FbT @()) (FbT @((FbS 0 8 7), (FbR 1 (FbT @((FbS 0 4 8), (FbS 1 1 1)))))) @()),
            (New-ArrowField 't' 10 (FbT @((FbS 0 2 1), (FbR 1 (FbStr 'UTC')))) $null @()),
            (New-ArrowField 'dt' 8 (FbT @(FbS 0 2 0)) $null @()),
            (New-ArrowField 'd64' 8 (FbT @(FbS 0 2 1)) $null @()),
            (New-ArrowField 'b' 6 (FbT @()) $null @()),
            (New-ArrowField 'dec' 7 (FbT @((FbS 0 4 10), (FbS 1 4 2), (FbS 2 4 128))) $null @()),
            (New-ArrowField 'f32' 3 (FbT @(FbS 0 2 1)) $null @()),
            (New-ArrowField 'bin' 4 (FbT @()) $null @()),
            (New-ArrowField 'tm' 9 (FbT @((FbS 0 2 1), (FbS 1 4 32))) $null @()),
            (New-ArrowField 'nul' 1 (FbT @()) $null @())
        ))))
    }
    function script:Get-ArrowGolden([switch]$Stream, $Compression) {
        $nodes = New-Object 'System.Collections.Generic.List[long]'
        $body = New-ArrowBody
        $e = [byte[]]@()
        $zeta = Utf8 ('z' + [char]0xE9)
        # n: Int32 [1, null, -3, 2147483647]
        Add-ArrowBuf $body ([byte[]]@(0x0D)); Add-ArrowBuf $body (Join-Bytes (I32 1) (I32 0) (I32 -3) (I32 2147483647)); $nodes.AddRange([long[]](4, 1))
        # u8: UInt8 [0, 255, 7, 128], no validity bitmap
        Add-ArrowBuf $body $e; Add-ArrowBuf $body ([byte[]](0, 255, 7, 128)); $nodes.AddRange([long[]](4, 0))
        # s: Utf8 ["a", "", null, "z<e-acute>"]
        Add-ArrowBuf $body ([byte[]]@(0x0B)); Add-ArrowBuf $body (Join-Bytes (I32 0) (I32 1) (I32 1) (I32 1) (I32 4)); Add-ArrowBuf $body (Join-Bytes (Utf8 'a') $zeta); $nodes.AddRange([long[]](4, 1))
        # ls: LargeUtf8 ["x", "yy", null, "zzz"]
        Add-ArrowBuf $body ([byte[]]@(0x0B)); Add-ArrowBuf $body (Join-Bytes (I64 0) (I64 1) (I64 3) (I64 3) (I64 6)); Add-ArrowBuf $body (Utf8 'xyyzzz'); $nodes.AddRange([long[]](4, 1))
        # d: dictionary id 7, Int8 indices [1, 0, null, 1]
        Add-ArrowBuf $body ([byte[]]@(0x0B)); Add-ArrowBuf $body ([byte[]](1, 0, 0, 1)); $nodes.AddRange([long[]](4, 1))
        # t: Timestamp(ms, UTC) [0, 1700000000123, null, -1]
        Add-ArrowBuf $body ([byte[]]@(0x0B)); Add-ArrowBuf $body (Join-Bytes (I64 0) (I64 1700000000123) (I64 0) (I64 -1)); $nodes.AddRange([long[]](4, 1))
        # dt: Date32 [0, 19723, -1, null]
        Add-ArrowBuf $body ([byte[]]@(0x07)); Add-ArrowBuf $body (Join-Bytes (I32 0) (I32 19723) (I32 -1) (I32 0)); $nodes.AddRange([long[]](4, 1))
        # d64: Date64 [2 days, -1 day, 1 ms, null]
        Add-ArrowBuf $body ([byte[]]@(0x07)); Add-ArrowBuf $body (Join-Bytes (I64 172800000) (I64 -86400000) (I64 1) (I64 0)); $nodes.AddRange([long[]](4, 1))
        # b: Bool [true, false, null, true]
        Add-ArrowBuf $body ([byte[]]@(0x0B)); Add-ArrowBuf $body ([byte[]]@(0x09)); $nodes.AddRange([long[]](4, 1))
        # dec: Decimal128(10, 2) [123.45, -0.01, 0, null]
        Add-ArrowBuf $body ([byte[]]@(0x07)); Add-ArrowBuf $body (Join-Bytes (I64 12345) (I64 0) (I64 -1) (I64 -1) (I64 0) (I64 0) (I64 0) (I64 0)); $nodes.AddRange([long[]](4, 1))
        # f32: Float32 [0.5, -1.25, null, 3]
        $f = New-ByteList; foreach ($x in 0.5, -1.25, 0, 3.0) { $f.AddRange([BitConverter]::GetBytes([single]$x)) }
        Add-ArrowBuf $body ([byte[]]@(0x0B)); Add-ArrowBuf $body $f.ToArray(); $nodes.AddRange([long[]](4, 1))
        # bin: Binary [01 02, empty, null, FF]
        Add-ArrowBuf $body ([byte[]]@(0x0B)); Add-ArrowBuf $body (Join-Bytes (I32 0) (I32 2) (I32 2) (I32 2) (I32 3)); Add-ArrowBuf $body ([byte[]](1, 2, 255)); $nodes.AddRange([long[]](4, 1))
        # tm: Time32(ms) [01:02:03.004, 00:00:00, null, 23:59:59]
        Add-ArrowBuf $body ([byte[]]@(0x0B)); Add-ArrowBuf $body (Join-Bytes (I32 3723004) (I32 0) (I32 0) (I32 86399000)); $nodes.AddRange([long[]](4, 1))
        # nul: Null type, no buffers
        $nodes.AddRange([long[]](4, 4))

        $schemaMsg = Get-ArrowMessage 1 (Get-ArrowGoldenSchema) ([byte[]]@())
        $db = New-ArrowBody
        Add-ArrowBuf $db $e; Add-ArrowBuf $db (Join-Bytes (I32 0) (I32 3) (I32 8)); Add-ArrowBuf $db (Utf8 'redgreen')
        $dictMsg = Get-ArrowMessage 2 (FbT @((FbS 0 8 7), (FbR 1 (New-RecordBatch 2 @(2, 0) $db $null)))) $db.Bytes.ToArray()
        $rbMsg = Get-ArrowMessage 3 (New-RecordBatch 4 $nodes.ToArray() $body $Compression) $body.Bytes.ToArray()
        $eos = [byte[]](0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0)
        if ($Stream) { return , (Join-Bytes $schemaMsg.Bytes $dictMsg.Bytes $rbMsg.Bytes $eos) }
        $head = Join-Bytes ([Text.Encoding]::ASCII.GetBytes('ARROW1')) ([byte[]](0, 0))
        $dictOff = $head.Length + $schemaMsg.Bytes.Length
        $rbOff = $dictOff + $dictMsg.Bytes.Length
        $blockD = Join-Bytes (I64 $dictOff) (I32 $dictMsg.MetaLen) (I32 0) (I64 $dictMsg.BodyLen)
        $blockR = Join-Bytes (I64 $rbOff) (I32 $rbMsg.MetaLen) (I32 0) (I64 $rbMsg.BodyLen)
        $footer = Build-Fb (FbT @((FbS 0 2 4), (FbR 1 (Get-ArrowGoldenSchema)), (FbR 2 (FbStructs $blockD 1)), (FbR 3 (FbStructs $blockR 1))))
        , (Join-Bytes $head $schemaMsg.Bytes $dictMsg.Bytes $rbMsg.Bytes $eos $footer (I32 $footer.Length) ([Text.Encoding]::ASCII.GetBytes('ARROW1')))
    }

    function script:Open-Bytes([byte[]]$B, [string]$Kind) { [SemColumnar.ColumnarFiles]::Open((New-Object IO.MemoryStream(, $B)), $Kind) }
    function script:Invoke-Checker([string]$Path) {
        $json = & $script:python -I $script:verifier $Path
        $json | ConvertFrom-Json
    }
    # The checker prints every value as text; compare with what Columnar.cs reads.
    function script:Get-CheckerText($v) {
        if ($null -eq $v) { return $null }
        if ($v -is [bool]) { if ($v) { return 'true' } else { return 'false' } }
        if ($v -is [byte[]]) { return [Convert]::ToBase64String($v) }
        if ($v -is [long]) { return $v.ToString([Globalization.CultureInfo]::InvariantCulture) }
        return [string]$v
    }
    function script:Compare-Checker($Checker, $Rows, $Types) {
        $bad = New-Object 'System.Collections.Generic.List[string]'
        if ($Checker.rows.Count -ne $Rows.Count) { $bad.Add("row count $($Checker.rows.Count) vs $($Rows.Count)"); return , $bad }
        for ($r = 0; $r -lt $Rows.Count -and $bad.Count -lt 5; $r++) {
            for ($c = 0; $c -lt $Types.Count; $c++) {
                $mine = $Rows[$r][$c]; $theirs = $Checker.rows[$r][$c]
                if ($Types[$c] -eq 'real' -and $null -ne $mine -and $null -ne $theirs) {
                    # .NET Framework parses "-0.0" as +0, so negative zero is mapped by hand.
                    $t = switch ($theirs) { 'nan' { [double]::NaN } 'inf' { [double]::PositiveInfinity } '-inf' { [double]::NegativeInfinity } '-0.0' { [BitConverter]::Int64BitsToDouble([long]::MinValue) } default { [double]::Parse($theirs, [Globalization.CultureInfo]::InvariantCulture) } }
                    if ([BitConverter]::DoubleToInt64Bits($t) -ne [BitConverter]::DoubleToInt64Bits([double]$mine)) { $bad.Add("row $r col $c real $mine vs $theirs") }
                    continue
                }
                $m = Get-CheckerText $mine
                if ($m -cne $theirs) { $bad.Add("row $r col $c '$m' vs '$theirs'") }
            }
        }
        , $bad
    }
}

AfterAll {
    if ($script:tmp -and (Test-Path -LiteralPath $script:tmp)) { Remove-Item -LiteralPath $script:tmp -Recurse -Force }
}

Describe 'Import-SemColumnar' {
    It 'compiles Columnar.cs once and is a no-op when the types exist' {
        $cmd = ". '" + $script:columnarPs1 + "'; Import-SemColumnar; Import-SemColumnar; [SemColumnar.ColumnarFiles]::KnownTypes.Count"
        $out = powershell.exe -NoProfile -NonInteractive -Command $cmd
        "$out".Trim() | Should -Be '7'
    }

    It 'keeps the PowerShell files ASCII-only' {
        foreach ($p in $script:columnarPs1, $PSCommandPath) {
            $bytes = [IO.File]::ReadAllBytes($p)
            @($bytes | Where-Object { $_ -gt 127 }).Count | Should -Be 0 -Because $p
        }
    }
}

Describe 'Snappy' {
    It 'decodes the hand-written vector <Name>' -TestCases @(
        @{ Name = 'literal only'; Hex = '03 08 61 62 63'; Text = 'abc' }
        @{ Name = 'copy with 1-byte offset'; Hex = '0C 0C 61 62 63 64 11 04'; Text = 'abcdabcdabcd' }
        @{ Name = 'copy with 2-byte offset'; Hex = '0C 0C 61 62 63 64 1E 04 00'; Text = 'abcdabcdabcd' }
        @{ Name = 'copy with 4-byte offset'; Hex = '0C 0C 61 62 63 64 1F 04 00 00 00'; Text = 'abcdabcdabcd' }
        @{ Name = 'overlapping copy (run)'; Hex = '0A 00 61 15 01'; Text = 'aaaaaaaaaa' }
    ) {
        param($Name, $Hex, $Text)
        $b = [byte[]]($Hex -split ' ' | Where-Object { $_ } | ForEach-Object { [Convert]::ToByte($_, 16) })
        [Text.Encoding]::ASCII.GetString([SemColumnar.Snappy]::Decompress($b)) | Should -BeExactly $Text
    }

    It 'decodes a copy-1 whose offset needs the 3 high bits in the tag' {
        # 256 distinct bytes as one literal (tag 60, one length byte), then copy 11 bytes from offset 256:
        # tag = 01 | (11-4)<<2 | (256>>8)<<5 = 0x3D, then the low offset byte 0x00.
        $lit = [byte[]](0..255)
        $enc = Join-Bytes (Get-Varint 267) ([byte[]](0xF0, 0xFF)) $lit ([byte[]](0x3D, 0x00))
        $dec = [SemColumnar.Snappy]::Decompress($enc)
        $dec.Length | Should -Be 267
        ($dec[256..266] -join ',') | Should -Be '0,1,2,3,4,5,6,7,8,9,10'
    }

    It 'decodes literals with 1-, 2- and 3-byte length extensions' {
        foreach ($n in 100, 300, 70000) {
            $data = New-Object byte[] $n
            for ($i = 0; $i -lt $n; $i++) { $data[$i] = [byte](($i * 7) % 251) }
            $l = $n - 1
            $tag = if ($n -le 256) { @(240, $l) } elseif ($n -le 65536) { @(244, ($l -band 255), ($l -shr 8)) } else { @(248, ($l -band 255), (($l -shr 8) -band 255), ($l -shr 16)) }
            $enc = Join-Bytes (Get-Varint $n) ([byte[]]$tag) $data
            $dec = [SemColumnar.Snappy]::Decompress($enc)
            [Convert]::ToBase64String($dec) | Should -Be ([Convert]::ToBase64String($data))
        }
    }

    It 'rejects <Name>' -TestCases @(
        @{ Name = 'an offset before the start'; Hex = '08 04 61 62 0D 05' }
        @{ Name = 'a zero offset'; Hex = '08 04 61 62 0D 00' }
        @{ Name = 'output shorter than declared'; Hex = '05 08 61 62 63' }
        @{ Name = 'a literal past the input'; Hex = '05 10 61 62' }
        @{ Name = 'a truncated copy'; Hex = '08 04 61 62 0E' }
        @{ Name = 'a copy past the declared length'; Hex = '04 04 61 62 0D 02' }
    ) {
        param($Name, $Hex)
        $b = [byte[]]($Hex -split ' ' | ForEach-Object { [Convert]::ToByte($_, 16) })
        { [SemColumnar.Snappy]::Decompress($b) } | Should -Throw
    }

    It 'round trips <Name> through its own compressor' -TestCases @(
        @{ Name = 'empty input'; Kind = 'empty'; Size = 0 }
        @{ Name = 'a short string'; Kind = 'text'; Size = 11 }
        @{ Name = 'repetitive text'; Kind = 'repeat'; Size = 200000 }
        @{ Name = 'random bytes'; Kind = 'random'; Size = 100000 }
        @{ Name = 'a 1 MB mix across 64 KB blocks'; Kind = 'mix'; Size = 1048576 }
    ) {
        param($Name, $Kind, $Size)
        $rng = New-Object Random 42
        $data = New-Object byte[] $Size
        switch ($Kind) {
            'text' { $data = [Text.Encoding]::ASCII.GetBytes('hello world') }
            'repeat' { $p = [Text.Encoding]::ASCII.GetBytes('Semaphore columnar, row group. '); for ($i = 0; $i -lt $Size; $i++) { $data[$i] = $p[$i % $p.Length] } }
            'random' { $rng.NextBytes($data) }
            'mix' { $rng.NextBytes($data); for ($i = 0; $i -lt $Size; $i += 4096) { $len = [Math]::Min(2048, $Size - $i); [Array]::Clear($data, $i, $len) } }
        }
        $c = [SemColumnar.Snappy]::Compress($data)
        $d = [SemColumnar.Snappy]::Decompress($c)
        $d.Length | Should -Be $data.Length
        [Convert]::ToBase64String($d) | Should -Be ([Convert]::ToBase64String($data))
        if ($Kind -eq 'repeat') { $c.Length | Should -BeLessThan ($Size / 10) }
        if ($Kind -eq 'random') { $c.Length | Should -BeLessThan ($Size + $Size / 6 + 32) }
    }
}

Describe 'Parquet reader on a hand-built golden file' {
    BeforeAll {
        $script:goldenPath = Join-Path $script:tmp 'golden.parquet'
        [IO.File]::WriteAllBytes($script:goldenPath, (Get-GoldenParquet))
    }

    It 'reads the names, types and row count from the thrift footer' {
        $r = [SemColumnar.ColumnarFiles]::Open($script:goldenPath)
        try {
            ($r.Names -join ',') | Should -Be 'id,name,day,ts,amount,flag,ratio,u32,uid,tsm,word,qty,big'
            ($r.Types -join ',') | Should -Be 'integer,text,date,datetime,real,boolean,real,integer,text,datetime,text,integer,integer'
            $r.RowCount | Should -Be 5
        }
        finally { $r.Dispose() }
    }

    It 'decodes every encoding, codec and logical type in it' {
        $rows = Read-All ([SemColumnar.ColumnarFiles]::Open($script:goldenPath))
        $rows.Count | Should -Be 5
        $col = { param($i) , @($rows | ForEach-Object { , $_[$i] }) }
        $zolw = -join [char[]](0x17C, 0xF3, 0x142, 0x77)
        (& $col 0) | Should -Be @([long]1, [long]2, [long]3, [long]-4, [long]9007199254740993)
        (& $col 0)[4] | Should -BeOfType [long]
        $names = & $col 1
        $names[0] | Should -BeExactly 'alpha'; $names[1] | Should -BeExactly 'beta'; $names[2] | Should -BeNullOrEmpty; $names[3] | Should -BeExactly 'alpha'; $names[4] | Should -BeExactly $zolw
        $epoch = New-Object DateTime 1970, 1, 1
        $days = & $col 2
        $days[0] | Should -Be $epoch.AddDays(19000).ToString('yyyy-MM-dd')
        $days[1] | Should -Be $epoch.AddDays(19001).ToString('yyyy-MM-dd')
        $null -eq $days[2] | Should -BeTrue
        $days[3] | Should -Be $epoch.AddDays(19005).ToString('yyyy-MM-dd')
        $days[4] | Should -Be $epoch.AddDays(18990).ToString('yyyy-MM-dd')
        (& $col 3)[0] | Should -Be '2024-01-02T03:04:05.678Z'
        $null -eq (& $col 3)[1] | Should -BeTrue
        (& $col 3)[2] | Should -Be '1970-01-01T00:00:00Z'
        (& $col 3)[3] | Should -Be '1899-12-31T23:59:59Z'
        (& $col 3)[4] | Should -Be '2000-02-29T12:00:00.500Z'
        (& $col 4) | Should -Be @(123.45, -1.0, 0.0, 999999999.99, -0.01)
        (& $col 5) | Should -Be @($true, $false, $true, $true, $false)
        $ratio = & $col 6
        $ratio[0] | Should -Be 0.5; $null -eq $ratio[1] | Should -BeTrue; $ratio[2] | Should -Be -2.25; $ratio[3] | Should -Be 1e300; $ratio[4] | Should -Be 3.0
        (& $col 7) | Should -Be @([long]4294967295, [long]0, [long]1, [long]2147483648, [long]7)
        (& $col 8)[0] | Should -Be '00112233-4455-6677-8899-aabbccddeeff'
        @((& $col 8)[1..4] | Where-Object { $null -ne $_ }).Count | Should -Be 0
        $tsm = & $col 9
        $tsm[0] | Should -Be '2023-11-14T22:13:20.123Z'; $null -eq $tsm[1] | Should -BeTrue; $tsm[2] | Should -Be '1969-12-31T23:59:59.999Z'; $tsm[3] | Should -Be '1970-01-01T00:00:00Z'; $null -eq $tsm[4] | Should -BeTrue
        (& $col 10) | Should -Be @('apple', 'apply', 'apt', 'b', '')
        $qty = & $col 11
        $qty[0..3] | Should -Be @([long]-7, [long]-7, [long]-7, [long]-7); $null -eq $qty[4] | Should -BeTrue
        (& $col 12) | Should -Be $script:goldenBig[0..4]
    }

    It 'decodes DELTA_BINARY_PACKED across several blocks and miniblocks' {
        $cols = (Get-GoldenParquetColumns)[-1]
        $vals = Get-DeltaPacked $script:goldenBig
        $raw = Join-Bytes (Get-DefLevels (@(1) * 300)) $vals
        $cols.Pages = @(New-V1Page $raw 300 5 1)
        $cols.Codec = 1
        $rows = Read-All (Open-Bytes (New-ParquetBytes @($cols) 300 $null) 'parquet')
        @($rows | ForEach-Object { $_[0] }) | Should -Be $script:goldenBig
    }

    It 'refuses <Codec> with the codec name and a Snappy hint' -TestCases @(
        @{ Codec = 'ZSTD'; Id = 6 }, @{ Codec = 'LZ4'; Id = 5 }, @{ Codec = 'BROTLI'; Id = 4 }, @{ Codec = 'LZ4_RAW'; Id = 7 }, @{ Codec = 'LZO'; Id = 3 }
    ) {
        param($Codec, $Id)
        $cols = (Get-GoldenParquetColumns)[0]
        $cols.Codec = $Id
        $b = New-ParquetBytes @($cols) 5 $null
        { Open-Bytes $b $null } | Should -Throw ("*'id' is compressed with $Codec,*Re-save the file with Snappy*")
    }

    It 'refuses nested and repeated columns and lists them' {
        $cols = (Get-GoldenParquetColumns)[0]
        $extra = @(
            @{ Top = $true; Schema = (TS @((TF 3 'i32' 1), (TF 4 'str' 'points'), (TF 5 'i32' 1), (TF 6 'i32' 3))) },
            @{ Top = $false; Schema = (TS @((TF 1 'i32' 1), (TF 3 'i32' 2), (TF 4 'str' 'element'))) },
            @{ Top = $true; Schema = (TS @((TF 1 'i32' 2), (TF 3 'i32' 2), (TF 4 'str' 'tags'))) }
        )
        $b = New-ParquetBytes @($cols) 5 $extra
        { Open-Bytes $b $null } | Should -Throw '*Parquet column(s) points, tags are nested or repeated*flat tables only*'
    }

    It 'rejects <Name>' -TestCases @(
        @{ Name = 'a file without the PAR1 footer'; Cut = 3; Message = '*PAR1 footer magic is missing*' }
        @{ Name = 'a file that is not columnar at all'; Cut = -1; Message = '*Not a Parquet or Arrow file*' }
    ) {
        param($Name, $Cut, $Message)
        $b = [IO.File]::ReadAllBytes($script:goldenPath)
        if ($Cut -gt 0) { $b = $b[0..($b.Length - 1 - $Cut)] } else { $b = [Text.Encoding]::ASCII.GetBytes('id,name' + "`n" + '1,alpha' + "`n") }
        { Open-Bytes ([byte[]]$b) $null } | Should -Throw $Message
    }

    It 'reports an unknown encoding by name' {
        $cols = (Get-GoldenParquetColumns)[0]
        $cols.Pages = @(New-V1Page (Join-Bytes (I64 1)) 5 1 0)
        $r = Open-Bytes (New-ParquetBytes @($cols) 5 $null) 'parquet'
        $row = New-Object object[] 1
        try { { $r.Next($row) } | Should -Throw "*'id'*GROUP_VAR_INT*" } finally { $r.Dispose() }
    }
}

Describe 'Arrow reader on hand-built golden files' {
    BeforeAll {
        $script:expectArrow = {
            param($rows)
            $col = { param($i) , @($rows | ForEach-Object { , $_[$i] }) }
            $rows.Count | Should -Be 4
            $n = & $col 0; $n[0] | Should -Be 1; $null -eq $n[1] | Should -BeTrue; $n[2] | Should -Be -3; $n[3] | Should -Be 2147483647
            $n[0] | Should -BeOfType [long]
            (& $col 1) | Should -Be @([long]0, [long]255, [long]7, [long]128)
            $s = & $col 2; $s[0] | Should -BeExactly 'a'; $s[1] | Should -BeExactly ''; $null -eq $s[2] | Should -BeTrue; $s[3] | Should -BeExactly ('z' + [char]0xE9)
            $ls = & $col 3; $ls[0] | Should -BeExactly 'x'; $ls[1] | Should -BeExactly 'yy'; $null -eq $ls[2] | Should -BeTrue; $ls[3] | Should -BeExactly 'zzz'
            $d = & $col 4; $d[0] | Should -BeExactly 'green'; $d[1] | Should -BeExactly 'red'; $null -eq $d[2] | Should -BeTrue; $d[3] | Should -BeExactly 'green'
            $t = & $col 5; $t[0] | Should -Be '1970-01-01T00:00:00Z'; $t[1] | Should -Be '2023-11-14T22:13:20.123Z'; $null -eq $t[2] | Should -BeTrue; $t[3] | Should -Be '1969-12-31T23:59:59.999Z'
            $dt = & $col 6; $dt[0..2] | Should -Be @('1970-01-01', '2024-01-01', '1969-12-31'); $null -eq $dt[3] | Should -BeTrue
            $d64 = & $col 7; $d64[0..2] | Should -Be @('1970-01-03', '1969-12-31', '1970-01-01'); $null -eq $d64[3] | Should -BeTrue
            $b = & $col 8; $b[0] | Should -BeTrue; $b[1] | Should -BeFalse; $null -eq $b[2] | Should -BeTrue; $b[3] | Should -BeTrue
            $dec = & $col 9; $dec[0..2] | Should -Be @(123.45, -0.01, 0.0); $null -eq $dec[3] | Should -BeTrue
            $f = & $col 10; $f[0] | Should -Be 0.5; $f[1] | Should -Be -1.25; $null -eq $f[2] | Should -BeTrue; $f[3] | Should -Be 3.0
            $bin = & $col 11; ($bin[0] -join ',') | Should -Be '1,2'; $bin[1].Length | Should -Be 0; $null -eq $bin[2] | Should -BeTrue; ($bin[3] -join ',') | Should -Be '255'
            $tm = & $col 12; $tm[0] | Should -Be '01:02:03.004'; $tm[1] | Should -Be '00:00:00'; $null -eq $tm[2] | Should -BeTrue; $tm[3] | Should -Be '23:59:59'
            @((& $col 13) | Where-Object { $null -ne $_ }).Count | Should -Be 0
        }
    }

    It 'reads the file format (ARROW1, footer blocks, dictionary batch)' {
        $p = Join-Path $script:tmp 'golden.arrow'
        [IO.File]::WriteAllBytes($p, (Get-ArrowGolden))
        $r = [SemColumnar.ColumnarFiles]::Open($p)
        ($r.Names -join ',') | Should -Be 'n,u8,s,ls,d,t,dt,d64,b,dec,f32,bin,tm,nul'
        ($r.Types -join ',') | Should -Be 'integer,integer,text,text,text,datetime,date,date,boolean,real,real,blob,text,text'
        $r.RowCount | Should -Be 4
        & $script:expectArrow (Read-All $r)
    }

    It 'reads the stream format, detected by its continuation marker' {
        $b = Get-ArrowGolden -Stream
        $r = Open-Bytes $b $null
        $null -eq $r.RowCount | Should -BeTrue
        & $script:expectArrow (Read-All $r)
        & $script:expectArrow (Read-All (Open-Bytes $b 'arrow'))
    }

    It 'refuses <Codec> body compression with a clear message' -TestCases @(@{ Codec = 'LZ4_FRAME'; Id = 0 }, @{ Codec = 'ZSTD'; Id = 1 }) {
        param($Codec, $Id)
        $comp = FbR 3 (FbT @((FbS 0 1 $Id), (FbS 1 1 0)))
        { Open-Bytes (Get-ArrowGolden -Compression $comp) $null } | Should -Throw "*uses $Codec body compression*Re-save it uncompressed*"
        $r = Open-Bytes (Get-ArrowGolden -Stream -Compression $comp) $null
        $row = New-Object object[] 14
        try { { $r.Next($row) } | Should -Throw "*uses $Codec body compression*" } finally { $r.Dispose() }
    }

    It 'reads Utf8View and BinaryView columns (inline and out-of-line views, variadic buffers)' {
        $long = 'a string longer than twelve'
        $view = {
            param([byte[]]$B, [int]$Buf, [int]$Off)
            $v = New-Object byte[] 16
            [Array]::Copy([BitConverter]::GetBytes([int]$B.Length), 0, $v, 0, 4)
            if ($B.Length -le 12) { [Array]::Copy($B, 0, $v, 4, $B.Length) }
            else { [Array]::Copy($B, 0, $v, 4, 4); [Array]::Copy([BitConverter]::GetBytes($Buf), 0, $v, 8, 4); [Array]::Copy([BitConverter]::GetBytes($Off), 0, $v, 12, 4) }
            , $v
        }
        $body = New-ArrowBody
        Add-ArrowBuf $body ([byte[]]@(0x0D))
        Add-ArrowBuf $body (Join-Bytes (& $view (Utf8 'short') 0 0) (New-Object byte[] 16) (& $view (Utf8 $long) 0 0) (& $view ([byte[]]@()) 0 0))
        Add-ArrowBuf $body (Utf8 $long)
        Add-ArrowBuf $body ([byte[]]@(0x0B))
        Add-ArrowBuf $body (Join-Bytes (& $view ([byte[]](1, 2)) 0 0) (& $view ([byte[]]@()) 0 0) (New-Object byte[] 16) (& $view ([byte[]](@(255) * 12)) 0 0))
        $schema = FbT @((FbR 1 (FbVec @((New-ArrowField 'sv' 24 (FbT @()) $null @()), (New-ArrowField 'bv' 23 (FbT @()) $null @())))))
        $variadic = FbR 4 (FbStructs (Get-Structs @(1, 0)) 2)
        $rb = Get-ArrowMessage 3 (New-RecordBatch 4 @(4, 1, 4, 1) $body $variadic) $body.Bytes.ToArray()
        $b = Join-Bytes (Get-ArrowMessage 1 $schema ([byte[]]@())).Bytes $rb.Bytes ([byte[]](0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0))
        $r = Open-Bytes $b $null
        ($r.Types -join ',') | Should -Be 'text,blob'
        $rows = Read-All $r
        $rows.Count | Should -Be 4
        $rows[0][0] | Should -BeExactly 'short'; $null -eq $rows[1][0] | Should -BeTrue; $rows[2][0] | Should -BeExactly $long; $rows[3][0] | Should -BeExactly ''
        ($rows[0][1] -join ',') | Should -Be '1,2'; $rows[1][1].Length | Should -Be 0; $null -eq $rows[2][1] | Should -BeTrue; ($rows[3][1] -join ',') | Should -Be ((@(255) * 12) -join ',')
    }

    It 'names Feather version 1 files instead of calling them unknown' {
        { Open-Bytes (Join-Bytes ([Text.Encoding]::ASCII.GetBytes('FEA1')) (New-Object byte[] 32)) $null } | Should -Throw '*Feather version 1*Re-save it as Feather version 2*'
    }

    It 'refuses nested columns and lists them' {
        $child = New-ArrowField 'item' 2 (FbT @((FbS 0 4 32), (FbS 1 1 1))) $null @()
        $schema = FbT @((FbR 1 (FbVec @(
            (New-ArrowField 'ok' 2 (FbT @((FbS 0 4 32), (FbS 1 1 1))) $null @()),
            (New-ArrowField 'items' 12 (FbT @()) $null @($child)),
            (New-ArrowField 'rec' 13 (FbT @()) $null @($child))
        ))))
        $msg = Get-ArrowMessage 1 $schema ([byte[]]@())
        $b = Join-Bytes $msg.Bytes ([byte[]](0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0))
        { Open-Bytes $b $null } | Should -Throw '*Arrow column(s) items (nested type List), rec (nested type Struct) cannot be read*'
    }
}

Describe 'Writer round trips' {
    BeforeAll {
        $script:negZero = [BitConverter]::Int64BitsToDouble([long]::MinValue)
        $script:allBytes = [byte[]](0..255)
        $smile = [char]::ConvertFromUtf32(0x1F600)
        $script:edgeIn = @(
            , @([long]::MinValue, [double]::NaN, '', '0001-01-01', '0001-01-01T00:00:00Z', $true, [byte[]]@())
            , @([long]::MaxValue, [double]::PositiveInfinity, ('h' + [char]0xE9 + 'llo ' + $smile + ' ' + [char]0x4E16), '9999-12-31', '9999-12-31T23:59:59.999Z', $false, $script:allBytes)
            , @([long]0, $script:negZero, ('x' * 10000), '1970-01-01', '1970-01-01T00:00:00Z', $true, $null)
            , @($null, [DBNull]::Value, $null, [DBNull]::Value, $null, $null, [DBNull]::Value)
            , @([int]42, [decimal]2.5, 3.5, ([datetime]'2024-03-01'), [DateTime]::SpecifyKind(([datetime]'2024-03-01T12:34:56.789'), 'Utc'), 'yes', 'hi')
            , @('17', '-1e-300', 'tab	and,comma "quoted"', '2024-06-01T23:00:00Z', '2024-06-01T10:00:00+02:00', 'false', [byte[]](0))
            , @([long]-1, [double]::NegativeInfinity, 'end', '1600-02-29', '2024-06-01T10:00:00.123456Z', $true, [byte[]](9, 8))
        )
        $script:edgeOut = @(
            , @([long]::MinValue, [double]::NaN, '', '0001-01-01', '0001-01-01T00:00:00Z', $true, [byte[]]@())
            , @([long]::MaxValue, [double]::PositiveInfinity, ('h' + [char]0xE9 + 'llo ' + $smile + ' ' + [char]0x4E16), '9999-12-31', '9999-12-31T23:59:59.999Z', $false, $script:allBytes)
            , @([long]0, $script:negZero, ('x' * 10000), '1970-01-01', '1970-01-01T00:00:00Z', $true, $null)
            , @($null, $null, $null, $null, $null, $null, $null)
            , @([long]42, 2.5, '3.5', '2024-03-01', '2024-03-01T12:34:56.789Z', $true, [Text.Encoding]::UTF8.GetBytes('hi'))
            , @([long]17, -1e-300, 'tab	and,comma "quoted"', '2024-06-01', '2024-06-01T08:00:00Z', $false, [byte[]](0))
            , @([long]-1, [double]::NegativeInfinity, 'end', '1600-02-29', '2024-06-01T10:00:00.123Z', $true, [byte[]](9, 8))
        )
        $script:write = {
            param([string]$Format, [string]$Path, $Names, $Types, $Rows, [int]$GroupRows)
            if ($Format -eq 'parquet') {
                if ($GroupRows) { [SemColumnar.ColumnarFiles]::WriteParquet($Path, $Names, $Types, $Rows, $GroupRows) }
                else { [SemColumnar.ColumnarFiles]::WriteParquet($Path, $Names, $Types, $Rows) }
            }
            else { [SemColumnar.ColumnarFiles]::WriteArrow($Path, $Names, $Types, $Rows) }
        }
        $script:asRows = { param($list) $l = New-Object 'System.Collections.Generic.List[object[]]'; foreach ($r in $list) { $l.Add([object[]]$r) }; , $l }
    }

    It 'round trips every type, edge values and nulls through <Format>' -TestCases @(@{ Format = 'parquet' }, @{ Format = 'arrow' }) {
        param($Format)
        $p = Join-Path $script:tmp ('edge.' + $Format)
        & $script:write $Format $p ([ColumnarTestKit]::Names) ([ColumnarTestKit]::Types) (& $script:asRows $script:edgeIn) 0
        $r = [SemColumnar.ColumnarFiles]::Open($p)
        ($r.Types -join ',') | Should -Be (([ColumnarTestKit]::Types) -join ',')
        ($r.Names -join ',') | Should -Be (([ColumnarTestKit]::Names) -join ',')
        $r.RowCount | Should -Be 7
        $rows = Read-All $r
        $rows.Count | Should -Be 7
        for ($i = 0; $i -lt 7; $i++) {
            for ($c = 0; $c -lt 7; $c++) {
                [ColumnarTestKit]::Same($rows[$i][$c], $script:edgeOut[$i][$c]) | Should -BeTrue -Because "row $i column $c read '$($rows[$i][$c])'"
            }
        }
    }

    It 'round trips 20,000 generated rows through <Format>' -TestCases @(@{ Format = 'parquet' }, @{ Format = 'arrow' }) {
        param($Format)
        $p = Join-Path $script:tmp ('gen.' + $Format)
        & $script:write $Format $p ([ColumnarTestKit]::Names) ([ColumnarTestKit]::Types) ([ColumnarTestKit]::Rows(20000)) 0
        [ColumnarTestKit]::Verify([SemColumnar.ColumnarFiles]::Open($p), 20000) | Should -Be 'ok'
    }

    It 'splits Parquet into row groups and Arrow into record batches' {
        $p = Join-Path $script:tmp 'groups.parquet'
        [SemColumnar.ColumnarFiles]::WriteParquet($p, [ColumnarTestKit]::Names, [ColumnarTestKit]::Types, [ColumnarTestKit]::Rows(10500), 1000)
        [ColumnarTestKit]::Verify([SemColumnar.ColumnarFiles]::Open($p), 10500) | Should -Be 'ok'
        $a = Join-Path $script:tmp 'batches.arrow'
        [SemColumnar.ColumnarFiles]::WriteArrow($a, [ColumnarTestKit]::Names, [ColumnarTestKit]::Types, [ColumnarTestKit]::Rows(140000))
        $r = [SemColumnar.ColumnarFiles]::Open($a)
        $r.RowCount | Should -Be 140000
        [ColumnarTestKit]::Verify($r, 140000) | Should -Be 'ok'
    }

    It 'dictionary-encodes low-cardinality text and not unique text' {
        $few = Join-Path $script:tmp 'few.parquet'; $many = Join-Path $script:tmp 'many.parquet'
        [SemColumnar.ColumnarFiles]::WriteParquet($few, @('i', 's'), @('integer', 'text'), [ColumnarTestKit]::Labels(100000, 4))
        [SemColumnar.ColumnarFiles]::WriteParquet($many, @('i', 's'), @('integer', 'text'), [ColumnarTestKit]::Labels(100000, 100000))
        (Get-Item $few).Length | Should -BeLessThan ((Get-Item $many).Length / 2)
        $rows = Read-All ([SemColumnar.ColumnarFiles]::Open($few))
        $rows.Count | Should -Be 100000
        $rows[99999][1] | Should -Be 'category-3'
        $rows[12345][0] | Should -Be 12345
    }

    It 'writes and reads an empty table in <Format>' -TestCases @(@{ Format = 'parquet' }, @{ Format = 'arrow' }) {
        param($Format)
        $p = Join-Path $script:tmp ('empty.' + $Format)
        & $script:write $Format $p @('a', 'b') @('integer', 'text') (New-Object 'System.Collections.Generic.List[object[]]') 0
        $r = [SemColumnar.ColumnarFiles]::Open($p)
        ($r.Names -join ',') | Should -Be 'a,b'
        $r.RowCount | Should -Be 0
        $row = New-Object object[] 2
        $r.Next($row) | Should -BeFalse
        $r.Dispose()
    }

    It 'rejects <Name> and leaves no partial file' -TestCases @(
        @{ Name = 'an unknown type'; Names = @('a'); Types = @('money'); Row = @(1); Message = "*'a' has type 'money'*" }
        @{ Name = 'a duplicate column'; Names = @('a', 'a'); Types = @('integer', 'text'); Row = @(1, 'x'); Message = "*'a' appears twice*" }
        @{ Name = 'a fractional integer'; Names = @('a'); Types = @('integer'); Row = @(1.5); Message = "*'a' is integer but a value (1.5)*" }
        @{ Name = 'a malformed date'; Names = @('a'); Types = @('date'); Row = @('31/31/2024'); Message = "*'a' is date*" }
        @{ Name = 'a malformed datetime'; Names = @('a'); Types = @('datetime'); Row = @('soon'); Message = "*'a' is datetime*" }
    ) {
        param($Name, $Names, $Types, $Row, $Message)
        foreach ($fmt in 'parquet', 'arrow') {
            $p = Join-Path $script:tmp ('bad.' + $fmt)
            { & $script:write $fmt $p $Names $Types (& $script:asRows @(, $Row)) 0 } | Should -Throw $Message
            Test-Path -LiteralPath $p | Should -BeFalse
        }
    }

    It 'passes the independent checker (<Format>)' -Skip:(-not $script:hasPython) -TestCases @(@{ Format = 'parquet' }, @{ Format = 'arrow' }) {
        param($Format)
        $p = Join-Path $script:tmp ('edge.' + $Format)
        & $script:write $Format $p ([ColumnarTestKit]::Names) ([ColumnarTestKit]::Types) (& $script:asRows $script:edgeIn) 0
        $ck = Invoke-Checker $p
        $ck.ok | Should -BeTrue -Because "$($ck.error)"
        $bad = Compare-Checker $ck $script:edgeOut ([ColumnarTestKit]::Types)
        ($bad -join '; ') | Should -BeNullOrEmpty
        $g = Join-Path $script:tmp ('checked.' + $Format)
        & $script:write $Format $g ([ColumnarTestKit]::Names) ([ColumnarTestKit]::Types) ([ColumnarTestKit]::Rows(5000)) 1000
        $ck = Invoke-Checker $g
        $ck.ok | Should -BeTrue -Because "$($ck.error)"
        $rows = Read-All ([SemColumnar.ColumnarFiles]::Open($g))
        ((Compare-Checker $ck $rows ([ColumnarTestKit]::Types)) -join '; ') | Should -BeNullOrEmpty
        if ($Format -eq 'parquet') {
            $ck.row_groups | Should -Be 5
            ($ck.encodings[2] -join ',') | Should -Be '0,3,8'
            ($ck.encodings[0] -join ',') | Should -Be '0,3'
        }
    }

    It 'writes and reads 1,000,000 rows (<Format>) and reports the speed' -TestCases @(@{ Format = 'parquet' }, @{ Format = 'arrow' }) {
        param($Format)
        $n = 1000000
        $p = Join-Path $script:tmp ('million.' + $Format)
        $sw = [Diagnostics.Stopwatch]::StartNew()
        & $script:write $Format $p ([ColumnarTestKit]::Names) ([ColumnarTestKit]::Types) ([ColumnarTestKit]::Rows($n)) 0
        $w = $sw.Elapsed.TotalSeconds
        $sw.Restart()
        $r = [SemColumnar.ColumnarFiles]::Open($p)
        [ColumnarTestKit]::Count($r, 7) | Should -Be $n
        $r.Dispose()
        $rd = $sw.Elapsed.TotalSeconds
        $mb = (Get-Item $p).Length / 1MB
        Write-Host ('      {0}: 1M rows x 7 columns, {1:N1} MB; write {2:N2} s ({3:N0} rows/s), read {4:N2} s ({5:N0} rows/s)' -f $Format, $mb, $w, ($n / $w), $rd, ($n / $rd))
        [ColumnarTestKit]::Verify([SemColumnar.ColumnarFiles]::Open($p), $n) | Should -Be 'ok'
    }
}

Describe 'Corrupt input' {
    It 'reports damaged <Format> files only as ColumnarException (500 random corruptions)' -TestCases @(@{ Format = 'parquet' }, @{ Format = 'arrow' }) {
        param($Format)
        $p = Join-Path $script:tmp ('fuzz.' + $Format)
        if ($Format -eq 'parquet') { [SemColumnar.ColumnarFiles]::WriteParquet($p, [ColumnarTestKit]::Names, [ColumnarTestKit]::Types, [ColumnarTestKit]::Rows(300), 100) }
        else { [SemColumnar.ColumnarFiles]::WriteArrow($p, [ColumnarTestKit]::Names, [ColumnarTestKit]::Types, [ColumnarTestKit]::Rows(300)) }
        $orig = [IO.File]::ReadAllBytes($p)
        $rng = New-Object Random 11
        $other = New-Object 'System.Collections.Generic.List[string]'
        $refused = 0
        for ($it = 0; $it -lt 500; $it++) {
            $b = [byte[]]$orig.Clone()
            for ($j = 0; $j -le $rng.Next(4); $j++) { $b[$rng.Next($b.Length)] = [byte]$rng.Next(256) }
            try { [void][ColumnarTestKit]::Count((Open-Bytes $b $null), 7) }
            catch {
                $e = $_.Exception
                while ($e -is [Management.Automation.MethodInvocationException] -and $e.InnerException) { $e = $e.InnerException }
                if ($e -is [SemColumnar.ColumnarException]) { $refused++ } else { $other.Add($e.GetType().Name + ': ' + $e.Message) }
            }
        }
        ($other | Select-Object -First 3) -join '; ' | Should -BeNullOrEmpty
        $refused | Should -BeGreaterThan 100
    }
}

Describe 'Cross-check against Arrow files from data-noodler' {
    It 'reads <Name> to match its dataset.json' -TestCases $script:fixtureCases {
        param($Name)
        $meta = Get-Content -Raw -LiteralPath (Join-Path $script:fixtures ($Name + '.dataset.json')) | ConvertFrom-Json
        $map = @{ VARCHAR = 'text'; DATE = 'date'; BIGINT = 'integer'; DOUBLE = 'real'; TIMESTAMP = 'datetime'; BOOLEAN = 'boolean' }
        $r = [SemColumnar.ColumnarFiles]::Open((Join-Path $script:fixtures ($Name + '.arrow')))
        ($r.Names -join ',') | Should -Be (($meta.columns | ForEach-Object { $_.name }) -join ',')
        ($r.Types -join ',') | Should -Be (($meta.columns | ForEach-Object { $map[$_.type] }) -join ',')
        $r.RowCount | Should -Be $meta.rowCount
        $rows = Read-All $r
        $rows.Count | Should -Be $meta.rowCount
    }

    It 'reads known values from the sample files' {
        $rows = Read-All ([SemColumnar.ColumnarFiles]::Open((Join-Path $script:fixtures 'SAMPLE_CUSTOMERS.arrow')))
        ($rows[0] -join '|') | Should -Be 'Alice Whitfield|alice.whitfield@example.com|512-555-0142|Austin|TX|2023-01-15|Pro'
        $rows = Read-All ([SemColumnar.ColumnarFiles]::Open((Join-Path $script:fixtures 'SAMPLE_SALES.arrow')))
        $rows[0][0] | Should -Be '2024-01-15'; $rows[0][3] | Should -Be 120; $rows[0][3] | Should -BeOfType [long]; $rows[0][4] | Should -Be 3600.0
        $rows = Read-All ([SemColumnar.ColumnarFiles]::Open((Join-Path $script:fixtures 'CLEAN_FUEL_BY_CLASS_MONTH.arrow')))
        ($rows[0][0..2] -join '|') | Should -Be 'Cutter|2025-01-01|15040'
        [Math]::Abs($rows[0][3] - 33171572.7) | Should -BeLessThan 1e-6
    }

    It 'reads the 1.55M-row FUEL_LOG file and matches its source CSV' -Skip:(-not $script:hasFuel) {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $r = [SemColumnar.ColumnarFiles]::Open($script:fuelArrow)
        $r.RowCount | Should -Be 1550000
        [ColumnarTestKit]::Count($r, 9) | Should -Be 1550000
        $r.Dispose()
        Write-Host ('      FUEL_LOG: 1,550,000 rows x 9 columns read in {0:N2} s' -f $sw.Elapsed.TotalSeconds)
        $r = [SemColumnar.ColumnarFiles]::Open($script:fuelArrow)
        $row = New-Object object[] 9
        $csv = [IO.File]::OpenText($script:fuelCsv)
        $bad = New-Object 'System.Collections.Generic.List[string]'
        try {
            $csv.ReadLine() | Should -Be ($r.Names -join ',')
            for ($i = 0; $i -lt 5000; $i++) {
                if (-not $r.Next($row)) { $bad.Add("ran out at row $i"); break }
                $f = $csv.ReadLine().Split(',')
                $want = @(($f[0].Replace(' ', 'T') + 'Z'), $f[1], $f[2], $f[3], $f[4],
                    [double]::Parse($f[5], [Globalization.CultureInfo]::InvariantCulture), [double]::Parse($f[6], [Globalization.CultureInfo]::InvariantCulture),
                    [double]::Parse($f[7], [Globalization.CultureInfo]::InvariantCulture), [long]$f[8])
                for ($c = 0; $c -lt 9; $c++) { if (-not [ColumnarTestKit]::Same($row[$c], $want[$c])) { $bad.Add("row $i column $c '$($row[$c])' vs '$($want[$c])'") } }
                if ($bad.Count -gt 5) { break }
            }
        }
        finally { $csv.Dispose(); $r.Dispose() }
        ($bad -join '; ') | Should -BeNullOrEmpty
    }
}
