// Every view at once, for each state captured on 2026-11-19 on a channel with both GTAVI's
// sitewide reward campaign and its own badge (CONTRIBUTING: "A new source of minutes changes every
// view"). Four bugs that day came one report at a time, each from this same mix. Placeholder names:
// foxtrot is the badge channel, echo_247 a second tab with no drops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchSnapshot } from '../extension/lib/twitch.js';
import { update, events, badge, warning, rewardsDue } from '../extension/lib/tracker.js';
import { chipView, channelDrops } from '../extension/lib/chip.js';
import { badgeSections } from '../extension/lib/badges.js';
import { verdictText } from '../extension/lib/panel.js';

const cc = JSON.parse(readFileSync(new URL('./fixtures/channel-campaigns-2026-11-19.json', import.meta.url)));
const inv = JSON.parse(readFileSync(new URL('./fixtures/reward-inventory-2026-11-19.json', import.meta.url))).answer;
const reward = JSON.parse(readFileSync(new URL('./fixtures/reward-campaign-2026-11-19.json', import.meta.url))).channel;
const badgeFx = JSON.parse(readFileSync(new URL('./fixtures/badge-2026-11-06.json', import.meta.url)));
const MIN = 60000;
const BADGE = '2599eac2-414e-4165-8dfb-9184ea99f927';
const WATCH_GROUP = 'afe7886c-e437-11f1-8716-0a58a9feac02';
const DVD = '2283245e-d15c-11f1-8cdd-0a58a9feac02';
const ECHO_ID = '20000011';
const json = (body) => ({ status: 200, ok: true, json: async () => body });

/**
 * One poll's Twitch. badge: the 180-minute group's minutes, or null to leave it out of the reward
 * inventory. dvd: { minutes, grants, windowEnd }. total: the session's GTAVI running total.
 * echo: a second tab open. badgeGroup: overrides for the badge group's self (earned, status).
 */
function twitchAt({ badge: badgeMinutes, dvd, total, echo, badgeGroup = {}, badgeListed = true, rewardListed = true, dismissed = false }) {
  const answer = structuredClone(inv);
  const [b, gta] = answer.data.currentUser.inventory.viewerRewardDropCampaignsInProgress;
  b.id = BADGE;
  b.rewardGroups[0].id = WATCH_GROUP;
  b.rewardGroups[0].self = { ...b.rewardGroups[0].self, currentMinutesWatched: badgeMinutes ?? 0, ...badgeGroup };
  if (badgeMinutes == null) answer.data.currentUser.inventory.viewerRewardDropCampaignsInProgress.splice(0, 1);
  const g = gta.rewardGroups[0].self;
  g.currentMinutesWatched = dvd.minutes;
  g.grantCount = dvd.grants;
  g.currentWindow = { startedAt: new Date(dvd.windowEnd - 86400000).toISOString(), expiresAt: new Date(dvd.windowEnd).toISOString() };
  if (dvd.next != null) g.nextEligibleAt = new Date(dvd.next).toISOString(); // Twitch's own "next eligible".
  const session = { channel: { displayName: 'Foxtrot', id: cc.channelID, name: 'foxtrot' }, currentMinutesWatched: total, dropID: DVD, game: null, requiredMinutesWatched: 60 };
  return async (_url, init) => {
    const ops = JSON.parse(init.body);
    return json(ops.map((o) => {
      const isEcho = o.variables?.channel === 'echo_247' || o.variables?.channelID === ECHO_ID;
      switch (o.operationName) {
        case 'ViewerRewardDropInventory': return answer;
        case 'Inventory': return { data: { currentUser: { inventory: { dropCampaignsInProgress: [], gameEventDrops: [] } } } };
        case 'VideoPlayerStreamInfoOverlayChannel':
          return isEcho
            ? { data: { user: { id: ECHO_ID, login: 'echo_247', displayName: 'echo_247', stream: { id: '2' } } } }
            : { data: { user: { id: cc.channelID, login: 'foxtrot', displayName: 'Foxtrot', stream: { id: '1' } } } };
        // dismissed: GTAVI's chat highlight dismissed, so only ChannelDropsCampaigns lists it (2026-11-20).
        // rewardListed false: gone from both answers.
        case 'DropsHighlightService_AvailableDrops': return { data: { channel: isEcho || !rewardListed || dismissed ? { id: isEcho ? ECHO_ID : cc.channelID, viewerDropCampaigns: [] } : reward } };
        case 'ChannelDropsCampaigns': return { data: { channelDropCampaigns: isEcho ? [] : cc.answer.data.channelDropCampaigns.filter((c) => (badgeListed || c.id !== BADGE) && (rewardListed || c.id === BADGE)).map((c) => (dismissed && c.id !== BADGE ? { ...c, hasViewerDismissedHighlight: true } : c)) } };
        case 'DropCurrentSessionContext': return { data: { currentUser: { dropCurrentSession: isEcho ? badgeFx.zeroedSession : session } } };
        default: throw new Error(o.operationName);
      }
    }));
  };
}

