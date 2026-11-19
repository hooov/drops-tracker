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
  // What Twitch's own Inventory page asked on 2026-11-19, with no variables.
  ViewerRewardDropInventory: ['828f9f0bdbc735ce3162519717f918b811902984580389a67ad733c684291e62'],
  // Sent by Twitch's channel page on 2026-11-19 (operation logger), variables { channelID }.
  // Answers signed out; the only place a creator badge campaign was found that day.
  ChannelDropsCampaigns: ['bc073ff0bb13797898f83e93dc8009838545dec95ff7fe92243c8fa3a740f7e7'],
};
const MAX_REWARD_GROUPS = 200; // Two campaigns, eight groups, seen on 2026-11-19.
const REWARD_WAIT_MS = 4000;

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

export const CREATOR_BADGE_BRAND = 'CREATOR_LED_BADGE_CAMPAIGN';

/**
 * A channel's own badge campaigns from ChannelDropsCampaigns. On 2026-11-19 a channel's badge
 * (1 sub, or 180 minutes) was in this answer and missing from DropsHighlightService's,
 * which listed only the sitewide GTAVI campaign. Picked by brandName, not by game: GTAVI's
 * campaign has game null here too. Added in the shapes applyCampaigns gives, so the Badges tab
 * and the reward inventory join (group ID = drop ID, confirmed on that badge) work unchanged.
 * Failing only costs the badges it would add: badgeLookupFailed, never the channel unknown.
 */
function applyChannelCampaigns(channel, item) {
  const c = channel;
  if (c.unknown) return;
  const list = item?.data?.channelDropCampaigns;
  if (errorsOf(item).length || !Array.isArray(list)) {
    c.badgeLookupFailed = true;
    return;
  }
  c.badges ||= [];
  c.campaigns ||= [];
  const have = new Set([...c.badges, ...c.campaigns].map((x) => x.id));
  for (const x of list) {
    if (!x?.id || x.brandName !== CREATOR_BADGE_BRAND || have.has(x.id) || !Array.isArray(x.rewardGroups)) continue;
    have.add(x.id);
    const drops = x.rewardGroups.filter((g) => g?.id && g.progressCriteria).slice(0, MAX_BADGE_DROPS).map((g) => {
      const crit = g.progressCriteria;
      const reward = (g.rewards || [])[0];
      return {
        id: g.id,
        name: reward?.name || g.name || x.name,
        image: httpsOr(reward?.thumbnailURL) || httpsOr(x.imageURL),
        required: crit.requirementType === 'WATCH' && crit.requirements?.minutesWatched > 0 ? crit.requirements.minutesWatched : 0,
        subs: crit.requirements?.subs || 0,
      };
    });
    if (c.badges.length < MAX_BADGE_CAMPAIGNS) c.badges.push({ id: x.id, name: x.name, endAt: x.endAt, drops });
    const watch = drops.filter((d) => d.required > 0);
    if (!watch.length) continue;
    c.subOnly = false;
    c.campaigns.push({
      id: x.id,
      name: x.name,
      benefitIds: [],
      channelOwned: true,
      rewardCampaign: false,
      game: null,
      endAt: x.endAt,
      image: x.imageURL,
      watchDrops: watch.map((d) => ({ id: d.id, name: d.name, image: d.image, required: d.required, startAt: x.startAt, endAt: x.endAt, benefitIds: [] })),
    });
  }
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
    // Twitch's own flag, on a campaign with a game. Its daily drop reports a running total, and its
    // other watch drop can be a final reward locked behind every other one (2026-11-19, captured,
    // sitewide, game "Special Events"). A channel badge carries the same flag, but its session
    // minutes are real progress (measured 2026-11-06), so it is left out.
    rewardCampaign: x.summary?.isRewardCampaign === true && x.game !== null,
    game: x.game?.displayName || null,
    endAt: x.endAt,
    image: x.imageURL,
    watchDrops: watchDropsOf(x).map((d) => ({
      id: d.id,
      name: d.benefitEdges?.[0]?.benefit?.name || d.name || x.name,
      image: d.benefitEdges?.[0]?.benefit?.imageAssetURL || x.imageURL,
      required: d.requiredMinutesWatched,
      startAt: d.startAt,
      endAt: d.endAt,
      benefitIds: (d.benefitEdges || []).map((b) => b.benefit?.id).filter(Boolean),
    })),
  }));
}

