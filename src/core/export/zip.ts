// A ZIP writer, and the deflate helpers the other writers share. Both run on the standard
// CompressionStream, so the same code works in Node 22 and Edge with nothing to install.

export interface ZipEntry {
  /** Forward slashes, no leading slash. Written as UTF-8. */
  name: string;
  data: Uint8Array | string;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function joinBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function throughStream(data: Uint8Array, stream: { readable: ReadableStream; writable: WritableStream }): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Written and read at once: a large input would otherwise stall on the stream's back-pressure.
  const writing = writer.write(data).then(() => writer.close());
  writing.catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array);
  }
  await writing;
  return joinBytes(chunks);
}

export const deflateRaw = (data: Uint8Array) => throughStream(data, new CompressionStream('deflate-raw'));
export const inflateRaw = (data: Uint8Array) => throughStream(data, new DecompressionStream('deflate-raw'));
/** Deflate in a zlib wrapper, as PDF's FlateDecode and PNG's IDAT use. */
export const deflateZlib = (data: Uint8Array) => throughStream(data, new CompressionStream('deflate'));
export const inflateZlib = (data: Uint8Array) => throughStream(data, new DecompressionStream('deflate'));

/** Date and time in the two 16-bit fields ZIP uses, read as UTC. ZIP's calendar starts in 1980. */
function dosStamp(date: Date | undefined): { time: number; day: number } {
  if (!date || Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1980 || date.getUTCFullYear() > 2107) {
    return { time: 0, day: (1 << 5) | 1 };
  }
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    day: ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

const UTF8_NAMES = 0x0800;
const STORE = 0;
const DEFLATE = 8;

/** Builds a ZIP. Each entry is deflated, or stored when deflate would not make it smaller. */
export async function zip(entries: ZipEntry[], options: { date?: Date } = {}): Promise<Uint8Array> {
  if (entries.length > 0xffff) throw new Error('A ZIP without ZIP64 holds at most 65,535 files.');
  const encoder = new TextEncoder();
  const { time, day } = dosStamp(options.date);
  const seen = new Set<string>();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (!entry.name || entry.name.startsWith('/') || entry.name.includes('\\') || entry.name.split('/').includes('..')) {
      throw new Error(`Not a safe ZIP entry name: ${entry.name}`);
    }
    if (seen.has(entry.name)) throw new Error(`Two ZIP entries are named ${entry.name}.`);
    seen.add(entry.name);

    const name = encoder.encode(entry.name);
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const packed = raw.length > 0 ? await deflateRaw(raw) : raw;
    const method = packed.length < raw.length ? DEFLATE : STORE;
    const body = method === DEFLATE ? packed : raw;
    const crc = crc32(raw);
    if (offset + body.length > 0xfffffffe) throw new Error('A ZIP without ZIP64 is limited to 4 GB.');

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, UTF8_NAMES, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const head = new Uint8Array(46 + name.length);
    const cv = new DataView(head.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, UTF8_NAMES, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    head.set(name, 46);

    parts.push(local, body);
    central.push(head);
    offset += local.length + body.length;
  }

  const directory = joinBytes(central);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directory.length, true);
  ev.setUint32(16, offset, true);
  return joinBytes([...parts, directory, end]);
}