/** Polls a minute apart; returns the last state and every event raised on the way. */
async function run(start, steps, { realAsk = false } = {}) {
  let s;
  const fired = [];
  for (const [i, step] of steps.entries()) {
    const t = start + i * MIN;
    const logins = step.echo ? ['foxtrot', 'echo_247'] : ['foxtrot'];
    // realAsk: the reward inventory only when background.js would ask it, not every poll.
    const snap = await fetchSnapshot('tok', logins, twitchAt(step), {}, { askRewards: realAsk ? rewardsDue(s, t) : true, now: t });
    const player = (base) => ({ hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: base + i * 60 });
    const streams = [{ tabId: 1, login: 'foxtrot', channel: snap.channels.foxtrot, tab: {}, player: player(100) }];
    if (step.echo) streams.push({ tabId: 2, login: 'echo_247', channel: snap.channels.echo_247, tab: {}, player: { ...player(500), hidden: true } });
    const next = update(s, { campaigns: snap.campaigns, rewards: snap.rewards, session: snap.session, sessions: snap.sessions, rewardGroups: snap.rewardGroups, streams }, t);
    fired.push(...events(s, next, t));
    s = next;
  }
  return { s, fired, now: start + (steps.length - 1) * MIN };
}

/** Everything a user can see, in one object. */
function views(s, now) {
  const chip = (login) => { const c = chipView(s, now, login); return { pct: c.pct, tone: c.tone, text: c.text }; };
  const list = (login) => { const d = channelDrops(s, login); return { ids: d.drops.map((x) => x.name), from: d.from }; };
  const tb = badge(s);
  const w = warning(s, now);
  return {
    verdict: s.verdict.code,
    cause: s.verdict.cause ?? null,
    wasted: s.verdict.wasted?.reason ?? null,
    headline: verdictText(s, now),
    toolbar: `${tb.text} ${tb.color}`,
    chipFoxtrot: chip('foxtrot'),
    chipEcho: s.streams.some((t) => t.login === 'echo_247') ? chip('echo_247') : null,
    dropsFoxtrot: list('foxtrot'),
    dropsEcho: s.streams.some((t) => t.login === 'echo_247') ? list('echo_247') : null,
    badgesTab: badgeSections(s.streams, 'foxtrot', now, s.unplacedBadges).map((x) => x.note || x.campaigns.map((c) => c.drops.map((d) => d.line).join(' | ')).join('; ')),
    warning: w ? w.title : null,
    states: s.streams.map((t) => `${t.login}:${t.channelState}`).join(' '),
    credited: s.creditedCampaign === BADGE ? 'badge' : s.creditedCampaign ? 'gtavi' : null,
  };
}

const WINDOW_END = Date.parse('2026-11-20T17:50:15Z');
const steps = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
const PRINT = process.env.ALL_VIEWS_PRINT === '1';
const show = (name, v) => { if (PRINT) console.log(`\n== ${name}\n${JSON.stringify(v, null, 1)}`); };

