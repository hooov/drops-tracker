// A watch campaign DropsHighlightService_AvailableDrops leaves out without its highlight being
// dismissed (2026-11-22, an Old School RuneScape channel: "RuneScape Bones", 60 min). The highlight
// answer listed only the sub-only campaign, so the channel read "Sub drops only" and My Drops was
// empty while Inventory and the session had RuneScape Bones rising on it. ChannelDropsCampaigns
// lists the watch campaign, its group's categories naming the game the stream is in.
// Placeholders: charlie is that channel, echo_247 a second tab with no drops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchSnapshot } from '../extension/lib/twitch.js';
import { events, badge, warning } from '../extension/lib/tracker.js';
import { update } from './invariants.mjs';
import { chipView, channelDrops } from '../extension/lib/chip.js';
import { badgeSections } from '../extension/lib/badges.js';
import { verdictText } from '../extension/lib/panel.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/highlight-omitted-2026-11-22.json', import.meta.url)));
const MIN = 60000;
const ECHO_ID = '20000011';
const START = Date.parse('2026-11-22T17:30:00Z');
const json = (body) => ({ status: 200, ok: true, json: async () => body });

const BONES_REWARD = 'daa5f04b-e34f-11f1-976b-0a58a9feac02';

/**
 * One poll's Twitch. minutes: RuneScape Bones in Inventory and the session. game: the stream's
 * category. claimed: Bones claimed, still listed. gone: Bones out of Inventory's in-progress list;
 * owned: its reward among the earned ones (assumed ID match, see the fixture). noSession: the
 * session answers null. cdc: a ChannelDropsCampaigns answer in place of the captured one.
 */
function twitchAt({ minutes, echo, game, claimed = false, gone = false, owned = gone, noSession = false, cdc = fx.channelCampaigns, noBroadcastSettings = false, endAt }) {
  const overlay = structuredClone(fx.overlay);
  if (game !== undefined) overlay.data.user.broadcastSettings.game = game;
  if (noBroadcastSettings) delete overlay.data.user.broadcastSettings;
  const campaign = structuredClone(fx.inventory);
  campaign.timeBasedDrops[0].self.currentMinutesWatched = minutes;
  // endAt: the campaign and its drop ending then, in Inventory and the channel's list.
  if (endAt) {
    campaign.endAt = endAt;
    campaign.timeBasedDrops[0].endAt = endAt;
    cdc = structuredClone(cdc);
    for (const c of cdc.data?.channelDropCampaigns || []) c.endAt = endAt;
  }
  if (claimed) Object.assign(campaign.timeBasedDrops[0].self, { isClaimed: true, dropInstanceID: 'USERID#a8ce1281#0cc61e0f' });
  const session = noSession ? null : { ...fx.session, currentMinutesWatched: minutes };
  return async (_url, init) => json(JSON.parse(init.body).map((o) => {
    const isEcho = o.variables?.channel === 'echo_247' || o.variables?.channelID === ECHO_ID;
    switch (o.operationName) {
      case 'Inventory': return { data: { currentUser: { inventory: { dropCampaignsInProgress: gone ? [] : [campaign], gameEventDrops: owned ? [{ id: BONES_REWARD, name: 'RuneScape Bones' }] : [] } } } };
      case 'VideoPlayerStreamInfoOverlayChannel':
        return isEcho ? { data: { user: { id: ECHO_ID, login: 'echo_247', displayName: 'echo_247', stream: { id: '2' } } } } : overlay;
      case 'DropsHighlightService_AvailableDrops': return isEcho ? { data: { channel: { id: ECHO_ID, viewerDropCampaigns: [] } } } : fx.highlight;
      case 'ChannelDropsCampaigns': return isEcho ? { data: { channelDropCampaigns: [] } } : cdc;
      case 'DropCurrentSessionContext': return { data: { currentUser: { dropCurrentSession: isEcho ? null : session } } };
      case 'ViewerRewardDropInventory': return { data: { currentUser: { inventory: { viewerRewardDropCampaignsInProgress: [] } } } };
      default: throw new Error(o.operationName);
    }
  }));
}