/**
 * Watch progress from Twitch's reward inventory (`ViewerRewardDropInventory`, the query its own
 * Inventory page makes). It covers channel badges and reward campaigns, which Inventory leaves out,
 * and for a repeating drop it has the 24-hour window that the session's running total does not
 * (captured 2026-11-19: 60 of 60 in a window that had ended, one grant of six, while the session
 * read 250). Only the fields the tracker uses are kept: no sub counts, no reward names.
 * Returns null when the answer cannot be read, which means unknown, never "nothing in progress".
 * A campaign missing from it is unknown too: a badge already claimed was not listed.
 */
export function parseRewardInventory(item) {
  if (errorsOf(item).length || needsIntegrity(item) || isStale(item)) return null;
  const list = item?.data?.currentUser?.inventory?.viewerRewardDropCampaignsInProgress;
  if (!Array.isArray(list)) return null;
  const groups = [];
  for (const c of list) {
    if (!c?.id || !Array.isArray(c.rewardGroups)) continue;
    for (const g of c.rewardGroups) {
      const crit = g?.progressCriteria;
      const required = crit?.requirements?.minutesWatched;
      if (!g?.id || crit?.requirementType !== 'WATCH' || !(required > 0) || !g.self) continue;
      const repeat = crit.repeatableConfig;
      const win = g.self.currentWindow;
      groups.push({
        campaignId: c.id,
        id: g.id,
        // A channel's own badge campaign, as Twitch's client tells them apart (2026-11-19).
        badge: c.brandName === 'CREATOR_LED_BADGE_CAMPAIGN',
        required,
        minutes: typeof g.self.currentMinutesWatched === 'number' ? g.self.currentMinutesWatched : null,
        status: typeof g.self.status === 'string' ? g.self.status : null,
        earned: !!g.self.earnedReward,
        preconditionsMet: g.self.hasPreconditionsMet !== false,
        repeatTimes: repeat?.repeatableTimes > 0 ? repeat.repeatableTimes : null,
        grants: typeof g.self.grantCount === 'number' ? g.self.grantCount : null,
        windowEnd: win ? dateOrNull(win.expiresAt) : null,
        nextEligibleAt: dateOrNull(g.self.nextEligibleAt),
      });
      if (groups.length >= MAX_REWARD_GROUPS) return groups;
    }
  }
  return groups;
}

/**
 * Everything one poll needs. Throws TwitchError only when progress itself cannot be read; other
 * failures mark the affected channels unknown, so "stalled" is never judged on missing data.
 * known: { working: {op: hash}, learned: {op: hash} }. options: { askRewards }.
 */
export async function fetchSnapshot(token, logins, fetchImpl = fetch, known = {}, options = {}) {
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
        { name: 'ChannelDropsCampaigns', variables: { channelID: c.id } },
      ]), ctx);
      liveChannels.forEach((c, i) => {
        applyCampaigns(c, second[i * 3]);
        applyChannelCampaigns(c, second[i * 3 + 2]);
        const sessionAnswer = second[i * 3 + 1];
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

  // Asked when an open channel offers a campaign Inventory leaves out, and while any channel is
  // live at least every 15 minutes (options.askRewards), so a badge Twitch credits but no channel
  // lists still shows up. A request of its own, so it can never cost the poll: every failure,
  // 401 and 429 included, is "unknown".
  let rewardGroups;
  const inventoryIds = new Set(campaigns.map((c) => c.id));
  if ((liveChannels.length && options.askRewards) || liveChannels.some((c) => (c.campaigns || []).some((x) => !inventoryIds.has(x.id)))) {
    // A slow answer must not hold the poll: after REWARD_WAIT_MS it counts as unknown.
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), REWARD_WAIT_MS); });
    try {
      const asked = run(token, [{ name: 'ViewerRewardDropInventory', variables: {} }], ctx)
        .then(([answer]) => parseRewardInventory(answer), () => null);
      rewardGroups = await Promise.race([asked, late]);
    } catch {
      rewardGroups = null;
    } finally {
      clearTimeout(timer);
    }
  }

  return { campaigns, rewards, channels, session: sessions[0] ?? null, sessions, rewardGroups, working: ctx.working };
}
