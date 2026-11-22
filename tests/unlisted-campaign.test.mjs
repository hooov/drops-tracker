// A game campaign the channel offers but Inventory leaves out, while Twitch's session credits it.
// Seen 2026-11-12 on a Streamer Awards Minecraft drop: Twitch's page showed it rising, and the
// tracker said "may need your game account linked" and drew those minutes dead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { warning } from '../extension/lib/tracker.js';
import { update } from './invariants.mjs';
import { verdictTone } from '../extension/lib/states.js';
import { channelDrops } from '../extension/lib/chip.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/gql-2026-11-06.json', import.meta.url)));
const T0 = Date.parse('2026-11-06T15:00:00Z');
const MIN = 60000;
const END = '2026-11-12T12:29:59.999Z';
const listed = fx.campaigns[1];

const hoodie = { id: 'mc', name: 'Frog hoodie', channelOwned: false, game: 'Minecraft', benefitIds: ['hoodie'], endAt: END, watchDrops: [{ id: 'mc-drop', name: 'Hoodie', required: 60 }] };
const channel = (campaigns) => ({ id: '20000001', login: 'charlie', displayName: 'Charlie', live: true, campaigns });
const stream = (ch, t) => ({ tabId: 1, login: 'charlie', channel: ch, tab: { discarded: false, frozen: false }, player: { hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: t, hidden: true } });
const sessionAt = (minutes) => ({ login: 'charlie', displayName: 'Charlie', dropId: 'mc-drop', minutes, required: 60 });

/** One poll a minute. sessionMinutes(i) gives the session reading, inventory(i) the Inventory list. */
function run(polls, ch, sessionMinutes, inventory = () => []) {
  let s;
  const seen = [];
  for (let i = 0; i < polls; i++) {
    const session = sessionAt(sessionMinutes(i));
    const now = T0 + i * MIN;
    s = update(s, { campaigns: inventory(i), rewardIds: [], session, sessions: [session], streams: [stream(ch, 100 + i * 60)] }, now);
    seen.push({ verdict: s.verdict, minute: s.timeline[s.timeline.length - 1], warn: warning(s, now) });
  }
  return { s, seen };
}

test('session minutes rising on a campaign missing from Inventory read as earning', () => {
  const { s, seen } = run(8, channel([hoodie]), (i) => 10 + i);
  assert.equal(seen[0].verdict.code, 'waiting', 'the first session reading is only a baseline');
  for (const [i, p] of seen.slice(1).entries()) {
    assert.equal(p.verdict.code, 'earning', `poll ${i + 1}`);
    assert.equal(p.minute.g, true, `poll ${i + 1} counted, not dead`);
    assert.equal(p.warn, null);
  }
  assert.equal(s.streams[0].channelState, 'eligible');
  assert.equal(s.active[0].game, 'Minecraft');
  assert.equal(verdictTone(s.verdict), 'ok');
});

test('a campaign missing from Inventory that the session names at 0 is still unstarted, never a hang', () => {
  const { s, seen } = run(10, channel([hoodie]), () => 0);
  assert.equal(s.streams[0].channelState, 'unstarted');
  assert.ok(seen.every((p) => p.verdict.code !== 'stalled'));
  assert.equal(s.verdict.limited, true);
});

test('a listed campaign sitting flat does not hide credit landing on an unlisted one on the same channel', () => {
  // Inventory's drop stays at 195 while Twitch credits the hoodie: before the fix those minutes
  // were drawn dead and the channel went on to read as hung.
  const { seen } = run(8, channel([{ id: listed.id, name: 'x', benefitIds: ['b'] }, hoodie]), (i) => 10 + i, () => structuredClone(fx.campaigns));
  for (const [i, p] of seen.slice(1).entries()) {
    assert.equal(p.verdict.code, 'earning', `poll ${i + 1}`);
    assert.equal(p.minute.g, true, `poll ${i + 1} counted, not dead`);
  }
});

test('when the unlisted campaign stops rising, it is judged like any other: a hang after the limit', () => {
  const { s } = run(8, channel([hoodie]), (i) => 10 + Math.min(i, 2));
  assert.equal(s.verdict.code, 'stalled');
});

test('a campaign Twitch has not started reads "Not counting yet", not "Cannot check streams" (2026-11-13)', async () => {
  const { verdictText } = await import('../extension/lib/panel.js');
  const { s } = run(10, channel([hoodie]), () => 0);
  assert.equal(s.verdict.unstarted, true);
  assert.equal(verdictText(s, T0 + 10 * MIN)[0], 'Not counting yet');
  // A failed lookup is the one case that headline is for.
  const unknown = { ...s, verdict: { code: 'idle', hasStreams: true, limited: true, message: 'x' } };
  assert.equal(verdictText(unknown, T0 + 10 * MIN)[0], 'Cannot check streams');
});

// Bundle 2026-11-19: the session named a campaign's first drop at 250 of 60, done, and only that
// drop was built from it, so the channel read "finished" while Twitch's page offered the second
// one at 0 of 60. Names replaced.
const chest = { id: 'gta-chest', name: 'Chest', required: 60, benefitIds: ['chest'] };
const chain = { id: 'gta-chain', name: 'Chain', required: 60, benefitIds: ['chain'] };
const launch = (second = chain) => ({ id: 'gta', name: 'Launch', channelOwned: false, game: 'Launch', benefitIds: ['chest', 'chain'], endAt: END, watchDrops: [chest, second] });

