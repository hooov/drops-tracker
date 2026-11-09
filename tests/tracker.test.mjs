import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { update, events, badge, summarize, warning, TIMELINE_MAX, creditRate } from '../extension/lib/tracker.js';
import { timelineCells } from '../extension/lib/minutelog.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/gql-2026-11-06.json', import.meta.url)));
const T0 = Date.parse('2026-11-06T15:00:00Z');
const MIN = 60000;
const POUCH = 'd5ffa3e4-d6fe-11f1-adef-0a58a9feac02';

function campaigns(minutes = 195) {
  const c = structuredClone(fx.campaigns);
  c[1].timeBasedDrops[0].self.currentMinutesWatched = minutes;
  return c;
}
const alpha = { id: '10000001', login: 'alphatv', displayName: 'AlphaTV', live: true, campaigns: [{ id: fx.campaigns[1].id, name: 'x', benefitIds: ['b'] }] };
const bravo = { id: '10000002', login: 'bravo', displayName: 'Bravo', live: true, campaigns: [] };
const stream = (tabId, channel, t, over = {}) => ({
  tabId,
  login: channel.login,
  channel,
  tab: { discarded: false, frozen: false },
  player: { hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: t, muted: false, hidden: true },
  ...over,
});
const obs = (minutes, streams, session = null) => ({ campaigns: campaigns(minutes), rewardIds: [], session, streams });

/** Run minutes-per-poll sequence, one poll a minute, with players advancing. */
function run(mins, streamsAt, session) {
  let s;
  mins.forEach((m, i) => { s = update(s, obs(m, streamsAt(i), session), T0 + i * MIN); });
  return s;
}

test('real inventory: expired campaign reward is unclaimed with a deadline, active drop is tracked', () => {
  const { active, unclaimed } = summarize(fx.campaigns, T0);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, POUCH);
  assert.equal(active[0].remaining, 45);
  assert.equal(active[0].pct, 81);
  assert.deepEqual(unclaimed.map((u) => u.name), ['Oxygen Respirator']);
  assert.equal(unclaimed[0].needsConnect, true);
  assert.equal(unclaimed[0].claimBy, Date.parse('2026-11-11T12:44:59.999Z'));
});

test('unfinished drop in an expired campaign is not reported as in progress', () => {
  const { active } = summarize(fx.campaigns, T0);
  assert.ok(!active.some((d) => d.name === 'Mailbox'));
});

test('reward past the 7 day claim window disappears', () => {
  const { unclaimed } = summarize(fx.campaigns, Date.parse('2026-11-12T00:00:00Z'));
  assert.equal(unclaimed.length, 0);
});

test('minutes rising means earning, and the credited tab is labelled against the no-drops tab', () => {
  const session = { login: 'alphatv', displayName: 'AlphaTV', dropId: POUCH };
  const s = run([195, 196, 197], (i) => [stream(1, alpha, 100 + i * 60), stream(2, bravo, 500 + i * 60)], session);
  assert.equal(s.verdict.code, 'earning');
  assert.equal(s.verdict.channel, 'AlphaTV');
  const [a, b] = s.streams;
  assert.equal(a.credited, true);
  assert.equal(a.channelState, 'eligible');
  assert.equal(b.credited, false);
  assert.equal(b.channelState, 'no_drops');
});

test('fresh start is waiting, not stalled, until the threshold passes', () => {
  const s = run([195, 195], (i) => [stream(1, alpha, 100 + i * 60)]);
  assert.equal(s.verdict.code, 'waiting');
});

test('player fine but no minutes for 4 min: stalled with reload advice', () => {
  const mins = [195, 196, 196, 196, 196, 196];
  const s = run(mins, (i) => [stream(1, alpha, 100 + i * 60)]);
  assert.equal(s.verdict.code, 'stalled');
  assert.equal(s.verdict.cause, 'uncounted');
  assert.equal(s.verdict.tabId, 1);
});

test('a single tick arriving late does not trip the alarm', () => {
  const mins = [195, 196, 196, 196, 197, 197, 197, 198];
  let s;
  mins.forEach((m, i) => {
    s = update(s, obs(m, [stream(1, alpha, 100 + i * 60)]), T0 + i * MIN);
    if (i > 1) assert.notEqual(s.verdict.code, 'stalled', `poll ${i}`);
  });
});

