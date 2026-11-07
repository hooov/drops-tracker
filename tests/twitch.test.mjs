import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLogin, normalizeSession, fetchSnapshot, parseInventory, parseRewards, extractHashes, PINNED, TwitchError } from '../extension/lib/twitch.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/gql-2026-11-06.json', import.meta.url)));

test('parseLogin takes channel pages only', () => {
  assert.equal(parseLogin('https://www.twitch.tv/AlphaTV'), 'alphatv');
  assert.equal(parseLogin('https://www.twitch.tv/alphatv?sr=a'), 'alphatv');
  assert.equal(parseLogin('https://m.twitch.tv/bravo'), 'bravo');
  for (const u of [
    'https://www.twitch.tv/',
    'https://www.twitch.tv/drops/inventory',
    'https://www.twitch.tv/directory',
    'https://www.twitch.tv/alphatv/videos',
    'https://www.twitch.tv/videos/123',
    'https://help.twitch.tv/alphatv',
    'https://evil.example/alphatv',
    'not a url',
  ]) assert.equal(parseLogin(u), null, u);
});

test('normalizeSession handles all three real shapes', () => {
  assert.equal(normalizeSession(fx.sessionEmptyChannelId), null);
  assert.equal(normalizeSession(fx.sessionUnrelatedChannelId), null);
  assert.deepEqual(normalizeSession(fx.sessionCredited), {
    login: 'alphatv', displayName: 'AlphaTV', dropId: 'd5ffa3e4-d6fe-11f1-adef-0a58a9feac02', minutes: 192, required: 240,
  });
});

/** Fake Twitch answering each op from captured fixtures. */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const ops = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, ops: ops.map((o) => o.operationName) });
    return handler(ops);
  };
  impl.calls = calls;
  return impl;
}
const json = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });
const liveHandler = (ops) => json(ops.map((o) => {
  switch (o.operationName) {
    case 'Inventory':
      return { data: { currentUser: { inventory: { dropCampaignsInProgress: fx.campaigns, gameEventDrops: [fx.rewardSample] } } } };
    case 'VideoPlayerStreamInfoOverlayChannel':
      return { data: { user: o.variables.channel === 'bravo' ? fx.channelBravo : o.variables.channel === 'alphatv' ? fx.channelAlpha : null } };
    case 'DropsHighlightService_AvailableDrops':
      return { data: { channel: o.variables.channelID === '10000001' ? fx.availableEligible : fx.availableNone } };
    case 'DropCurrentSessionContext':
      return { data: { currentUser: { dropCurrentSession: o.variables.channelID === '10000001' ? fx.sessionCredited : fx.sessionUnrelatedChannelId } } };
    default:
      throw new Error(o.operationName);
  }
}));

test('snapshot: bravo has no campaigns, alphatv has one, session comes from the eligible channel', async () => {
  const f = fakeFetch(liveHandler);
  const snap = await fetchSnapshot('tok', ['bravo', 'alphatv', 'bravo'], f);
  assert.equal(snap.channels.bravo.campaigns.length, 0);
  assert.equal(snap.channels.alphatv.campaigns.length, 1);
  assert.equal(snap.session.login, 'alphatv');
  assert.deepEqual(snap.rewards, { ids: [fx.rewardSample.id], complete: true });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].headers.Authorization, 'OAuth tok');
  assert.equal(f.calls[0].url, 'https://gql.twitch.tv/gql');
  assert.equal(f.calls[0].ops.filter((o) => o === 'VideoPlayerStreamInfoOverlayChannel').length, 2, 'duplicate logins deduped');
});

test('snapshot: sub-only campaign does not count as eligible', async () => {
  const subOnly = { id: '10000001', viewerDropCampaigns: [{ id: 'c', name: 'Sub', timeBasedDrops: [{ id: 'd', requiredMinutesWatched: 0, requiredSubs: 1, benefitEdges: [] }] }] };
  const f = fakeFetch(async (ops) => {
    const body = await liveHandler(ops).json();
    ops.forEach((o, i) => {
      if (o.operationName === 'DropsHighlightService_AvailableDrops') body[i] = { data: { channel: subOnly } };
    });
    return json(body);
  });
  const snap = await fetchSnapshot('tok', ['alphatv'], f);
  assert.equal(snap.channels.alphatv.campaigns.length, 0);
});

test('snapshot: offline channel skips the drop lookups', async () => {
  const offline = { ...fx.channelAlpha, stream: null };
  const f = fakeFetch((ops) => json(ops.map((o) => (o.operationName === 'Inventory'
    ? { data: { currentUser: { inventory: { dropCampaignsInProgress: [], gameEventDrops: [] } } } }
    : { data: { user: offline } }))));
  const snap = await fetchSnapshot('tok', ['alphatv'], f);
  assert.equal(snap.channels.alphatv.live, false);
  assert.equal(f.calls.length, 1);
});

