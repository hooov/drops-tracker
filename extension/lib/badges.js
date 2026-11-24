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

const DAY_S = 86400;
const positive = (n) => (Number.isFinite(n) && n > 0 ? n : null);
const reading = (n) => (Number.isFinite(n) && n >= 0 ? n : null);

/**
 * What is left to watch of one group of a seen campaign, or null when what it needs is not known
 * (stored before this was kept, or unreadable).
 * minutes: for the order only, a repeating group's days left as whole windows and unknown progress
 * as none done. known: Twitch reported progress. today: today's window is done. reached: nothing
 * left to watch. late: cannot be done before endAt even at the soonest, judged from the reading's
 * own time, so an old reading never says it of minutes that could have been watched since.
 */
function groupNeed(c, g, state, now) {
  const required = positive(g.minutes);
  const times = positive(g.times);
  if (required == null || times == null) return null;
  const same = (x) => x.id === g.id && x.campaignId === c.id;
  const inv = objects(state?.rewardSeen?.groups).find(same);
  const invAt = positive(state?.rewardSeen?.at);
  const ends = positive(c.endAt) ?? Infinity;
  const blocked = inv?.preconditionsMet === false;
  if (times === 1) {
    // Inventory's own minutes are read every poll, with or without a stream. A running total or a
    // held reading is not this drop's progress (tracker.js rewardCampaigns).
    const own = objects(state?.active).find((x) => same(x) && !x.unjudged && !x.held);
    const at = own ? positive(state.lastOkAt) : invAt;
    const minutes = at == null ? null : reading(own ? own.minutes : inv?.windowEnd == null ? inv?.minutes : null);
    const given = objects(state?.unclaimed).some(same) || ['CLAIMED', 'CLAIMABLE'].includes(inv?.status);
    const reached = given || minutes >= required;
    const left = reached ? 0 : required - (minutes ?? 0);
    return {
      id: g.id,
      minutes: left,
      known: minutes != null,
      daily: false,
      today: false,
      reached,
      blocked,
      waiting: blocked || (reached && !given),
      late: !reached && minutes != null && at + left * 60000 > ends,
      text: reached ? 'Watch time reached'
        : minutes > 0 ? `Watch ${span(left)} more, ${minutes} of ${required} min done` : `Watch ${span(required)}`,
    };
  }
  // The window's minutes and the days granted are only in the reward inventory (2026-11-19). A
  // campaign missing from it is unknown, never zero.
  const read = inv && invAt != null ? inv : null;
  const grants = reading(read?.grants);
  const opens = read?.nextEligibleAt ?? null;
  const windowEnd = read?.windowEnd ?? null;
  const inWindow = windowEnd != null && now < windowEnd && invAt < windowEnd;
  const minutes = inWindow ? reading(read.minutes) : null;
  const partWay = minutes != null && minutes < required;
  // Twitch's next start has never been captured set, so it says nothing against an open window.
  const today = minutes >= required || (!partWay && opens != null && now < opens);
  // Read from Twitch's own client, 2026-11-22 (tracker.js dayIndex): a claimable day is done and
  // not granted yet; any other day at its minutes is already in the grants.
  const days = times - Math.min(times, (grants ?? 0) + (grants != null && read.status === 'CLAIMABLE' ? 1 : 0));
  const reached = days === 0;
  const unit = g.reset === DAY_S;
  const more = grants > 0 || days < times ? ' more' : '';
  const count = unit ? `on ${days}${more} ${days === 1 ? 'day' : 'days'}` : `${days}${more} ${days === 1 ? 'time' : 'times'}`;
  const left = `${span(required)}${unit ? ' ' : ', '}${count}`;
  const watch = `Watch ${left}`;
  return {
    id: g.id,
    minutes: days * ((positive(g.reset) ?? DAY_S) / 60),
    known: read != null,
    daily: true,
    today: today && !reached,
    reached,
    blocked,
    waiting: blocked,
    late: !reached && g.all === true && positive(g.reset) != null && grants != null && soonest() > ends,
    text: reached ? 'Watch time reached'
      : today ? `${unit ? 'Done for today' : 'Done for now'}, then ${left}`
        : minutes > 0 ? `${watch}, ${minutes} of ${required} min ${unit ? 'today' : 'so far'}` : watch,
  };

  /** The soonest all of it could be done: every window opening as the one before it ends. */
  function soonest() {
    const reset = g.reset * 1000;
    const whole = required * 60000;
    const open = windowEnd != null && invAt < windowEnd;
    const atRead = open ? reading(read.minutes) ?? required : 0;
    if (open && atRead < required) return days === 1 ? invAt + (required - atRead) * 60000 : windowEnd + (days - 2) * reset + whole;
    const start = opens ?? (open ? windowEnd : invAt);
    return Math.max(invAt, start) + (days - 1) * reset + whole;
  }
}

