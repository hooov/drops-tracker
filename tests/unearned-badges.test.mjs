// "Badges not earned yet" in the Badges tab (drops-tracker#12): the rows, from what the extension
// stores. Built from the captured answers through the real parsers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSeenBadges, mergeSeenBadges, parseClaimedGroups, mergeClaimedGroups } from '../extension/lib/twitch.js';
import { update } from '../extension/lib/tracker.js';
import { unearnedBadges, badgesListError, OWNED_FRESH_MS } from '../extension/lib/badges.js';
import { categoryUrl } from '../extension/lib/directory.js';

const load = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const gta = load('channel-campaigns-2026-11-19.json').answer;
const osrs = load('highlight-omitted-2026-11-22.json').channelCampaigns;
const poke = load('pokemon-campaigns-2026-11-23.json');
const T0 = Date.parse('2026-11-22T12:00:00Z');
const GTA_GAME = '1867279146';
const item = (list) => ({ data: { channelDropCampaigns: structuredClone(list) } });
const EVO = poke.list.find((c) => c.name === 'Pokemon Evolutions');
const NIGHT = poke.list.find((c) => c.name === 'Pokémon Night Out Campaign');
const DVD = '2283245e-d15c-11f1-8cdd-0a58a9feac02';
const IGUANA = '8aada31e-d18c-11f1-a5bd-0a58a9feac02';
const GTA = 'b7669f9e-c69c-4a9b-a3b2-36266c1bdfc0';

const ofList = (list, gameId = '509658') => parseSeenBadges(item(list), gameId, T0);
const gtaSeen = () => parseSeenBadges(gta, GTA_GAME, T0);
const osrsSeen = () => parseSeenBadges(osrs, '459931', T0);
const keep = (...lists) => mergeSeenBadges([], lists.flat(), T0);
const owning = (...ids) => update(undefined, { campaigns: [], rewards: { ids, complete: true }, session: null, sessions: [], streams: [] }, T0);
const partly = (...ids) => update(undefined, { campaigns: [], rewards: { ids, complete: false }, session: null, sessions: [], streams: [] }, T0);
const sitewide = (c, over = {}) => ({
  kind: 'reward', id: c.id, name: c.name, game: c.name, owner: '', art: null, startAt: Date.parse(c.startAt), endAt: Date.parse(c.endAt),
  minutes: 20, sitewide: true, rewards: ['Haunter'], linkUrl: 'https://help.twitch.tv/s/article/pokemon-chat-badges', ...over,
});
const dirOf = (...campaigns) => ({ at: T0, triedAt: T0, error: null, campaigns });
const rows = (over = {}, now = T0) => unearnedBadges({ state: owning(), seen: [], directory: null, claimed: [], ...over }, now);
const brief = (list) => list.map((r) => [r.name, r.status, r.missing.map((m) => m.name)]);
const evoIds = EVO.rewardGroups.map((g) => g.rewards[0].id);

test('nothing owned: every badge is missing, and the count is provable', () => {
  const [row] = rows({ seen: keep(ofList([EVO])) });
  assert.equal(row.status, '0 of 9 owned');
  assert.equal(row.missing.length, 9);
  assert.equal(row.kind, 'missing');
  assert.match(row.ends, /^Ends /);
});

test('some owned: the count, and only the missing names', () => {
  const [row] = rows({ state: owning(...evoIds.slice(0, 6)), seen: keep(ofList([EVO])) });
  assert.equal(row.status, '6 of 9 owned');
  assert.deepEqual(row.missing.map((m) => m.name), EVO.rewardGroups.slice(6).map((g) => g.rewards[0].name));
});

test('all owned: hidden. A campaign of one badge says "Not earned yet"', () => {
  assert.deepEqual(rows({ state: owning(...evoIds), seen: keep(ofList([EVO])) }), []);
  assert.deepEqual(brief(rows({ seen: keep(osrsSeen()) })), [['OSRS Hardcore Worlds', 'Not earned yet', ['RuneScape Bones']]]);
});

test('a partial owned list never reads as not earned', () => {
  for (const state of [partly(), partly(...evoIds.slice(0, 6)), undefined, { rewards: { ids: evoIds.slice(0, 6) } }]) {
    const [row] = rows({ state, seen: keep(ofList([EVO])) });
    assert.equal(row.status, 'Cannot tell if earned');
    assert.equal(row.kind, 'unknown');
    assert.doesNotMatch(JSON.stringify(row), /of 9/);
  }
  // Every badge named by a partial list is still proven.
  assert.deepEqual(rows({ state: partly(...evoIds), seen: keep(ofList([EVO])) }), []);
});

test('an owned list read too long ago reads as unknown', () => {
  const state = owning();
  const at = T0 + OWNED_FRESH_MS;
  assert.equal(rows({ state, seen: keep(ofList([EVO])) }, at)[0].kind, 'missing');
  assert.equal(rows({ state, seen: keep(ofList([EVO])) }, at + 1)[0].kind, 'unknown');
});

