// Twitch's reward inventory (ViewerRewardDropInventory), from the answer its Inventory page got on
// 2026-11-19. It is the only source of a repeating reward drop's 24-hour window, and of a channel
// badge's minutes when the session is silent. Its readings are shown and never judged: on
// 2026-11-18 the tracker saw about 15 of the 250 minutes Twitch counted on that campaign, and
// called a hang while it counted. Through the real parser and the real tracker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchSnapshot, parseRewardInventory } from '../extension/lib/twitch.js';
import { update, warning, badge, REWARD_HOLD_MS } from '../extension/lib/tracker.js';
import { channelDrops } from '../extension/lib/chip.js';
import { verdictText } from '../extension/lib/panel.js';
import { logEntry, compareMinutes } from '../extension/lib/minutelog.js';

const inv = JSON.parse(readFileSync(new URL('./fixtures/reward-inventory-2026-11-19.json', import.meta.url))).answer;
const reward = JSON.parse(readFileSync(new URL('./fixtures/reward-campaign-2026-11-19.json', import.meta.url))).channel;
const badgeFx = JSON.parse(readFileSync(new URL('./fixtures/badge-2026-11-06.json', import.meta.url)));
const MIN = 60000;
const DVD = '2283245e-d15c-11f1-8cdd-0a58a9feac02';
const BADGE_DROP = '692c7608-d659-11f1-9553-0a58a9feac02';
const WINDOW_END = Date.parse('2026-11-19T11:17:18Z');
const json = (body) => ({ status: 200, ok: true, json: async () => body });

test('parse: watch groups with their window and repeats, nothing else; unreadable is null, not empty', () => {
  const groups = parseRewardInventory(inv);
  assert.deepEqual(groups.map((g) => [g.id, g.required, g.minutes, g.repeatTimes, g.grants, g.windowEnd]), [
    [BADGE_DROP, 180, 2, null, 0, null],
    [DVD, 60, 60, 6, 1, WINDOW_END],
  ], 'the sub group is left out');
  assert.equal(JSON.stringify(groups).includes('currentSubs'), false);
  assert.equal(parseRewardInventory({ errors: [{ message: 'PersistedQueryNotFound' }] }), null);
  assert.equal(parseRewardInventory({ data: { currentUser: { inventory: {} } } }), null);
  assert.equal(parseRewardInventory({ errors: [{ message: 'failed integrity check' }], data: null }), null);
});

/** Twitch for one channel, GTAVI's reward campaign or the 2026-11-06 badge. rewardAnswer: what the reward inventory answers. */
function twitch({ login, available, session, rewardAnswer, onReward }) {
  return async (_url, init) => {
    const ops = JSON.parse(init.body);
    if (ops.some((o) => o.operationName === 'ViewerRewardDropInventory')) {
      onReward?.();
      if (rewardAnswer instanceof Error) throw rewardAnswer;
      return json(ops.map(() => rewardAnswer));
    }
    return json(ops.map((o) => {
      switch (o.operationName) {
        case 'Inventory': return { data: { currentUser: { inventory: { dropCampaignsInProgress: [], gameEventDrops: [] } } } };
        case 'VideoPlayerStreamInfoOverlayChannel': return { data: { user: { id: '20000009', login, displayName: login, stream: { id: '1' } } } };
        case 'DropsHighlightService_AvailableDrops': return { data: { channel: available } };
        default: return { data: { currentUser: { dropCurrentSession: session ?? badgeFx.zeroedSession } } };
      }
    }));
  };
}

async function poll(prev, t, i, opts) {
  const snap = await fetchSnapshot('tok', [opts.login], twitch(opts));
  return update(prev, { campaigns: snap.campaigns, rewards: snap.rewards, session: snap.session, sessions: snap.sessions, rewardGroups: snap.rewardGroups, streams: [{ tabId: 1, login: opts.login, channel: snap.channels[opts.login], tab: {}, player: { hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: 100 + i * 60 } }] }, t);
}

const withDvd = (minutes, grants = 1, end = '2026-11-19T11:17:18Z') => {
  const a = structuredClone(inv);
  const g = a.data.currentUser.inventory.viewerRewardDropCampaignsInProgress[1].rewardGroups[0];
  g.self.currentMinutesWatched = minutes;
  g.self.grantCount = grants;
  g.self.currentWindow.expiresAt = end;
  return a;
};
const gta = (rewardAnswer, extra = {}) => ({ login: 'echo', available: reward, rewardAnswer, ...extra });

