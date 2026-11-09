// Minutes Twitch spends where they cannot help, and what My Drops lists meanwhile. Shaped on two
// debug bundles from 2026-11-09: Twitch kept crediting a channel badge already earned (362 and 363
// of 360) ahead of an open Marvel Rivals tab, then credited a World of Tanks drop needing 179
// minutes with about 95 left in its campaign. Through the real tracker, not hand-made state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { update } from '../extension/lib/tracker.js';
import { channelDrops, chipView } from '../extension/lib/chip.js';

const T0 = Date.parse('2026-11-09T14:00:00Z');
const MIN = 60000;
const LATER = '2026-11-20T00:00:00Z';
const REWARDS = { ids: [], complete: true };
const OWNED = { ids: ['loyalty-benefit'], complete: true }; // Twitch lists an earned badge as owned.
const player = (i) => ({ hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: 100 + i * 60 });
const watch = (id, minutes, required, endAt = LATER) => ({
  id, name: id, status: 'ACTIVE', endAt,
  timeBasedDrops: [{ id: `${id}-drop`, name: `${id} reward`, requiredMinutesWatched: required, endAt, self: { currentMinutesWatched: minutes, isClaimed: false, hasPreconditionsMet: true } }],
});
// A channel badge: never in Inventory, its minutes come only from the session.
const BADGE = { id: 'badge', name: 'Loyalty badge', channelOwned: true, endAt: LATER, benefitIds: ['loyalty-benefit'], watchDrops: [{ id: 'badge-drop', name: 'loyalty', required: 360 }] };
const chan = (login, campaigns) => ({
  id: login, login, displayName: login, live: true, campaigns,
  badges: campaigns.filter((c) => c.channelOwned).map((c) => ({ id: c.id, name: c.name, endAt: c.endAt, drops: c.watchDrops.map((d) => ({ ...d, subs: 0 })) })),
});
const stream = (channel, i, tabId) => ({ tabId, login: channel.login, channel, tab: {}, player: player(i) });
const session = (login, dropId, minutes, required) => ({ login, displayName: login, dropId, minutes, required });

function poll(s, i, { campaigns, channels, sessions, rewards = REWARDS }) {
  return update(s, { campaigns, rewards, session: sessions[0] ?? null, sessions, streams: channels.map((c, n) => stream(c, i, n + 1)) }, T0 + i * MIN);
}

// Golf-like: the badge earned at 360 and owned from then on, its session still rising past it;
// rivals open in another tab, not rising. As in the bundle: golf reads "finished", not eligible.
function badgeRun(withRivalsTab) {
  const golf = chan('golf', [BADGE]);
  const india = chan('india', [{ id: 'rivals' }]);
  let s;
  for (let i = 0; i < 5; i++) {
    const minutes = 358 + i;
    s = poll(s, i, {
      campaigns: [watch('rivals', 69, 360)],
      channels: withRivalsTab ? [golf, india] : [golf],
      sessions: [session('golf', 'badge-drop', minutes, 360)],
      rewards: minutes >= 360 ? OWNED : REWARDS,
    });
  }
  assert.equal(s.streams.find((st) => st.login === 'golf').channelState, 'finished');
  return s;
}

test('a badge already earned and still credited: My Drops does not borrow unrelated drops', () => {
  const s = badgeRun(false);
  assert.equal(s.verdict.code, 'earning');
  assert.equal(s.verdict.channel, 'golf');
  assert.deepEqual(channelDrops(s, 'golf'), { drops: [], from: null });
  assert.deepEqual(channelDrops(s, null), { drops: [], from: null });
});

test('a badge already earned and still credited is called out, naming the tab that could earn', () => {
  const s = badgeRun(true);
  assert.equal(s.verdict.code, 'earning');
  assert.equal(s.verdict.wasted?.reason, 'earned');
  assert.match(s.verdict.wasted.message, /loyalty/);
  assert.match(s.verdict.wasted.message, /already earned/);
  assert.match(s.verdict.wasted.message, /india can earn rivals/);
  assert.match(s.verdict.wasted.message, /close or pause golf/);
  const chip = chipView(s, T0 + 2 * MIN, 'golf');
  assert.equal(chip.tone, 'warn');
  assert.match(chip.title, /already earned/);
});

test('a badge already earned with nothing else open still says the minutes do nothing', () => {
  const s = badgeRun(false);
  assert.equal(s.verdict.wasted?.reason, 'earned');
  assert.doesNotMatch(s.verdict.wasted.message, /close or pause/);
});

test('a drop that cannot finish before its campaign ends is called out', () => {
  const ends = new Date(T0 + 95 * MIN).toISOString();
  const juliet = chan('juliet', [{ id: 'tanks' }]);
  const india = chan('india', [{ id: 'rivals' }]);
  let s;
  for (let i = 0; i < 3; i++) {
    s = poll(s, i, {
      campaigns: [watch('tanks', i, 180, ends), watch('rivals', 70, 360)],
      channels: [india, juliet],
      sessions: [session('juliet', 'tanks-drop', i, 180)],
    });
  }
  assert.equal(s.verdict.code, 'earning');
  assert.equal(s.verdict.channel, 'juliet');
  assert.equal(s.verdict.wasted?.reason, 'too_late');
  assert.match(s.verdict.wasted.message, /tanks reward cannot finish before its campaign ends/);
  assert.match(s.verdict.wasted.message, /india can earn rivals: close or pause juliet/);
});

test('ordinary earning is not called wasted', () => {
  const india = chan('india', [{ id: 'rivals' }]);
  let s;
  for (let i = 0; i < 3; i++) {
    s = poll(s, i, { campaigns: [watch('rivals', 70 + i, 360)], channels: [india], sessions: [session('india', 'rivals-drop', 70 + i, 360)] });
  }
  assert.equal(s.verdict.code, 'earning');
  assert.equal(s.verdict.wasted, null);
  assert.equal(chipView(s, T0 + 2 * MIN, 'india').tone, 'ok');
});

test('credited outside this browser: nothing to close here, so no call to action', () => {
  // The session names a channel with no tab here. Its drop is earned, but there is nothing to close.
  const india = chan('india', [{ id: 'rivals' }]);
  let s;
  for (let i = 0; i < 3; i++) {
    s = poll(s, i, { campaigns: [watch('rivals', 70 + i, 360)], channels: [india], sessions: [session('elsewhere', 'gone-drop', 400 + i, 360)] });
  }
  assert.equal(s.verdict.wasted ?? null, null);
});
