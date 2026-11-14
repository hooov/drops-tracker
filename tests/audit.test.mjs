// One test per finding of the audit of 2026-11-06, each driving the real modules. Most triggers
// are hand-built, since they have not all been seen on real Twitch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { update, warning, badge, summarize } from '../extension/lib/tracker.js';
import { chipView, channelFromPath } from '../extension/lib/chip.js';
import { badgeSections } from '../extension/lib/badges.js';
import { directoryRows } from '../extension/lib/directory.js';
import { parseDirectory, parseLogin, fetchSnapshot, TwitchError } from '../extension/lib/twitch.js';

const T0 = Date.parse('2026-11-06T19:00:00Z');
const MIN = 60000;
const END = '2026-11-20T00:00:00Z';
const REWARDS = { ids: [], complete: true };
const player = (i, over = {}) => ({ hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: 100 + i * 60, ...over });
const drop = (id, m, required = 240, self = {}, extra = {}) => ({ id, name: id, requiredMinutesWatched: required, ...extra, self: { currentMinutesWatched: m, isClaimed: false, hasPreconditionsMet: true, ...self } });
const camp = (id, drops, extra = {}) => ({ id, name: id, status: 'ACTIVE', endAt: END, timeBasedDrops: drops, ...extra });
const chan = (login, campaigns) => ({ id: login, login, displayName: login, live: true, campaigns });
const st = (channel, i, tabId = 1) => ({ tabId, login: channel.login, channel, tab: {}, player: player(i) });
const sess = (login, dropId, minutes, required = 240) => ({ login, displayName: login, dropId, minutes, required });
const game = chan('gamechan', [{ id: 'cg', name: 'G', channelOwned: false, benefitIds: ['bg'], endAt: END, watchDrops: [{ id: 'dg', name: 'Sword', required: 240 }] }]);
const owned = chan('badgechan', [{ id: 'cb', name: 'B', channelOwned: true, benefitIds: ['bb'], endAt: END, watchDrops: [{ id: 'db', name: 'Ring', required: 180 }] }]);
const poll = (s, campaigns, streams, sessions, i) => update(s, { campaigns, rewards: REWARDS, session: sessions[0] ?? null, sessions, streams }, T0 + i * MIN);

test('session and Inventory disagreeing while both are flat must not hide a hang as Earning', () => {
  const c = chan('a', [{ id: 'c', name: 'c', benefitIds: [] }]);
  let s;
  for (let i = 0; i < 12; i++) s = poll(s, [camp('c', [drop('d', 65)])], [st(c, i)], [sess('a', 'd', 70)], i);
  assert.equal(s.verdict.code, 'stalled');
});

test('over 100 drops, all flat and no stream open, must not read as Earning', () => {
  const many = [camp('c', Array.from({ length: 120 }, (_, i) => drop(`d${i}`, 5, 240, { isClaimed: true })))];
  let s;
  for (let i = 0; i < 6; i++) {
    s = poll(s, many, [], [], i);
    assert.notEqual(s.verdict.code, 'earning', `poll ${i}`);
  }
  assert.ok(Object.keys(s.drops).length <= 120, 'still bounded by what Twitch reports');
});

test('old drops are dropped from the saved marks once over the limit, but never a current one', () => {
  let s = poll(undefined, [camp('c', Array.from({ length: 100 }, (_, i) => drop(`old${i}`, 5)))], [], [], 0);
  s = poll(s, [camp('c', [drop('new', 5)])], [], [], 1);
  assert.ok(Object.keys(s.drops).length <= 100);
  assert.ok(s.drops.new);
});

test('finishing a drop with the tab left open is not "Stopped earning"', () => {
  const c = chan('a', [{ id: 'c', name: 'c', benefitIds: [] }]);
  let s;
  for (let i = 0; i < 10; i++) {
    s = poll(s, [camp('c', [drop('d', Math.min(236 + i, 240))])], [st(c, i)], [sess('a', 'd', Math.min(236 + i, 240))], i);
  }
  assert.equal(s.streams[0].channelState, 'finished');
  assert.notEqual(s.verdict.lost, true);
  assert.equal(warning(s, T0 + 9 * MIN), null);
  assert.notEqual(badge(s).text, '!');
});