test('18:10 UTC: today\'s GTAVI drop and the badge both rising, second tab open', async () => {
  const { s, now } = await run(Date.parse('2026-11-19T18:05:00Z'), steps(6, (i) => ({ badge: 16 + i, dvd: { minutes: 16 + i, grants: 1, windowEnd: WINDOW_END }, total: 266 + i, echo: true })));
  const v = views(s, now);
  show('both rising', v);
  assert.deepEqual([v.verdict, v.wasted, v.warning, v.states], ['earning', null, null, 'foxtrot:eligible echo_247:no_drops']);
  assert.equal(v.headline[0], 'Earning on Foxtrot');
  assert.equal(v.toolbar, '35% #067647', "today's GTAVI drop, the one the session names");
  assert.deepEqual([v.chipFoxtrot.pct, v.chipEcho.pct, v.chipEcho.tone], [35, 35, 'ok']);
  assert.deepEqual(v.dropsEcho, { ids: ['GTA DVD Chest', 'Foxtrot Watch Badge'], from: 'Foxtrot' });
  assert.match(v.badgesTab[0], /Watch 2h 39m to earn/);
});

test('19:03 UTC: today\'s GTAVI drop done, the badge rising, second tab open', async () => {
  const { s, now } = await run(Date.parse('2026-11-19T19:00:00Z'), steps(6, (i) => ({ badge: 69 + i, dvd: { minutes: 60, grants: 2, windowEnd: WINDOW_END }, total: 319 + i, echo: true })));
  const v = views(s, now);
  show('badge rising, gtavi done', v);
  assert.deepEqual([v.verdict, v.wasted, v.warning, v.credited], ['earning', null, null, 'badge'], 'not "these minutes do nothing"');
  assert.equal(v.toolbar, '41% #067647');
  assert.deepEqual([v.chipFoxtrot.pct, v.chipFoxtrot.tone, v.chipEcho.pct, v.chipEcho.tone], [41, 'ok', 41, 'ok'], 'no bare ring on either tab');
  assert.deepEqual(v.dropsEcho, { ids: ['Foxtrot Watch Badge'], from: 'Foxtrot' });
});

test('20:00 UTC: the badge stopped at 106, second tab playing', async () => {
  const flat = [103, 104, 105, 106, 106, 106, 106, 106, 106, 106];
  const { s, now, fired } = await run(Date.parse('2026-11-19T19:50:00Z'), flat.map((m, i) => ({ badge: m, dvd: { minutes: 60, grants: 2, windowEnd: WINDOW_END }, total: 353 + Math.min(i, 3), echo: true })));
  const v = views(s, now);
  show('badge stalled, second stream', { ...v, notified: fired.map((e) => e.type) });
  assert.deepEqual([v.verdict, v.cause, v.warning], ['stalled', 'second_stream', 'Drops not counting']);
  assert.match(v.headline[1], /echo_247 is also playing.*Close or pause echo_247/);
  assert.equal(v.toolbar, '! #d92d20');
  assert.deepEqual([v.chipFoxtrot.tone, v.chipFoxtrot.pct, v.chipEcho.tone], ['bad', 58, 'bad']);
  assert.deepEqual(fired.map((e) => e.type), ['warning'], 'one desktop notification');
});

test('the badge stopped, no second tab', async () => {
  const flat = [103, 104, 105, 106, 106, 106, 106, 106, 106, 106];
  const { s, now, fired } = await run(Date.parse('2026-11-19T19:50:00Z'), flat.map((m, i) => ({ badge: m, dvd: { minutes: 60, grants: 2, windowEnd: WINDOW_END }, total: 353 + Math.min(i, 3) })));
  const v = views(s, now);
  show('badge stalled, alone', { ...v, notified: fired.map((e) => e.type) });
  assert.deepEqual([v.verdict, v.cause, v.warning], ['stalled', 'uncounted', 'Drops not counting']);
  assert.equal(v.toolbar, '! #d92d20');
  assert.deepEqual([v.chipFoxtrot.tone, v.chipFoxtrot.pct], ['bad', 58]);
  assert.deepEqual(fired.map((e) => e.type), ['warning']);
});

