// Read-only client for the persisted GQL operations twitch.tv itself uses. None of this is a
// public API, so it is written around how it was seen to fail (docs/twitch-drops-facts.md):
// - A response can carry good data AND an error on one field. Half of real Inventory calls do.
// - Hashes retire without notice. Each operation has several candidates, and the extension
//   learns current ones from Twitch's own page traffic.
// - Only Inventory is essential. Losing anything else narrows what can be said, not everything.

import { RESERVED } from './chip.js';

export const GQL_URL = 'https://gql.twitch.tv/gql';
export const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const TIMEOUT_MS = 10000;
const RETRY_WAIT_MS = 1500;
const MAX_CHANNELS = 10;
const DIRECTORY_MAX = 500; // 142 seen on 2026-11-06.
const MAX_BADGE_CAMPAIGNS = 10; // One per channel seen on 2026-11-06.
const MAX_BADGE_DROPS = 20; // Two per campaign seen.
const MAX_TEXT = 200;
const HASH = /^[0-9a-f]{64}$/;

/** Known good hashes, tried in order. Inventory's second is the one Twitch's page used on 2026-11-06. */
export const PINNED = {
  Inventory: [
    '8337eb8541b314040b0edde0c09c5c7a2783ba1960aa9edfbf3bac16d0fec404',
    '3f6e2aea40af76f3ceadb2cca2f4b3337c2f074f3139dac1c117a20eace8b0bd',
  ],
  DropCurrentSessionContext: ['4d06b702d25d652afb9ef835d2a550031f1cf762b193523a92166f40ea3d142b'],
  DropsHighlightService_AvailableDrops: ['782dad0f032942260171d2d80a654f88bdd0c5a9dddc392e9bc92218a0f42d20'],
  VideoPlayerStreamInfoOverlayChannel: ['198492e0857f6aedead9665c81c5a06d67b25b58034649687124083ff288597d'],
};

// Fields of Inventory that failing does not affect tracking. Seen failing constantly.
const OPTIONAL_INVENTORY_FIELDS = new Set(['gameEventDrops', 'gameEventDropsConnection', 'earnedDropRewards']);

export class TwitchError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // auth | api_changed | network | bad_response
  }
}

/** Channel login for a live-channel page URL, else null. */
export function parseLogin(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^(www\.|m\.)?twitch\.tv$/.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 1) return null;
  const login = parts[0].toLowerCase();
  return RESERVED.has(login) ? null : login;
}

