import test from 'node:test';
import assert from 'node:assert/strict';
import { update } from '../extension/lib/tracker.js';
import { logEntry, addMinute, compareMinutes, LOG_MAX, MIN_TO_COMPARE } from '../extension/lib/minutelog.js';

const T0 = Date.parse('2026-11-06T19:00:30Z');
const MIN = 60000;
const END = '2026-11-20T00:00:00Z';
const REWARDS = { ids: [], complete: true };
const drop = (m) => ({ id: 'd', name: 'd', requiredMinutesWatched: 240, self: { currentMinutesWatched: m, isClaimed: false, hasPreconditionsMet: true } });
const camp = (m) => [{ id: 'c', name: 'c', status: 'ACTIVE', endAt: END, timeBasedDrops: [drop(m)] }];
const earner = { id: 'a', login: 'a', displayName: 'A', live: true, campaigns: [{ id: 'c', name: 'c', benefitIds: [] }] };
const noDrops = { id: 'b', login: 'b', displayName: 'B', live: true, campaigns: [] };
const stream = (channel, tabId, i, player = {}, tab = {}) => ({
  tabId,
  login: channel.login,
  channel,
  tab: { discarded: false, frozen: false, active: false, tabMuted: false, ...tab },
  player: { hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: 100 + i * 60, hidden: true, playerMuted: false, volumeZero: false, videoHeight: 720, ad: false, ...player },
});

/** Runs real polls through the real tracker, returning the log as the background script builds it. */
function run(polls) {
  let s;
  let log = [];
  polls.forEach(({ obs, at }) => {
    const next = update(s, obs, at);
    log = addMinute(log, logEntry(s, obs, next, at));
    s = next;
  });
  return { s, log };
}
const good = (m, i, streams) => ({ obs: { campaigns: camp(m), rewards: REWARDS, session: null, sessions: [], streams }, at: T0 + i * MIN });

test('records the tab and player state of each watched minute, and what Twitch credited', () => {
  const { log } = run([
    good(100, 0, [stream(earner, 1, 0)]),
    good(101, 1, [stream(earner, 1, 1, { hidden: false, playerMuted: true, videoHeight: 360, ad: true }, { active: true, tabMuted: true }), stream(noDrops, 2, 1)]),
  ]);
  assert.equal(log.length, 2);
  const e = log[1];
  assert.deepEqual(
    [e.d, e.e, e.p, e.c, e.st, e.h, e.a, e.pm, e.tm, e.q, e.ad],
    [1, 1, 2, 'a', 'playing', 0, 1, 1, 1, 360, 1],
  );
  assert.equal(log[0].d, 0);
});

test('measures how fast the video really advanced', () => {
  const normal = run([good(100, 0, [stream(earner, 1, 0)]), good(101, 1, [stream(earner, 1, 1)])]).log[1];
  assert.equal(normal.s, 100);
  const slow = run([good(100, 0, [stream(earner, 1, 0, { currentTime: 100 })]), good(100, 1, [stream(earner, 1, 1, { currentTime: 118 })])]).log[1];
  assert.equal(slow.s, 30);
  assert.equal(run([good(100, 0, [stream(earner, 1, 0)])]).log[0].s, null, 'nothing to compare with yet');
});

test('a channel change in the tab is not read as playback speed', () => {
  const other = { ...earner, login: 'other', displayName: 'Other' };
  const { log } = run([good(100, 0, [stream(earner, 1, 0)]), good(101, 1, [stream(other, 1, 1, { currentTime: 5000 })])]);
  assert.equal(log[1].s, null);
});

test('minutes with nothing that can earn are not logged', () => {
  const { log } = run([good(100, 0, [stream(noDrops, 1, 0)]), good(100, 1, [])]);
  assert.deepEqual(log, []);
});

test('a failed poll is marked unknown, and is not counted as a lost minute', () => {
  const polls = [good(100, 0, [stream(earner, 1, 0)]), good(101, 1, [stream(earner, 1, 1)]), { obs: { error: { kind: 'network', message: 'x' } }, at: T0 + 2 * MIN }];
  const { log } = run(polls);
  assert.deepEqual(log[2], { m: Math.floor((T0 + 2 * MIN) / MIN), x: 1 });
  assert.equal(compareMinutes(log).total.watched, 2);
});

test('a failed poll when nothing was being tracked is not logged', () => {
  assert.deepEqual(run([{ obs: { error: { kind: 'network', message: 'x' } }, at: T0 }]).log, []);
});

test('a second poll in one minute replaces the first, keeping the gain and the speed reading', () => {
  const at0 = T0;
  const panelOpened = T0 + MIN + 2000;
  const { log } = run([
    good(100, 0, [stream(earner, 1, 0)]),
    good(101, 1, [stream(earner, 1, 1)]),
    { obs: { campaigns: camp(101), rewards: REWARDS, session: null, sessions: [], streams: [stream(earner, 1, 1, { currentTime: 162 })] }, at: panelOpened },
  ]);
  assert.equal(at0 < panelOpened, true);
  assert.equal(log.length, 2);
  assert.equal(log[1].d, 1, 'the gain earlier in this minute stays');
  assert.equal(log[1].s, 100, 'a reading too soon to judge keeps the last one');
});

test('a failed poll cannot wipe a minute already known', () => {
  const known = { m: 5, d: 1, e: 1, p: 1 };
  assert.deepEqual(addMinute([known], { m: 5, x: 1 }), [known]);
});

