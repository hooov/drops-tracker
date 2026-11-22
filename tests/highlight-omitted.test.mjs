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
function twitchAt({ minutes, echo, game, claimed = false, gone = false, owned = gone, noSession = false, cdc = fx.channelCampaigns }) {
  const overlay = structuredClone(fx.overlay);
  if (game !== undefined) overlay.data.user.broadcastSettings.game = game;
  const campaign = structuredClone(fx.inventory);
  campaign.timeBasedDrops[0].self.currentMinutesWatched = minutes;
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
  for (const [i, step] of steps.entries()) {
    const t = START + i * MIN;
    const logins = step.echo ? [fx.login, 'echo_247'] : [fx.login];
    const snap = await fetchSnapshot('tok', logins, twitchAt(step), {}, { askRewards: true, now: t });
    const player = (base) => ({ hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: base + i * 60 });
    const streams = [{ tabId: 1, login: fx.login, channel: snap.channels[fx.login], tab: {}, player: player(100) }];
    if (step.echo) streams.push({ tabId: 2, login: 'echo_247', channel: snap.channels.echo_247, tab: {}, player: { ...player(500), hidden: true } });
    const next = update(s, { campaigns: snap.campaigns, rewards: snap.rewards, session: snap.session, sessions: snap.sessions, rewardGroups: snap.rewardGroups, streams }, t);
    fired.push(...events(s, next, t).map((e) => e.type));
    s = next;
  }
  return { s, fired, now: START + (steps.length - 1) * MIN };
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
  for (const [name, after] of [
    ['claimed, still listed', { minutes: 60, claimed: true }],
    ['gone from Inventory, reward earned', { minutes: 60, gone: true }],
    ['gone from Inventory, reward not listed, session at 60', { minutes: 60, gone: true, owned: false }],
    ['gone from Inventory, reward not listed, no session', { minutes: 60, gone: true, owned: false, noSession: true }],
  ]) {
    const { s, now, fired } = await run([...toSixty, ...steps(12, () => after)]);
    const v = views(s, now);
    if (process.env.PRINT === '1') console.log(name, JSON.stringify({ ...v, fired }, null, 1));
    assert.deepEqual([v.verdict, v.warning, v.toolbar, v.chip.tone, fired], ['idle', null, ' #667085', 'idle', []], name);
    // With no session and the reward not among the earned ones, nothing says it is earned, and it
    // reads as any listed campaign Inventory leaves out: "not started counting", quietly. What
    // Twitch answers then is unmeasured, so that state is not asserted here.
    if (!after.noSession) assert.equal(v.states, 'charlie:finished', name);
  }
});

// "Get rewards ... while they're live in {Category}" (the sub campaign's earn instructions, same
// capture): the group's categories are where it can earn, so a stream in another one cannot.
test('the stream in another category, or none read: the omitted campaign is not added', async () => {
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