test('a channel really losing its campaign mid-watch still warns', () => {
  const live = chan('a', [{ id: 'c', name: 'c', benefitIds: [] }]);
  const gone = chan('a', []);
  let s;
  for (let i = 0; i < 8; i++) {
    s = poll(s, [camp('c', [drop('d', i < 3 ? 100 + i : 102)])], [st(i < 3 ? live : gone, i)], [], i);
  }
  assert.equal(s.verdict.lost, true);
  assert.equal(badge(s).text, '!');
});

test('a game campaign missing from Inventory never reads as Hung, even when a session answers', () => {
  let s;
  for (let i = 0; i < 7; i++) s = poll(s, [], [st(game, i)], [sess('gamechan', 'dg', 0)], i);
  assert.equal(s.streams[0].channelState, 'unstarted');
  assert.notEqual(s.verdict.code, 'stalled');
  assert.equal(s.verdict.limited, true);
  assert.match(s.verdict.message, /account linked/);
  assert.equal(s.active.length, 0);
});

test('a badge whose rewards are already owned is not tracked, whatever the session says', () => {
  let s;
  for (let i = 0; i < 7; i++) {
    s = update(s, { campaigns: [], rewards: { ids: ['bb'], complete: true }, session: null, sessions: [sess('badgechan', 'db', 5, 180)], streams: [st(owned, i)] }, T0 + i * MIN);
  }
  assert.equal(s.streams[0].channelState, 'finished');
  assert.notEqual(s.verdict.code, 'stalled');
});

test('a badge reopened after minutes rose elsewhere: that jump is not earning now', () => {
  const stream = (i) => [st(owned, i)];
  let s;
  s = poll(s, [], stream(0), [sess('badgechan', 'db', 5, 180)], 0);
  s = poll(s, [], stream(1), [sess('badgechan', 'db', 5, 180)], 1);
  for (let i = 2; i < 8; i++) s = poll(s, [], [], [], i);
  for (let i = 8; i < 11; i++) {
    s = poll(s, [], stream(i), [sess('badgechan', 'db', 50, 180)], i);
    assert.notEqual(s.verdict.code, 'earning', `poll ${i}`);
  }
  assert.equal(s.drops.db.peak, 50, 'the new reading is the baseline');
});

test('minutes rising across a PC sleep are not earning now', () => {
  const c = chan('a', [{ id: 'c', name: 'c', benefitIds: [] }]);
  let s = poll(undefined, [camp('c', [drop('d', 100)])], [st(c, 0)], [], 0);
  s = poll(s, [camp('c', [drop('d', 100)])], [st(c, 1)], [], 1);
  s = poll(s, [camp('c', [drop('d', 150)])], [st(c, 20)], [], 20);
  assert.notEqual(s.verdict.code, 'earning');
  s = poll(s, [camp('c', [drop('d', 151)])], [st(c, 21)], [], 21);
  assert.equal(s.verdict.code, 'earning', 'the next real minute still counts');
});

test('a failed check at the moment earning stops must not lose the warning', () => {
  const live = chan('a', [{ id: 'c', name: 'c', benefitIds: [] }]);
  const gone = chan('a', []);
  let s;
  for (let i = 0; i < 9; i++) {
    if (i === 5) s = update(s, { error: { kind: 'network', message: 'x' } }, T0 + i * MIN);
    else s = poll(s, [camp('c', [drop('d', i < 3 ? 100 + i : 102)])], [st(i < 3 ? live : gone, i)], [], i);
  }
  assert.equal(s.verdict.lost, true);
  assert.equal(badge(s).text, '!');
  assert.ok(warning(s, T0 + 8 * MIN));
});

