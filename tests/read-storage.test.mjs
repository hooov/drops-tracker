import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackedId, creditedRuns, channelTotals, ownedText, streamLines, compareBundle, readStorage, pollList, report } from '../scripts/read-storage.mjs';
import { Unreadable } from '../scripts/leveldb.mjs';
import { LOG_MAX } from '../extension/lib/minutelog.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'extension-storage');
const row = (m, over = {}) => ({ m, d: 1, e: 1, p: 1, c: 'alphatv', cr: 1, st: 'playing', ...over });
const rows = (from, n, over = {}) => Array.from({ length: n }, (_, i) => row(from + i, over));
const at = (m) => m * 60000;

test('the extension ID of an unpacked folder is the hash of its path', () => {
  // The ID Brave gave an extension loaded from that folder (throwaway profile, 2026-11-23).
  assert.equal(unpackedId('C:\\Users\\Public\\drops-id-test', 'win32'), 'bmmjpfanioblfkeneihmbclcpobgpnnm');
  assert.match(unpackedId('/home/me/ext', 'linux'), /^[a-p]{32}$/);
});

test('a run is unbroken minutes credited on one channel', () => {
  const [r, ...none] = creditedRuns([...rows(100, 10), ...rows(110, 5, { d: 0 }), ...rows(115, 10)], null);
  assert.equal(none.length, 0);
  assert.deepEqual([r.channel, r.from, r.to, r.minutes, r.rows, r.credited, r.longestFlat], ['alphatv', 100, 124, 25, 25, 20, 5]);
});

test('another channel, an uncredited minute or a reward reading ends a run', () => {
  const froms = (list) => creditedRuns(list, null).map((r) => [r.channel, r.from, r.to, r.reward]);
  assert.deepEqual(froms([...rows(100, 3), ...rows(103, 2, { c: 'bravo' }), ...rows(105, 2)]), [['alphatv', 100, 102, false], ['bravo', 103, 104, false], ['alphatv', 105, 106, false]]);
  assert.deepEqual(froms([...rows(100, 3), row(103, { cr: 0 }), ...rows(104, 2)]), [['alphatv', 100, 102, false], ['alphatv', 104, 105, false]]);
  assert.deepEqual(froms([...rows(100, 3), ...rows(103, 2, { rw: 1 })]), [['alphatv', 100, 102, false], ['alphatv', 103, 104, true]]);
});

test('one unknown minute (no row, or a failed check) stays in the run and in its length; two end it', () => {
  const missing = creditedRuns([...rows(100, 3), ...rows(104, 3)], null);
  assert.deepEqual(missing.map((r) => [r.minutes, r.rows, r.unknown]), [[7, 6, 1]]);
  const failed = creditedRuns([...rows(100, 3), { m: 103, x: 1 }, ...rows(104, 3)], null);
  assert.deepEqual(failed.map((r) => [r.minutes, r.rows, r.unknown]), [[7, 6, 1]]);
  assert.equal(creditedRuns([...rows(100, 3), { m: 103, x: 1 }, { m: 104, x: 1 }, ...rows(105, 3)], null).length, 2);
  assert.equal(creditedRuns([...rows(100, 3), ...rows(105, 3)], null).length, 2);
});

test('minutes credited two at once are counted in full, and the flat minute before them is seen', () => {
  const [r] = creditedRuns([row(100), row(101, { d: 0 }), row(102, { d: 2 })], null);
  assert.deepEqual([r.credited, r.longestFlat], [3, 1]);
});

test('a run is split where the page hook went live', () => {
  const runs = creditedRuns(rows(100, 40), at(115));
  assert.deepEqual(runs.map((r) => [r.from, r.to, r.hook]), [[100, 114, false], [115, 139, true]]);
});

test('only 20 or more single-stream minutes with the hook live, all playing, not a reward reading, count', () => {
  const why = (list, since = at(100)) => creditedRuns(list, since)[0].notCounted;
  assert.deepEqual(why(rows(100, 20)), []);
  assert.deepEqual(why(rows(100, 19)), ['under 20 minutes']);
  assert.deepEqual(why(rows(100, 25), at(500)), ['before the hook']);
  assert.deepEqual(why(rows(100, 25), null), ['no --hook-since given']);
  assert.deepEqual(why([...rows(100, 24), row(124, { p: 2 })]), ['2 streams playing']);
  assert.deepEqual(why([...rows(100, 24), row(124, { st: 'paused' })]), ['not playing for 1 of 25']);
  assert.deepEqual(why(rows(100, 25, { rw: 1 })), ['reward reading']);
});

