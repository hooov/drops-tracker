// The invariant in invariants.mjs must fail on the bug it was written for, not only pass. Replays
// the 2026-11-22 OSRS capture with the stream's category unread, which is what the tracker saw
// before ChannelDropsCampaigns became the list: "Sub drops only" while RuneScape Bones rose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchSnapshot } from '../extension/lib/twitch.js';
import { update as realUpdate } from '../extension/lib/tracker.js';
import { update, creditedNotListed } from './invariants.mjs';

const fx = JSON.parse(readFileSync(new URL('./fixtures/highlight-omitted-2026-11-22.json', import.meta.url)));
const T = Date.parse('2026-11-22T17:30:00Z');
const json = (body) => ({ status: 200, ok: true, json: async () => body });

function twitchAt(minutes, game) {
  const overlay = structuredClone(fx.overlay);
  overlay.data.user.broadcastSettings.game = game;
  const campaign = structuredClone(fx.inventory);
  campaign.timeBasedDrops[0].self.currentMinutesWatched = minutes;
  return async (_u, init) => json(JSON.parse(init.body).map((o) => {
    switch (o.operationName) {
      case 'Inventory': return { data: { currentUser: { inventory: { dropCampaignsInProgress: [campaign], gameEventDrops: [] } } } };
      case 'VideoPlayerStreamInfoOverlayChannel': return overlay;
      case 'DropsHighlightService_AvailableDrops': return fx.highlight;
      case 'ChannelDropsCampaigns': return fx.channelCampaigns;
      case 'DropCurrentSessionContext': return { data: { currentUser: { dropCurrentSession: { ...fx.session, currentMinutesWatched: minutes } } } };
      case 'ViewerRewardDropInventory': return { data: { currentUser: { inventory: { viewerRewardDropCampaignsInProgress: [] } } } };
      default: throw new Error(o.operationName);
    }
  }));
}

async function poll(u, prev, i, game) {
  const snap = await fetchSnapshot('tok', [fx.login], twitchAt(1 + i, game), {}, { askRewards: false, now: T + i * 60000 });
  const streams = [{ tabId: 1, login: fx.login, channel: snap.channels[fx.login], tab: {}, player: { hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: 100 + i * 60 } }];
  return { snap, s: u(prev, { campaigns: snap.campaigns, rewards: snap.rewards, session: snap.session, sessions: snap.sessions, rewardGroups: snap.rewardGroups, streams }, T + i * 60000) };
}

test('catches the b0aty miss: Bones rising on a channel read as "Sub drops only"', async () => {
  // The tracker's own update, so the miss can be built; then the check run on it.
  const a = await poll(realUpdate, undefined, 0, null);
  const b = await poll(realUpdate, a.s, 1, null);
  assert.equal(b.s.streams[0].channelState, 'sub_only', 'the miss being reproduced');
  const bad = creditedNotListed(a.snap.sessions, b.snap.sessions, b.s);
  assert.equal(bad.length, 2, bad.join('; '));
  assert.match(bad[0], /charlie reads sub_only while 0cc61e0f-e351-11f1-9433-0a58a9feac02 rises 1 to 2/);
  assert.match(bad[1], /not in its My Drops/);
  // And the wrapped update throws on it.
  const c = await poll(update, undefined, 0, null);
  await assert.rejects(poll(update, c.s, 1, null), /Credited drop not tracked/);
});

test('quiet when the category is read: Bones tracked', async () => {
  const game = fx.overlay.data.user.broadcastSettings.game;
  let s;
  for (let i = 0; i < 4; i++) s = (await poll(update, s, i, game)).s;
  assert.equal(s.streams[0].channelState, 'eligible');
});

test('not credited: flat, over the requirement, or a channel not open', () => {
  const st = { streams: [{ login: 'charlie', channelState: 'no_drops', campaignIds: [] }], active: [] };
  const was = [{ login: 'charlie', dropId: 'd', minutes: 5, required: 60 }];
  assert.deepEqual(creditedNotListed(was, [{ ...was[0] }], st), [], 'flat');
  assert.deepEqual(creditedNotListed([{ ...was[0], minutes: 250 }], [{ ...was[0], minutes: 251 }], st), [], 'a running total past the requirement');
  assert.deepEqual(creditedNotListed(was, [{ ...was[0], login: 'elsewhere', minutes: 6 }], st), [], 'a stream outside this browser');
  assert.equal(creditedNotListed(was, [{ ...was[0], minutes: 6 }], st).length, 2, 'rising here: both views wrong');
});