test('the badge reaching 180 and Twitch still crediting it', async () => {
  const mins = [177, 178, 179, 180, 181, 182, 183];
  const { s, now, fired } = await run(Date.parse('2026-11-19T21:10:00Z'), mins.map((m, i) => ({ badge: m, dvd: { minutes: 60, grants: 2, windowEnd: WINDOW_END }, total: 427 + i, echo: true, badgeGroup: m >= 180 ? { status: 'CLAIMED', earnedReward: {}, grantCount: 1 } : {} })));
  const v = views(s, now);
  show('badge earned, still credited', { ...v, notified: fired.map((e) => e.type) });
  assert.deepEqual([v.verdict, v.wasted], ['earning', 'earned'], 'all-views check: was a green "Earning"');
  // Nothing else open can earn (echo_247 has no drops), so done, in grey: no amber with nothing to
  // act on (colour scheme, 2026-11-20). The badge does not repeat, so no "next one can start".
  assert.deepEqual(v.headline, ['Already earned on Foxtrot', 'Foxtrot Watch Badge is already earned, and nothing else open can earn right now.']);
  assert.equal(v.toolbar, ' #667085');
  assert.deepEqual([v.chipFoxtrot.tone, v.chipFoxtrot.text, v.chipEcho.tone], ['idle', 'Done', 'idle']);
  assert.match(v.badgesTab[0], /Watch time reached/);
});

test('the badge campaign over: gone from both answers', async () => {
  const { s, now } = await run(Date.parse('2026-11-19T23:05:00Z'), steps(4, (i) => ({ badge: null, badgeListed: false, dvd: { minutes: 60, grants: 2, windowEnd: WINDOW_END }, total: 480 + i, echo: true })));
  const v = views(s, now);
  show('badge over', v);
  assert.deepEqual([v.verdict, v.wasted], ['earning', 'earned'], 'all-views check: was a green "Earning"');
  // Today's drop done and nothing else to earn: done for today, with the next start (2026-11-20).
  assert.equal(v.headline[0], 'Done for today on Foxtrot');
  assert.match(v.headline[1], /^GTA DVD Chest is earned for today\. The next one can start at /);
  assert.equal(v.toolbar, ' #667085');
  assert.deepEqual(v.badgesTab, ['No badge drops on this channel.']);
});

// 2026-11-20, suzy (Foxtrot here; times moved into the fixtures' campaign window): the badge read
// 179 of 180 at 08:14 UTC; at the next poll its group was gone from Twitch's in-progress list and
// the session's GTAVI running total took the minutes (today's DVD drop already 60 of 60). At 09:55
// GTAVI's campaign left the channel's list. Then nothing rose. The panel said "Cannot track this
// badge" with a desktop notification, the Badges tab "Watch 1m to earn", and the minute the
// campaign left counted the running total against the window's 60 as hundreds of minutes earned.
test('the badge leaving Twitch\'s in-progress list at 179, then GTAVI leaving the channel', async () => {
  const dvd = { minutes: 60, grants: 2, windowEnd: WINDOW_END };
  const rising = steps(4, (i) => ({ badge: 176 + i, dvd, total: 444 + i }));
  const left = steps(4, (i) => ({ badge: null, dvd, total: 448 + i }));
  const unlisted = steps(3, (i) => ({ badge: null, dvd, total: 452 + i, rewardListed: false }));
  const flat = steps(16, () => ({ badge: null, dvd, total: 454, rewardListed: false }));
  const start = Date.parse('2026-11-19T20:11:00Z');

  const atLeft = await run(start, [...rising, ...left]);
  const vLeft = views(atLeft.s, atLeft.now);
  show('badge left at 179', vLeft);
  assert.match(vLeft.badgesTab[0], /Likely earned/, 'not "Watch 1m to earn"');
  assert.equal(vLeft.wasted, 'earned');
  assert.match(vLeft.headline[1], /GTA DVD Chest is earned for today/);

  const atUnlisted = await run(start, [...rising, ...left, ...unlisted]);
  const vUnlisted = views(atUnlisted.s, atUnlisted.now);
  show('GTAVI unlisted, total still rising', vUnlisted);
  assert.ok(atUnlisted.s.timeline.every((t) => (t.d ?? 0) <= 1), `one minute a minute, got ${atUnlisted.s.timeline.map((t) => t.d).join(',')}`);
  assert.match(vUnlisted.headline[1], /GTA DVD Chest is earned for today/, 'the name, not "Foxtrot\'s drop"');

  const end = await run(start, [...rising, ...left, ...unlisted, ...flat]);
  const v = views(end.s, end.now);
  show('nothing rising', { ...v, notified: end.fired.map((e) => e.type) });
  assert.equal(v.states, 'foxtrot:badge_left');
  assert.deepEqual(v.headline, ['Badge likely earned', "Twitch stopped listing Foxtrot's badge at 179 of 180 minutes, so you have probably earned it. The badge picker in Foxtrot's chat shows whether you have it."]);
  assert.equal(v.warning, null, 'no "Drops not being tracked" notification');
  assert.notEqual(v.toolbar.split(' ')[0], '?');
  assert.equal(v.chipFoxtrot.tone === 'warn', false);
  assert.match(v.badgesTab[0], /Likely earned/);
});

