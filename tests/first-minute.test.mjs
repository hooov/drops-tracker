// Opening a channel, as the person watching sees it (audit, 2026-11-22). Tyler: "when we first go
// to a channel it shows nothing and then after about a minute it starts showing all the badges".
// Four causes, each replayed here through the real tracker and views:
//   1. A tab Twitch had not started for 4 minutes put its "may need your game account linked" on
//      every channel opened after it, by name.
//   2. A new channel waited for the next once-a-minute poll, and its Badges tab said the page had to
//      be open while it was.
//   3. "Earning slowly" on a fresh channel came from the last channel's hang (11 of 30, about 18
//      minutes to clear on a channel counting every minute).
//   4. A campaign not started yet listed none of its drops.
// Placeholder channels; the Inventory comes from tests/fixtures/gql-2026-11-06.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { events, STALL_MS } from '../extension/lib/tracker.js';
import { update } from './invariants.mjs';
import { chipView, channelDrops, checkNeeded } from '../extension/lib/chip.js';
import { verdictText } from '../extension/lib/panel.js';
import { badgeSections } from '../extension/lib/badges.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/gql-2026-11-06.json', import.meta.url)));
const T0 = Date.parse('2026-11-06T15:00:00Z');
const MIN = 60000;
const END = '2026-12-31T00:00:00.000Z';
const POUCH = 'd5ffa3e4-d6fe-11f1-adef-0a58a9feac02';

const camp = (id, drops) => ({ id, name: `${id} campaign`, channelOwned: false, game: `${id} game`, benefitIds: [`b-${id}`], endAt: END, watchDrops: drops });
const echoCamp = camp('camp-echo', [{ id: 'echo-1', name: 'Echo hat', required: 60 }]);
const foxCamp = camp('camp-fox', [{ id: 'fox-1', name: 'Fox cap', required: 30 }, { id: 'fox-2', name: 'Fox coat', required: 90 }]);
const channel = (id, login, displayName, campaigns) => ({ id, login, displayName, live: true, campaigns });
const echo = channel('20000011', 'echo_247', 'echo_247', [echoCamp]);
const fox = channel('20000012', 'foxtrot', 'Foxtrot', [foxCamp]);
const alpha = channel('10000001', 'alphatv', 'AlphaTV', [{ id: fx.campaigns[1].id, name: 'x', benefitIds: ['b'] }]);
const bravo = channel('10000002', 'bravo', 'Bravo', [{ id: 'camp-b', name: 'y', benefitIds: ['bb'] }]);
const stream = (tabId, ch, t, hidden, withPlayer = true) => ({
  tabId,
  login: ch.login,
  channel: ch,
  tab: { discarded: false, frozen: false },
  player: withPlayer ? { hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: t, muted: false, hidden } : null,
});

/** Inventory with AlphaTV's pouch at `a` minutes and, when `b` is given, Bravo's drop at `b`. */
function inventory(a = 195, b = null) {
  const c = structuredClone(fx.campaigns);
  c[1].timeBasedDrops[0].self.currentMinutesWatched = a;
  if (b != null) {
    const extra = structuredClone(fx.campaigns[1]);
    extra.id = 'camp-b';
    extra.timeBasedDrops = [{ ...structuredClone(fx.campaigns[1].timeBasedDrops[0]), id: 'b-drop' }];
    extra.timeBasedDrops[0].self.currentMinutesWatched = b;
    c.push(extra);
  }
  return c;
}

/** One poll a minute. at(i) gives { streams, session, campaigns }; returns every state and its time. */
function run(polls, at, step = MIN) {
  let s;
  const seen = [];
  for (let i = 0; i < polls; i++) {
    const now = T0 + i * step;
    const { streams, session = null, campaigns = inventory(), owned = null } = at(i);
    const prev = s;
    s = update(s, { campaigns, rewardIds: [], ...(owned ? { rewards: { ids: owned, complete: true } } : {}), session, sessions: session ? [session] : [], streams }, now);
    seen.push({ s: structuredClone(s), now, events: events(prev, s, now) });
  }
  return seen;
}

// 1. The headline on a channel just opened.

