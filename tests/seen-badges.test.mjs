// Badge campaigns remembered from the channels you open (drops-tracker#12), read from the
// ChannelDropsCampaigns answer the extension already asks for. Against the captured answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchSnapshot, parseSeenBadges, mergeSeenBadges, MAX_SEEN_BADGES, SEEN_AGAIN_MS } from '../extension/lib/twitch.js';

const load = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const gta = load('channel-campaigns-2026-11-19.json').answer;
const osrs = load('highlight-omitted-2026-11-22.json').channelCampaigns;
const poke = load('pokemon-campaigns-2026-11-23.json');
const T0 = Date.parse('2026-11-19T18:00:00Z');
const MIN = 60000;
const item = (list, errors) => ({ data: { channelDropCampaigns: structuredClone(list) }, ...(errors ? { errors } : {}) });
const GTA_GAME = '1867279146';

test('GTAVI: a sitewide-style campaign is kept, the channel\'s own badge is not', () => {
  const seen = parseSeenBadges(gta, GTA_GAME, T0);
  assert.equal(seen.length, 1);
  const [c] = seen;
  assert.equal(c.name, 'GTAVI Launch Celebration');
  assert.equal(c.badge, true, 'Golden Iguana is a BADGE');
  assert.equal(c.gameless, true);
  assert.equal(c.more, true, 'it has a sub goal');
  assert.equal(c.cut, false);
  assert.deepEqual(c.place, { id: GTA_GAME, name: 'Grand Theft Auto VI' });
  assert.equal(c.places, 1);
  assert.deepEqual(c.groups.map((g) => g.rewards.map((r) => [r.name, r.badge])), [[['GTA DVD Chest', false]], [['Golden Iguana', true]]]);
  assert.equal(c.endAt, Date.parse('2026-12-01T07:59:59.999Z'));
});

test('OSRS: the watch badge is kept, its sub-only sibling is not', () => {
  const seen = parseSeenBadges(osrs, '459931', T0);
  assert.deepEqual(seen.map((c) => [c.groups.map((g) => g.rewards[0].name), c.more, c.gameless]), [[['RuneScape Bones'], false, false]]);
});

test('Evolutions and Night Out: every watch reward, and which are badges', () => {
  const seen = parseSeenBadges(item(poke.list), '509658', T0);
  assert.deepEqual(seen.map((c) => [c.name, c.groups.length, c.badge]), [['Pokemon Evolutions', 9, true], ['Pokémon Night Out Campaign', 1, false]]);
  assert.equal(seen[0].place, null, 'the trimmed capture has no category name, so there is nothing to link');
});

test('nothing about the channel or the viewer is kept', () => {
  const text = JSON.stringify(parseSeenBadges(gta, GTA_GAME, T0));
  for (const word of ['Foxtrot', '20000010', 'hasViewerDismissed', 'self', 'minutesWatched']) assert.doesNotMatch(text, new RegExp(word));
});

test('a game campaign with no badge by watching is not a badge campaign', () => {
  const skin = structuredClone(osrs);
  for (const c of skin.data.channelDropCampaigns) for (const g of c.rewardGroups) g.rewards[0].distributionType = 'DIRECT_ENTITLEMENT';
  assert.deepEqual(parseSeenBadges(skin, '459931', T0), []);
  // Watch for a skin, subscribe for the badge: no badge to watch for.
  const mixed = structuredClone(osrs);
  mixed.data.channelDropCampaigns = [{ ...mixed.data.channelDropCampaigns[1], rewardGroups: [...mixed.data.channelDropCampaigns[0].rewardGroups, ...skin.data.channelDropCampaigns[1].rewardGroups] }];
  assert.deepEqual(parseSeenBadges(mixed, '459931', T0), []);
});

test('an answer with an error, or none, adds nothing', () => {
  assert.deepEqual(parseSeenBadges(item(poke.list, [{ message: 'service error', path: ['channelDropCampaigns', 0, 'rewardGroups'] }]), '509658', T0), [], 'a list cut short would replace a whole one');
  for (const bad of [null, undefined, {}, { data: null }, { data: { channelDropCampaigns: null } }, { data: { channelDropCampaigns: {} } }]) {
    assert.deepEqual(parseSeenBadges(bad, '1', T0), []);
  }
});

test('ended, or with no end date, or no ID: not kept', () => {
  const change = (fields) => parseSeenBadges(item(poke.list.slice(0, 1).map((c) => ({ ...c, ...fields }))), '509658', T0);
  assert.equal(change({}).length, 1);
  assert.deepEqual(change({ endAt: '2026-11-19T17:59:59Z' }), []);
  assert.deepEqual(change({ endAt: null }), []);
  assert.deepEqual(change({ id: null }), []);
  assert.deepEqual(change({ name: null }), []);
  assert.deepEqual(change({ rewardGroups: null }), []);
});

