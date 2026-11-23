// A channel whose only campaigns are finished reward campaigns read "Not counting yet", "It may need
// your game account linked" (drops-tracker#17, captured 2026-11-23). Night Out's watch group lists a
// POOL reward, the ball; the owned list held neither its ID nor the ID of the badge it became, so
// "every listed reward is owned" could never be true, while all nine Evolutions rewards (BADGE)
// were owned. What says it is finished is the answer Twitch's own channel page receives
// (DropChannelCampaignsProgress): CLAIMED, 3 of 3. Without that answer, nothing can tell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchSnapshot, parseDayRewards, parseClaimedGroups, mergeClaimedGroups, MAX_CLAIMED_GROUPS } from '../extension/lib/twitch.js';
import { badge, events, warning, STALL_MS } from '../extension/lib/tracker.js';
import { chipView } from '../extension/lib/chip.js';
import { verdictText } from '../extension/lib/panel.js';
import { CHANNEL_STATES, verdictTone } from '../extension/lib/states.js';
import { update } from './invariants.mjs';

const fx = JSON.parse(readFileSync(new URL('./fixtures/pokemon-campaigns-2026-11-23.json', import.meta.url)));
const T0 = Date.parse('2026-11-23T11:30:00Z');
const MIN = 60000;
const NIGHT = fx.list.find((c) => c.name === 'Pokémon Night Out Campaign');
const EVO = fx.list.find((c) => c.name === 'Pokemon Evolutions');
const BALL = NIGHT.rewardGroups[0];
const progressItem = (list = fx.progress) => ({ data: { channelDropCampaignsProgress: structuredClone(list) } });
const claimedFrom = (item = progressItem(), now = T0) => mergeClaimedGroups([], parseClaimedGroups(item), now);

/** Polls through the real client and tracker, as the extension makes them. */
async function poll({ owned = fx.owned, list = fx.list, claimed = [], polls = 6, session = null, groups = [], inFront = true } = {}) {
  let s;
  const seen = [];
  for (let i = 0; i < polls; i++) {
    const now = T0 + i * MIN;
    const answer = (o) => {
      switch (o.operationName) {
        case 'Inventory': return { data: { currentUser: { inventory: { dropCampaignsInProgress: null, gameEventDrops: owned.map((id) => ({ id })) } } } };
        case 'VideoPlayerStreamInfoOverlayChannel': return { data: { user: { id: '1', displayName: 'AlphaTV', stream: { id: 's' }, broadcastSettings: { game: { id: '509658' } } } } };
        case 'DropsHighlightService_AvailableDrops': return { data: { channel: { viewerDropCampaigns: null } } };
        case 'ChannelDropsCampaigns': return { data: { channelDropCampaigns: structuredClone(list) } };
        case 'ViewerRewardDropInventory': return { data: { currentUser: { inventory: { viewerRewardDropCampaignsInProgress: groups } } } };
        default: return { data: { currentUser: { dropCurrentSession: session?.(i) ?? null } } };
      }
    };
    const fetchImpl = async (_url, { body }) => ({ ok: true, status: 200, json: async () => JSON.parse(body).map(answer) });
    const snap = await fetchSnapshot('t', ['alphatv'], fetchImpl, {}, { askRewards: true, now });
    const prev = s;
    s = update(s, { ...snap, dayRewards: [], claimedGroups: claimed, streams: [{ tabId: 1, login: 'alphatv', channel: snap.channels.alphatv, tab: {}, player: { hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: 100 + i * 60, hidden: !inFront } }] }, now);
    seen.push({ s, now, events: events(prev, s, now) });
  }
  return { s, seen, now: T0 + (polls - 1) * MIN };
}
const everyView = ({ s, now, seen }) => ({
  state: s.streams[0].channelState,
  headline: verdictText(s, now)[0],
  detail: verdictText(s, now)[1],
  chip: chipView(s, now, 'alphatv').text,
  chipTitle: chipView(s, now, 'alphatv').title,
  secondTab: chipView(s, now, 'bravo').text,
  tone: verdictTone(s.verdict),
  toolbar: badge(s).text,
  warning: warning(s, now),
  notified: seen.flatMap((x) => x.events).length,
});

