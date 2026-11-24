// A repeating reward drop's card showing the day's reward, as Twitch's panel does (2026-11-22: a
// GTAVI channel at 48 of 60 with 4 of 6 days granted; Twitch's panel showed "Diamond Chain" with
// its badge art, this showed "GTA DVD Chest" with REWARD/default.png). Read from Twitch's client
// the same day: day n shows the daily chest's pool.rewards[n] on the GTA6 card, rewardGroup.rewards[n]
// (else rewards[0]) on the generic one, from the DropChannelCampaignsProgress answer its channel
// page receives (page-hook.js). That answer is constructed here from the query's fields: the raw
// answer was not captured, but the six names and their order are what parseDayRewards stored from
// it in Tyler's Brave (0.1.16 debug bundle, 2026-11-22). Art URLs are placeholders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchSnapshot, parseDayRewards, mergeDayRewards, MAX_DAY_GROUPS } from '../extension/lib/twitch.js';
import { dayIndex } from '../extension/lib/tracker.js';
import { update } from './invariants.mjs';
import { channelDrops } from '../extension/lib/chip.js';

const inv = JSON.parse(readFileSync(new URL('./fixtures/reward-inventory-2026-11-19.json', import.meta.url))).answer;
const reward = JSON.parse(readFileSync(new URL('./fixtures/reward-campaign-2026-11-19.json', import.meta.url))).channel;
const badgeFx = JSON.parse(readFileSync(new URL('./fixtures/badge-2026-11-06.json', import.meta.url)));
const MIN = 60000;
const GTA = reward.viewerDropCampaigns[0].id;
const DVD = '2283245e-d15c-11f1-8cdd-0a58a9feac02';
const json = (body) => ({ status: 200, ok: true, json: async () => body });
const DAY_NAMES = ['Purple Chain', 'Bronze Chain', 'Silver Chain', 'Gold Chain', 'Diamond Chain', 'Miami Chain'];
const art = (i) => `https://static-cdn.jtvnw.net/twitch-quests-assets/REWARD/day${i + 1}.png`;

// shape 'pool' (GTAVI's): the group's one reward is the chest (POOL, as ChannelDropsCampaigns lists
// it), holding one badge per day in pool.rewards. Twitch's GTA6 card names day n from that pool
// (module 635265; the chest is the reward its remote config calls orderedDailyChest). shape
// 'rewards': one reward per day on the group itself, Twitch's generic card (module 756662).
function progressAnswer(names = DAY_NAMES, shape = 'pool') {
  const perDay = names.map((name, i) => ({ id: `reward-${i}`, name, thumbnailURL: art(i), distributionType: 'BADGE' }));
  const chest = { id: 'chest', name: 'GTA DVD Chest', thumbnailURL: 'https://static-cdn.jtvnw.net/twitch-quests-assets/REWARD/default.png', distributionType: 'POOL', pool: { id: 'pool', selectionMode: 'unknown', rewards: perDay } };
  return {
    data: {
      channelDropCampaignsProgress: [{
        id: GTA,
        name: 'GTAVI Launch Celebration',
        endAt: '2026-12-31T23:59:59Z',
        rewardGroups: [
          {
            id: DVD,
            name: 'GTA DVD Drops',
            progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 60 }, repeatableConfig: { repeatableTimes: 6, resetIntervalSeconds: 86400 } },
            rewards: shape === 'pool' ? [chest] : perDay,
            self: { status: 'IN_PROGRESS', currentMinutesWatched: 48, currentSubs: 0, grantCount: 4 },
          },
          { id: 'sub-group', progressCriteria: { requirementType: 'SUB', requirements: { subs: 1 }, repeatableConfig: { repeatableTimes: 3 } }, rewards: [{ id: 's', name: 'GTA Sub 1 Badge', thumbnailURL: art(9) }] },
          { id: 'final', progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 60 }, repeatableConfig: null }, rewards: [{ id: 'f', name: 'Golden Iguana', thumbnailURL: art(8) }] },
        ],
      }],
    },
  };
}

