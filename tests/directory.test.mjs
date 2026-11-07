import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDirectory, TwitchError } from '../extension/lib/twitch.js';
import { directoryRows, directoryError, failedDirectory, isFresh, FRESH_MS, RETRY_MS } from '../extension/lib/directory.js';

const real = JSON.parse(readFileSync(new URL('./fixtures/dashboard-2026-11-06.json', import.meta.url)));
const NOW = Date.parse('2026-11-06T12:00:00Z');
const clone = () => structuredClone(real);
const kindOf = (fn) => {
  try { fn(); return 'no error'; } catch (e) {
    assert.ok(e instanceof TwitchError, String(e));
    return e.kind;
  }
};
const parsed = (now = NOW) => parseDirectory(clone(), now);
const byGame = (rows) => Object.fromEntries(rows.map((r) => [r.game, r]));

test('real answer: keeps live campaigns and the sitewide reward, drops EXPIRED', () => {
  const { campaigns } = parsed();
  assert.deepEqual(campaigns.map((c) => c.game).sort(), ['Krunker', 'League of Legends', 'Madden NFL 27', 'Pokémon Night Out Campaign']);
});

test('real answer: a campaign still marked ACTIVE after its end is not listed', () => {
  const { campaigns } = parsed(Date.parse('2026-11-06T18:30:00Z'));
  assert.deepEqual(campaigns.map((c) => c.game).sort(), ['Krunker', 'Pokémon Night Out Campaign']);
});

test('real answer: time is the longest drop, since drops in a campaign tick together', () => {
  const c = byGame(parsed().campaigns);
  assert.equal(c['Madden NFL 27'].minutes, 240);
  assert.equal(c['Madden NFL 27'].drops, 3);
  assert.equal(c.Krunker.subs, true);
});

test('rows: wording for watch, mixed, sub-only and reward', () => {
  const { rows } = directoryRows(parsed(), [], '', NOW);
  const r = byGame(rows);
  assert.match(r['Madden NFL 27'].line, /^3 drops, 4h, ends in 6h$/); // 12:00 to 17:59:59.999 rounds to 360m.
  assert.match(r.Krunker.line, /^3 drops, 6h or subs, ends /);
  assert.match(r['League of Legends'].line, /^Subscribe to earn, ends in 5h$/); // 359m: whole hours, rounded down.
  assert.match(r['Pokémon Night Out Campaign'].line, /^20m, ends /);
  assert.equal(r['Pokémon Night Out Campaign'].sub, 'Sitewide reward');
});

test('rows: yours first, then sitewide, then soonest ending', () => {
  const krunker = parsed().campaigns.find((c) => c.game === 'Krunker').id;
  const { rows } = directoryRows(parsed(), [{ campaignId: krunker, pct: 30 }, { campaignId: krunker, pct: 82 }], '', NOW);
  assert.deepEqual(rows.map((r) => r.game), ['Krunker', 'Pokémon Night Out Campaign', 'League of Legends', 'Madden NFL 27']);
  assert.equal(rows[0].tag, '82% done');
});

test('rows: the saved list is re-checked against the clock', () => {
  const later = Date.parse('2026-11-07T00:00:00Z');
  const { rows, total } = directoryRows(parsed(), [], '', later);
  assert.equal(total, 2);
  assert.ok(!rows.some((r) => r.game === 'Madden NFL 27'));
});

test('rows: not started yet is not active', () => {
  const dir = parsed();
  dir.campaigns[1].startAt = NOW + 60000;
  assert.equal(directoryRows(dir, [], '', NOW).total, 3);
});

test('rows: search matches game, campaign and owner, and total stays the full count', () => {
  const dir = parsed();
  for (const q of ['madden', ' Electronic ', 'LIVE']) {
    const { rows, total } = directoryRows(dir, [], q, NOW);
    assert.deepEqual(rows.map((r) => r.game), ['Madden NFL 27'], q);
    assert.equal(total, 4);
  }
  assert.equal(directoryRows(dir, [], 'zzz', NOW).rows.length, 0);
});

test('rows: a game name with punctuation makes a valid link', () => {
  const dir = { campaigns: [{ kind: 'drop', id: '1', name: 'x', game: "Tom Clancy's: The/Division 2", owner: '', drops: 1, minutes: 5 }] };
  const { rows } = directoryRows(dir, [], '', NOW);
  assert.equal(new URL(rows[0].browseUrl).pathname.split('/').length, 4);
});

test('links that are not https are dropped, so a bad value cannot become a javascript: link', () => {
  const body = clone();
  body.data.currentUser.dropCampaigns[0].accountLinkURL = 'javascript:alert(1)';
  body.data.currentUser.dropCampaigns[0].game.boxArtURL = 'http://example.com/a.png';
  const madden = parseDirectory(body, NOW).campaigns.find((c) => c.game === 'Madden NFL 27');
  assert.equal(madden.linkUrl, null);
  assert.equal(madden.art, null);
});

