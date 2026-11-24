// The Badges tab: the badge drops of the channel being looked at, and the badges not earned yet.
// Pure, no chrome.*.
import { span, day, categoryUrl, directoryError, endsText } from './directory.js';

// How old the last whole owned list may be and still prove a reward is not owned. Polls run every
// minute with or without a stream, and about half answer this field, so it is normally minutes old.
export const OWNED_FRESH_MS = 30 * 60000;

/**
 * true: an owned list named it. false: a whole and recent list did not (tracker.js mergeRewards).
 * null: unknown, never "not owned". A reward given as a POOL is in no owned list at all
 * (2026-11-23), so false means something for a BADGE only.
 */
export function rewardOwned(state, id, now) {
  if (!id) return null;
  if ((state?.rewards?.ids ?? []).includes(id)) return true;
  const wholeAt = state?.rewards?.wholeAt;
  const age = now - wholeAt;
  return wholeAt != null && age >= 0 && age <= OWNED_FRESH_MS ? false : null;
}

const httpsOr = (url) => {
  try { return new URL(url).protocol === 'https:' ? url : null; } catch { return null; }
};
const objects = (list) => (Array.isArray(list) ? list.filter((x) => x && typeof x === 'object') : []);
const running = (c, now) => (c.endAt == null || now < c.endAt) && (c.startAt == null || now >= c.startAt);

/** A seen campaign's badges: null when they are all proven, or when nothing says it has any. */
function seenRow(c, sitewide, state, claimed, left, now) {
  if (!c.badge && !sitewide) return null;
  const missing = [];
  const unknown = [];
  const counted = new Set();
  let owned = 0;
  let countable = !c.cut;
  for (const g of objects(c.groups)) {
    for (const r of objects(g.rewards)) {
      if (counted.has(r.id)) continue; // One badge, offered by two groups.
      counted.add(r.id);
      if (!r.badge) countable = false;
      const has = claimed.has(`${c.id}/${g.id}`) ? true : rewardOwned(state, r.id, now);
      if (has === true) owned++;
      // Likely earned (tracker.js leftDrops) is not proof either way.
      else if (has === false && r.badge && !left.has(g.id)) missing.push({ name: r.name || c.name, unknown: false });
      else unknown.push({ name: r.name || c.name, unknown: true });
    }
  }
  if (!counted.size || (owned === counted.size && !c.cut)) return null;
  if (unknown.length) countable = false;
  const status = !missing.length ? 'Cannot tell if earned'
    : !countable ? 'Not all earned'
      : counted.size === 1 ? 'Not earned yet' : `${owned} of ${counted.size} owned`;
  return { kind: missing.length ? 'missing' : 'unknown', status, missing: [...missing, ...unknown], more: !!c.more || counted.size > 1 };
}

function whereText(c) {
  const others = c.place ? c.places - 1 : 0;
  return [
    c.cut ? 'Part of this campaign could not be read.' : '',
    c.someChannels ? 'Some of it counts only on certain channels.' : '',
    others > 0 ? `Also counts in ${others} other ${others === 1 ? 'category' : 'categories'}.` : '',
  ].filter(Boolean).join(' ');
}

const endsLine = (endAt, now) => endsText(endAt, now).replace(/^e/, 'E'); // A line of its own here.
const KIND_ORDER =['missing', 'unseen', 'unknown'];

/**
 * The rows of "Badges not earned yet" (drops-tracker#12): badge campaigns seen on opened channels
 * (seen: storage seenBadges), and sitewide ones in the saved All Drops list. One row per campaign;
 * one whose watch badges are all proven earned is left out, even with a sub goal left. Proven: named
 * by the owned list, or its group called claimed by Twitch's channel page (claimed: storage
 * claimedGroups). kind: missing (something is proven not earned), unseen (only listed, and the list
 * names one reward per campaign, so it says nothing about which), unknown.
 * Bound: MAX_SEEN_BADGES plus the saved list's sitewide campaigns (DIRECTORY_MAX).
 */
export function unearnedBadges({ state, seen, directory, claimed }, now) {
  const listed = new Map(objects(directory?.campaigns)
    .filter((c) => c.kind === 'reward' && c.sitewide === true && c.id && c.name && c.minutes > 0 && running(c, now))
    .map((c) => [c.id, c]));
  const done = new Set(objects(claimed).filter((x) => now < x.endAt).map((x) => `${x.campaignId}/${x.groupId}`));
  const left = new Set(objects(state?.leftDrops).map((x) => x.id));
  const out = [];
  for (const c of objects(seen)) {
    if (!c.id || !c.name || !Array.isArray(c.groups) || !running(c, now)) continue;
    const list = listed.get(c.id);
    const row = seenRow(c, !!list, state, done, left, now);
    listed.delete(c.id);
    if (!row) continue;
    const browse = c.place ? categoryUrl(c.place.name) : null;
    const info = httpsOr(c.infoUrl) || httpsOr(list?.linkUrl);
    out.push({
      id: c.id,
      name: c.name,
      art: httpsOr(list?.art) || httpsOr(c.art),
      endAt: c.endAt,
      ends: endsLine(c.endAt, now),
      ...row,
      where: whereText(c),
      link: browse ? { label: `Browse ${c.place.name}`, href: browse } : info ? { label: 'Details', href: info } : null,
    });
  }
  for (const c of listed.values()) {
    const info = httpsOr(c.linkUrl);
    out.push({
      id: c.id,
      name: c.name,
      art: httpsOr(c.art),
      endAt: c.endAt ?? null,
      ends: endsLine(c.endAt, now),
      kind: 'unseen',
      status: 'Open a channel in it to see its badges',
      missing: [],
      more: false,
      where: '',
      link: info ? { label: 'Details', href: info } : null,
    });
  }
  return out.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    || (a.endAt ?? Infinity) - (b.endAt ?? Infinity)
    || String(a.name).localeCompare(String(b.name)));
}