// 2026-11-20, yoon_froggy (Foxtrot here) with suzy_247 (echo_247) open: GTAVI's chat highlight had
// been dismissed, so Twitch's highlight answer listed nothing for the channel while
// ChannelDropsCampaigns still listed GTAVI. The reward inventory read today's window 60 of 60 at
// 17:49:43, the window ended 17:50:15, and Twitch's own panel then counted the next one (2 of 60,
// window from 17:51:58). The panel said "already earned ... these minutes do nothing", and Open
// streams "No Drops on this channel" for both tabs.
const ROLL = Date.parse('2026-11-20T17:50:15Z');
const NEXT_END = Date.parse('2026-11-21T17:51:58Z');
const before = (i) => ({ badge: null, badgeListed: false, dvd: { minutes: 60, grants: 2, windowEnd: ROLL }, total: 630 + i, echo: true });
const after = (i, extra) => ({ badge: null, badgeListed: false, dvd: { minutes: 1 + i, grants: 2, windowEnd: NEXT_END }, total: 633 + i, echo: true, ...extra });

test('GTAVI dismissed on the channel: still listed, and the next window reads as earning', async () => {
  // Listed until the highlight was dismissed (as at 09:55 that morning), then only in ChannelDropsCampaigns.
  const listedThenDismissed = (list) => list.map((x, i) => ({ ...x, dismissed: i >= 2 }));
  const pre = await run(Date.parse('2026-11-20T17:47:00Z'), listedThenDismissed(steps(3, before)));
  const vPre = views(pre.s, pre.now);
  show('dismissed, window done', vPre);
  assert.equal(vPre.wasted, 'earned', "today's window really is done: that warning is right");
  assert.equal(vPre.headline[0], 'Done for today on Foxtrot', 'done, not an amber warning: nothing else can earn');
  assert.match(vPre.headline[1], /GTA DVD Chest is earned for today/);

  const { s, now } = await run(Date.parse('2026-11-20T17:47:00Z'), listedThenDismissed([...steps(3, before), ...steps(6, (i) => after(i))]));
  const v = views(s, now);
  show('dismissed, next window', v);
  assert.deepEqual([v.verdict, v.wasted, v.warning], ['earning', null, null], 'not "these minutes do nothing"');
  assert.equal(v.headline[0], 'Earning on Foxtrot');
  assert.doesNotMatch(v.states, /foxtrot:no_drops/, 'not "No Drops on this channel"');
  assert.deepEqual(v.dropsFoxtrot.ids.includes('GTA DVD Chest'), true);
  assert.equal(v.chipFoxtrot.tone, 'ok');
  assert.deepEqual(v.badgesTab, ['No badge drops on this channel.'], 'right that day: the badge campaign had ended');
});