test('frozen player is caught fast and named', () => {
  const mins = [195, 196, 196, 196];
  const s = run(mins, (i) => [stream(1, alpha, i < 1 ? 100 : 160)]);
  assert.equal(s.verdict.code, 'stalled');
  assert.equal(s.verdict.cause, 'frozen');
  assert.match(s.verdict.message, /AlphaTV player is frozen/);
});

test('sleeping (discarded) tab is reported as asleep, without a video reading', () => {
  const mins = [195, 196, 196, 196];
  const s = run(mins, (i) => [stream(1, alpha, 100 + i * 60, i > 0 ? { tab: { discarded: true }, player: null } : {})]);
  assert.equal(s.verdict.cause, 'asleep');
});

test('paused player is reported as paused', () => {
  const mins = [195, 196, 196, 196];
  const s = run(mins, (i) => [stream(1, alpha, 100 + i * 60, i > 0 ? { player: { hasVideo: true, paused: true, readyState: 4, currentTime: 160 } } : {})]);
  assert.equal(s.verdict.cause, 'paused');
});

test('watching only a no-drops channel is idle, never stalled', () => {
  const s = run([195, 195, 195, 195, 195, 195, 195], (i) => [stream(2, bravo, 100 + i * 60)]);
  assert.equal(s.verdict.code, 'idle');
  assert.equal(s.verdict.hasStreams, true);
});

test('offline channel page is not a candidate', () => {
  const off = { ...alpha, live: false };
  const s = run([195, 195, 195, 195, 195, 195], (i) => [stream(1, off, 100)]);
  assert.equal(s.verdict.code, 'idle');
  assert.equal(s.streams[0].channelState, 'offline');
});

test('closing the stream stops saying earning within 3 min', () => {
  const s = run([195, 196, 196, 196, 196], (i) => (i < 2 ? [stream(1, alpha, 100 + i * 60)] : []));
  assert.equal(s.verdict.code, 'idle');
  assert.equal(s.verdict.hasStreams, false);
});

test('minutes rising with no eligible tab: earning, source unknown (phone or other browser)', () => {
  const s = run([195, 196], () => []);
  assert.equal(s.verdict.code, 'earning');
  assert.equal(s.verdict.channel, null);
});

test('more than two playing streams with no gain names the limit', () => {
  const mins = [195, 196, 196, 196, 196, 196];
  const s = run(mins, (i) => [stream(1, alpha, 100 + i * 60), stream(2, bravo, 200 + i * 60), stream(3, { ...bravo, login: 'x', id: '9' }, 300 + i * 60)]);
  assert.equal(s.verdict.cause, 'too_many');
  assert.match(s.verdict.message, /3 streams/);
});

// Measured 2026-11-09: a second playing stream on another channel stopped credit for 10.5 min and
// closing it brought minutes back. Before this, two playing streams read "uncounted", whose advice
// (and Auto-reload) is to reload the earning tab, which does not remove the cause.
test('a second playing stream with no gain is named as the cause, not reload advice', () => {
  const mins = [195, 196, 196, 196, 196, 196];
  const s = run(mins, (i) => [stream(1, alpha, 100 + i * 60), stream(2, bravo, 200 + i * 60)]);
  assert.equal(s.verdict.code, 'stalled');
  assert.equal(s.verdict.cause, 'second_stream');
  assert.equal(s.verdict.tabId, 1, 'the earning tab, not the other one');
  assert.equal(s.verdict.otherTabId, 2);
  assert.match(s.verdict.message, /Bravo is also playing/);
  assert.match(s.verdict.message, /Close or pause Bravo/);
  assert.doesNotMatch(s.verdict.message, /reload/i);
});

test('the same channel open in two playing tabs says so', () => {
  const mins = [195, 196, 196, 196, 196, 196];
  const s = run(mins, (i) => [stream(1, alpha, 100 + i * 60), stream(2, alpha, 200 + i * 60)]);
  assert.equal(s.verdict.cause, 'second_stream');
  assert.match(s.verdict.message, /AlphaTV is playing in two tabs/);
});

