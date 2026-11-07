// When a hang starts counting. A tab that could not earn for a while has not been hanging all that
// time. Real case, 2026-11-07: Delta paused 23:33 to 00:19, then reloaded 2s after it resumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { update } from '../extension/lib/tracker.js';
import { autoReloadStep, normalize } from '../extension/lib/settings.js';

const T0 = Date.parse('2026-11-06T23:00:30Z');
const MIN = 60000;
const END = '2026-11-20T00:00:00Z';
const REWARDS = { ids: [], complete: true };
const SETTINGS = normalize({ autoReload: true });
const camp = (m) => [{
  id: 'c', name: 'c', status: 'ACTIVE', endAt: END,
  timeBasedDrops: [{ id: 'd', name: 'd', requiredMinutesWatched: 480, self: { currentMinutesWatched: m, isClaimed: false, hasPreconditionsMet: true } }],
}];
const chan = (login, over = {}) => ({ id: login, login, displayName: login, live: true, campaigns: [{ id: 'c', name: 'c', benefitIds: [] }], ...over });
const tab = (channel, i, tabId = 1, player = {}) => ({
  tabId,
  login: channel.login,
  channel,
  tab: {},
  player: { hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: 100 + i * 60, ...player },
});
const paused = { paused: true, currentTime: 100 };

/** Feeds polls through the real tracker and the real auto-reload step, noting each reload. */
function driver() {
  let s;
  let memo = null;
  const reloads = [];
  return {
    poll(i, minutes, streams) {
      const at = T0 + i * MIN;
      s = update(s, { campaigns: camp(minutes), rewards: REWARDS, session: null, sessions: [], streams }, at);
      const step = autoReloadStep(memo, s, SETTINGS, at);
      memo = step.memo;
      if (step.tabId != null) reloads.push(i);
      return s;
    },
    reloads,
  };
}

test('a tab back from a long pause is not hung, and is not reloaded', () => {
  const d = driver();
  for (let i = 0; i <= 5; i++) d.poll(i, 100 + i, [tab(chan('delta'), i)]);
  let s;
  for (let i = 6; i <= 51; i++) s = d.poll(i, 105, [tab(chan('delta'), i, 1, paused)]);
  assert.equal(s.verdict.code, 'stalled');
  assert.equal(s.verdict.cause, 'paused');
  assert.deepEqual(d.reloads, [], 'a reload cannot fix a pause');
  s = d.poll(52, 105, [tab(chan('delta'), 52)]);
  assert.equal(s.verdict.code, 'waiting', JSON.stringify(s.verdict));
  assert.deepEqual(d.reloads, []);
});

test('credit coming back after a pause never reloads', () => {
  const d = driver();
  for (let i = 0; i <= 5; i++) d.poll(i, 100 + i, [tab(chan('delta'), i)]);
  for (let i = 6; i <= 51; i++) d.poll(i, 105, [tab(chan('delta'), i, 1, paused)]);
  let s;
  d.poll(52, 105, [tab(chan('delta'), 52)]);
  for (let i = 53; i <= 60; i++) s = d.poll(i, 106 + (i - 53), [tab(chan('delta'), i)]);
  assert.equal(s.verdict.code, 'earning');
  assert.deepEqual(d.reloads, []);
});

test('flat after a pause is a real hang, timed from the resume', () => {
  const d = driver();
  for (let i = 0; i <= 5; i++) d.poll(i, 100 + i, [tab(chan('delta'), i)]);
  for (let i = 6; i <= 51; i++) d.poll(i, 105, [tab(chan('delta'), i, 1, paused)]);
  let s;
  for (let i = 52; i <= 55; i++) {
    s = d.poll(i, 105, [tab(chan('delta'), i)]);
    assert.equal(s.verdict.code, 'waiting', `minute ${i}`);
  }
  s = d.poll(56, 105, [tab(chan('delta'), 56)]);
  assert.equal(s.verdict.code, 'stalled');
  assert.equal(s.verdict.cause, 'uncounted');
  assert.equal(s.verdict.since, T0 + 52 * MIN);
  for (let i = 57; i <= 58; i++) d.poll(i, 105, [tab(chan('delta'), i)]);
  assert.deepEqual(d.reloads, [58], 'six minutes after the resume');
});

test('a channel back from offline is not hung, and is not reloaded', () => {
  const d = driver();
  for (let i = 0; i <= 5; i++) d.poll(i, 100 + i, [tab(chan('delta'), i)]);
  for (let i = 6; i <= 95; i++) d.poll(i, 105, [tab(chan('delta', { live: false, campaigns: [] }), i)]);
  const s = d.poll(96, 105, [tab(chan('delta'), 96)]);
  assert.equal(s.verdict.code, 'waiting', JSON.stringify(s.verdict));
  assert.deepEqual(d.reloads, []);
});

test('a hang with no pause still reloads six minutes after the last credit', () => {
  const d = driver();
  for (let i = 0; i <= 5; i++) d.poll(i, 100 + i, [tab(chan('delta'), i)]);
  for (let i = 6; i <= 11; i++) d.poll(i, 105, [tab(chan('delta'), i)]);
  assert.deepEqual(d.reloads, [11]);
});

test('one failed channel lookup does not restart a hang', () => {
  const d = driver();
  for (let i = 0; i <= 5; i++) d.poll(i, 100 + i, [tab(chan('delta'), i)]);
  let s;
  for (let i = 6; i <= 9; i++) s = d.poll(i, 105, [tab(chan('delta'), i)]);
  const since = s.verdict.since;
  assert.equal(s.verdict.code, 'stalled');
  d.poll(10, 105, [tab({ login: 'delta', unknown: true }, 10)]);
  s = d.poll(11, 105, [tab(chan('delta'), 11)]);
  assert.equal(s.verdict.code, 'stalled', JSON.stringify(s.verdict));
  assert.equal(s.verdict.since, since);
});

test('resuming a second tab does not restart the hang on the first', () => {
  const d = driver();
  const both = (i, second = {}) => [tab(chan('delta'), i, 1), tab(chan('other'), i, 2, second)];
  for (let i = 0; i <= 5; i++) d.poll(i, 100 + i, both(i, paused));
  let s;
  for (let i = 6; i <= 9; i++) s = d.poll(i, 105, both(i, paused));
  const since = s.verdict.since;
  assert.equal(s.verdict.code, 'stalled');
  s = d.poll(10, 105, both(10));
  assert.equal(s.verdict.code, 'stalled', JSON.stringify(s.verdict));
  assert.equal(s.verdict.since, since);
});