async function run(steps) {
  let s;
  const fired = [];
  const said = [];
  for (const [i, step] of steps.entries()) {
    const t = START + i * MIN;
    // noTab: charlie's tab closed this poll.
    const logins = [...(step.noTab ? [] : [fx.login]), ...(step.echo ? ['echo_247'] : [])];
    const snap = await fetchSnapshot('tok', logins, twitchAt(step), {}, { askRewards: true, now: t });
    const player = (base) => ({ hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: base + i * 60 });
    const streams = step.noTab ? [] : [{ tabId: 1, login: fx.login, channel: snap.channels[fx.login], tab: {}, player: player(100) }];
    if (step.echo) streams.push({ tabId: 2, login: 'echo_247', channel: snap.channels.echo_247, tab: {}, player: { ...player(500), hidden: true } });
    const next = update(s, { campaigns: snap.campaigns, rewards: snap.rewards, session: snap.session, sessions: snap.sessions, rewardGroups: snap.rewardGroups, streams }, t);
    const evs = events(s, next, t);
    fired.push(...evs.map((e) => e.type));
    said.push(...evs);
    s = next;
  }
  return { s, fired, said, now: START + (steps.length - 1) * MIN };
}

function views(s, now) {
  const chip = (login) => { const c = chipView(s, now, login); return { pct: c.pct, tone: c.tone }; };
  const echo = s.streams.some((t) => t.login === 'echo_247');
  const tb = badge(s);
  const w = warning(s, now);
  return {
    states: s.streams.map((t) => `${t.login}:${t.channelState}`).join(' '),
    verdict: s.verdict.code,
    cause: s.verdict.cause ?? null,
    wasted: s.verdict.wasted?.reason ?? null,
    headline: verdictText(s, now)[0],
    line: verdictText(s, now)[1],
    toolbar: `${tb.text} ${tb.color}`,
    drops: channelDrops(s, fx.login).drops.map((d) => d.name),
    dropsEcho: echo ? channelDrops(s, 'echo_247').drops.map((d) => d.name) : null,
    chip: chip(fx.login),
    chipEcho: echo ? chip('echo_247') : null,
    badgesTab: badgeSections(s.streams, fx.login, now, s.unplacedBadges).map((x) => x.note || 'campaigns'),
    warning: w ? w.title : null,
  };
}

const steps = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

test('RuneScape Bones rising: tracked on its channel, not "Sub drops only"', async () => {
  const { s, now, fired } = await run(steps(6, (i) => ({ minutes: 1 + i, echo: true })));
  const v = views(s, now);
  assert.deepEqual(fired, [], 'no notification');
  assert.equal(v.states, 'charlie:eligible echo_247:no_drops');
  assert.deepEqual([v.verdict, v.wasted, v.warning], ['earning', null, null]);
  assert.equal(v.headline, 'Earning on Charlie');
  assert.deepEqual(v.drops, ['RuneScape Bones']);
  assert.deepEqual(v.dropsEcho, ['RuneScape Bones'], 'the second tab lists what the open channel can earn');
  // 6 of 60 minutes.
  assert.deepEqual([v.chip.pct, v.chip.tone, v.chipEcho.pct], [10, 'ok', 10]);
  assert.equal(v.toolbar, '10% #067647');
  assert.deepEqual(v.badgesTab, ['No badge drops on this channel.'], 'a game drop, not a channel badge');
});

test('RuneScape Bones flat: a stall, not "Sub drops only"', async () => {
  const mins = [1, 2, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4];
  const { s, now, fired } = await run(mins.map((m) => ({ minutes: m })));
  const v = views(s, now);
  assert.deepEqual(fired, ['warning'], 'one desktop notification');
  assert.equal(v.states, 'charlie:eligible');
  assert.deepEqual([v.verdict, v.cause, v.warning], ['stalled', 'uncounted', 'Drops not counting']);
  assert.equal(v.toolbar, '! #d92d20');
  assert.equal(v.chip.tone, 'bad');
});