/** Hashes for the operations we use, from a request body Twitch's own page sent. */
export function extractHashes(bodyText) {
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch { return {}; }
  const found = {};
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    const name = item?.operationName;
    const hash = item?.extensions?.persistedQuery?.sha256Hash;
    if (Object.hasOwn(PINNED, name) && HASH.test(hash ?? '')) found[name] = hash;
  }
  return found;
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function send(headers, body, fetchImpl) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(GQL_URL, { method: 'POST', headers, body, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A bad Client-ID and a bad token both give the same 401 when a token is sent, so "Signed out"
 * would be a lie if Twitch rotated its client ID. Without a token they differ: 400 vs 200.
 */
async function clientIdRejected(fetchImpl) {
  try {
    const res = await send(
      { 'Client-ID': CLIENT_ID, 'Content-Type': 'text/plain' },
      JSON.stringify([operation('VideoPlayerStreamInfoOverlayChannel', { channel: 'twitch' }, PINNED.VideoPlayerStreamInfoOverlayChannel[0])]),
      fetchImpl,
    );
    return res.status === 400;
  } catch {
    return false;
  }
}

const operation = (operationName, variables, sha256Hash) => ({
  operationName,
  variables,
  extensions: { persistedQuery: { version: 1, sha256Hash } },
});

async function post(token, ops, fetchImpl) {
  const headers = { 'Client-ID': CLIENT_ID, Authorization: `OAuth ${token}`, 'Content-Type': 'text/plain' };
  const body = JSON.stringify(ops);
  let res;
  for (let attempt = 0; ; attempt++) {
    let failure = null;
    try {
      res = await send(headers, body, fetchImpl);
      if (res.status >= 500) failure = `Twitch answered HTTP ${res.status}`;
    } catch (e) {
      failure = e?.name === 'AbortError' ? 'Twitch did not answer in time' : 'Could not reach Twitch';
    }
    if (!failure) break;
    if (attempt >= 1) throw new TwitchError('network', failure);
    await wait(RETRY_WAIT_MS);
  }
  if (res.status === 401) {
    if (await clientIdRejected(fetchImpl)) throw new TwitchError('api_changed', 'Twitch changed its client ID');
    throw new TwitchError('auth', 'Twitch rejected the login');
  }
  if (res.status === 400) throw new TwitchError('api_changed', 'Twitch rejected the request format');
  if (res.status === 429) throw new TwitchError('network', 'Twitch is rate limiting requests');
  if (!res.ok) throw new TwitchError('network', `Twitch answered HTTP ${res.status}`);
  let parsed;
  // The abort timer ends at the headers, so a body that stalls needs its own limit, or the
  // poll never finishes and every later one waits on it.
  let bodyTimer;
  const stalled = new Promise((_, reject) => {
    bodyTimer = setTimeout(() => reject(new TwitchError('network', 'Twitch did not answer in time')), TIMEOUT_MS);
  });
  try {
    parsed = await Promise.race([res.json(), stalled]);
  } catch (e) {
    throw e instanceof TwitchError ? e : new TwitchError('bad_response', 'Twitch sent unreadable data');
  } finally {
    clearTimeout(bodyTimer);
  }
  if (!Array.isArray(parsed) || parsed.length !== ops.length) throw new TwitchError('bad_response', 'Twitch sent an unexpected response');
  return parsed;
}

const errorsOf = (item) => (Array.isArray(item?.errors) ? item.errors : []);
const isStale = (item) => errorsOf(item).some((e) => /PersistedQuery/i.test(e?.message ?? '') || /PERSISTED_QUERY/.test(e?.extensions?.code ?? ''));
const needsIntegrity = (item) => errorsOf(item).some((e) => /integrity/i.test(e?.message ?? ''));

function candidates(name, known) {
  const list = [known?.working?.[name], ...PINNED[name], known?.learned?.[name]];
  return [...new Set(list.filter((h) => HASH.test(h ?? '')))];
}

/**
 * Sends each op with its best hash, moving a stale op on to its next candidate. Reports the hash
 * that worked in `working`, so later polls go straight to it.
 */
async function run(token, ops, ctx) {
  const results = new Array(ops.length);
  const tried = ops.map(() => 0);
  const lists = ops.map((o) => candidates(o.name, ctx.known));
  let pending = ops.map((_, i) => i);
  while (pending.length) {
    const answers = await post(token, pending.map((i) => operation(ops[i].name, ops[i].variables, lists[i][tried[i]])), ctx.fetchImpl);
    const next = [];
    pending.forEach((i, at) => {
      results[i] = answers[at];
      if (!isStale(answers[at])) {
        ctx.working[ops[i].name] = lists[i][tried[i]];
      } else if (tried[i] + 1 < lists[i].length) {
        tried[i]++;
        next.push(i);
      }
    });
    pending = next;
  }
  return results;
}

/** Empty sessions come back as a zeroed object, or null when no channel ID is sent. */
export function normalizeSession(raw) {
  if (!raw || !raw.channel || !raw.dropID) return null;
  return {
    login: raw.channel.name,
    displayName: raw.channel.displayName || raw.channel.name,
    dropId: raw.dropID,
    minutes: raw.currentMinutesWatched,
    required: raw.requiredMinutesWatched,
  };
}

/**
 * Rewards the user already owns. The list is only used to rule campaigns out, so it says whether
 * it is complete: the newer query's connection is paged, and either field can fail outright.
 * ids: null means unknown, not none.
 */
export function parseRewards(inventory) {
  if (Array.isArray(inventory?.gameEventDrops)) {
    return { ids: inventory.gameEventDrops.map((r) => r?.id).filter(Boolean), complete: true };
  }
  const edges = inventory?.gameEventDropsConnection?.edges;
  if (Array.isArray(edges)) {
    return {
      ids: edges.map((e) => e?.node?.id).filter(Boolean),
      complete: inventory.gameEventDropsConnection.pageInfo?.hasNextPage === false,
    };
  }
  return { ids: null, complete: false };
}

/** The essential answer. Anything doubtful here must fail the poll, never read as "no drops". */
export function parseInventory(item) {
  if (needsIntegrity(item)) throw new TwitchError('api_changed', 'Twitch now requires an integrity check');
  if (isStale(item)) throw new TwitchError('api_changed', 'Twitch changed its API');
  const errors = errorsOf(item);
  const user = item?.data?.currentUser;
  if (user === null && !errors.length) throw new TwitchError('auth', 'Not logged in to Twitch');
  const inventory = user?.inventory;
  if (!inventory) {
    throw errors.length
      ? new TwitchError('network', 'Twitch had a service error')
      : new TwitchError('bad_response', 'Inventory had an unexpected shape');
  }
  const damaged = errors.some((e) => {
    if (!Array.isArray(e?.path)) return false;
    const field = e.path[2];
    return field === undefined || !OPTIONAL_INVENTORY_FIELDS.has(field);
  });
  if (damaged) throw new TwitchError('network', 'Twitch had a service error');

  const campaigns = inventory.dropCampaignsInProgress;
  // Twitch uses null for an empty list. A missing key is the query itself having changed.
  if (campaigns === undefined) throw new TwitchError('bad_response', 'Inventory had an unexpected shape');
  if (campaigns === null && errors.length) throw new TwitchError('network', 'Twitch had a service error');
  const raw = campaigns ?? [];
  if (!Array.isArray(raw) || raw.some((c) => !c?.id)) throw new TwitchError('bad_response', 'Inventory had an unexpected shape');
  const list = raw.map((c) => ({ ...c, timeBasedDrops: (c.timeBasedDrops || []).filter(Boolean) }));
  // Fields moving must not read as "nothing in progress": every drop losing its requirement
  // or its minutes is the query having changed.
  const drops = list.flatMap((c) => c.timeBasedDrops);
  const watchDrops = drops.filter((d) => d.requiredMinutesWatched > 0);
  if (drops.length && !drops.some((d) => typeof d.requiredMinutesWatched === 'number')) {
    throw new TwitchError('bad_response', 'Inventory had an unexpected shape');
  }
  if (watchDrops.length && !watchDrops.some((d) => typeof d.self?.currentMinutesWatched === 'number')) {
    throw new TwitchError('bad_response', 'Inventory had an unexpected shape');
  }
  return { campaigns: list, rewards: parseRewards(inventory) };
}

const httpsOr = (url) => {
  try { return new URL(url).protocol === 'https:' ? url : null; } catch { return null; }
};
const dateOrNull = (value) => {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
};
const clip = (text) => (typeof text === 'string' ? text.slice(0, MAX_TEXT) : text); // Goes in storage.

function directoryDrop(c, now) {
  // Rows are only ever removed on evidence: an unknown status falls back to the dates.
  if (c.status === 'EXPIRED' || c.status === 'UPCOMING') return null;
  const endAt = dateOrNull(c.endAt);
  if (endAt != null && now >= endAt) return null;
  const drops = (c.timeBasedDrops || []).filter(Boolean);
  return {
    kind: 'drop',
    id: c.id,
    name: clip(c.name),
    game: clip(c.game?.displayName || c.name),
    owner: clip(c.owner?.name || ''),
    art: httpsOr(c.game?.boxArtURL),
    startAt: dateOrNull(c.startAt),
    endAt,
    drops: drops.length,
    // Drops in a campaign tick together (measured), so the longest is the whole campaign's time.
    minutes: Math.max(0, ...drops.map((d) => d.requiredMinutesWatched || 0)),
    subs: drops.some((d) => d.requiredSubs > 0),
    linked: c.self?.isAccountConnected === true,
    linkUrl: httpsOr(c.accountLinkURL),
  };
}

function directoryReward(r, now) {
  if (!r?.id || !r.name) return null;
  const endAt = dateOrNull(r.endsAt);
  if (endAt != null && now >= endAt) return null;
  return {
    kind: 'reward',
    id: r.id,
    name: clip(r.name),
    game: clip(r.name),
    owner: clip(r.brand || ''),
    art: httpsOr(r.image?.image1xURL),
    startAt: dateOrNull(r.startsAt),
    endAt,
    minutes: r.unlockRequirements?.minuteWatchedGoal || 0,
    sitewide: r.isSitewide === true,
    rewards: (r.rewards || []).map((x) => clip(x?.name)).filter(Boolean).slice(0, 5),
    linkUrl: httpsOr(r.externalURL) || httpsOr(r.aboutURL),
  };
}

/**
 * Twitch's whole campaign list, from the answer its own Drops page received. A list that cannot
 * be trusted must throw, never come back short or empty: an empty list means "nothing is running".
 */
export function parseDirectory(item, now) {
  if (needsIntegrity(item)) throw new TwitchError('api_changed', 'Twitch blocked the campaign list');
  if (isStale(item)) throw new TwitchError('api_changed', 'Twitch changed its API');
  const errors = errorsOf(item);
  const user = item?.data?.currentUser;
  // Logged out gives a null user with errors only on the rewards. An error on the user itself is
  // Twitch failing while you are logged in.
  if (user === null && !errors.some((e) => e?.path?.[0] === 'currentUser')) {
    throw new TwitchError('auth', 'Not logged in to Twitch');
  }
  if (user === null || errors.some((e) => !Array.isArray(e?.path) || e.path.includes('dropCampaigns'))) {
    throw new TwitchError('network', 'Twitch had a service error');
  }
  const raw = user?.dropCampaigns;
  if (raw === undefined) throw new TwitchError('bad_response', 'Campaign list had an unexpected shape');
  const list = (Array.isArray(raw) ? raw : []).filter((c) => c?.id && c.name);
  if (raw !== null && !Array.isArray(raw)) throw new TwitchError('bad_response', 'Campaign list had an unexpected shape');
  // Fields moving must not read as "nothing to watch": every row losing them is the query changing.
  const incomplete = !list.some((c) => c.game?.displayName)
    || !list.flatMap((c) => c.timeBasedDrops || []).some((d) => typeof d?.requiredMinutesWatched === 'number');
  if ((raw?.length && !list.length) || (list.length && incomplete)) {
    throw new TwitchError('bad_response', 'Campaign list had an unexpected shape');
  }
  // Only the drops decide whether the list is usable. Rewards failing just leaves them out.
  const rewards = Array.isArray(item.data.rewardCampaignsAvailableToUser) ? item.data.rewardCampaignsAvailableToUser : [];
  const campaigns = [
    ...rewards.map((r) => directoryReward(r, now)),
    ...list.map((c) => directoryDrop(c, now)),
  ].filter(Boolean).slice(0, DIRECTORY_MAX);
  return { campaigns };
}

const watchDropsOf = (campaign) => (campaign.timeBasedDrops || []).filter((d) => d.requiredMinutesWatched > 0);
const benefitIds = (campaign) => watchDropsOf(campaign).flatMap((d) => (d.benefitEdges || []).map((b) => b.benefit?.id)).filter(Boolean);

function parseChannel(login, item) {
  const unknown = { id: null, login, displayName: login, live: false, campaigns: [], unknown: true };
  if (errorsOf(item).length || !item?.data || !('user' in item.data)) return unknown;
  const u = item.data.user;
  if (u === null) return { ...unknown, unknown: false }; // Not a channel, such as a new site route.
  if (!u.id || !('stream' in u)) return unknown;
  return { id: u.id, login, displayName: u.displayName || login, live: !!u.stream, campaigns: [] };
}

function applyCampaigns(channel, item) {
  const c = channel;
  if (errorsOf(item).length || !item?.data || !('channel' in item.data)) {
    c.unknown = true;
    return;
  }
  const raw = item.data.channel?.viewerDropCampaigns;
  if (raw === undefined && item.data.channel !== null) {
    c.unknown = true;
    return;
  }
  const drops = (raw || []).flatMap((x) => x?.timeBasedDrops || []);
  if (drops.length && !drops.some((d) => typeof d?.requiredMinutesWatched === 'number')) {
    c.unknown = true; // The field moved. Without this it would read as "no Drops here".
    return;
  }
  // Sub-only campaigns never gain from watching, so they must not count as eligible.
  const watchable = (raw || []).filter((x) => watchDropsOf(x).length > 0);
  c.subOnly = !watchable.length && (raw || []).length > 0;
  // The Badges tab shows sub drops too, which never gain from watching. Rebuilt every poll.
  c.badges = (raw || []).filter((x) => x?.id && x.game === null).slice(0, MAX_BADGE_CAMPAIGNS).map((x) => ({
    id: x.id,
    name: x.name,
    endAt: x.endAt,
    drops: (x.timeBasedDrops || []).filter(Boolean).slice(0, MAX_BADGE_DROPS).map((d) => ({
      id: d.id,
      name: d.benefitEdges?.[0]?.benefit?.name || d.name || x.name,
      image: httpsOr(d.benefitEdges?.[0]?.benefit?.imageAssetURL) || httpsOr(x.imageURL),
      required: d.requiredMinutesWatched || 0,
      subs: d.requiredSubs || 0,
    })),
  }));
  c.campaigns = watchable.map((x) => ({
    id: x.id,
    name: x.name,
    benefitIds: benefitIds(x),
    // A channel's own badge has an explicit null game, and Inventory never lists it (measured).
    // Exactly null: if the field ever goes missing, a game campaign must not fall silent.
    channelOwned: x.game === null,
    endAt: x.endAt,
    image: x.imageURL,
    watchDrops: watchDropsOf(x).map((d) => ({
      id: d.id,
      name: d.benefitEdges?.[0]?.benefit?.name || d.name || x.name,
      image: d.benefitEdges?.[0]?.benefit?.imageAssetURL || x.imageURL,
      required: d.requiredMinutesWatched,
      startAt: d.startAt,
      endAt: d.endAt,
    })),
  }));
}

/**
 * Everything one poll needs. Throws TwitchError only when progress itself cannot be read; other
 * failures mark the affected channels unknown, so "stalled" is never judged on missing data.
 * known: { working: {op: hash}, learned: {op: hash} }.
 */
export async function fetchSnapshot(token, logins, fetchImpl = fetch, known = {}) {
  const unique = [...new Set(logins)].slice(0, MAX_CHANNELS);
  const ctx = { fetchImpl, known, working: {} };
  const first = await run(token, [
    { name: 'Inventory', variables: { fetchRewardCampaigns: false } },
    ...unique.map((channel) => ({ name: 'VideoPlayerStreamInfoOverlayChannel', variables: { channel } })),
  ], ctx);

  const { campaigns, rewards } = parseInventory(first[0]);
  const channels = {};
  unique.forEach((login, i) => { channels[login] = parseChannel(login, first[i + 1]); });

  // The session query needs a channel ID with a campaign: empty gives null, an unrelated ID
  // gives a zeroed session. So ask per channel and keep the first real one.
  const liveChannels = Object.values(channels).filter((c) => c.id && c.live);
  const sessions = [];
  if (liveChannels.length) {
    try {
      const second = await run(token, liveChannels.flatMap((c) => [
        { name: 'DropsHighlightService_AvailableDrops', variables: { channelID: c.id } },
        { name: 'DropCurrentSessionContext', variables: { channelID: c.id, channelLogin: '' } },
      ]), ctx);
      liveChannels.forEach((c, i) => {
        applyCampaigns(c, second[i * 2]);
        const sessionAnswer = second[i * 2 + 1];
        // The only source of a badge's minutes. Its query failing is not Twitch reporting none.
        if (errorsOf(sessionAnswer).length && c.campaigns.some((x) => x.channelOwned)) c.unknown = true;
        const seen = normalizeSession(sessionAnswer?.data?.currentUser?.dropCurrentSession);
        if (seen) sessions.push(seen);
      });
    } catch (e) {
      if (e instanceof TwitchError && e.kind === 'auth') throw e;
      liveChannels.forEach((c) => { c.unknown = true; }); // Progress is fine; only eligibility is unseen.
    }
  }

  return { campaigns, rewards, channels, session: sessions[0] ?? null, sessions, working: ctx.working };
}