test('a POOL reward is never called not earned, and is proven only by the channel page', () => {
  const seen = keep(ofList([NIGHT]));
  const directory = dirOf(sitewide(NIGHT));
  assert.deepEqual(brief(rows({ seen, directory })), [['Pokémon Night Out Campaign', 'Cannot tell if earned', ['Pokémon Night Out Themed Poke Ball']]]);
  const claimed = mergeClaimedGroups([], parseClaimedGroups({ data: { channelDropCampaignsProgress: poke.progress } }), T0);
  assert.deepEqual(rows({ seen, directory, claimed }), []);
  // Not in the sitewide list and no BADGE in it: nothing says it is a badge.
  assert.deepEqual(rows({ seen }), []);
});

test('GTAVI: missing, unknown and claimed parts together', () => {
  const seen = keep(gtaSeen());
  const [row] = rows({ seen });
  assert.equal(row.kind, 'missing');
  assert.equal(row.status, 'Not all earned', 'the chest is not countable');
  assert.deepEqual(row.missing, [{ name: 'Golden Iguana', unknown: false }, { name: 'GTA DVD Chest', unknown: true }]);
  assert.equal(row.more, true);
  const iguana = rows({ state: owning(IGUANA), seen })[0];
  assert.deepEqual([iguana.kind, iguana.missing], ['unknown', [{ name: 'GTA DVD Chest', unknown: true }]]);
  // Both watch groups proven: hidden, although its sub goal is not (default 2).
  const claimed = [{ campaignId: GTA, groupId: DVD, endAt: T0 + 1e9 }];
  assert.deepEqual(rows({ state: owning(IGUANA), seen, claimed }), []);
  // The chest finished, the badge not: six badges came out of that chest, so "1 of 2" would be wrong.
  assert.deepEqual(brief(rows({ seen, claimed })), [['GTAVI Launch Celebration', 'Not all earned', ['Golden Iguana']]]);
  assert.equal(rows({ state: owning(IGUANA), seen, claimed: [{ ...claimed[0], endAt: T0 }] }).length, 1, 'an ended flag proves nothing');
  assert.equal(rows({ state: owning(IGUANA), seen, claimed: [{ ...claimed[0], campaignId: 'other' }] }).length, 1);
});

test('a badge that has probably just been earned is unknown, not missing', () => {
  const group = osrs.data.channelDropCampaigns[1].rewardGroups[0].id;
  const state = { ...owning(), leftDrops: [{ id: group, campaignId: osrs.data.channelDropCampaigns[1].id }] };
  assert.equal(rows({ state, seen: keep(osrsSeen()) })[0].kind, 'unknown');
});

test('a campaign only partly read is never counted or hidden', () => {
  const c = structuredClone(EVO);
  c.rewardGroups[0].rewards = null;
  const seen = keep(ofList([c]));
  assert.equal(rows({ seen })[0].status, 'Not all earned');
  const all = rows({ state: owning(...evoIds), seen });
  assert.deepEqual([all.length, all[0].kind, all[0].missing], [1, 'unknown', []]);
  assert.equal(all[0].where, 'Part of this campaign could not be read.', 'never a row that opens to nothing');
  // The real capture: a drop's Inventory ID is its group's ID, which the likely-earned check joins on.
  const osrsFx = load('highlight-omitted-2026-11-22.json');
  assert.equal(osrsFx.inventory.timeBasedDrops[0].id, osrsFx.channelCampaigns.data.channelDropCampaigns[1].rewardGroups[0].id);
});

test('the same reward in two groups is one badge', () => {
  const c = structuredClone(EVO);
  c.rewardGroups[1].rewards = structuredClone(c.rewardGroups[0].rewards);
  const [row] = rows({ seen: keep(ofList([c])) });
  assert.equal(row.status, '0 of 8 owned');
  assert.equal(row.missing.length, 8, 'and it is named once');
});

test('a sitewide campaign no opened channel has carried', () => {
  const directory = dirOf(sitewide(EVO), sitewide(NIGHT, { minutes: 0 }), sitewide(NIGHT, { id: 'brand', sitewide: false }), { kind: 'drop', id: 'd', name: 'D', game: 'G', endAt: T0 + 1e9 });
  const list = rows({ directory });
  assert.deepEqual(brief(list), [['Pokemon Evolutions', 'Open a channel in it to see its badges', []]], 'no watch goal, not sitewide, a game drop: left out');
  assert.equal(list[0].link.label, 'Details');
  assert.equal(list[0].link.href, 'https://help.twitch.tv/s/article/pokemon-chat-badges');
  assert.doesNotMatch(JSON.stringify(list), /Haunter/, 'the one name the list gives is not all of it');
});

test('a sitewide campaign both listed and seen is one row', () => {
  const list = rows({ seen: keep(ofList([EVO])), directory: dirOf(sitewide(EVO)) });
  assert.equal(list.length, 1);
  assert.equal(list[0].status, '0 of 9 owned');
  assert.deepEqual(rows({ state: owning(...evoIds), seen: keep(ofList([EVO])), directory: dirOf(sitewide(EVO)) }), [], 'owned: the listed row goes too');
});