// The widened gate must not turn a finished drop into a false stall (why it was narrow before).
test('RuneScape Bones earned: done, never a stall', async () => {
  const toSixty = steps(4, (i) => ({ minutes: 57 + i }));
  // Leaving Inventory at 60 of 60 is the likely-earned case too (leftDrops, 2026-11-22): one notice,
  // since a BADGE reward has no claim step. Until then this test expected silence. Not when
  // Inventory still lists it claimed, nor when the session at 60 still lists it.
  for (const [name, after, notice] of [
    ['claimed, still listed', { minutes: 60, claimed: true }, []],
    ['gone from Inventory, reward earned', { minutes: 60, gone: true }, ['earned']],
    ['gone from Inventory, reward not listed, session at 60', { minutes: 60, gone: true, owned: false }, []],
    ['gone from Inventory, reward not listed, no session', { minutes: 60, gone: true, owned: false, noSession: true }, ['earned']],
  ]) {
    const { s, now, fired } = await run([...toSixty, ...steps(12, () => after)]);
    const v = views(s, now);
    if (process.env.PRINT === '1') console.log(name, JSON.stringify({ ...v, fired }, null, 1));
    assert.deepEqual([v.verdict, v.warning, v.toolbar, v.chip.tone, fired], ['idle', null, ' #667085', 'idle', notice], name);
    // With no session and the reward not among the earned ones, only its leaving Inventory at its
    // requirement says it is earned; before leftDrops it read "not started counting".
    assert.equal(v.states, 'charlie:finished', name);
  }
});

// The real case (Tyler, 2026-11-22, confirmed granted): Bones read 59 of 60 at 18:58 UTC, and at
// the next poll it was in no list at all, with nothing said. Its reward is a BADGE, so there is
// no claim step and the claim reminder never fires. Within LEFT_NEAR_MINUTES of the requirement,
// leaving every list reads as likely earned: a panel line and one notification, no warning.
test('Bones at 59 of 60, then gone from every list: likely earned, said once', async () => {
  const toFiftyNine = steps(3, (i) => ({ minutes: 57 + i }));
  for (const [name, after] of [
    ['reward not listed, no session', { minutes: 60, gone: true, owned: false, noSession: true, echo: true }],
    ['reward among the earned ones, no session', { minutes: 60, gone: true, owned: true, noSession: true, echo: true }],
  ]) {
    const { s, now, fired, said } = await run([...toFiftyNine.map((x) => ({ ...x, echo: true })), ...steps(12, () => after)]);
    const v = views(s, now);
    if (process.env.PRINT === '1') console.log(name, JSON.stringify({ ...v, fired }, null, 1));
    assert.deepEqual(fired, ['earned'], `${name}: one notification`);
    assert.equal(said[0].title, 'Drop likely earned', name);
    assert.equal(said[0].message, 'Twitch stopped listing RuneScape Bones at 59 of 60 minutes, so you have probably earned it.', name);
    const line = "Twitch stopped listing Charlie's RuneScape Bones at 59 of 60 minutes, so you have probably earned it. Your Drops inventory on Twitch shows whether you have it.";
    assert.equal(v.states, 'charlie:finished echo_247:no_drops', `${name}: not "Not counting yet"`);
    assert.deepEqual([v.verdict, v.warning, v.toolbar, v.chip.tone, v.chipEcho.tone], ['idle', null, ' #667085', 'idle', 'idle'], name);
    assert.equal(v.headline, 'Drop likely earned', name);
    assert.equal(v.line, line, name);
    assert.equal(chipView(s, now, fx.login).title, line, `${name}: chip title`);
    // Done: not re-listed as a drop that has not started.
    assert.deepEqual([v.drops, v.dropsEcho, s.upcoming], [[], [], []], name);
  }
});

