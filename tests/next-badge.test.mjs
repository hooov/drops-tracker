// Watch time left, "Next" and "Cannot finish before it ends" in "Badges not earned yet"
// (drops-tracker#18). From the captured answers, through the real parsers and the real tracker.
// Captured as such: OSRS (one badge, its Inventory minutes) and GTAVI (a daily badge, one day of six
// granted). No capture is part-way through a campaign whose days all count for one BADGE, so
// Evolutions' progress is the captured GTAVI reading with Evolutions' IDs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSeenBadges, mergeSeenBadges, parseRewardInventory, loginPrint } from '../extension/lib/twitch.js';
import { REWARD_HOLD_MS } from '../extension/lib/tracker.js';
import { update } from './invariants.mjs';
import { unearnedBadges, closeFirst, OWNED_FRESH_MS } from '../extension/lib/badges.js';

const load = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const gta = load('channel-campaigns-2026-11-19.json').answer;
const osrsFx = load('highlight-omitted-2026-11-22.json');
const poke = load('pokemon-campaigns-2026-11-23.json');
const invFx = load('reward-inventory-2026-11-19.json').answer;
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const EVO = poke.list.find((c) => c.name === 'Pokemon Evolutions');
const NIGHT = poke.list.find((c) => c.name === 'Pokémon Night Out Campaign');
const GTA = 'b7669f9e-c69c-4a9b-a3b2-36266c1bdfc0';
const DVD = '2283245e-d15c-11f1-8cdd-0a58a9feac02';
const ULTIMATE = 'c7e4cd08-d18f-11f1-a716-0a58a9feac02';
const IGUANA = '8aada31e-d18c-11f1-a5bd-0a58a9feac02';
const BONES = '0cc61e0f-e351-11f1-9433-0a58a9feac02';
const WINDOW_END = Date.parse('2026-11-19T11:17:18Z'); // The captured window's own.
const OSRS_END = Date.parse('2026-11-30T23:59:59.999Z');
const EVO_END = Date.parse(EVO.endAt);
const T0 = Date.parse('2026-11-22T12:00:00Z');

const item = (list) => ({ data: { channelDropCampaigns: structuredClone(list) } });
const seenOf = (answer, gameId, now = T0) => mergeSeenBadges([], parseSeenBadges(answer, gameId, now), now);
const gtaSeen = (now) => seenOf(gta, '1867279146', now);
const osrsSeen = (now) => seenOf(osrsFx.channelCampaigns, '459931', now);
const evoSeen = (now, change = () => {}) => {
  const c = structuredClone(EVO);
  change(c.rewardGroups);
  return seenOf(item([c]), '509658', now);
};

/** The captured reward inventory's GTAVI campaign, its groups' readings changed. */
const rewardInv = (self = {}, over = {}) => {
  const answer = structuredClone(invFx);
  const [, camp] = answer.data.currentUser.inventory.viewerRewardDropCampaignsInProgress;
  camp.id = over.campaignId ?? camp.id;
  camp.rewardGroups = (over.groupIds ?? [DVD]).map((id) => {
    const g = structuredClone(camp.rewardGroups[0]);
    g.id = id;
    Object.assign(g.self, self);
    if (over.required) g.progressCriteria.requirements.minutesWatched = over.required;
    if (over.times) g.progressCriteria.repeatableConfig.repeatableTimes = over.times;
    return g;
  });
  if (over.more) camp.rewardGroups.push(over.more);
  answer.data.currentUser.inventory.viewerRewardDropCampaignsInProgress = [camp];
  const groups = parseRewardInventory(answer);
  assert.ok(groups?.length);
  return groups;
};
const evoIds = EVO.rewardGroups.map((g) => g.id);
const evoInv = (self, ids = evoIds) => rewardInv(self, { campaignId: EVO.id, groupIds: ids, required: 20, times: 3 });
const window = (start) => ({ currentWindow: { startedAt: new Date(start).toISOString(), expiresAt: new Date(start + DAY).toISOString() } });