/** echo_247 sits unstarted in a background tab for 6 polls; Foxtrot opens in front at poll 6. */
const besideUnstarted = (order = 'echo-first', foxPlayer = true, session = () => null) => (i) => {
  const e = stream(1, echo, 100 + i * 60, true);
  const f = i >= 6 ? [stream(2, fox, 10 + (i - 6) * 60, false, foxPlayer)] : [];
  return { streams: order === 'echo-first' ? [e, ...f] : [...f, e], session: session(i) };
};

for (const order of ['echo-first', 'fox-first']) {
  test(`a channel opened beside a tab Twitch has not started reads as its own first minute (${order})`, () => {
    const seen = run(12, besideUnstarted(order));
    assert.equal(seen[5].s.verdict.unstarted, true, 'echo_247 alone, past its grace: not counting yet');
    for (const p of seen.slice(6, 10)) {
      const [head, detail] = verdictText(p.s, p.now);
      const chip = chipView(p.s, p.now, 'foxtrot', { claimReminders: false });
      assert.equal(p.s.verdict.code, 'waiting', `${(p.now - T0) / MIN}: Foxtrot's first minutes are a wait`);
      assert.ok(!`${head} ${detail} ${chip.title}`.includes('echo_247'), `${(p.now - T0) / MIN}: Foxtrot's page names echo_247: ${head} / ${chip.title}`);
    }
    // Its grace over and still not started: now it is Foxtrot's own news.
    const last = seen[11];
    assert.equal(last.s.verdict.unstarted, true);
    assert.match(last.s.verdict.message, /Foxtrot/);
  });
}

test('a tab with no player answer cannot take the headline from the tab in front', () => {
  // echo_247 in front and unstarted; a Foxtrot tab whose player was never read opens behind it.
  const seen = run(10, (i) => ({ streams: [stream(1, echo, 100 + i * 60, false), ...(i >= 6 ? [stream(2, fox, 0, false, false)] : [])] }));
  assert.match(seen[7].s.verdict.message || '', /echo_247/);
});

test('the session naming the new channel with no minutes still reads as its first minutes', () => {
  const session = (i) => (i >= 6 ? { login: 'foxtrot', displayName: 'Foxtrot', dropId: 'fox-1', minutes: 0, required: 30 } : null);
  const seen = run(10, besideUnstarted('echo-first', true, session));
  for (const p of seen.slice(6, 10)) {
    assert.ok(!(p.s.verdict.message || '').includes('echo_247'), `${(p.now - T0) / MIN}: ${p.s.verdict.message}`);
    assert.notEqual(p.s.verdict.code, 'stalled');
  }
});

test('a page checked before its video mounts already counts as the tab in front', () => {
  // readPlayer() in background.js answers { hasVideo: false, hidden: document.hidden } with no <video>.
  const seen = run(9, (i) => {
    const f = i >= 6 ? [{ ...stream(2, fox, 0, false), player: i === 6 ? { hasVideo: false, hidden: false } : stream(2, fox, (i - 6) * 60, false).player }] : [];
    return { streams: [stream(1, echo, 100 + i * 60, true), ...f] };
  });
  for (const p of seen.slice(6)) assert.equal(p.s.verdict.code, 'waiting', `${(p.now - T0) / MIN}: ${p.s.verdict.message}`);
});

test('a new tab in front does not make a badge warning fire twice', () => {
  // A badge with no minutes warns ("Drops not being tracked", key limited). A tab opened in front
  // and then closed again must not bring the same notification back.
  const badgeCamp = { ...camp('camp-badge', [{ id: 'badge-1', name: 'Badge', required: 60 }]), channelOwned: true, game: null };
  const india = channel('20000015', 'india', 'India', [badgeCamp]);
  const seen = run(14, (i) => ({ streams: [stream(1, india, 100 + i * 60, false), ...(i >= 6 && i < 10 ? [stream(2, fox, 10 + (i - 6) * 60, false)] : [])] }));
  const warnings = seen.flatMap((p) => p.events.filter((e) => e.type === 'warning'));
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
});

