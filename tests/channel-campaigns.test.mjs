// A channel's own badge campaign that only ChannelDropsCampaigns lists (2026-11-19, captured):
// DropsHighlightService_AvailableDrops gave only the sitewide GTAVI campaign for that channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchSnapshot, PINNED } from '../extension/lib/twitch.js';
import { update } from '../extension/lib/tracker.js';
import { badgeSections } from '../extension/lib/badges.js';

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
  assert.deepEqual([row.minutes, row.required, row.unjudged], [22, 180, true]);
  assert.equal(s.streams[0].channelState, 'reward');
  assert.notEqual(s.verdict.code, 'stalled');
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
function dayTwoEvening({ badge, total }) {
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
      if (ops[i].operationName === 'ViewerRewardDropInventory') return a;
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

test('today\'s reward drop earned and nothing else rising: still not called wasted (a running total judges nothing)', async () => {
  let s;
  for (let i = 0; i < 4; i++) s = await eveningPoll(s, i, { badge: 72, total: 319 + i });
  assert.equal(s.verdict.wasted ?? null, null, JSON.stringify(s.verdict));
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
