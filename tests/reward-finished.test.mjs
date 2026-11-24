// A reward campaign finishing while its tab is open (2026-11-23, GTAVI's sixth day, read from the
// extension's own stored checks). For the two checks after Twitch's session ended the verdict was
// "Earning" on no channel: the panel said "Minutes are rising from a stream outside this browser",
// the toolbar showed another campaign's percentage in green, and then "Not earning". Nothing said
// it was finished. Each poll below is one stored check, at its own time, with the names replaced:
// foxtrot is the reward channel (in the background), echo_247 a channel with no Drops in front.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchSnapshot } from '../extension/lib/twitch.js';
import { badge, events, warning, rewardsDone, rewardsCounting, REWARDS_DONE_MAX } from '../extension/lib/tracker.js';
import { channelDrops, chipView } from '../extension/lib/chip.js';
import { verdictText } from '../extension/lib/panel.js';
import { verdictTone, TONE_COLORS, MAX_REWARD_GROUPS } from '../extension/lib/states.js';
import { debugRows } from '../extension/lib/debug.js';
import { update } from './invariants.mjs';

const reward = JSON.parse(readFileSync(new URL('./fixtures/reward-campaign-2026-11-19.json', import.meta.url))).channel;
const invFx = JSON.parse(readFileSync(new URL('./fixtures/reward-inventory-2026-11-19.json', import.meta.url))).answer;
const GTA = reward.viewerDropCampaigns[0];
const listed = JSON.parse(readFileSync(new URL('./fixtures/channel-campaigns-2026-11-19.json', import.meta.url))).answer.data.channelDropCampaigns.find((c) => c.id === GTA.id);
const DVD = '2283245e-d15c-11f1-8cdd-0a58a9feac02';
const ULTIMATE = 'c7e4cd08-d18f-11f1-a716-0a58a9feac02';
const IGUANA = '8aada31e-d18c-11f1-a5bd-0a58a9feac02';
const WINDOW_END = 1795554461000; // As stored: the sixth day's window.
const FINISHED = 'Campaign finished';
const DETAIL = `You have earned every watch reward in ${GTA.name}.`;
const at = (clock) => Date.parse(`2026-11-23T${clock}Z`);
const CLAIMED = [DVD, ULTIMATE].map((groupId) => ({ campaignId: GTA.id, groupId, endAt: Date.parse(GTA.endAt), at: at('22:06:57') }));

// dvd: the group's minutes, or null once it left the reward inventory. total: the session's number.
const CAPTURED = [
  { t: '22:04:56', dvd: 57, total: 1321 },
  { t: '22:05:56', dvd: 58, total: 1322 },
  { t: '22:06:51', dvd: 59, total: 1323 },
  { t: '22:06:56', dvd: null, total: 1324, owned: true },
  { t: '22:07:01', dvd: null, total: 1324, owned: true, claimed: CLAIMED },
  { t: '22:07:24', dvd: null, total: 1324, owned: true, claimed: CLAIMED },
  { t: '22:07:56', dvd: null, total: null, owned: true, claimed: CLAIMED },
  { t: '22:08:56', dvd: null, total: null, owned: true, claimed: CLAIMED },
  { t: '22:09:56', dvd: null, total: null, owned: true, claimed: CLAIMED },
];

// Another game's drop, part done and not being watched, as it was in the capture (42 of 60).
const otherGame = (minutes) => ({
  id: 'other-campaign', name: 'Other Game Drops', status: 'ACTIVE', startAt: '2026-11-20T00:00:00Z', endAt: '2026-12-11T00:00:00Z',
  game: { name: 'Other Game' }, imageURL: null, self: { isAccountConnected: true },
  timeBasedDrops: [{ id: 'other-drop', name: 'Other Drop', requiredMinutesWatched: 60, startAt: '2026-11-20T00:00:00Z', endAt: '2026-12-11T00:00:00Z', benefitEdges: [{ benefit: { id: 'other-benefit', name: 'Other Drop' } }], self: { currentMinutesWatched: minutes, isClaimed: false, hasPreconditionsMet: true, dropInstanceID: null } }],
});