test('parse: each repeating watch group\'s reward per day, names and art only', () => {
  const days = DAY_NAMES.map((name, i) => ({ name, image: art(i) }));
  for (const shape of ['pool', 'rewards']) {
    const out = parseDayRewards(progressAnswer(DAY_NAMES, shape));
    assert.deepEqual(out, [{ campaignId: GTA, groupId: DVD, endAt: Date.parse('2026-12-31T23:59:59Z'), days }], shape);
    assert.equal(JSON.stringify(out).includes('grantCount'), false, 'the viewer\'s progress is not kept');
  }
  // A pool beside other rewards: the group's own rewards, as Twitch's generic card reads them.
  const beside = progressAnswer();
  beside.data.channelDropCampaignsProgress[0].rewardGroups[0].rewards.push({ id: 'x', name: 'Other', thumbnailURL: art(7) });
  assert.deepEqual(parseDayRewards(beside)[0].days.map((d) => d.name), ['GTA DVD Chest', 'Other']);
  const odd = progressAnswer(DAY_NAMES, 'rewards');
  odd.data.channelDropCampaignsProgress[0].rewardGroups[0].rewards[1].thumbnailURL = 'http://example.com/x.png';
  odd.data.channelDropCampaignsProgress[0].rewardGroups[0].rewards[2].name = 5;
  assert.deepEqual(parseDayRewards(odd)[0].days.slice(1, 3), [{ name: 'Bronze Chain', image: null }, { name: '', image: art(2) }], 'not https: no image; not a string: no name');
  for (const bad of [null, {}, { data: {} }, { data: { channelDropCampaignsProgress: null } }, { errors: [{ message: 'failed integrity check' }] }]) {
    assert.equal(parseDayRewards(bad), null, JSON.stringify(bad));
  }
});

// Tyler's 0.1.16 bundle (2026-11-22): one channel's Pokémon campaigns put 10 single-reward
// repeating groups into dayRewards (cap MAX_DAY_GROUPS). One reward for every day names no day,
// and those entries can evict GTAVI's.
test('parse: a repeating group with one reward for every day is not kept', () => {
  assert.deepEqual(parseDayRewards(progressAnswer(['Haunter'], 'rewards')), [], 'one reward repeated');
  // Its order is unknown, so it reads as the chest alone, which is one reward.
  assert.deepEqual(parseDayRewards(progressAnswer(DAY_NAMES.slice(0, 3))), [], 'a pool that is not one reward per day');
  const mixed = progressAnswer();
  mixed.data.channelDropCampaignsProgress[0].rewardGroups.push({ id: 'poke', progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 30 }, repeatableConfig: { repeatableTimes: 3 } }, rewards: [{ id: 'p', name: 'Haunter', thumbnailURL: art(7) }] });
  assert.deepEqual(parseDayRewards(mixed).map((x) => x.groupId), [DVD], 'only the multi-day group');
});

test('merge: newest answer per group wins, ended campaigns dropped, bounded', () => {
  const now = Date.parse('2026-11-22T20:00:00Z');
  const [one] = parseDayRewards(progressAnswer());
  let map = mergeDayRewards([], [one], now);
  assert.deepEqual(map, [{ ...one, at: now }]);
  const renamed = { ...one, days: [{ name: 'New', image: null }] };
  map = mergeDayRewards(map, [renamed], now + 1);
  assert.deepEqual(map.map((x) => x.days[0].name), ['New']);
  assert.deepEqual(mergeDayRewards(map, [], one.endAt + 1), [], 'its campaign ended');
  let many = [];
  for (let i = 0; i < MAX_DAY_GROUPS + 5; i++) many = mergeDayRewards(many, [{ ...one, groupId: `g${i}` }], now + i);
  assert.equal(many.length, MAX_DAY_GROUPS);
  assert.equal(many[many.length - 1].groupId, `g${MAX_DAY_GROUPS + 4}`);
  assert.deepEqual(mergeDayRewards(null, null, now), []);
});

// Twitch's rule (its client, 2026-11-22): day n+1 is in progress, or earned when CLAIMABLE, where n
// is the grant count; today's minutes done and not claimable shows the last claimed day; an ended
// window counts as 0 minutes.
test('dayIndex: the day Twitch\'s panel shows', () => {
  const now = Date.parse('2026-11-22T20:00:00Z');
  const g = (over) => ({ repeatTimes: 6, grants: 4, minutes: 48, status: 'IN_PROGRESS', windowEnd: now + 3600000, ...over });
  assert.equal(dayIndex(g(), 60, now), 4, 'in progress: the fifth day');
  assert.equal(dayIndex(g({ minutes: 60, status: 'CLAIMABLE' }), 60, now), 4, 'earned, not yet granted');
  assert.equal(dayIndex(g({ minutes: 60, grants: 5 }), 60, now), 4, 'done for today: the day just granted');
  assert.equal(dayIndex(g({ minutes: 60, grants: 0 }), 60, now), 0, 'done with none granted: the first');
  assert.equal(dayIndex(g({ minutes: 60, windowEnd: now - 1 }), 60, now), 4, 'window over: 0 minutes, so in progress');
  assert.equal(dayIndex(g({ grants: 6, minutes: 60 }), 60, now), 5, 'every day granted: the last');
  assert.equal(dayIndex(g({ grants: null, minutes: null }), 60, now), 0);
  assert.equal(dayIndex(g({ repeatTimes: null }), 60, now), 0, 'not repeating');
});

