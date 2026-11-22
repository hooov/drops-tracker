// A channel's own badge campaign that only ChannelDropsCampaigns lists (2026-11-19, captured):
// DropsHighlightService_AvailableDrops gave only the sitewide GTAVI campaign for that channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchSnapshot, PINNED } from '../extension/lib/twitch.js';
import { badge, warning } from '../extension/lib/tracker.js';
import { update } from './invariants.mjs';
import { badgeSections } from '../extension/lib/badges.js';
import { chipView, channelDrops } from '../extension/lib/chip.js';

const cc = JSON.parse(readFileSync(new URL('./fixtures/channel-campaigns-2026-11-19.json', import.meta.url)));
const inv = JSON.parse(readFileSync(new URL('./fixtures/reward-inventory-2026-11-19.json', import.meta.url))).answer;
const reward = JSON.parse(readFileSync(new URL('./fixtures/reward-campaign-2026-11-19.json', import.meta.url))).channel;
const badgeFx = JSON.parse(readFileSync(new URL('./fixtures/badge-2026-11-06.json', import.meta.url)));
const MIN = 60000;
const T = Date.parse('2026-11-19T18:00:00Z');
const BADGE = '2599eac2-414e-4165-8dfb-9184ea99f927';
const WATCH_GROUP = 'afe7886c-e437-11f1-8716-0a58a9feac02';
const SUB_GROUP = 'afe78731-e437-11f1-8716-0a58a9feac02';
const json = (body) => ({ status: 200, ok: true, json: async () => body });

/** The reward inventory as it read that evening: the badge's 180-minute group at these minutes. */
function inventoryAt(minutes) {
  const a = structuredClone(inv);
  const [badge] = a.data.currentUser.inventory.viewerRewardDropCampaignsInProgress;
  badge.id = BADGE;
  badge.rewardGroups[0].id = WATCH_GROUP;
  badge.rewardGroups[0].self.currentMinutesWatched = minutes;
  return a;
}

function twitch({ minutes, channelCampaigns = cc.answer }) {
  return async (_url, init) => {
    const ops = JSON.parse(init.body);
    return json(ops.map((o) => {
      switch (o.operationName) {
        case 'ViewerRewardDropInventory': return inventoryAt(minutes);
        case 'Inventory': return { data: { currentUser: { inventory: { dropCampaignsInProgress: [], gameEventDrops: [] } } } };
        case 'VideoPlayerStreamInfoOverlayChannel': return { data: { user: { id: cc.channelID, login: 'foxtrot', displayName: 'Foxtrot', stream: { id: '1' } } } };
        case 'DropsHighlightService_AvailableDrops': return { data: { channel: reward } };
        case 'ChannelDropsCampaigns': return channelCampaigns;
        case 'DropCurrentSessionContext': return { data: { currentUser: { dropCurrentSession: badgeFx.zeroedSession } } };
        default: throw new Error(o.operationName);
      }
    }));
  };
}

async function poll(prev, t, i, opts) {
  const snap = await fetchSnapshot('tok', ['foxtrot'], twitch(opts), {}, { askRewards: true });
  const state = update(prev, { campaigns: snap.campaigns, rewards: snap.rewards, session: snap.session, sessions: snap.sessions, rewardGroups: snap.rewardGroups, streams: [{ tabId: 1, login: 'foxtrot', channel: snap.channels.foxtrot, tab: {}, player: { hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: 100 + i * 60 } }] }, t);
  return { snap, state };
}

test('the query is pinned, so a hash Twitch\'s page sends can repair it', () => {
  assert.deepEqual(PINNED.ChannelDropsCampaigns, ['bc073ff0bb13797898f83e93dc8009838545dec95ff7fe92243c8fa3a740f7e7']);
});