const rejects = (promise, kind) => assert.rejects(promise, (e) => e instanceof TwitchError && e.kind === kind);

test('failures map to kinds the UI can tell apart from a stall', async () => {
  await rejects(fetchSnapshot('t', [], async () => json({}, 401)), 'auth');
  await rejects(fetchSnapshot('t', [], async () => json({}, 503)), 'network');
  await rejects(fetchSnapshot('t', [], async () => { throw new TypeError('offline'); }), 'network');
  await rejects(fetchSnapshot('t', [], async () => json([{ errors: [{ message: 'PersistedQueryNotFound' }] }])), 'api_changed');
  await rejects(fetchSnapshot('t', [], async () => json([{ errors: [{ message: 'service timeout' }] }])), 'network');
  await rejects(fetchSnapshot('t', [], async () => json([{ errors: [{ message: 'failed integrity check' }] }])), 'api_changed');
  await rejects(fetchSnapshot('t', [], async () => json({}, 429)), 'network');
  await rejects(fetchSnapshot('t', [], async () => json({ not: 'an array' })), 'bad_response');
  await rejects(fetchSnapshot('t', [], async () => json([{ data: { currentUser: null } }])), 'auth');
  await rejects(fetchSnapshot('t', [], async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('x'); } })), 'bad_response');
});

// Bodies below are the real ones, captured from gql.twitch.tv on 2026-11-06.
const STALE_BODY = { errors: [{ message: 'PersistedQueryNotFound', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }] };
const inv = (inventory) => ({ data: { currentUser: { inventory } } });
const goodInventory = { dropCampaignsInProgress: fx.campaigns, gameEventDrops: [fx.rewardSample] };

test('a service error on the rewards field does not cost the drop data', () => {
  const body = {
    ...inv({ dropCampaignsInProgress: fx.campaigns, gameEventDrops: null }),
    errors: [{ message: 'service error', path: ['currentUser', 'inventory', 'gameEventDrops'] }],
  };
  const out = parseInventory(body);
  assert.equal(out.campaigns.length, 2);
  assert.deepEqual(out.rewards, { ids: null, complete: false }, 'unknown, not an empty list');
});

test('a service error on the drop data itself fails the poll', () => {
  const body = {
    ...inv({ dropCampaignsInProgress: fx.campaigns, gameEventDrops: [] }),
    errors: [{ message: 'service error', path: ['currentUser', 'inventory', 'dropCampaignsInProgress', 1, 'self'] }],
  };
  assert.throws(() => parseInventory(body), (e) => e.kind === 'network');
});

test('the newer paged rewards field is read, and is known to be partial', () => {
  assert.deepEqual(parseRewards({ gameEventDropsConnection: { edges: [{ node: { id: 'a' } }], pageInfo: { hasNextPage: true } } }), { ids: ['a'], complete: false });
  assert.deepEqual(parseRewards({ gameEventDropsConnection: { edges: [{ node: { id: 'a' } }], pageInfo: { hasNextPage: false } } }), { ids: ['a'], complete: true });
});

test('shape changes are errors, never "nothing in progress"', () => {
  const bad = (x) => assert.throws(() => parseInventory(x), (e) => e.kind === 'bad_response', JSON.stringify(x).slice(0, 80));
  bad(inv({ gameEventDrops: [] })); // Renamed list.
  bad({ data: null });
  bad({ data: {} });
  bad(inv({ dropCampaignsInProgress: [null] }));
  const renamedMinutes = structuredClone(fx.campaigns);
  renamedMinutes.forEach((c) => c.timeBasedDrops.forEach((d) => { d.self = { minutesWatched: 5 }; }));
  bad(inv({ dropCampaignsInProgress: renamedMinutes }));
  const renamedRequired = structuredClone(fx.campaigns);
  renamedRequired.forEach((c) => c.timeBasedDrops.forEach((d) => { delete d.requiredMinutesWatched; }));
  bad(inv({ dropCampaignsInProgress: renamedRequired }));
});

test('null means empty, and only a clean null user means signed out', () => {
  assert.deepEqual(parseInventory(inv({ dropCampaignsInProgress: null })).campaigns, []);
  assert.throws(() => parseInventory({ data: { currentUser: null } }), (e) => e.kind === 'auth');
  assert.throws(() => parseInventory({ data: { currentUser: null }, errors: [{ message: 'service error' }] }), (e) => e.kind === 'network');
});

test('a null drop inside a campaign is dropped instead of crashing later', () => {
  const c = structuredClone(fx.campaigns);
  c[1].timeBasedDrops.unshift(null);
  assert.equal(parseInventory(inv({ dropCampaignsInProgress: c })).campaigns[1].timeBasedDrops.length, 1);
});

test('a rotated hash on one channel op narrows the answer but keeps the progress', async () => {
  const f = fakeFetch(async (ops) => {
    const body = await liveHandler(ops).json();
    ops.forEach((o, i) => { if (o.operationName !== 'Inventory') body[i] = STALE_BODY; });
    return json(body);
  });
  const snap = await fetchSnapshot('t', ['alphatv'], f);
  assert.equal(snap.campaigns.length, 2);
  assert.equal(snap.channels.alphatv.unknown, true);
});

