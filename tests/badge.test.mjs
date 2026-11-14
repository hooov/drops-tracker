import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchSnapshot } from '../extension/lib/twitch.js';
import { update, warning, badge } from '../extension/lib/tracker.js';
import { chipView, channelFromPath } from '../extension/lib/chip.js';
import { badgeSections } from '../extension/lib/badges.js';

// Everything here runs the real parser on real answers, then the real tracker on what it returns.
const fx = JSON.parse(readFileSync(new URL('./fixtures/badge-2026-11-06.json', import.meta.url)));
const T0 = Date.parse('2026-11-06T19:00:00Z');
const MIN = 60000;
const json = (body) => ({ status: 200, ok: true, json: async () => body });

/** Twitch for one or more badge channels. minutes: login -> session minutes, or null for none. */
const twitch = (minutes, inventory = []) => async (_url, init) => json(JSON.parse(init.body).map((o) => {
  const v = o.variables;
  switch (o.operationName) {
    case 'Inventory':
      return { data: { currentUser: { inventory: { dropCampaignsInProgress: inventory, gameEventDrops: [] } } } };
    case 'VideoPlayerStreamInfoOverlayChannel':
      return { data: { user: v.channel === 'charlie' ? fx.mixedChannel : fx.subOnlyChannel } };
    case 'DropsHighlightService_AvailableDrops':
      return { data: { channel: v.channelID === fx.mixed.id ? fx.mixed : fx.subOnly } };
    default: {
      const m = minutes.charlie;
      const real = v.channelID === fx.mixed.id && m != null;
      return { data: { currentUser: { dropCurrentSession: real ? { ...fx.mixedSession, currentMinutesWatched: m } : fx.zeroedSession } } };
    }
  }
}));

async function poll(prev, login, minutes, i, inventory) {
  const snap = await fetchSnapshot('tok', [login], twitch({ [login]: minutes }, inventory));
  return update(prev, {
    campaigns: snap.campaigns,
    rewards: snap.rewards,
    session: snap.session,
    sessions: snap.sessions,
    streams: [{
      tabId: 1,
      login,
      channel: snap.channels[login],
      tab: { discarded: false, frozen: false },
      player: { hasVideo: true, paused: false, ended: false, readyState: 4, currentTime: 100 + i * 60, muted: false, hidden: false },
    }],
  }, T0 + i * MIN);
}

async function run(login, minutesPerPoll) {
  let s;
  for (let i = 0; i < minutesPerPoll.length; i++) s = await poll(s, login, minutesPerPoll[i], i);
  return s;
}

const flat = (n, m = 3) => Array.from({ length: n }, () => m);

test('the first bug: a timer badge must not read as "may need your game account linked"', async () => {
  const s = await run('charlie', flat(8));
  const chip = chipView(s, T0 + 7 * MIN);
  assert.notEqual(chip.text, 'Drops ?');
  assert.notEqual(s.verdict.limited, true);
  assert.doesNotMatch(chip.title, /account linked/);
  assert.notEqual(badge(s).text, '?');
});

test('a timer badge is tracked like any drop: flat minutes on a playing channel warn as Hung', async () => {
  const s = await run('charlie', flat(8));
  assert.equal(s.streams[0].channelState, 'eligible');
  assert.equal(s.verdict.code, 'stalled');
  assert.equal(s.verdict.cause, 'uncounted');
  assert.match(chipView(s, T0 + 7 * MIN).text, /^Hung \d+m$/);
  assert.equal(badge(s).text, '!');
  assert.match(warning(s, T0 + 7 * MIN).short, /^Drops not counting/);
  assert.deepEqual([s.active[0].name, s.active[0].game, s.active[0].minutes, s.active[0].required], ['The Two Rings', 'Charlie', 3, 180]);
});

test('a timer badge gets the same grace as a drop: no warning before the 4 minutes are up', async () => {
  const s = await run('charlie', flat(3));
  assert.equal(s.verdict.code, 'waiting');
  assert.equal(warning(s, T0 + 2 * MIN), null);
});

test('opening a badge channel while already tracking: its existing minutes are not a gain', async () => {
  // The usual real case: the tracker has been polling for a while, then you open this channel.
  // The session answers before anyone watches, so reading 3 must not count as earning.
  let s = await poll(undefined, 'subonly', null, 0);
  s = await poll(s, 'charlie', 3, 1);
  assert.equal(s.lastGainAt, null);
  assert.notEqual(s.verdict.code, 'earning');
  assert.equal(s.verdict.code, 'waiting');
  for (let i = 2; i < 9; i++) s = await poll(s, 'charlie', 3, i);
  assert.equal(s.lastGainAt, null);
  assert.equal(s.verdict.code, 'stalled');
});

test('rising badge minutes are real earning, with the channel named and the right percentage', async () => {
  const s = await run('charlie', [3, 4, 5, 6]);
  assert.equal(s.verdict.code, 'earning');
  assert.equal(s.verdict.channel, 'Charlie');
  assert.equal(s.streams[0].channelState, 'eligible');
  assert.equal(s.streams[0].credited, true);
  const chip = chipView(s, T0 + 3 * MIN);
  assert.deepEqual([chip.tone, chip.text], ['ok', '3%']);
});