test('a second tab that is paused is not a second stream', () => {
  const mins = [195, 196, 196, 196, 196, 196];
  const paused = { player: { hasVideo: true, paused: true, readyState: 4, currentTime: 200 } };
  const s = run(mins, (i) => [stream(1, alpha, 100 + i * 60), stream(2, bravo, 200, paused)]);
  assert.equal(s.verdict.cause, 'uncounted');
});

test('network failure is not a stall, and the clock restarts after an outage', () => {
  let s = run([195, 196], (i) => [stream(1, alpha, 100 + i * 60)]);
  s = update(s, { error: { kind: 'network', message: 'Could not reach Twitch' } }, T0 + 6 * MIN);
  assert.equal(s.verdict.code, 'error');
  s = update(s, obs(196, [stream(1, alpha, 500)]), T0 + 7 * MIN);
  assert.equal(s.verdict.code, 'waiting', 'minutes were unknowable during the outage');
});

test('PC sleep gap does not produce a false stall on wake', () => {
  let s = run([195, 196], (i) => [stream(1, alpha, 100 + i * 60)]);
  s = update(s, obs(196, [stream(1, alpha, 900)]), T0 + 120 * MIN);
  assert.equal(s.verdict.code, 'waiting');
});

test('hash rotation and logout get their own verdicts', () => {
  assert.equal(update(undefined, { error: { kind: 'api_changed', message: 'x' } }, T0).verdict.code, 'api_changed');
  assert.equal(update(undefined, { error: { kind: 'auth', message: 'x' } }, T0).verdict.code, 'signed_out');
});

test('finished campaign still listed on a channel is not eligible', () => {
  const done = campaigns();
  done[1].timeBasedDrops[0].self.isClaimed = true;
  const s = update(undefined, { campaigns: done, rewardIds: [], session: null, streams: [stream(1, alpha, 1)] }, T0);
  assert.equal(s.streams[0].channelState, 'finished');
});

test('campaign not started yet never reads as hung; one whose rewards are all owned is finished', () => {
  const fresh = { ...alpha, campaigns: [{ id: 'new', name: 'n', benefitIds: ['b1'] }] };
  const noMinutes = (i) => ({ campaigns: [], rewards: { ids: [], complete: true }, session: null, streams: [stream(1, fresh, 100 + i * 60)] });
  let s;
  for (let i = 0; i < 2; i++) s = update(s, noMinutes(i), T0 + i * MIN);
  assert.equal(s.streams[0].channelState, 'unstarted');
  assert.equal(s.verdict.code, 'waiting');
  for (let i = 2; i < 8; i++) s = update(s, noMinutes(i), T0 + i * MIN);
  assert.equal(s.verdict.code, 'idle');
  assert.equal(s.verdict.limited, true);
  assert.match(s.verdict.message, /may need your game account linked/);
  const b = update(undefined, { campaigns: [], rewards: { ids: ['b1'], complete: true }, session: null, streams: [stream(1, fresh, 1)] }, T0);
  assert.equal(b.streams[0].channelState, 'finished');
});

test('reward list surviving the polls where that field failed', () => {
  const fresh = { ...alpha, campaigns: [{ id: 'new', name: 'n', benefitIds: ['b1'] }] };
  const at = (rewards) => ({ campaigns: [], rewards, session: null, streams: [stream(1, fresh, 1)] });
  let s = update(undefined, at({ ids: ['b1'], complete: true }), T0);
  assert.equal(s.streams[0].channelState, 'finished');
  s = update(s, at({ ids: null, complete: false }), T0 + MIN);
  assert.equal(s.streams[0].channelState, 'finished', 'a failed field must not forget what was owned');
});

test('a value flapping up and down is not progress', () => {
  let s = run([195, 195], (i) => [stream(1, alpha, 100 + i * 60)]);
  // Old enough that only new gains could say "earning".
  for (let i = 2; i < 8; i++) s = update(s, obs(i % 2 ? 194 : 195, [stream(1, alpha, 100 + i * 60)]), T0 + i * MIN);
  assert.notEqual(s.verdict.code, 'earning');
  assert.equal(s.verdict.code, 'stalled');
});

