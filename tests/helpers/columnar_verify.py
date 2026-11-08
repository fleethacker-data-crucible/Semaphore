"""Independent checker for Parquet and Arrow IPC files (Python standard library only).

Written from the parquet-format thrift definitions and the Arrow IPC flatbuffer schemas, with no
code shared with server/Columnar.cs. It checks the structure strictly (required thrift fields,
page and chunk sizes, offsets, statistics, flatbuffer and buffer alignment, footer blocks) and
prints the decoded table as JSON: every value as a string (reals in repr form, blobs in base64)
or null.

usage: python columnar_verify.py FILE
"""
import base64
import datetime
import gzip
import json
import struct
import sys

EPOCH = datetime.date(1970, 1, 1)


class Bad(Exception):
    pass


def need(cond, msg):
    if not cond:
        raise Bad(msg)


# ----------------------------------------------------------------------------- snappy
def snappy_decode(b):
    p, n, shift = 0, 0, 0
    while True:
        x = b[p]; p += 1
        n |= (x & 0x7F) << shift
        if not x & 0x80:
            break
        shift += 7
    out = bytearray()
    while p < len(b):
        tag = b[p]; p += 1
        kind = tag & 3
        if kind == 0:
            ln = tag >> 2
            if ln >= 60:
                nb = ln - 59
                ln = int.from_bytes(b[p:p + nb], 'little'); p += nb
            ln += 1
            out += b[p:p + ln]; p += ln
            continue
        if kind == 1:
            ln = ((tag >> 2) & 7) + 4
            off = ((tag >> 5) << 8) | b[p]; p += 1
        elif kind == 2:
            ln = (tag >> 2) + 1
            off = int.from_bytes(b[p:p + 2], 'little'); p += 2
        else:
            ln = (tag >> 2) + 1
            off = int.from_bytes(b[p:p + 4], 'little'); p += 4
        need(0 < off <= len(out), 'snappy offset out of range')
        for _ in range(ln):
            out.append(out[-off])
    need(len(out) == n, 'snappy length mismatch')
    return bytes(out)


# ----------------------------------------------------------------------------- thrift compact
class TReader:
    def __init__(self, b, p=0):
        self.b, self.p = b, p

    def byte(self):
        x = self.b[self.p]; self.p += 1
        return x

    def varint(self):
        r, s = 0, 0
        while True:
            x = self.byte()
            r |= (x & 0x7F) << s
            if not x & 0x80:
                return r
            s += 7

    def zz(self):
        n = self.varint()
        return (n >> 1) ^ -(n & 1)

    def value(self, t):
        if t == 1:
            return True
        if t == 2:
            return False
        if t == 3:
            return struct.unpack('b', bytes([self.byte()]))[0]
        if t in (4, 5, 6):
            return self.zz()
        if t == 7:
            v = struct.unpack('<d', self.b[self.p:self.p + 8])[0]; self.p += 8
            return v
        if t == 8:
            n = self.varint()
            v = bytes(self.b[self.p:self.p + n]); self.p += n
            return v
        if t in (9, 10):
            h = self.byte()
            n, et = h >> 4, h & 15
            if n == 15:
                n = self.varint()
            if et in (1, 2):
                return [self.byte() == 1 for _ in range(n)]
            return [self.value(et) for _ in range(n)]
        if t == 12:
            return self.struct()
        raise Bad('thrift type %d not expected here' % t)

    def struct(self):
        d, last = {}, 0
        while True:
            h = self.byte()
            if h == 0:
                return d
            t, delta = h & 15, h >> 4
            fid = last + delta if delta else self.zz()
            need(fid not in d, 'thrift field %d repeated' % fid)
            last = fid
            d[fid] = self.value(t)


def req(d, ids, what):
    for i in ids:
        need(i in d, '%s is missing required field %d' % (what, i))


# ----------------------------------------------------------------------------- parquet
def hybrid(b, p, end, bw, n):
    out = []
    while len(out) < n:
        need(p < end, 'RLE levels truncated')
        h, s = 0, 0
        while True:
            x = b[p]; p += 1
            h |= (x & 0x7F) << s
            if not x & 0x80:
                break
            s += 7
        if h & 1:
            groups = h >> 1
            raw = int.from_bytes(b[p:p + groups * bw], 'little'); p += groups * bw
            for i in range(groups * 8):
                out.append((raw >> (i * bw)) & ((1 << bw) - 1))
        else:
            w = (bw + 7) // 8
            v = int.from_bytes(b[p:p + w], 'little'); p += w
            out.extend([v] * (h >> 1))
    return out[:n], p