test('switching which tab is in front does not notify again', () => {
  // The same two unstarted tabs, the front one swapping every poll, past both graces.
  const seen = run(16, (i) => ({ streams: [stream(1, echo, 100 + i * 60, i % 2 === 0), stream(2, fox, 100 + i * 60, i % 2 === 1)] }));
  const warnings = seen.flatMap((p) => p.events.filter((e) => e.type === 'warning'));
  assert.ok(warnings.length <= 1, JSON.stringify(warnings));
});

// 2. Checking a new channel at once.

test('a page asks for a check when its channel is not in the last poll, and only then', () => {
  const s = run(3, (i) => ({ streams: [stream(1, alpha, 100 + i * 60, false)] }))[2].s;
  assert.equal(checkNeeded(s, 'foxtrot', true), 'new');
  assert.equal(checkNeeded(s, 'alphatv', true), null);
  assert.equal(checkNeeded(s, null, true), null, 'not a channel page');
  assert.equal(checkNeeded(null, 'foxtrot', true), null, 'no state yet: content.js already polls a missing state');
  // Seen last poll as a background tab, now in front: the headline picks the tab in front.
  const behind = run(3, (i) => ({ streams: [stream(1, alpha, 100 + i * 60, true)] }))[2].s;
  assert.equal(checkNeeded(behind, 'alphatv', true), 'shown');
  assert.equal(checkNeeded(behind, 'alphatv', false), null);
});

test('the Badges tab on a channel not checked yet does not say its page must be open', () => {
  const s = run(2, (i) => ({ streams: [stream(1, alpha, 100 + i * 60, false)] }))[1].s;
  const [section] = badgeSections(s.streams, 'foxtrot', T0 + 2 * MIN, []);
  assert.ok(!/needs its own page open/.test(section.note), section.note);
});

test('a lower reading needs time as well as polls before it is believed', () => {
  // Three polls 10 seconds apart reading 190 after 195, then 195 again: the extra checks a new
  // channel brings must not turn a stale read into a credited minute.
  let s;
  const poll = (minutes, now) => { s = update(s, { campaigns: inventory(minutes), rewardIds: [], session: null, sessions: [], streams: [stream(1, alpha, (now - T0) / 1000, false)] }, now); };
  poll(195, T0);
  poll(190, T0 + 10000);
  poll(190, T0 + 20000);
  poll(190, T0 + 30000);
  poll(195, T0 + 40000);
  assert.equal(s.timeline.at(-1).d, 0, 'no minute credited by a recovery from a dip that was never real');
});

test('a lower reading over three polls a minute apart is still believed', () => {
  let s;
  const poll = (minutes, now) => { s = update(s, { campaigns: inventory(minutes), rewardIds: [], session: null, sessions: [], streams: [stream(1, alpha, (now - T0) / 1000, false)] }, now); };
  poll(195, T0);
  poll(190, T0 + MIN);
  poll(190, T0 + 2 * MIN);
  poll(190, T0 + 3 * MIN);
  assert.equal(s.drops[POUCH].peak, 190);
});

// 3. "Earning slowly" belongs to the channel Twitch credits.

test('a slow channel does not make the next one read slow', () => {
  // AlphaTV credited every other minute for 20 minutes, then Twitch credits Bravo every minute.
  const at = (i) => {
    const a = 150 + Math.ceil(Math.min(i, 20) / 2);
    const b = i >= 20 ? 10 + (i - 20) : null;
    const onA = i < 20;
    const session = onA ? { login: 'alphatv', displayName: 'AlphaTV', dropId: POUCH, minutes: a, required: 240 } : { login: 'bravo', displayName: 'Bravo', dropId: 'b-drop', minutes: b, required: 240 };
    return { streams: [stream(1, alpha, 100 + i * 60, true), stream(2, bravo, 100 + i * 60, false)], session, campaigns: inventory(a, b ?? 9) };
  };
  const seen = run(24, at);
  assert.equal(seen[19].s.verdict.slow, true, 'AlphaTV at half rate reads slow');
  for (const p of seen.slice(21)) {
    assert.equal(p.s.verdict.code, 'earning');
    assert.equal(p.s.verdict.channel, 'Bravo');
    assert.equal(p.s.verdict.slow, false, `${(p.now - T0) / MIN}: Bravo counting every minute reads slow`);
    assert.ok(!/slowly/.test(chipView(p.s, p.now, 'bravo', {}).title));
  }
  // The strip under it still covers every minute shown.
  assert.equal(seen[23].s.rate.watched, 23, 'all but the first check, a baseline');
});

