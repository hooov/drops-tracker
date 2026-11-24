// Whether the owned reward list was whole, and when (drops-tracker#12). "Not earned" may only be said
// from a whole list that is recent: an ID missing from a list that was cut short proves nothing. The
// list's field fails on about half of real calls (docs/twitch-drops-facts.md), and Twitch's newer
// query pages it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInventory, parseRewards } from '../extension/lib/twitch.js';
import { update, emptyState } from '../extension/lib/tracker.js';
import { rewardOwned, OWNED_FRESH_MS } from '../extension/lib/badges.js';

const T0 = Date.parse('2026-11-24T10:00:00Z');
const MIN = 60000;
const inventory = (gameEventDrops, errors) => ({
  data: { currentUser: { inventory: { dropCampaignsInProgress: [], gameEventDrops } } },
  ...(errors ? { errors } : {}),
});
const poll = (prev, rewards, now) => update(prev, { campaigns: [], rewards, session: null, sessions: [], streams: [] }, now);
const whole = (...ids) => ({ ids, complete: true });

test('a list with an entry that has no ID is not whole', () => {
  assert.deepEqual(parseRewards({ gameEventDrops: [{ id: 'a' }, { name: 'ID gone' }] }), { ids: ['a'], complete: false });
  assert.deepEqual(parseRewards({ gameEventDrops: [{ name: 'a' }, { name: 'b' }] }), { ids: [], complete: false }, 'the ID field renamed must not read as owning nothing');
  assert.deepEqual(parseRewards({ gameEventDrops: [{ id: 'a' }, null] }), { ids: ['a'], complete: false });
  assert.deepEqual(parseRewards({ gameEventDropsConnection: { edges: [{ node: { id: 'a' } }, { node: null }], pageInfo: { hasNextPage: false } } }), { ids: ['a'], complete: false });
  assert.deepEqual(parseRewards({ gameEventDrops: [{ id: 'a' }] }), { ids: ['a'], complete: true });
});

test('a list beside an error about it, or about nothing named, is not whole', () => {
  const at = (path) => parseInventory(inventory([{ id: 'a' }], [{ message: 'service error', path }])).rewards;
  assert.deepEqual(at(['currentUser', 'inventory', 'gameEventDrops']), { ids: ['a'], complete: false });
  assert.deepEqual(at(['currentUser', 'inventory', 'gameEventDrops', 3, 'id']), { ids: ['a'], complete: false });
  // An error on another optional field says nothing about this list.
  assert.deepEqual(at(['currentUser', 'inventory', 'earnedDropRewards']), { ids: ['a'], complete: true });
  const pathless = parseInventory(inventory([{ id: 'a' }], [{ message: 'service error' }])).rewards;
  assert.deepEqual(pathless, { ids: ['a'], complete: false });
});

test('owned, not owned, or unknown', () => {
  const s = poll(undefined, whole('a'), T0);
  assert.equal(rewardOwned(s, 'a', T0), true);
  assert.equal(rewardOwned(s, 'b', T0), false);
  assert.equal(rewardOwned(emptyState(), 'b', T0), null, 'no list yet');
  assert.equal(rewardOwned({ rewards: { ids: ['a'] } }, 'b', T0), null, 'saved by an older version');
  assert.equal(rewardOwned({ rewards: { ids: ['a'] } }, 'a', T0), true, 'an ID in any list is owned');
  assert.equal(rewardOwned(undefined, 'a', T0), null);
  assert.equal(rewardOwned(s, null, T0), null);
});

test('a failed or partial list keeps the last whole one, and only for a while', () => {
  let s = poll(undefined, whole('a'), T0);
  s = poll(s, { ids: null, complete: false }, T0 + MIN);
  assert.equal(rewardOwned(s, 'b', T0 + MIN), false);
  s = poll(s, { ids: ['c'], complete: false }, T0 + 2 * MIN);
  assert.equal(rewardOwned(s, 'c', T0 + 2 * MIN), true, 'a partial list still proves what it lists');
  assert.equal(rewardOwned(s, 'b', T0 + 2 * MIN), false);
  assert.equal(rewardOwned(s, 'b', T0 + OWNED_FRESH_MS), false);
  assert.equal(rewardOwned(s, 'b', T0 + OWNED_FRESH_MS + 1), null, 'too old to say not owned');
  assert.equal(rewardOwned(s, 'a', T0 + OWNED_FRESH_MS + 1), true);
});

test('only ever partial lists: never not owned', () => {
  let s;
  for (let i = 0; i < 40; i++) s = poll(s, { ids: ['a'], complete: false }, T0 + i * MIN);
  assert.equal(rewardOwned(s, 'a', T0 + 39 * MIN), true);
  assert.equal(rewardOwned(s, 'b', T0 + 39 * MIN), null);
});

test('an empty list right after one with rewards is not believed until it is seen again', () => {
  let s = poll(undefined, whole('a'), T0);
  s = poll(s, whole(), T0 + MIN);
  assert.equal(rewardOwned(s, 'b', T0 + MIN), null);
  s = poll(s, whole(), T0 + 2 * MIN);
  assert.equal(rewardOwned(s, 'b', T0 + 2 * MIN), false, 'another account, which owns nothing');
});

test('a list longer than is kept is not whole', () => {
  const ids = Array.from({ length: 2001 }, (_, i) => `r${i}`);
  const s = poll(undefined, whole(...ids), T0);
  assert.equal(s.rewards.ids.length, 2000);
  assert.equal(rewardOwned(s, 'r2000', T0), null);
  assert.equal(rewardOwned(s, 'r0', T0), true);
});

test('signed out: the last whole list says nothing about who signs in next', () => {
  let s = poll(undefined, whole('a'), T0);
  s = update(s, { error: { kind: 'network', message: 'x' } }, T0 + MIN);
  assert.equal(rewardOwned(s, 'b', T0 + MIN), false, 'a failed poll is not a sign-out');
  s = update(s, { error: { kind: 'auth', message: 'x' } }, T0 + 2 * MIN);
  assert.equal(rewardOwned(s, 'b', T0 + 2 * MIN), null);
});

test('a clock that jumped back does not make an old list fresh for ever', () => {
  const s = poll(undefined, whole('a'), T0);
  assert.equal(rewardOwned(s, 'b', T0 - 60 * MIN), null);
});