/** OSRS in Inventory, as captured, at these minutes. */
const bones = (minutes, self = {}) => {
  const c = structuredClone(osrsFx.inventory);
  Object.assign(c.timeBasedDrops[0].self, { currentMinutesWatched: minutes }, self);
  return c;
};
const poll = (now, { owned = [], complete = true, campaigns = [], rewardGroups, streams = [], sessions = [], prev } = {}) => update(prev, {
  campaigns, rewards: { ids: owned, complete }, rewardGroups, session: sessions[0] ?? null, sessions, streams,
}, now);
const rows = (state, seen, now = T0, over = {}) => unearnedBadges({ state, seen, directory: null, claimed: [], ...over }, now);
const row = (...args) => {
  const list = rows(...args);
  assert.equal(list.length, 1);
  return list[0];
};

test('what is kept of a group: minutes, and how often it repeats', () => {
  const groupsOf = (seen) => seen[0].groups.map(({ id, rewards, ...rest }) => rest);
  assert.deepEqual(groupsOf(osrsSeen()), [{ minutes: 60, times: 1 }]);
  assert.deepEqual(groupsOf(gtaSeen()), [{ minutes: 60, times: 6, reset: 86400, all: false }, { minutes: 60, times: 1 }]);
  assert.deepEqual(groupsOf(evoSeen())[0], { minutes: 20, times: 3, reset: 86400, all: true });
  // A last-chance extension's rule is not known, so nothing is judged too late on it.
  assert.equal(groupsOf(evoSeen(T0, (g) => { g[0].progressCriteria.repeatableConfig.isLastChanceExtensionEnabled = true; }))[0].all, false);
});

test('a requirement or a repeat that cannot be read is unknown, never one sitting', () => {
  const first = (change) => evoSeen(T0, (g) => change(g[0].progressCriteria))[0].groups[0];
  assert.equal(first((c) => { c.requirements = null; }).minutes, null);
  assert.equal(first((c) => { c.requirements.minutesWatched = '20'; }).minutes, null);
  assert.equal(first((c) => { c.requirements.minutesWatched = Infinity; }).minutes, null);
  assert.equal(first((c) => { delete c.repeatableConfig; }).times, null);
  assert.equal(first((c) => { c.repeatableConfig = {}; }).times, null);
  assert.equal(first((c) => { c.repeatableConfig.repeatableTimes = -1; }).times, null);
  assert.equal(first((c) => { c.repeatableConfig.resetIntervalSeconds = null; }).reset, null);
  assert.deepEqual([first((c) => { c.repeatableConfig = null; }).times, first((c) => { c.repeatableConfig.repeatableTimes = 1; }).times], [1, 1]);
});

test('one badge, as captured: the time left with its progress, and it is Next', () => {
  const r = row(poll(T0, { campaigns: [bones(1)] }), osrsSeen());
  assert.equal(r.watch, 'Watch 59m more, 1 of 60 min done');
  assert.equal(r.next, true);
  assert.equal(r.late, false);
  assert.equal(row(poll(T0, { campaigns: [bones(0)] }), osrsSeen()).watch, 'Watch 1h');
});

test('unknown progress: the whole time, Next, and never too late', () => {
  const state = poll(T0);
  assert.deepEqual([row(state, osrsSeen()).watch, row(state, osrsSeen()).next], ['Watch 1h', true]);
  assert.equal(row(state, evoSeen()).watch, 'Each badge: watch 20m on 3 days');
  for (const end of [OSRS_END, EVO_END]) {
    const now = end - MIN;
    const seen = end === OSRS_END ? osrsSeen(now) : evoSeen(now);
    const r = row(poll(now), seen, now);
    assert.deepEqual([r.late, r.next, r.missing.some((m) => m.late)], [false, true, false]);
  }
});

test('too late: known minutes that no longer fit, to the minute', () => {
  const at = (now, state) => row(state, osrsSeen(now), now);
  const fits = OSRS_END - 30 * MIN;
  assert.equal(at(fits, poll(fits, { campaigns: [bones(30)] })).late, false);
  const r = at(fits + MIN, poll(fits + MIN, { campaigns: [bones(30)] }));
  assert.deepEqual([r.late, r.next], [true, false]);
  assert.equal(r.watch, 'Watch 30m more, 30 of 60 min done');
  // An older reading: it could have been watched ever since, so it is judged from its own time.
  assert.equal(at(fits + 10 * MIN, poll(fits, { campaigns: [bones(30)] })).late, false);
  // Minutes that come from no judged reading are not known.
  const unjudged = poll(fits + MIN, { campaigns: [bones(30)] });
  for (const flag of ['unjudged', 'held']) {
    const state = { ...unjudged, active: unjudged.active.map((d) => ({ ...d, [flag]: true })) };
    assert.deepEqual([at(fits + MIN, state).late, at(fits + MIN, state).watch], [false, 'Watch 1h']);
  }
});