test('a part that cannot be read marks the campaign cut, so it is never counted or hidden', () => {
  const change = (edit) => {
    const c = structuredClone(poke.list[0]);
    edit(c.rewardGroups);
    return parseSeenBadges(item([c]), '509658', T0)[0];
  };
  assert.equal(change(() => {}).cut, false);
  assert.equal(change((g) => { g[0].rewards = null; }).cut, true);
  assert.equal(change((g) => { g[0].rewards = []; }).cut, true);
  assert.equal(change((g) => { g[0].rewards = [null]; }).cut, true);
  assert.equal(change((g) => { g[0].rewards[0].id = null; }).cut, true);
  assert.equal(change((g) => { g[0].progressCriteria = null; }).cut, true, 'not known to be a sub goal');
  assert.equal(change((g) => { g[0].progressCriteria.requirements = null; }).cut, true);
  assert.equal(change((g) => { g[0].id = null; }).cut, true);
  assert.equal(change((g) => { g[0] = null; }).cut, true);
  const many = change((g) => { while (g.length < 60) g.push({ ...structuredClone(g[0]), id: `g${g.length}`, rewards: [{ id: `r${g.length}`, name: 'x', distributionType: 'BADGE' }] }); });
  assert.equal(many.cut, true);
  assert.ok(many.groups.length <= 40);
  const wide = change((g) => { g[0].rewards = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, name: 'x', distributionType: 'BADGE' })); });
  assert.equal(wide.cut, true);
  assert.ok(wide.groups.flatMap((g) => g.rewards).length <= 40);
});

test('a reward type that is missing or new is not called a badge', () => {
  const c = structuredClone(poke.list[0]);
  delete c.rewardGroups[0].rewards[0].distributionType;
  c.rewardGroups[1].rewards[0].distributionType = 'BADGE_V2';
  const [seen] = parseSeenBadges(item([c]), '509658', T0);
  assert.deepEqual(seen.groups.slice(0, 3).map((g) => g.rewards[0].badge), [false, false, true]);
});

test('names and links are bounded and https only', () => {
  const c = { ...structuredClone(poke.list[0]), name: 'x'.repeat(5000), imageURL: 'javascript:alert(1)', detailsURL: 'http://example.com' };
  c.rewardGroups[0].rewards[0].name = 'y'.repeat(5000);
  const [seen] = parseSeenBadges(item([c]), '509658', T0);
  assert.equal(seen.name.length, 200);
  assert.equal(seen.groups[0].rewards[0].name.length, 100);
  assert.equal(seen.art, null);
  assert.equal(seen.infoUrl, null);
});

const withPlaces = (places, over = {}) => {
  const c = structuredClone(poke.list[0]);
  for (const g of c.rewardGroups) g.progressCriteria.categories = places;
  return { ...c, ...over };
};
const A = { id: '1', displayName: 'First Game' };
const B = { id: '2', displayName: 'Second Game' };
const C = { id: '3', displayName: 'Third Game' };

test('several categories: the one the campaign was seen in, else the first', () => {
  const at = (gameId) => parseSeenBadges(item([withPlaces([A, B, C])]), gameId, T0)[0];
  assert.deepEqual([at('2').place, at('2').places, at('2').seenIn], [{ id: '2', name: 'Second Game' }, 3, true]);
  assert.deepEqual([at('9').place.id, at('9').seenIn], ['1', false], 'the stream moved on');
  assert.deepEqual([at(undefined).place.id, at(null).place.id], ['1', '1'], 'category unreadable, or none');
  // No category named: nothing to link. A channel list: a category page would be the wrong place.
  assert.equal(parseSeenBadges(item([withPlaces([])]), '2', T0)[0].place, null);
  const limited = withPlaces([A]);
  limited.rewardGroups[0].progressCriteria.channels = [{ id: '10000001' }];
  const [l] = parseSeenBadges(item([limited]), '1', T0);
  assert.deepEqual([l.someChannels, l.place], [true, null]);
  assert.equal(at('2').someChannels, false);
});

test('merging: a category seen is not replaced by a guess', () => {
  const seen = (gameId) => parseSeenBadges(item([withPlaces([A, B, C])]), gameId, T0);
  let m = mergeSeenBadges([], seen('2'), T0);
  m = mergeSeenBadges(m, seen(undefined), T0 + MIN);
  assert.equal(m[0].place.id, '2');
  m = mergeSeenBadges(m, seen('3'), T0 + 2 * MIN);
  assert.equal(m[0].place.id, '3', 'the newest place it was seen');
  // Gone from the campaign's own list: no longer a place to send anyone.
  m = mergeSeenBadges(m, parseSeenBadges(item([withPlaces([A, B])]), undefined, T0), T0 + 3 * MIN);
  assert.equal(m[0].place.id, '1');
});