test('day two, window ended: Twitch\'s 0 of 60 is shown, the channel is quiet, and a flat reading is never a hang', async () => {
  const T = Date.parse('2026-11-19T15:30:00Z');
  let s;
  for (let i = 0; i < 10; i++) s = await poll(s, T + i * MIN, i, gta(withDvd(60)));
  const row = s.active.find((d) => d.id === DVD);
  assert.deepEqual([row.minutes, row.required, row.unjudged], [0, 60, true], 'the window ended, so not 60 of 60');
  assert.equal(s.streams[0].channelState, 'reward');
  assert.equal(s.verdict.code, 'idle');
  assert.equal(s.verdict.reward, true);
  assert.match(s.verdict.message, /GTA DVD Chest: 0 of 60 minutes, as Twitch reports it/);
  assert.equal(warning(s, T + 10 * MIN), null);
  assert.equal(badge(s).text, '');
  assert.equal(verdictText(s, T + 10 * MIN)[0], 'Reward campaign');
  assert.deepEqual(channelDrops(s, 'echo', { pending: true }).drops.map((d) => d.name), ['GTA DVD Chest'], 'no Golden Iguana: Twitch lists no group for it');
});

test('today\'s already earned: quiet, and the next one starts when the window ends, at a time', async () => {
  const T = Date.parse('2026-11-18T15:30:00Z'); // Inside the window that began 11:17 that day.
  let s;
  for (let i = 0; i < 6; i++) s = await poll(s, T + i * MIN, i, gta(withDvd(60)));
  assert.equal(s.streams[0].channelState, 'reward', 'good news, not an amber "not counting yet" every day');
  assert.equal(s.streams[0].rewardOpens, WINDOW_END);
  assert.match(s.verdict.message, /today's reward drop is earned, as Twitch's reward inventory reports it\. The next one can start at /);
  assert.equal(warning(s, T + 6 * MIN), null);
});

test('Twitch\'s own next-eligible time wins over the window\'s end', async () => {
  const T = Date.parse('2026-11-18T15:30:00Z');
  const a = withDvd(60);
  a.data.currentUser.inventory.viewerRewardDropCampaignsInProgress[1].rewardGroups[0].self.nextEligibleAt = '2026-11-19T09:00:00Z';
  let s;
  for (let i = 0; i < 3; i++) s = await poll(s, T + i * MIN, i, gta(a));
  assert.equal(s.streams[0].rewardOpens, Date.parse('2026-11-19T09:00:00Z'));
});

test('every repeat granted: finished', async () => {
  const T = Date.parse('2026-11-25T15:30:00Z');
  let s;
  for (let i = 0; i < 3; i++) s = await poll(s, T + i * MIN, i, gta(withDvd(60, 6, '2026-11-25T11:17:18Z')));
  assert.equal(s.streams[0].channelState, 'finished');
});

test('a rising reward reading is earning, credited on its channel, with Twitch\'s numbers and no finish time', async () => {
  const T = Date.parse('2026-11-19T15:30:00Z');
  let s;
  for (let i = 0; i < 4; i++) s = await poll(s, T + i * MIN, i, gta(withDvd(i, 1, '2026-11-20T15:30:00Z')));
  assert.equal(s.verdict.code, 'earning');
  assert.equal(s.streams[0].channelState, 'reward');
  assert.deepEqual(s.active.filter((d) => d.id === DVD).map((d) => d.minutes), [3]);
  assert.equal(badge(s).text, '5%');
});

test('a badge the session is silent on: its minutes come from the reward inventory, not "cannot track"', async () => {
  const T = Date.parse('2026-11-06T19:00:00Z');
  let s;
  for (let i = 0; i < 8; i++) s = await poll(s, T + i * MIN, i, { login: 'charlie', available: badgeFx.mixed, rewardAnswer: inv });
  assert.equal(s.streams[0].channelState, 'reward');
  assert.deepEqual(s.active.filter((d) => d.id === BADGE_DROP).map((d) => [d.minutes, d.required]), [[2, 180]]);
  assert.equal(s.streams[0].badges[0].drops.find((d) => d.id === BADGE_DROP).minutes, 2, 'the Badges tab shows it too');
  assert.notEqual(s.verdict.limited, true);
});

test('a badge the session answers for keeps the session, which has been measured', async () => {
  const T = Date.parse('2026-11-06T19:00:00Z');
  let s;
  for (let i = 0; i < 4; i++) {
    s = await poll(s, T + i * MIN, i, { login: 'charlie', available: badgeFx.mixed, rewardAnswer: inv, session: { ...badgeFx.mixedSession, currentMinutesWatched: 3 + i } });
  }
  assert.equal(s.streams[0].channelState, 'eligible');
  assert.equal(s.verdict.code, 'earning');
});

test('asked only when an open channel has a campaign Inventory leaves out', async () => {
  let asked = 0;
  await fetchSnapshot('tok', ['bravo'], twitch({ login: 'bravo', available: { viewerDropCampaigns: null }, rewardAnswer: inv, onReward: () => { asked++; } }));
  assert.equal(asked, 0);
  const snap = await fetchSnapshot('tok', ['echo'], twitch(gta(inv, { onReward: () => { asked++; } })));
  assert.equal(asked, 1);
  assert.equal(snap.rewardGroups.length, 2);
});