for (const [label, d, words] of [
  ['unmet requirements', drop('d', 5, 240, { hasPreconditionsMet: false }), /requirement|earlier drop/i],
  ['a later window', drop('d', 5, 240, {}, { startAt: '2026-12-01T00:00:00Z' }), /opens/i],
]) {
  test(`a campaign that cannot count yet because of ${label} warns, and does not say finished`, () => {
    const c = chan('a', [{ id: 'c', name: 'c', benefitIds: [] }]);
    let s;
    for (let i = 0; i < 7; i++) s = poll(s, [camp('c', [d])], [st(c, i)], [], i);
    assert.equal(s.streams[0].channelState, 'blocked');
    assert.equal(s.verdict.limited, true);
    assert.match(s.verdict.message, words);
    assert.notEqual(s.verdict.code, 'stalled');
    assert.ok(warning(s, T0 + 6 * MIN));
  });
}

test('earning from another device names no channel here, and the rising drop leads', () => {
  let s;
  for (let i = 0; i < 4; i++) {
    s = poll(s, [camp('cg', [drop('dg', 100 + i)])], [st(owned, i)], [sess('badgechan', 'db', 5, 180)], i);
  }
  assert.equal(s.verdict.code, 'earning');
  assert.equal(s.verdict.channel, null);
  assert.equal(s.streams[0].credited, false);
  assert.equal(s.active[0].id, 'dg');
  assert.doesNotMatch(chipView(s, T0 + 3 * MIN).title, /Earning on/);
});

test('nothing has ever risen: no channel is called credited', () => {
  let s;
  for (let i = 0; i < 2; i++) {
    s = poll(s, [camp('cg', [drop('dg', 50)])], [st(owned, i, 1), st(game, i, 2)], [sess('badgechan', 'db', 5, 180), sess('gamechan', 'dg', 50)], i);
  }
  assert.deepEqual(s.streams.map((x) => x.credited), [false, false]);
  assert.equal(s.session, null);
});

test('once a drop has risen its channel stays named through a hang', () => {
  let s;
  [100, 101, 101, 101].forEach((m, i) => {
    s = poll(s, [camp('cg', [drop('dg', m)])], [st(game, i)], [sess('gamechan', 'dg', m)], i);
  });
  assert.equal(s.streams[0].credited, true);
  assert.equal(s.session.login, 'gamechan');
});

// Reported case: closing the channel being earned on, with another Twitch tab still open, said it "may have changed game, gone offline or raided away".
const earner = chan('earner', [{ id: 'c', name: 'c', benefitIds: [] }]);
const noDrops = chan('other', []);
const earnThenClose = () => {
  let s;
  for (let i = 0; i < 4; i++) {
    s = poll(s, [camp('c', [drop('d', 100 + i)])], [st(earner, i, 1), st(noDrops, i, 2)], [sess('earner', 'd', 100 + i)], i);
  }
  assert.equal(s.verdict.code, 'earning');
  return s;
};

test('closing the tab that was earning is not "Stopped earning", and stops saying Earning at once', () => {
  let s = earnThenClose();
  for (let i = 4; i < 10; i++) {
    s = poll(s, [camp('c', [drop('d', 103)])], [st(noDrops, i, 2)], [], i);
    assert.equal(s.verdict.code, 'idle', `poll ${i}`);
    assert.notEqual(s.verdict.lost, true, `poll ${i}`);
    assert.equal(warning(s, T0 + i * MIN), null, `poll ${i}`);
    assert.equal(badge(s).text, '', `poll ${i}`);
    assert.equal(s.closedName, 'earner', `poll ${i}`);
  }
});

test('a last minute landing just after closing does not read as earning elsewhere', () => {
  let s = earnThenClose();
  s = poll(s, [camp('c', [drop('d', 103)])], [st(noDrops, 4, 2)], [], 4);
  s = poll(s, [camp('c', [drop('d', 104)])], [st(noDrops, 5, 2)], [], 5);
  assert.notEqual(s.verdict.code, 'earning');
  assert.equal(s.closedName, 'earner');
});

test('minutes still rising well after closing are real, from somewhere else', () => {
  let s = earnThenClose();
  [103, 103, 103, 103, 104].forEach((m, i) => { s = poll(s, [camp('c', [drop('d', m)])], [st(noDrops, 4 + i, 2)], [], 4 + i); });
  assert.equal(s.verdict.code, 'earning');
  assert.equal(s.closedName, null);
});