function twitchAt({ dvd, total, owned = false, other = 42, grants = 5, live = true, invFails = false, echoEarns = false, pad = false, extra = false, sessionDrop = DVD, dismissed = false, echoLive = true, echoSession = null }) {
  const inv = structuredClone(invFx);
  const list = inv.data.currentUser.inventory.viewerRewardDropCampaignsInProgress;
  list.splice(0, 1); // The channel badge of that capture: not part of this one.
  if (dvd == null) list.splice(0, 1);
  else {
    const self = list[0].rewardGroups.find((g) => g.id === DVD).self;
    Object.assign(self, { currentMinutesWatched: dvd, grantCount: grants, currentWindow: { startedAt: new Date(WINDOW_END - 86400000).toISOString(), expiresAt: new Date(WINDOW_END).toISOString() } });
  }
  if (pad) {
    const rewardGroups = Array.from({ length: MAX_REWARD_GROUPS }, (_, i) => ({ id: `pad-${i}`, progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 60 } }, self: { status: 'IN_PROGRESS', currentMinutesWatched: 1 } }));
    list.push({ id: 'pad', rewardGroups });
  }
  const here = structuredClone(reward);
  if (extra) here.viewerDropCampaigns.push({ ...otherGame(0), id: 'extra-campaign', game: { id: '9', displayName: 'Extra Game' }, timeBasedDrops: [{ ...otherGame(0).timeBasedDrops[0], id: 'extra-drop' }] });
  const echoList = echoEarns ? [{ ...otherGame(other), details: null }] : null;
  return async (_url, { body }) => ({
    ok: true,
    status: 200,
    json: async () => JSON.parse(body).map((o) => {
      const isEcho = o.variables?.channel === 'echo_247' || o.variables?.channelID === '2';
      switch (o.operationName) {
        case 'Inventory': return { data: { currentUser: { inventory: { dropCampaignsInProgress: [otherGame(other)], gameEventDrops: owned ? [{ id: IGUANA }] : [] } } } };
        case 'VideoPlayerStreamInfoOverlayChannel': return { data: { user: { id: isEcho ? '2' : '1', displayName: isEcho ? 'echo_247' : 'Foxtrot', stream: (isEcho ? echoLive : live) ? { id: 's' } : null, broadcastSettings: { game: { id: '1867279146' } } } } };
        case 'DropsHighlightService_AvailableDrops': return { data: { channel: isEcho ? { viewerDropCampaigns: echoList } : dismissed ? { viewerDropCampaigns: [] } : here } };
        case 'ChannelDropsCampaigns': return { data: { channelDropCampaigns: dismissed && !isEcho ? [{ ...structuredClone(listed), hasViewerDismissedHighlight: true }] : null } };
        case 'ViewerRewardDropInventory': return invFails ? { errors: [{ message: 'service error' }], data: null } : inv;
        case 'DropCurrentSessionContext': return { data: { currentUser: { dropCurrentSession: isEcho && echoSession != null ? { channel: { id: '2', name: 'echo_247', displayName: 'echo_247' }, dropID: 'other-drop', currentMinutesWatched: echoSession, requiredMinutesWatched: 60, game: null } : isEcho || total == null ? null : { channel: { id: '1', name: 'foxtrot', displayName: 'Foxtrot' }, dropID: sessionDrop, currentMinutesWatched: total, requiredMinutesWatched: 60, game: null } } } };
        default: throw new Error(o.operationName);
      }
    }),
  });
}

async function run(polls, from) {
  let s = from;
  const out = [];
  for (const [i, p] of polls.entries()) {
    const now = at(p.t);
    const snap = await fetchSnapshot('t', ['echo_247', 'foxtrot'], twitchAt(p), {}, { askRewards: true, now });
    const player = { hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: 100 + i * 60 };
    const streams = p.echoClosed ? [] : [{ tabId: 1, login: 'echo_247', channel: snap.channels.echo_247, tab: {}, player: { ...player, hidden: false } }];
    if (p.home) streams.push({ tabId: 3, login: null, channel: null, tab: {}, player: null });
    if (!p.closed) streams.push({ tabId: 2, login: 'foxtrot', channel: snap.channels.foxtrot, tab: {}, player: { ...player, hidden: true } });
    const obs = { ...snap, dayRewards: [], claimedGroups: p.claimed || [], streams };
    const prev = s;
    s = update(s, obs, now);
    // As storage holds it between checks: nothing may depend on an object staying alive.
    s = JSON.parse(JSON.stringify(s));
    out.push({ t: p.t, s, now, fired: events(prev, s, now) });
  }
  return out;
}