function runLaunch(polls, { second, named = () => ['gta-chest', 250], owned = [] } = {}) {
  let s;
  const seen = [];
  for (let i = 0; i < polls; i++) {
    const [dropId, minutes] = named(i);
    const session = { login: 'charlie', displayName: 'Charlie', dropId, minutes, required: 60 };
    s = update(s, { campaigns: [], rewards: { ids: owned, complete: true }, session, sessions: [session], streams: [stream(channel([launch(second)]), 100 + i * 60)] }, T0 + i * MIN);
    seen.push(s.verdict);
  }
  return { s, seen };
}

test('a session campaign whose named drop is done still offers its next drop: not counting yet, not finished', async () => {
  const { verdictText } = await import('../extension/lib/panel.js');
  const { s, seen } = runLaunch(10);
  assert.equal(s.streams[0].channelState, 'unstarted');
  assert.ok(seen.every((v) => v.code !== 'stalled'), 'no reading of the next drop, so never a hang');
  assert.equal(s.verdict.unstarted, true);
  assert.match(s.verdict.message, /No minutes are rising on Charlie, and Twitch reports none for its Chain/);
  assert.doesNotMatch(s.verdict.message, /account linked/);
  assert.equal(verdictText(s, T0 + 10 * MIN)[0], 'Not counting yet');
  // Unknown minutes are not listed as 0, and not in the active list, where they would read as eligible.
  assert.deepEqual(s.active.map((d) => [d.name, d.minutes]), [['Chest', 250]]);
  // My Drops lists it on its channel, as Twitch's panel does; the chip's percentage does not use it.
  assert.deepEqual(channelDrops(s, 'charlie', { pending: true }).drops.map((d) => [d.name, d.minutes]), [['Chest', 250], ['Chain', null]]);
  assert.deepEqual(channelDrops(s, 'charlie').drops.map((d) => d.name), ['Chest']);
});

test('the next drop already owned: the campaign is finished', () => {
  const { s } = runLaunch(6, { owned: ['chain'] });
  assert.equal(s.streams[0].channelState, 'finished');
});

test('when Twitch starts crediting the next drop it reads as earning, and once that is done the campaign is finished', () => {
  const named = (i) => (i < 3 ? ['gta-chest', 250] : ['gta-chain', Math.min(i - 2, 60)]);
  const { s } = runLaunch(8, { named });
  assert.equal(s.streams[0].channelState, 'eligible');
  assert.equal(s.verdict.code, 'earning');
  assert.deepEqual(s.active.find((d) => d.id === 'gta-chain')?.minutes, 5);
  // The session no longer names the chest, so only its reading of 250 says it is done.
  const after = runLaunch(70, { named }).s;
  assert.equal(after.streams[0].channelState, 'finished');
  assert.deepEqual(after.pending, []);
});

test('a next drop whose window opens later reads as blocked with its date', () => {
  const opens = new Date(T0 + 24 * 60 * MIN).toISOString();
  const { s } = runLaunch(6, { second: { ...chain, startAt: opens } });
  assert.equal(s.streams[0].channelState, 'blocked');
  assert.equal(s.streams[0].blockedOpens, Date.parse(opens));
});

test('a drop whose window closed unearned does not hide a later window: blocked, not finished', () => {
  const closed = new Date(T0 - 60 * MIN).toISOString();
  const opens = new Date(T0 + 24 * 60 * MIN).toISOString();
  const day1 = { ...chain, id: 'gta-day1', endAt: closed };
  const day2 = { ...chain, id: 'gta-day2', name: 'Day 2', benefitIds: ['day2'], startAt: opens };
  const ch = channel([{ ...launch(), watchDrops: [chest, day1, day2] }]);
  let s;
  for (let i = 0; i < 6; i++) {
    const session = { login: 'charlie', displayName: 'Charlie', dropId: 'gta-chest', minutes: 250, required: 60 };
    s = update(s, { campaigns: [], rewards: { ids: [], complete: true }, session, sessions: [session], streams: [stream(ch, 100 + i * 60)] }, T0 + i * MIN);
  }
  assert.equal(s.streams[0].channelState, 'blocked');
  assert.equal(s.streams[0].blockedOpens, Date.parse(opens));
});

// Until 2026-11-20 this raised a pill and a notification, "Drops not counting yet". Usually there is
// nothing to do but wait, so now only the panel says it, never "not being tracked" either.
test('a drop Twitch has not started raises no pill or notification; the panel says not counting yet', async () => {
  const { s } = run(10, channel([hoodie]), () => 0);
  assert.equal(warning(s, T0 + 10 * MIN), null);
  const { verdictText } = await import('../extension/lib/panel.js');
  assert.equal(verdictText(s, T0 + 10 * MIN)[0], 'Not counting yet');
});

test('an offline channel is not said to have no Drops', async () => {
  const { verdictText } = await import('../extension/lib/panel.js');
  const s = { verdict: { code: 'idle', hasStreams: true }, streams: [{ login: 'charlie', displayName: 'Charlie', channelState: 'offline' }] };
  assert.deepEqual(verdictText(s, T0), ['Not earning', 'Charlie is offline, so it cannot earn right now.']);
});
