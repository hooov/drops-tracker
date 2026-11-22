// A sitewide reward campaign, from Twitch's real answer (2026-11-19). Its DVD drop gives one badge
// a day for an hour's watching, and the session reports a running total for it (250 of 60 on day
// two, while Twitch's panel read today's badge at 0 of 60). Its "Ultimate Reward" is listed as a
// 60-minute watch drop but needs all 12 of the campaign's rewards. Shown wrong before: the DVD drop
// as "Watch time reached" at 60/60 and Golden Iguana as "Watch 1h to earn".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchSnapshot } from '../extension/lib/twitch.js';
import { warning } from '../extension/lib/tracker.js';
import { update } from './invariants.mjs';
import { channelDrops } from '../extension/lib/chip.js';
import { verdictText } from '../extension/lib/panel.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/reward-campaign-2026-11-19.json', import.meta.url)));
const badgeFx = JSON.parse(readFileSync(new URL('./fixtures/badge-2026-11-06.json', import.meta.url)));
const T0 = Date.parse('2026-11-19T15:30:00Z');
const MIN = 60000;
const DVD = '2283245e-d15c-11f1-8cdd-0a58a9feac02';
const json = (body) => ({ status: 200, ok: true, json: async () => body });

const twitch = (minutes) => async (_url, init) => json(JSON.parse(init.body).map((o) => {
  switch (o.operationName) {
    case 'Inventory': return { data: { currentUser: { inventory: { dropCampaignsInProgress: [], gameEventDrops: [] } } } };
    case 'VideoPlayerStreamInfoOverlayChannel': return { data: { user: { id: '20000009', login: 'echo', displayName: 'Echo', stream: { id: '1' } } } };
    case 'DropsHighlightService_AvailableDrops': return { data: { channel: fx.channel } };
    default: return { data: { currentUser: { dropCurrentSession: { channel: { displayName: 'Echo', id: '20000009', name: 'echo' }, currentMinutesWatched: minutes, dropID: DVD, game: null, requiredMinutesWatched: 60 } } } };
  }
}));

async function run(minutesPerPoll) {
  let s;
  for (let i = 0; i < minutesPerPoll.length; i++) {
    const snap = await fetchSnapshot('tok', ['echo'], twitch(minutesPerPoll[i]));
    s = update(s, { campaigns: snap.campaigns, rewards: snap.rewards, session: snap.session, sessions: snap.sessions, streams: [{ tabId: 1, login: 'echo', channel: snap.channels.echo, tab: {}, player: { hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: 100 + i * 60 } }] }, T0 + i * MIN);
  }
  return s;
}

test('reward campaign: the parser carries Twitch\'s flag, and a channel badge does not count as one', async () => {
  const snap = await fetchSnapshot('tok', ['echo'], twitch(250));
  assert.equal(snap.channels.echo.campaigns[0].rewardCampaign, true);
  assert.equal(badgeFx.mixed.viewerDropCampaigns[0].summary.isRewardCampaign, true, 'a badge carries the same flag');
});

test('reward campaign: a running total is not shown as progress, and the final reward is not listed as watchable', async () => {
  const s = await run(Array(8).fill(250));
  assert.deepEqual(s.active.filter((d) => d.campaignId === fx.channel.viewerDropCampaigns[0].id), [], 'not "Watch time reached"');
  const { drops } = channelDrops(s, 'echo', { pending: true });
  assert.deepEqual(drops.map((d) => [d.name, d.minutes, d.runningTotal]), [['GTA DVD Chest', null, true]], 'no Golden Iguana');
  // Quiet: flat was the normal reading while Twitch counted (2026-11-18), so no "not counting".
  assert.equal(s.streams[0].channelState, 'reward');
  assert.equal(s.verdict.code, 'idle');
  assert.equal(s.verdict.reward, true);
  assert.notEqual(s.verdict.limited, true);
  assert.equal(warning(s, T0 + 8 * MIN), null, 'no pill, no notification');
  assert.match(s.verdict.message, /^Progress for Echo's GTA DVD Chest could not be read\. Twitch's Drops page shows it\.$/);
  assert.equal(verdictText(s, T0 + 8 * MIN)[0], 'Reward campaign');
});