/** Everything a user can see. */
const views = ({ s, now }) => ({
  headline: verdictText(s, now)[0],
  detail: verdictText(s, now)[1],
  tone: verdictTone(s.verdict),
  toolbar: badge(s, { claimReminders: false }).text,
  chip: chipView(s, now, 'foxtrot'),
  secondTab: chipView(s, now, 'echo_247'),
  popupDrops: channelDrops(s).drops.map((d) => d.name),
  state: s.streams.find((x) => x.login === 'foxtrot')?.channelState ?? null,
  warning: warning(s, now),
});
const earned = (polls) => polls.flatMap((p) => p.fired).filter((e) => e.type === 'earned');
const byTime = (polls, t) => polls.find((p) => p.t === t);

test('the captured checks: earning while Twitch counts, the states as stored', async () => {
  const polls = await run(CAPTURED);
  assert.deepEqual(polls.map((p) => p.s.streams[1].channelState), ['reward', 'reward', 'reward', 'reward', 'reward', 'reward', 'finished', 'finished', 'finished']);
  for (const p of polls.slice(1, 6)) assert.deepEqual([p.s.verdict.code, p.s.verdict.channel], ['earning', 'Foxtrot'], p.t);
});

test('finished on every view, from the first check after the session ends', async () => {
  const polls = await run(CAPTURED);
  for (const t of ['22:07:56', '22:08:56', '22:09:56']) {
    const v = views(byTime(polls, t));
    assert.deepEqual([v.headline, v.detail, v.tone], [FINISHED, DETAIL, 'idle'], t);
    assert.doesNotMatch(v.detail, /outside this browser/, t);
    assert.equal(v.toolbar, '', `${t}: not another campaign's percentage`);
    assert.deepEqual(v.popupDrops, [], `${t}: nothing is rising`);
    assert.deepEqual([v.chip.text, v.chip.pct, v.chip.tone, v.chip.title], ['Drops', null, 'idle', DETAIL], t);
    assert.deepEqual([v.secondTab.text, v.secondTab.pct, v.secondTab.tone], ['Drops', null, 'idle'], t);
    assert.deepEqual([v.state, v.warning], ['finished', null], t);
  }
  assert.equal(badge(byTime(polls, '22:07:56').s, {}).color, TONE_COLORS.idle);
  assert.match(debugRows({ state: polls.at(-1).s }, at('22:09:56')).find((r) => r.label === 'Verdict').value, /rewardDone/);
});

test('one notification, when it is finished and not again', async () => {
  const polls = await run([...CAPTURED, { ...CAPTURED.at(-1), t: '22:10:56' }, { ...CAPTURED.at(-1), t: '22:11:56' }]);
  assert.deepEqual(earned(polls).map((e) => [e.title, e.message]), [[FINISHED, DETAIL]]);
  assert.deepEqual(polls.flatMap((p) => p.fired).filter((e) => e.type === 'warning'), [], 'good news is not a warning');
});

test('finished long before the extension saw it: today\'s text, and nothing is announced', async () => {
  const polls = await run(CAPTURED.slice(6));
  const v = views(polls.at(-1));
  assert.deepEqual([v.state, v.headline, v.detail], ['finished', 'Not earning', 'None of your open streams have Drops you need.']);
  assert.deepEqual(earned(polls), []);
});

test('no proof, no claim: gone from the inventory without being claimed is not finished', async () => {
  const polls = await run(CAPTURED.map((p) => ({ ...p, claimed: [] })));
  assert.ok(polls.every((p) => p.s.streams[1].channelState !== 'finished'));
  assert.ok(polls.every((p) => p.s.verdict.rewardDone !== true));
  assert.deepEqual(earned(polls), []);
  // One group short of claimed.
  const short = await run(CAPTURED.map((p) => ({ ...p, owned: false, claimed: p.claimed && p.claimed.slice(0, 1) })));
  assert.deepEqual(earned(short), []);
});

test('proof that arrives late still says it, once', async () => {
  const late = CAPTURED.map((p, i) => ({ ...p, claimed: i < 8 ? [] : CLAIMED }));
  const polls = await run(late);
  assert.equal(views(polls.at(-1)).headline, FINISHED);
  assert.equal(earned(polls).length, 1);
});

