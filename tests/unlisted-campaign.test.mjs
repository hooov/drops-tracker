// A game campaign the channel offers but Inventory leaves out, while Twitch's session credits it.
// Seen 2026-11-12 on a Streamer Awards Minecraft drop: Twitch's page showed it rising, and the
// tracker said "may need your game account linked" and drew those minutes dead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { update, warning } from '../extension/lib/tracker.js';
import { verdictTone } from '../extension/lib/states.js';

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