// Only Inventory's own answer counts. A drop built from the session (Inventory not listing it)
// exists only while its tab is open and its lookups answer, so those lapsing is not Twitch's.
test('a session-built drop at 59 of 60 whose tab closes or lookup fails: not "likely earned"', async () => {
  const failed = { errors: [{ message: 'service error' }], data: null };
  const toFiftyNine = steps(3, (i) => ({ minutes: 57 + i, gone: true, owned: false }));
  for (const [name, after] of [
    ['tab closed', { minutes: 59, gone: true, owned: false, noTab: true, echo: true }],
    ['channel lookup failing', { minutes: 59, gone: true, owned: false, cdc: failed }],
    ['session answering null', { minutes: 59, gone: true, owned: false, noSession: true }],
  ]) {
    const { s, fired } = await run([...toFiftyNine, ...steps(4, () => after)]);
    assert.ok(!fired.includes('earned'), name);
    assert.deepEqual(s.leftDrops, [], name);
  }
});

test('gone from every list further from its requirement, or as its campaign ends: never "likely earned"', async () => {
  const far = await run([...steps(3, (i) => ({ minutes: 40 + i })), ...steps(4, () => ({ minutes: 42, gone: true, owned: false, noSession: true }))]);
  // What else it says then is not this rule's (unmeasured: a drop leaving that far short).
  assert.ok(!far.fired.includes('earned'), 'eighteen minutes short');
  assert.notEqual(far.s.verdict.dropLeft, true);
  const endAt = new Date(START + 3 * MIN).toISOString();
  const ended = await run([...steps(3, (i) => ({ minutes: 57 + i, endAt })), ...steps(4, () => ({ minutes: 59, gone: true, owned: false, noSession: true, endAt }))]);
  assert.ok(!ended.fired.includes('earned'), 'its campaign ended');
  assert.notEqual(ended.s.verdict.dropLeft, true);
});

test('gone, then back in Inventory, then gone again: one notification', async () => {
  const gone = { minutes: 59, gone: true, owned: false, noSession: true };
  const { fired } = await run([...steps(3, (i) => ({ minutes: 57 + i })), gone, { minutes: 59 }, gone, gone]);
  assert.deepEqual(fired, ['earned']);
});

// Audit 2026-11-22: ChannelDropsCampaigns is the list, so its failing, or the stream's category
// being unreadable, must not read as the highlight answer's "Sub drops only" while Bones rises.
test('the channel list failing: unknown with Bones still shown, never "Sub drops only"', async () => {
  const failed = { errors: [{ message: 'service error' }], data: null };
  const { s, now } = await run(steps(4, (i) => ({ minutes: 1 + i, cdc: failed })));
  const v = views(s, now);
  assert.equal(v.states, 'charlie:unknown');
  assert.deepEqual(v.drops, ['RuneScape Bones']);
  assert.notEqual(v.verdict, 'stalled');
});

test('Bones flat with the channel list failing on every other call: still one stall warning', async () => {
  const failed = { errors: [{ message: 'service error' }], data: null };
  const mins = [1, 2, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4];
  const { s, now, fired } = await run(mins.map((m, i) => ({ minutes: m, ...(i % 2 === 1 ? { cdc: failed } : {}) })));
  const v = views(s, now);
  assert.deepEqual([v.verdict, v.warning], ['stalled', 'Drops not counting']);
  assert.deepEqual(fired, ['warning'], 'one desktop notification');
});

// Minutes win over the lists (2026-11-22, point 2): Twitch crediting Bones on an open channel whose
// lists cannot place it (here the stream reports another category) is earning there, and a hang
// there afterwards still warns.
const OTHER = { id: '509658', displayName: 'Just Chatting', name: 'Just Chatting' };