/**
 * What the row says of the watching left, from its groups not proven earned. Drops in one campaign
 * tick together (facts, 2026-11-06 and 11-19), so the campaign's watch time is its longest group's.
 * able: something in it can gain now. slack: ms to spare, what "Next" is ordered by, days as whole
 * windows; null when nothing is left or known.
 */
function watchLeft(c, open, now) {
  // Each missing badge cannot be done. Not said of a campaign partly read: the rest may be doable.
  const missing = open.filter((o) => o.missing);
  const allLate = missing.length > 0 && missing.every((o) => o.need?.late);
  const todo = open.filter((o) => o.need && !o.need.reached && !o.need.late);
  const days = todo.filter((o) => o.need.daily);
  // Every daily group done today: one with no reading got those same minutes, so it is not "none
  // done" (GTAVI's last badge, listed as an hour, waits on its days).
  const dayDone = days.length > 0 && days.every((o) => o.need.today);
  const gains = todo.filter((o) => !o.need.today && !o.need.blocked && (!dayDone || o.need.known));
  // A missing badge itself, or one that waits on the campaign's other rewards (GTAVI's last badge:
  // at its minutes and not given, or requirements Twitch says are unmet) and one of those known to
  // be in progress.
  const able = gains.some((o) => o.missing) || (missing.some((o) => o.need?.waiting) && gains.some((o) => o.need.known));
  const longestOf = (list) => list.reduce((a, o) => (a && a.need.minutes >= o.need.minutes ? a : o), null)?.need ?? null;
  // Said: what can gain now, so one group done for today does not speak for another that is not.
  const pick = able ? todo.filter((o) => !o.need.today) : todo.length ? todo : open.filter((o) => o.need);
  const longest = longestOf(pick);
  const texts = (list) => new Set(list.map((o) => o.need?.text)).size;
  const badges = new Set(pick.flatMap((o) => o.ids)).size;
  const each = !!longest && !longest.reached && badges > 1 && texts(pick) === 1;
  const ends = positive(c.endAt);
  return {
    watch: !longest ? '' : each ? `Each badge: ${lower(longest.text)}` : longest.text,
    late: allLate && !c.cut,
    able: able && missing.length > 0 && !allLate,
    slack: todo.length && ends != null ? ends - now - longestOf(todo).minutes * 60000 : null,
    // Per badge only where they differ; with one text the row's own line says it.
    perBadge: texts(open) > 1,
  };
}

const lower = (text) => text.charAt(0).toLowerCase() + text.slice(1);