test('the capture: only Night Out\'s reward is not owned, and the page\'s answer calls all ten groups claimed', () => {
  const owned = new Set(fx.owned);
  const missing = fx.list.flatMap((c) => c.rewardGroups).filter((g) => !g.rewards.every((r) => owned.has(r.id)));
  assert.deepEqual(missing.map((g) => [g.id, g.rewards[0].distributionType]), [[BALL.id, 'POOL']]);
  assert.equal(owned.has(fx.progress.find((c) => c.id === NIGHT.id).rewardGroups[0].rewards[0].id), false, 'nor the badge it became');
  assert.equal(claimedFrom().length, 10);
});

test('finished reward campaigns, with the page\'s answer: finished on every view', async () => {
  const v = everyView(await poll({ claimed: claimedFrom() }));
  assert.deepEqual(
    [v.state, v.headline, v.detail, v.chip, v.tone, v.toolbar, v.warning, v.notified],
    ['finished', 'Not earning', 'None of your open streams have Drops you need.', 'Drops', 'idle', '', null, 0],
  );
});

test('the same without the page\'s answer: cannot tell on every view, and never linking', async () => {
  const v = everyView(await poll());
  assert.equal(v.state, 'reward_unproven');
  assert.equal(CHANNEL_STATES[v.state].label, 'Cannot tell if finished');
  assert.equal(v.headline, 'Cannot tell if finished');
  assert.match(v.detail, /AlphaTV/);
  assert.match(v.detail, /Pokémon Night Out Campaign/);
  assert.equal(v.chip, 'Drops');
  assert.match(v.chipTitle, /Pokémon Night Out Campaign/);
  assert.equal(v.secondTab, 'Drops');
  for (const text of [v.headline, v.detail, v.chip, v.chipTitle]) assert.doesNotMatch(text, /link|not counting|account/i);
  assert.deepEqual([v.tone, v.toolbar, v.warning, v.notified], ['idle', '', null, 0]);
});

test('a channel just opened still waits for its page\'s answer before saying it cannot tell', async () => {
  const { seen } = await poll();
  for (const x of seen) assert.equal(x.s.verdict.code, x.now - T0 < STALL_MS ? 'waiting' : 'idle', String(x.now));
});

test('not started, not claimed: never finished', async () => {
  // Neither campaign begun, as the page would answer for a new viewer: nothing owned or claimed.
  const fresh = structuredClone(fx.progress);
  for (const g of fresh.flatMap((c) => c.rewardGroups)) g.self = { status: 'IN_PROGRESS', currentMinutesWatched: 0, grantCount: 0 };
  const claimed = claimedFrom(progressItem(fresh));
  assert.deepEqual(claimed, []);
  assert.equal((await poll({ owned: [], claimed })).s.streams[0].channelState, 'reward_unproven');
});

test('one group short of claimed: not finished', async () => {
  const claimed = claimedFrom().filter((x) => x.groupId !== BALL.id);
  assert.equal((await poll({ claimed })).s.streams[0].channelState, 'reward_unproven');
  // The other way round: nothing owned, Evolutions claimed but for one group.
  const short = claimedFrom().filter((x) => x.groupId !== EVO.rewardGroups[4].id);
  assert.equal((await poll({ owned: [], claimed: short })).s.streams[0].channelState, 'reward_unproven');
  assert.equal((await poll({ owned: [], claimed: claimedFrom() })).s.streams[0].channelState, 'finished', 'all ten claimed, none owned');
});

test('owned and claimed add up across one campaign\'s groups', async () => {
  const half = EVO.rewardGroups.slice(0, 5).map((g) => g.rewards[0].id);
  const rest = claimedFrom().filter((x) => x.groupId === BALL.id || EVO.rewardGroups.slice(5).some((g) => g.id === x.groupId));
  assert.equal((await poll({ owned: half, claimed: rest })).s.streams[0].channelState, 'finished');
});

test('minutes rising win over a claimed flag', async () => {
  // A stale flag (another account signed in): the session counts this group, so it is not finished.
  const session = (i) => ({ channel: { name: 'alphatv', displayName: 'AlphaTV' }, dropID: BALL.id, currentMinutesWatched: 3 + i, requiredMinutesWatched: 20 });
  const { s } = await poll({ claimed: claimedFrom(), session });
  assert.equal(s.streams[0].channelState, 'reward');
  assert.equal(s.verdict.code, 'earning');
});