test('GTAVI listed, then in neither answer: a window that ended is asked again, and the total is not called earned', async () => {
  const { s, now } = await run(Date.parse('2026-11-20T17:47:00Z'), [...steps(3, before), ...steps(6, (i) => after(i, { rewardListed: false }))], { realAsk: true });
  const v = views(s, now);
  show('unlisted, next window', v);
  const g = s.rewardInv.groups.find((x) => x.id === DVD);
  assert.equal(g.windowEnd, NEXT_END, 'the inventory was asked again after 17:50:15, not held for 15 minutes');
  assert.deepEqual([v.verdict, v.wasted], ['earning', null], 'a running total of 638 is not a finished 60-minute drop');
});

// Twitch's Watch Drops panel keeps a daily drop done for today as "Day complete" with "Day opens in
// 4h" (Tyler's screenshot, 2026-11-22). Before, the extension dropped it from My Drops entirely.
test('GTAVI done for today: My Drops keeps it with when the next day opens, and nothing else counts it', async () => {
  const day = (over = {}) => steps(6, (i) => ({ badge: 69 + i, dvd: { minutes: 60, grants: 2, windowEnd: WINDOW_END, ...over }, total: 319 + i, echo: true }));
  const { s, now } = await run(Date.parse('2026-11-19T19:00:00Z'), day());
  const mine = channelDrops(s, 'foxtrot', { pending: true }).drops;
  const dvd = mine.find((d) => d.id === DVD);
  assert.ok(dvd, 'listed on its channel');
  assert.equal(dvd.opensAt, WINDOW_END, 'no "next eligible" from Twitch: the window end');
  assert.equal(dvd.required, 60);
  assert.ok(mine.some((d) => d.name === 'Foxtrot Watch Badge'), 'the badge still listed beside it');
  assert.ok(!s.active.some((d) => d.id === DVD), 'not progress');
  assert.ok(!channelDrops(s, 'foxtrot').drops.some((d) => d.id === DVD), "not for the chip, whose percentage stays the badge's");
  assert.equal(chipView(s, now, 'foxtrot').pct, 41);

  const next = WINDOW_END - 2 * 3600000;
  const own = await run(Date.parse('2026-11-19T19:00:00Z'), day({ next }));
  assert.equal(own.s.resting.find((d) => d.id === DVD)?.opensAt, next, "Twitch's own time wins");
});

test('GTAVI done for today: gone from the timer once the day opens, or once every day is granted', async () => {
  const after = await run(WINDOW_END + MIN, steps(3, (i) => ({ badge: 100 + i, dvd: { minutes: 60, grants: 2, windowEnd: WINDOW_END }, total: 400 + i })));
  assert.deepEqual(after.s.resting, [], 'window over: open again, not resting');
  const all = await run(Date.parse('2026-11-19T19:00:00Z'), steps(3, (i) => ({ badge: 69 + i, dvd: { minutes: 60, grants: 6, windowEnd: WINDOW_END }, total: 319 + i })));
  assert.deepEqual(all.s.resting, [], 'all 6 granted: done for good');
  // GTAVI's campaign ends 2026-12-01T07:59:59Z: a next day after that never comes.
  const last = await run(Date.parse('2026-11-30T21:00:00Z'), steps(3, (i) => ({ badge: null, dvd: { minutes: 60, grants: 5, windowEnd: Date.parse('2026-12-01T20:00:00Z') }, total: 900 + i })));
  assert.deepEqual(last.s.resting, [], 'next day after the campaign ends');
  const before = await run(Date.parse('2026-11-30T05:00:00Z'), steps(3, (i) => ({ badge: null, dvd: { minutes: 60, grants: 5, windowEnd: Date.parse('2026-11-30T20:00:00Z') }, total: 900 + i })));
  assert.equal(before.s.resting.length, 1, 'the same campaign a day earlier: resting');
  const alone = await run(Date.parse('2026-11-19T19:00:00Z'), steps(3, (i) => ({ badge: null, dvd: { minutes: 60, grants: 2, windowEnd: WINDOW_END }, total: 319 + i })));
  const popup = channelDrops(alone.s, null, { pending: true });
  assert.deepEqual([popup.drops.map((d) => d.id), popup.from], [[DVD], 'Foxtrot'], 'the toolbar popup shows it too, named by channel');
});