/** A seen campaign's badges: null when they are all proven, or when nothing says it has any. */
function seenRow(c, sitewide, state, claimed, left, now) {
  if (!c.badge && !sitewide) return null;
  const missing = [];
  const unknown = [];
  const counted = new Map(); // Reward ID to owned, missing or unknown.
  const open = []; // Groups with a reward not proven earned.
  let owned = 0;
  let countable = !c.cut;
  for (const g of objects(c.groups)) {
    const need = groupNeed(c, g, state, now);
    const found = new Set();
    const ids = [];
    for (const r of objects(g.rewards)) {
      if (!counted.has(r.id)) { // Counted once: one badge can be offered by two groups.
        if (!r.badge) countable = false;
        const has = claimed.has(`${c.id}/${g.id}`) ? true : rewardOwned(state, r.id, now);
        // Likely earned (tracker.js leftDrops) is not proof either way.
        const is = has === true ? 'owned' : has === false && r.badge && !left.has(g.id) ? 'missing' : 'unknown';
        counted.set(r.id, is);
        if (is === 'owned') owned++;
        else (is === 'missing' ? missing : unknown).push({ name: r.name || c.name, unknown: is === 'unknown', need });
      }
      found.add(counted.get(r.id));
      if (counted.get(r.id) !== 'owned') ids.push(r.id);
    }
    if (ids.length) open.push({ need, ids, missing: found.has('missing') });
  }
  if (!counted.size || (owned === counted.size && !c.cut)) return null;
  if (unknown.length) countable = false;
  const status = !missing.length ? 'Cannot tell if earned'
    : !countable ? 'Not all earned'
      : counted.size === 1 ? 'Not earned yet' : `${owned} of ${counted.size} owned`;
  const { perBadge, ...time } = watchLeft(c, open, now);
  return {
    kind: missing.length ? 'missing' : 'unknown',
    status,
    missing: [...missing, ...unknown].map(({ name, unknown: u, need }) => ({
      name,
      unknown: u,
      ...(perBadge && need ? { watch: lower(need.text) } : {}),
      ...(!u && need?.late && !time.late ? { late: true } : {}),
    })),
    more: !!c.more || counted.size > 1,
    ...time,
  };
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
const KIND_ORDER = ['missing', 'unseen', 'unknown'];
const byEnd = (a, b) => (a.endAt ?? Infinity) - (b.endAt ?? Infinity) || String(a.name).localeCompare(String(b.name));
// Infinity - Infinity is NaN, which falls through to the next key.
const bySlack = (a, b) => (a.slack ?? Infinity) - (b.slack ?? Infinity) || byEnd(a, b);

/**
 * The rows of "Badges not earned yet" (drops-tracker#12): badge campaigns seen on opened channels
 * (seen: storage seenBadges), and sitewide ones in the saved All Drops list. One row per campaign;
 * one whose watch badges are all proven earned is left out, even with a sub goal left. Proven: named
 * by the owned list, or its group called claimed by Twitch's channel page (claimed: storage
 * claimedGroups). kind: missing (something is proven not earned), unseen (only listed, and the list
 * names one reward per campaign, so it says nothing about which), unknown.
 * next (drops-tracker#18): the one row to go for now, first in the list: a missing badge that can
 * still be done and can gain today, least slack first. late: no missing badge in it can be done.
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
      // Not the list's own minutes: it does not say a campaign repeats (GTAVI's six days read as 1h).
      watch: '',
      late: false,
      able: false,
      slack: null,
      where: '',
      link: info ? { label: 'Details', href: info } : null,
    });
  }
  const next = out.filter((r) => r.kind === 'missing' && r.able && r.slack != null).sort(bySlack)[0];
  // slack and able stay out of the rows: slack changes with the clock, and the panel redraws on change.
  return out
    .sort((a, b) => Number(b === next) - Number(a === next)
      || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
      || (a.kind === 'missing' ? Number(a.late) - Number(b.late) || bySlack(a, b) : byEnd(a, b)))
    .map((r) => {
      const { slack, able, ...shown } = r;
      return { ...shown, next: r === next };
    });
}

/**
 * The one line said while another channel is earning, or ''. Only for a channel open in this
 * browser. Not said when that channel carries the Next campaign: with two campaigns on one channel,
 * which of them its minutes reach is not always known, and closing it could stop that badge.
 * rows: unearnedBadges().
 */
export function closeFirst(rows, state) {
  const next = objects(rows).find((r) => r.next === true);
  const session = state?.session;
  if (!next || state?.verdict?.code !== 'earning' || !session?.login || state.creditedCampaign === next.id) return '';
  const stream = objects(state.streams).find((s) => s.login === session.login);
  if (!stream || stream.campaignIds?.includes(next.id)) return '';
  return `Close ${stream.displayName || stream.login} first: Twitch counts one channel at a time.`;
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