test('the reward inventory listing the group in progress wins over a claimed flag', async () => {
  const groups = [{ id: NIGHT.id, brandName: 'Pokemon', rewardGroups: [{ id: BALL.id, progressCriteria: BALL.progressCriteria, self: { status: 'IN_PROGRESS', currentMinutesWatched: 5, grantCount: 1, hasPreconditionsMet: true, currentWindow: { expiresAt: '2026-11-24T05:00:00Z' } } }] }];
  assert.equal((await poll({ claimed: claimedFrom(), groups })).s.streams[0].channelState, 'reward');
});

test('a game campaign beside it that has not started keeps its own wording', async () => {
  const game = { id: 'game', name: 'Game Drops', brandName: '', startAt: '2026-11-01T00:00:00Z', endAt: '2026-12-31T00:00:00Z', imageURL: null, game: { displayName: 'Some Game' }, rewardGroups: [{ id: 'gd', progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 60 }, repeatableConfig: null, channels: null, categories: [{ id: '509658' }] }, rewards: [{ id: 'gr', name: 'Hat' }] }] };
  const v = everyView(await poll({ list: [...fx.list, game] }));
  assert.equal(v.state, 'unstarted');
  assert.match(v.detail, /may need your game account linked/);
});

test('a reward campaign that names a game keeps the linking hint, and a claimed one is still finished', async () => {
  const list = structuredClone([NIGHT]);
  list[0].game = { displayName: 'Some Game' };
  assert.equal((await poll({ list })).s.streams[0].channelState, 'unstarted');
  assert.equal((await poll({ list, claimed: claimedFrom() })).s.streams[0].channelState, 'finished');
});

test('GTAVI as the highlight answer gives it, its chest a POOL too: never linking', async () => {
  // Captured 2026-11-19 (game "Special Events"). Reading no progress here is inferred, not captured.
  const gta = JSON.parse(readFileSync(new URL('./fixtures/reward-campaign-2026-11-19.json', import.meta.url))).channel;
  const now = Date.parse('2026-11-23T11:30:00Z');
  const answer = (o) => ({
    Inventory: { data: { currentUser: { inventory: { dropCampaignsInProgress: null, gameEventDrops: [] } } } },
    VideoPlayerStreamInfoOverlayChannel: { data: { user: { id: '1', displayName: 'AlphaTV', stream: { id: 's' }, broadcastSettings: { game: { id: '509663' } } } } },
    DropsHighlightService_AvailableDrops: { data: { channel: gta } },
    ChannelDropsCampaigns: { data: { channelDropCampaigns: null } },
    ViewerRewardDropInventory: { data: { currentUser: { inventory: { viewerRewardDropCampaignsInProgress: [] } } } },
    DropCurrentSessionContext: { data: { currentUser: { dropCurrentSession: null } } },
  }[o.operationName]);
  const fetchImpl = async (_url, { body }) => ({ ok: true, status: 200, json: async () => JSON.parse(body).map(answer) });
  const snap = await fetchSnapshot('t', ['alphatv'], fetchImpl, {}, { askRewards: true, now });
  const obs = (claimedGroups) => ({ ...snap, dayRewards: [], claimedGroups, streams: [{ tabId: 1, login: 'alphatv', channel: snap.channels.alphatv, tab: {}, player: { hasVideo: true, readyState: 4, currentTime: 1, hidden: false } }] });
  assert.equal(update(undefined, obs([]), now).streams[0].channelState, 'reward_unproven');
  const [c] = gta.viewerDropCampaigns;
  const flags = c.timeBasedDrops.filter((d) => d.requiredMinutesWatched > 0).map((d) => ({ campaignId: c.id, groupId: d.id, endAt: Date.parse(c.endAt) }));
  assert.equal(update(undefined, obs(flags), now).streams[0].channelState, 'finished');
  assert.equal(update(undefined, obs(flags.slice(0, 1)), now).streams[0].channelState, 'reward_unproven', 'the final reward is not claimed');
});