test('a raid moves the same tab to another channel, which is still a warning', () => {
  let s = earnThenClose();
  for (let i = 4; i < 9; i++) s = poll(s, [camp('c', [drop('d', 103)])], [st(chan('raided', []), i, 1), st(noDrops, i, 2)], [], i);
  assert.equal(s.verdict.lost, true);
  assert.equal(badge(s).text, '!');
  assert.ok(warning(s, T0 + 8 * MIN));
  assert.equal(s.closedName, null);
});

test('the channel going offline in the same tab is still a warning', () => {
  let s = earnThenClose();
  for (let i = 4; i < 9; i++) s = poll(s, [camp('c', [drop('d', 103)])], [st({ ...earner, live: false }, i, 1), st(noDrops, i, 2)], [], i);
  assert.equal(s.verdict.lost, true);
});

test('closing one of two channels that can earn leaves normal tracking on the other', () => {
  const second = chan('second', [{ id: 'c', name: 'c', benefitIds: [] }]);
  let s;
  for (let i = 0; i < 3; i++) s = poll(s, [camp('c', [drop('d', 100 + i)])], [st(earner, i, 1), st(second, i, 2)], [sess('earner', 'd', 100 + i)], i);
  for (let i = 3; i < 10; i++) s = poll(s, [camp('c', [drop('d', 102)])], [st(second, i, 2)], [], i);
  assert.equal(s.closedName, null);
  assert.equal(s.verdict.code, 'stalled');
});

test('a warning already stuck on screen from before this fix clears by itself', () => {
  const stuck = { ...earnThenClose(), verdict: { code: 'idle', hasStreams: true, lost: true, message: 'x' }, lostAt: T0, tracking: true, earnerTabs: undefined };
  const s = poll(stuck, [camp('c', [drop('d', 103)])], [st(noDrops, 9, 2)], [], 9);
  assert.notEqual(s.verdict.lost, true);
  assert.equal(warning(s, T0 + 9 * MIN), null);
  assert.equal(badge(s).text, '');
});

test('reopening a channel after closing it clears the note', () => {
  let s = earnThenClose();
  s = poll(s, [camp('c', [drop('d', 103)])], [st(noDrops, 4, 2)], [], 4);
  assert.equal(s.closedName, 'earner');
  s = poll(s, [camp('c', [drop('d', 103)])], [st(earner, 5, 3), st(noDrops, 5, 2)], [], 5);
  assert.equal(s.closedName, null);
  assert.equal(s.streams[0].channelState, 'eligible');
});

test('the 11th channel tab is unknown, not a false Offline', () => {
  const s = update(undefined, { campaigns: [], rewards: REWARDS, session: null, sessions: [], streams: [{ tabId: 1, login: 'ch10', channel: undefined, tab: {}, player: player(0) }] }, T0);
  assert.equal(s.streams[0].channelState, 'unknown');
});

const json = (body) => ({ status: 200, ok: true, json: async () => body });
const badgeTwitch = (session) => async (_u, init) => json(JSON.parse(init.body).map((o) => {
  if (o.operationName === 'Inventory') return { data: { currentUser: { inventory: { dropCampaignsInProgress: [] } } } };
  if (o.operationName === 'VideoPlayerStreamInfoOverlayChannel') return { data: { user: { id: '1', login: 'badgechan', displayName: 'BadgeChan', stream: { id: '1' } } } };
  if (o.operationName === 'DropsHighlightService_AvailableDrops') {
    return { data: { channel: { viewerDropCampaigns: [{ id: 'cb', name: 'B', game: null, endAt: END, timeBasedDrops: [{ id: 'db', requiredMinutesWatched: 180, requiredSubs: 0, benefitEdges: [{ benefit: { id: 'bb', name: 'Ring' } }] }] }] } } };
  }
  return session;
}));

test('a failed session query on a badge channel reads as cannot check, not "no minutes reported"', async () => {
  const snap = await fetchSnapshot('t', ['badgechan'], badgeTwitch({ errors: [{ message: 'service error', path: ['currentUser', 'dropCurrentSession'] }], data: { currentUser: null } }));
  assert.equal(snap.channels.badgechan.unknown, true);
});