test('merging: kept until the campaign ends, and never dropped for being absent', () => {
  const m = mergeSeenBadges([], parseSeenBadges(item(poke.list), '509658', T0), T0);
  assert.equal(m.length, 2);
  assert.equal(mergeSeenBadges(m, [], T0 + 60 * MIN).length, 2);
  const afterNight = Date.parse('2026-11-23T23:00:00Z');
  assert.deepEqual(mergeSeenBadges(m, [], afterNight).map((c) => c.name), ['Pokemon Evolutions']);
  assert.deepEqual(mergeSeenBadges(m, [], Date.parse('2027-02-01T00:00:00Z')), []);
});

test('merging the same again changes nothing, so it is not written every minute', () => {
  const fresh = () => parseSeenBadges(item(poke.list), '509658', T0);
  const m = mergeSeenBadges([], fresh(), T0);
  assert.deepEqual(mergeSeenBadges(m, fresh(), T0 + 5 * MIN), m);
  // chrome.storage hands objects back with their keys sorted.
  const reKeyed = (v) => (Array.isArray(v) ? v.map(reKeyed) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, reKeyed(v[k])])) : v);
  assert.deepEqual(mergeSeenBadges(reKeyed(m), fresh(), T0 + 5 * MIN), m);
  assert.ok(mergeSeenBadges(reKeyed(m), fresh(), T0 + 5 * MIN).every((c) => c.at === T0));
  // Two tabs in two of its categories settle on one, rather than taking turns.
  const two = () => ['2', '3'].flatMap((id) => parseSeenBadges(item([withPlaces([A, B, C])]), id, T0));
  const t = mergeSeenBadges([], two(), T0);
  assert.equal(t[0].place.id, '2');
  assert.deepEqual(mergeSeenBadges(t, two(), T0 + MIN), t);
  // The first tab is in none of its categories: the second says where it was seen.
  const late = [...parseSeenBadges(item([withPlaces([A, B, C])]), '9', T0), ...parseSeenBadges(item([withPlaces([A, B, C])]), '3', T0)];
  assert.equal(mergeSeenBadges([], late, T0)[0].place.id, '3');
  assert.equal(mergeSeenBadges(m, fresh(), T0 + SEEN_AGAIN_MS + 1)[0].at, T0 + SEEN_AGAIN_MS + 1, 'its age still moves, for the cap');
  const changed = fresh();
  changed[0].groups.pop();
  assert.equal(mergeSeenBadges(m, changed, T0 + 5 * MIN).find((c) => c.name === 'Pokemon Evolutions').groups.length, 8);
});

test('merging is capped, newest kept, and survives damaged storage', () => {
  const [one] = parseSeenBadges(item(poke.list), '509658', T0);
  const many = Array.from({ length: 150 }, (_, i) => ({ ...one, id: `c${i}`, at: T0 - i }));
  const m = mergeSeenBadges(many, [{ ...one, id: 'new' }], T0);
  assert.equal(m.length, MAX_SEEN_BADGES);
  assert.equal(MAX_SEEN_BADGES, 100);
  assert.ok(m.some((c) => c.id === 'new'));
  assert.ok(!m.some((c) => c.id === 'c149'));
  for (const bad of [undefined, null, 'x', {}, [null, 'x', {}, { id: 'a' }, { id: 'a', endAt: 'soon', groups: [] }, { id: 'a', endAt: T0 + MIN }]]) {
    assert.deepEqual(mergeSeenBadges(bad, [], T0), []);
  }
});

test('the poll hands over what its live channels listed, two channels included', async () => {
  const answer = (o) => {
    switch (o.operationName) {
      case 'Inventory': return { data: { currentUser: { inventory: { dropCampaignsInProgress: [], gameEventDrops: [] } } } };
      case 'VideoPlayerStreamInfoOverlayChannel': {
        const n = o.variables.channel === 'foxtrot' ? '1' : '2';
        return { data: { user: { id: n, displayName: o.variables.channel, stream: { id: 's' }, broadcastSettings: { game: { id: n === '1' ? GTA_GAME : '459931' } } } } };
      }
      case 'DropsHighlightService_AvailableDrops': return { data: { channel: { viewerDropCampaigns: null } } };
      case 'ChannelDropsCampaigns': return o.variables.channelID === '1' ? gta : osrs;
      default: return { data: { currentUser: { dropCurrentSession: null } } };
    }
  };
  const fetchImpl = async (_u, { body }) => ({ ok: true, status: 200, json: async () => structuredClone(JSON.parse(body).map(answer)) });
  const snap = await fetchSnapshot('t', ['foxtrot', 'echo_247'], fetchImpl, {}, { now: T0 });
  assert.deepEqual(snap.seenBadges.map((c) => [c.name, c.place?.name]), [['GTAVI Launch Celebration', 'Grand Theft Auto VI'], ['OSRS Hardcore Worlds', 'Old School RuneScape']]);
  // Both lookups failing costs nothing else and hands over nothing.
  const down = async (u, o) => (JSON.parse(o.body)[0].operationName === 'Inventory' ? fetchImpl(u, o) : { ok: false, status: 503, json: async () => [] });
  assert.deepEqual((await fetchSnapshot('t', ['foxtrot'], down, {}, { now: T0 })).seenBadges, []);
});