test('a claimed flag while the reward inventory still counts it is not finished', async () => {
  // A stale flag: another account's, say. Rising minutes win, as everywhere else.
  const polls = await run(CAPTURED.slice(0, 3).map((p) => ({ ...p, owned: true, claimed: CLAIMED })));
  assert.ok(polls.every((p) => p.s.streams[1].channelState === 'reward'));
  assert.deepEqual(earned(polls), []);
});

test('the same with today\'s drop done and the next day still to come', async () => {
  // Day five as stored on 2026-11-23: 60 of 60, 5 of 6 granted, nothing in progress until tomorrow.
  const polls = await run(CAPTURED.slice(0, 3).map((p) => ({ ...p, dvd: 60, total: null, owned: true, claimed: CLAIMED })));
  assert.ok(polls.every((p) => p.s.streams[1].channelState === 'reward'));
  assert.deepEqual(earned(polls), []);
});

test('the channel has another campaign Twitch has not started: the channel is not finished', async () => {
  const more = ['22:10:56', '22:11:56', '22:12:56', '22:13:56'].map((t) => ({ ...CAPTURED.at(-1), t }));
  const polls = await run([...CAPTURED, ...more].map((p) => ({ ...p, extra: true })));
  assert.deepEqual([views(byTime(polls, '22:07:56')).headline, views(byTime(polls, '22:08:56')).headline], ['Checking', 'Checking'], 'never a stream outside this browser');
  assert.equal(polls.at(-1).s.streams[1].channelState, 'unstarted');
  assert.equal(views(polls.at(-1)).headline, 'Not counting yet');
  assert.equal(earned(polls).length, 1, 'the reward campaign itself is still announced');
});

test('a failed reward inventory says nothing about leaving it', async () => {
  const polls = await run([...CAPTURED.slice(0, 3), { ...CAPTURED[3], invFails: true, claimed: CLAIMED }, { ...CAPTURED[4], invFails: true }]);
  assert.deepEqual(earned(polls), []);
});

test('the reward inventory call failing as the session ends: the last good answer already left it out', async () => {
  // That call fails on about half of real polls.
  for (const t of ['22:07:24', '22:07:56', '22:08:56']) {
    const polls = await run(CAPTURED.map((p) => ({ ...p, invFails: p.t === t })));
    const v = views(byTime(polls, '22:07:56'));
    assert.deepEqual([v.headline, v.detail], [FINISHED, DETAIL], t);
    assert.equal(earned(polls).length, 1, t);
  }
  // Failing since before it left: the last good answer still lists it, and later there is none.
  const never = await run(CAPTURED.map((p, i) => ({ ...p, invFails: i >= 3 })));
  assert.deepEqual(earned(never), []);
});

test('the highlight dismissed, so only ChannelDropsCampaigns lists it: the same', async () => {
  const polls = await run(CAPTURED.map((p) => ({ ...p, dismissed: true })));
  const v = views(byTime(polls, '22:07:56'));
  assert.deepEqual([v.state, v.headline, v.detail, v.toolbar, v.popupDrops.length], ['finished', FINISHED, DETAIL, '', 0]);
  assert.equal(earned(polls).length, 1);
});

// Later: another tab earning its own drop, with the finished tab still open.
const LATER = [1, 2, 3, 4].map((i) => ({ ...CAPTURED.at(-1), t: `22:1${i}:56`, echoEarns: true, other: 42 + i, echoSession: 42 + i }));

test('another tab that was earning since stops: its own story, not the finished campaign\'s', async () => {
  const after = (over) => ['22:15:56', '22:16:56', '22:17:56', '22:18:56'].map((t) => ({ ...CAPTURED.at(-1), t, other: 46, ...over }));
  // Its channel changed game while the session keeps naming it.
  const game = await run([...CAPTURED, ...LATER, ...after({ echoSession: 46 })]);
  assert.equal(views(byTime(game, '22:13:56')).headline, 'Earning on echo_247');
  assert.equal(views(game.at(-1)).headline, 'Stopped earning');
  assert.equal(views(game.at(-1)).warning?.title, 'Stopped earning Drops');
  // The session gone with it: offline, or a game with no Drops. The finished tab is not the one that
  // was earning, and only that one can make stopping a good outcome.
  for (const over of [{ echoEarns: true, echoLive: false }, {}]) {
    const polls = await run([...CAPTURED, ...LATER, ...after(over)]);
    const v = views(polls.at(-1));
    assert.deepEqual([v.headline, v.warning?.title], ['Stopped earning', 'Stopped earning Drops'], JSON.stringify(over));
    assert.equal(polls.flatMap((p) => p.fired).filter((e) => e.type === 'warning').length, 1, 'once');
  }
});

