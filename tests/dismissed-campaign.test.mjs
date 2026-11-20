// A campaign whose chat highlight was dismissed: signed in, DropsHighlightService_AvailableDrops
// leaves it out and ChannelDropsCampaigns still lists it with hasViewerDismissedHighlight: true
// (2026-11-20, GTAVI on a channel Twitch was crediting). twitch.js addDismissedCampaign().
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSnapshot } from '../extension/lib/twitch.js';

const NOW = Date.parse('2026-11-20T18:00:00Z');
const json = (b) => ({ status: 200, ok: true, json: async () => b });
const group = (over = {}) => ({
  id: 'g1', name: 'GTA DVD Drops',
  progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 60 }, repeatableConfig: { repeatableTimes: 6 } },
  rewards: [{ id: 'r1', name: 'GTA DVD Chest', thumbnailURL: 'https://x/y.png' }],
  ...over,
});
const camp = (over = {}) => ({
  id: 'c1', name: 'GTAVI Launch Celebration', brandName: '', startAt: '2026-11-18T11:00:00Z', endAt: '2026-12-01T07:59:59.999Z',
  imageURL: 'https://x/c.png', hasViewerDismissedHighlight: true, game: null, rewardGroups: [group()], ...over,
});
const listed = (list) => ({ data: { channelDropCampaigns: list } });
const noHighlight = { data: { channel: { id: '1', viewerDropCampaigns: [] } } };

async function channel(cdc, avail = noHighlight) {
  const f = async (_u, init) => json(JSON.parse(init.body).map((o) => {
    switch (o.operationName) {
      case 'Inventory': return { data: { currentUser: { inventory: { dropCampaignsInProgress: [], gameEventDrops: [] } } } };
      case 'VideoPlayerStreamInfoOverlayChannel': return { data: { user: { id: '1', login: 'foxtrot', displayName: 'Foxtrot', stream: { id: '1' } } } };
      case 'DropsHighlightService_AvailableDrops': return avail;
      case 'ChannelDropsCampaigns': return cdc;
      case 'DropCurrentSessionContext': return { data: { currentUser: { dropCurrentSession: null } } };
      case 'ViewerRewardDropInventory': return { data: { currentUser: { inventory: { viewerRewardDropCampaignsInProgress: [] } } } };
      default: throw new Error(o.operationName);
    }
  }));
  return (await fetchSnapshot('tok', ['foxtrot'], f, {}, { askRewards: false, now: NOW })).channels.foxtrot;
}

test('a dismissed reward campaign is added in the shape the highlight answer gives', async () => {
  const c = await channel(listed([camp()]));
  assert.equal(c.campaigns.length, 1);
  const [x] = c.campaigns;
  assert.deepEqual(
    { id: x.id, channelOwned: x.channelOwned, rewardCampaign: x.rewardCampaign, benefitIds: x.benefitIds, subOnly: c.subOnly },
    { id: 'c1', channelOwned: false, rewardCampaign: true, benefitIds: ['r1'], subOnly: false },
  );
  assert.deepEqual(x.watchDrops, [{ id: 'g1', name: 'GTA DVD Chest', image: 'https://x/y.png', required: 60, startAt: '2026-11-18T11:00:00Z', endAt: '2026-12-01T07:59:59.999Z', benefitIds: ['r1'] }]);
  assert.deepEqual(c.badges, [], 'not a badge');
});

test('only a campaign Twitch says was dismissed, and not one that has ended', async () => {
  for (const flag of [false, undefined, null, 'true']) {
    assert.deepEqual((await channel(listed([camp({ hasViewerDismissedHighlight: flag })]))).campaigns, [], String(flag));
  }
  assert.deepEqual((await channel(listed([camp({ endAt: '2026-11-20T17:59:59Z' })]))).campaigns, [], 'ended');
});

test('a non-repeating dismissed campaign is not a reward campaign', async () => {
  const g = group({ progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 120 }, repeatableConfig: null } });
  const [x] = (await channel(listed([camp({ rewardGroups: [g] })]))).campaigns;
  assert.equal(x.rewardCampaign, false);
});

test('sub drops only: "Sub only", not "No Drops"', async () => {
  const sub = group({ progressCriteria: { requirementType: 'SUB', requirements: { subs: 1 } } });
  const c = await channel(listed([camp({ rewardGroups: [sub] })]));
  assert.deepEqual([c.campaigns, c.subOnly], [[], true]);
});

test('already in the highlight answer: kept once, from there', async () => {
  const avail = { data: { channel: { id: '1', viewerDropCampaigns: [{ id: 'c1', name: 'GTAVI Launch Celebration', game: { displayName: 'Special Events' }, summary: { isRewardCampaign: true }, timeBasedDrops: [{ id: 'g1', requiredMinutesWatched: 60, benefitEdges: [{ benefit: { id: 'r1', name: 'GTA DVD Chest' } }] }] }] } } };
  const c = await channel(listed([camp()]), avail);
  assert.deepEqual(c.campaigns.map((x) => [x.id, x.game]), [['c1', 'Special Events']]);
});

test('a dismissed badge keeps the badge path', async () => {
  const c = await channel(listed([camp({ brandName: 'CREATOR_LED_BADGE_CAMPAIGN', rewardGroups: [group({ progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 180 } } })] })]));
  assert.deepEqual(c.campaigns.map((x) => [x.id, x.channelOwned]), [['c1', true]]);
  assert.equal(c.badges.length, 1);
});

test('odd shapes never throw and never mark the channel unknown', async () => {
  const shapes = [
    listed([camp({ rewardGroups: null })]),
    listed([camp({ rewardGroups: [null, group({ progressCriteria: null }), group({ progressCriteria: { requirementType: 'WATCH', requirements: null } })] })]),
    listed([null, camp({ rewardGroups: [group({ rewards: null })] })]),
  ];
  const got = [];
  for (const s of shapes) { const c = await channel(s); got.push([!!c.unknown, c.campaigns.map((x) => x.watchDrops.map((d) => d.name).join())]); }
  assert.deepEqual(got, [[false, []], [false, []], [false, ['GTA DVD Drops']]]);
  for (const bad of [listed(null), { errors: [{ message: 'service error' }], data: null }]) {
    const c = await channel(bad);
    assert.deepEqual([!!c.unknown, c.badgeLookupFailed, c.campaigns], [false, true, []]);
  }
});

test('bounded: at most twenty campaigns on a channel', async () => {
  const c = await channel(listed(Array.from({ length: 30 }, (_, i) => camp({ id: `c${i}` }))));
  assert.equal(c.campaigns.length, 20);
});