test('per-channel totals over every credited row', () => {
  const list = [...rows(100, 4), row(104, { d: 0 }), row(200, { d: 0 }), ...rows(300, 2, { c: 'bravo', rw: 1 }), row(400, { cr: 0 })];
  assert.deepEqual(channelTotals(list), [
    { channel: 'alphatv', rows: 6, credited: 4, longestFlat: 2, reward: 0 },
    { channel: 'bravo', rows: 2, credited: 2, longestFlat: 0, reward: 2 },
  ]);
});

test('no minute log and an empty one are different answers', () => {
  const said = (minuteLog) => report({ state: {}, minuteLog, dayRewards: [] }, {});
  assert.match(said(undefined), /minute log: not stored/i);
  assert.match(said([]), /minute log: 0 rows/i);
});

test('owned reward IDs: none stored is not the same as none owned', () => {
  assert.deepEqual(ownedText({ rewards: { ids: ['r1', 'r2'] } }), ['2 owned reward IDs', '  r1', '  r2']);
  assert.match(ownedText({ rewards: { ids: [] } })[0], /^0 owned reward IDs.*not a proof/);
  assert.match(ownedText({})[0], /not stored/);
  assert.match(ownedText({ rewards: { ids: null } })[0], /not stored/);
});

test('finished reward groups as the channel page gave them', () => {
  const said = (claimedGroups) => report({ state: {}, minuteLog: [], dayRewards: [], claimedGroups }, {});
  assert.match(said([{ campaignId: 'c', groupId: 'g', endAt: 1, at: 0 }]), /1 finished reward group\n  c\/g \(stored 1970-01-01T00:00:00Z\)/);
  assert.match(said([]), /0 finished reward groups/);
  assert.match(said(undefined), /Finished reward groups: not stored/);
});

test('each stream with its state', () => {
  const state = { streams: [
    { login: 'alphatv', channelState: 'eligible', playerState: 'playing', credited: true, hidden: false },
    { login: 'bravo', channelState: 'unstarted', playerState: 'playing', hidden: true, listedState: 'no_drops', campaignIds: ['c1'] },
  ] };
  assert.deepEqual(streamLines(state), [
    'alphatv: eligible, playing, credited, front, campaigns none',
    'bravo: unstarted (lists: no_drops), playing, background, campaigns c1',
  ]);
});

const bundleOf = () => ({
  version: '0.1.16',
  state: { lastPollAt: 5000, streams: [{ login: 'alphatv', channelState: 'eligible' }], lastGainAt: 4000 },
  minuteLog: [...rows(100, 3)],
  dayRewards: [{ groupId: 'g', days: [] }],
});
const historyOf = (b) => [
  { seq: 1, key: 'state', value: JSON.stringify({ lastPollAt: 1000 }) },
  { seq: 2, key: 'dayRewards', value: JSON.stringify(b.dayRewards) },
  { seq: 3, key: 'state', value: JSON.stringify({ ...b.state, rewards: { ids: ['r'] } }) },
  { seq: 4, key: 'minuteLog', value: JSON.stringify([...b.minuteLog, row(103)]) },
];

test('a bundle that says what storage says matches', () => {
  const c = compareBundle(historyOf(bundleOf()), bundleOf());
  assert.equal(c.match, true);
  assert.deepEqual(c.lines, ['state at the bundle\'s check: 3 of 3 fields the same', 'minute log: 3 of 3 rows the same', 'dayRewards: the same']);
});

test('any difference from the bundle is a mismatch', () => {
  const differs = (change) => {
    const b = bundleOf();
    const h = historyOf(b);
    change(b);
    return compareBundle(h, b).match;
  };
  assert.equal(differs((b) => { b.state.streams[0].channelState = 'unstarted'; }), false);
  assert.equal(differs((b) => { b.minuteLog[1].d = 0; }), false);
  assert.equal(differs((b) => { b.minuteLog.unshift(row(50)); }), false);
  assert.equal(differs((b) => { b.dayRewards = []; }), false);
});