test('a drop missing from one answer does not count as gaining when it returns', () => {
  let s = run([195, 195], (i) => [stream(1, alpha, 100 + i * 60)]);
  for (let i = 2; i < 8; i++) {
    const answer = i === 4 ? { ...obs(195, [stream(1, alpha, 100 + i * 60)]), campaigns: [] } : obs(195, [stream(1, alpha, 100 + i * 60)]);
    s = update(s, answer, T0 + i * MIN);
  }
  assert.notEqual(s.verdict.code, 'earning');
});

test('a lasting drop in minutes is believed, so a multi-day reset can earn again', () => {
  let s = run([60, 61], (i) => [stream(1, alpha, 100 + i * 60)]);
  [0, 0, 0, 0].forEach((m, k) => { s = update(s, obs(m, [stream(1, alpha, 300 + k * 60)]), T0 + (2 + k) * MIN); });
  s = update(s, obs(1, [stream(1, alpha, 900)]), T0 + 6 * MIN);
  assert.equal(s.verdict.code, 'earning');
});

test('the session seeing minutes first still counts as a gain, once', () => {
  const sess = (m) => ({ login: 'alphatv', displayName: 'AlphaTV', dropId: POUCH, minutes: m });
  let s = update(undefined, obs(195, [stream(1, alpha, 100)], sess(195)), T0);
  s = update(s, obs(195, [stream(1, alpha, 160)], sess(196)), T0 + MIN);
  assert.equal(s.lastGainAt, T0 + MIN);
  s = update(s, obs(196, [stream(1, alpha, 220)], sess(196)), T0 + 2 * MIN);
  assert.equal(s.lastGainAt, T0 + MIN, 'inventory catching up is not a second gain');
});

test('a drop whose later window has not opened is not in progress', () => {
  const c = structuredClone(fx.campaigns);
  c[1].timeBasedDrops[0].startAt = new Date(T0 + 3600000).toISOString();
  assert.equal(summarize(c, T0).active.length, 0);
});

test('unknown status falls back to the dates instead of hiding every drop', () => {
  const c = structuredClone(fx.campaigns);
  c[1].status = 'LIVE';
  assert.equal(summarize(c, T0).active.length, 1);
  c[1].endAt = '2020-01-01T00:00:00Z';
  c[1].timeBasedDrops[0].endAt = '2020-01-01T00:00:00Z';
  assert.equal(summarize(c, T0).active.length, 0);
});

test('missing or malformed dates do not make drops or rewards vanish', () => {
  const c = structuredClone(fx.campaigns);
  delete c[1].endAt;
  delete c[1].timeBasedDrops[0].endAt;
  delete c[0].endAt;
  const { active, unclaimed } = summarize(c, T0);
  assert.equal(active.length, 1);
  assert.equal(active[0].endsAt, null);
  assert.equal(unclaimed[0].claimBy, null);
});

test('a missing isClaimed does not nag about claiming', () => {
  const c = structuredClone(fx.campaigns);
  delete c[0].timeBasedDrops[1].self.isClaimed;
  assert.equal(summarize(c, T0).unclaimed.length, 0);
});

test('a player that cannot be read never shortens the wait or claims to be dead', () => {
  const blind = { player: null };
  const quick = run([195, 196, 196, 196], (i) => [stream(1, alpha, 0, blind)]);
  assert.equal(quick.verdict.code, 'earning', 'still inside the 4 minute window');
  const later = run([195, 196, 196, 196, 196, 196, 196], (i) => [stream(1, alpha, 0, blind)]);
  assert.equal(later.verdict.code, 'stalled');
  assert.match(later.verdict.message, /Cannot see a player/);
});

test('channels that could not be checked give "cannot check", not a stall or a clean idle', () => {
  const unseen = { ...alpha, unknown: true, live: false, campaigns: [] };
  const s = run([195, 195, 195, 195, 195, 195], (i) => [stream(1, unseen, 100 + i * 60)]);
  assert.equal(s.verdict.code, 'idle');
  assert.equal(s.verdict.limited, true);
  assert.equal(warning(s, T0 + 6 * MIN).short, 'Drops not being tracked');
  assert.equal(badge(s).text, '?');
});

