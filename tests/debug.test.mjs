import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { update } from '../extension/lib/tracker.js';
import { debugRows, debugStreams, debugBundle } from '../extension/lib/debug.js';

const T0 = Date.parse('2026-11-06T19:00:00Z');
const MIN = 60000;
const END = '2026-11-20T00:00:00Z';
const channel = { id: 'a', login: 'delta', displayName: 'Delta', live: true, campaigns: [{ id: 'c', name: 'c', benefitIds: [] }] };
const drop = (m) => ({ id: 'd', name: 'd', requiredMinutesWatched: 120, self: { currentMinutesWatched: m, isClaimed: false, hasPreconditionsMet: true } });
const session = (m) => ({ login: 'delta', displayName: 'Delta', dropId: 'd', minutes: m, required: 120 });

/** Real state from the real tracker: earning, then hung. */
function realState() {
  let s;
  [100, 101, 102, 102, 102, 102, 102, 102].forEach((m, i) => {
    s = update(s, {
      campaigns: [{ id: 'c', name: 'c', status: 'ACTIVE', endAt: END, timeBasedDrops: [drop(m)] }],
      rewards: { ids: [], complete: true },
      session: session(m),
      sessions: [session(m)],
      streams: [{ tabId: 7, login: 'delta', channel, tab: {}, player: { hasVideo: true, readyState: 4, currentTime: 100 + i * 60, hidden: true, muted: true } }],
    }, T0 + i * MIN);
  });
  return s;
}
const value = (rows, label) => rows.find((r) => r.label === label)?.value;

test('debug rows say what the tracker believes, read from real state', () => {
  const state = realState();
  const now = T0 + 7 * MIN + 5000;
  const rows = debugRows({
    state,
    version: '0.1.0',
    autoReload: { since: 1, tries: 2, lastAt: T0 + 6 * MIN },
    directory: { at: T0, campaigns: [{}, {}], error: { kind: 'timeout' } },
    minuteLog: [{}, {}, {}],
    hashes: { working: { Inventory: 'abcdef0123456789' }, learned: { Inventory: 'fedcba9876543210' } },
  }, now);
  assert.equal(value(rows, 'Version'), '0.1.0');
  assert.equal(value(rows, 'Verdict'), 'stalled, uncounted');
  assert.equal(value(rows, 'Last check'), '5s ago');
  assert.equal(value(rows, 'Last minute credited'), '5m ago');
  assert.equal(value(rows, 'Credited channel'), 'delta, 102 of 120 min');
  assert.equal(value(rows, 'Drops being earned'), '1');
  assert.equal(value(rows, 'Auto-reload this hang'), '2 tries, last 1m ago');
  assert.equal(value(rows, 'All Drops list'), '2 saved, 7m ago');
  assert.equal(value(rows, 'All Drops error'), 'timeout');
  assert.equal(value(rows, 'Minute log'), '3 minutes');
  assert.equal(value(rows, 'Inventory'), 'using abcdef01, page sent fedcba98');
});

test('debug rows survive having nothing yet, and damaged saved data', () => {
  for (const input of [{}, { state: null, hashes: null, directory: null, minuteLog: 'junk' }, { state: { verdict: null, drops: null } }]) {
    const rows = debugRows(input, T0);
    assert.equal(value(rows, 'Verdict'), 'none');
    assert.equal(value(rows, 'Last check'), 'never');
    assert.equal(value(rows, 'Minute log'), '0 minutes');
    assert.equal(value(rows, 'All Drops list'), 'not loaded');
  }
});

test('stream lines show channel and player state as last read', () => {
  const [line] = debugStreams(realState());
  assert.equal(line.name, 'Delta');
  assert.equal(line.line, 'eligible, playing, credited, background, muted');
  assert.deepEqual(debugStreams(null), []);
  assert.deepEqual(debugStreams({ streams: [{ tabId: 1 }] }), [{ id: 1, name: 'Twitch page', line: 'front' }]);
});

test('the copied bundle holds what is needed to diagnose a problem', () => {
  const state = realState();
  const log = [{ m: 1, d: 1 }];
  const bundle = debugBundle({ state, settings: { autoReload: true }, hashes: { working: { Inventory: 'x' }, learned: {} }, autoReload: { tries: 1 }, directory: { at: 5, campaigns: [{}, {}] }, minuteLog: log, version: '0.1.0' }, T0);
  assert.equal(bundle.state.verdict.code, 'stalled');
  assert.ok(bundle.state.timeline.length);
  assert.ok(bundle.state.streams.length);
  assert.deepEqual(bundle.minuteLog, log);
  assert.deepEqual(bundle.settings, { autoReload: true });
  assert.equal(bundle.version, '0.1.0');
  assert.equal(bundle.copiedAt, new Date(T0).toISOString());
  assert.deepEqual(bundle.directory, { at: 5, triedAt: null, error: null, campaigns: 2 });
});

test('a token placed anywhere in storage cannot reach the copied bundle', () => {
  const SECRET = 'abcdefghijklmnopqrstuvwxyz012345';
  const bundle = debugBundle({
    state: { ...realState(), authToken: SECRET, token: SECRET, cookie: SECRET },
    settings: {},
    hashes: { working: {}, learned: {}, token: SECRET },
    directory: { at: 1, campaigns: [], authToken: SECRET },
    autoToken: SECRET,
    cookies: SECRET,
  }, T0);
  assert.equal(JSON.stringify(bundle).includes(SECRET), false);
});

test('the bundle copes with an empty install', () => {
  const bundle = debugBundle({}, T0);
  assert.deepEqual(bundle.state, {});
  assert.deepEqual(bundle.minuteLog, []);
  assert.equal(bundle.directory, null);
});

test('the Debug tab module is web accessible, or the chat panel would not load', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url)));
  assert.ok(manifest.web_accessible_resources[0].resources.includes('lib/debug.js'));
});