test('reward campaign: a rising running total is earning, and not called an earned drop being wasted', async () => {
  const s = await run([250, 251, 252, 253]);
  assert.equal(s.verdict.code, 'earning');
  assert.equal(s.verdict.wasted, null);
});

// Day one (2026-11-18) read under 60 the whole time, and the tracker saw about 15 of the 250
// minutes Twitch counted, called a hang and reloaded a tab. So under it: shown, never judged.
test('reward campaign: under its requirement the session reading is shown, but a flat reading is never a hang (day one)', async () => {
  const s = await run([30, 31, 32]);
  assert.equal(s.streams[0].channelState, 'reward');
  assert.equal(s.verdict.code, 'earning', 'rising is still credit');
  assert.deepEqual(s.active.filter((d) => d.id === DVD).map((d) => [d.minutes, d.required, d.unjudged]), [[32, 60, true]]);
  assert.deepEqual(s.pending, []);
  const flat = await run([30, 31, 32, ...Array(10).fill(32)]);
  assert.notEqual(flat.verdict.code, 'stalled');
  assert.equal(flat.verdict.reward, true);
  assert.equal(warning(flat, Date.parse('2026-11-19T15:45:00Z')), null);
});

test('reward campaign: a running total that stops rising is not a hang', async () => {
  const s = await run([250, 251, 252, ...Array(8).fill(252)]);
  assert.notEqual(s.verdict.code, 'stalled');
});

test('reward campaign credited while another tab can earn: that tab\'s drop is not shown as what is rising', async () => {
  const { badge } = await import('../extension/lib/tracker.js');
  const { chipView } = await import('../extension/lib/chip.js');
  const later = '2026-11-30T00:00:00Z';
  const other = { id: 'rivals', name: 'Rivals', status: 'ACTIVE', endAt: later, game: { name: 'Rivals' }, timeBasedDrops: [{ id: 'rivals-drop', name: 'Rivals reward', requiredMinutesWatched: 120, endAt: later, self: { currentMinutesWatched: 40, isClaimed: false, hasPreconditionsMet: true } }] };
  const echo = { id: 'e', login: 'echo', displayName: 'Echo', live: true, campaigns: [{ id: 'gta', name: 'Launch', channelOwned: false, rewardCampaign: true, game: 'Special Events', endAt: later, benefitIds: ['chest'], watchDrops: [{ id: DVD, name: 'GTA DVD Chest', required: 60, benefitIds: ['chest'] }] }] };
  const bravo = { id: 'b', login: 'bravo', displayName: 'Bravo', live: true, campaigns: [{ id: 'rivals', name: 'Rivals', benefitIds: ['r'] }] };
  let s;
  for (let i = 0; i < 4; i++) {
    const session = { login: 'echo', displayName: 'Echo', dropId: DVD, minutes: 250 + i, required: 60 };
    const player = { hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: 100 + i * 60 };
    s = update(s, { campaigns: [structuredClone(other)], rewards: { ids: [], complete: true }, session, sessions: [session], streams: [{ tabId: 1, login: 'echo', channel: echo, tab: {}, player }, { tabId: 2, login: 'bravo', channel: bravo, tab: {}, player }] }, T0 + i * MIN);
  }
  assert.equal(s.verdict.code, 'earning');
  assert.equal(s.streams.find((t) => t.login === 'echo').credited, true, 'its row says Earning, not Not counting yet');
  assert.equal(badge(s).text, 'ON', 'not the other tab\'s 33%');
  const chip = chipView(s, T0 + 3 * MIN, 'bravo');
  assert.equal(chip.pct, null);
  assert.doesNotMatch(chip.title, /Rivals reward/);
});

test('reward campaign: a reading exactly at the requirement is not "Watch time reached" either', async () => {
  const s = await run(Array(8).fill(60));
  assert.deepEqual(s.active.filter((d) => d.id === DVD), []);
  assert.notEqual(s.streams[0].channelState, 'finished');
  assert.deepEqual((s.pending || []).map((d) => [d.id, d.runningTotal]), [[DVD, true]]);
});