test('rising minutes still read as earning when channel checks are down', () => {
  const unseen = { ...alpha, unknown: true, live: false, campaigns: [] };
  const s = run([195, 196], (i) => [stream(1, unseen, 100 + i * 60)]);
  assert.equal(s.verdict.code, 'earning');
});

test('old or damaged saved state cannot crash a poll', () => {
  for (const old of [{}, { verdict: null }, { timeline: 'x' }, { drops: { [POUCH]: 195 }, verdict: { code: 'earning' } }]) {
    const s = update(old, obs(196, [stream(1, alpha, 1)]), T0);
    assert.ok(s.verdict.code, JSON.stringify(old));
  }
  const migrated = update({ drops: { [POUCH]: 195 } }, obs(196, []), T0);
  assert.deepEqual(migrated.drops[POUCH], { peak: 196, low: 0, at: T0 });
});

test('earned drop waiting on claim blocks a later drop and is named as the cause', () => {
  const c = campaigns();
  const first = c[1].timeBasedDrops[0];
  c[1].timeBasedDrops = [
    { ...structuredClone(first), id: 'a', requiredMinutesWatched: 60, self: { currentMinutesWatched: 60, dropInstanceID: 'i', hasPreconditionsMet: true, isClaimed: false }, benefitEdges: [{ benefit: { id: 'ba', name: 'First' } }] },
    { ...structuredClone(first), id: 'b', requiredMinutesWatched: 240, self: { currentMinutesWatched: 60, dropInstanceID: null, hasPreconditionsMet: true, isClaimed: false } },
  ];
  let s;
  for (let i = 0; i < 6; i++) s = update(s, { campaigns: c, rewardIds: [], session: null, streams: [stream(1, alpha, 100 + i * 60)] }, T0 + i * MIN);
  assert.equal(s.verdict.cause, 'claim_first');
  assert.match(s.verdict.message, /First/);
});

test('rate counts minutes added, not polls with a gain, and calls half speed slow', () => {
  // +1 every other minute, as seen on a real session on 2026-11-06.
  const half = Array.from({ length: 21 }, (_, i) => 195 + Math.floor(i / 2));
  const s = run(half, (i) => [stream(1, alpha, 100 + i * 60)]);
  assert.equal(s.verdict.code, 'earning');
  assert.equal(s.verdict.slow, true);
  assert.deepEqual(s.rate, { watched: 21, counted: 10 });
  // Two minutes landing in one poll is full speed that arrived late, not half speed.
  const batched = Array.from({ length: 21 }, (_, i) => 195 + i - (i % 2));
  const b = run(batched, (i) => [stream(1, alpha, 100 + i * 60)]);
  assert.equal(b.verdict.slow, false);
  assert.ok(b.rate.counted >= 19);
});

test('full speed is not slow, and too little data never is', () => {
  const s = run(Array.from({ length: 15 }, (_, i) => 195 + i), (i) => [stream(1, alpha, 100 + i * 60)]);
  assert.equal(s.verdict.slow, false);
  const early = run([195, 195, 195, 196], (i) => [stream(1, alpha, 100 + i * 60)]);
  assert.equal(early.verdict.slow, false);
});

test('timeline saved by the previous version, without minute counts, still works', () => {
  const s = run([195, 196], (i) => [stream(1, alpha, 100 + i * 60)]);
  s.timeline = s.timeline.map(({ d, ...rest }) => rest);
  const next = update(s, obs(197, [stream(1, alpha, 300)]), T0 + 2 * MIN);
  assert.equal(next.verdict.code, 'earning');
  assert.ok(next.rate.counted >= 1);
});

test('reward art comes through for the panel', () => {
  const c = structuredClone(fx.campaigns);
  c[1].timeBasedDrops[0].benefitEdges[0].benefit.imageAssetURL = 'https://static-cdn.jtvnw.net/x.png';
  assert.equal(summarize(c, T0).active[0].image, 'https://static-cdn.jtvnw.net/x.png');
});

