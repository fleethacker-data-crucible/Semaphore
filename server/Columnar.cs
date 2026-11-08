// Columnar.cs: Parquet and Arrow IPC readers and writers for Semaphore's local database.
// C# 5, .NET Framework 4.x, no dependencies beyond mscorlib and System.dll. Compiled at run time
// by Windows PowerShell 5.1 (Add-Type), so: no string interpolation, no ?., no expression bodies,
// no nameof, no unsafe code.
//
// Value model shared by every reader and writer (column Types):
//   integer -> long, real -> double, text -> string, date -> "yyyy-MM-dd",
//   datetime -> "yyyy-MM-ddTHH:mm:ss[.fff]Z", boolean -> bool, blob -> byte[]; null -> null.
//
// Parquet: thrift compact footer and page headers, PLAIN, dictionary (PLAIN_DICTIONARY and
// RLE_DICTIONARY), RLE/bit-packed levels, DELTA_BINARY_PACKED, DELTA_LENGTH_BYTE_ARRAY,
// DELTA_BYTE_ARRAY, BYTE_STREAM_SPLIT, data pages v1 and v2, codecs UNCOMPRESSED, SNAPPY and GZIP.
// Arrow IPC: file (ARROW1) and stream formats, flat columns, dictionary-encoded columns.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Text;

namespace SemColumnar
{
    public interface ITableReader : IDisposable
    {
        string[] Names { get; }
        string[] Types { get; }
        long? RowCount { get; }
        bool Next(object[] row);
    }

    public class ColumnarException : Exception
    {
        public ColumnarException(string message) : base(message) { }
        public ColumnarException(string message, Exception inner) : base(message, inner) { }
    }

    public static class ColumnarFiles
    {
        public const int DefaultRowGroupRows = 131072;
        public static readonly string[] KnownTypes = new string[] { "integer", "real", "text", "date", "datetime", "boolean", "blob" };

        public static ITableReader Open(string path)
        {
            if (path == null) throw new ArgumentNullException("path");
            FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16);
            try { return Open(fs, null); }
            catch { fs.Dispose(); throw; }
        }

        // kind: "parquet", "arrow" (file or stream), or null/"auto" to detect from the magic bytes.
        // On success the reader owns the stream and disposes it.
        public static ITableReader Open(Stream s, string kind)
        {
            if (s == null) throw new ArgumentNullException("s");
            if (!s.CanSeek)
            {
                MemoryStream ms = new MemoryStream();
                s.CopyTo(ms);
                s.Dispose();
                ms.Position = 0;
                s = ms;
            }
            string k = kind == null ? "" : kind.Trim().ToLowerInvariant();
            if (k == "" || k == "auto") k = Detect(s);
            if (k == "parquet") return new ParquetReader(s);
            if (k == "arrow" || k == "ipc" || k == "feather" || k == "arrows" || k == "arrow-file" || k == "arrow-stream") return new ArrowReader(s);
            throw new ColumnarException("Unknown columnar kind '" + kind + "': use parquet or arrow.");
        }

        static string Detect(Stream s)
        {
            long start = s.Position;
            byte[] head = new byte[8];
            int n = 0;
            while (n < 8) { int r = s.Read(head, n, 8 - n); if (r <= 0) break; n += r; }
            s.Position = start;
            if (n >= 4 && head[0] == 'P' && head[1] == 'A' && head[2] == 'R' && head[3] == '1') return "parquet";
            if (n >= 4 && head[0] == 'P' && head[1] == 'A' && head[2] == 'R' && head[3] == 'E')
                throw new ColumnarException("This Parquet file is encrypted (PARE footer); Semaphore cannot read encrypted Parquet.");
            if (n >= 6 && head[0] == 'A' && head[1] == 'R' && head[2] == 'R' && head[3] == 'O' && head[4] == 'W' && head[5] == '1') return "arrow";
            if (n >= 4 && head[0] == 'F' && head[1] == 'E' && head[2] == 'A' && head[3] == '1')
                throw new ColumnarException("This is a Feather version 1 file, an old format Semaphore does not read. Re-save it as Feather version 2 (Arrow IPC), for example pyarrow feather.write_feather(table, path, version=2, compression='uncompressed').");
            if (n >= 8 && head[0] == 0xFF && head[1] == 0xFF && head[2] == 0xFF && head[3] == 0xFF) return "arrow";
            throw new ColumnarException("Not a Parquet or Arrow file: the first bytes are not PAR1, ARROW1 or an Arrow stream marker.");
        }

        public static void WriteParquet(string path, string[] names, string[] types, IEnumerable<object[]> rows)
        {
            WriteParquet(path, names, types, rows, DefaultRowGroupRows);
        }

        public static void WriteParquet(string path, string[] names, string[] types, IEnumerable<object[]> rows, int rowGroupRows)
        {
            CheckSchema(names, types);
            if (rows == null) throw new ArgumentNullException("rows");
            if (rowGroupRows <= 0) rowGroupRows = DefaultRowGroupRows;
            WriteSafely(path, delegate(Stream fs) { new ParquetWriter(fs, names, types, rowGroupRows).Write(rows); });
        }

        public static void WriteArrow(string path, string[] names, string[] types, IEnumerable<object[]> rows)
        {
            CheckSchema(names, types);
            if (rows == null) throw new ArgumentNullException("rows");
            WriteSafely(path, delegate(Stream fs) { new ArrowWriter(fs, names, types, 65536).Write(rows); });
        }

        delegate void StreamAction(Stream s);