test('ended and not started campaigns are left out, whatever is stored', () => {
  const seen = keep(ofList([EVO]));
  const directory = dirOf(sitewide(NIGHT));
  const after = Date.parse('2027-01-30T23:00:00Z');
  assert.deepEqual(rows({ seen, directory }, after), []);
  assert.deepEqual(rows({ seen: seen.map((c) => ({ ...c, startAt: T0 + 1 })), directory: dirOf(sitewide(NIGHT, { startAt: T0 + 1 })) }), []);
  assert.equal(rows({ directory: dirOf(sitewide(NIGHT, { endAt: null })) }).length, 1, 'no end date in the list is not an end');
});

test('order: not earned, then not seen yet, then unknown; soonest to end first', () => {
  const seen = keep(ofList([EVO]), gtaSeen(), osrsSeen());
  const directory = dirOf(sitewide(NIGHT));
  const state = owning(IGUANA);
  assert.deepEqual(rows({ state, seen, directory }).map((r) => [r.name, r.kind]), [
    ['OSRS Hardcore Worlds', 'missing'], ['Pokemon Evolutions', 'missing'], ['Pokémon Night Out Campaign', 'unseen'], ['GTAVI Launch Celebration', 'unknown'],
  ]);
});

test('links: the category once known, the info page until then, nothing otherwise', () => {
  assert.deepEqual(rows({ seen: keep(gtaSeen()) })[0].link, { label: 'Browse Grand Theft Auto VI', href: 'https://www.twitch.tv/directory/game/Grand%20Theft%20Auto%20VI' });
  // The trimmed capture names no category.
  const bare = rows({ seen: keep(ofList([EVO])), directory: dirOf(sitewide(EVO)) })[0];
  assert.equal(bare.link.label, 'Details');
  assert.equal(rows({ seen: keep(ofList([EVO])) })[0].link, null);
  assert.equal(rows({ seen: keep(ofList([{ ...EVO, detailsURL: 'https://help.twitch.tv/x' }])) })[0].link.href, 'https://help.twitch.tv/x');
  // Damaged storage cannot put a script in a link.
  assert.equal(rows({ directory: dirOf(sitewide(EVO, { linkUrl: 'javascript:alert(1)' })) })[0].link, null);
});

test('several categories are said, beside the one linked', () => {
  const c = structuredClone(EVO);
  for (const g of c.rewardGroups) g.progressCriteria.categories = Array.from({ length: 21 }, (_, i) => ({ id: String(i), displayName: `Game ${i}` }));
  const [row] = rows({ seen: keep(ofList([c], '7')) });
  assert.equal(row.link.label, 'Browse Game 7');
  assert.equal(row.where, 'Also counts in 20 other categories.');
  for (const g of c.rewardGroups) g.progressCriteria.categories.length = 2;
  assert.equal(rows({ seen: keep(ofList([c], '1')) })[0].where, 'Also counts in 1 other category.');
  assert.equal(rows({ seen: keep(gtaSeen()) })[0].where, '');
  for (const g of c.rewardGroups) g.progressCriteria.channels = [{ id: '1' }];
  const limited = rows({ seen: keep(ofList([c], '1')) })[0];
  assert.deepEqual([limited.where, limited.link], ['Some of it counts only on certain channels.', null]);
});

test('category links: names that break a plain link (checked on Twitch, 2026-11-24)', () => {
  assert.equal(categoryUrl('Just Chatting'), 'https://www.twitch.tv/directory/game/Just%20Chatting');
  assert.equal(categoryUrl('Fate/Grand Order'), 'https://www.twitch.tv/directory/game/Fate%2FGrand%20Order');
  // A % encoded once answers "Category does not exist"; encoded twice it opens the category.
  assert.equal(categoryUrl('100% Orange Juice'), 'https://www.twitch.tv/directory/game/100%2525%20Orange%20Juice');
  assert.equal(categoryUrl(''), null);
  assert.equal(categoryUrl(undefined), null);
  assert.equal(categoryUrl('\ud800'), null, 'half a character cannot be encoded');
});

test('"may need more": several rewards or a sub goal', () => {
  assert.equal(rows({ seen: keep(ofList([EVO])) })[0].more, true);
  assert.equal(rows({ seen: keep(osrsSeen()) })[0].more, false);
});

test('damaged or missing storage gives no rows, not an error', () => {
  for (const bad of [null, undefined, 'x', {}, [null, 'x', {}, { id: 'a', endAt: T0 + 1e6 }, { id: 'a', endAt: T0 + 1e6, groups: [null, { id: 'g' }] }]]) {
    assert.deepEqual(unearnedBadges({ state: null, seen: bad, directory: { campaigns: bad }, claimed: bad }, T0), []);
  }
  assert.deepEqual(unearnedBadges({}, T0), []);
});

test('a list that failed to load says what to do on this tab', () => {
  assert.equal(badgesListError(null), '');
  assert.equal(badgesListError({ kind: 'timeout' }), "Twitch's campaigns page did not answer. Try again.");
  assert.match(badgesListError({ kind: 'auth' }), /Log in/);
});