test('stalled notifies once per episode, and a new episode notifies again', () => {
  let s;
  const fired = [];
  [195, 196, 196, 196, 196, 196, 196, 196, 197, 197, 197, 197, 197, 197].forEach((m, i) => {
    const now = T0 + i * MIN;
    const next = update(s, obs(m, [stream(1, alpha, 100 + i * 60)]), now);
    fired.push(...events(s, next, now).filter((e) => e.type === 'warning'));
    s = next;
  });
  assert.equal(fired.length, 2);
});

test('channel losing eligibility while earning warns, sticks, and clears when earning resumes', () => {
  const noLongerDrops = { ...alpha, campaigns: [] };
  let s;
  const at = (i, m, ch) => { const now = T0 + i * MIN; const next = update(s, obs(m, [stream(1, ch, 100 + i * 60)]), now); const ev = events(s, next, now); s = next; return { now, ev }; };
  at(0, 195, alpha);
  at(1, 196, alpha);
  at(2, 197, alpha);
  at(3, 197, noLongerDrops);
  at(4, 197, noLongerDrops);
  assert.equal(s.verdict.code, 'earning', 'a late tick is still possible for 2.5 min after the last gain');
  let r = at(5, 197, noLongerDrops);
  assert.equal(s.verdict.code, 'idle');
  assert.equal(s.verdict.lost, true);
  assert.equal(r.ev.filter((e) => e.type === 'warning').length, 1);
  assert.equal(warning(s, r.now).short, 'Stopped earning Drops');
  assert.equal(badge(s).text, 'STOP');
  r = at(6, 197, noLongerDrops);
  assert.equal(s.verdict.lost, true, 'stays warned until it is resolved');
  assert.equal(r.ev.filter((e) => e.type === 'warning').length, 0, 'same episode does not re-notify');
  r = at(7, 198, alpha);
  assert.equal(s.verdict.code, 'earning');
  assert.equal(warning(s, r.now), null);
});

test('closing every tab is deliberate and does not warn', () => {
  const s = run([195, 196, 196, 196, 196], (i) => (i < 2 ? [stream(1, alpha, 100 + i * 60)] : []));
  assert.equal(s.verdict.lost, undefined);
  assert.equal(warning(s, T0 + 5 * MIN), null);
});

test('just browsing a no-drops channel never warns', () => {
  const s = run([195, 195, 195, 195, 195, 195], (i) => [stream(2, bravo, 100 + i * 60)]);
  assert.equal(warning(s, T0 + 6 * MIN), null);
  assert.equal(badge(s).text, '');
});

test('tracker blind spots warn: API change now, network only after the gap, logout only if it was tracking', () => {
  const tracking = run([195, 196], (i) => [stream(1, alpha, 100 + i * 60)]);
  const net = { error: { kind: 'network', message: 'Could not reach Twitch' } };
  const blip = update(tracking, net, T0 + 2 * MIN);
  assert.equal(warning(blip, T0 + 2 * MIN), null, 'one failed poll is a blip');
  const outage = update(blip, net, T0 + 6 * MIN);
  assert.match(warning(outage, T0 + 6 * MIN).message, /Progress is unknown/);
  const api = update(tracking, { error: { kind: 'api_changed', message: 'x' } }, T0 + 2 * MIN);
  assert.equal(warning(api, T0 + 2 * MIN).short, 'Drops not being tracked');
  const auth = { error: { kind: 'auth', message: 'x' } };
  assert.equal(warning(update(undefined, auth, T0), T0), null, 'fresh install, never tracked');
  assert.ok(warning(update(tracking, auth, T0 + 2 * MIN), T0 + 2 * MIN));
});

test('claim notifies once, only for live campaigns', () => {
  const c = campaigns();
  c[1].timeBasedDrops[0].self.dropInstanceID = 'inst';
  c[1].timeBasedDrops[0].self.currentMinutesWatched = 240;
  const first = update(undefined, { campaigns: c, rewardIds: [], session: null, streams: [] }, T0);
  const ev = events(undefined, first, T0);
  assert.deepEqual(ev.map((e) => e.message), ['Pouch of Violet Dust is ready to claim.']);
  const second = update(first, { campaigns: c, rewardIds: [], session: null, streams: [] }, T0 + MIN);
  assert.equal(events(first, second, T0 + MIN).length, 0);
  assert.equal(badge(second).text, 'CLM');
});