test('the reward call failing never costs the poll, and the last good answer is held for a while', async () => {
  const T = Date.parse('2026-11-19T15:30:00Z');
  const failed = await fetchSnapshot('tok', ['echo'], twitch(gta(new Error('offline'))));
  assert.equal(failed.rewardGroups, null);
  assert.equal(failed.campaigns.length, 0, 'the rest of the poll still read');
  let s = await poll(undefined, T, 0, gta(withDvd(60)));
  s = await poll(s, T + 5 * MIN, 1, gta({ errors: [{ message: 'service error' }] }));
  assert.equal(s.streams[0].channelState, 'reward');
  assert.ok(s.active.some((d) => d.id === DVD && d.unjudged), 'held');
  assert.equal(s.rewardCheck.ok, false);
  s = await poll(s, T + 5 * MIN + REWARD_HOLD_MS, 2, gta({ errors: [{ message: 'service error' }] }));
  assert.equal(s.active.some((d) => d.id === DVD), false, 'too old: not held any longer');
});

test('switching between the window and the session\'s running total is not read as minutes credited', async () => {
  const T = Date.parse('2026-11-19T15:30:00Z');
  const session = { channel: { displayName: 'echo', id: '20000009', name: 'echo' }, currentMinutesWatched: 250, dropID: DVD, game: null, requiredMinutesWatched: 60 };
  // A poll every minute, so no gap resets the marks: the reward call works twice, then fails for
  // good, the held answer runs out, and the session's 250 takes over from the window's 0.
  let s;
  for (let i = 0; i < 20; i++) {
    const answer = i < 2 ? withDvd(60) : { errors: [{ message: 'down' }] };
    s = await poll(s, T + i * MIN, i, gta(answer, { session }));
  }
  assert.equal(s.active.some((d) => d.id === DVD), false, 'the hold ran out: now from the session');
  assert.equal(s.lastGainAt, null);
  assert.notEqual(s.verdict.code, 'earning');
});

test('the minute log records both raw readings on a reward channel, flat too, and leaves them out of the comparison', async () => {
  // Flat, as on 2026-11-19 at 15:55: nothing rising, so the tracker has chosen no session.
  const T = Date.parse('2026-11-19T15:30:00Z');
  const session = { channel: { displayName: 'echo', id: '20000009', name: 'echo' }, currentMinutesWatched: 250, dropID: DVD, game: null, requiredMinutesWatched: 60 };
  let s;
  for (let i = 0; i < 3; i++) s = await poll(s, T + i * MIN, i, gta(withDvd(60), { session }));
  const snap = await fetchSnapshot('tok', ['echo'], twitch(gta(withDvd(60), { session })));
  const obs = { campaigns: snap.campaigns, rewards: snap.rewards, session: snap.session, sessions: snap.sessions, rewardGroups: snap.rewardGroups, streams: [{ tabId: 1, login: 'echo', channel: snap.channels.echo, tab: {}, player: { hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: 400 } }] };
  const next = update(s, obs, T + 3 * MIN);
  assert.equal(next.session, null, 'nothing rose');
  const entry = logEntry(s, obs, next, T + 3 * MIN);
  assert.deepEqual([entry.rw, entry.rm, entry.sm, entry.e], [1, 60, 250, 0], 'raw: the group\'s 60 though the window ended, and the session\'s 250');
  assert.equal(compareMinutes([{ ...entry, e: 1 }]).total.watched, 0);
});

test('credit landing: the window and the session rise together, and each minute counts once', async () => {
  const T = Date.parse('2026-11-19T15:30:00Z');
  const sess = (m) => ({ channel: { displayName: 'echo', id: '20000009', name: 'echo' }, currentMinutesWatched: m, dropID: DVD, game: null, requiredMinutesWatched: 60 });
  let s;
  // Already running and flat, then Twitch starts this window.
  for (let i = 0; i < 3; i++) s = await poll(s, T + i * MIN, i, gta(withDvd(0, 1, '2026-11-20T15:00:00Z'), { session: sess(250) }));
  for (let i = 3; i < 7; i++) s = await poll(s, T + i * MIN, i, gta(withDvd(i - 2, 1, '2026-11-20T15:00:00Z'), { session: sess(247 + i) }));
  assert.equal(s.drops[DVD].peak, 4, 'the window\'s mark is the window\'s minutes');
  assert.equal(s.drops[`${DVD}:total`].peak, 253, 'the session\'s on its own mark');
  assert.deepEqual(s.timeline.slice(-4).map((t) => t.d), [1, 1, 1, 1]);
  assert.equal(s.verdict.code, 'earning');
  assert.equal(s.streams[0].credited, true);
});