test('credited where no list places it: earning there, listed, and the mismatch recorded', async () => {
  const { s, now, fired } = await run(steps(5, (i) => ({ minutes: 1 + i, game: OTHER, echo: true })));
  const v = views(s, now);
  assert.equal(v.states, 'charlie:eligible echo_247:no_drops');
  assert.deepEqual([v.verdict, v.warning, v.drops, v.dropsEcho], ['earning', null, ['RuneScape Bones'], ['RuneScape Bones']]);
  assert.deepEqual(fired, []);
  assert.equal(v.headline, 'Earning on Charlie');
  // 5 of 60 minutes.
  assert.deepEqual([v.chip.pct, v.chip.tone, v.chipEcho.pct, v.chipEcho.tone, v.toolbar], [8, 'ok', 8, 'ok', '8% #067647']);
  assert.deepEqual(s.creditUnlisted.map((x) => [x.login, x.dropId, x.campaignId]), [['charlie', '0cc61e0f-e351-11f1-9433-0a58a9feac02', 'a8ce1281-5c82-4fbe-9a18-3e7d02e1e7b6']]);
});

test('credited where no list places it, then flat: one stall warning, not "No Drops"', async () => {
  const mins = [1, 2, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4];
  const { s, now, fired } = await run(mins.map((m) => ({ minutes: m, game: OTHER })));
  const v = views(s, now);
  assert.equal(v.states, 'charlie:eligible');
  assert.deepEqual([v.verdict, v.cause, v.warning], ['stalled', 'uncounted', 'Drops not counting']);
  assert.deepEqual(fired, ['warning']);
});

test('placed, then flat with the channel list failing on every other call: still one stall warning', async () => {
  const failed = { errors: [{ message: 'service error' }], data: null };
  const mins = [1, 2, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4];
  const { s, now, fired } = await run(mins.map((m, i) => ({ minutes: m, game: OTHER, ...(i >= 4 && i % 2 === 0 ? { cdc: failed } : {}) })));
  const v = views(s, now);
  assert.deepEqual([v.verdict, v.warning], ['stalled', 'Drops not counting']);
  assert.deepEqual(fired, ['warning']);
});

// Twitch credits "while they're live in {Category}": after a game change minutes stop on purpose,
// and a reload cannot help. Read as a listed campaign leaving the channel: the "may have changed
// game" message, no "not counting" warning, no reload.
test('placed, then the stream changes game: no warning, the changed-game message', async () => {
  const LEAGUE = { id: '21779', displayName: 'League of Legends', name: 'League of Legends' };
  const mins = [1, 2, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4];
  const { s, now, fired } = await run(mins.map((m, i) => ({ minutes: m, game: i < 4 ? OTHER : LEAGUE })));
  const v = views(s, now);
  assert.equal(v.states, 'charlie:sub_only');
  assert.notEqual(v.verdict, 'stalled');
  // The one notification a listed campaign leaving the channel gives too, not "Drops not counting".
  assert.deepEqual([fired, v.warning], [['warning'], 'Stopped earning Drops']);
  assert.equal(s.verdict.lost, true);
  assert.match(s.verdict.message, /changed game/);
  assert.deepEqual(s.placed, []);
});

test('placed, then the category unreadable for a poll: kept, still one stall warning', async () => {
  const mins = [1, 2, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4];
  const { s, now, fired } = await run(mins.map((m, i) => ({ minutes: m, game: OTHER, noBroadcastSettings: i === 5 })));
  const v = views(s, now);
  assert.deepEqual([v.verdict, v.warning], ['stalled', 'Drops not counting']);
  assert.deepEqual(fired, ['warning']);
});

test('placed, then flat past PLACED_KEEP_MS: back to what the lists say', async () => {
  const mins = [1, 2, 3, 4, ...Array(34).fill(4)];
  const { s } = await run(mins.map((m) => ({ minutes: m, game: OTHER })));
  assert.equal(s.streams[0].channelState, 'sub_only');
  assert.deepEqual(s.placed, []);
});

test('a session never rising there places nothing: no evidence of credit', async () => {
  const { s } = await run(steps(5, () => ({ minutes: 4, game: OTHER })));
  assert.equal(s.streams[0].channelState, 'sub_only');
  assert.deepEqual(s.creditUnlisted ?? [], []);
});