test('the badge only ChannelDropsCampaigns lists reaches the Badges tab, with its minutes from the reward inventory', async () => {
  let s;
  let snap;
  for (const [i, m] of [20, 21, 22].entries()) ({ snap, state: s } = await poll(s, T + i * MIN, i, { minutes: m }));
  const ch = snap.channels.foxtrot;
  assert.deepEqual(ch.badges.map((b) => b.id), [BADGE], 'GTAVI has game null in this answer too, and is not a badge');
  assert.deepEqual(ch.badges[0].drops.map((d) => [d.id, d.name, d.required, d.subs]), [
    [SUB_GROUP, 'Foxtrot Sub Badge', 0, 1],
    [WATCH_GROUP, 'Foxtrot Watch Badge', 180, 0],
  ]);
  assert.ok(ch.campaigns.some((c) => c.id === BADGE && c.channelOwned), 'tracked as the channel\'s own campaign');

  const [sec] = badgeSections(s.streams, 'foxtrot', T + 3 * MIN, s.unplacedBadges);
  assert.equal(sec.note, null);
  const [sub, watch] = sec.campaigns[0].drops;
  assert.equal(sub.line, 'Subscribe or gift a sub to earn');
  assert.deepEqual([watch.minutes, watch.pct], [22, 12]);
  assert.match(watch.line, /^Watch 2h 38m to earn$/);
  assert.deepEqual(s.unplacedBadges, [], 'placed now, so the "no open channel lists" note is gone');

  const row = s.active.find((d) => d.id === WATCH_GROUP);
  // A channel's own badge read fresh from the reward inventory is judged like any drop, so the
  // channel can earn rather than being a quiet reward channel (2026-11-19).
  assert.deepEqual([row.minutes, row.required, row.unjudged ?? false], [22, 180, false]);
  assert.equal(s.streams[0].channelState, 'eligible');
  assert.equal(s.verdict.code, 'earning');
});

test('ChannelDropsCampaigns failing costs only its badges: the channel is still read, and the tab says it could not check', async () => {
  const { snap, state } = await poll(undefined, T, 0, { minutes: 20, channelCampaigns: { errors: [{ message: 'PersistedQueryNotFound' }], data: null } });
  const ch = snap.channels.foxtrot;
  assert.equal(ch.unknown, undefined);
  assert.equal(ch.badgeLookupFailed, true);
  assert.deepEqual(ch.campaigns.map((c) => c.id), ['b7669f9e-c69c-4a9b-a3b2-36266c1bdfc0'], 'GTAVI still tracked');
  assert.equal(badgeSections(state.streams, 'foxtrot', T)[0].note, "Cannot read this channel's badge drops right now.");
});

// 2026-11-19, Tyler's bundle at 19:03 UTC: today's GTAVI DVD drop earned (60 of 60, second grant),
// the session still naming it with GTAVI's running total (322 of 60), and the channel's own badge
// rising in the reward inventory (72 of 180). The panel turned amber: "already earned, these
// minutes do nothing". They were earning the badge.
function dayTwoEvening({ badge, total, rewardFails = false }) {
  const a = inventoryAt(badge);
  const dvd = a.data.currentUser.inventory.viewerRewardDropCampaignsInProgress[1].rewardGroups[0];
  dvd.self.currentMinutesWatched = 60;
  dvd.self.grantCount = 2;
  dvd.self.currentWindow = { startedAt: '2026-11-19T17:50:15Z', expiresAt: '2026-11-20T17:50:15Z' };
  const session = { channel: { displayName: 'Foxtrot', id: cc.channelID, name: 'foxtrot' }, currentMinutesWatched: total, dropID: '2283245e-d15c-11f1-8cdd-0a58a9feac02', game: null, requiredMinutesWatched: 60 };
  return async (_url, init) => {
    const ops = JSON.parse(init.body);
    const base = await (await twitch({ minutes: badge })(_url, init)).json();
    return json(base.map((x, i) => {
      if (ops[i].operationName === 'ViewerRewardDropInventory') return rewardFails ? { errors: [{ message: 'service timeout' }], data: null } : a;
      if (ops[i].operationName === 'DropCurrentSessionContext') return { data: { currentUser: { dropCurrentSession: session } } };
      return x;
    }));
  };
}

async function eveningPoll(prev, i, opts) {
  const t = Date.parse('2026-11-19T19:00:00Z') + i * MIN;
  const snap = await fetchSnapshot('tok', ['foxtrot'], dayTwoEvening(opts), {}, { askRewards: true });
  return update(prev, { campaigns: snap.campaigns, rewards: snap.rewards, session: snap.session, sessions: snap.sessions, rewardGroups: snap.rewardGroups, streams: [{ tabId: 1, login: 'foxtrot', channel: snap.channels.foxtrot, tab: {}, player: { hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: 100 + i * 60 } }] }, t);
}