test('a session that fails on some polls does not hide a channel that really is slow', () => {
  const at = (i) => {
    const a = 150 + Math.ceil(i / 2);
    const session = i % 3 === 1 ? null : { login: 'alphatv', displayName: 'AlphaTV', dropId: POUCH, minutes: a, required: 240 };
    return { streams: [stream(1, alpha, 100 + i * 60, false)], session, campaigns: inventory(a) };
  };
  const seen = run(20, at);
  assert.equal(seen[19].s.verdict.slow, true);
});

// 4. A campaign not started yet lists its drops.

test("a campaign Twitch has not started lists its drops, with no minutes, on its own channel", () => {
  const seen = run(3, (i) => ({ streams: [stream(2, fox, 10 + i * 60, false)] }));
  const { s, now } = seen[2];
  assert.equal(s.streams[0].channelState, 'unstarted');
  const { drops } = channelDrops(s, 'foxtrot', { pending: true });
  assert.deepEqual(drops.map((d) => [d.name, d.minutes, d.required]), [['Fox cap', null, 30], ['Fox coat', null, 90]]);
  assert.ok(!s.active.some((d) => d.campaignId === 'camp-fox'), 'never in the active list, where minutes left would make it eligible');
  assert.equal(chipView(s, now, 'foxtrot', {}).pct, null, 'no percentage from a drop with no minutes');
});

test('those drops do not replace another tab’s progress on its page', () => {
  // AlphaTV earning in the background, Foxtrot unstarted in front: Foxtrot's page keeps showing
  // the progress the headline is about, as for a drop resting until tomorrow (chip.js).
  const seen = run(4, (i) => ({
    streams: [stream(1, alpha, 100 + i * 60, true), stream(2, fox, 10 + i * 60, false)],
    session: { login: 'alphatv', displayName: 'AlphaTV', dropId: POUCH, minutes: 195 + i, required: 240 },
    campaigns: inventory(195 + i),
  }));
  const { drops, from } = channelDrops(seen[3].s, 'foxtrot', { pending: true });
  assert.equal(from, 'AlphaTV');
  assert.ok(drops.some((d) => d.id === POUCH));
  assert.ok(!drops.some((d) => d.campaignId === 'camp-fox'));
});

test('a badge, an owned reward, a reward campaign or an ended campaign is not listed as not started', () => {
  const badge = { ...camp('camp-badge', [{ id: 'badge-1', name: 'Badge', required: 60 }]), channelOwned: true, game: null };
  const owned = camp('camp-owned', [{ id: 'owned-1', name: 'Owned', required: 60 }]);
  const daily = { ...camp('camp-daily', [{ id: 'daily-1', name: 'Daily', required: 60 }]), rewardCampaign: true };
  const ended = { ...camp('camp-ended', [{ id: 'ended-1', name: 'Ended', required: 60 }]), endAt: '2026-11-01T00:00:00.000Z' };
  const ch = channel('20000013', 'golf', 'Golf', [badge, owned, daily, ended, foxCamp]);
  const { s } = run(3, (i) => ({ streams: [stream(3, ch, 10 + i * 60, false)], owned: ['b-camp-owned'] }))[2];
  assert.equal(s.streams[0].channelState, 'unstarted');
  assert.deepEqual(s.upcoming.map((d) => d.name), ['Fox cap', 'Fox coat']);
});

test('a channel Twitch has started lists no not-started drops', () => {
  const ch = channel('20000014', 'hotel', 'Hotel', [{ id: fx.campaigns[1].id, name: 'x', benefitIds: ['b'] }, foxCamp]);
  const { s } = run(3, (i) => ({ streams: [stream(4, ch, 10 + i * 60, false)] }))[2];
  assert.equal(s.streams[0].channelState, 'eligible');
  assert.deepEqual(s.upcoming, []);
});

test('the grace for a new tab is STALL_MS', () => assert.equal(STALL_MS, 4 * MIN));