test('which channel was earning is not known: a finished tab still means done, beside a Twitch page with no channel', async () => {
  // State saved by an older version, with the session already gone.
  const { s } = (await run([...CAPTURED, ...LATER])).at(-1);
  const old = { ...s, session: null, lastGainLogin: undefined };
  for (const saved of [old, { ...old, lastGainLogin: null }]) {
    const [p] = await run([{ ...CAPTURED.at(-1), t: '22:17:56', other: 46, home: true }], { ...saved, lastPollAt: at('22:16:56'), lastOkAt: at('22:16:56'), lastGainAt: at('22:14:56') });
    assert.deepEqual([views(p).headline, views(p).warning], ['Not earning', null]);
  }
});

test('finishing with a tab open that could earn earlier and no longer can: finished, not "Stopped earning"', async () => {
  // echo_247 could earn before Foxtrot was credited, and went offline with its tab left open.
  const before = ['22:01:56', '22:02:56'].map((t) => ({ ...CAPTURED[0], t, dvd: 55, total: 1319, echoEarns: true }));
  const polls = await run([...before, ...CAPTURED.map((p) => ({ ...p, echoEarns: true, echoLive: false }))]);
  for (const t of ['22:07:56', '22:08:56', '22:09:56']) {
    const v = views(byTime(polls, t));
    assert.deepEqual([v.headline, v.warning], [FINISHED, null], t);
  }
});

test('another tab that was earning is left, finished tab open: says which one was left', async () => {
  const left = ['22:15:56', '22:16:56'].map((t) => ({ ...CAPTURED.at(-1), t, other: 46, echoClosed: true }));
  const polls = await run([...CAPTURED, ...LATER, ...left]);
  assert.match(views(polls.at(-1)).detail, /You left echo_247/);
  // The same for one that could earn and never did.
  const idle = ['22:10:56', '22:11:56'].map((t) => ({ ...CAPTURED.at(-1), t, echoEarns: true }));
  const never = await run([...CAPTURED, ...idle, { ...CAPTURED.at(-1), t: '22:12:56', echoClosed: true }]);
  assert.match(views(never.at(-1)).detail, /You left echo_247/);
});

test('minutes rising after it: earning again, and from outside this browser still says so', async () => {
  const after = { dvd: null, total: null, owned: true, claimed: CLAIMED };
  const polls = await run([...CAPTURED, { ...after, t: '22:10:56', other: 43 }, { ...after, t: '22:11:56', other: 43 }, { ...after, t: '22:12:56', other: 44 }]);
  for (const t of ['22:10:56', '22:11:56', '22:12:56']) {
    const v = views(byTime(polls, t));
    assert.deepEqual([v.headline, v.detail], ['Earning', 'Minutes are rising from a stream outside this browser.'], `${t}: a quiet check between two rises must not flicker`);
  }
});

test('a gain from elsewhere just before it finished keeps saying earning', async () => {
  // Other Game rises on another device in the same checks, so the last minute was not foxtrot's.
  const polls = await run(CAPTURED.map((p, i) => ({ ...p, other: i >= 6 ? 43 : 42 })).slice(0, 8));
  assert.equal(views(polls.at(-1)).headline, 'Earning');
});

test('another drop rising on the finished channel: earning, through quiet checks and once its session goes', async () => {
  // The finish is older than that gain, so it says nothing about it.
  const rises = [['22:10:56', 5], ['22:11:56', 6], ['22:12:56', 6]].map(([t, total]) => ({ ...CAPTURED.at(-1), t, total, sessionDrop: 'extra-drop', extra: true }));
  const polls = await run([...CAPTURED.map((p) => ({ ...p, extra: true })), ...rises, { ...CAPTURED.at(-1), t: '22:13:26', extra: true }]);
  for (const t of ['22:11:56', '22:12:56', '22:13:26']) assert.equal(byTime(polls, t).s.verdict.code, 'earning', t);
});

test('its tab closed: no headline about a channel that is not open', async () => {
  const polls = await run([...CAPTURED, { ...CAPTURED.at(-1), t: '22:10:56', closed: true }, { ...CAPTURED.at(-1), t: '22:14:56', closed: true }]);
  assert.notEqual(views(polls.at(-1)).headline, FINISHED);
});