test('GTAVI as captured, its window over: five days left, Next, never too late', () => {
  const now = WINDOW_END + 6 * HOUR;
  const r = row(poll(now, { rewardGroups: rewardInv() }), gtaSeen(now), now);
  assert.equal(r.watch, 'Watch 1h on 5 more days');
  assert.equal(r.next, true);
  assert.deepEqual(r.missing.map((m) => [m.name, m.watch]), [['Golden Iguana', 'watch 1h'], ['GTA DVD Chest', 'watch 1h on 5 more days']]);
  // Not one BADGE over six days (its days each give a reward), so nothing proves it too late.
  const end = Date.parse('2026-12-01T07:59:59.999Z') - HOUR / 2;
  assert.equal(row(poll(end, { rewardGroups: rewardInv() }), gtaSeen(end), end).late, false);
});

test('GTAVI as captured, its window open and done: not Next today', () => {
  const now = WINDOW_END - 2 * HOUR;
  const r = row(poll(now, { rewardGroups: rewardInv() }), gtaSeen(now), now);
  assert.equal(r.watch, 'Done for today, then 1h on 5 more days');
  assert.equal(r.next, false, 'its 1h badge shares those minutes, so unknown there is not "none done"');
  assert.equal(r.late, false);
  // And another badge takes the place.
  const two = rows(poll(now, { rewardGroups: rewardInv() }), [...gtaSeen(now), ...osrsSeen(now)], now);
  assert.deepEqual(two.map((x) => [x.name, x.next]), [['OSRS Hardcore Worlds', true], ['GTAVI Launch Celebration', false]]);
  // Part-way through today's.
  const part = row(poll(now, { rewardGroups: rewardInv({ currentMinutesWatched: 24 }) }), gtaSeen(now), now);
  assert.deepEqual([part.watch, part.next], ['Watch 1h on 5 more days, 24 of 60 min today', true]);
});

test('GTAVI with its final badge at its minutes but not given: the days are what is left', () => {
  const now = WINDOW_END + HOUR;
  // "The same 250 as the campaign's other reward groups" (facts, 2026-11-19).
  const more = { id: ULTIMATE, progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 60 }, repeatableConfig: null }, self: { status: 'IN_PROGRESS', currentMinutesWatched: 60, grantCount: 0, hasPreconditionsMet: false } };
  const r = row(poll(now, { rewardGroups: rewardInv({}, { more }) }), gtaSeen(now), now);
  assert.deepEqual([r.watch, r.next], ['Watch 1h on 5 more days', true]);
  const open = WINDOW_END - HOUR;
  assert.equal(row(poll(open, { rewardGroups: rewardInv({}, { more }) }), gtaSeen(open), open).next, false);
  // Nothing left to watch that is known of: not Next, not too late.
  const done = row(poll(now, { rewardGroups: rewardInv({}, { more, groupIds: [] }) }), gtaSeen(now), now, { claimed: [{ campaignId: GTA, groupId: DVD, endAt: now + DAY }] });
  assert.deepEqual([done.watch, done.next, done.late], ['Watch time reached', false, false]);
});