test('a failed second request narrows the answer but keeps the progress', async () => {
  let n = 0;
  const f = fakeFetch((ops) => { n++; return n === 1 ? liveHandler(ops) : json({}, 403); });
  const snap = await fetchSnapshot('t', ['alphatv'], f);
  assert.equal(snap.campaigns.length, 2);
  assert.equal(snap.channels.alphatv.unknown, true);
});

test('renamed channel fields are unknown, not "offline" or "no Drops"', async () => {
  const noStreamKey = { id: '1', login: 'x', displayName: 'X' };
  const a = await fetchSnapshot('t', ['x'], fakeFetch((ops) => json(ops.map((o) => (o.operationName === 'Inventory' ? inv(goodInventory) : { data: { user: noStreamKey } })))));
  assert.equal(a.channels.x.unknown, true);
  const renamedAd = fakeFetch(async (ops) => {
    const body = await liveHandler(ops).json();
    ops.forEach((o, i) => { if (o.operationName === 'DropsHighlightService_AvailableDrops') body[i] = { data: { channel: { id: '1', campaigns: [] } } }; });
    return json(body);
  });
  assert.equal((await fetchSnapshot('t', ['alphatv'], renamedAd)).channels.alphatv.unknown, true);
  const b = await fetchSnapshot('t', ['gone'], fakeFetch((ops) => json(ops.map((o) => (o.operationName === 'Inventory' ? inv(goodInventory) : { data: { user: null } })))));
  assert.equal(b.channels.gone.unknown, false, 'a route that is not a channel is known');
});

test('a retired hash moves on to the next candidate and remembers what worked', async () => {
  const seen = [];
  const f = fakeFetch(async (ops) => {
    seen.push(ops[0].extensions.persistedQuery.sha256Hash);
    const stale = ops[0].extensions.persistedQuery.sha256Hash === PINNED.Inventory[0];
    return json(ops.map(() => (stale ? STALE_BODY : inv(goodInventory))));
  });
  const snap = await fetchSnapshot('t', [], f);
  assert.deepEqual(seen, [PINNED.Inventory[0], PINNED.Inventory[1]]);
  assert.equal(snap.working.Inventory, PINNED.Inventory[1]);
  seen.length = 0;
  await fetchSnapshot('t', [], f, { working: snap.working });
  assert.deepEqual(seen, [PINNED.Inventory[1]], 'goes straight to it next poll');
});

test('with every pinned hash retired, a hash learned from Twitch\'s page rescues it', async () => {
  const learned = 'a'.repeat(64);
  const f = fakeFetch(async (ops) => json(ops.map((o) => (o.extensions.persistedQuery.sha256Hash === learned ? inv(goodInventory) : STALE_BODY))));
  const snap = await fetchSnapshot('t', [], f, { learned: { Inventory: learned } });
  assert.equal(snap.working.Inventory, learned);
  await rejects(fetchSnapshot('t', [], f), 'api_changed');
});

test('extractHashes keeps only our operations with real hashes', () => {
  const h = 'b'.repeat(64);
  const body = JSON.stringify([
    { operationName: 'Inventory', extensions: { persistedQuery: { sha256Hash: h } } },
    { operationName: 'SideNav', extensions: { persistedQuery: { sha256Hash: h } } },
    { operationName: 'DropCurrentSessionContext', extensions: { persistedQuery: { sha256Hash: 'not-a-hash' } } },
    { operationName: 'constructor', extensions: { persistedQuery: { sha256Hash: h } } },
  ]);
  assert.deepEqual(extractHashes(body), { Inventory: h });
  assert.deepEqual(extractHashes('not json'), {});
  assert.deepEqual(extractHashes(JSON.stringify({ operationName: 'Inventory', extensions: { persistedQuery: { sha256Hash: h } } })), { Inventory: h });
});

test('a rejected login is told apart from a rejected client ID', async () => {
  const withAnon = (anonStatus) => async (_u, init) => (init.headers.Authorization ? json({}, 401) : json([{}], anonStatus));
  await rejects(fetchSnapshot('t', [], withAnon(200)), 'auth');
  await rejects(fetchSnapshot('t', [], withAnon(400)), 'api_changed');
});

test('a body that never finishes arriving cannot hang the poll', { timeout: 15000 }, async () => {
  const stuck = async () => ({ status: 200, ok: true, json: () => new Promise(() => {}) });
  await rejects(fetchSnapshot('t', [], stuck), 'network');
});

test('errors never carry the token', async () => {
  try {
    await fetchSnapshot('SECRET', [], async () => { throw new TypeError('failed'); });
    assert.fail('should throw');
  } catch (e) {
    assert.ok(!String(e.message).includes('SECRET'));
  }
});