test('the toolbar badge keeps showing the next drop while earning with a claim waiting', () => {
  const earning = { verdict: { code: 'earning' }, active: [{ pct: 51 }], unclaimed: [{ campaignActive: true }] };
  const b = badge(earning);
  assert.equal(b.text, '51%');
  assert.equal(b.color, '#b54708', 'amber, so the claim is still flagged');
  assert.equal(badge({ ...earning, active: [] }).text, 'CLM', 'nothing left to earn');
  assert.equal(badge({ ...earning, verdict: { code: 'idle' } }).text, 'CLM', 'not earning');
  assert.equal(badge({ ...earning, verdict: { code: 'idle', lost: true } }).text, 'STOP', 'stopping outranks a claim');
  assert.equal(badge({ ...earning, verdict: { code: 'idle', limited: true } }).text, '?', 'not knowing outranks a claim');
  assert.equal(badge({ ...earning, unclaimed: [] }).color, '#067647', 'green without a claim waiting');
});

test('badge reflects verdict', () => {
  const earning = run([195, 196], (i) => [stream(1, alpha, 100 + i * 60)]);
  assert.deepEqual(badge(earning).text, '81%');
  const stalled = run([195, 196, 196, 196, 196, 196], (i) => [stream(1, alpha, 100 + i * 60)]);
  assert.equal(badge(stalled).text, 'HUNG');
});

test('state stays bounded: timeline capped, closed tabs and vanished drops are dropped', () => {
  let s;
  for (let i = 0; i < 300; i++) {
    s = update(s, obs(195 + i, i < 299 ? [stream(i, alpha, i * 60)] : []), T0 + i * MIN);
  }
  assert.ok(s.timeline.length <= TIMELINE_MAX);
  assert.equal(Object.keys(s.tabs).length, 0);
  assert.ok(Object.keys(s.drops).length <= 3);
});

test('previous state is not mutated (it is what the next poll diffs against)', () => {
  const s1 = update(undefined, obs(195, []), T0);
  const snapshot = JSON.stringify(s1);
  update(s1, obs(196, []), T0 + MIN);
  assert.equal(JSON.stringify(s1), snapshot);
});

// The minute strip. Twitch credits on its own clock: a check finds nothing, the next finds two.
const tl = (...cells) => cells.map(([g, w, d], i) => ({ m: 100 + i, g, w, d }));

test('strip: a minute credited late is drawn as counted, not lost', () => {
  assert.deepEqual(timelineCells(tl([0, 1, 0], [1, 1, 2]), 2), ['gain', 'gain']);
});

test('strip: late credit fills the nearest earlier miss, skipping counted and idle minutes', () => {
  const cells = timelineCells(tl([0, 1, 0], [0, 0, 0], [1, 1, 1], [0, 1, 0], [1, 1, 3]), 5);
  assert.deepEqual(cells, ['gain', '', 'gain', 'gain', 'gain']);
});

test('strip: a minute never credited stays red, and an idle minute stays empty', () => {
  assert.deepEqual(timelineCells(tl([0, 0, 0], [0, 1, 0], [1, 1, 1], [1, 1, 1]), 4), ['', 'miss', 'gain', 'gain']);
});

test('strip: entries saved before minute counts existed are drawn as before', () => {
  assert.deepEqual(timelineCells(tl([0, 1], [1, 1]), 2), ['miss', 'gain']);
});

test('strip agrees with the count under it when credit lags', () => {
  // 27 watched minutes, six of them found empty and made up by a double the minute after.
  const rows = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 27; i++) rows.push(i % 4 === 1 && i < 24 ? [0, 1, 0] : i % 4 === 2 && i < 24 ? [1, 1, 2] : [1, 1, 1]);
  const timeline = tl(...rows);
  const cells = timelineCells(timeline);
  const rate = creditRate(timeline);
  assert.equal(rate.counted, 27);
  assert.equal(cells.filter((c) => c === 'gain').length, rate.counted);
  assert.equal(cells.filter((c) => c === 'miss').length, 0);
});