test('a daily badge: days left, today, done for today, and the next start', () => {
  const start = T0 - 2 * HOUR;
  const at = (self, now = T0) => row(poll(T0, { rewardGroups: evoInv({ grantCount: 1, ...window(start), ...self }) }), evoSeen(), now);
  const part = at({ currentMinutesWatched: 5 });
  assert.deepEqual([part.watch, part.next], ['Each badge: watch 20m on 2 more days, 5 of 20 min today', true]);
  const done = at({ currentMinutesWatched: 20 });
  assert.deepEqual([done.watch, done.next], ['Each badge: done for today, then 20m on 2 more days', false]);
  // The window ended with no newer reading: today's minutes there are not today's any more.
  const after = start + DAY;
  const over = row(poll(after, { prev: poll(T0, { rewardGroups: evoInv({ grantCount: 1, currentMinutesWatched: 20, ...window(start) }) }) }), evoSeen(), after);
  assert.deepEqual([over.next, over.watch], [true, 'Each badge: watch 20m on 2 more days']);
  // Twitch's own time, with no window open.
  const later = at({ currentMinutesWatched: 20, currentWindow: null, nextEligibleAt: new Date(T0 + HOUR).toISOString() });
  assert.deepEqual([later.next, later.watch], [false, 'Each badge: done for today, then 20m on 2 more days']);
  // Twitch's client counts a claimable day as not granted yet: it is done, and needs a claim.
  assert.equal(at({ currentMinutesWatched: 20, status: 'CLAIMABLE' }).watch, 'Each badge: done for today, then 20m on 1 more day');
  // Grants not given: how many days are left is not known, today's minutes are.
  assert.equal(at({ currentMinutesWatched: 5, grantCount: null }).watch, 'Each badge: watch 20m on 3 days, 5 of 20 min today');
  assert.equal(at({ currentMinutesWatched: 0, grantCount: 0, currentWindow: null }).watch, 'Each badge: watch 20m on 3 days');
  assert.deepEqual([at({ grantCount: 3 }).watch, at({ grantCount: 3 }).next], ['Watch time reached', false]);
  // Not a day: said as times.
  const weekly = evoSeen(T0, (g) => { for (const x of g) x.progressCriteria.repeatableConfig.resetIntervalSeconds = 604800; });
  assert.equal(row(poll(T0), weekly).watch, 'Each badge: watch 20m, 3 times');
});

test('one daily badge done for today and another not: the row says the one that can gain', () => {
  const self = { grantCount: 0, ...window(T0 - HOUR) };
  const groups = [...evoInv({ ...self, currentMinutesWatched: 20, grantCount: 1 }, evoIds.slice(0, 8)), ...evoInv({ ...self, currentMinutesWatched: 5, grantCount: 2 }, evoIds.slice(8))];
  const r = row(poll(T0, { rewardGroups: groups }), evoSeen());
  assert.deepEqual([r.next, r.watch], [true, 'Watch 20m on 1 more day, 5 of 20 min today']);
  assert.deepEqual([r.missing[0].watch, r.missing[8].watch], ['done for today, then 20m on 2 more days', 'watch 20m on 1 more day, 5 of 20 min today']);
});

test('a missing badge done for today does not borrow another reward\'s minutes to be Next', () => {
  // Evolutions' first badge with a 60-minute reward that is not a badge beside it.
  const seen = (now) => evoSeen(now, (g) => {
    g.length = 2;
    g[1].rewards[0].distributionType = 'DIRECT_ENTITLEMENT';
    Object.assign(g[1].progressCriteria, { requirements: { minutesWatched: 60, subs: null }, repeatableConfig: null });
  });
  const once = { id: evoIds[1], progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 60 }, repeatableConfig: null }, self: { status: 'IN_PROGRESS', currentMinutesWatched: 5, grantCount: 0, hasPreconditionsMet: true } };
  const at = (minutes) => row(poll(T0, { rewardGroups: rewardInv({ grantCount: 1, currentMinutesWatched: minutes, ...window(T0 - HOUR) }, { campaignId: EVO.id, groupIds: evoIds.slice(0, 1), required: 20, times: 3, more: once }) }), seen());
  assert.equal(at(5).next, true);
  assert.equal(at(20).next, false);
  // Nor one whose badge only waits to be claimed.
  const claim = { ...osrsSeen()[0], groups: [...osrsSeen()[0].groups, { id: 'x', minutes: 60, times: 1, rewards: [{ id: 'r', name: 'Skin', badge: false }] }] };
  const s = poll(T0, { campaigns: [bones(60, { dropInstanceID: 'x' })] });
  const both = { ...s, active: [...s.active, { id: 'x', campaignId: claim.id, minutes: 5 }] };
  assert.equal(row(both, [claim]).next, false);
});

test('a daily badge too late but done for today: a badge with no reading got those minutes too', () => {
  // Evolutions' first badge, and its second made a once-only one Twitch gives no reading for.
  const now = EVO_END - 2 * HOUR;
  const at = (minutes) => row(poll(now, { rewardGroups: evoInv({ grantCount: 1, currentMinutesWatched: minutes, ...window(now - HOUR) }, evoIds.slice(0, 1)) }), evoSeen(now, (g) => {
    g.length = 2;
    Object.assign(g[1].progressCriteria, { requirements: { minutesWatched: 20, subs: null }, repeatableConfig: null });
  }), now);
  assert.deepEqual([at(20).missing[0].late, at(20).next], [true, false]);
  assert.deepEqual([at(5).missing[0].late, at(5).next], [true, true], 'today not done: it can still gain');
});