test('parse: claimed watch groups only, IDs and end date only', () => {
  const { claimed, listed } = parseClaimedGroups(progressItem());
  assert.equal(listed.length, 10);
  assert.deepEqual(claimed.find((x) => x.groupId === BALL.id), { campaignId: NIGHT.id, groupId: BALL.id, endAt: Date.parse(NIGHT.endAt) });
  const kept = JSON.stringify(claimed);
  for (const word of ['grantCount', 'minutes', 'CLAIMED', 'Gastly']) assert.equal(kept.includes(word), false, word);
  // The day names are unchanged by any of it: single-reward groups are still not kept there.
  assert.deepEqual(parseDayRewards(progressItem()), []);
});

test('parse: claimed means every repeat granted, and anything unreadable is not claimed', () => {
  const ball = (change) => {
    const list = structuredClone(fx.progress);
    const c = list.find((x) => x.id === NIGHT.id);
    change(c.rewardGroups[0], c);
    return parseClaimedGroups(progressItem(list)).claimed.some((x) => x.groupId === BALL.id);
  };
  assert.equal(ball(() => {}), true);
  assert.equal(ball((g) => { g.self.grantCount = 2; }), false, 'a day claimed, not the last');
  assert.equal(ball((g) => { g.self.status = 'CLAIMABLE'; }), false);
  assert.equal(ball((g) => { g.self = null; }), false);
  assert.equal(ball((g) => { delete g.self.grantCount; }), false);
  assert.equal(ball((g) => { delete g.progressCriteria.repeatableConfig.repeatableTimes; }), false, 'how many repeats is unknown');
  assert.equal(ball((g) => { g.progressCriteria.requirementType = 'SUB'; }), false);
  assert.equal(ball((g, c) => { c.endAt = 'soon'; }), false, 'no end date: it could never be dropped');
  assert.equal(ball((g, c) => { c.brandName = 'CREATOR_LED_BADGE_CAMPAIGN'; }), false, 'a channel badge is judged by its own rules');
  for (const bad of [null, {}, { data: {} }, { data: { channelDropCampaignsProgress: null } }, { ...progressItem(), errors: [{ message: 'service error' }] }]) {
    assert.equal(parseClaimedGroups(bad), null, JSON.stringify(bad)?.slice(0, 40));
  }
});

test('merge: a fresh answer corrects its own groups, an unreadable one changes nothing', () => {
  const stored = claimedFrom();
  assert.deepEqual(mergeClaimedGroups(stored, null, T0), stored);
  const undone = structuredClone(fx.progress);
  undone.find((c) => c.id === NIGHT.id).rewardGroups[0].self.status = 'IN_PROGRESS';
  const after = mergeClaimedGroups(stored, parseClaimedGroups(progressItem(undone)), T0 + MIN);
  assert.equal(after.some((x) => x.groupId === BALL.id), false, 'another account: the flag goes');
  assert.equal(after.length, 9);
  const other = mergeClaimedGroups(stored, { claimed: [], listed: ['x/y'] }, T0);
  assert.equal(other.length, 10, 'another channel\'s answer says nothing about these');
  assert.equal(mergeClaimedGroups(stored, parseClaimedGroups(progressItem()), T0).length, 10, 'no duplicates');
});

test('merge: ended campaigns go, and the list is bounded with the newest kept', () => {
  assert.deepEqual(mergeClaimedGroups(claimedFrom(), null, Date.parse(NIGHT.endAt)).map((x) => x.campaignId).filter((id) => id === NIGHT.id), []);
  assert.deepEqual(mergeClaimedGroups('garbage', null, T0), []);
  const many = Array.from({ length: MAX_CLAIMED_GROUPS + 20 }, (_, i) => ({ campaignId: 'c', groupId: `g${i}`, endAt: T0 + 86400000 }));
  const out = mergeClaimedGroups(claimedFrom(), { claimed: many, listed: [] }, T0 + MIN);
  assert.equal(out.length, MAX_CLAIMED_GROUPS);
  assert.equal(out.some((x) => x.campaignId === NIGHT.id), false, 'the older ones went first');
});

test('stored flags that are missing or damaged are no proof', async () => {
  for (const claimed of [undefined, null, 'x', [null], [{}], [{ campaignId: NIGHT.id }]]) {
    assert.equal((await poll({ claimed, polls: 2 })).s.streams[0].channelState, 'reward_unproven', JSON.stringify(claimed));
  }
});
