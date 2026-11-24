import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDb, snappy, crc32c, Unreadable } from '../scripts/leveldb.mjs';

// Written by a real browser (scripts/make-storage-fixture.mjs), so the reader is checked against
// Chromium's own files.
const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'extension-storage');
const files = () => Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f))]));
const nameOf = (fs, end) => Object.keys(fs).find((f) => f.endsWith(end));
const json = (db, key) => JSON.parse(db.values.get(key));

test('real files: the newest value of every key, from table and log together', () => {
  const db = readDb(files());
  assert.deepEqual(json(db, 'unchanged'), { text: 'still here', accents: 'é 한글' });
  assert.deepEqual(json(db, 'state'), { n: 102, pad: '' });
  const many = json(db, 'many');
  assert.equal(many.length, 400);
  assert.deepEqual(many[399], { m: 1399, c: 'alphatv', d: 1, note: 'row 399 of 400' });
  assert.equal(json(db, 'long').split(',').length, 9000); // Split over two log blocks.
  assert.deepEqual([...db.values.keys()].sort(), ['long', 'many', 'state', 'unchanged']); // The removed ones are gone.
});

test('real files: older values are kept in the order they were written, removals too', () => {
  const db = readDb(files());
  const state = db.history.filter((h) => h.key === 'state').map((h) => JSON.parse(h.value).n);
  assert.deepEqual(state, [1, 100, 101, 102]);
  assert.equal(db.history.filter((h) => h.key === 'gone').at(-1).value, null);
  const seqs = db.history.map((h) => h.seq);
  assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
});

test('a log cut short while the browser writes loses only its last write, and says so', () => {
  const fs = files();
  const log = nameOf(fs, '.log');
  assert.equal(readDb(fs).tailDropped, false);
  fs[log] = fs[log].subarray(0, fs[log].length - 3);
  const db = readDb(fs);
  assert.equal(db.tailDropped, true);
  assert.equal(db.values.has('gone'), true); // Its removal was the last write.
  assert.deepEqual(json(db, 'state'), { n: 102, pad: '' });
});

test('every possible cut of the log reads as a shorter history or unreadable, never as wrong values', () => {
  const full = readDb(files()).history;
  const log = nameOf(files(), '.log');
  const size = files()[log].length;
  for (let cut = 0; cut < size; cut += 911) {
    const fs = files();
    fs[log] = fs[log].subarray(0, cut);
    const got = readDb(fs).history;
    assert.deepEqual(got, full.slice(0, got.length));
  }
});

test('zeros after the last record (space reserved by the writer) are an ordinary end', () => {
  const fs = files();
  const log = nameOf(fs, '.log');
  fs[log] = Buffer.concat([fs[log], Buffer.alloc(500)]);
  assert.deepEqual(json(readDb(fs), 'state'), { n: 102, pad: '' });
});

test('a damaged record before the end is unreadable, never skipped', () => {
  const fs = files();
  const log = nameOf(fs, '.log');
  fs[log][40] ^= 0xff;
  assert.throws(() => readDb(fs), Unreadable);
});

test('a damaged table is unreadable', () => {
  const at = (n) => () => {
    const fs = files();
    const t = nameOf(fs, '.ldb');
    fs[t][n < 0 ? fs[t].length + n : n] ^= 0xff;
    readDb(fs);
  };
  assert.throws(at(100), Unreadable); // A data block: caught by its checksum.
  assert.throws(at(-1), Unreadable); // The magic number.
});

test('a table or log the manifest names but the copy lacks is unreadable', () => {
  for (const end of ['.ldb', '.log', 'CURRENT']) {
    const fs = files();
    delete fs[nameOf(fs, end)];
    assert.throws(() => readDb(fs), Unreadable, end);
  }
  assert.throws(() => readDb({}), Unreadable);
  const fs = files();
  delete fs[Object.keys(fs).find((f) => f.startsWith('MANIFEST'))];
  assert.throws(() => readDb(fs), Unreadable);
});

test('a leftover table the manifest no longer names is not read', () => {
  const fs = files();
  fs['000002.ldb'] = Buffer.from('left over, not a table');
  assert.deepEqual(json(readDb(fs), 'state'), { n: 102, pad: '' });
});

test('crc32c matches its published check value', () => {
  assert.equal(crc32c(Buffer.from('123456789')), 0xe3069283);
});

test('snappy: the format description\'s own forms', () => {
  const bytes = (...b) => Buffer.from(b);
  assert.equal(snappy(bytes(3, 0x08, 97, 98, 99)).toString(), 'abc'); // A literal.
  // "Literal 'ab', then a copy of offset 2": overlapping, so it repeats the pattern.
  assert.equal(snappy(bytes(8, 0x04, 97, 98, 0x16, 2, 0)).toString(), 'abababab');
  assert.equal(snappy(bytes(6, 0x04, 97, 98, 0x01, 2)).toString(), 'ababab'); // One-byte offset.
  assert.equal(snappy(bytes(5, 0x00, 97, 0x0f, 1, 0, 0, 0)).toString(), 'aaaaa'); // Four-byte offset.
  assert.throws(() => snappy(bytes(9, 0x04, 97, 98, 0x16, 2, 0)), Unreadable); // Shorter than it says.
  assert.throws(() => snappy(bytes(8, 0x04, 97, 98, 0x16, 3, 0)), Unreadable); // Copies from before the start.
});