test('numbers kept are capped:out of range is unknown', () => {
  const first = (change) => evoSeen(T0, (g) => change(g[0].progressCriteria))[0].groups[0];
  assert.equal(first((c) => { c.requirements.minutesWatched = 1e308; }).minutes, null);
  assert.equal(first((c) => { c.repeatableConfig.repeatableTimes = 1e308; }).times, null);
  assert.equal(first((c) => { c.repeatableConfig.resetIntervalSeconds = 1e308; }).reset, null);
});

test('a daily badge too late: only when even the soonest days do not fit', () => {
  const at = (left, self, change) => {
    const now = EVO_END - left;
    return row(poll(now, { rewardGroups: evoInv({ grantCount: 1, currentWindow: null, currentMinutesWatched: 0, ...self(now) }) }), evoSeen(now, change), now);
  };
  // Two days left, none open: today's 20 minutes, then 20 minutes 24 hours after it started.
  assert.equal(at(DAY + 20 * MIN, () => ({})).late, false);
  const late = at(DAY + 19 * MIN, () => ({}));
  assert.deepEqual([late.late, late.next, late.watch], [true, false, 'Each badge: watch 20m on 2 more days']);
  // The last day needs its minutes, not a whole window.
  assert.deepEqual([at(20 * MIN, () => ({ grantCount: 2 })).late, at(19 * MIN, () => ({ grantCount: 2 })).late], [false, true]);
  // Today done: the next window opens when this one ends.
  const done = (end) => (now) => ({ currentMinutesWatched: 20, grantCount: 2, ...window(now + end - DAY) });
  assert.deepEqual([at(2 * HOUR, done(HOUR)).late, at(2 * HOUR, done(2 * HOUR - 10 * MIN)).late], [false, true]);
  // Today part-way and one more day: after this window ends.
  const part = (end) => (now) => ({ currentMinutesWatched: 5, grantCount: 1, ...window(now + end - DAY) });
  assert.deepEqual([at(2 * HOUR, part(HOUR)).late, at(2 * HOUR, part(2 * HOUR - 10 * MIN)).late], [false, true]);
  // Not known: days granted, a reset, a last-chance rule, a badge that may need only one day.
  assert.equal(at(HOUR, () => ({ grantCount: null })).late, false);
  for (const change of [
    (c) => { c.resetIntervalSeconds = null; },
    (c) => { c.isLastChanceExtensionEnabled = true; },
    (c) => { c.shouldCompleteAllRepeatsToEarn = false; },
  ]) assert.equal(at(HOUR, () => ({}), (g) => { for (const x of g) change(x.progressCriteria.repeatableConfig); }).late, false);
});

test('one badge too late and others not: the row is still finishable, the badge says so', () => {
  const now = EVO_END - HOUR;
  const self = { currentWindow: null, currentMinutesWatched: 0 };
  const groups = [...evoInv({ ...self, grantCount: 2 }, evoIds.slice(0, 8)), ...evoInv({ ...self, grantCount: 0 }, evoIds.slice(8))];
  const r = row(poll(now, { rewardGroups: groups }), evoSeen(now), now);
  assert.deepEqual([r.late, r.next, r.watch], [false, true, 'Each badge: watch 20m on 1 more day']);
  assert.deepEqual(r.missing.filter((m) => m.late).map((m) => m.name), ['Blastoise']);
  // A part that could not be read may be the one that can be finished.
  const cut = evoSeen(now, (g) => { g[8].rewards = null; });
  const all = poll(now, { rewardGroups: evoInv({ ...self, grantCount: 0 }) });
  assert.equal(row(all, cut, now).late, false);
  assert.equal(row(all, evoSeen(now), now).late, true);
});