test('a badge that was rising and stops is a real stall', async () => {
  const s = await run('charlie', [3, 4, 5, ...flat(6, 5)]);
  assert.equal(s.verdict.code, 'stalled');
  assert.equal(s.verdict.cause, 'uncounted');
});

test('a finished badge is not earnable and not flagged', async () => {
  const s = await run('charlie', flat(6, 180));
  assert.equal(s.streams[0].channelState, 'finished');
  assert.notEqual(s.verdict.limited, true);
});

test('timer badge with no minutes reported: says it cannot be tracked, and not about game accounts', async () => {
  const early = await run('charlie', flat(2, null));
  assert.equal(early.verdict.code, 'waiting');
  const s = await run('charlie', flat(8, null));
  assert.equal(s.streams[0].channelState, 'badge_unseen');
  assert.equal(s.active.length, 0);
  assert.equal(s.verdict.limited, true);
  assert.equal(s.verdict.badge, true);
  assert.match(s.verdict.message, /Charlie's badge has a watch timer/);
  assert.match(s.verdict.message, /already have earned it/);
  assert.doesNotMatch(s.verdict.message, /account/);
  assert.equal(chipView(s, T0 + 7 * MIN).text, 'Drops ?');
  assert.equal(warning(s, T0 + 7 * MIN).short, 'Drops not being tracked');
});

test('sub-only badge: says so instead of "no Drops here", and stays quiet', async () => {
  const s = await run('subonly', flat(8, null));
  assert.equal(s.streams[0].channelState, 'sub_only');
  assert.equal(warning(s, T0 + 7 * MIN), null);
  assert.notEqual(chipView(s, T0 + 7 * MIN).text, 'Drops ?');
});

test('a game campaign missing from Inventory still warns: this must stay specific to badges', async () => {
  const game = structuredClone(fx.mixed);
  game.viewerDropCampaigns[0].game = { id: '1', displayName: 'Some Game' };
  const body = async (_url, init) => {
    const res = await twitch({ charlie: null })(_url, init);
    const answers = await res.json();
    JSON.parse(init.body).forEach((o, i) => {
      if (o.operationName === 'DropsHighlightService_AvailableDrops') answers[i] = { data: { channel: game } };
    });
    return json(answers);
  };
  let s;
  for (let i = 0; i < 6; i++) {
    const snap = await fetchSnapshot('tok', ['charlie'], body);
    s = update(s, { campaigns: snap.campaigns, rewards: snap.rewards, session: snap.session, sessions: snap.sessions, streams: [{ tabId: 1, login: 'charlie', channel: snap.channels.charlie, tab: {}, player: { hasVideo: true, readyState: 4, currentTime: 100 + i * 60 } }] }, T0 + i * MIN);
  }
  assert.equal(s.streams[0].channelState, 'unstarted');
  assert.equal(s.verdict.limited, true);
  assert.match(s.verdict.message, /account linked/);
});

test('a campaign whose game field goes missing is tracked normally, not silenced as a badge', async () => {
  const renamed = structuredClone(fx.mixed);
  delete renamed.viewerDropCampaigns[0].game;
  const body = async (_url, init) => {
    const answers = await (await twitch({ charlie: null })(_url, init)).json();
    JSON.parse(init.body).forEach((o, i) => {
      if (o.operationName === 'DropsHighlightService_AvailableDrops') answers[i] = { data: { channel: renamed } };
    });
    return json(answers);
  };
  const snap = await fetchSnapshot('tok', ['charlie'], body);
  assert.equal(snap.channels.charlie.campaigns[0].channelOwned, false);
});

test('Badges tab: both real drops of the channel, watch with progress and sub without', async () => {
  const s = await run('charlie', flat(2, 5));
  const [sec] = badgeSections(s.streams, 'charlie', T0 + MIN);
  assert.equal(sec.title, 'Charlie');
  assert.match(sec.campaigns[0].ends, /^The Big Three-O, ends Nov/);
  const [sub, watch] = sec.campaigns[0].drops;
  assert.deepEqual([sub.name, sub.pct, sub.line], ['The Big Three-O', null, 'Subscribe or gift a sub to earn']);
  assert.deepEqual([watch.name, watch.pct, watch.line, watch.minutes], ['The Two Rings', 2, 'Watch 2h 55m to earn', 5]);
});

test('a timer badge is in the active list, which is what My Drops and the chip read', async () => {
  const s = await run('charlie', [3, 4]);
  assert.equal(s.active[0].name, 'The Two Rings');
  assert.equal(chipView(s, T0 + MIN).text, '2%');
});

test('Badges tab: no session reported is not shown as zero', async () => {
  const s = await run('charlie', flat(2, null));
  const [, watch] = badgeSections(s.streams, 'charlie', T0 + MIN)[0].campaigns[0].drops;
  assert.deepEqual([watch.pct, watch.minutes, watch.line], [null, null, 'Watch 3h to earn']);
});

test('Badges tab: sub-only channel lists its badge, though it can never earn from watching', async () => {
  const s = await run('subonly', flat(2, null));
  const [sec] = badgeSections(s.streams, 'subonly', T0 + MIN);
  assert.equal(sec.campaigns[0].drops[0].name, 'WoW Forever Pixel Badge');
  assert.equal(sec.campaigns[0].drops[0].pct, null);
});

test('Badges tab: only the channel being looked at', async () => {
  const stream = (login, badges) => ({ login, displayName: login, channelState: 'no_drops', badges });
  const one = { id: 'x', name: 'One', endAt: '2026-11-08T22:30:00Z', drops: [{ id: 'a', name: 'A', required: 0, subs: 1, minutes: null }] };
  const streams = [stream('aaa', [one]), stream('bbb', [{ ...one, id: 'y', name: 'Two' }])];
  assert.deepEqual(badgeSections(streams, 'bbb', T0).map((x) => x.title), ['bbb']);
  assert.deepEqual(badgeSections(streams, null, T0).map((x) => x.title), ['aaa', 'bbb'], 'popup over a non-channel page');
  assert.match(badgeSections(streams, 'ccc', T0)[0].note, /own page open/);
  assert.match(badgeSections([], null, T0)[0].note, /Open a channel/);
});

test('Badges tab: says why when there is nothing, and never reads unknown as none', () => {
  const at = (channelState) => badgeSections([{ login: 'a', displayName: 'A', channelState, badges: [] }], 'a', T0)[0].note;
  assert.match(at('no_drops'), /No badge drops/);
  assert.match(at('offline'), /Offline/);
  assert.match(at('unknown'), /Cannot check/);
});

test('Badges tab: warns when the time left is too short to finish', () => {
  const late = { id: 'x', name: 'One', endAt: new Date(T0 + 30 * MIN).toISOString(), drops: [{ id: 'a', name: 'A', required: 180, subs: 0, minutes: 5 }] };
  const drop = badgeSections([{ login: 'a', channelState: 'badge_unseen', badges: [late] }], 'a', T0)[0].campaigns[0].drops[0];
  assert.equal(drop.atRisk, true);
});

test('Badges tab: a game campaign on the channel is not a badge', async () => {
  const game = structuredClone(fx.mixed);
  game.viewerDropCampaigns[0].game = { id: '1', displayName: 'Some Game' };
  const body = async (_url, init) => {
    const answers = await (await twitch({ charlie: null })(_url, init)).json();
    JSON.parse(init.body).forEach((o, i) => {
      if (o.operationName === 'DropsHighlightService_AvailableDrops') answers[i] = { data: { channel: game } };
    });
    return json(answers);
  };
  const snap = await fetchSnapshot('tok', ['charlie'], body);
  assert.deepEqual(snap.channels.charlie.badges, []);
});

test('the channel comes from the page path, including the chat popout', () => {
  assert.equal(channelFromPath('/Charlie'), 'charlie');
  assert.equal(channelFromPath('/popout/Charlie/chat'), 'charlie');
  assert.equal(channelFromPath('/'), null);
  assert.equal(channelFromPath(''), null);
});

test('two channels both answer a session: the one credited is the one rising', () => {
  const channel = (id, login, dropId) => ({ id, login, displayName: login, live: true, campaigns: [{ id: `c${id}`, name: login, channelOwned: true, benefitIds: [], watchDrops: [{ id: dropId, name: login, required: 180 }] }] });
  const a = channel('1', 'aaa', 'drop-a');
  const b = channel('2', 'bbb', 'drop-b');
  const stream = (tabId, c, i) => ({ tabId, login: c.login, channel: c, tab: {}, player: { hasVideo: true, readyState: 4, currentTime: 100 + i * 60 } });
  let s;
  [[5, 10], [5, 11], [5, 12]].forEach(([ma, mb], i) => {
    const sessions = [
      { login: 'aaa', displayName: 'aaa', dropId: 'drop-a', minutes: ma, required: 180 },
      { login: 'bbb', displayName: 'bbb', dropId: 'drop-b', minutes: mb, required: 180 },
    ];
    s = update(s, { campaigns: [], rewards: { ids: [], complete: true }, session: sessions[0], sessions, streams: [stream(1, a, i), stream(2, b, i)] }, T0 + i * MIN);
  });
  assert.equal(s.verdict.channel, 'bbb');
  const by = Object.fromEntries(s.streams.map((x) => [x.login, x]));
  assert.equal(by.bbb.credited, true);
  assert.equal(by.aaa.credited, false);
  assert.equal(by.aaa.channelState, 'eligible');
  assert.equal(s.verdict.code, 'earning', 'one channel rising is enough, since only one earns at a time');
});

test('state saved by an older version cannot crash a badge poll', async () => {
  let s = await poll(undefined, 'charlie', 3, 0);
  s.drops = { '692c7608-d659-11f1-9553-0a58a9feac02': 3 }; // Older versions stored a bare number.
  s = await poll(s, 'charlie', 4, 1);
  assert.equal(s.verdict.code, 'earning');
});