test('real failure: integrity check on dropCampaigns is a Twitch change, not an empty list', () => {
  const body = { errors: [{ message: 'failed integrity check', extensions: { code: 'IntegrityCheckFailed' }, path: ['currentUser', 'dropCampaigns'] }], data: { currentUser: { id: '0', login: 'x', dropCampaigns: null }, rewardCampaignsAvailableToUser: [] } };
  assert.equal(kindOf(() => parseDirectory(body, NOW)), 'api_changed');
});

test('real failure: logged out', () => {
  const body = { errors: [{ message: 'unauthenticated', extensions: { code: 'Unauthenticated' }, path: ['rewardCampaignsAvailableToUser'] }], data: { currentUser: null, rewardCampaignsAvailableToUser: null } };
  assert.equal(kindOf(() => parseDirectory(body, NOW)), 'auth');
});

test('real failure: retired hash', () => {
  const body = { errors: [{ message: 'PersistedQueryNotFound', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }] };
  assert.equal(kindOf(() => parseDirectory(body, NOW)), 'api_changed');
});

test('a service error on the list fails it, because a short list would look complete', () => {
  const body = clone();
  body.errors = [{ message: 'service error', path: ['currentUser', 'dropCampaigns', 3] }];
  assert.equal(kindOf(() => parseDirectory(body, NOW)), 'network');
});

test('rewards failing only loses the rewards', () => {
  const body = clone();
  body.errors = [{ message: 'service error', path: ['rewardCampaignsAvailableToUser'] }];
  body.data.rewardCampaignsAvailableToUser = null;
  assert.equal(parseDirectory(body, NOW).campaigns.length, 3);
});

test('renamed fields throw instead of reading as no campaigns', () => {
  const gone = clone();
  delete gone.data.currentUser.dropCampaigns;
  assert.equal(kindOf(() => parseDirectory(gone, NOW)), 'bad_response');
  const nulls = clone();
  nulls.data.currentUser.dropCampaigns = [null, null];
  assert.equal(kindOf(() => parseDirectory(nulls, NOW)), 'bad_response');
  const noGames = clone();
  for (const c of noGames.data.currentUser.dropCampaigns) delete c.game;
  assert.equal(kindOf(() => parseDirectory(noGames, NOW)), 'bad_response');
  const noMinutes = clone();
  for (const c of noMinutes.data.currentUser.dropCampaigns) for (const d of c.timeBasedDrops) delete d.requiredMinutesWatched;
  assert.equal(kindOf(() => parseDirectory(noMinutes, NOW)), 'bad_response');
  assert.equal(kindOf(() => parseDirectory(undefined, NOW)), 'bad_response');
  assert.equal(kindOf(() => parseDirectory({ data: { currentUser: { dropCampaigns: 'x' } } }, NOW)), 'bad_response');
});

test('a truly empty list is allowed and means nothing is running', () => {
  for (const list of [[], null]) {
    assert.deepEqual(parseDirectory({ data: { currentUser: { dropCampaigns: list } } }, NOW).campaigns, []);
  }
});

test('unknown status falls back to the dates', () => {
  const body = clone();
  body.data.currentUser.dropCampaigns[0].status = 'SOMETHING_NEW';
  body.data.currentUser.dropCampaigns[3].status = 'SOMETHING_NEW'; // Its dates have passed.
  const games = parseDirectory(body, NOW).campaigns.map((c) => c.game);
  assert.ok(games.includes('Madden NFL 27'));
  assert.ok(!games.includes('Tanki Online'));
});

test('the saved list is bounded', () => {
  const body = clone();
  const one = body.data.currentUser.dropCampaigns[1];
  body.data.currentUser.dropCampaigns = Array.from({ length: 900 }, (_, i) => ({ ...one, id: String(i) }));
  assert.equal(parseDirectory(body, NOW).campaigns.length, 500);
});

test('freshness: a good list lasts longer than a failure, and neither reopens the tab every click', () => {
  assert.equal(isFresh(null, NOW), false);
  assert.equal(isFresh({ triedAt: NOW - FRESH_MS + 1000, error: null }, NOW), true);
  assert.equal(isFresh({ triedAt: NOW - FRESH_MS - 1000, error: null }, NOW), false);
  assert.equal(isFresh({ triedAt: NOW - RETRY_MS + 1000, error: { kind: 'timeout' } }, NOW), true);
  assert.equal(isFresh({ triedAt: NOW - RETRY_MS - 1000, error: { kind: 'timeout' } }, NOW), false);
});

test('a failure keeps the last list and its age', () => {
  const prev = { ...parsed(), at: NOW - 1000, triedAt: NOW - 1000, error: null };
  const failed = failedDirectory(prev, { kind: 'timeout' }, NOW);
  assert.equal(failed.campaigns.length, 4);
  assert.equal(failed.at, NOW - 1000);
  assert.equal(failed.triedAt, NOW);
  assert.equal(failedDirectory(undefined, { kind: 'auth' }, NOW).at, null);
});

test('every failure kind has a message that does not suggest progress is broken', () => {
  for (const kind of ['api_changed', 'bad_response', 'network', undefined]) {
    assert.match(directoryError({ kind }), /progress is not affected/);
  }
  assert.match(directoryError({ kind: 'auth' }), /Log in/);
  assert.match(directoryError({ kind: 'timeout' }), /Open it below/);
});