test('today\'s reward drop earned while the channel\'s badge rises: earning, never "these minutes do nothing"', async () => {
  let s;
  for (let i = 0; i < 4; i++) s = await eveningPoll(s, i, { badge: 69 + i, total: 319 + i });
  assert.equal(s.verdict.code, 'earning');
  assert.equal(s.verdict.wasted, null, JSON.stringify(s.verdict.wasted));
  assert.equal(s.active.find((d) => d.id === WATCH_GROUP).minutes, 72);
});

test('the same evening: the chip ring and the toolbar badge show the badge\'s percentage, also on a quiet minute', async () => {
  let s;
  // 69, 70, 71, then a minute where nothing rose, then 72.
  for (const [i, m] of [69, 70, 71, 71, 72].entries()) {
    s = await eveningPoll(s, i, { badge: m, total: 319 + i });
    const at = Date.parse('2026-11-19T19:00:00Z') + i * MIN;
    const pct = Math.floor((m / 180) * 100);
    assert.equal(chipView(s, at, 'foxtrot').pct, pct, `chip at ${m}`);
    // The first poll is a baseline, so the toolbar has no "earning" to show yet.
    if (i > 0) {
      assert.equal(s.verdict.code, 'earning', `minute ${i}`);
      assert.equal(badge(s).text, `${pct}%`, `toolbar at ${m}`);
    }
  }
  assert.equal(s.creditedCampaign, BADGE);
});

// Corrected by the all-views check (2026-11-19): this asserted "not wasted", but today's reward drop
// done and only its running total rising means the minutes count for nothing until the next window.
test('today\'s reward drop earned and only its running total rising: wasted, naming the reward', async () => {
  let s;
  for (let i = 0; i < 4; i++) s = await eveningPoll(s, i, { badge: 72, total: 319 + i });
  assert.equal(s.verdict.wasted?.reason, 'earned', JSON.stringify(s.verdict));
  assert.match(s.verdict.wasted.message, /GTA DVD Chest is earned for today/);
});

test('a badge both queries list is shown once', async () => {
  const both = structuredClone(cc.answer);
  const fromHighlight = { ...reward, viewerDropCampaigns: [...reward.viewerDropCampaigns, { id: BADGE, name: 'FoxtrotGTA', game: null, endAt: '2026-11-19T23:00:00.962Z', timeBasedDrops: [{ id: WATCH_GROUP, name: '', requiredMinutesWatched: 180, requiredSubs: 0, benefitEdges: [{ benefit: { id: 'b', name: 'Foxtrot Watch Badge' } }] }] }] };
  const f = async (_url, init) => {
    const ops = JSON.parse(init.body);
    const base = await twitch({ minutes: 20, channelCampaigns: both })(_url, init);
    const answers = await base.json();
    return json(answers.map((a, i) => (ops[i].operationName === 'DropsHighlightService_AvailableDrops' ? { data: { channel: fromHighlight } } : a)));
  };
  const snap = await fetchSnapshot('tok', ['foxtrot'], f, {}, { askRewards: true });
  assert.equal(snap.channels.foxtrot.badges.filter((b) => b.id === BADGE).length, 1);
  assert.equal(snap.channels.foxtrot.campaigns.filter((c) => c.id === BADGE).length, 1);
});

