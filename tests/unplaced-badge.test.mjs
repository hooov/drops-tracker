// A badge Twitch credits that no open channel lists (2026-11-19: a channel's badges were on
// Twitch's panel, but its drop list held only the sitewide GTAVI campaign). The tracker cannot
// show such a badge, so it must at least say one is being counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchSnapshot } from '../extension/lib/twitch.js';
import { update, events } from '../extension/lib/tracker.js';
import { badgeSections } from '../extension/lib/badges.js';
import { debugRows, debugBundle } from '../extension/lib/debug.js';

const inv = JSON.parse(readFileSync(new URL('./fixtures/reward-inventory-2026-11-19.json', import.meta.url))).answer;
const reward = JSON.parse(readFileSync(new URL('./fixtures/reward-campaign-2026-11-19.json', import.meta.url))).channel;
const badgeFx = JSON.parse(readFileSync(new URL('./fixtures/badge-2026-11-06.json', import.meta.url)));
const MIN = 60000;
const T = Date.parse('2026-11-19T17:00:00Z');
const BADGE_CAMPAIGN = 'c374d163-5e71-486e-bab9-b261404d2231';
const json = (body) => ({ status: 200, ok: true, json: async () => body });

/** The reward inventory with the badge group at these minutes. */
const withBadge = (minutes) => {
  const a = structuredClone(inv);
  a.data.currentUser.inventory.viewerRewardDropCampaignsInProgress[0].rewardGroups[0].self.currentMinutesWatched = minutes;
  return a;
};

function twitch({ login, available, rewardAnswer, onReward, lookupFails, badgeLookupFails }) {
  return async (_url, init) => {
    const ops = JSON.parse(init.body);
    if (ops.some((o) => o.operationName === 'ViewerRewardDropInventory')) {
      onReward?.();
      return json(ops.map(() => rewardAnswer));
    }
    return json(ops.map((o) => {
      switch (o.operationName) {
        case 'Inventory': return { data: { currentUser: { inventory: { dropCampaignsInProgress: [], gameEventDrops: [] } } } };
        case 'VideoPlayerStreamInfoOverlayChannel': return { data: { user: { id: '20000009', login, displayName: login, stream: { id: '1' } } } };
        case 'DropsHighlightService_AvailableDrops': return lookupFails ? { errors: [{ message: 'service error' }] } : { data: { channel: available } };
        case 'ChannelDropsCampaigns': return badgeLookupFails ? { errors: [{ message: 'PersistedQueryNotFound' }], data: null } : { data: { channelDropCampaigns: [] } };
        default: return { data: { currentUser: { dropCurrentSession: badgeFx.zeroedSession } } };
      }
    }));
  };
}

async function poll(prev, t, i, opts) {
  const snap = await fetchSnapshot('tok', [opts.login], twitch(opts), {}, { askRewards: true });
  return update(prev, { campaigns: snap.campaigns, rewards: snap.rewards, session: snap.session, sessions: snap.sessions, rewardGroups: snap.rewardGroups, streams: [{ tabId: 1, login: opts.login, channel: snap.channels[opts.login], tab: {}, player: { hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: 100 + i * 60 } }] }, t);
}

// The reported case: the channel lists only the sitewide GTAVI campaign.
const gtaOnly = (minutes, extra = {}) => ({ login: 'foxtrot', available: reward, rewardAnswer: withBadge(minutes), ...extra });

test('a badge rising in the reward inventory that no open channel lists is said, in the Badges tab and Debug', async () => {
  let s;
  for (const [i, m] of [2, 2, 3, 4].entries()) s = await poll(s, T + i * MIN, i, gtaOnly(m));
  assert.equal(s.unplacedBadges.length, 1);
  assert.deepEqual(
    [s.unplacedBadges[0].campaignId, s.unplacedBadges[0].first, s.unplacedBadges[0].minutes, s.unplacedBadges[0].required, s.unplacedBadges[0].rising],
    [BADGE_CAMPAIGN, 2, 4, 180, true],
  );
  const [lead, channel] = badgeSections(s.streams, 'foxtrot', T + 4 * MIN, s.unplacedBadges);
  assert.match(lead.note, /counting minutes on a badge no open channel lists \(4 of 180 min\)/);
  assert.equal(channel.note, 'No badge drops on this channel.', 'the channel itself still lists none');
  const rows = debugRows({ state: s }, T + 4 * MIN);
  assert.equal(rows.find((r) => r.label === 'Badges no open channel lists').value, '1 in progress, 1 rising');
  assert.deepEqual(debugBundle({ state: s }, T).state.unplacedBadges, s.unplacedBadges, 'Copy debug info carries it');
});