function twitch(rewardAnswer) {
  return async (_url, init) => {
    const ops = JSON.parse(init.body);
    if (ops.some((o) => o.operationName === 'ViewerRewardDropInventory')) return json(ops.map(() => rewardAnswer));
    return json(ops.map((o) => {
      switch (o.operationName) {
        case 'Inventory': return { data: { currentUser: { inventory: { dropCampaignsInProgress: [], gameEventDrops: [] } } } };
        case 'VideoPlayerStreamInfoOverlayChannel': return { data: { user: { id: '20000009', login: 'echo', displayName: 'Echo', stream: { id: '1' } } } };
        case 'DropsHighlightService_AvailableDrops': return { data: { channel: reward } };
        default: return { data: { currentUser: { dropCurrentSession: badgeFx.zeroedSession } } };
      }
    }));
  };
}

const withDvd = (minutes, grants, end) => {
  const a = structuredClone(inv);
  const g = a.data.currentUser.inventory.viewerRewardDropCampaignsInProgress[1].rewardGroups[0];
  Object.assign(g.self, { currentMinutesWatched: minutes, grantCount: grants, status: 'IN_PROGRESS' });
  g.self.currentWindow.expiresAt = end;
  return a;
};

async function run(polls, dayRewards) {
  const T = Date.parse('2026-11-22T20:00:00Z');
  let s;
  for (let i = 0; i < polls; i++) {
    const snap = await fetchSnapshot('tok', ['echo'], twitch(withDvd(48, 4, '2026-11-23T01:00:00Z')), {}, { askRewards: true, now: T + i * MIN });
    s = update(s, { campaigns: snap.campaigns, rewards: snap.rewards, session: snap.session, sessions: snap.sessions, rewardGroups: snap.rewardGroups, dayRewards, streams: [{ tabId: 1, login: 'echo', channel: snap.channels.echo, tab: {}, player: { hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: 100 + i * 60 } }] }, T + i * MIN);
  }
  return s;
}

test('48 of 60 on day five: the card shows Diamond Chain with its art, as Twitch\'s panel does', async () => {
  const s = await run(3, parseDayRewards(progressAnswer()));
  const [card] = channelDrops(s, 'echo', { pending: true }).drops;
  assert.deepEqual([card.name, card.image, card.minutes, card.required], ['Diamond Chain', art(4), 48, 60]);
  assert.match(s.verdict.message, /^Echo's Diamond Chain: 48 of 60 minutes, as Twitch reports it\.$/, 'named the same everywhere');
});

test('no page answer yet, or no entry for that day: the list\'s own reward, as before', async () => {
  const none = await run(2, undefined);
  assert.deepEqual(channelDrops(none, 'echo', { pending: true }).drops.map((d) => d.name), ['GTA DVD Chest']);
  const one = await run(2, parseDayRewards(progressAnswer(['Purple Chain'], 'rewards')));
  assert.deepEqual(channelDrops(one, 'echo', { pending: true }).drops.map((d) => d.name), ['GTA DVD Chest'], 'one reward for every day is not kept');
  const short = await run(2, parseDayRewards(progressAnswer(['Purple Chain', 'Bronze Chain'], 'rewards')));
  assert.deepEqual(channelDrops(short, 'echo', { pending: true }).drops.map((d) => [d.name, d.image]), [['Purple Chain', art(0)]], 'no fifth day: Twitch falls back to the first');
  const blank = await run(2, parseDayRewards(progressAnswer(['Purple Chain', '', '', '', '', ''], 'rewards')));
  assert.deepEqual(channelDrops(blank, 'echo', { pending: true }).drops.map((d) => d.name), ['GTA DVD Chest'], 'a nameless day keeps the list\'s name');
});