test('Next is the least slack: the time left minus the watch time, days as whole windows', () => {
  const now = OSRS_END - 5 * DAY; // GTAVI ends 8 hours after OSRS.
  const all = [...osrsSeen(now), ...gtaSeen(now), ...evoSeen(now)];
  // Unknown progress counts as none done: GTAVI's six days put it first, though OSRS ends sooner.
  assert.deepEqual(rows(poll(now), all, now).map((r) => [r.name, r.next]), [['GTAVI Launch Celebration', true], ['OSRS Hardcore Worlds', false], ['Pokemon Evolutions', false]]);
  // Five of six granted: one window, so about 4 days 8 hours against 4 days 23.
  const five = { grantCount: 5, currentWindow: null, currentMinutesWatched: 0 };
  assert.equal(rows(poll(now, { rewardGroups: rewardInv(five) }), all, now)[0].name, 'GTAVI Launch Celebration');
  // Done for today: OSRS is Next, above it.
  const today = { grantCount: 5, currentMinutesWatched: 60, ...window(now - HOUR) };
  assert.deepEqual(rows(poll(now, { rewardGroups: rewardInv(today) }), all, now).map((r) => [r.name, r.next]), [['OSRS Hardcore Worlds', true], ['GTAVI Launch Celebration', false], ['Pokemon Evolutions', false]]);
  // Too late: after the others that can be finished.
  const end = OSRS_END - 10 * MIN;
  const late = rows(poll(end, { campaigns: [bones(1)] }), [...osrsSeen(end), ...evoSeen(end)], end);
  assert.deepEqual(late.map((r) => [r.name, r.next, r.late]), [['Pokemon Evolutions', true, false], ['OSRS Hardcore Worlds', false, true]]);
  for (const list of [rows(poll(now), all, now), late]) assert.equal(list.filter((r) => r.next).length, 1, 'one only');
});

test('a failed, missing or old read never gives Next or too late', () => {
  const now = OSRS_END - 10 * MIN;
  const seen = [...osrsSeen(now), ...evoSeen(now), ...gtaSeen(now)];
  const good = poll(now, { campaigns: [bones(1)] });
  const states = [
    undefined, null, {},
    poll(now, { complete: false, campaigns: [bones(1)] }), // A partial owned list.
    { ...good, rewards: null },
    { ...good, rewards: { ids: [] } },
    update(good, { error: { kind: 'auth', message: 'x' } }, now), // Signed out.
    { ...good, rewards: { ids: [], wholeAt: now - OWNED_FRESH_MS - 1 } },
  ];
  for (const state of states) {
    const list = rows(state, seen, now);
    assert.equal(list.length, 3);
    for (const r of list) assert.deepEqual([r.next, r.late, r.missing.some((m) => m.late)], [false, false, false]);
  }
  // A failed poll keeps what was proven before it.
  assert.equal(rows(update(good, { error: { kind: 'network', message: 'x' } }, now), osrsSeen(now), now)[0].late, true);
});

test('unseen and unknown rows are never Next; with everything owned there is none', () => {
  const directory = { at: T0, triedAt: T0, error: null, campaigns: [{ kind: 'reward', id: EVO.id, name: EVO.name, game: '', owner: '', art: null, startAt: null, endAt: EVO_END, minutes: 20, sitewide: true, rewards: ['Haunter'], linkUrl: null }] };
  const [unseen] = rows(poll(T0), [], T0, { directory });
  assert.deepEqual([unseen.kind, unseen.next, unseen.watch, unseen.late], ['unseen', false, '', false]);
  const night = seenOf(item([NIGHT]), '509658');
  const listed = { ...directory, campaigns: [{ ...directory.campaigns[0], id: NIGHT.id, name: NIGHT.name }] };
  const [unknown] = rows(poll(T0), night, T0, { directory: listed });
  assert.deepEqual([unknown.kind, unknown.next, unknown.watch], ['unknown', false, 'Watch 20m on 3 days']);
  // Only the chest is left to tell: unknown, whatever its progress.
  const left = { ...poll(T0, { owned: [IGUANA], rewardGroups: rewardInv() }) };
  assert.deepEqual([row(left, gtaSeen()).kind, row(left, gtaSeen()).next], ['unknown', false]);
  assert.deepEqual(rows(poll(T0, { owned: [IGUANA] }), gtaSeen(), T0, { claimed: [{ campaignId: GTA, groupId: DVD, endAt: T0 + DAY }] }), []);
});