/** Why the saved list could not be loaded, worded for this tab, which has its own button. */
export function badgesListError(error) {
  if (!error) return '';
  return error.kind === 'timeout' ? "Twitch's campaigns page did not answer. Try again." : directoryError(error);
}

function dropRow(d, campaignEnd, now) {
  if (d.required <= 0) {
    return { ...d, pct: null, line: d.subs > 1 ? `${d.subs} subs or gifts to earn` : 'Subscribe or gift a sub to earn', atRisk: false };
  }
  // Seen leaving Twitch's in-progress list (tracker.js leftBadges). One reading short of the
  // requirement is how an earned badge looked on 2026-11-20; further off, why is not known.
  if (d.left) {
    return {
      ...d,
      pct: Math.floor((Math.min(d.left.minutes, d.required) / d.required) * 100),
      line: d.left.near
        ? `Likely earned: left Twitch's in-progress list at ${d.left.minutes} of ${d.required} min`
        : `Left Twitch's in-progress list at ${d.left.minutes} of ${d.required} min, reason unknown`,
      atRisk: false,
    };
  }
  // Twitch reports no minutes until the session names this drop, so "none reported" is not zero.
  if (d.minutes == null) {
    return { ...d, pct: null, line: `Watch ${span(d.required)} to earn`, atRisk: false };
  }
  const left = Math.max(0, d.required - d.minutes);
  const end = Date.parse(campaignEnd);
  return {
    ...d,
    pct: Math.floor((Math.min(d.minutes, d.required) / d.required) * 100),
    line: left ? `Watch ${span(left)} to earn` : 'Watch time reached',
    atRisk: left > 0 && !Number.isNaN(end) && left * 60000 > end - now,
  };
}

function section(stream, now) {
  const title = stream.displayName || stream.login;
  if (stream.channelState === 'offline') {
    return { title, note: 'Offline. Badge drops are only checked while the channel is live.', campaigns: [] };
  }
  if (stream.channelState === 'unknown') return { title, note: 'Cannot check this channel right now.', campaigns: [] };
  if (!stream.badges?.length) {
    // Badge campaigns come from a query of their own (ChannelDropsCampaigns), which can fail alone.
    const note = stream.badgeLookupFailed ? "Cannot read this channel's badge drops right now." : 'No badge drops on this channel.';
    return { title, note, campaigns: [] };
  }
  return {
    title,
    note: null,
    campaigns: stream.badges.map((b) => {
      const end = Date.parse(b.endAt);
      return {
        id: b.id,
        ends: [b.name, Number.isNaN(end) ? '' : `ends ${day(end)}`].filter(Boolean).join(', '),
        drops: b.drops.map((d) => dropRow(d, b.endAt, now)),
      };
    }),
  };
}

// A badge Twitch is counting minutes on that no open channel lists (tracker.js unplacedBadges).
function unplacedSection(unplaced) {
  const rising = (unplaced || []).filter((u) => u.rising);
  if (!rising.length) return [];
  const counts = rising.map((u) => `${u.minutes} of ${u.required} min`).join('; ');
  return [{
    title: null,
    note: `Twitch is counting minutes on a badge no open channel lists (${counts}). Twitch may have changed where it lists channel badges, so it cannot be shown here.`,
    campaigns: [],
  }];
}

/**
 * login: the channel being looked at. Without one (the toolbar popup over a page that is not a
 * channel), every open channel that has badges. unplaced: state.unplacedBadges.
 */
export function badgeSections(streams, login, now, unplaced) {
  const lead = unplacedSection(unplaced);
  const open = (streams || []).filter((s) => s.login);
  if (login) {
    const stream = open.find((s) => s.login === login);
    if (stream) return [...lead, section(stream, now)];
    // Said on the channel's own page while its first check runs (audit, 2026-11-22: "needs its own
    // page open" read as broken there). Also true of a tab past the tab limit, never checked.
    return [...lead, { title: null, note: 'This channel has not been checked yet.', campaigns: [] }];
  }
  const withBadges = open.filter((s) => s.badges?.length);
  if (withBadges.length) return [...lead, ...withBadges.map((s) => section(s, now))];
  return [...lead, { title: null, note: 'Open a channel to see its badge drops.', campaigns: [] }];
}