test('a retired session hash on a badge channel reads as cannot check too', async () => {
  const snap = await fetchSnapshot('t', ['badgechan'], badgeTwitch({ errors: [{ message: 'PersistedQueryNotFound', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }] }));
  assert.equal(snap.channels.badgechan.unknown, true);
});

test('one poll with no session must not flip a Hung badge to "cannot track" and back', () => {
  let s;
  const verdicts = [];
  for (let i = 0; i < 10; i++) {
    s = poll(s, [], [st(owned, i)], i === 7 ? [] : [sess('badgechan', 'db', 5, 180)], i);
    verdicts.push(s.verdict.limited === true);
  }
  assert.deepEqual(verdicts.filter(Boolean), [], 'a one-poll gap needs its own grace period');
});

test('Badges tab on Twitch pages that are not channels', () => {
  for (const path of ['/drops/inventory', '/drops/campaigns', '/directory', '/directory/category/x', '/settings/profile', '/videos/123', '/', '']) {
    assert.equal(channelFromPath(path), null, path);
  }
  assert.equal(channelFromPath('/moderator/SomeBody'), 'somebody');
  assert.equal(channelFromPath('/popout/SomeBody/chat'), 'somebody');
  assert.equal(channelFromPath('/SomeBody'), 'somebody');
  const streams = [{ login: 'a', displayName: 'A', channelState: 'no_drops', badges: [{ id: 'x', name: 'One', endAt: END, drops: [] }] }];
  assert.equal(badgeSections(streams, channelFromPath('/drops/inventory'), T0)[0].title, 'A', 'lists open channels instead');
});

test('the reserved page list is shared, so the two channel parsers cannot disagree', () => {
  for (const path of ['/drops', '/directory', '/settings', '/wallet', '/videos', '/search']) {
    assert.equal(channelFromPath(path), parseLogin(`https://www.twitch.tv${path}`), path);
  }
});

test('All Drops: a service error while logged in is not "Log in"', () => {
  const kind = (item) => { try { parseDirectory(item, T0); return 'none'; } catch (e) { assert.ok(e instanceof TwitchError); return e.kind; } };
  assert.equal(kind({ errors: [{ message: 'service error', path: ['currentUser'] }], data: { currentUser: null } }), 'network');
  assert.equal(kind({ errors: [{ message: 'unauthenticated', path: ['rewardCampaignsAvailableToUser'] }], data: { currentUser: null } }), 'auth');
  assert.equal(kind({ data: { currentUser: null } }), 'auth');
});

test('the Connect link must be https, like every other link from Twitch', () => {
  const claimable = (url) => summarize([camp('c', [drop('d', 240, 240, { dropInstanceID: 'i' })], { accountLinkURL: url, self: { isAccountConnected: false } })], T0).unclaimed[0].connectUrl;
  assert.equal(claimable('javascript:alert(1)'), null);
  assert.equal(claimable('https://example.com/link'), 'https://example.com/link');
});

test('a damaged saved list cannot break the All Drops tab', () => {
  for (const bad of [{ campaigns: 'x' }, { campaigns: [null] }, { campaigns: [{ id: 'a' }] }, null]) {
    assert.doesNotThrow(() => directoryRows(bad, [], '', T0));
    assert.doesNotThrow(() => directoryRows(bad, [], 'q', T0));
  }
});

test('one campaign with enormous names cannot fill the saved list', () => {
  const huge = 'x'.repeat(1000000);
  const item = { data: { currentUser: { dropCampaigns: [{ id: 'a', name: huge, status: 'ACTIVE', game: { displayName: huge }, owner: { name: huge }, timeBasedDrops: [{ requiredMinutesWatched: 5 }] }] } } };
  assert.ok(JSON.stringify(parseDirectory(item, T0)).length < 2000);
});

test('the page hook only runs on the one page that needs it, not where drops are claimed', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url)));
  for (const script of ['page-hook.js', 'page-bridge.js']) {
    const entry = manifest.content_scripts.find((c) => c.js.includes(script));
    assert.deepEqual(entry.matches, ['https://www.twitch.tv/drops/campaigns*'], script);
  }
});