        static void WriteSafely(string path, StreamAction act)
        {
            if (path == null) throw new ArgumentNullException("path");
            bool ok = false;
            FileStream fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16);
            try
            {
                act(fs);
                fs.Flush();
                ok = true;
            }
            finally
            {
                fs.Dispose();
                if (!ok) { try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { } }
            }
        }

        static void CheckSchema(string[] names, string[] types)
        {
            if (names == null) throw new ArgumentNullException("names");
            if (types == null) throw new ArgumentNullException("types");
            if (names.Length != types.Length) throw new ArgumentException("names and types must have the same length (" + names.Length + " vs " + types.Length + ").");
            if (names.Length == 0) throw new ArgumentException("At least one column is required.");
            Dictionary<string, bool> seen = new Dictionary<string, bool>(StringComparer.Ordinal);
            for (int i = 0; i < names.Length; i++)
            {
                if (string.IsNullOrEmpty(names[i])) throw new ArgumentException("Column " + i + " has no name.");
                if (seen.ContainsKey(names[i])) throw new ArgumentException("Column name '" + names[i] + "' appears twice.");
                seen[names[i]] = true;
                if (Array.IndexOf(KnownTypes, types[i]) < 0)
                    throw new ArgumentException("Column '" + names[i] + "' has type '" + types[i] + "'; use one of " + string.Join(", ", KnownTypes) + ".");
            }
        }
    }

    // ------------------------------------------------------------------------------------------
    // Shared value conversion and formatting
    // ------------------------------------------------------------------------------------------
    internal static class Val
    {
        public const long EpochTicks = 621355968000000000L;

        public static long FloorDiv(long a, long b)
        {
            long q = a / b;
            if ((a % b != 0) && ((a < 0) != (b < 0))) q--;
            return q;
        }

        public static void CivilFromDays(long days, out long y, out int m, out int d)
        {
            long z = days + 719468;
            long era = (z >= 0 ? z : z - 146096) / 146097;
            long doe = z - era * 146097;
            long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
            y = yoe + era * 400;
            long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            long mp = (5 * doy + 2) / 153;
            d = (int)(doy - (153 * mp + 2) / 5 + 1);
            m = (int)(mp < 10 ? mp + 3 : mp - 9);
            if (m <= 2) y++;
        }

        public static long DaysFromCivil(long y, int m, int d)
        {
            if (m <= 2) y--;
            long era = (y >= 0 ? y : y - 399) / 400;
            long yoe = y - era * 400;
            long doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
            long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
            return era * 146097 + doe - 719468;
        }

        static void Put2(char[] c, int at, int v) { c[at] = (char)('0' + v / 10); c[at + 1] = (char)('0' + v % 10); }

        static string Year(long y)
        {
            if (y >= 0 && y <= 9999) return y.ToString("D4", CultureInfo.InvariantCulture);
            if (y > 9999) return "+" + y.ToString(CultureInfo.InvariantCulture);
            return "-" + (-y).ToString("D4", CultureInfo.InvariantCulture);
        }

        public static string FormatDate(long days)
        {
            long y; int m, d;
            CivilFromDays(days, out y, out m, out d);
            if (y >= 0 && y <= 9999)
            {
                char[] c = new char[10];
                int yy = (int)y;
                c[0] = (char)('0' + yy / 1000); c[1] = (char)('0' + yy / 100 % 10); c[2] = (char)('0' + yy / 10 % 10); c[3] = (char)('0' + yy % 10);
                c[4] = '-'; Put2(c, 5, m); c[7] = '-'; Put2(c, 8, d);
                return new string(c);
            }
            return Year(y) + "-" + m.ToString("D2", CultureInfo.InvariantCulture) + "-" + d.ToString("D2", CultureInfo.InvariantCulture);
        }

        // value counted in units, unitsPerSecond in {1, 1e3, 1e6, 1e9}.
        public static string FormatTimestamp(long value, long unitsPerSecond)
        {
            long secs = FloorDiv(value, unitsPerSecond);
            long frac = value - secs * unitsPerSecond;
            int millis = (int)(frac * 1000 / unitsPerSecond);
            return FormatSeconds(secs, frac != 0, millis);
        }

        public static string FormatSeconds(long secs, bool hasFrac, int millis)
        {
            long days = FloorDiv(secs, 86400);
            int sod = (int)(secs - days * 86400);
            long y; int m, d;
            CivilFromDays(days, out y, out m, out d);
            char[] c = new char[hasFrac ? 24 : 20];
            if (y >= 0 && y <= 9999)
            {
                int yy = (int)y;
                c[0] = (char)('0' + yy / 1000); c[1] = (char)('0' + yy / 100 % 10); c[2] = (char)('0' + yy / 10 % 10); c[3] = (char)('0' + yy % 10);
            }
            c[4] = '-'; Put2(c, 5, m); c[7] = '-'; Put2(c, 8, d); c[10] = 'T';
            Put2(c, 11, sod / 3600); c[13] = ':'; Put2(c, 14, sod / 60 % 60); c[16] = ':'; Put2(c, 17, sod % 60);
            if (hasFrac)
            {
                c[19] = '.'; c[20] = (char)('0' + millis / 100); c[21] = (char)('0' + millis / 10 % 10); c[22] = (char)('0' + millis % 10); c[23] = 'Z';
            }
            else c[19] = 'Z';
            string s = new string(c);
            if (y < 0 || y > 9999) s = Year(y) + s.Substring(4);
            return s;
        }

        public static string FormatTime(long value, long unitsPerSecond)
        {
            long secs = FloorDiv(value, unitsPerSecond);
            long frac = value - secs * unitsPerSecond;
            long sod = ((secs % 86400) + 86400) % 86400;
            string s = (sod / 3600).ToString("D2", CultureInfo.InvariantCulture) + ":" + (sod / 60 % 60).ToString("D2", CultureInfo.InvariantCulture) + ":" + (sod % 60).ToString("D2", CultureInfo.InvariantCulture);
            if (frac != 0) s += "." + (frac * 1000 / unitsPerSecond).ToString("D3", CultureInfo.InvariantCulture);
            return s;
        }

        public static double DecimalFromLong(long unscaled, int scale)
        {
            if (scale == 0) return (double)unscaled;
            if (scale > 0 && scale <= 28)
            {
                bool neg = unscaled < 0;
                ulong mag = neg ? (ulong)(-(unscaled + 1)) + 1UL : (ulong)unscaled;
                decimal d = new decimal((int)(uint)(mag & 0xFFFFFFFFUL), (int)(uint)(mag >> 32), 0, neg, (byte)scale);
                return (double)d;
            }
            return unscaled / Math.Pow(10, scale);
        }

        // Two's complement integer of len bytes (big- or little-endian) divided by 10^scale.
        public static double DecimalFromBytes(byte[] b, int off, int len, int scale, bool bigEndian)
        {
            if (len == 0) return 0.0;
            byte[] le = new byte[len];
            for (int i = 0; i < len; i++) le[i] = bigEndian ? b[off + len - 1 - i] : b[off + i];
            bool neg = (le[len - 1] & 0x80) != 0;
            if (neg)
            {
                int carry = 1;
                for (int i = 0; i < len; i++) { int v = (~le[i] & 0xFF) + carry; le[i] = (byte)v; carry = v >> 8; }
            }
            int top = len;
            while (top > 0 && le[top - 1] == 0) top--;
            if (top <= 12 && scale >= 0 && scale <= 28)
            {
                int lo = 0, mid = 0, hi = 0;
                for (int i = 0; i < top; i++)
                {
                    if (i < 4) lo |= le[i] << (8 * i);
                    else if (i < 8) mid |= le[i] << (8 * (i - 4));
                    else hi |= le[i] << (8 * (i - 8));
                }
                return (double)new decimal(lo, mid, hi, neg, (byte)scale);
            }
            double m = 0;
            for (int i = top - 1; i >= 0; i--) m = m * 256.0 + le[i];
            if (neg) m = -m;
            return m / Math.Pow(10, scale);
        }

        public static double HalfToDouble(int h)
        {
            int sign = (h >> 15) & 1, exp = (h >> 10) & 0x1F, man = h & 0x3FF;
            double v;
            if (exp == 0) v = man * Math.Pow(2, -24);
            else if (exp == 31) v = man == 0 ? double.PositiveInfinity : double.NaN;
            else v = (1.0 + man / 1024.0) * Math.Pow(2, exp - 15);
            return sign == 1 ? -v : v;
        }

        static readonly char[] Hex = "0123456789abcdef".ToCharArray();

        public static string Uuid(byte[] b, int off, int len)
        {
            if (len != 16) return Convert.ToBase64String(b, off, len);
            char[] c = new char[36];
            int p = 0;
            for (int i = 0; i < 16; i++)
            {
                if (i == 4 || i == 6 || i == 8 || i == 10) c[p++] = '-';
                c[p++] = Hex[b[off + i] >> 4]; c[p++] = Hex[b[off + i] & 15];
            }
            return new string(c);
        }

        public static byte[] Slice(byte[] b, int off, int len)
        {
            byte[] r = new byte[len];
            Buffer.BlockCopy(b, off, r, 0, len);
            return r;
        }

        public static int LE16(byte[] b, int p) { return b[p] | (b[p + 1] << 8); }
        public static int LE32(byte[] b, int p) { return b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24); }
        public static long LE64(byte[] b, int p) { return (long)(uint)LE32(b, p) | ((long)LE32(b, p + 4) << 32); }

        // ---------- writer-side normalization ----------
        public static bool IsNull(object v) { return v == null || v is DBNull; }

        public static long ToLong(object v, string col)
        {
            if (v is long) return (long)v;
            if (v is int) return (int)v;
            if (v is short) return (short)v;
            if (v is byte) return (byte)v;
            if (v is sbyte) return (sbyte)v;
            if (v is ushort) return (ushort)v;
            if (v is uint) return (uint)v;
            if (v is bool) return ((bool)v) ? 1 : 0;
            if (v is ulong)
            {
                ulong u = (ulong)v;
                if (u > long.MaxValue) throw new ColumnarException("Column '" + col + "' is integer but a value (" + u + ") is above the 64-bit signed range.");
                return (long)u;
            }
            if (v is double || v is float || v is decimal)
            {
                double d = Convert.ToDouble(v, CultureInfo.InvariantCulture);
                if (d != Math.Floor(d) || d < -9.2233720368547758E18 || d >= 9.2233720368547758E18)
                    throw new ColumnarException("Column '" + col + "' is integer but a value (" + d.ToString("R", CultureInfo.InvariantCulture) + ") is not a whole 64-bit number.");
                if (v is decimal) return decimal.ToInt64((decimal)v);
                return (long)d;
            }
            string s = v as string;
            if (s != null)
            {
                long r;
                if (long.TryParse(s.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out r)) return r;
                throw new ColumnarException("Column '" + col + "' is integer but a value ('" + Clip(s) + "') is not a whole number.");
            }
            try { return Convert.ToInt64(v, CultureInfo.InvariantCulture); }
            catch (Exception e) { throw new ColumnarException("Column '" + col + "' is integer but a value of type " + v.GetType().Name + " cannot be converted.", e); }
        }

        public static double ToDouble(object v, string col)
        {
            if (v is double) return (double)v;
            if (v is long) return (long)v;
            if (v is int) return (int)v;
            if (v is float) return (float)v;
            if (v is decimal) return (double)(decimal)v;
            if (v is bool) return ((bool)v) ? 1 : 0;
            string s = v as string;
            if (s != null)
            {
                double r;
                if (double.TryParse(s.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out r)) return r;
                throw new ColumnarException("Column '" + col + "' is real but a value ('" + Clip(s) + "') is not a number.");
            }
            try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); }
            catch (Exception e) { throw new ColumnarException("Column '" + col + "' is real but a value of type " + v.GetType().Name + " cannot be converted.", e); }
        }

        public static bool ToBool(object v, string col)
        {
            if (v is bool) return (bool)v;
            string s = v as string;
            if (s != null)
            {
                string t = s.Trim().ToLowerInvariant();
                if (t == "true" || t == "1" || t == "yes" || t == "y" || t == "t") return true;
                if (t == "false" || t == "0" || t == "no" || t == "n" || t == "f" || t == "") return false;
                throw new ColumnarException("Column '" + col + "' is boolean but a value ('" + Clip(s) + "') is not true or false.");
            }
            if (v is IConvertible) return ToDouble(v, col) != 0;
            throw new ColumnarException("Column '" + col + "' is boolean but a value of type " + v.GetType().Name + " cannot be converted.");
        }

        public static string ToText(object v)
        {
            string s = v as string;
            if (s != null) return s;
            if (v is double) return ((double)v).ToString("R", CultureInfo.InvariantCulture);
            if (v is float) return ((float)v).ToString("R", CultureInfo.InvariantCulture);
            if (v is DateTime) return FormatDateTimeValue((DateTime)v);
            if (v is bool) return ((bool)v) ? "true" : "false";
            byte[] b = v as byte[];
            if (b != null) return Convert.ToBase64String(b);
            IFormattable f = v as IFormattable;
            if (f != null) return f.ToString(null, CultureInfo.InvariantCulture);
            return v.ToString();
        }

        public static byte[] ToBlob(object v)
        {
            byte[] b = v as byte[];
            if (b != null) return b;
            return Encoding.UTF8.GetBytes(ToText(v));
        }

        static string FormatDateTimeValue(DateTime dt)
        {
            if (dt.Kind == DateTimeKind.Local) dt = dt.ToUniversalTime();
            long t = dt.Ticks - EpochTicks;
            return FormatTimestamp(t, 10000000);
        }

        static int Digits(string s, int p, int n)
        {
            if (p + n > s.Length) return -1;
            int v = 0;
            for (int i = 0; i < n; i++) { char c = s[p + i]; if (c < '0' || c > '9') return -1; v = v * 10 + (c - '0'); }
            return v;
        }

        public static int ToDays(object v, string col)
        {
            if (v is DateTime) { DateTime dt = (DateTime)v; return (int)DaysFromCivil(dt.Year, dt.Month, dt.Day); }
            if (v is DateTimeOffset) { DateTime dt = ((DateTimeOffset)v).DateTime; return (int)DaysFromCivil(dt.Year, dt.Month, dt.Day); }
            string s = v as string;
            if (s != null)
            {
                s = s.Trim();
                int y = Digits(s, 0, 4), m = Digits(s, 5, 2), d = Digits(s, 8, 2);
                if (y >= 0 && m >= 1 && m <= 12 && d >= 1 && d <= 31 && s[4] == '-' && s[7] == '-' && (s.Length == 10 || s[10] == 'T' || s[10] == ' '))
                    return (int)DaysFromCivil(y, m, d);
                DateTime p;
                if (DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out p))
                    return (int)DaysFromCivil(p.Year, p.Month, p.Day);
                throw new ColumnarException("Column '" + col + "' is date but a value ('" + Clip(s) + "') is not yyyy-MM-dd.");
            }
            if (v is long || v is int) return (int)Convert.ToInt64(v, CultureInfo.InvariantCulture);
            throw new ColumnarException("Column '" + col + "' is date but a value of type " + v.GetType().Name + " cannot be converted.");
        }

        public static long ToMicros(object v, string col)
        {
            if (v is DateTime)
            {
                DateTime dt = (DateTime)v;
                if (dt.Kind == DateTimeKind.Local) dt = dt.ToUniversalTime();
                return FloorDiv(dt.Ticks - EpochTicks, 10);
            }
            if (v is DateTimeOffset) return FloorDiv(((DateTimeOffset)v).UtcTicks - EpochTicks, 10);
            string s = v as string;
            if (s != null)
            {
                s = s.Trim();
                long r;
                if (TryIso(s, out r)) return r;
                DateTime p;
                if (DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out p))
                    return FloorDiv(p.Ticks - EpochTicks, 10);
                throw new ColumnarException("Column '" + col + "' is datetime but a value ('" + Clip(s) + "') is not an ISO date-time.");
            }
            if (v is long || v is int) return Convert.ToInt64(v, CultureInfo.InvariantCulture);
            throw new ColumnarException("Column '" + col + "' is datetime but a value of type " + v.GetType().Name + " cannot be converted.");
        }

        // yyyy-MM-dd[(T| )HH:mm[:ss[.f+]]][Z|(+|-)HH[:]mm] -> microseconds since the Unix epoch, UTC.
        static bool TryIso(string s, out long micros)
        {
            micros = 0;
            int y = Digits(s, 0, 4), mo = Digits(s, 5, 2), d = Digits(s, 8, 2);
            if (y < 0 || mo < 1 || mo > 12 || d < 1 || d > 31 || s[4] != '-' || s[7] != '-') return false;
            long days = DaysFromCivil(y, mo, d);
            int p = 10; int hh = 0, mi = 0, ss = 0; long fracMicros = 0;
            if (p < s.Length && (s[p] == 'T' || s[p] == ' '))
            {
                hh = Digits(s, p + 1, 2); mi = Digits(s, p + 4, 2);
                if (hh < 0 || mi < 0 || s[p + 3] != ':' || hh > 23 || mi > 59) return false;
                p += 6;
                if (p < s.Length && s[p] == ':')
                {
                    ss = Digits(s, p + 1, 2);
                    if (ss < 0 || ss > 60) return false;
                    p += 3;
                    if (p < s.Length && (s[p] == '.' || s[p] == ','))
                    {
                        p++;
                        int digits = 0; long f = 0;
                        while (p < s.Length && s[p] >= '0' && s[p] <= '9') { if (digits < 6) { f = f * 10 + (s[p] - '0'); digits++; } p++; }
                        while (digits < 6) { f *= 10; digits++; }
                        fracMicros = f;
                    }
                }
            }
            long offsetSec = 0;
            if (p < s.Length)
            {
                char c = s[p];
                if (c == 'Z' || c == 'z') p++;
                else if (c == '+' || c == '-')
                {
                    int oh = Digits(s, p + 1, 2); if (oh < 0) return false;
                    int q = p + 3; if (q < s.Length && s[q] == ':') q++;
                    int om = Digits(s, q, 2); if (om < 0) om = 0; else q += 2;
                    offsetSec = (oh * 3600 + om * 60) * (c == '-' ? -1 : 1);
                    p = q;
                }
                if (p != s.Length) return false;
            }
            micros = ((days * 86400 + hh * 3600 + mi * 60 + ss) - offsetSec) * 1000000L + fracMicros;
            return true;
        }

        public static string Clip(string s) { return s.Length > 40 ? s.Substring(0, 40) + "..." : s; }
    }

    // ------------------------------------------------------------------------------------------
    // Snappy (raw block format, as used inside Parquet pages)
    // ------------------------------------------------------------------------------------------
    public static class Snappy
    {
        public static byte[] Decompress(byte[] src) { return Decompress(src, 0, src.Length); }

        public static byte[] Decompress(byte[] src, int off, int len)
        {
            int p = off, end = off + len;
            ulong ulen = 0; int shift = 0;
            while (true)
            {
                if (p >= end) throw new ColumnarException("Snappy data is truncated (no length).");
                byte b = src[p++];
                ulen |= (ulong)(b & 0x7F) << shift;
                if ((b & 0x80) == 0) break;
                shift += 7;
                if (shift > 28) throw new ColumnarException("Snappy length is too large.");
            }
            if (ulen > int.MaxValue || ulen > (ulong)len * 22 + 64) throw new ColumnarException("Snappy length " + ulen + " is impossible for " + len + " compressed bytes (corrupt data).");
            byte[] dst = new byte[(int)ulen];
            int d = 0;
            while (p < end)
            {
                int tag = src[p++];
                int type = tag & 3;
                if (type == 0)
                {
                    long l = tag >> 2;
                    if (l >= 60)
                    {
                        int nb = (int)l - 59;
                        if (p + nb > end) throw new ColumnarException("Snappy literal length is truncated.");
                        l = 0;
                        for (int i = 0; i < nb; i++) l |= (long)src[p + i] << (8 * i);
                        p += nb;
                    }
                    l += 1;
                    if (l > end - p || l > dst.Length - d) throw new ColumnarException("Snappy literal runs past the end of the data.");
                    Buffer.BlockCopy(src, p, dst, d, (int)l);
                    p += (int)l; d += (int)l;
                }
                else
                {
                    int l; long o;
                    if (type == 1)
                    {
                        if (p >= end) throw new ColumnarException("Snappy copy is truncated.");
                        l = ((tag >> 2) & 7) + 4;
                        o = ((tag >> 5) << 8) | src[p++];
                    }
                    else if (type == 2)
                    {
                        if (p + 2 > end) throw new ColumnarException("Snappy copy is truncated.");
                        l = (tag >> 2) + 1;
                        o = src[p] | (src[p + 1] << 8);
                        p += 2;
                    }
                    else
                    {
                        if (p + 4 > end) throw new ColumnarException("Snappy copy is truncated.");
                        l = (tag >> 2) + 1;
                        o = (long)(uint)(src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24));
                        p += 4;
                    }
                    if (o == 0 || o > d) throw new ColumnarException("Snappy copy offset " + o + " points before the start of the output.");
                    if (l > dst.Length - d) throw new ColumnarException("Snappy copy runs past the declared length.");
                    int from = d - (int)o;
                    if (o >= l) { Buffer.BlockCopy(dst, from, dst, d, l); d += l; }
                    else { for (int i = 0; i < l; i++) dst[d++] = dst[from + i]; }
                }
            }
            if (d != dst.Length) throw new ColumnarException("Snappy data is shorter than its declared length (" + d + " of " + dst.Length + ").");
            return dst;
        }

        public static byte[] Compress(byte[] src) { return Compress(src, 0, src.Length); }

        public static byte[] Compress(byte[] src, int off, int len)
        {
            byte[] dst = new byte[32 + len + len / 6];
            int d = 0;
            uint v = (uint)len;
            while (v >= 0x80) { dst[d++] = (byte)(v | 0x80); v >>= 7; }
            dst[d++] = (byte)v;
            int[] table = new int[1 << 14];
            int end = off + len;
            for (int bs = off; bs < end; bs += 65536)
            {
                int be = Math.Min(bs + 65536, end);
                d = CompressBlock(src, bs, be, dst, d, table);
            }
            byte[] r = new byte[d];
            Buffer.BlockCopy(dst, 0, r, 0, d);
            return r;
        }

        static uint Load32(byte[] b, int p) { return (uint)(b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)); }

        static int CompressBlock(byte[] src, int start, int end, byte[] dst, int d, int[] table)
        {
            Array.Clear(table, 0, table.Length);
            int lit = start;
            int p = start;
            int limit = end - 4;
            int misses = 0;
            while (p <= limit)
            {
                uint cur = Load32(src, p);
                int h = (int)((cur * 0x1E35A7BDu) >> 18);
                int cand = table[h] - 1;
                table[h] = p + 1;
                if (cand >= start && Load32(src, cand) == cur)
                {
                    int m = p + 4, c = cand + 4;
                    while (m < end && src[m] == src[c]) { m++; c++; }
                    if (p > lit) d = EmitLiteral(src, lit, p - lit, dst, d);
                    d = EmitCopy(p - cand, m - p, dst, d);
                    if (m - 1 <= limit && m - 1 > p) { uint x = Load32(src, m - 1); table[(int)((x * 0x1E35A7BDu) >> 18)] = m; }
                    p = m; lit = m; misses = 0;
                }
                else
                {
                    misses++;
                    p += 1 + (misses >> 5);
                }
            }
            if (end > lit) d = EmitLiteral(src, lit, end - lit, dst, d);
            return d;
        }

        static int EmitLiteral(byte[] src, int p, int n, byte[] dst, int d)
        {
            int l = n - 1;
            if (l < 60) dst[d++] = (byte)(l << 2);
            else if (l < 256) { dst[d++] = 60 << 2; dst[d++] = (byte)l; }
            else if (l < 65536) { dst[d++] = 61 << 2; dst[d++] = (byte)l; dst[d++] = (byte)(l >> 8); }
            else if (l < (1 << 24)) { dst[d++] = 62 << 2; dst[d++] = (byte)l; dst[d++] = (byte)(l >> 8); dst[d++] = (byte)(l >> 16); }
            else { dst[d++] = 63 << 2; dst[d++] = (byte)l; dst[d++] = (byte)(l >> 8); dst[d++] = (byte)(l >> 16); dst[d++] = (byte)(l >> 24); }
            Buffer.BlockCopy(src, p, dst, d, n);
            return d + n;
        }

        static int EmitCopy(int offset, int len, byte[] dst, int d)
        {
            while (len >= 68) { d = Copy2(offset, 64, dst, d); len -= 64; }
            if (len > 64) { d = Copy2(offset, 60, dst, d); len -= 60; }
            if (len >= 4 && len <= 11 && offset < 2048)
            {
                dst[d++] = (byte)(1 | ((len - 4) << 2) | ((offset >> 8) << 5));
                dst[d++] = (byte)offset;
                return d;
            }
            return Copy2(offset, len, dst, d);
        }

        static int Copy2(int offset, int len, byte[] dst, int d)
        {
            dst[d++] = (byte)(2 | ((len - 1) << 2));
            dst[d++] = (byte)offset;
            dst[d++] = (byte)(offset >> 8);
            return d;
        }
    }

    // ------------------------------------------------------------------------------------------
    // Thrift compact protocol
    // ------------------------------------------------------------------------------------------
    internal sealed class TStruct
    {
        public readonly Dictionary<short, object> F = new Dictionary<short, object>();
        public bool Has(short id) { return F.ContainsKey(id); }
        public long I(short id, long def) { object o; return F.TryGetValue(id, out o) && o is long ? (long)o : def; }
        public long I(short id)
        {
            object o;
            if (F.TryGetValue(id, out o) && o is long) return (long)o;
            throw new ColumnarException("Parquet metadata is missing required field " + id + ".");
        }
        public bool Bool(short id, bool def) { object o; return F.TryGetValue(id, out o) && o is bool ? (bool)o : def; }
        public byte[] B(short id) { object o; return F.TryGetValue(id, out o) ? o as byte[] : null; }
        public string S(short id) { byte[] b = B(id); return b == null ? null : Encoding.UTF8.GetString(b); }
        public TStruct T(short id) { object o; return F.TryGetValue(id, out o) ? o as TStruct : null; }
        public List<object> L(short id) { object o; return F.TryGetValue(id, out o) ? o as List<object> : null; }
    }

    internal static class Thrift
    {
        static int RB(Stream s) { int b = s.ReadByte(); if (b < 0) throw new ColumnarException("Parquet metadata ends unexpectedly."); return b; }

        static ulong Varint(Stream s)
        {
            ulong r = 0; int shift = 0;
            while (true)
            {
                int b = RB(s);
                r |= (ulong)(b & 0x7F) << shift;
                if ((b & 0x80) == 0) return r;
                shift += 7;
                if (shift > 63) throw new ColumnarException("Parquet metadata has a malformed varint.");
            }
        }

        static long Zig(ulong n) { return (long)(n >> 1) ^ -(long)(n & 1); }

        public static TStruct ReadStruct(Stream s) { return ReadStruct(s, 0); }

        static TStruct ReadStruct(Stream s, int depth)
        {
            if (depth > 64) throw new ColumnarException("Parquet metadata is nested too deeply.");
            TStruct t = new TStruct();
            short last = 0;
            while (true)
            {
                int b = RB(s);
                if (b == 0) return t;
                int type = b & 0x0F, delta = b >> 4;
                short id = delta != 0 ? (short)(last + delta) : (short)Zig(Varint(s));
                last = id;
                t.F[id] = ReadValue(s, type, depth);
            }
        }

        static object ReadValue(Stream s, int type, int depth)
        {
            switch (type)
            {
                case 1: return true;
                case 2: return false;
                case 3: return (long)(sbyte)RB(s);
                case 4:
                case 5:
                case 6: return Zig(Varint(s));
                case 7:
                    {
                        byte[] d = ReadBytes(s, 8);
                        return BitConverter.ToDouble(d, 0);
                    }
                case 8:
                    {
                        ulong n = Varint(s);
                        if (n > (ulong)(s.Length - s.Position)) throw new ColumnarException("Parquet metadata has a string longer than the file.");
                        return ReadBytes(s, (int)n);
                    }
                case 9:
                case 10:
                    {
                        int h = RB(s);
                        long n = h >> 4;
                        int et = h & 0x0F;
                        if (n == 15) n = (long)Varint(s);
                        if (n > s.Length - s.Position) throw new ColumnarException("Parquet metadata has a list longer than the file.");
                        List<object> l = new List<object>((int)n);
                        for (long i = 0; i < n; i++)
                        {
                            if (et == 1 || et == 2) l.Add(RB(s) == 1);
                            else l.Add(ReadValue(s, et, depth + 1));
                        }
                        return l;
                    }
                case 11:
                    {
                        long n = (long)Varint(s);
                        List<object> l = new List<object>();
                        if (n == 0) return l;
                        if (n > s.Length - s.Position) throw new ColumnarException("Parquet metadata has a map longer than the file.");
                        int kv = RB(s);
                        for (long i = 0; i < n; i++)
                        {
                            int kt = kv >> 4, vt = kv & 0x0F;
                            l.Add(kt == 1 || kt == 2 ? (object)(RB(s) == 1) : ReadValue(s, kt, depth + 1));
                            l.Add(vt == 1 || vt == 2 ? (object)(RB(s) == 1) : ReadValue(s, vt, depth + 1));
                        }
                        return l;
                    }
                case 12: return ReadStruct(s, depth + 1);
                default: throw new ColumnarException("Parquet metadata has an unknown thrift type " + type + ".");
            }
        }

        static byte[] ReadBytes(Stream s, int n)
        {
            byte[] r = new byte[n];
            int got = 0;
            while (got < n) { int k = s.Read(r, got, n - got); if (k <= 0) throw new ColumnarException("Parquet metadata ends unexpectedly."); got += k; }
            return r;
        }
    }

    internal sealed class TWriter
    {
        public readonly MemoryStream Out = new MemoryStream();
        readonly Stack<short> stack = new Stack<short>();
        short last;

        void Byte(int b) { Out.WriteByte((byte)b); }
        void Varint(ulong v) { while (v >= 0x80) { Byte((int)(v & 0x7F) | 0x80); v >>= 7; } Byte((int)v); }
        static ulong Zig(long v) { return (ulong)((v << 1) ^ (v >> 63)); }

        void Field(short id, int type)
        {
            if (id > last && id - last <= 15) Byte(((id - last) << 4) | type);
            else { Byte(type); Varint(Zig(id)); }
            last = id;
        }

        public void I32(short id, long v) { Field(id, 5); Varint(Zig(v)); }
        public void I64(short id, long v) { Field(id, 6); Varint(Zig(v)); }
        public void I16(short id, long v) { Field(id, 4); Varint(Zig(v)); }
        public void I8(short id, int v) { Field(id, 3); Byte(v); }
        public void Bool(short id, bool v) { Field(id, v ? 1 : 2); }
        public void Bin(short id, byte[] b) { Field(id, 8); Varint((ulong)b.Length); Out.Write(b, 0, b.Length); }
        public void Str(short id, string s) { Bin(id, Encoding.UTF8.GetBytes(s)); }
        public void BeginStruct(short id) { Field(id, 12); stack.Push(last); last = 0; }
        public void EndStruct() { Byte(0); last = stack.Pop(); }
        public void EmptyStruct(short id) { BeginStruct(id); EndStruct(); }
        public void BeginList(short id, int elemType, int count)
        {
            Field(id, 9);
            if (count < 15) Byte((count << 4) | elemType);
            else { Byte(0xF0 | elemType); Varint((ulong)count); }
        }
        public void ListI32(long v) { Varint(Zig(v)); }
        public void ListBin(byte[] b) { Varint((ulong)b.Length); Out.Write(b, 0, b.Length); }
        public void BeginElem() { stack.Push(last); last = 0; }
        public void EndElem() { Byte(0); last = stack.Pop(); }
        public void Stop() { Byte(0); }
        public byte[] ToArray() { return Out.ToArray(); }
    }

    // ------------------------------------------------------------------------------------------
    // Bit-level helpers: RLE/bit-packed hybrid, delta binary packed
    // ------------------------------------------------------------------------------------------
    internal static class Bits
    {
        public static int WidthFor(long maxValue)
        {
            int w = 0;
            while (maxValue > 0) { w++; maxValue >>= 1; }
            return w;
        }

        public static ulong Varint(byte[] b, ref int p, int end)
        {
            ulong r = 0; int shift = 0;
            while (true)
            {
                if (p >= end) throw new ColumnarException("Parquet page data ends inside a varint.");
                byte x = b[p++];
                r |= (ulong)(x & 0x7F) << shift;
                if ((x & 0x80) == 0) return r;
                shift += 7;
                if (shift > 63) throw new ColumnarException("Parquet page data has a malformed varint.");
            }
        }

        public static long Zig(ulong n) { return (long)(n >> 1) ^ -(long)(n & 1); }

        public static int[] DecodeHybrid(byte[] b, int p, int end, int bw, int n)
        {
            int[] r = new int[n];
            if (bw > 32) throw new ColumnarException("Parquet RLE bit width " + bw + " is invalid.");
            int i = 0;
            int bytesW = (bw + 7) / 8;
            uint mask = bw == 32 ? 0xFFFFFFFFu : (uint)((1L << bw) - 1);
            while (i < n)
            {
                ulong h = Varint(b, ref p, end);
                if ((h & 1) == 0)
                {
                    long cnt = (long)(h >> 1);
                    if (p + bytesW > end) throw new ColumnarException("Parquet RLE run is truncated.");
                    int v = 0;
                    for (int k = 0; k < bytesW; k++) v |= b[p + k] << (8 * k);
                    p += bytesW;
                    long take = Math.Min(cnt, n - i);
                    for (long k = 0; k < take; k++) r[i++] = v;
                }
                else
                {
                    long groups = (long)(h >> 1);
                    long cnt = groups * 8;
                    long take = Math.Min(cnt, n - i);
                    ulong acc = 0; int bits = 0; int q = p;
                    for (long k = 0; k < take; k++)
                    {
                        while (bits < bw) { acc |= (ulong)(q < end ? b[q] : 0) << bits; q++; bits += 8; }
                        r[i++] = (int)(acc & mask);
                        acc >>= bw; bits -= bw;
                    }
                    p = (int)Math.Min((long)end, p + groups * bw);
                }
            }
            return r;
        }

        // Legacy BIT_PACKED level encoding: values packed most-significant bit first.
        public static int[] DecodeBitPackedLegacy(byte[] b, int p, int bw, int n)
        {
            int[] r = new int[n];
            long bit = 0;
            for (int i = 0; i < n; i++)
            {
                int v = 0;
                for (int k = 0; k < bw; k++)
                {
                    int byteIdx = p + (int)(bit >> 3);
                    int x = byteIdx < b.Length ? b[byteIdx] : 0;
                    v = (v << 1) | ((x >> (7 - (int)(bit & 7))) & 1);
                    bit++;
                }
                r[i] = v;
            }
            return r;
        }

        public static int LegacyBytes(int bw, int n) { return (int)(((long)bw * n + 7) / 8); }

        static ulong ReadBits(byte[] b, long bitOffset, int w, int end)
        {
            ulong v = 0; int got = 0; long bit = bitOffset;
            while (got < w)
            {
                long bi = bit >> 3;
                int x = bi < end ? b[bi] : 0;
                int sh = (int)(bit & 7);
                int take = Math.Min(8 - sh, w - got);
                ulong part = (ulong)((x >> sh) & ((1 << take) - 1));
                v |= part << got;
                got += take; bit += take;
            }
            return v;
        }

        public static long[] DecodeDelta(byte[] b, ref int p, int end)
        {
            ulong blockSize = Varint(b, ref p, end);
            ulong minis = Varint(b, ref p, end);
            ulong total = Varint(b, ref p, end);
            long first = Zig(Varint(b, ref p, end));
            if (minis == 0 || blockSize == 0 || blockSize > (1 << 20) || blockSize % minis != 0 || (blockSize / minis) % 8 != 0 || total > int.MaxValue)
                throw new ColumnarException("Parquet DELTA_BINARY_PACKED header is invalid.");
            // Every block of blockSize values needs at least its min-delta byte.
            if (total > 1 && (long)(total - 1) > (long)(end - p) * (long)blockSize)
                throw new ColumnarException("Parquet DELTA_BINARY_PACKED header claims more values than the page can hold.");
            long[] r = new long[(int)total];
            if (total == 0) return r;
            r[0] = first;
            long last = first;
            int i = 1;
            int perMini = (int)(blockSize / minis);
            int nMini = (int)minis;
            while (i < (int)total)
            {
                long minDelta = Zig(Varint(b, ref p, end));
                if (p + nMini > end) throw new ColumnarException("Parquet DELTA_BINARY_PACKED block is truncated.");
                int wStart = p;
                p += nMini;
                for (int m = 0; m < nMini && i < (int)total; m++)
                {
                    int w = b[wStart + m];
                    if (w > 64) throw new ColumnarException("Parquet DELTA_BINARY_PACKED bit width " + w + " is invalid.");
                    long baseBit = (long)p * 8;
                    for (int k = 0; k < perMini && i < (int)total; k++)
                    {
                        ulong v = w == 0 ? 0UL : ReadBits(b, baseBit + (long)k * w, w, end);
                        last = unchecked(last + minDelta + (long)v);
                        r[i++] = last;
                    }
                    p += perMini * w / 8;
                }
            }
            return r;
        }

        // ---------- encoders ----------
        public static void EncodeHybrid(int[] vals, int start, int n, int bw, MemoryStream o)
        {
            List<int> lit = new List<int>();
            int bytesW = (bw + 7) / 8;
            int i = start, end = start + n;
            while (i < end)
            {
                int j = i + 1;
                while (j < end && vals[j] == vals[i]) j++;
                int run = j - i;
                if (run >= 8)
                {
                    int pad = (8 - lit.Count % 8) % 8;
                    if (run - pad >= 8)
                    {
                        for (int k = 0; k < pad; k++) lit.Add(vals[i]);
                        FlushLiteral(lit, bw, o);
                        int rl = run - pad;
                        WriteVarint(o, (ulong)rl << 1);
                        int v = vals[i];
                        for (int k = 0; k < bytesW; k++) o.WriteByte((byte)(v >> (8 * k)));
                        i = j;
                        continue;
                    }
                }
                for (int k = i; k < j; k++) lit.Add(vals[k]);
                i = j;
            }
            FlushLiteral(lit, bw, o);
        }

        static void FlushLiteral(List<int> lit, int bw, MemoryStream o)
        {
            if (lit.Count == 0) return;
            int groups = (lit.Count + 7) / 8;
            WriteVarint(o, ((ulong)groups << 1) | 1);
            ulong acc = 0; int bits = 0;
            int total = groups * 8;
            for (int k = 0; k < total; k++)
            {
                ulong v = k < lit.Count ? (ulong)(uint)lit[k] : 0;
                acc |= v << bits; bits += bw;
                while (bits >= 8) { o.WriteByte((byte)acc); acc >>= 8; bits -= 8; }
            }
            if (bits > 0) o.WriteByte((byte)acc);
            lit.Clear();
        }

        public static void WriteVarint(MemoryStream o, ulong v)
        {
            while (v >= 0x80) { o.WriteByte((byte)(v | 0x80)); v >>= 7; }
            o.WriteByte((byte)v);
        }
    }

    // ------------------------------------------------------------------------------------------
    // Parquet reader
    // ------------------------------------------------------------------------------------------
    internal enum PqKind { Bool, Int, UInt32, UInt64, Date, Timestamp, Time, DecimalInt, Float, Double, Text, Blob, DecimalBytes, Uuid, Float16, Int96 }

    internal sealed class PqColumn
    {
        public string Name;
        public int Physical;       // 0 BOOLEAN 1 INT32 2 INT64 3 INT96 4 FLOAT 5 DOUBLE 6 BYTE_ARRAY 7 FIXED_LEN_BYTE_ARRAY
        public int TypeLength;
        public int MaxDef;
        public PqKind Kind;
        public string OutType;
        public int Scale;
        public long UnitsPerSecond;

        public object FromLong(long v)
        {
            switch (Kind)
            {
                case PqKind.Int: return v;
                case PqKind.UInt32: return (long)(uint)v;
                case PqKind.UInt64: { ulong u = (ulong)v; return u <= long.MaxValue ? (object)v : (object)(double)u; }
                case PqKind.Date: return Val.FormatDate(v);
                case PqKind.Timestamp: return Val.FormatTimestamp(v, UnitsPerSecond);
                case PqKind.Time: return Val.FormatTime(v, UnitsPerSecond);
                case PqKind.DecimalInt: return Val.DecimalFromLong(v, Scale);
                case PqKind.Double: return (double)v;
                default: return v;
            }
        }

        public object FromBytes(byte[] b, int off, int len)
        {
            switch (Kind)
            {
                case PqKind.Text: return Encoding.UTF8.GetString(b, off, len);
                case PqKind.DecimalBytes: return Val.DecimalFromBytes(b, off, len, Scale, true);
                case PqKind.Uuid: return Val.Uuid(b, off, len);
                case PqKind.Float16: return len == 2 ? (object)Val.HalfToDouble(Val.LE16(b, off)) : null;
                case PqKind.Int96:
                    {
                        if (len != 12) return null;
                        long nanos = Val.LE64(b, off);
                        long days = (long)Val.LE32(b, off + 8) - 2440588;
                        long secs = days * 86400 + Val.FloorDiv(nanos, 1000000000L);
                        long frac = nanos - Val.FloorDiv(nanos, 1000000000L) * 1000000000L;
                        return Val.FormatSeconds(secs, frac != 0, (int)(frac / 1000000));
                    }
                default: return Val.Slice(b, off, len);
            }
        }
    }

    internal sealed class ParquetReader : ITableReader
    {
        readonly Stream s;
        readonly string[] names, types;
        readonly long rowCount;
        readonly PqColumn[] cols;
        readonly List<object> rowGroups;
        int rg = -1;
        long rgRemaining;
        PqCursor[] cursors;

        static readonly string[] Codecs = { "UNCOMPRESSED", "SNAPPY", "GZIP", "LZO", "BROTLI", "LZ4", "ZSTD", "LZ4_RAW" };

        internal static bool IsCorruption(Exception e)
        {
            return e is IndexOutOfRangeException || e is ArgumentException || e is InvalidCastException || e is NullReferenceException
                || e is OverflowException || e is InvalidDataException || e is EndOfStreamException;
        }

        public ParquetReader(Stream stream)
        {
            s = stream;
            try { Init(out names, out types, out rowCount, out cols, out rowGroups); }
            catch (Exception e)
            {
                if (!IsCorruption(e)) throw;
                throw new ColumnarException("Parquet metadata is corrupt (" + e.GetType().Name + ": " + e.Message + ").", e);
            }
        }

        void Init(out string[] names, out string[] types, out long rowCount, out PqColumn[] cols, out List<object> rowGroups)
        {
            long len = s.Length;
            if (len < 12) throw new ColumnarException("Not a Parquet file: too short.");
            byte[] tail = new byte[8];
            s.Position = len - 8;
            ReadFull(s, tail, 8);
            if (tail[4] == 'P' && tail[5] == 'A' && tail[6] == 'R' && tail[7] == 'E')
                throw new ColumnarException("This Parquet file is encrypted (PARE footer); Semaphore cannot read encrypted Parquet.");
            if (tail[4] != 'P' || tail[5] != 'A' || tail[6] != 'R' || tail[7] != '1')
                throw new ColumnarException("Not a Parquet file: the PAR1 footer magic is missing (the file may be truncated).");
            int flen = Val.LE32(tail, 0);
            if (flen <= 0 || flen > len - 12) throw new ColumnarException("Parquet footer length " + flen + " is invalid.");
            byte[] footer = new byte[flen];
            s.Position = len - 8 - flen;
            ReadFull(s, footer, flen);
            TStruct meta;
            try { meta = Thrift.ReadStruct(new MemoryStream(footer, false)); }
            catch (ColumnarException e) { throw new ColumnarException("Parquet footer is corrupt: " + e.Message, e); }

            List<object> schema = meta.L(2);
            if (schema == null || schema.Count == 0) throw new ColumnarException("Parquet footer has no schema.");
            rowCount = meta.I(3, 0);
            rowGroups = meta.L(4) ?? new List<object>();

            List<PqColumn> leaves = new List<PqColumn>();
            List<string> nested = new List<string>();
            TStruct root = (TStruct)schema[0];
            int rootChildren = (int)root.I(5, schema.Count - 1);
            int idx = 1;
            for (int c = 0; c < rootChildren; c++)
            {
                if (idx >= schema.Count) throw new ColumnarException("Parquet schema is shorter than its declared children.");
                TStruct se = (TStruct)schema[idx];
                string name = se.S(4) ?? ("column" + c);
                int kids = (int)se.I(5, 0);
                int rep = (int)se.I(3, 0);
                if (kids > 0 || rep == 2)
                {
                    nested.Add(name);
                    idx = SkipSubtree(schema, idx);
                    continue;
                }
                idx++;
                PqColumn col = new PqColumn();
                col.Name = name;
                col.Physical = (int)se.I(1, -1);
                col.TypeLength = (int)se.I(2, 0);
                col.MaxDef = rep == 1 ? 1 : 0;
                Classify(col, se);
                leaves.Add(col);
            }
            if (nested.Count > 0)
                throw new ColumnarException("Parquet column(s) " + string.Join(", ", nested.ToArray()) + " are nested or repeated (list, map or struct). Semaphore imports flat tables only: flatten or drop these columns and save the file again.");
            cols = leaves.ToArray();
            names = new string[cols.Length];
            types = new string[cols.Length];
            for (int i = 0; i < cols.Length; i++) { names[i] = cols[i].Name; types[i] = cols[i].OutType; }

            for (int g = 0; g < rowGroups.Count; g++)
            {
                TStruct rgs = (TStruct)rowGroups[g];
                List<object> chunks = rgs.L(1);
                if (chunks == null || chunks.Count != cols.Length) throw new ColumnarException("Parquet row group " + g + " has " + (chunks == null ? 0 : chunks.Count) + " column chunks for " + cols.Length + " columns.");
                for (int c = 0; c < chunks.Count; c++)
                {
                    TStruct cc = (TStruct)chunks[c];
                    if (cc.S(1) != null) throw new ColumnarException("Parquet column '" + cols[c].Name + "' keeps its data in another file (" + cc.S(1) + "); Semaphore reads single-file Parquet only.");
                    TStruct md = cc.T(3);
                    if (md == null) throw new ColumnarException("Parquet column '" + cols[c].Name + "' has no column metadata (possibly encrypted).");
                    int codec = (int)md.I(4, 0);
                    if (codec != 0 && codec != 1 && codec != 2)
                    {
                        string cn = codec >= 0 && codec < Codecs.Length ? Codecs[codec] : ("codec " + codec);
                        throw new ColumnarException("Parquet column '" + cols[c].Name + "' is compressed with " + cn + ", which Semaphore cannot read (it reads Snappy, GZIP and uncompressed). Re-save the file with Snappy compression, for example pyarrow pq.write_table(table, path, compression='snappy') or DuckDB COPY ... TO 'file.parquet' (FORMAT parquet, COMPRESSION snappy).");
                    }
                }
            }
        }

        static int SkipSubtree(List<object> schema, int idx)
        {
            TStruct se = (TStruct)schema[idx];
            int kids = (int)se.I(5, 0);
            idx++;
            for (int k = 0; k < kids; k++)
            {
                if (idx >= schema.Count) throw new ColumnarException("Parquet schema is shorter than its declared children.");
                idx = SkipSubtree(schema, idx);
            }
            return idx;
        }

        static long Unit(TStruct unit)
        {
            if (unit == null) return 1000;
            if (unit.Has(1)) return 1000;
            if (unit.Has(2)) return 1000000;
            if (unit.Has(3)) return 1000000000;
            return 1000;
        }

        static void Classify(PqColumn c, TStruct se)
        {
            int ph = c.Physical;
            TStruct lt = se.T(10);
            int conv = (int)se.I(6, -1);
            c.Scale = (int)se.I(7, 0);
            bool isBytes = ph == 6 || ph == 7;
            bool done = false;
            if (lt != null)
            {
                done = true;
                if ((lt.Has(1) || lt.Has(4) || lt.Has(12)) && isBytes) Set(c, PqKind.Text, "text");
                else if (lt.Has(5))
                {
                    TStruct dt = lt.T(5);
                    c.Scale = (int)dt.I(1, c.Scale);
                    Set(c, isBytes ? PqKind.DecimalBytes : PqKind.DecimalInt, "real");
                }
                else if (lt.Has(6) && ph == 1) Set(c, PqKind.Date, "date");
                else if (lt.Has(7) && (ph == 1 || ph == 2)) { c.UnitsPerSecond = Unit(lt.T(7).T(2)); Set(c, PqKind.Time, "text"); }
                else if (lt.Has(8) && ph == 2) { c.UnitsPerSecond = Unit(lt.T(8).T(2)); Set(c, PqKind.Timestamp, "datetime"); }
                else if (lt.Has(10) && (ph == 1 || ph == 2))
                {
                    TStruct it = lt.T(10);
                    long bitw = it.I(1, ph == 1 ? 32 : 64);
                    bool signed = it.Bool(2, true);
                    if (!signed && bitw == 64) Set(c, PqKind.UInt64, "integer");
                    else if (!signed && bitw == 32) Set(c, PqKind.UInt32, "integer");
                    else Set(c, PqKind.Int, "integer");
                }
                else if (lt.Has(14) && ph == 7) Set(c, PqKind.Uuid, "text");
                else if (lt.Has(15) && ph == 7) Set(c, PqKind.Float16, "real");
                else done = false;
            }
            if (!done && conv >= 0)
            {
                done = true;
                switch (conv)
                {
                    case 0: case 4: case 19: if (isBytes) Set(c, PqKind.Text, "text"); else done = false; break;
                    case 5: Set(c, isBytes ? PqKind.DecimalBytes : PqKind.DecimalInt, "real"); break;
                    case 6: Set(c, PqKind.Date, "date"); break;
                    case 7: c.UnitsPerSecond = 1000; Set(c, PqKind.Time, "text"); break;
                    case 8: c.UnitsPerSecond = 1000000; Set(c, PqKind.Time, "text"); break;
                    case 9: c.UnitsPerSecond = 1000; Set(c, PqKind.Timestamp, "datetime"); break;
                    case 10: c.UnitsPerSecond = 1000000; Set(c, PqKind.Timestamp, "datetime"); break;
                    case 13: Set(c, PqKind.UInt32, "integer"); break;
                    case 14: Set(c, PqKind.UInt64, "integer"); break;
                    case 11: case 12: case 15: case 16: case 17: case 18: Set(c, PqKind.Int, "integer"); break;
                    default: done = false; break;
                }
            }
            if (!done)
            {
                switch (ph)
                {
                    case 0: Set(c, PqKind.Bool, "boolean"); break;
                    case 1: case 2: Set(c, PqKind.Int, "integer"); break;
                    case 3: Set(c, PqKind.Int96, "datetime"); break;
                    case 4: Set(c, PqKind.Float, "real"); break;
                    case 5: Set(c, PqKind.Double, "real"); break;
                    case 6: case 7: Set(c, PqKind.Blob, "blob"); break;
                    default: throw new ColumnarException("Parquet column '" + c.Name + "' has unknown physical type " + ph + ".");
                }
            }
            if (ph == 3) Set(c, PqKind.Int96, "datetime");
            if (ph == 0) Set(c, PqKind.Bool, "boolean");
            if (ph == 4 && c.Kind != PqKind.Float) Set(c, PqKind.Float, "real");
            if (ph == 5 && c.Kind != PqKind.Double) Set(c, PqKind.Double, "real");
            if (ph == 7 && c.TypeLength <= 0) throw new ColumnarException("Parquet column '" + c.Name + "' is FIXED_LEN_BYTE_ARRAY without a length.");
        }

        static void Set(PqColumn c, PqKind k, string t) { c.Kind = k; c.OutType = t; }

        internal static void ReadFull(Stream s, byte[] buf, int n)
        {
            int got = 0;
            while (got < n) { int k = s.Read(buf, got, n - got); if (k <= 0) throw new ColumnarException("The file ends unexpectedly (truncated?)."); got += k; }
        }

        public string[] Names { get { return names; } }
        public string[] Types { get { return types; } }
        public long? RowCount { get { return rowCount; } }

        public bool Next(object[] row)
        {
            if (row == null || row.Length < cols.Length) throw new ArgumentException("row must have room for " + cols.Length + " values.");
            try { return NextRow(row); }
            catch (Exception e)
            {
                if (!IsCorruption(e)) throw;
                throw new ColumnarException("Parquet data is corrupt in row group " + rg + " (" + e.GetType().Name + ": " + e.Message + ").", e);
            }
        }

        bool NextRow(object[] row)
        {
            while (rgRemaining <= 0)
            {
                rg++;
                if (rg >= rowGroups.Count) { cursors = null; return false; }
                TStruct rgs = (TStruct)rowGroups[rg];
                rgRemaining = rgs.I(3, 0);
                List<object> chunks = rgs.L(1);
                cursors = new PqCursor[cols.Length];
                for (int c = 0; c < cols.Length; c++) cursors[c] = new PqCursor(s, cols[c], ((TStruct)chunks[c]).T(3));
            }
            for (int c = 0; c < cols.Length; c++) row[c] = cursors[c].NextValue();
            rgRemaining--;
            return true;
        }

        public void Dispose() { s.Dispose(); }
    }

    internal sealed class PqCursor
    {
        readonly Stream s;
        readonly PqColumn col;
        readonly int codec;
        long pos, end;
        long remaining;
        object[] dict;
        object[] page;
        int pageIdx, pageCount;

        static readonly string[] Encodings = { "PLAIN", "GROUP_VAR_INT", "PLAIN_DICTIONARY", "RLE", "BIT_PACKED", "DELTA_BINARY_PACKED", "DELTA_LENGTH_BYTE_ARRAY", "DELTA_BYTE_ARRAY", "RLE_DICTIONARY", "BYTE_STREAM_SPLIT" };

        public PqCursor(Stream stream, PqColumn column, TStruct md)
        {
            s = stream; col = column;
            codec = (int)md.I(4, 0);
            remaining = md.I(5, 0);
            long dataOff = md.I(9);
            long dictOff = md.I(11, -1);
            pos = (dictOff > 0 && dictOff < dataOff) ? dictOff : dataOff;
            // total_compressed_size is not trusted (some writers leave out the dictionary page);
            // the value count bounds the walk instead.
            end = s.Length;
        }

        public object NextValue()
        {
            if (pageIdx >= pageCount) LoadPage();
            return page[pageIdx++];
        }

        ColumnarException Bad(string what) { return new ColumnarException("Parquet column '" + col.Name + "': " + what); }

        void LoadPage()
        {
            while (true)
            {
                if (remaining <= 0 || pos >= end) throw Bad("the column chunk has fewer values than the row group.");
                s.Position = pos;
                TStruct h;
                try { h = Thrift.ReadStruct(s); }
                catch (ColumnarException e) { throw Bad("page header is corrupt: " + e.Message); }
                int type = (int)h.I(1);
                int usize = (int)h.I(2);
                int csize = (int)h.I(3);
                if (usize < 0 || csize < 0) throw Bad("page header has a negative size.");
                long bodyStart = s.Position;
                if (csize < 0 || bodyStart + csize > s.Length) throw Bad("page runs past the end of the file.");
                byte[] raw = new byte[csize];
                ParquetReader.ReadFull(s, raw, csize);
                pos = bodyStart + csize;
                if (type == 2) { ReadDictionary(h, raw, usize); continue; }
                if (type == 0) DataV1(h, raw, usize);
                else if (type == 3) DataV2(h, raw, usize);
                else continue;
                if (pageCount > 0) { remaining -= pageCount; pageIdx = 0; return; }
            }
        }

        byte[] Inflate(byte[] raw, int off, int len, int usize)
        {
            if (codec == 0)
            {
                if (off == 0 && len == raw.Length) return raw;
                return Val.Slice(raw, off, len);
            }
            if (usize > 1 << 30) throw Bad("page claims " + usize + " uncompressed bytes.");
            if (codec == 1)
            {
                byte[] r = Snappy.Decompress(raw, off, len);
                if (r.Length != usize) throw Bad("Snappy page decompressed to " + r.Length + " bytes, expected " + usize + ".");
                return r;
            }
            byte[] o = new byte[usize];
            using (GZipStream gz = new GZipStream(new MemoryStream(raw, off, len, false), CompressionMode.Decompress))
            {
                int got = 0;
                while (got < usize) { int k = gz.Read(o, got, usize - got); if (k <= 0) break; got += k; }
                if (got != usize) throw Bad("GZIP page decompressed to " + got + " bytes, expected " + usize + ".");
            }
            return o;
        }

        void ReadDictionary(TStruct h, byte[] raw, int usize)
        {
            TStruct dh = h.T(7);
            if (dh == null) throw Bad("dictionary page has no header.");
            int n = (int)dh.I(1);
            if (n < 0 || n > (long)usize * 8 + 8) throw Bad("dictionary page claims " + n + " values in " + usize + " bytes.");
            int enc = (int)dh.I(2, 0);
            if (enc != 0 && enc != 2) throw Bad("dictionary page uses encoding " + EncName(enc) + ".");
            byte[] b = Inflate(raw, 0, raw.Length, usize);
            dict = new object[n];
            DecodePlain(b, 0, b.Length, n, dict);
        }

        static string EncName(int e) { return e >= 0 && e < Encodings.Length ? Encodings[e] : ("encoding " + e); }

        void DataV1(TStruct h, byte[] raw, int usize)
        {
            TStruct dh = h.T(5);
            if (dh == null) throw Bad("data page has no header.");
            int n = (int)dh.I(1);
            if (n < 0 || n > remaining) throw Bad("data page claims " + n + " values but the chunk has " + remaining + " left.");
            int enc = (int)dh.I(2);
            int defEnc = (int)dh.I(3, 3);
            byte[] b = Inflate(raw, 0, raw.Length, usize);
            int p = 0;
            int[] defs = null;
            if (col.MaxDef > 0)
            {
                int bw = Bits.WidthFor(col.MaxDef);
                if (defEnc == 3)
                {
                    if (p + 4 > b.Length) throw Bad("definition levels are truncated.");
                    int l = Val.LE32(b, p); p += 4;
                    if (l < 0 || p + l > b.Length) throw Bad("definition levels are truncated.");
                    defs = Bits.DecodeHybrid(b, p, p + l, bw, n);
                    p += l;
                }
                else if (defEnc == 4)
                {
                    defs = Bits.DecodeBitPackedLegacy(b, p, bw, n);
                    p += Bits.LegacyBytes(bw, n);
                }
                else throw Bad("definition levels use " + EncName(defEnc) + ".");
            }
            Fill(b, p, b.Length, enc, n, defs);
        }

        void DataV2(TStruct h, byte[] raw, int usize)
        {
            TStruct dh = h.T(8);
            if (dh == null) throw Bad("data page v2 has no header.");
            int n = (int)dh.I(1);
            if (n < 0 || n > remaining) throw Bad("data page claims " + n + " values but the chunk has " + remaining + " left.");
            int enc = (int)dh.I(4);
            int dlen = (int)dh.I(5, 0);
            int rlen = (int)dh.I(6, 0);
            bool compressed = dh.Bool(7, true);
            if (dlen < 0 || rlen < 0 || rlen + dlen > raw.Length) throw Bad("data page v2 level lengths are invalid.");
            int[] defs = null;
            if (col.MaxDef > 0) defs = Bits.DecodeHybrid(raw, rlen, rlen + dlen, Bits.WidthFor(col.MaxDef), n);
            int lv = rlen + dlen;
            byte[] b;
            if (compressed && codec != 0) b = Inflate(raw, lv, raw.Length - lv, usize - lv);
            else b = Val.Slice(raw, lv, raw.Length - lv);
            Fill(b, 0, b.Length, enc, n, defs);
        }

        void Fill(byte[] b, int p, int end, int enc, int n, int[] defs)
        {
            int k = n;
            if (defs != null)
            {
                k = 0;
                for (int i = 0; i < n; i++) if (defs[i] == col.MaxDef) k++;
            }
            object[] vals = new object[k];
            DecodeValues(b, p, end, enc, k, vals);
            if (defs == null || k == n) { page = vals; pageCount = n; return; }
            object[] full = new object[n];
            int j = 0;
            for (int i = 0; i < n; i++) if (defs[i] == col.MaxDef) full[i] = vals[j++];
            page = full; pageCount = n;
        }

        void DecodeValues(byte[] b, int p, int end, int enc, int k, object[] vals)
        {
            if (k == 0) return;
            switch (enc)
            {
                case 0: DecodePlain(b, p, end, k, vals); return;
                case 2:
                case 8:
                    {
                        if (dict == null) throw Bad("dictionary-encoded page without a dictionary page.");
                        if (p >= end) throw Bad("dictionary indices are missing.");
                        int bw = b[p++];
                        int[] idx = Bits.DecodeHybrid(b, p, end, bw, k);
                        for (int i = 0; i < k; i++)
                        {
                            int x = idx[i];
                            if (x < 0 || x >= dict.Length) throw Bad("dictionary index " + x + " is out of range (" + dict.Length + " entries).");
                            vals[i] = dict[x];
                        }
                        return;
                    }
                case 3:
                    {
                        if (col.Physical != 0) throw Bad("RLE value encoding is only valid for booleans.");
                        int l = Val.LE32(b, p); p += 4;
                        int[] bits = Bits.DecodeHybrid(b, p, Math.Min(end, p + l), 1, k);
                        for (int i = 0; i < k; i++) vals[i] = bits[i] != 0;
                        return;
                    }
                case 5:
                    {
                        if (col.Physical != 1 && col.Physical != 2) throw Bad("DELTA_BINARY_PACKED is only valid for INT32 and INT64.");
                        long[] v = Bits.DecodeDelta(b, ref p, end);
                        if (v.Length < k) throw Bad("DELTA_BINARY_PACKED page holds fewer values than expected.");
                        for (int i = 0; i < k; i++) vals[i] = col.FromLong(col.Physical == 1 ? (long)(int)v[i] : v[i]);
                        return;
                    }
                case 6:
                    {
                        long[] lens = Bits.DecodeDelta(b, ref p, end);
                        if (lens.Length < k) throw Bad("DELTA_LENGTH_BYTE_ARRAY page holds fewer values than expected.");
                        for (int i = 0; i < k; i++)
                        {
                            int l = (int)lens[i];
                            if (l < 0 || p + l > end) throw Bad("DELTA_LENGTH_BYTE_ARRAY value runs past the page.");
                            vals[i] = col.FromBytes(b, p, l);
                            p += l;
                        }
                        return;
                    }
                case 7:
                    {
                        long[] pre = Bits.DecodeDelta(b, ref p, end);
                        long[] suf = Bits.DecodeDelta(b, ref p, end);
                        if (pre.Length < k || suf.Length < k) throw Bad("DELTA_BYTE_ARRAY page holds fewer values than expected.");
                        byte[] prev = new byte[0];
                        for (int i = 0; i < k; i++)
                        {
                            int pl = (int)pre[i], sl = (int)suf[i];
                            if (pl < 0 || pl > prev.Length || sl < 0 || p + sl > end) throw Bad("DELTA_BYTE_ARRAY value is invalid.");
                            byte[] cur = new byte[pl + sl];
                            Buffer.BlockCopy(prev, 0, cur, 0, pl);
                            Buffer.BlockCopy(b, p, cur, pl, sl);
                            p += sl;
                            vals[i] = col.FromBytes(cur, 0, cur.Length);
                            prev = cur;
                        }
                        return;
                    }
                case 9:
                    {
                        int w;
                        switch (col.Physical)
                        {
                            case 1: case 4: w = 4; break;
                            case 2: case 5: w = 8; break;
                            case 7: w = col.TypeLength; break;
                            default: throw Bad("BYTE_STREAM_SPLIT is not valid for this physical type.");
                        }
                        if (p + (long)w * k > end) throw Bad("BYTE_STREAM_SPLIT page is truncated.");
                        byte[] one = new byte[w];
                        for (int i = 0; i < k; i++)
                        {
                            for (int j = 0; j < w; j++) one[j] = b[p + j * k + i];
                            vals[i] = PlainOne(one, 0, w);
                        }
                        return;
                    }
                default:
                    throw Bad("values use " + EncName(enc) + " encoding, which Semaphore does not read. Re-save the file with default (dictionary/PLAIN) encodings.");
            }
        }

        object PlainOne(byte[] b, int p, int w)
        {
            switch (col.Physical)
            {
                case 1: return col.FromLong(Val.LE32(b, p));
                case 2: return col.FromLong(Val.LE64(b, p));
                case 4: return (double)BitConverter.ToSingle(b, p);
                case 5: return BitConverter.ToDouble(b, p);
                default: return col.FromBytes(b, p, w);
            }
        }

        void DecodePlain(byte[] b, int p, int end, int k, object[] vals)
        {
            switch (col.Physical)
            {
                case 0:
                    if (p + (k + 7) / 8 > end) throw Bad("PLAIN booleans are truncated.");
                    for (int i = 0; i < k; i++) vals[i] = ((b[p + (i >> 3)] >> (i & 7)) & 1) != 0;
                    return;
                case 1:
                    if (p + 4L * k > end) throw Bad("PLAIN INT32 values are truncated.");
                    for (int i = 0; i < k; i++) { vals[i] = col.FromLong(Val.LE32(b, p)); p += 4; }
                    return;
                case 2:
                    if (p + 8L * k > end) throw Bad("PLAIN INT64 values are truncated.");
                    if (col.Kind == PqKind.Int) { for (int i = 0; i < k; i++) { vals[i] = Val.LE64(b, p); p += 8; } }
                    else for (int i = 0; i < k; i++) { vals[i] = col.FromLong(Val.LE64(b, p)); p += 8; }
                    return;
                case 3:
                    if (p + 12L * k > end) throw Bad("PLAIN INT96 values are truncated.");
                    for (int i = 0; i < k; i++) { vals[i] = col.FromBytes(b, p, 12); p += 12; }
                    return;
                case 4:
                    if (p + 4L * k > end) throw Bad("PLAIN FLOAT values are truncated.");
                    for (int i = 0; i < k; i++) { vals[i] = (double)BitConverter.ToSingle(b, p); p += 4; }
                    return;
                case 5:
                    if (p + 8L * k > end) throw Bad("PLAIN DOUBLE values are truncated.");
                    for (int i = 0; i < k; i++) { vals[i] = BitConverter.ToDouble(b, p); p += 8; }
                    return;
                case 6:
                    for (int i = 0; i < k; i++)
                    {
                        if (p + 4 > end) throw Bad("PLAIN BYTE_ARRAY values are truncated.");
                        int l = Val.LE32(b, p); p += 4;
                        if (l < 0 || p + l > end) throw Bad("PLAIN BYTE_ARRAY value runs past the page.");
                        vals[i] = col.FromBytes(b, p, l);
                        p += l;
                    }
                    return;
                case 7:
                    {
                        int w = col.TypeLength;
                        if (p + (long)w * k > end) throw Bad("PLAIN FIXED_LEN_BYTE_ARRAY values are truncated.");
                        for (int i = 0; i < k; i++) { vals[i] = col.FromBytes(b, p, w); p += w; }
                        return;
                    }
                default: throw Bad("unknown physical type.");
            }
        }
    }

    // ------------------------------------------------------------------------------------------
    // Typed column buffer used by both writers (one row group / record batch at a time)
    // ------------------------------------------------------------------------------------------
    internal sealed class ColBuf
    {
        public readonly string Name, Type;
        public int Count;
        public bool[] Nulls;
        public long[] Longs;      // integer, datetime (micros)
        public int[] Ints;        // date (days)
        public double[] Doubles;  // real
        public bool[] Bools;      // boolean
        public string[] Strings;  // text
        public byte[][] Blobs;    // blob
        public int NullCount;

        public ColBuf(string name, string type, int cap)
        {
            Name = name; Type = type;
            Nulls = new bool[cap];
            switch (type)
            {
                case "integer": case "datetime": Longs = new long[cap]; break;
                case "date": Ints = new int[cap]; break;
                case "real": Doubles = new double[cap]; break;
                case "boolean": Bools = new bool[cap]; break;
                case "text": Strings = new string[cap]; break;
                default: Blobs = new byte[cap][]; break;
            }
        }

        public void Add(object v)
        {
            int i = Count;
            if (Val.IsNull(v)) { Nulls[i] = true; NullCount++; Count++; return; }
            Nulls[i] = false;
            switch (Type)
            {
                case "integer": Longs[i] = Val.ToLong(v, Name); break;
                case "datetime": Longs[i] = Val.ToMicros(v, Name); break;
                case "date": Ints[i] = Val.ToDays(v, Name); break;
                case "real": Doubles[i] = Val.ToDouble(v, Name); break;
                case "boolean": Bools[i] = Val.ToBool(v, Name); break;
                case "text": Strings[i] = Val.ToText(v); break;
                default: Blobs[i] = Val.ToBlob(v); break;
            }
            Count++;
        }

        public void Reset()
        {
            if (Strings != null) Array.Clear(Strings, 0, Count);
            if (Blobs != null) Array.Clear(Blobs, 0, Count);
            Count = 0; NullCount = 0;
        }
    }

    // ------------------------------------------------------------------------------------------
    // Parquet writer
    // ------------------------------------------------------------------------------------------
    internal sealed class ParquetWriter
    {
        readonly Stream o;
        readonly string[] names, types;
        readonly int groupRows;
        long pos;
        long totalRows;
        readonly List<byte[]> rowGroupMeta = new List<byte[]>();
        const int PageBytes = 1 << 20;
        const int MaxDictBytes = 1 << 20;

        public ParquetWriter(Stream output, string[] names, string[] types, int rowGroupRows)
        {
            o = output; this.names = names; this.types = types; groupRows = rowGroupRows;
        }

        void Put(byte[] b) { o.Write(b, 0, b.Length); pos += b.Length; }
        void Put(byte[] b, int n) { o.Write(b, 0, n); pos += n; }

        public void Write(IEnumerable<object[]> rows)
        {
            Put(Encoding.ASCII.GetBytes("PAR1"));
            ColBuf[] bufs = new ColBuf[names.Length];
            int cap = Math.Min(groupRows, 1 << 16);
            for (int c = 0; c < names.Length; c++) bufs[c] = new ColBuf(names[c], types[c], cap);
            int n = 0;
            foreach (object[] row in rows)
            {
                if (row == null) continue;
                if (n == bufs[0].Nulls.Length) Grow(bufs, Math.Min(groupRows, n * 2));
                for (int c = 0; c < names.Length; c++) bufs[c].Add(c < row.Length ? row[c] : null);
                n++;
                if (n == groupRows) { WriteRowGroup(bufs, n); n = 0; }
            }
            if (n > 0) WriteRowGroup(bufs, n);
            byte[] footer = Footer();
            Put(footer);
            byte[] len = BitConverter.GetBytes(footer.Length);
            Put(len);
            Put(Encoding.ASCII.GetBytes("PAR1"));
        }

        static void Grow(ColBuf[] bufs, int cap)
        {
            for (int c = 0; c < bufs.Length; c++)
            {
                ColBuf b = bufs[c];
                Array.Resize(ref b.Nulls, cap);
                if (b.Longs != null) Array.Resize(ref b.Longs, cap);
                if (b.Ints != null) Array.Resize(ref b.Ints, cap);
                if (b.Doubles != null) Array.Resize(ref b.Doubles, cap);
                if (b.Bools != null) Array.Resize(ref b.Bools, cap);
                if (b.Strings != null) Array.Resize(ref b.Strings, cap);
                if (b.Blobs != null) Array.Resize(ref b.Blobs, cap);
            }
        }

        sealed class ChunkMeta
        {
            public int Physical;
            public List<int> Encodings = new List<int>();
            public long Uncompressed, Compressed, DataOffset, DictOffset = -1, NumValues, NullCount;
            public byte[] Min, Max;
        }

        void WriteRowGroup(ColBuf[] bufs, int n)
        {
            long start = pos;
            List<ChunkMeta> metas = new List<ChunkMeta>();
            long totalU = 0, totalC = 0;
            for (int c = 0; c < bufs.Length; c++)
            {
                ChunkMeta m = WriteChunk(bufs[c], n);
                metas.Add(m);
                totalU += m.Uncompressed; totalC += m.Compressed;
                bufs[c].Reset();
            }
            TWriter t = new TWriter();
            t.BeginElem();
            t.BeginList(1, 12, metas.Count);
            for (int c = 0; c < metas.Count; c++)
            {
                ChunkMeta m = metas[c];
                t.BeginElem();
                t.I64(2, m.DictOffset >= 0 ? m.DictOffset : m.DataOffset);
                t.BeginStruct(3);
                t.I32(1, m.Physical);
                t.BeginList(2, 5, m.Encodings.Count);
                foreach (int e in m.Encodings) t.ListI32(e);
                t.BeginList(3, 8, 1);
                t.ListBin(Encoding.UTF8.GetBytes(names[c]));
                t.I32(4, 1);
                t.I64(5, m.NumValues);
                t.I64(6, m.Uncompressed);
                t.I64(7, m.Compressed);
                t.I64(9, m.DataOffset);
                if (m.DictOffset >= 0) t.I64(11, m.DictOffset);
                t.BeginStruct(12);
                t.I64(3, m.NullCount);
                if (m.Max != null) t.Bin(5, m.Max);
                if (m.Min != null) t.Bin(6, m.Min);
                t.EndStruct();
                t.EndStruct();
                t.EndElem();
            }
            t.I64(2, totalU);
            t.I64(3, n);
            t.I64(5, start);
            t.I64(6, totalC);
            t.I16(7, rowGroupMeta.Count);
            t.EndElem();
            rowGroupMeta.Add(t.ToArray());
            totalRows += n;
        }

        static int Physical(string type)
        {
            switch (type)
            {
                case "boolean": return 0;
                case "date": return 1;
                case "integer": case "datetime": return 2;
                case "real": return 5;
                default: return 6;
            }
        }

        static int CompareBytes(byte[] a, byte[] b)
        {
            int n = Math.Min(a.Length, b.Length);
            for (int i = 0; i < n; i++) if (a[i] != b[i]) return a[i] - b[i];
            return a.Length - b.Length;
        }

        ChunkMeta WriteChunk(ColBuf b, int n)
        {
            ChunkMeta m = new ChunkMeta();
            m.Physical = Physical(b.Type);
            m.NumValues = n;
            m.NullCount = b.NullCount;
            int nonNull = n - b.NullCount;

            // UTF-8 bytes for text/blob, computed once.
            byte[][] bytes = null;
            if (b.Type == "text")
            {
                bytes = new byte[n][];
                for (int i = 0; i < n; i++) if (!b.Nulls[i]) bytes[i] = Encoding.UTF8.GetBytes(b.Strings[i]);
            }
            else if (b.Type == "blob") bytes = b.Blobs;

            // Dictionary for low-cardinality text.
            int[] codes = null;
            List<byte[]> dictVals = null;
            if (b.Type == "text" && nonNull > 0)
            {
                Dictionary<string, int> map = new Dictionary<string, int>(StringComparer.Ordinal);
                dictVals = new List<byte[]>();
                codes = new int[n];
                long dictBytes = 0;
                for (int i = 0; i < n && codes != null; i++)
                {
                    if (b.Nulls[i]) continue;
                    int id;
                    if (!map.TryGetValue(b.Strings[i], out id))
                    {
                        id = dictVals.Count;
                        map[b.Strings[i]] = id;
                        dictVals.Add(bytes[i]);
                        dictBytes += 4 + bytes[i].Length;
                        if (dictBytes > MaxDictBytes || dictVals.Count > 65535) codes = null;
                    }
                    if (codes != null) codes[i] = id;
                }
                if (codes != null && dictVals.Count * 2 > nonNull && nonNull > 16) codes = null;
                if (codes == null) dictVals = null;
            }

            // Statistics.
            ComputeStats(b, n, bytes, m);

            m.Encodings.Add(0);
            m.Encodings.Add(3);
            if (dictVals != null)
            {
                m.Encodings.Add(8);
                MemoryStream dp = new MemoryStream();
                foreach (byte[] v in dictVals) { dp.Write(BitConverter.GetBytes(v.Length), 0, 4); dp.Write(v, 0, v.Length); }
                m.DictOffset = pos;
                WritePage(m, 2, dp.ToArray(), dictVals.Count, -1);
            }
            m.DataOffset = pos;
            int dictBw = dictVals == null ? 0 : Math.Max(1, Bits.WidthFor(dictVals.Count - 1));

            int r = 0;
            while (r < n)
            {
                // Decide the page's row range by its approximate value size.
                int start = r;
                long sz = 0;
                while (r < n && sz < PageBytes)
                {
                    if (!b.Nulls[r])
                    {
                        if (codes != null) sz += 2;
                        else if (bytes != null) sz += 4 + bytes[r].Length;
                        else sz += 8;
                    }
                    r++;
                }
                int cnt = r - start;
                MemoryStream pg = new MemoryStream();
                // Definition levels (all columns are OPTIONAL): 4-byte length then RLE/bit-packed hybrid.
                int[] defs = new int[cnt];
                for (int i = 0; i < cnt; i++) defs[i] = b.Nulls[start + i] ? 0 : 1;
                MemoryStream lv = new MemoryStream();
                Bits.EncodeHybrid(defs, 0, cnt, 1, lv);
                pg.Write(BitConverter.GetBytes((int)lv.Length), 0, 4);
                lv.WriteTo(pg);
                int enc;
                if (codes != null)
                {
                    enc = 8;
                    int k = 0;
                    int[] idx = new int[cnt];
                    for (int i = start; i < r; i++) if (!b.Nulls[i]) idx[k++] = codes[i];
                    pg.WriteByte((byte)dictBw);
                    Bits.EncodeHybrid(idx, 0, k, dictBw, pg);
                }
                else
                {
                    enc = 0;
                    WritePlain(b, bytes, start, r, pg);
                }
                WritePage(m, 0, pg.ToArray(), cnt, enc);
            }
            return m;
        }

        static void WritePlain(ColBuf b, byte[][] bytes, int start, int end, MemoryStream pg)
        {
            byte[] tmp = new byte[8];
            switch (b.Type)
            {
                case "boolean":
                    {
                        int acc = 0, bits = 0;
                        for (int i = start; i < end; i++)
                        {
                            if (b.Nulls[i]) continue;
                            if (b.Bools[i]) acc |= 1 << bits;
                            bits++;
                            if (bits == 8) { pg.WriteByte((byte)acc); acc = 0; bits = 0; }
                        }
                        if (bits > 0) pg.WriteByte((byte)acc);
                        return;
                    }
                case "date":
                    for (int i = start; i < end; i++) if (!b.Nulls[i]) pg.Write(BitConverter.GetBytes(b.Ints[i]), 0, 4);
                    return;
                case "integer":
                case "datetime":
                    for (int i = start; i < end; i++) if (!b.Nulls[i]) pg.Write(BitConverter.GetBytes(b.Longs[i]), 0, 8);
                    return;
                case "real":
                    for (int i = start; i < end; i++) if (!b.Nulls[i]) pg.Write(BitConverter.GetBytes(b.Doubles[i]), 0, 8);
                    return;
                default:
                    for (int i = start; i < end; i++)
                    {
                        if (b.Nulls[i]) continue;
                        byte[] v = bytes[i];
                        pg.Write(BitConverter.GetBytes(v.Length), 0, 4);
                        pg.Write(v, 0, v.Length);
                    }
                    return;
            }
        }

        void WritePage(ChunkMeta m, int pageType, byte[] body, int numValues, int encoding)
        {
            byte[] comp = Snappy.Compress(body);
            TWriter h = new TWriter();
            h.I32(1, pageType);
            h.I32(2, body.Length);
            h.I32(3, comp.Length);
            if (pageType == 2)
            {
                h.BeginStruct(7);
                h.I32(1, numValues);
                h.I32(2, 0);
                h.EndStruct();
            }
            else
            {
                h.BeginStruct(5);
                h.I32(1, numValues);
                h.I32(2, encoding);
                h.I32(3, 3);
                h.I32(4, 3);
                h.EndStruct();
            }
            h.Stop();
            byte[] hb = h.ToArray();
            Put(hb);
            Put(comp);
            m.Uncompressed += hb.Length + body.Length;
            m.Compressed += hb.Length + comp.Length;
        }

        static void ComputeStats(ColBuf b, int n, byte[][] bytes, ChunkMeta m)
        {
            bool any = false;
            switch (b.Type)
            {
                case "integer":
                case "datetime":
                    {
                        long mn = 0, mx = 0;
                        for (int i = 0; i < n; i++)
                        {
                            if (b.Nulls[i]) continue;
                            long v = b.Longs[i];
                            if (!any) { mn = mx = v; any = true; }
                            else { if (v < mn) mn = v; if (v > mx) mx = v; }
                        }
                        if (any) { m.Min = BitConverter.GetBytes(mn); m.Max = BitConverter.GetBytes(mx); }
                        return;
                    }
                case "date":
                    {
                        int mn = 0, mx = 0;
                        for (int i = 0; i < n; i++)
                        {
                            if (b.Nulls[i]) continue;
                            int v = b.Ints[i];
                            if (!any) { mn = mx = v; any = true; }
                            else { if (v < mn) mn = v; if (v > mx) mx = v; }
                        }
                        if (any) { m.Min = BitConverter.GetBytes(mn); m.Max = BitConverter.GetBytes(mx); }
                        return;
                    }
                case "real":
                    {
                        double mn = 0, mx = 0;
                        for (int i = 0; i < n; i++)
                        {
                            if (b.Nulls[i]) continue;
                            double v = b.Doubles[i];
                            if (double.IsNaN(v)) continue;
                            if (!any) { mn = mx = v; any = true; }
                            else { if (v < mn) mn = v; if (v > mx) mx = v; }
                        }
                        if (any)
                        {
                            if (mn == 0) mn = -0.0;
                            if (mx == 0) mx = 0.0;
                            m.Min = BitConverter.GetBytes(mn); m.Max = BitConverter.GetBytes(mx);
                        }
                        return;
                    }
                case "boolean":
                    {
                        bool hasT = false, hasF = false;
                        for (int i = 0; i < n; i++) { if (b.Nulls[i]) continue; if (b.Bools[i]) hasT = true; else hasF = true; }
                        if (hasT || hasF)
                        {
                            m.Min = new byte[] { (byte)(hasF ? 0 : 1) };
                            m.Max = new byte[] { (byte)(hasT ? 1 : 0) };
                        }
                        return;
                    }
                default:
                    {
                        byte[] mn = null, mx = null;
                        for (int i = 0; i < n; i++)
                        {
                            if (b.Nulls[i]) continue;
                            byte[] v = bytes[i];
                            if (mn == null) { mn = mx = v; }
                            else { if (CompareBytes(v, mn) < 0) mn = v; if (CompareBytes(v, mx) > 0) mx = v; }
                        }
                        // Long values are left out rather than truncated, so the statistics stay exact.
                        if (mn != null && mn.Length <= 256 && mx.Length <= 256) { m.Min = mn; m.Max = mx; }
                        return;
                    }
            }
        }

        byte[] Footer()
        {
            TWriter t = new TWriter();
            t.I32(1, 2);
            t.BeginList(2, 12, names.Length + 1);
            t.BeginElem();
            t.Str(4, "schema");
            t.I32(5, names.Length);
            t.EndElem();
            for (int c = 0; c < names.Length; c++)
            {
                string ty = types[c];
                t.BeginElem();
                t.I32(1, Physical(ty));
                t.I32(3, 1);
                t.Str(4, names[c]);
                if (ty == "text") t.I32(6, 0);
                else if (ty == "date") t.I32(6, 6);
                else if (ty == "datetime") t.I32(6, 10);
                if (ty == "text") { t.BeginStruct(10); t.EmptyStruct(1); t.EndStruct(); }
                else if (ty == "date") { t.BeginStruct(10); t.EmptyStruct(6); t.EndStruct(); }
                else if (ty == "datetime")
                {
                    t.BeginStruct(10);
                    t.BeginStruct(8);
                    t.Bool(1, true);
                    t.BeginStruct(2); t.EmptyStruct(2); t.EndStruct();
                    t.EndStruct();
                    t.EndStruct();
                }
                t.EndElem();
            }
            t.I64(3, totalRows);
            t.BeginList(4, 12, rowGroupMeta.Count);
            foreach (byte[] rgm in rowGroupMeta) t.Out.Write(rgm, 0, rgm.Length);
            t.Str(6, "Semaphore columnar writer");
            t.BeginList(7, 12, names.Length);
            for (int c = 0; c < names.Length; c++) { t.BeginElem(); t.EmptyStruct(1); t.EndElem(); }
            t.Stop();
            return t.ToArray();
        }
    }

    // ------------------------------------------------------------------------------------------
    // Flatbuffers: a reader for Arrow metadata and a small front-to-back builder for the writer
    // ------------------------------------------------------------------------------------------
    internal struct FbTable
    {
        public readonly byte[] B;
        public readonly int Pos;
        public FbTable(byte[] b, int pos) { B = b; Pos = pos; }

        public static FbTable Root(byte[] b, int start)
        {
            if (b.Length - start < 8) throw new ColumnarException("Arrow metadata is too short.");
            return new FbTable(b, start + Val.LE32(b, start));
        }

        int Field(int idx)
        {
            int vt = Pos - Val.LE32(B, Pos);
            int vtSize = Val.LE16(B, vt);
            int o = 4 + 2 * idx;
            if (o + 2 > vtSize) return 0;
            int fo = Val.LE16(B, vt + o);
            return fo == 0 ? 0 : Pos + fo;
        }

        public bool Has(int idx) { return Field(idx) != 0; }
        public long Long(int idx, long def) { int p = Field(idx); return p == 0 ? def : Val.LE64(B, p); }
        public int Int(int idx, int def) { int p = Field(idx); return p == 0 ? def : Val.LE32(B, p); }
        public int Short(int idx, int def) { int p = Field(idx); return p == 0 ? def : (short)Val.LE16(B, p); }
        public int Byte(int idx, int def) { int p = Field(idx); return p == 0 ? def : B[p]; }
        public bool Bool(int idx, bool def) { int p = Field(idx); return p == 0 ? def : B[p] != 0; }

        public bool Table(int idx, out FbTable t)
        {
            int p = Field(idx);
            if (p == 0) { t = new FbTable(B, 0); return false; }
            t = new FbTable(B, p + Val.LE32(B, p));
            return true;
        }

        public string Str(int idx)
        {
            int p = Field(idx);
            if (p == 0) return null;
            int s = p + Val.LE32(B, p);
            int n = Val.LE32(B, s);
            if (n < 0 || s + 4 + n > B.Length) throw new ColumnarException("Arrow metadata string is out of range.");
            return Encoding.UTF8.GetString(B, s + 4, n);
        }

        // Returns element count and the position of the first element (0 if absent).
        public int Vector(int idx, out int first)
        {
            int p = Field(idx);
            if (p == 0) { first = 0; return 0; }
            int v = p + Val.LE32(B, p);
            int n = Val.LE32(B, v);
            if (n < 0 || v + 4 + (long)n > B.Length) throw new ColumnarException("Arrow metadata vector is out of range.");
            first = v + 4;
            return n;
        }

        public FbTable VectorTable(int first, int i) { int p = first + 4 * i; return new FbTable(B, p + Val.LE32(B, p)); }
    }

    internal abstract class FbObj { }
    internal sealed class FbStr : FbObj { public byte[] Data; public FbStr(string s) { Data = Encoding.UTF8.GetBytes(s); } }
    internal sealed class FbStructVec : FbObj { public byte[] Data; public int Count; public FbStructVec(byte[] d, int count) { Data = d; Count = count; } }
    internal sealed class FbRefVec : FbObj { public List<FbObj> Items = new List<FbObj>(); }
    internal sealed class FbTab : FbObj
    {
        public sealed class Fld { public int Idx, Size; public long Val; public FbObj Ref; }
        public readonly List<Fld> Fields = new List<Fld>();
        public FbTab Scalar(int idx, int size, long v) { Fld f = new Fld(); f.Idx = idx; f.Size = size; f.Val = v; Fields.Add(f); return this; }
        public FbTab Ref(int idx, FbObj o) { Fld f = new Fld(); f.Idx = idx; f.Size = 4; f.Ref = o; Fields.Add(f); return this; }
    }

    internal sealed class FbBuilder
    {
        byte[] buf = new byte[256];
        int len;

        void Ensure(int n) { if (len + n > buf.Length) Array.Resize(ref buf, Math.Max(buf.Length * 2, len + n)); }
        void Pad(int align) { while (len % align != 0) { Ensure(1); buf[len++] = 0; } }
        void W(long v, int size) { Ensure(size); for (int i = 0; i < size; i++) buf[len++] = (byte)(v >> (8 * i)); }
        void Patch32(int at, int v) { buf[at] = (byte)v; buf[at + 1] = (byte)(v >> 8); buf[at + 2] = (byte)(v >> 16); buf[at + 3] = (byte)(v >> 24); }

        public static byte[] Finish(FbTab root)
        {
            FbBuilder b = new FbBuilder();
            b.W(0, 4);
            b.W(0, 4);
            int r = b.Place(root);
            b.Patch32(0, r);
            b.Pad(8);
            byte[] o = new byte[b.len];
            Buffer.BlockCopy(b.buf, 0, o, 0, b.len);
            return o;
        }

        int Place(FbObj obj)
        {
            FbStr s = obj as FbStr;
            if (s != null)
            {
                Pad(4);
                int p = len;
                W(s.Data.Length, 4);
                Ensure(s.Data.Length + 1);
                Buffer.BlockCopy(s.Data, 0, buf, len, s.Data.Length);
                len += s.Data.Length;
                buf[len++] = 0;
                return p;
            }
            FbStructVec sv = obj as FbStructVec;
            if (sv != null)
            {
                while ((len + 4) % 8 != 0) W(0, 1);
                int p = len;
                W(sv.Count, 4);
                Ensure(sv.Data.Length);
                Buffer.BlockCopy(sv.Data, 0, buf, len, sv.Data.Length);
                len += sv.Data.Length;
                return p;
            }
            FbRefVec rv = obj as FbRefVec;
            if (rv != null)
            {
                Pad(4);
                int p = len;
                W(rv.Items.Count, 4);
                int slots = len;
                for (int i = 0; i < rv.Items.Count; i++) W(0, 4);
                for (int i = 0; i < rv.Items.Count; i++)
                {
                    int q = Place(rv.Items[i]);
                    Patch32(slots + 4 * i, q - (slots + 4 * i));
                }
                return p;
            }
            FbTab t = (FbTab)obj;
            int maxIdx = -1;
            foreach (FbTab.Fld f in t.Fields) if (f.Idx > maxIdx) maxIdx = f.Idx;
            int[] offs = new int[maxIdx + 1];
            // Inline layout: soffset, then 4-byte, then 8-byte (8-aligned), then 2- and 1-byte fields.
            int cur = 4;
            List<FbTab.Fld> order = new List<FbTab.Fld>();
            foreach (FbTab.Fld f in t.Fields) if (f.Size == 4) order.Add(f);
            bool any8 = false;
            foreach (FbTab.Fld f in t.Fields) if (f.Size == 8) any8 = true;
            foreach (FbTab.Fld f in order) { offs[f.Idx] = cur; cur += 4; }
            if (any8) { if (cur % 8 != 0) cur += 4; foreach (FbTab.Fld f in t.Fields) if (f.Size == 8) { order.Add(f); offs[f.Idx] = cur; cur += 8; } }
            foreach (FbTab.Fld f in t.Fields) if (f.Size == 2) { order.Add(f); offs[f.Idx] = cur; cur += 2; }
            foreach (FbTab.Fld f in t.Fields) if (f.Size == 1) { order.Add(f); offs[f.Idx] = cur; cur += 1; }
            int tableSize = cur;
            Pad(2);
            int vt = len;
            int vtSize = 4 + 2 * (maxIdx + 1);
            W(vtSize, 2);
            W(tableSize, 2);
            for (int i = 0; i <= maxIdx; i++) W(offs[i], 2);
            Pad(8);
            int tp = len;
            W(tp - vt, 4);
            Ensure(tableSize);
            for (int i = 4; i < tableSize; i++) buf[len + i - 4] = 0;
            len = tp + tableSize;
            foreach (FbTab.Fld f in t.Fields)
            {
                if (f.Ref != null) continue;
                int at = tp + offs[f.Idx];
                for (int i = 0; i < f.Size; i++) buf[at + i] = (byte)(f.Val >> (8 * i));
            }
            foreach (FbTab.Fld f in t.Fields)
            {
                if (f.Ref == null) continue;
                int at = tp + offs[f.Idx];
                int q = Place(f.Ref);
                Patch32(at, q - at);
            }
            return tp;
        }
    }

    // ------------------------------------------------------------------------------------------
    // Arrow IPC reader
    // ------------------------------------------------------------------------------------------
    internal enum ArKind { Null, Int, UInt, Float16, Float32, Float64, Utf8, LargeUtf8, Binary, LargeBinary, Utf8View, BinaryView, FixedBinary, Bool, Date32, Date64, Timestamp, Time32, Time64, Duration, Decimal }

    internal sealed class ArType
    {
        public ArKind Kind;
        public int BitWidth;     // Int, Decimal (128/256)
        public long UnitsPerSecond;
        public int Scale;
        public int ByteWidth;    // FixedSizeBinary
        public string OutType;
        public int BufferCount;  // buffers per node in the body
    }

    internal sealed class ArField
    {
        public string Name;
        public ArType Type;      // value type
        public bool Dict;
        public long DictId;
        public int IndexBits;
        public bool IndexSigned;
    }

    // One column's view of the current record batch body.
    internal sealed class ArCol
    {
        public ArType T;
        public byte[] Body;
        public long Length, NullCount;
        public int ValidOff, ValidLen, OffOff, OffLen, DataOff, DataLen;
        public int[] VarOff, VarLen;   // variadic data buffers of Utf8View/BinaryView
        public bool IsIndex;      // dictionary indices (integer buffer) rather than values
        public int IndexBits; public bool IndexSigned;
        public object[] DictValues;
        public string FieldName;

        public bool IsValid(long i)
        {
            if (NullCount == 0 || ValidLen == 0) return true;
            return ((Body[ValidOff + (int)(i >> 3)] >> (int)(i & 7)) & 1) != 0;
        }

        long ReadInt(long i, int bits, bool signed)
        {
            int p = DataOff + (int)(i * (bits / 8));
            switch (bits)
            {
                case 8: return signed ? (long)(sbyte)Body[p] : Body[p];
                case 16: return signed ? (long)(short)Val.LE16(Body, p) : Val.LE16(Body, p);
                case 32: return signed ? (long)Val.LE32(Body, p) : (long)(uint)Val.LE32(Body, p);
                default: return Val.LE64(Body, p);
            }
        }

        public object Get(long i)
        {
            if (T.Kind == ArKind.Null) return null;
            if (!IsValid(i)) return null;
            if (IsIndex)
            {
                long x = ReadInt(i, IndexBits, IndexSigned);
                if (DictValues == null) throw new ColumnarException("Arrow column '" + FieldName + "' refers to a dictionary that was never sent.");
                if (x < 0 || x >= DictValues.Length) throw new ColumnarException("Arrow column '" + FieldName + "' has dictionary index " + x + " out of range.");
                return DictValues[x];
            }
            switch (T.Kind)
            {
                case ArKind.Int: return ReadInt(i, T.BitWidth, true);
                case ArKind.UInt:
                    {
                        long v = ReadInt(i, T.BitWidth, false);
                        if (T.BitWidth == 64 && v < 0) return (double)(ulong)v;
                        return v;
                    }
                case ArKind.Float16: return Val.HalfToDouble(Val.LE16(Body, DataOff + (int)i * 2));
                case ArKind.Float32: return (double)BitConverter.ToSingle(Body, DataOff + (int)i * 4);
                case ArKind.Float64: return BitConverter.ToDouble(Body, DataOff + (int)i * 8);
                case ArKind.Bool: return ((Body[DataOff + (int)(i >> 3)] >> (int)(i & 7)) & 1) != 0;
                case ArKind.Date32: return Val.FormatDate(Val.LE32(Body, DataOff + (int)i * 4));
                case ArKind.Date64: return Val.FormatDate(Val.FloorDiv(Val.LE64(Body, DataOff + (int)i * 8), 86400000L));
                case ArKind.Timestamp: return Val.FormatTimestamp(Val.LE64(Body, DataOff + (int)i * 8), T.UnitsPerSecond);
                case ArKind.Time32: return Val.FormatTime(Val.LE32(Body, DataOff + (int)i * 4), T.UnitsPerSecond);
                case ArKind.Time64: return Val.FormatTime(Val.LE64(Body, DataOff + (int)i * 8), T.UnitsPerSecond);
                case ArKind.Duration: return Val.LE64(Body, DataOff + (int)i * 8);
                case ArKind.Decimal:
                    {
                        int w = T.BitWidth / 8;
                        return Val.DecimalFromBytes(Body, DataOff + (int)i * w, w, T.Scale, false);
                    }
                case ArKind.FixedBinary: return Val.Slice(Body, DataOff + (int)i * T.ByteWidth, T.ByteWidth);
                case ArKind.Utf8View:
                case ArKind.BinaryView:
                    {
                        // 16-byte view: length, then up to 12 inline bytes, or a 4-byte prefix, buffer index and offset.
                        int p = DataOff + (int)i * 16;
                        int len = Val.LE32(Body, p);
                        int at;
                        if (len < 0) throw new ColumnarException("Arrow column '" + FieldName + "' has a negative view length.");
                        if (len <= 12) at = p + 4;
                        else
                        {
                            int bi = Val.LE32(Body, p + 8), o = Val.LE32(Body, p + 12);
                            if (VarOff == null || bi < 0 || bi >= VarOff.Length || o < 0 || (long)o + len > VarLen[bi])
                                throw new ColumnarException("Arrow column '" + FieldName + "' has a view outside its data buffers.");
                            at = VarOff[bi] + o;
                        }
                        if (T.Kind == ArKind.Utf8View) return Encoding.UTF8.GetString(Body, at, len);
                        return Val.Slice(Body, at, len);
                    }
                case ArKind.Utf8:
                case ArKind.Binary:
                case ArKind.LargeUtf8:
                case ArKind.LargeBinary:
                    {
                        long a, b;
                        if (T.Kind == ArKind.Utf8 || T.Kind == ArKind.Binary) { a = Val.LE32(Body, OffOff + (int)i * 4); b = Val.LE32(Body, OffOff + (int)i * 4 + 4); }
                        else { a = Val.LE64(Body, OffOff + (int)i * 8); b = Val.LE64(Body, OffOff + (int)i * 8 + 8); }
                        if (a < 0 || b < a || b > DataLen) throw new ColumnarException("Arrow column '" + FieldName + "' has an invalid offset.");
                        if (T.Kind == ArKind.Utf8 || T.Kind == ArKind.LargeUtf8) return Encoding.UTF8.GetString(Body, DataOff + (int)a, (int)(b - a));
                        return Val.Slice(Body, DataOff + (int)a, (int)(b - a));
                    }
            }
            return null;
        }
    }

    internal sealed class ArrowReader : ITableReader
    {
        readonly Stream s;
        readonly bool fileMode;
        ArField[] fields;
        string[] names, types;
        long? rowCount;
        int metadataVersion = 4;
        readonly Dictionary<long, object[]> dicts = new Dictionary<long, object[]>();
        readonly List<long> batchOffsets = new List<long>();
        int nextBatch;
        long streamPos;
        bool streamDone;
        ArCol[] cur;
        long curLen, curRow;

        public ArrowReader(Stream stream)
        {
            s = stream;
            long len = s.Length;
            byte[] head = new byte[8];
            s.Position = 0;
            int n = ReadSome(head, 8);
            fileMode = n >= 6 && head[0] == 'A' && head[1] == 'R' && head[2] == 'R' && head[3] == 'O' && head[4] == 'W' && head[5] == '1';
            try
            {
                if (fileMode) OpenFile(len);
                else OpenStream();
            }
            catch (Exception e)
            {
                if (!ParquetReader.IsCorruption(e)) throw;
                throw new ColumnarException("Arrow metadata is corrupt (" + e.GetType().Name + ": " + e.Message + ").", e);
            }
        }

        int ReadSome(byte[] b, int n)
        {
            int got = 0;
            while (got < n) { int k = s.Read(b, got, n - got); if (k <= 0) break; got += k; }
            return got;
        }

        void OpenFile(long len)
        {
            if (len < 18) throw new ColumnarException("Arrow file is too short.");
            byte[] tail = new byte[10];
            s.Position = len - 10;
            ReadSome(tail, 10);
            if (tail[4] != 'A' || tail[5] != 'R' || tail[6] != 'R' || tail[7] != 'O' || tail[8] != 'W' || tail[9] != '1')
                throw new ColumnarException("Arrow file has no ARROW1 footer magic (truncated, or a stream saved with a .arrow name).");
            int flen = Val.LE32(tail, 0);
            if (flen <= 0 || flen > len - 18) throw new ColumnarException("Arrow footer length " + flen + " is invalid.");
            byte[] fb = new byte[flen];
            s.Position = len - 10 - flen;
            if (ReadSome(fb, flen) != flen) throw new ColumnarException("Arrow footer is truncated.");
            FbTable footer = FbTable.Root(fb, 0);
            metadataVersion = footer.Short(0, 4);
            FbTable schema;
            if (!footer.Table(1, out schema)) throw new ColumnarException("Arrow footer has no schema.");
            ParseSchema(schema);
            int first;
            int nd = footer.Vector(2, out first);
            for (int i = 0; i < nd; i++)
            {
                long off = Val.LE64(fb, first + 24 * i);
                s.Position = off;
                FbTable msg; byte[] meta; byte[] body;
                if (!ReadMessage(true, out msg, out meta, out body)) throw new ColumnarException("Arrow dictionary block " + i + " is empty.");
                HandleDictionary(msg, body);
            }
            int nb = footer.Vector(3, out first);
            long total = 0;
            for (int i = 0; i < nb; i++)
            {
                long off = Val.LE64(fb, first + 24 * i);
                batchOffsets.Add(off);
                s.Position = off;
                FbTable msg; byte[] meta; byte[] body;
                if (!ReadMessage(false, out msg, out meta, out body)) throw new ColumnarException("Arrow record batch block " + i + " is empty.");
                FbTable rb;
                if (msg.Byte(1, 0) != 3 || !msg.Table(2, out rb)) throw new ColumnarException("Arrow record batch block " + i + " does not hold a record batch.");
                CheckCompression(rb);
                total += rb.Long(0, 0);
            }
            rowCount = total;
        }

        void OpenStream()
        {
            streamPos = 0;
            s.Position = 0;
            FbTable msg; byte[] meta; byte[] body;
            if (!ReadMessage(true, out msg, out meta, out body)) throw new ColumnarException("Arrow stream is empty.");
            FbTable schema;
            if (msg.Byte(1, 0) != 1 || !msg.Table(2, out schema)) throw new ColumnarException("Arrow stream does not start with a schema message.");
            metadataVersion = msg.Short(0, 4);
            ParseSchema(schema);
            streamPos = s.Position;
            rowCount = null;
        }

        // Reads one encapsulated message at the current position. False at end of stream.
        bool ReadMessage(bool withBody, out FbTable msg, out byte[] meta, out byte[] body)
        {
            msg = new FbTable(); meta = null; body = null;
            byte[] four = new byte[4];
            if (ReadSome(four, 4) < 4) return false;
            int len = Val.LE32(four, 0);
            if (len == -1)
            {
                if (ReadSome(four, 4) < 4) return false;
                len = Val.LE32(four, 0);
            }
            if (len == 0) return false;
            if (len < 0 || len > s.Length - s.Position) throw new ColumnarException("Arrow message length " + len + " is invalid.");
            meta = new byte[len];
            if (ReadSome(meta, len) != len) throw new ColumnarException("Arrow message is truncated.");
            msg = FbTable.Root(meta, 0);
            long bodyLen = msg.Long(3, 0);
            if (bodyLen < 0 || bodyLen > s.Length - s.Position) throw new ColumnarException("Arrow message body length " + bodyLen + " runs past the end of the file.");
            if (bodyLen > int.MaxValue) throw new ColumnarException("Arrow record batch body is larger than 2 GB; save it in smaller batches.");
            if (withBody)
            {
                body = new byte[bodyLen];
                if (ReadSome(body, (int)bodyLen) != bodyLen) throw new ColumnarException("Arrow message body is truncated.");
            }
            else s.Position += bodyLen;
            return true;
        }

        static readonly string[] TypeNames = { "NONE", "Null", "Int", "FloatingPoint", "Binary", "Utf8", "Bool", "Decimal", "Date", "Time", "Timestamp", "Interval", "List", "Struct", "Union", "FixedSizeBinary", "FixedSizeList", "Map", "Duration", "LargeBinary", "LargeUtf8", "LargeList", "RunEndEncoded", "BinaryView", "Utf8View", "ListView", "LargeListView" };

        static long UnitsFor(int unit) { switch (unit) { case 0: return 1; case 1: return 1000; case 2: return 1000000; default: return 1000000000; } }

        // Returns null if the type is supported, else the reason.
        string ParseType(FbTable f, out ArType t)
        {
            t = new ArType();
            int tt = f.Byte(2, 0);
            FbTable ty;
            bool hasT = f.Table(3, out ty);
            string tn = tt >= 0 && tt < TypeNames.Length ? TypeNames[tt] : ("type " + tt);
            t.BufferCount = 2;
            switch (tt)
            {
                case 1: t.Kind = ArKind.Null; t.OutType = "text"; t.BufferCount = metadataVersion < 4 ? 1 : 0; return null;
                case 2:
                    {
                        int bw = hasT ? ty.Int(0, 32) : 32;
                        bool signed = hasT && ty.Bool(1, false);
                        if (bw != 8 && bw != 16 && bw != 32 && bw != 64) return "Int with " + bw + " bits";
                        t.Kind = signed ? ArKind.Int : ArKind.UInt; t.BitWidth = bw; t.OutType = "integer"; return null;
                    }
                case 3:
                    {
                        int prec = hasT ? ty.Short(0, 0) : 0;
                        t.Kind = prec == 0 ? ArKind.Float16 : prec == 1 ? ArKind.Float32 : ArKind.Float64; t.OutType = "real"; return null;
                    }
                case 4: t.Kind = ArKind.Binary; t.OutType = "blob"; t.BufferCount = 3; return null;
                case 5: t.Kind = ArKind.Utf8; t.OutType = "text"; t.BufferCount = 3; return null;
                case 6: t.Kind = ArKind.Bool; t.OutType = "boolean"; return null;
                case 7:
                    {
                        t.Kind = ArKind.Decimal; t.Scale = hasT ? ty.Int(1, 0) : 0; t.BitWidth = hasT ? ty.Int(2, 128) : 128;
                        if (t.BitWidth != 128 && t.BitWidth != 256 && t.BitWidth != 64 && t.BitWidth != 32) return "Decimal with " + t.BitWidth + " bits";
                        t.OutType = "real"; return null;
                    }
                case 8:
                    {
                        int unit = hasT ? ty.Short(0, 1) : 1;
                        t.Kind = unit == 0 ? ArKind.Date32 : ArKind.Date64; t.OutType = "date"; return null;
                    }
                case 9:
                    {
                        int unit = hasT ? ty.Short(0, 1) : 1;
                        int bw = hasT ? ty.Int(1, 32) : 32;
                        t.Kind = bw == 64 ? ArKind.Time64 : ArKind.Time32; t.UnitsPerSecond = UnitsFor(unit); t.OutType = "text"; return null;
                    }
                case 10:
                    {
                        int unit = hasT ? ty.Short(0, 0) : 0;
                        t.Kind = ArKind.Timestamp; t.UnitsPerSecond = UnitsFor(unit); t.OutType = "datetime"; return null;
                    }
                case 15: t.Kind = ArKind.FixedBinary; t.ByteWidth = hasT ? ty.Int(0, 0) : 0; t.OutType = "blob"; if (t.ByteWidth <= 0) return "FixedSizeBinary without a width"; return null;
                case 18: t.Kind = ArKind.Duration; t.OutType = "integer"; return null;
                case 19: t.Kind = ArKind.LargeBinary; t.OutType = "blob"; t.BufferCount = 3; return null;
                case 20: t.Kind = ArKind.LargeUtf8; t.OutType = "text"; t.BufferCount = 3; return null;
                case 23: t.Kind = ArKind.BinaryView; t.OutType = "blob"; return null;
                case 24: t.Kind = ArKind.Utf8View; t.OutType = "text"; return null;
                case 12: case 13: case 14: case 16: case 17: case 21: case 25: case 26: case 22:
                    return "nested type " + tn;
                default:
                    return "unsupported type " + tn;
            }
        }

        void ParseSchema(FbTable schema)
        {
            if (schema.Short(0, 0) != 0) throw new ColumnarException("Arrow data is big-endian; Semaphore reads little-endian Arrow only.");
            int first;
            int n = schema.Vector(1, out first);
            List<ArField> list = new List<ArField>();
            List<string> bad = new List<string>();
            for (int i = 0; i < n; i++)
            {
                FbTable f = schema.VectorTable(first, i);
                ArField af = new ArField();
                af.Name = f.Str(0) ?? ("column" + i);
                ArType t;
                string why = ParseType(f, out t);
                af.Type = t;
                int cf;
                if (why == null && f.Vector(5, out cf) > 0) why = "child fields";
                FbTable de;
                if (f.Table(4, out de))
                {
                    af.Dict = true;
                    af.DictId = de.Long(0, 0);
                    FbTable it;
                    if (de.Table(1, out it)) { af.IndexBits = it.Int(0, 32); af.IndexSigned = it.Bool(1, true); }
                    else { af.IndexBits = 32; af.IndexSigned = true; }
                    if (af.IndexBits != 8 && af.IndexBits != 16 && af.IndexBits != 32 && af.IndexBits != 64) why = "dictionary index of " + af.IndexBits + " bits";
                }
                if (why != null) bad.Add(af.Name + " (" + why + ")");
                list.Add(af);
            }
            if (bad.Count > 0)
                throw new ColumnarException("Arrow column(s) " + string.Join(", ", bad.ToArray()) + " cannot be read: Semaphore imports flat tables of numbers, text, dates, times, booleans and binary. Flatten or drop these columns and save again.");
            fields = list.ToArray();
            names = new string[fields.Length];
            types = new string[fields.Length];
            for (int i = 0; i < fields.Length; i++) { names[i] = fields[i].Name; types[i] = fields[i].Type.OutType; }
        }

        static void CheckCompression(FbTable rb)
        {
            FbTable comp;
            if (rb.Table(3, out comp))
            {
                int codec = comp.Byte(0, 0);
                string cn = codec == 0 ? "LZ4_FRAME" : codec == 1 ? "ZSTD" : ("codec " + codec);
                throw new ColumnarException("This Arrow file uses " + cn + " body compression, which Semaphore cannot read. Re-save it uncompressed, for example pyarrow feather.write_feather(table, path, compression='uncompressed') or ipc.new_file(path, schema, options=ipc.IpcWriteOptions(compression=None)).");
            }
        }

        // Binds a record batch body to column views. nodeStart/bufStart walk the flat field list.
        ArCol[] Bind(FbTable rb, byte[] body, ArField[] flds, bool valuesOnly)
        {
            CheckCompression(rb);
            int nFirst, bFirst;
            int nn = rb.Vector(1, out nFirst);
            int nbuf = rb.Vector(2, out bFirst);
            int vFirst;
            int nvar = rb.Vector(4, out vFirst);
            byte[] mb = rb.B;
            ArCol[] cols = new ArCol[flds.Length];
            int ni = 0, bi = 0, vi = 0;
            for (int c = 0; c < flds.Length; c++)
            {
                ArField f = flds[c];
                ArCol col = new ArCol();
                col.FieldName = f.Name;
                col.T = f.Type;
                col.Body = body;
                if (ni >= nn) throw new ColumnarException("Arrow record batch has fewer field nodes than columns.");
                col.Length = Val.LE64(mb, nFirst + 16 * ni);
                col.NullCount = Val.LE64(mb, nFirst + 16 * ni + 8);
                ni++;
                bool asIndex = f.Dict && !valuesOnly;
                int bc = asIndex ? 2 : f.Type.BufferCount;
                bool view = !asIndex && (f.Type.Kind == ArKind.Utf8View || f.Type.Kind == ArKind.BinaryView);
                if (view)
                {
                    long extra = vi < nvar ? Val.LE64(mb, vFirst + 8 * vi) : 0;
                    vi++;
                    if (extra < 0 || extra > nbuf) throw new ColumnarException("Arrow column '" + f.Name + "' has an invalid variadic buffer count.");
                    bc = 2 + (int)extra;
                }
                int[] off = new int[Math.Max(3, bc)], ln = new int[Math.Max(3, bc)];
                for (int k = 0; k < bc; k++)
                {
                    if (bi >= nbuf) throw new ColumnarException("Arrow record batch has fewer buffers than its columns need.");
                    long bo = Val.LE64(mb, bFirst + 16 * bi), bl = Val.LE64(mb, bFirst + 16 * bi + 8);
                    bi++;
                    if (bo < 0 || bl < 0 || bo + bl > body.Length) throw new ColumnarException("Arrow column '" + f.Name + "' has a buffer outside the message body.");
                    off[k] = (int)bo; ln[k] = (int)bl;
                }
                if (f.Type.Kind == ArKind.Null && !asIndex) { col.NullCount = col.Length; }
                else
                {
                    col.ValidOff = off[0]; col.ValidLen = ln[0];
                    if (view)
                    {
                        col.DataOff = off[1]; col.DataLen = ln[1];
                        col.VarOff = new int[bc - 2]; col.VarLen = new int[bc - 2];
                        for (int k = 2; k < bc; k++) { col.VarOff[k - 2] = off[k]; col.VarLen[k - 2] = ln[k]; }
                    }
                    else if (bc == 3) { col.OffOff = off[1]; col.OffLen = ln[1]; col.DataOff = off[2]; col.DataLen = ln[2]; }
                    else { col.DataOff = off[1]; col.DataLen = ln[1]; }
                }
                if (col.NullCount > 0 && col.ValidLen > 0 && col.ValidLen * 8L < col.Length) throw new ColumnarException("Arrow column '" + f.Name + "' has a short validity bitmap.");
                if (asIndex)
                {
                    col.IsIndex = true; col.IndexBits = f.IndexBits; col.IndexSigned = f.IndexSigned;
                    object[] dv;
                    dicts.TryGetValue(f.DictId, out dv);
                    col.DictValues = dv;
                    if ((long)col.DataLen < col.Length * (f.IndexBits / 8)) throw new ColumnarException("Arrow column '" + f.Name + "' has a short index buffer.");
                }
                else CheckSize(col);
                cols[c] = col;
            }
            return cols;
        }

        static void CheckSize(ArCol col)
        {
            long need = 0;
            switch (col.T.Kind)
            {
                case ArKind.Int: case ArKind.UInt: need = col.Length * (col.T.BitWidth / 8); break;
                case ArKind.Float16: need = col.Length * 2; break;
                case ArKind.Float32: case ArKind.Date32: case ArKind.Time32: need = col.Length * 4; break;
                case ArKind.Float64: case ArKind.Date64: case ArKind.Time64: case ArKind.Timestamp: case ArKind.Duration: need = col.Length * 8; break;
                case ArKind.Decimal: need = col.Length * (col.T.BitWidth / 8); break;
                case ArKind.FixedBinary: need = col.Length * col.T.ByteWidth; break;
                case ArKind.Utf8View: case ArKind.BinaryView: need = col.Length * 16; break;
                case ArKind.Bool: need = (col.Length + 7) / 8; break;
                case ArKind.Utf8: case ArKind.Binary: if (col.Length > 0 && col.OffLen < (col.Length + 1) * 4) throw new ColumnarException("Arrow column '" + col.FieldName + "' has a short offsets buffer."); break;
                case ArKind.LargeUtf8: case ArKind.LargeBinary: if (col.Length > 0 && col.OffLen < (col.Length + 1) * 8) throw new ColumnarException("Arrow column '" + col.FieldName + "' has a short offsets buffer."); break;
            }
            if (col.DataLen < need) throw new ColumnarException("Arrow column '" + col.FieldName + "' has a data buffer shorter than its length.");
        }

        void HandleDictionary(FbTable msg, byte[] body)
        {
            FbTable db;
            if (msg.Byte(1, 0) != 2 || !msg.Table(2, out db)) throw new ColumnarException("Arrow dictionary block does not hold a dictionary batch.");
            long id = db.Long(0, 0);
            FbTable rb;
            if (!db.Table(1, out rb)) throw new ColumnarException("Arrow dictionary batch has no data.");
            bool delta = db.Bool(2, false);
            ArField owner = null;
            foreach (ArField f in fields) if (f.Dict && f.DictId == id) { owner = f; break; }
            if (owner == null) return;
            ArCol[] c = Bind(rb, body, new ArField[] { owner }, true);
            ArCol col = c[0];
            object[] vals = new object[col.Length];
            for (long i = 0; i < col.Length; i++) vals[i] = col.Get(i);
            object[] prev;
            if (delta && dicts.TryGetValue(id, out prev))
            {
                object[] all = new object[prev.Length + vals.Length];
                Array.Copy(prev, all, prev.Length);
                Array.Copy(vals, 0, all, prev.Length, vals.Length);
                vals = all;
            }
            dicts[id] = vals;
        }

        bool LoadNextBatch()
        {
            while (true)
            {
                FbTable msg; byte[] meta; byte[] body;
                if (fileMode)
                {
                    if (nextBatch >= batchOffsets.Count) return false;
                    s.Position = batchOffsets[nextBatch++];
                    if (!ReadMessage(true, out msg, out meta, out body)) return false;
                }
                else
                {
                    if (streamDone) return false;
                    s.Position = streamPos;
                    if (!ReadMessage(true, out msg, out meta, out body)) { streamDone = true; return false; }
                    streamPos = s.Position;
                }
                int ht = msg.Byte(1, 0);
                FbTable h;
                if (!msg.Table(2, out h)) continue;
                if (ht == 2) { HandleDictionary(msg, body); continue; }
                if (ht != 3) continue;
                cur = Bind(h, body, fields, false);
                curLen = h.Long(0, 0);
                curRow = 0;
                for (int c = 0; c < cur.Length; c++)
                    if (cur[c].Length < curLen) throw new ColumnarException("Arrow column '" + fields[c].Name + "' is shorter than its record batch.");
                return true;
            }
        }

        public string[] Names { get { return names; } }
        public string[] Types { get { return types; } }
        public long? RowCount { get { return rowCount; } }

        public bool Next(object[] row)
        {
            if (row == null || row.Length < fields.Length) throw new ArgumentException("row must have room for " + fields.Length + " values.");
            try
            {
                while (cur == null || curRow >= curLen)
                {
                    cur = null;
                    if (!LoadNextBatch()) return false;
                }
                for (int c = 0; c < cur.Length; c++) row[c] = cur[c].Get(curRow);
            }
            catch (Exception e)
            {
                if (!ParquetReader.IsCorruption(e)) throw;
                throw new ColumnarException("Arrow data is corrupt (" + e.GetType().Name + ": " + e.Message + ").", e);
            }
            curRow++;
            return true;
        }

        public void Dispose() { s.Dispose(); }
    }

    // ------------------------------------------------------------------------------------------
    // Arrow IPC writer (file format, uncompressed, one record batch per batchRows rows)
    // ------------------------------------------------------------------------------------------
    internal sealed class ArrowWriter
    {
        readonly Stream o;
        readonly string[] names, types;
        readonly int batchRows;
        long pos;
        readonly List<long[]> blocks = new List<long[]>();

        public ArrowWriter(Stream output, string[] names, string[] types, int batchRows)
        {
            o = output; this.names = names; this.types = types; this.batchRows = batchRows;
        }

        void Put(byte[] b, int n) { o.Write(b, 0, n); pos += n; }
        void Put(byte[] b) { Put(b, b.Length); }

        FbTab Schema()
        {
            FbRefVec fv = new FbRefVec();
            for (int c = 0; c < names.Length; c++)
            {
                FbTab f = new FbTab();
                f.Ref(0, new FbStr(names[c]));
                f.Scalar(1, 1, 1);
                int tt; FbTab ty = new FbTab();
                switch (types[c])
                {
                    case "integer": tt = 2; ty.Scalar(0, 4, 64).Scalar(1, 1, 1); break;
                    case "real": tt = 3; ty.Scalar(0, 2, 2); break;
                    case "text": tt = 5; break;
                    case "date": tt = 8; ty.Scalar(0, 2, 0); break;
                    case "datetime": tt = 10; ty.Scalar(0, 2, 2).Ref(1, new FbStr("UTC")); break;
                    case "boolean": tt = 6; break;
                    default: tt = 4; break;
                }
                f.Scalar(2, 1, tt);
                f.Ref(3, ty);
                f.Ref(5, new FbRefVec());
                fv.Items.Add(f);
            }
            FbTab s = new FbTab();
            s.Scalar(0, 2, 0);
            s.Ref(1, fv);
            return s;
        }

        void WriteMessage(int headerType, FbTab header, byte[] body, int bodyLen, bool record)
        {
            FbTab m = new FbTab();
            m.Scalar(0, 2, 4);
            m.Scalar(1, 1, headerType);
            m.Ref(2, header);
            m.Scalar(3, 8, bodyLen);
            byte[] fb = FbBuilder.Finish(m);
            int padded = (fb.Length + 8 + 7) / 8 * 8 - 8;
            long start = pos;
            Put(new byte[] { 0xFF, 0xFF, 0xFF, 0xFF });
            Put(BitConverter.GetBytes(padded));
            Put(fb);
            if (padded > fb.Length) Put(new byte[padded - fb.Length]);
            if (bodyLen > 0) Put(body, bodyLen);
            if (record) blocks.Add(new long[] { start, padded + 8, bodyLen });
        }

        public void Write(IEnumerable<object[]> rows)
        {
            Put(new byte[] { (byte)'A', (byte)'R', (byte)'R', (byte)'O', (byte)'W', (byte)'1', 0, 0 });
            WriteMessage(1, Schema(), null, 0, false);
            ColBuf[] bufs = new ColBuf[names.Length];
            for (int c = 0; c < names.Length; c++) bufs[c] = new ColBuf(names[c], types[c], batchRows);
            int n = 0;
            foreach (object[] row in rows)
            {
                if (row == null) continue;
                for (int c = 0; c < names.Length; c++) bufs[c].Add(c < row.Length ? row[c] : null);
                n++;
                if (n == batchRows) { WriteBatch(bufs, n); n = 0; }
            }
            if (n > 0 || blocks.Count == 0) WriteBatch(bufs, n);
            Put(new byte[] { 0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0 });
            // Footer
            FbTab footer = new FbTab();
            footer.Scalar(0, 2, 4);
            footer.Ref(1, Schema());
            footer.Ref(2, new FbStructVec(new byte[0], 0));
            byte[] bd = new byte[24 * blocks.Count];
            for (int i = 0; i < blocks.Count; i++)
            {
                Buffer.BlockCopy(BitConverter.GetBytes(blocks[i][0]), 0, bd, 24 * i, 8);
                Buffer.BlockCopy(BitConverter.GetBytes((int)blocks[i][1]), 0, bd, 24 * i + 8, 4);
                Buffer.BlockCopy(BitConverter.GetBytes(blocks[i][2]), 0, bd, 24 * i + 16, 8);
            }
            footer.Ref(3, new FbStructVec(bd, blocks.Count));
            byte[] fb = FbBuilder.Finish(footer);
            Put(fb);
            Put(BitConverter.GetBytes(fb.Length));
            Put(new byte[] { (byte)'A', (byte)'R', (byte)'R', (byte)'O', (byte)'W', (byte)'1' });
        }

        sealed class Body
        {
            public MemoryStream Data = new MemoryStream();
            public List<long> Buffers = new List<long>();
            public void Add(byte[] b, int n)
            {
                long off = Data.Length;
                Data.Write(b, 0, n);
                while (Data.Length % 8 != 0) Data.WriteByte(0);
                Buffers.Add(off); Buffers.Add(n);
            }
        }

        void WriteBatch(ColBuf[] bufs, int n)
        {
            Body body = new Body();
            byte[] nodes = new byte[16 * bufs.Length];
            for (int c = 0; c < bufs.Length; c++)
            {
                ColBuf b = bufs[c];
                Buffer.BlockCopy(BitConverter.GetBytes((long)n), 0, nodes, 16 * c, 8);
                Buffer.BlockCopy(BitConverter.GetBytes((long)b.NullCount), 0, nodes, 16 * c + 8, 8);
                if (b.NullCount > 0)
                {
                    byte[] vb = new byte[(n + 7) / 8];
                    for (int i = 0; i < n; i++) if (!b.Nulls[i]) vb[i >> 3] |= (byte)(1 << (i & 7));
                    body.Add(vb, vb.Length);
                }
                else body.Add(new byte[0], 0);
                switch (b.Type)
                {
                    case "integer":
                    case "datetime":
                        {
                            byte[] d = new byte[8 * n];
                            for (int i = 0; i < n; i++) if (!b.Nulls[i]) Buffer.BlockCopy(BitConverter.GetBytes(b.Longs[i]), 0, d, 8 * i, 8);
                            body.Add(d, d.Length);
                            break;
                        }
                    case "real":
                        {
                            byte[] d = new byte[8 * n];
                            for (int i = 0; i < n; i++) if (!b.Nulls[i]) Buffer.BlockCopy(BitConverter.GetBytes(b.Doubles[i]), 0, d, 8 * i, 8);
                            body.Add(d, d.Length);
                            break;
                        }
                    case "date":
                        {
                            byte[] d = new byte[4 * n];
                            for (int i = 0; i < n; i++) if (!b.Nulls[i]) Buffer.BlockCopy(BitConverter.GetBytes(b.Ints[i]), 0, d, 4 * i, 4);
                            body.Add(d, d.Length);
                            break;
                        }
                    case "boolean":
                        {
                            byte[] d = new byte[(n + 7) / 8];
                            for (int i = 0; i < n; i++) if (!b.Nulls[i] && b.Bools[i]) d[i >> 3] |= (byte)(1 << (i & 7));
                            body.Add(d, d.Length);
                            break;
                        }
                    default:
                        {
                            byte[] offs = new byte[4 * (n + 1)];
                            MemoryStream data = new MemoryStream();
                            for (int i = 0; i < n; i++)
                            {
                                if (!b.Nulls[i])
                                {
                                    byte[] v = b.Type == "text" ? Encoding.UTF8.GetBytes(b.Strings[i]) : b.Blobs[i];
                                    data.Write(v, 0, v.Length);
                                    if (data.Length > int.MaxValue) throw new ColumnarException("Column '" + b.Name + "' holds more than 2 GB in one Arrow batch.");
                                }
                                Buffer.BlockCopy(BitConverter.GetBytes((int)data.Length), 0, offs, 4 * (i + 1), 4);
                            }
                            body.Add(offs, offs.Length);
                            body.Add(data.GetBuffer(), (int)data.Length);
                            break;
                        }
                }
                b.Reset();
            }
            byte[] bufMeta = new byte[8 * body.Buffers.Count];
            for (int i = 0; i < body.Buffers.Count; i++) Buffer.BlockCopy(BitConverter.GetBytes(body.Buffers[i]), 0, bufMeta, 8 * i, 8);
            FbTab rb = new FbTab();
            rb.Scalar(0, 8, n);
            rb.Ref(1, new FbStructVec(nodes, bufs.Length));
            rb.Ref(2, new FbStructVec(bufMeta, body.Buffers.Count / 2));
            if (body.Data.Length > int.MaxValue) throw new ColumnarException("Arrow record batch is larger than 2 GB.");
            WriteMessage(3, rb, body.Data.GetBuffer(), (int)body.Data.Length, true);
        }
    }
}
