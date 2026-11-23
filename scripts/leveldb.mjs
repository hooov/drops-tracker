// Reads a LevelDB folder already loaded into memory, as Chromium writes one for chrome.storage.
// Reading only, for scripts/read-storage.mjs. Format: LevelDB's doc/log_format.md and
// doc/table_format.md, snappy's format_description.txt.
// Every checksum is verified, and anything damaged, missing or not understood throws Unreadable: a
// key that looks absent because a file was half copied would read as "no minutes". The one
// exception is the end of the live log, which a running browser is always in the middle of.

export class Unreadable extends Error {
  constructor(message) {
    super(message);
    this.name = 'Unreadable';
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32c(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// LevelDB stores a checksum rotated and offset, since checksummed data can hold checksums.
const masked = (buf) => {
  const c = crc32c(buf);
  return (((c >>> 15) | (c << 17)) + 0xa282ead8) >>> 0;
};

/** A cursor whose every read is bounds checked. */
function reader(buf, what) {
  let at = 0;
  const need = (n) => {
    if (!(n >= 0) || at + n > buf.length) throw new Unreadable(`${what} ends too early`);
  };
  const self = {
    done: () => at >= buf.length,
    left: () => buf.length - at,
    bytes(n) {
      need(n);
      at += n;
      return buf.subarray(at - n, at);
    },
    byte: () => self.bytes(1)[0],
    u16: () => self.bytes(2).readUInt16LE(),
    u32: () => self.bytes(4).readUInt32LE(),
    u64: () => Number(self.bytes(8).readBigUInt64LE()),
    varint() {
      let value = 0;
      let scale = 1;
      for (let i = 0; i < 10; i++) {
        const b = self.byte();
        value += (b & 127) * scale;
        if (b < 128) return value;
        scale *= 128;
      }
      throw new Unreadable(`${what} holds a number that is too long`);
    },
    slice: () => self.bytes(self.varint()),
  };
  return self;
}

export function snappy(buf) {
  const r = reader(buf, 'a compressed block');
  const size = r.varint();
  if (size > 256 * 1024 * 1024) throw new Unreadable('a compressed block claims to be too large');
  const out = Buffer.alloc(size);
  let n = 0;
  while (!r.done()) {
    const tag = r.byte();
    let length;
    let offset;
    if ((tag & 3) === 0) {
      length = tag >>> 2;
      if (length >= 60) length = r.bytes(length - 59).readUIntLE(0, length - 59);
      length += 1;
      if (n + length > size) throw new Unreadable('a compressed block is longer than it says');
      r.bytes(length).copy(out, n);
      n += length;
      continue;
    }
    if ((tag & 3) === 1) {
      length = ((tag >>> 2) & 7) + 4;
      offset = ((tag >>> 5) << 8) | r.byte();
    } else {
      length = (tag >>> 2) + 1;
      offset = (tag & 3) === 2 ? r.u16() : r.u32();
    }
    if (offset === 0 || offset > n || n + length > size) throw new Unreadable('a compressed block copies from outside itself');
    for (let i = 0; i < length; i++, n++) out[n] = out[n - offset]; // Byte by byte: copies may overlap.
  }
  if (n !== size) throw new Unreadable('a compressed block is shorter than it says');
  return out;
}

const BLOCK = 32768;
const HEADER = 7;
const FULL = 1;
const FIRST = 2;
const MIDDLE = 3;
const LAST = 4;

/**
 * The records of a log or manifest file. tail: whether an unfinished write was dropped from its
 * end. Only a record the file itself is too short for counts as that, or zeros to the end of the
 * file; a full-length record with a wrong checksum counts only when nothing but it follows.
 */
function logRecords(buf, what) {
  const records = [];
  let parts = null;
  let at = 0;
  const zeros = (from) => buf.subarray(from).every((b) => b === 0);
  while (at < buf.length) {
    const room = BLOCK - (at % BLOCK);
    if (room < HEADER) { // A block's last few bytes hold no record.
      at += room;
      continue;
    }
    if (buf.length - at < HEADER) return { records, tail: true };
    const length = buf.readUInt16LE(at + 4);
    const type = buf[at + 6];
    if (type === 0 && length === 0) {
      // Space reserved and never written to.
      if (zeros(at)) return { records, tail: parts != null };
      throw new Unreadable(`${what} has an empty record before its end`);
    }
    if (HEADER + length > room) throw new Unreadable(`${what} has a record that does not fit its block`);
    const end = at + HEADER + length;
    if (end > buf.length) return { records, tail: true };
    if (buf.readUInt32LE(at) !== masked(buf.subarray(at + 6, end))) {
      if (end === buf.length) return { records, tail: true };
      throw new Unreadable(`${what} has a damaged record`);
    }
    const data = buf.subarray(at + HEADER, end);
    if (type === FULL || type === FIRST) {
      if (parts) throw new Unreadable(`${what} has a record that never finished`);
      if (type === FULL) records.push(data);
      else parts = [data];
    } else if ((type === MIDDLE || type === LAST) && parts) {
      parts.push(data);
      if (type === LAST) {
        records.push(Buffer.concat(parts));
        parts = null;
      }
    } else {
      throw new Unreadable(`${what} has a record part out of place`);
    }
    at = end;
  }
  return { records, tail: parts != null };
}

const VALUE = 1;

function logEntries(buf, what) {
  const { records, tail } = logRecords(buf, what);
  const out = [];
  for (const record of records) {
    const r = reader(record, what);
    const first = r.u64();
    const count = r.u32();
    for (let i = 0; i < count; i++) {
      const type = r.byte();
      if (type > VALUE) throw new Unreadable(`${what} has an unknown kind of write`);
      const key = r.slice().toString('utf8');
      out.push({ seq: first + i, key, value: type === VALUE ? r.slice().toString('utf8') : null });
    }
    if (!r.done()) throw new Unreadable(`${what} has a write longer than it says`);
  }
  return { entries: out, tail };
}

function block(buf, offset, size, what) {
  if (offset + size + 5 > buf.length) throw new Unreadable(`${what} is cut short`);
  const raw = buf.subarray(offset, offset + size);
  if (buf.readUInt32LE(offset + size + 1) !== masked(buf.subarray(offset, offset + size + 1))) throw new Unreadable(`${what} has a damaged block`);
  const kind = buf[offset + size];
  if (kind === 0) return raw;
  if (kind === 1) return snappy(raw);
  throw new Unreadable(`${what} uses an unknown compression`);
}

function blockEntries(data, what) {
  if (data.length < 4) throw new Unreadable(`${what} has an empty block`);
  const restarts = data.readUInt32LE(data.length - 4);
  const end = data.length - 4 - restarts * 4;
  if (end < 0) throw new Unreadable(`${what} has a bad block`);
  const r = reader(data.subarray(0, end), what);
  const out = [];
  let key = Buffer.alloc(0);
  while (!r.done()) {
    const shared = r.varint();
    const own = r.varint();
    const size = r.varint();
    if (shared > key.length) throw new Unreadable(`${what} has a bad key`);
    key = Buffer.concat([key.subarray(0, shared), r.bytes(own)]);
    out.push([key, r.bytes(size)]);
  }
  return out;
}

const MAGIC = 0xdb4775248b80fb57n;

function tableEntries(buf, what) {
  if (buf.length < 48 || buf.readBigUInt64LE(buf.length - 8) !== MAGIC) throw new Unreadable(`${what} is not a whole table`);
  const footer = reader(buf.subarray(buf.length - 48), what);
  footer.varint();
  footer.varint();
  const index = blockEntries(block(buf, footer.varint(), footer.varint(), what), what);
  return index.flatMap(([, handle]) => {
    const h = reader(handle, what);
    return blockEntries(block(buf, h.varint(), h.varint(), what), what).map(([key, value]) => {
      if (key.length < 8) throw new Unreadable(`${what} has a bad key`);
      const trailer = key.readBigUInt64LE(key.length - 8);
      const type = Number(trailer & 255n);
      if (type > VALUE) throw new Unreadable(`${what} has an unknown kind of write`);
      return { seq: Number(trailer >> 8n), key: key.subarray(0, -8).toString('utf8'), value: type === VALUE ? value.toString('utf8') : null };
    });
  });
}

/** Which tables and logs are live, from the manifest's edits. */
function liveFiles(files) {
  const current = files.CURRENT?.toString('utf8').trim();
  const manifest = current && files[current];
  if (!manifest) throw new Unreadable('the manifest is missing');
  const { records, tail } = logRecords(manifest, 'the manifest');
  if (tail || !records.length) throw new Unreadable('the manifest is cut short');
  const tables = new Set();
  let log = null;
  let previousLog = 0;
  for (const record of records) {
    const r = reader(record, 'the manifest');
    while (!r.done()) {
      const tag = r.varint();
      if (tag === 1) r.slice(); // Comparator name.
      else if (tag === 2) log = r.varint();
      else if (tag === 3 || tag === 4) r.varint(); // Next file number, last sequence.
      else if (tag === 5) { // Compact pointer: level, key.
        r.varint();
        r.slice();
      } else if (tag === 6) {
        r.varint();
        tables.delete(r.varint());
      } else if (tag === 7) { // New file: level, number, size, smallest key, largest key.
        r.varint();
        tables.add(r.varint());
        r.varint();
        r.slice();
        r.slice();
      } else if (tag === 9) previousLog = r.varint();
      else throw new Unreadable('the manifest has an unknown entry');
    }
  }
  if (log == null) throw new Unreadable('the manifest names no log');
  return { tables, log, previousLog };
}

const numberOf = (name) => Number(name.split('.')[0]);

/**
 * files: file name to Buffer. values: each live key's newest value (removed keys are absent).
 * history: every write still stored, oldest first, value null for a removal. tailDropped: an
 * unfinished last write was left out, so the newest value may be one write old.
 */
export function readDb(files) {
  const live = liveFiles(files);
  const names = Object.keys(files);
  const tables = [...live.tables].map((n) => {
    const name = names.find((f) => f.endsWith('.ldb') && numberOf(f) === n);
    if (!name) throw new Unreadable(`table ${n} is missing`);
    return name;
  });
  const logs = names.filter((f) => f.endsWith('.log') && (numberOf(f) >= live.log || (live.previousLog && numberOf(f) === live.previousLog)))
    .sort((a, b) => numberOf(a) - numberOf(b));
  if (!logs.some((f) => numberOf(f) === live.log)) throw new Unreadable(`log ${live.log} is missing`);
  const writes = new Map(); // By sequence number: no write is listed twice.
  for (const name of tables) for (const e of tableEntries(files[name], name)) writes.set(e.seq, e);
  let tailDropped = false;
  for (const [i, name] of logs.entries()) {
    const { entries, tail } = logEntries(files[name], name);
    // Only the newest log can still be being written.
    if (tail && i < logs.length - 1) throw new Unreadable(`${name} is cut short`);
    tailDropped ||= tail;
    for (const e of entries) writes.set(e.seq, e);
  }
  const history = [...writes.values()].sort((a, b) => a.seq - b.seq);
  const values = new Map();
  for (const { key, value } of history) {
    if (value === null) values.delete(key);
    else values.set(key, value);
  }
  return { values, history, tailDropped };
}
