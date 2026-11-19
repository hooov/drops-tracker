import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOps, addPageOps, pageKind, dropOps, MAX_PAGE_OPS } from '../extension/lib/pageops.js';
import { debugRows, debugBundle } from '../extension/lib/debug.js';

const HASH = 'a'.repeat(64);
const T = Date.parse('2026-11-19T18:00:00Z');

test('extractOps keeps names, hashes and variable types, never a string or number value', () => {
  const body = JSON.stringify([
    { operationName: 'ChannelBadgeDrops', variables: { channelID: '987654321', isLoggedIn: true, limit: 5, ids: ['x'], cursor: null }, extensions: { persistedQuery: { version: 1, sha256Hash: HASH } } },
    { operationName: 'NoHash', variables: { login: 'someone' } },
    { operationName: 'bad name!', variables: {} },
  ]);
  const ops = extractOps(body);
  assert.deepEqual(ops, [
    { op: 'ChannelBadgeDrops', hash: HASH, vars: { channelID: 'string', isLoggedIn: true, limit: 'number', ids: 'array', cursor: 'null' } },
    { op: 'NoHash', hash: null, vars: { login: 'string' } },
  ]);
  assert.equal(JSON.stringify(ops).includes('987654321'), false);
  assert.equal(JSON.stringify(ops).includes('someone'), false);
  assert.deepEqual(extractOps('not json'), []);
});

test('pageKind names the kind of page, never the channel', () => {
  assert.equal(pageKind('https://www.twitch.tv/foxtrot', true), 'channel');
  assert.equal(pageKind('https://www.twitch.tv/drops/inventory?x=1', false), 'drops/inventory');
  assert.equal(pageKind('https://www.twitch.tv/', false), 'home');
  assert.equal(pageKind('nope', false), 'unknown');
});

test('addPageOps counts, remembers where, and stays at MAX_PAGE_OPS, oldest dropped', () => {
  let m = addPageOps(undefined, [{ op: 'A', hash: HASH, vars: {} }], 'channel', T);
  m = addPageOps(m, [{ op: 'A', hash: null, vars: { x: 'string' } }], 'drops/inventory', T + 1);
  assert.deepEqual(m.A, { hash: HASH, vars: { x: 'string' }, where: ['channel', 'drops/inventory'], first: T, last: T + 1, count: 2 });
  for (let i = 0; i < MAX_PAGE_OPS + 10; i++) m = addPageOps(m, [{ op: `Op${i}`, hash: null, vars: {} }], 'home', T + 10 + i);
  assert.equal(Object.keys(m).length, MAX_PAGE_OPS);
  assert.equal(m.A, undefined, 'the oldest went first');
  assert.ok(m[`Op${MAX_PAGE_OPS + 9}`]);
});

test('Debug lists the drop and badge operations, and Copy debug info carries the map', () => {
  const pageOps = addPageOps(undefined, [
    { op: 'ChannelBadgeDrops', hash: HASH, vars: { channelID: 'string' } },
    { op: 'ChatList', hash: HASH, vars: {} },
  ], 'channel', T);
  assert.deepEqual(dropOps(pageOps).map((o) => o.op), ['ChannelBadgeDrops']);
  const rows = debugRows({ state: {}, pageOps }, T);
  assert.equal(rows.find((r) => r.label === 'Page operations seen').value, '2');
  assert.equal(rows.find((r) => r.label === 'Page: ChannelBadgeDrops').value, 'aaaaaaaa, channel, channelID, x1');
  assert.deepEqual(debugBundle({ state: {}, pageOps }, T).pageOps, pageOps);
  assert.deepEqual(debugBundle({ state: {} }, T).pageOps, {});
});
