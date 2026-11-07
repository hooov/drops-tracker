// Which drops show on a channel, through the real tracker rather than hand-made state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { update } from '../extension/lib/tracker.js';
import { channelDrops, chipView } from '../extension/lib/chip.js';

const T0 = Date.parse('2026-11-07T01:00:00Z');
const END = '2026-11-08T20:29:59Z';
const MIN = 60000;
const REWARDS = { ids: [], complete: true };
const player = (i) => ({ hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: 100 + i * 60 });
const camp = (id, minutes, required = 240) => ({
  id,
  name: id,
  status: 'ACTIVE',
  endAt: END,
  timeBasedDrops: [{ id: `${id}-drop`, name: `${id} reward`, requiredMinutesWatched: required, self: { currentMinutesWatched: minutes, isClaimed: false, hasPreconditionsMet: true } }],
});
const chan = (login, ...campaigns) => ({ id: login, login, displayName: login, live: true, campaigns: campaigns.map((id) => ({ id })) });
const stream = (channel, i, tabId) => ({ tabId, login: channel.login, channel, tab: {}, player: player(i) });
const poll = (s, campaigns, channels, i) => update(
  s,
  { campaigns, rewards: REWARDS, session: null, sessions: [], streams: channels.map((c, n) => stream(c, i, n + 1)) },
  T0 + i * MIN,
);
const names = (r) => r.drops.map((d) => d.campaignId);

test('a channel lists only the drops it can earn', () => {
  const s = poll(undefined, [camp('exile', 175), camp('rivals', 30)], [chan('delta', 'exile')], 0);
  assert.deepEqual(names(channelDrops(s, 'delta')), ['exile']);
});

test('on a channel with no drops, with nothing else open that can earn, nothing is listed', () => {
  // The reported case: echo_247 and FOXTROT open, ExileCon at 175 of 240 and earnable elsewhere.
  const s = poll(undefined, [camp('exile', 175)], [chan('echo_247'), chan('foxtrot')], 0);
  assert.equal(s.verdict.code, 'idle');
  assert.deepEqual(channelDrops(s, 'echo_247'), { drops: [], from: null });
  assert.deepEqual(channelDrops(s, 'foxtrot'), { drops: [], from: null });
  assert.deepEqual(channelDrops(s, null), { drops: [], from: null });
});

test('the chip does not show a percentage this channel cannot move', () => {
  const s = poll(undefined, [camp('exile', 175)], [chan('foxtrot')], 0);
  const v = chipView(s, T0, 'foxtrot');
  assert.equal(v.pct, null);
  assert.equal(v.text, 'Drops');
});

test('watching one channel while another open tab can earn shows that tab, and says so', () => {
  const channels = [chan('echo_247'), chan('delta', 'exile')];
  const s = poll(undefined, [camp('exile', 175), camp('rivals', 30)], channels, 0);
  const r = channelDrops(s, 'echo_247');
  assert.deepEqual(names(r), ['exile']);
  assert.equal(r.from, 'delta');
  assert.equal(chipView(s, T0, 'echo_247').pct, 72);
});

test('the channel being looked at wins over another tab that can earn', () => {
  const channels = [chan('delta', 'exile'), chan('riv', 'rivals')];
  const s = poll(undefined, [camp('exile', 175), camp('rivals', 30)], channels, 0);
  const r = channelDrops(s, 'riv');
  assert.deepEqual(names(r), ['rivals']);
  assert.equal(r.from, null);
});

test('with no channel in view, every open tab that can earn', () => {
  const channels = [chan('delta', 'exile'), chan('riv', 'rivals'), chan('echo_247')];
  const s = poll(undefined, [camp('exile', 175), camp('rivals', 30), camp('unwatched', 5)], channels, 0);
  const r = channelDrops(s, null);
  assert.deepEqual(names(r).sort(), ['exile', 'rivals']);
  assert.equal(r.from, null, 'two channels cannot be named as one');
});

test('a lookup that failed is unknown, so it hides nothing', () => {
  const s = poll(undefined, [camp('exile', 175)], [{ login: 'delta', unknown: true }], 0);
  assert.equal(s.streams[0].channelState, 'unknown');
  assert.deepEqual(names(channelDrops(s, 'delta')), ['exile']);
});

test('minutes rising from outside this browser still show what is rising', () => {
  let s = poll(undefined, [camp('exile', 175)], [chan('foxtrot')], 0);
  s = poll(s, [camp('exile', 176)], [chan('foxtrot')], 1);
  assert.equal(s.verdict.code, 'earning');
  assert.deepEqual(names(channelDrops(s, 'foxtrot')), ['exile']);
});

test('state saved before streams recorded campaigns shows everything until the next poll', () => {
  const s = { active: [{ campaignId: 'exile' }], streams: [{ login: 'delta', channelState: 'eligible' }], verdict: { code: 'idle' } };
  assert.deepEqual(names(channelDrops(s, 'delta')), ['exile']);
  assert.deepEqual(names(channelDrops({ active: [{ campaignId: 'exile' }], verdict: { code: 'idle' } }, 'delta')), ['exile']);
});

test('a claim waiting on a channel with no drops reads as Claim, not a borrowed percentage', () => {
  const s = poll(undefined, [camp('exile', 175)], [chan('foxtrot')], 0);
  s.unclaimed = [{ name: 'Reward', campaignActive: true }];
  const v = chipView(s, T0, 'foxtrot');
  assert.equal(v.text, 'Claim');
});

test('a hang keeps its drop on the channel that hung', () => {
  let s;
  for (let i = 0; i <= 12; i++) s = poll(s, [camp('exile', 119, 120)], [chan('delta', 'exile')], i);
  assert.equal(s.verdict.code, 'stalled');
  assert.deepEqual(names(channelDrops(s, 'delta')), ['exile']);
  assert.match(chipView(s, T0 + 12 * MIN, 'delta').text, /^Hung/);
  assert.equal(chipView(s, T0 + 12 * MIN, 'delta').pct, 99);
});