test('nothing to compare is not a match', () => {
  const b = bundleOf();
  const gone = compareBundle(historyOf(b).filter((h) => h.key !== 'state'), b);
  assert.equal(gone.match, null);
  assert.match(gone.lines[0], /no longer stored/);
  // A later answer has replaced the bundle's day rewards too, so a different one there proves nothing.
  const later = compareBundle([{ seq: 2, key: 'dayRewards', value: '[]' }, ...historyOf(b).filter((h) => h.key === 'minuteLog')], b);
  assert.equal(later.match, null);
  assert.match(later.lines[2], /no longer stored/);
  assert.equal(compareBundle(historyOf(b), { ...b, minuteLog: [] }).match, null);
});

test('a later check in the bundle\'s newest minute replaced that row, which is no difference', () => {
  // Seen 2026-11-23: 313 of 314 rows the same, the 314th being the minute the bundle was copied in.
  const b = bundleOf();
  const h = historyOf(b);
  b.minuteLog[2].s = 50;
  const c = compareBundle(h, b);
  assert.equal(c.match, true);
  assert.equal(c.lines[1], 'minute log: 2 of 2 rows the same (its newest minute was still being written, not compared)');
  // Missing altogether is a difference: a minute's row is replaced, never removed.
  const lost = bundleOf();
  const without = historyOf(lost);
  without[3].value = JSON.stringify(lost.minuteLog.slice(0, 2));
  assert.equal(compareBundle(without, lost).match, false);
});

test('rows the full log has dropped since are left out, and said so', () => {
  const b = bundleOf();
  const h = historyOf(b);
  h.push({ seq: 5, key: 'minuteLog', value: JSON.stringify(rows(102, LOG_MAX)) });
  const c = compareBundle(h, b);
  assert.equal(c.match, true); // The older stored log still holds them.
  const only = compareBundle(h.filter((x) => x.seq !== 4), b);
  assert.equal(only.match, true);
  assert.equal(only.lines[1], 'minute log: 1 of 1 rows the same (2 older ones no longer stored)');
});

test('every check still stored, with what each channel read and how many rewards were known', () => {
  const list = pollList([
    { seq: 1, key: 'state', value: JSON.stringify({ lastPollAt: 0, rewards: { ids: ['a'] }, streams: [{ login: 'alphatv', channelState: 'unstarted' }] }) },
    { seq: 2, key: 'minuteLog', value: '[]' },
    { seq: 3, key: 'state', value: JSON.stringify({ lastPollAt: 60000, streams: [] }) },
  ]);
  assert.deepEqual(list, ['1970-01-01T00:00:00Z owned 1 | alphatv:unstarted', '1970-01-01T00:01:00Z owned not stored | no streams']);
});

const copies = () => readdirSync(tmpdir()).filter((f) => f.startsWith('drops-storage-'));
const inTemp = async (run) => {
  const dir = mkdtempSync(join(tmpdir(), 'dropstest-'));
  try { return await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('reading changes nothing in the source and leaves no copy behind', () => inTemp((dir) => {
  const src = join(dir, 'store');
  cpSync(fixture, src, { recursive: true });
  writeFileSync(join(src, 'LOCK'), '');
  const look = () => readdirSync(src).map((f) => [f, statSync(join(src, f)).mtimeMs, readFileSync(join(src, f)).toString('base64')]);
  const before = look();
  const had = copies();
  const db = readStorage(src);
  assert.equal(JSON.parse(db.values.get('state')).n, 102);
  assert.deepEqual(look(), before);
  assert.deepEqual(copies(), had);
}));

test('unreadable storage is an error, never an empty result, and its copy is deleted too', () => inTemp((dir) => {
  const src = join(dir, 'store');
  cpSync(fixture, src, { recursive: true });
  const t = readdirSync(src).find((f) => f.endsWith('.ldb'));
  writeFileSync(join(src, t), readFileSync(join(src, t)).subarray(0, 1000));
  const had = copies();
  assert.throws(() => readStorage(src), Unreadable);
  assert.deepEqual(copies(), had);
  assert.throws(() => readStorage(join(dir, 'absent')), Unreadable);
  assert.equal(existsSync(join(dir, 'absent')), false);
}));

test('a stored value that is not JSON is unreadable, not missing', () => {
  assert.throws(() => pollList([{ seq: 1, key: 'state', value: '{"lastPollAt":' }]), Unreadable);
});