test('a live channel with no campaigns (Twitch answers null): "No Drops", not "Cannot check"', async () => {
  const none = { data: { channelDropCampaigns: null } };
  const highlight = { data: { channel: { id: fx.channelID, viewerDropCampaigns: null } } };
  const f = twitchAt({ minutes: 1, cdc: none });
  const g = async (u, init) => {
    const res = await f(u, init);
    const body = await res.json();
    JSON.parse(init.body).forEach((o, i) => { if (o.operationName === 'DropsHighlightService_AvailableDrops') body[i] = highlight; });
    return json(body);
  };
  const snap = await fetchSnapshot('tok', [fx.login], g, {}, { askRewards: false, now: START });
  const c = snap.channels[fx.login];
  assert.deepEqual([!!c.unknown, !!c.badgeLookupFailed, c.campaigns, !!c.subOnly], [false, false, [], false]);
});

test('the channel list answering with an error beside good data: the good data is read', async () => {
  const partial = { ...structuredClone(fx.channelCampaigns), errors: [{ message: 'service error', path: ['channelDropCampaigns', 0, 'rewardGroups'] }] };
  const { s, now } = await run(steps(4, (i) => ({ minutes: 1 + i, cdc: partial })));
  const v = views(s, now);
  assert.equal(v.states, 'charlie:eligible');
  assert.deepEqual([v.verdict, v.drops], ['earning', ['RuneScape Bones']]);
});

test('the stream category unreadable (broadcastSettings gone): unknown, never "Sub drops only"', async () => {
  const { s, now } = await run(steps(4, (i) => ({ minutes: 1 + i, game: undefined, noBroadcastSettings: true })));
  const v = views(s, now);
  assert.equal(v.states, 'charlie:unknown');
  assert.deepEqual(v.drops, ['RuneScape Bones']);
});

// "Get rewards ... while they're live in {Category}" (the sub campaign's earn instructions, same
// capture): the group's categories are where it can earn, so a stream in another one cannot.
// game null is Twitch saying the stream has no category, unlike a field gone (test above).
test('the stream in another category, or in none: the omitted campaign is not added', async () => {
  for (const game of [{ id: '509658', displayName: 'Just Chatting', name: 'Just Chatting' }, null]) {
    const snap = await fetchSnapshot('tok', [fx.login], twitchAt({ minutes: 1, game }), {}, { askRewards: false, now: START });
    assert.deepEqual(snap.channels[fx.login].campaigns.map((x) => x.id), [], String(game?.name));
  }
});

test('odd categories never throw and never mark the channel unknown', async () => {
  for (const categories of [{ id: '459931' }, '459931', null, [null, 5]]) {
    const cdc = structuredClone(fx.channelCampaigns);
    cdc.data.channelDropCampaigns[1].rewardGroups[0].progressCriteria.categories = categories;
    const snap = await fetchSnapshot('tok', [fx.login], twitchAt({ minutes: 1, cdc }), {}, { askRewards: false, now: START });
    const c = snap.channels[fx.login];
    assert.deepEqual([!!c.unknown, c.campaigns.map((x) => x.id)], [false, []], JSON.stringify(categories));
  }
});

test('the omitted campaign in the shape the highlight answer gives', async () => {
  const snap = await fetchSnapshot('tok', [fx.login], twitchAt({ minutes: 1 }), {}, { askRewards: false, now: START });
  const c = snap.channels[fx.login];
  assert.equal(c.subOnly, false);
  assert.deepEqual(c.campaigns.map((x) => ({ id: x.id, channelOwned: x.channelOwned, rewardCampaign: x.rewardCampaign, benefitIds: x.benefitIds, game: x.game })), [
    { id: 'a8ce1281-5c82-4fbe-9a18-3e7d02e1e7b6', channelOwned: false, rewardCampaign: false, benefitIds: ['daa5f04b-e34f-11f1-976b-0a58a9feac02'], game: 'Old School RuneScape' },
  ]);
  assert.deepEqual(c.campaigns[0].watchDrops.map((d) => [d.id, d.name, d.required]), [['0cc61e0f-e351-11f1-9433-0a58a9feac02', 'RuneScape Bones', 60]]);
  assert.deepEqual(c.badges, []);
});