test('an entry stored by the version before shows no watch time and is not Next', () => {
  const strip = (seen) => seen.map((c) => ({ ...c, groups: c.groups.map(({ id, rewards }) => ({ id, rewards })) }));
  const now = OSRS_END - 10 * MIN;
  const state = poll(now, { campaigns: [bones(1)] });
  const old = row(state, strip(osrsSeen(now)), now);
  assert.deepEqual([old.kind, old.status, old.watch, old.next, old.late], ['missing', 'Not earned yet', '', false, false]);
  // Seen again: replaced at once, whatever its age.
  const merged = mergeSeenBadges(strip(osrsSeen(now)), parseSeenBadges(osrsFx.channelCampaigns, '459931', now), now + MIN);
  assert.equal(merged[0].groups[0].minutes, 60);
  // And damaged fields are unknown, not a crash.
  for (const bad of [{ minutes: 'x' }, { minutes: -1 }, { minutes: NaN }, { times: 'x' }, { times: 0 }, { minutes: 1e999, times: 1 }]) {
    const seen = osrsSeen(now).map((c) => ({ ...c, groups: c.groups.map((g) => ({ ...g, ...bad })) }));
    assert.deepEqual([row(state, seen, now).watch, row(state, seen, now).next], ['', false]);
  }
});

test('a drop waiting to be claimed is not something to watch', () => {
  const r = row(poll(T0, { campaigns: [bones(60, { dropInstanceID: 'x' })] }), osrsSeen());
  assert.deepEqual([r.watch, r.next, r.late], ['Watch time reached', false, false]);
});

test('a window read before the channel was closed still says today is done', () => {
  const start = T0 - HOUR;
  const first = poll(T0, { rewardGroups: evoInv({ grantCount: 1, currentMinutesWatched: 20, ...window(start) }) });
  const later = T0 + REWARD_HOLD_MS + MIN; // The tracker's own hold is over, and nothing is asked.
  const next = poll(later, { prev: first });
  assert.equal(next.rewardInv, null);
  assert.equal(row(next, evoSeen(), later).next, false);
  assert.equal(row(next, evoSeen(), later).watch, 'Each badge: done for today, then 20m on 2 more days');
  // A failed answer changes nothing; a good one replaces it whole; a sign-out forgets it.
  assert.equal(row(poll(later, { prev: first, rewardGroups: null }), evoSeen(), later).next, false);
  const replaced = poll(later, { prev: first, rewardGroups: [] });
  assert.deepEqual([row(replaced, evoSeen(), later).watch, row(replaced, evoSeen(), later).next], ['Each badge: watch 20m on 3 days', true]);
  const out = poll(later + MIN, { prev: update(first, { error: { kind: 'auth', message: 'x' } }, later) });
  assert.equal(row(out, evoSeen(), later + MIN).watch, 'Each badge: watch 20m on 3 days');
});

test('another account signing in forgets the last one\'s progress, with no signed-out poll between', () => {
  const start = T0 - HOUR;
  const first = poll(T0, { rewardGroups: evoInv({ grantCount: 1, currentMinutesWatched: 20, ...window(start) }) });
  const later = T0 + MIN;
  const obs = (over) => ({ campaigns: [], rewards: { ids: [], complete: true }, session: null, sessions: [], streams: [], ...over });
  const shown = (s) => row(s, evoSeen(), later);
  assert.equal(shown(update(first, obs(), later)).watch, 'Each badge: done for today, then 20m on 2 more days', 'the same account keeps it');
  const other = update(first, obs({ accountChanged: true }), later);
  assert.deepEqual([other.rewardSeen, shown(other).watch], [null, 'Each badge: watch 20m on 3 days']);
  // Their own answer in that same poll is theirs, and kept.
  const groups = evoInv({ grantCount: 2, currentMinutesWatched: 0, currentWindow: null });
  assert.equal(shown(update(first, obs({ accountChanged: true, rewardGroups: groups }), later)).watch, 'Each badge: watch 20m on 1 more day');
  // A failed first poll, or one without a whole owned list, says nothing from the last account's.
  const failed = update(first, { error: { kind: 'network', message: 'x' }, accountChanged: true }, later);
  assert.deepEqual([failed.rewardSeen, failed.rewards.wholeAt, shown(failed).kind], [null, null, 'unknown']);
  const partial = update(first, obs({ accountChanged: true, rewards: { ids: [], complete: false } }), later);
  assert.deepEqual([partial.rewards.wholeAt, shown(partial).kind], [null, 'unknown']);
  assert.equal(update(undefined, obs({ accountChanged: true }), later).rewardSeen ?? null, null, 'with nothing stored yet');
});

test('the login is compared by a fingerprint that does not hold it', async () => {
  const token = 'abcdefghij0123456789klmnopqrst';
  const print = await loginPrint(token);
  assert.match(print, /^[0-9a-f]{16}$/);
  assert.equal(await loginPrint(token), print);
  assert.notEqual(await loginPrint(`${token}x`), print);
});