test('flat: an old badge from a channel watched before is listed in Debug but never said in the tab', async () => {
  let s;
  for (let i = 0; i < 4; i++) s = await poll(s, T + i * MIN, i, gtaOnly(2));
  assert.equal(s.unplacedBadges[0].rising, false);
  const sections = badgeSections(s.streams, 'foxtrot', T, s.unplacedBadges);
  assert.deepEqual(sections.map((x) => x.note), ['No badge drops on this channel.']);
  assert.equal(debugRows({ state: s }, T).find((r) => r.label === 'Badges no open channel lists').value, '1 in progress, 0 rising');
});

test('a badge the open channel does list is not unplaced', async () => {
  let s;
  for (const [i, m] of [2, 3, 4].entries()) {
    s = await poll(s, T + i * MIN, i, { login: 'charlie', available: { id: badgeFx.mixed.id, viewerDropCampaigns: badgeFx.mixed.viewerDropCampaigns }, rewardAnswer: withBadge(m) });
  }
  assert.deepEqual(s.unplacedBadges, []);
});

test('a channel whose list could not be read holds the marks, so its own badge is never called unplaced', async () => {
  let s = await poll(undefined, T, 0, gtaOnly(2));
  s = await poll(s, T + MIN, 1, gtaOnly(5, { lookupFails: true }));
  assert.deepEqual([s.unplacedBadges[0].minutes, s.unplacedBadges[0].rising], [2, false], 'the blind reading moved nothing');
  s = await poll(s, T + 2 * MIN, 2, gtaOnly(6, { badgeLookupFails: true }));
  assert.deepEqual([s.unplacedBadges[0].minutes, s.unplacedBadges[0].rising], [2, false], 'nor does one with the badge query failing');
});

test('the reward inventory is asked for any live channel when asked to, and not otherwise', async () => {
  let asked = 0;
  const opts = { login: 'bravo', available: { viewerDropCampaigns: null }, rewardAnswer: inv, onReward: () => { asked++; } };
  await fetchSnapshot('tok', ['bravo'], twitch(opts));
  assert.equal(asked, 0, 'nothing on the channel and not due');
  const snap = await fetchSnapshot('tok', ['bravo'], twitch(opts), {}, { askRewards: true });
  assert.equal(asked, 1);
  assert.equal(snap.rewardGroups.find((g) => g.campaignId === BADGE_CAMPAIGN).badge, true, 'brandName is kept');
});

/** Polls in order, as the background does: update, then events on the new state. */
async function notesFor(minutes, opts) {
  let s;
  const fired = [];
  for (const [i, m] of minutes.entries()) {
    const next = await poll(s, T + i * MIN, i, opts(m));
    fired.push(...events(s, next, T + i * MIN).filter((e) => e.type === 'unplaced'));
    s = next;
  }
  return { s, fired };
}

test('notification: once, when the unlisted badge starts rising, not on every poll after', async () => {
  const { s, fired } = await notesFor([2, 2, 3, 4, 5], (m) => gtaOnly(m));
  assert.equal(fired.length, 1);
  assert.equal(fired[0].title, 'Badge Drops Tracker cannot show');
  assert.match(fired[0].message, /\(3 of 180 min\) that no open channel lists/);
  assert.deepEqual(s.notifiedUnplaced, [BADGE_CAMPAIGN]);
});

test('notification: never for a flat one, nor for a badge the open channel lists', async () => {
  assert.equal((await notesFor([2, 2, 2, 2], (m) => gtaOnly(m))).fired.length, 0);
  const listed = (m) => ({ login: 'charlie', available: { id: badgeFx.mixed.id, viewerDropCampaigns: badgeFx.mixed.viewerDropCampaigns }, rewardAnswer: withBadge(m) });
  assert.equal((await notesFor([2, 3, 4], listed)).fired.length, 0);
});

test('notification: a blind poll neither fires it nor forgets it was sent', async () => {
  const { s } = await notesFor([2, 3], (m) => gtaOnly(m));
  const blind = await poll(s, T + 2 * MIN, 2, gtaOnly(9, { badgeLookupFails: true }));
  assert.equal(events(s, blind, T + 2 * MIN).filter((e) => e.type === 'unplaced').length, 0);
  assert.deepEqual(blind.notifiedUnplaced, [BADGE_CAMPAIGN]);
});
