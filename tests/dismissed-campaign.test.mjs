// A campaign whose chat highlight was dismissed: signed in, DropsHighlightService_AvailableDrops
// leaves it out and ChannelDropsCampaigns still lists it with hasViewerDismissedHighlight: true
// (2026-11-20, GTAVI on a channel Twitch was crediting). twitch.js addDismissedCampaign().
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSnapshot } from '../extension/lib/twitch.js';

const NOW = Date.parse('2026-11-20T18:00:00Z');
const json = (b) => ({ status: 200, ok: true, json: async () => b });
// Where GTAVI's groups say they earn (captured 2026-11-19), and the stream live in that category.
const GTA = '1867279146';
const PLACE = { channels: null, categories: [{ id: GTA, displayName: 'Grand Theft Auto VI' }] };
const group = (over = {}) => {
  const g = {
    id: 'g1', name: 'GTA DVD Drops',
    progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 60 }, repeatableConfig: { repeatableTimes: 6 } },
    rewards: [{ id: 'r1', name: 'GTA DVD Chest', thumbnailURL: 'https://x/y.png' }],
    ...over,
  };
  if (g.progressCriteria) g.progressCriteria = { ...PLACE, ...g.progressCriteria };
  return g;
};
const camp = (over = {}) => ({
  id: 'c1', name: 'GTAVI Launch Celebration', brandName: '', startAt: '2026-11-18T11:00:00Z', endAt: '2026-12-01T07:59:59.999Z',
  imageURL: 'https://x/c.png', hasViewerDismissedHighlight: true, game: null, rewardGroups: [group()], ...over,
});
const listed = (list) => ({ data: { channelDropCampaigns: list } });
const noHighlight = { data: { channel: { id: '1', viewerDropCampaigns: [] } } };

async function channel(cdc, avail = noHighlight, game = { id: GTA }) {
  const f = async (_u, init) => json(JSON.parse(init.body).map((o) => {
    switch (o.operationName) {
      case 'Inventory': return { data: { currentUser: { inventory: { dropCampaignsInProgress: [], gameEventDrops: [] } } } };
      case 'VideoPlayerStreamInfoOverlayChannel': return { data: { user: { id: '1', login: 'foxtrot', displayName: 'Foxtrot', broadcastSettings: { game }, stream: { id: '1' } } } };
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

// Dismissed or not: the highlight answer also left out an undismissed campaign (2026-11-22).
test('dismissed or not, added where its groups earn; not ended, not elsewhere', async () => {
  for (const flag of [true, false, undefined, null, 'true']) {
    assert.deepEqual((await channel(listed([camp({ hasViewerDismissedHighlight: flag })]))).campaigns.map((x) => x.id), ['c1'], String(flag));
  }
  assert.deepEqual((await channel(listed([camp({ endAt: '2026-11-20T17:59:59Z' })]))).campaigns, [], 'ended');
  assert.deepEqual((await channel(listed([camp()]), noHighlight, { id: '509658' })).campaigns, [], 'stream in another category');
  assert.deepEqual((await channel(listed([camp()]), noHighlight, null)).campaigns, [], 'no category read');
  const nowhere = group({ progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 60 }, channels: null, categories: [] } });
  assert.deepEqual((await channel(listed([camp({ rewardGroups: [nowhere] })]))).campaigns, [], 'a group naming no place');
  const otherChannel = group({ progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 60 }, channels: [{ id: '2' }] } });
  assert.deepEqual((await channel(listed([camp({ rewardGroups: [otherChannel] })]))).campaigns, [], 'a group naming another channel');
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
  // A badge's groups name the channel, not a category (captured 2026-11-19).
  const c = await channel(listed([camp({ brandName: 'CREATOR_LED_BADGE_CAMPAIGN', rewardGroups: [group({ progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 180 }, channels: [{ id: '1' }], categories: [] } })] })]));
  assert.deepEqual(c.campaigns.map((x) => [x.id, x.channelOwned]), [['c1', true]]);
  assert.equal(c.badges.length, 1);
});

// Audit 2026-11-22: a badge is this channel's own, from this channel's answer. One whose groups
// name no place was listed before earnsHere and must stay listed (none captured; a miss is worse).
test('a badge whose groups name no place stays listed', async () => {
  const g = group({ progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 180 }, channels: null, categories: [] } });
  const c = await channel(listed([camp({ brandName: 'CREATOR_LED_BADGE_CAMPAIGN', rewardGroups: [g] })]));
  assert.deepEqual([c.badges.length, c.campaigns.map((x) => [x.id, x.channelOwned])], [1, [['c1', true]]]);
  // One naming another channel is not this channel's.
  const other = group({ progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 180 }, channels: [{ id: '2' }], categories: [] } });
  assert.deepEqual((await channel(listed([camp({ brandName: 'CREATOR_LED_BADGE_CAMPAIGN', rewardGroups: [other] })]))).badges, []);
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
  // This answer is the channel's list (audit, 2026-11-22): not reading it, with nothing earnable
  // from the highlight answer, is unknown, not "No Drops".
  for (const bad of [{ data: {} }, listed({}), { errors: [{ message: 'service error' }], data: null }, { errors: [{ message: 'service error' }], data: { channelDropCampaigns: null } }]) {
    const c = await channel(bad);
    assert.deepEqual([!!c.unknown, c.badgeLookupFailed, c.campaigns], [true, true, []], JSON.stringify(bad));
  }
  // null with no error is Twitch's answer for a live channel with no campaigns (captured
  // 2026-11-22, 5 of 6 such channels): "No Drops", never "Cannot check".
  const none = await channel(listed(null));
  assert.deepEqual([!!none.unknown, !!none.badgeLookupFailed, none.campaigns], [false, false, []]);
});

test('bounded: at most twenty campaigns on a channel', async () => {
  const c = await channel(listed(Array.from({ length: 30 }, (_, i) => camp({ id: `c${i}` }))));
  assert.equal(c.campaigns.length, 20);
});