test('"Close <channel> first" while another channel is earning',() => {
  // Charlie credited on OSRS; Evolutions is Next or OSRS is, by what is owned.
  const channel = { id: '20000012', login: 'charlie', displayName: 'Charlie', live: true, unknown: false, subOnly: false, badges: [], campaigns: [{ id: osrsFx.inventory.id, name: 'OSRS Hardcore Worlds', benefitIds: [], channelOwned: false, rewardCampaign: false, game: 'Old School RuneScape', endAt: osrsFx.inventory.endAt, watchDrops: [{ id: BONES, required: 60, benefitIds: [] }] }] };
  const streams = [{ tabId: 1, login: 'charlie', channel, tab: {}, player: { hasVideo: true, paused: false, currentTime: 10, readyState: 4, muted: false, hidden: false } }];
  const session = (minutes) => [{ login: 'charlie', displayName: 'Charlie', dropId: BONES, minutes, required: 60 }];
  const at = (minutes, now, prev, over = {}) => poll(now, { prev, campaigns: [bones(minutes)], streams, sessions: session(minutes), ...over });
  let s = at(1, T0);
  s = at(2, T0 + MIN, s);
  const now = T0 + MIN;
  assert.equal(s.verdict.code, 'earning');
  const evo = evoSeen();
  assert.equal(closeFirst(rows(s, evo, now), s), 'Close Charlie first: Twitch counts one channel at a time.');
  assert.equal(closeFirst(rows(s, osrsSeen(), now), s), '', 'it is earning the Next badge');
  assert.equal(closeFirst(rows(s, [], now), s), '', 'nothing is Next');
  // Evolutions offered on the same channel: whether its minutes rise there too is not known.
  const both = { ...s, streams: s.streams.map((x) => ({ ...x, campaignIds: [...x.campaignIds, EVO.id] })) };
  assert.equal(closeFirst(rows(both, evo, now), both), '');
  // Not earning, not read, not open here, or no channel named.
  for (const state of [
    { ...s, verdict: { code: 'stalled', since: T0 } }, { ...s, verdict: { code: 'waiting', since: T0 } }, { ...s, verdict: null },
    update(s, { error: { kind: 'network', message: 'x' } }, now), { ...s, streams: [] }, { ...s, session: null }, null, undefined,
  ]) assert.equal(closeFirst(rows(s, evo, now), state), '');
  assert.equal(closeFirst(null, s), '');
  assert.equal(closeFirst([null, {}], s), '');
});

test('two categories, or one badge in two groups: one row, one Next', () => {
  const c = structuredClone(EVO);
  c.rewardGroups.forEach((g, i) => { g.progressCriteria.categories = [{ id: String(i % 2), displayName: `Game ${i % 2}` }]; });
  const r = row(poll(T0), seenOf(item([c]), '1'));
  assert.deepEqual([r.next, r.watch, r.where], [true, 'Each badge: watch 20m on 3 days', 'Also counts in 1 other category.']);
  // Two groups giving one badge: owned through either one, it leaves nothing open.
  const twice = structuredClone(EVO);
  twice.rewardGroups = twice.rewardGroups.slice(0, 2);
  twice.rewardGroups[1].rewards = structuredClone(twice.rewardGroups[0].rewards);
  const seen = seenOf(item([twice]), '509658');
  assert.deepEqual(rows(poll(T0, { owned: [twice.rewardGroups[0].rewards[0].id] }), seen), []);
  assert.equal(row(poll(T0), seen).watch, 'Watch 20m on 3 days', 'one badge, so not "each"');
});

test('an account that owns nothing: named as such it has a Next, unreadable it has none', () => {
  const seen = [...osrsSeen(), ...evoSeen()];
  assert.equal(rows(poll(T0, { owned: [], complete: true }), seen).filter((r) => r.next).length, 1);
  assert.equal(rows(poll(T0, { owned: [], complete: false }), seen).filter((r) => r.next).length, 0);
});

test('an ended campaign has no row, so nothing is Next', () => {
  assert.deepEqual(rows(poll(OSRS_END), osrsSeen(), OSRS_END), []);
  assert.equal(closeFirst(rows(poll(OSRS_END), osrsSeen(), OSRS_END), poll(OSRS_END)), '');
});