def plain(b, p, phys, n, tlen):
    vals = []
    for i in range(n):
        if phys == 0:
            vals.append((b[p + i // 8] >> (i % 8)) & 1 == 1)
        elif phys == 1:
            vals.append(struct.unpack_from('<i', b, p)[0]); p += 4
        elif phys == 2:
            vals.append(struct.unpack_from('<q', b, p)[0]); p += 8
        elif phys == 5:
            vals.append(struct.unpack_from('<d', b, p)[0]); p += 8
        elif phys == 4:
            vals.append(struct.unpack_from('<f', b, p)[0]); p += 4
        elif phys == 6:
            ln = struct.unpack_from('<i', b, p)[0]; p += 4
            vals.append(bytes(b[p:p + ln])); p += ln
        elif phys == 7:
            vals.append(bytes(b[p:p + tlen])); p += tlen
        else:
            raise Bad('physical type %d not handled by the checker' % phys)
    if phys == 0:
        p += (n + 7) // 8
    return vals, p


def stat_key(phys, raw):
    if phys == 0:
        return raw[0]
    if phys == 1:
        return struct.unpack('<i', raw)[0]
    if phys == 2:
        return struct.unpack('<q', raw)[0]
    if phys == 5:
        return struct.unpack('<d', raw)[0]
    return raw


def show_parquet(se, v):
    if v is None:
        return None
    phys, lt, ct = se.get(1), se.get(10, {}), se.get(6)
    if phys == 0:
        return 'true' if v else 'false'
    if phys == 1 and (6 in lt or ct == 6):
        return (EPOCH + datetime.timedelta(days=v)).isoformat()
    if phys == 2 and (8 in lt or ct in (9, 10)):
        unit = lt.get(8, {}).get(2, {2: {}}) if 8 in lt else ({1: {}} if ct == 9 else {2: {}})
        per = 1000 if 1 in unit else 1000000 if 2 in unit else 1000000000
        secs, frac = divmod(v, per)
        dt = datetime.datetime(1970, 1, 1) + datetime.timedelta(seconds=secs)
        s = dt.isoformat(timespec='seconds')
        if frac:
            s += '.%03d' % (frac * 1000 // per)
        return s + 'Z'
    if phys in (1, 2):
        return str(v)
    if phys in (4, 5):
        return repr(float(v))
    if phys == 6 and (1 in lt or ct == 0):
        return v.decode('utf-8')
    return base64.b64encode(v).decode('ascii')


def read_parquet(b):
    need(b[:4] == b'PAR1' and b[-4:] == b'PAR1', 'PAR1 magic missing')
    flen = struct.unpack('<i', b[-8:-4])[0]
    tr = TReader(b, len(b) - 8 - flen)
    meta = tr.struct()
    need(tr.p == len(b) - 8, 'footer length does not match the thrift footer')
    req(meta, (1, 2, 3, 4), 'FileMetaData')
    schema = meta[2]
    req(schema[0], (4,), 'root SchemaElement')
    need(schema[0].get(5) == len(schema) - 1, 'root num_children does not match the schema')
    leaves = schema[1:]
    for se in leaves:
        req(se, (1, 3, 4), 'SchemaElement')
        need(5 not in se, 'nested schema not expected from this writer')
    if 7 in meta:
        need(len(meta[7]) == len(leaves), 'column_orders length differs from the column count')
    rows = []
    encodings = []
    total = 0
    expected_offset = 4
    for gi, rg in enumerate(meta[4]):
        req(rg, (1, 2, 3), 'RowGroup')
        need(len(rg[1]) == len(leaves), 'row group column count')
        n = rg[3]
        total += n
        cols = []
        rg_comp = 0
        for ci, cc in enumerate(rg[1]):
            req(cc, (2, 3), 'ColumnChunk')
            md = cc[3]
            req(md, (1, 2, 3, 4, 5, 6, 7, 9), 'ColumnMetaData')
            if gi == 0:
                encodings.append(sorted(md[2]))
            se = leaves[ci]
            need(md[1] == se[1], 'column type differs from schema')
            need(md[3] == [se[4]], 'path_in_schema differs from schema name')
            need(md[5] == n, 'num_values differs from row group rows (flat column)')
            start = md.get(11, md[9])
            need(start == expected_offset, 'column chunk does not start where the previous one ended')
            if 11 in md:
                need(md[11] < md[9], 'dictionary page must come before data pages')
            p = start
            usum = csum = 0
            vals = []
            dictionary = None
            while len(vals) < n:
                hr = TReader(b, p)
                h = hr.struct()
                req(h, (1, 2, 3), 'PageHeader')
                hlen = hr.p - p
                body = bytes(b[hr.p:hr.p + h[3]])
                p = hr.p + h[3]
                usum += hlen + h[2]
                csum += hlen + h[3]
                codec = md[4]
                if codec == 1:
                    data = snappy_decode(body)
                elif codec == 2:
                    data = gzip.decompress(body)
                else:
                    need(codec == 0, 'codec %d not handled by the checker' % codec)
                    data = body
                need(len(data) == h[2], 'uncompressed_page_size does not match the page')
                if h[1] == 2:
                    need(dictionary is None and not vals, 'dictionary page out of place')
                    need(start == md.get(11), 'dictionary page offset not set')
                    dh = h[7]
                    req(dh, (1, 2), 'DictionaryPageHeader')
                    dictionary, _ = plain(data, 0, se[1], dh[1], se.get(2, 0))
                    continue
                need(h[1] == 0, 'page type %d not expected from this writer' % h[1])
                dh = h[5]
                req(dh, (1, 2, 3, 4), 'DataPageHeader')
                cnt = dh[1]
                q = 0
                if se[3] == 1:
                    ln = struct.unpack_from('<i', data, 0)[0]
                    defs, _ = hybrid(data, 4, 4 + ln, 1, cnt)
                    q = 4 + ln
                else:
                    defs = [1] * cnt
                k = sum(defs)
                if dh[2] == 0:
                    pv, q = plain(data, q, se[1], k, se.get(2, 0))
                    need(q == len(data), 'PLAIN page has trailing bytes')
                elif dh[2] in (2, 8):
                    need(dictionary is not None, 'dictionary page missing')
                    bw = data[q]
                    idx, _ = hybrid(data, q + 1, len(data), bw, k)
                    pv = [dictionary[i] for i in idx]
                    need(dh[2] in md[2], 'data page encoding missing from chunk encodings')
                else:
                    raise Bad('encoding %d not handled by the checker' % dh[2])
                it = iter(pv)
                vals.extend(next(it) if d else None for d in defs)
            need(len(vals) == n, 'column chunk value count')
            need(usum == md[6], 'total_uncompressed_size %d but pages add up to %d' % (md[6], usum))
            need(csum == md[7], 'total_compressed_size %d but pages add up to %d' % (md[7], csum))
            expected_offset = p
            rg_comp += csum
            st = md.get(12)
            if st is not None:
                nulls = sum(1 for v in vals if v is None)
                if 3 in st:
                    need(st[3] == nulls, 'null_count %d but %d nulls' % (st[3], nulls))
                live = [v for v in vals if v is not None and not (isinstance(v, float) and v != v)]
                if 5 in st or 6 in st:
                    need(live, 'min/max written for an all-null chunk')
                    keyed = [stat_key(se[1], v) if not isinstance(v, (bytes, bool, int, float)) else v for v in live]
                    if se[1] == 0:
                        keyed = [1 if v else 0 for v in live]
                    lo, hi = min(keyed), max(keyed)
                    need(stat_key(se[1], st[6]) == lo, 'min_value is not the minimum')
                    need(stat_key(se[1], st[5]) == hi, 'max_value is not the maximum')
            cols.append([show_parquet(se, v) for v in vals])
        if 6 in rg:
            need(rg[6] == rg_comp, 'row group total_compressed_size')
        for r in range(n):
            rows.append([c[r] for c in cols])
    need(total == meta[3], 'num_rows %d but row groups hold %d' % (meta[3], total))
    need(expected_offset == len(b) - 8 - flen, 'bytes between the last column chunk and the footer')
    return {'format': 'parquet', 'names': [se[4].decode('utf-8') for se in leaves],
            'row_groups': len(meta[4]), 'encodings': encodings, 'rows': rows}


# ----------------------------------------------------------------------------- flatbuffers / arrow
class Table:
    def __init__(self, b, pos):
        self.b, self.pos = b, pos
        self.vt = pos - struct.unpack_from('<i', b, pos)[0]
        self.vtlen = struct.unpack_from('<H', b, self.vt)[0]
        need(self.vtlen >= 4 and self.vtlen % 2 == 0, 'bad vtable size')

    def off(self, i):
        o = 4 + 2 * i
        if o + 2 > self.vtlen:
            return 0
        return struct.unpack_from('<H', self.b, self.vt + o)[0]

    def scalar(self, i, fmt, default):
        o = self.off(i)
        if not o:
            return default
        at = self.pos + o
        need(at % struct.calcsize(fmt) == 0, 'misaligned scalar in flatbuffer')
        return struct.unpack_from('<' + fmt, self.b, at)[0]

    def ref(self, i):
        o = self.off(i)
        if not o:
            return None
        at = self.pos + o
        need(at % 4 == 0, 'misaligned offset in flatbuffer')
        return at + struct.unpack_from('<I', self.b, at)[0]

    def table(self, i):
        r = self.ref(i)
        return Table(self.b, r) if r is not None else None

    def string(self, i):
        r = self.ref(i)
        if r is None:
            return None
        n = struct.unpack_from('<I', self.b, r)[0]
        need(self.b[r + 4 + n] == 0, 'flatbuffer string not zero-terminated')
        return bytes(self.b[r + 4:r + 4 + n]).decode('utf-8')

    def vector(self, i):
        r = self.ref(i)
        if r is None:
            return None, 0
        return r + 4, struct.unpack_from('<I', self.b, r)[0]

    def tables(self, i):
        start, n = self.vector(i)
        out = []
        for k in range(n):
            at = start + 4 * k
            out.append(Table(self.b, at + struct.unpack_from('<I', self.b, at)[0]))
        return out

    def structs(self, i, size, fmt):
        start, n = self.vector(i)
        if start is None:
            return None
        need(start % 8 == 0, 'struct vector not 8-byte aligned')
        return [struct.unpack_from('<' + fmt, self.b, start + size * k) for k in range(n)]


def root(b):
    return Table(b, struct.unpack_from('<I', b, 0)[0])


def field_desc(f):
    tt = f.scalar(2, 'B', 0)
    t = f.table(3)
    need(t is not None, 'field type table missing')
    need(f.vector(5)[0] is not None, 'field children vector missing (Arrow C++ requires it)')
    if tt == 2:
        return ('int', t.scalar(0, 'i', 0), t.scalar(1, '?', False))
    if tt == 3:
        return ('float', t.scalar(0, 'h', 0))
    if tt == 8:
        return ('date', t.scalar(0, 'h', 1))
    if tt == 10:
        return ('ts', t.scalar(0, 'h', 0), t.string(1))
    return (tt,)


def arrow_value(desc, body, bufs, i):
    kind = desc[0]
    data = bufs[1]
    if kind == 'int':
        w = desc[1] // 8
        return str(int.from_bytes(body[data[0] + w * i:data[0] + w * i + w], 'little', signed=desc[2]))
    if kind == 'float':
        return repr(struct.unpack_from('<d', body, data[0] + 8 * i)[0])
    if kind == 'date':
        return (EPOCH + datetime.timedelta(days=struct.unpack_from('<i', body, data[0] + 4 * i)[0])).isoformat()
    if kind == 'ts':
        per = (1, 1000, 1000000, 1000000000)[desc[1]]
        v = struct.unpack_from('<q', body, data[0] + 8 * i)[0]
        secs, frac = divmod(v, per)
        s = (datetime.datetime(1970, 1, 1) + datetime.timedelta(seconds=secs)).isoformat(timespec='seconds')
        if frac:
            s += '.%03d' % (frac * 1000 // per)
        return s + 'Z'
    if kind == 6:
        return 'true' if (body[data[0] + i // 8] >> (i % 8)) & 1 else 'false'
    if kind in (4, 5):
        offs = bufs[1][0]
        a, z = struct.unpack_from('<ii', body, offs + 4 * i)
        raw = bytes(body[bufs[2][0] + a:bufs[2][0] + z])
        return raw.decode('utf-8') if kind == 5 else base64.b64encode(raw).decode('ascii')
    raise Bad('arrow type %r not handled by the checker' % (kind,))


def read_message(b, p):
    need(p % 8 == 0, 'message does not start on an 8-byte boundary')
    need(struct.unpack_from('<I', b, p)[0] == 0xFFFFFFFF, 'continuation marker missing')
    ln = struct.unpack_from('<i', b, p + 4)[0]
    if ln == 0:
        return None, p + 8, 0, 0
    need((8 + ln) % 8 == 0, 'metadata length not padded to 8 bytes')
    meta = bytes(b[p + 8:p + 8 + ln])
    m = root(meta)
    need(m.scalar(0, 'h', 0) == 4, 'message metadata version is not V5')
    body_len = m.scalar(3, 'q', 0)
    need(body_len % 8 == 0, 'body length not a multiple of 8')
    return m, p + 8 + ln, ln + 8, body_len


def read_arrow(b):
    need(b[:6] == b'ARROW1' and b[6:8] == b'\0\0' and b[-6:] == b'ARROW1', 'ARROW1 magic missing')
    flen = struct.unpack_from('<i', b, len(b) - 10)[0]
    footer = root(bytes(b[len(b) - 10 - flen:len(b) - 10]))
    need(footer.scalar(0, 'h', 0) == 4, 'footer version is not V5')
    fschema = footer.table(1)
    fields = fschema.tables(1)
    names = [f.string(0) for f in fields]
    descs = [field_desc(f) for f in fields]
    m, p, _, _ = read_message(b, 8)
    need(m.scalar(1, 'B', 0) == 1, 'first message is not the schema')
    s2 = m.table(2)
    need([f.string(0) for f in s2.tables(1)] == names, 'schema message and footer schema differ')
    need([field_desc(f) for f in s2.tables(1)] == descs, 'schema message and footer types differ')
    blocks = footer.structs(3, 24, 'qi4xq')
    need(footer.structs(2, 24, 'qi4xq') is not None, 'footer dictionaries vector missing')
    rows = []
    for off, mlen, blen in blocks:
        need(off == p, 'record batch block offset %d but message at %d' % (off, p))
        m, bodyp, real_mlen, body_len = read_message(b, off)
        need(real_mlen == mlen, 'block metaDataLength differs from the message')
        need(body_len == blen, 'block bodyLength differs from the message')
        need(m.scalar(1, 'B', 0) == 3, 'block does not hold a record batch')
        rb = m.table(2)
        n = rb.scalar(0, 'q', 0)
        nodes = rb.structs(1, 16, 'qq')
        bufs = rb.structs(2, 16, 'qq')
        need(len(nodes) == len(fields), 'one field node per column')
        body = b[bodyp:bodyp + body_len]
        cols, bi = [], 0
        for c, d in enumerate(descs):
            nb = 3 if d[0] in (4, 5) else 2
            mine = bufs[bi:bi + nb]; bi += nb
            for bo, bl in mine:
                need(bo % 8 == 0 and bo + bl <= body_len, 'buffer misaligned or outside the body')
            length, nulls = nodes[c]
            need(length == n, 'field node length differs from the batch')
            vals = []
            seen_nulls = 0
            for i in range(n):
                valid = True
                if mine[0][1]:
                    valid = (body[mine[0][0] + i // 8] >> (i % 8)) & 1 == 1
                if not valid:
                    seen_nulls += 1
                    vals.append(None)
                else:
                    vals.append(arrow_value(d, body, mine, i))
            need(seen_nulls == nulls, 'null_count %d but %d nulls' % (nulls, seen_nulls))
            cols.append(vals)
        need(bi == len(bufs), 'unused buffers in the record batch')
        for r in range(n):
            rows.append([c[r] for c in cols])
        p = bodyp + body_len
    eos = struct.unpack_from('<Ii', b, p)
    need(eos == (0xFFFFFFFF, 0), 'end-of-stream marker missing before the footer')
    need(p + 8 == len(b) - 10 - flen, 'bytes between the end-of-stream marker and the footer')
    return {'format': 'arrow', 'names': names, 'batches': len(blocks), 'rows': rows}


def main():
    b = open(sys.argv[1], 'rb').read()
    try:
        out = read_parquet(b) if b[:4] == b'PAR1' else read_arrow(b)
        out['ok'] = True
    except (Bad, IndexError, struct.error, KeyError, ValueError) as e:
        out = {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}
    sys.stdout.write(json.dumps(out))


if __name__ == '__main__':
    main()