test('the log is bounded and copes with damaged saved data', () => {
  let log = [];
  for (let m = 0; m < LOG_MAX + 50; m++) log = addMinute(log, { m, d: 1, e: 1, p: 1 });
  assert.equal(log.length, LOG_MAX);
  assert.equal(log[0].m, 50);
  assert.deepEqual(addMinute('junk', { m: 1 }), [{ m: 1 }]);
  assert.equal(addMinute(null, null).length, 0);
  assert.equal(compareMinutes('junk').total.watched, 0);
  assert.equal(compareMinutes([null, {}, { x: 1 }]).total.watched, 0);
});

const minutes = (n, fields) => Array.from({ length: n }, (_, m) => ({ m, e: 1, p: 1, h: 0, pm: 0, v0: 0, tm: 0, q: 720, s: 100, ad: 0, d: 1, ...fields }));
const row = (cmp, label) => cmp.rows.find((r) => r.yesLabel === label);

test('compares credit on each side of a condition, and the biggest gap comes first', () => {
  const log = [
    ...minutes(20, { p: 1, d: 1 }),
    ...Array.from({ length: 20 }, (_, m) => ({ m: 100 + m, e: 1, p: 2, h: 0, pm: 0, v0: 0, tm: 0, q: 720, s: 100, ad: 0, d: m % 2 })),
  ];
  const cmp = compareMinutes(log);
  assert.deepEqual(cmp.total, { watched: 40, counted: 30, pct: 75 });
  const streams = cmp.rows[0];
  assert.equal(streams.yesLabel, 'Two or more streams playing');
  assert.deepEqual(streams.yes, { watched: 20, counted: 10, pct: 50 });
  assert.deepEqual(streams.no, { watched: 20, counted: 20, pct: 100 });
  assert.equal(streams.comparable, true);
  assert.equal(streams.gap, 50);
});

test('each condition sorts minutes onto the right side', () => {
  const cases = [
    ['Tab in background', { h: 1 }],
    ['Player muted', { pm: 1 }],
    ['Player muted', { v0: 1 }],
    ['Browser tab muted', { tm: 1 }],
    ['Below 480p', { q: 360 }],
    ['Player running slow', { s: 50 }],
    ['During an ad', { ad: 1 }],
  ];
  for (const [label, fields] of cases) {
    const cmp = compareMinutes([...minutes(MIN_TO_COMPARE, fields), ...minutes(MIN_TO_COMPARE, {})]);
    const r = row(cmp, label);
    assert.equal(r.yes.watched, MIN_TO_COMPARE, label);
    assert.equal(r.no.watched, MIN_TO_COMPARE, label);
  }
});

test('a condition with too few minutes on one side is not offered as comparable', () => {
  const cmp = compareMinutes([...minutes(MIN_TO_COMPARE - 1, { h: 1, d: 0 }), ...minutes(30, {})]);
  const r = row(cmp, 'Tab in background');
  assert.equal(r.comparable, false);
  assert.equal(r.gap, -1);
});

test('paused minutes are not lost minutes, and cannot be blamed on any condition', () => {
  // Delta, 2026-11-07: 52 paused minutes in the background, muted, made both read as a big loss.
  const log = [...minutes(20, { st: 'playing', h: 0, pm: 0 }), ...minutes(5, { st: 'playing', h: 1, pm: 1 }), ...minutes(30, { st: 'paused', h: 1, pm: 1, d: 0 })];
  const cmp = compareMinutes(log);
  assert.deepEqual(cmp.total, { watched: 25, counted: 25, pct: 100 });
  assert.equal(cmp.paused, 30);
  assert.deepEqual(row(cmp, 'Tab in background').yes, { watched: 5, counted: 5, pct: 100 });
  assert.deepEqual(row(cmp, 'Player muted').yes, { watched: 5, counted: 5, pct: 100 });
});

test('a player stuck or asleep still counts: only a pause is left out', () => {
  const log = ['frozen', 'asleep', 'ended', 'no_video'].flatMap((st) => minutes(2, { st, d: 0 }));
  const cmp = compareMinutes(log);
  assert.equal(cmp.total.watched, 8);
  assert.equal(cmp.paused, 0);
});

test('a paused player reaches the log as paused, through the real tracker', () => {
  const { log } = run([
    good(100, 0, [stream(earner, 1, 0)]),
    good(101, 1, [stream(earner, 1, 1)]),
    good(101, 2, [stream(earner, 1, 2, { paused: true, currentTime: 160 })]),
  ]);
  const cmp = compareMinutes(log);
  assert.equal(log[2].st, 'paused');
  assert.equal(cmp.total.watched, 2);
  assert.equal(cmp.paused, 1);
});

test('readings that were not available stay out of that comparison only', () => {
  const r = row(compareMinutes(minutes(10, { q: null, s: null })), 'Below 480p');
  assert.equal(r, undefined);
  assert.equal(compareMinutes(minutes(10, { q: null, s: null })).total.watched, 10);
});

test('a late batch counts in full, but a group cannot credit more than it watched', () => {
  const cmp = compareMinutes(minutes(3, { d: 5 }));
  assert.deepEqual(cmp.total, { watched: 3, counted: 3, pct: 100 });
  const late = compareMinutes([...minutes(4, { d: 0 }), ...minutes(1, { d: 4 })]);
  assert.deepEqual(late.total, { watched: 5, counted: 4, pct: 80 });
});