// The same evening with a second tab open on a channel with no drops (Tyler's setup: a 24/7
// channel beside the badge channel). Its chip showed a bare full ring.
async function twoTabPoll(prev, i, minutes, { total = 319 + i, rewardFails = false } = {}) {
  const t = Date.parse('2026-11-19T19:00:00Z') + i * MIN;
  const one = dayTwoEvening({ badge: minutes, total, rewardFails });
  const fake = async (_url, init) => {
    const ops = JSON.parse(init.body);
    const base = await (await one(_url, init)).json();
    return json(base.map((a, k) => {
      const o = ops[k];
      const echo = o.variables?.channel === 'echo_247' || o.variables?.channelID === '20000011';
      if (!echo) return a;
      switch (o.operationName) {
        case 'VideoPlayerStreamInfoOverlayChannel': return { data: { user: { id: '20000011', login: 'echo_247', displayName: 'echo_247', stream: { id: '2' } } } };
        case 'DropsHighlightService_AvailableDrops': return { data: { channel: { id: '20000011', viewerDropCampaigns: [] } } };
        case 'ChannelDropsCampaigns': return { data: { channelDropCampaigns: [] } };
        case 'DropCurrentSessionContext': return { data: { currentUser: { dropCurrentSession: badgeFx.zeroedSession } } };
        default: return a;
      }
    }));
  };
  const snap = await fetchSnapshot('tok', ['foxtrot', 'echo_247'], fake, {}, { askRewards: true });
  const player = (tabTime) => ({ hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: tabTime });
  return update(prev, {
    campaigns: snap.campaigns, rewards: snap.rewards, session: snap.session, sessions: snap.sessions, rewardGroups: snap.rewardGroups,
    streams: [
      { tabId: 1, login: 'foxtrot', channel: snap.channels.foxtrot, tab: {}, player: player(100 + i * 60) },
      { tabId: 2, login: 'echo_247', channel: snap.channels.echo_247, tab: {}, player: player(500 + i * 60) },
    ],
  }, t);
}

test('a second tab with no drops shows the badge channel\'s percentage, and names it', async () => {
  let s;
  for (const [i, m] of [69, 70, 71, 71, 72].entries()) {
    s = await twoTabPoll(s, i, m);
    const at = Date.parse('2026-11-19T19:00:00Z') + i * MIN;
    // The first poll is a baseline: nothing has risen, so no channel is known to be credited yet.
    // From then on, quiet minutes (71 twice) included.
    if (i > 0) assert.equal(chipView(s, at, 'echo_247').pct, Math.floor((m / 180) * 100), `second tab at ${m}`);
  }
  assert.equal(s.streams.find((t) => t.login === 'echo_247').channelState, 'no_drops');
  const { drops, from } = channelDrops(s, 'echo_247');
  assert.deepEqual([drops[0].id, from], [WATCH_GROUP, 'Foxtrot']);
});

// 2026-11-19, 19:50 to 20:00 UTC (Tyler's bundle): the badge stopped at 106 of 180 and the session
// at 356 with a second stream playing, and the panel said only "today's reward drop is earned".
test('the badge stopping on a reward channel is a stall, naming the second stream', async () => {
  let s;
  const minutes = [103, 104, 105, 106, 106, 106, 106, 106, 106, 106];
  for (const [i, m] of minutes.entries()) s = await twoTabPoll(s, i, m, { total: 353 + Math.min(i, 3) });
  assert.equal(s.streams.find((t) => t.login === 'foxtrot').channelState, 'eligible');
  assert.equal(s.verdict.code, 'stalled', JSON.stringify(s.verdict));
  assert.equal(s.verdict.cause, 'second_stream', JSON.stringify(s.verdict));
});

test('a failed reward inventory call never reads as the badge stalling', async () => {
  let s;
  for (const [i, m] of [103, 104, 105, 106].entries()) s = await twoTabPoll(s, i, m, { total: 353 + i });
  // Twitch keeps crediting, but the reward inventory times out for 8 polls: the held reading is flat.
  for (let i = 4; i < 12; i++) s = await twoTabPoll(s, i, 106 + i, { total: 353 + i, rewardFails: true });
  assert.notEqual(s.verdict.code, 'stalled', JSON.stringify(s.verdict));
  // And with nothing rising anywhere and only held readings: still never a stall from the badge.
  let q;
  for (const [i, m] of [103, 104, 105, 106].entries()) q = await twoTabPoll(q, i, m, { total: 353 + i });
  for (let i = 4; i < 12; i++) q = await twoTabPoll(q, i, 106, { total: 356, rewardFails: true });
  // Not "not eligible": leaving the channel unjudged on held polls reset its hang clock, so a real
  // stall between failed calls never warned (audit, 2026-11-22). Held readings keep the state and
  // clock but cannot raise a stall by themselves.
  assert.notEqual(q.verdict.code, 'stalled', JSON.stringify(q.verdict));
  assert.equal(warning(q, Date.parse('2026-11-19T19:00:00Z') + 11 * MIN), null);
});