test('no minute since: the headline stays while its tab is open', async () => {
  const later = ['22:30:56', '23:00:56', '23:30:56'].map((t) => ({ ...CAPTURED.at(-1), t }));
  const polls = await run([...CAPTURED, ...later]);
  for (const x of later) assert.equal(views(byTime(polls, x.t)).headline, FINISHED, x.t);
});

test('the channel goes offline after: offline, not finished', async () => {
  const polls = await run([...CAPTURED, { ...CAPTURED.at(-1), t: '22:10:56', live: false }, { ...CAPTURED.at(-1), t: '22:14:56', live: false }]);
  assert.notEqual(views(polls.at(-1)).headline, FINISHED);
});

test('announced only once Twitch\'s session has let go of it', async () => {
  const polls = await run(CAPTURED);
  assert.deepEqual(polls.filter((p) => earned([p]).length).map((p) => p.t), ['22:07:56']);
  // The session reading a number under the requirement still lists it as a drop in progress.
  const under = await run(CAPTURED.map((p, i) => (i < 4 ? p : { ...p, total: 30, claimed: CLAIMED })));
  assert.deepEqual(earned(under), []);
});

test('another tab that can earn: its headline, not this one\'s', async () => {
  const polls = await run(CAPTURED.map((p) => ({ ...p, echoEarns: true })));
  const v = views(byTime(polls, '22:07:56'));
  assert.equal(v.headline, 'Earning');
  assert.doesNotMatch(v.detail, /outside this browser/);
  assert.equal(earned(polls).length, 1, 'still announced');
});

test('a reward inventory cut short at its cap says nothing about what it leaves out', async () => {
  const polls = await run(CAPTURED.map((p, i) => ({ ...p, pad: i >= 3 })));
  assert.deepEqual(earned(polls), []);
});

test('counting again after it: the headline goes, and it is not announced a second time', async () => {
  const again = { dvd: 1, grants: 0, total: 1325, owned: true, claimed: [] };
  const polls = await run([...CAPTURED, { ...again, t: '22:10:56' }, { ...CAPTURED.at(-1), t: '22:11:56' }, { ...CAPTURED.at(-1), t: '22:20:56' }]);
  assert.deepEqual(byTime(polls, '22:10:56').s.rewardsDone, []);
  assert.notEqual(views(byTime(polls, '22:10:56')).headline, FINISHED);
  assert.equal(earned(polls).length, 1);
});

test('rewardsCounting: only a reward campaign, and not one already finished', () => {
  const now = at('22:07:56');
  const streams = [{ channel: { campaigns: [{ id: 'r', name: 'R', rewardCampaign: true, endAt: '2026-12-01T00:00:00Z' }, { id: 'badge', name: 'B', rewardCampaign: false, endAt: '2026-12-01T00:00:00Z' }] } }, { channel: null }];
  const groups = [{ campaignId: 'r' }, { campaignId: 'badge' }];
  assert.deepEqual(rewardsCounting(undefined, streams, groups, new Set(), now).map((x) => x.campaignId), ['r']);
  assert.deepEqual(rewardsCounting([{ campaignId: 'r', name: 'R', endsAt: null }], [], groups, new Set(['r']), now), []);
  assert.deepEqual(rewardsCounting(undefined, streams, null, new Set(), now), [], 'no answer');
});

test('rewardsDone and rewardsCounting: bounded, and dropped when the campaign ends', () => {
  const now = at('22:07:56');
  const many = Array.from({ length: REWARDS_DONE_MAX + 5 }, (_, i) => ({ campaignId: `c${i}`, name: `C${i}`, endsAt: now + 1000 }));
  assert.equal(rewardsDone(many, [], new Set(), now).length, REWARDS_DONE_MAX);
  assert.equal(rewardsCounting(many, [], null, new Set(), now).length, REWARDS_DONE_MAX);
  const ended = [{ campaignId: 'c', name: 'C', endsAt: now }];
  assert.deepEqual(rewardsDone(ended, [], new Set(), now), []);
  assert.deepEqual(rewardsCounting(ended, [], null, new Set(), now), []);
  for (const bad of [undefined, null, 'x', [null], [{}]]) {
    assert.deepEqual(rewardsDone(bad, bad, new Set(), now), []);
    assert.deepEqual(rewardsCounting(bad, [], null, new Set(), now), []);
  }
});
