// Pure state machine: (previous state, observation, time) -> next state. No chrome.* here.
// Bounds: timeline <= TIMELINE_MAX entries; tabs, drops and notified ids are rebuilt from
// the current observation each poll, so they cannot outgrow what Twitch currently reports.
// The states it writes (verdict codes, causes, channel and player states) are declared in
// states.js; the map of how they move is docs/state-machines.md.
import { PLAYER_STATES, RATE_MIN_MINUTES, MAX_REWARD_GROUPS, verdictTone, TONE_COLORS } from './states.js';
import { span } from './directory.js';

export { RATE_MIN_MINUTES };

export const STALL_MS = 4 * 60000; // Credit lands about every 60s (measured); 4 misses is a real stall.
export const REWARD_HOLD_MS = 15 * 60000; // A failed reward inventory call reuses the last good answer this long.
export const REWARD_RETRY_MS = 5 * 60000; // After a failed call, a window-end re-ask waits this long.
export const DEAD_PLAYER_MS = 2 * 60000; // Every eligible player is visibly dead: no need to wait the full 4.
export const NO_STREAM_MS = 2.5 * 60000; // No eligible tab: stop saying "earning" once a tick has been missed.
export const GAP_MS = 3 * 60000; // Longer than this without good data (sleep, outage): restart the clock.
export const TIMELINE_MAX = 60;
export const RATE_WINDOW = 30;
export const SLOW_BELOW = 0.75;
export const CLAIM_WINDOW_MS = 7 * 24 * 3600000; // Twitch help: claimable up to 7 days after campaign end.
export const STREAM_SOFT_LIMIT = 2; // Reported per-IP limit; only this browser's tabs are visible to us.
const REWARDS_MAX = 2000;
const DROPS_MAX = 100;
const DIP_POLLS = 3; // A lower reading must last this many polls before it is believed.
// And this long: a channel just opened asks for a check at once, and three quick checks reading a
// stale lower number would be believed, then the real number read as credited minutes (2026-11-22).
const DIP_MS = 2 * 60000;
const FRESH_READING_MS = 5000;
const CLOSE_SETTLE_MS = 2 * 60000; // Credit lands about every 60s, so one can still arrive after leaving.
// "Stopped earning" is news when it happens; left amber with nothing to do about it, it reads as a
// fault. After this it settles to a plain idle, and stays there until something can earn again.
export const LOST_SHOWN_MS = 10 * 60000;
const LEFT_BADGES_MAX = 20; // Badge groups remembered as having left the in-progress list.

export function emptyState() {
  return {
    lastPollAt: null,
    lastOkAt: null,
    lastGainAt: null,
    resumeAt: null,
    drops: {},
    tabs: {},
    timeline: [],
    notifiedClaims: [],
    active: [],
    resting: [],
    unclaimed: [],
    streams: [],
    session: null,
    earnerTabs: [],
    closedAt: null,
    closedName: null,
    verdict: { code: 'starting' },
  };
}

function dateOr(value, fallback) {
  const t = Date.parse(value);
  return Number.isNaN(t) ? fallback : t;
}

/** An unknown status value falls back to the dates, so a rename cannot hide every drop. */
function isLive(campaign, now) {
  if (campaign.status === 'ACTIVE') return true;
  if (campaign.status === 'EXPIRED' || campaign.status === 'UPCOMING') return false;
  return now >= dateOr(campaign.startAt, -Infinity) && now < dateOr(campaign.endAt, Infinity);
}

/** Split Twitch's campaign list into drops still being earned and rewards waiting on the user. */
export function summarize(campaigns, now) {
  const active = [];
  const unclaimed = [];
  for (const c of campaigns) {
    // A date Twitch stops sending or changes the format of must not make a drop vanish.
    const campaignEnd = dateOr(c.endAt, Infinity);
    const live = isLive(c, now);
    for (const d of c.timeBasedDrops || []) {
      const self = d.self;
      const required = d.requiredMinutesWatched || 0;
      // Only an explicit false: a missing field must not turn claimed drops into "Claim" nags.
      if (!self || required <= 0 || self.isClaimed !== false) continue;
      const benefit = d.benefitEdges?.[0]?.benefit;
      const name = benefit?.name || d.name;
      const base = {
        id: d.id,
        name,
        campaignId: c.id,
        campaign: c.name,
        game: c.game?.name || c.game?.displayName || '',
        image: benefit?.imageAssetURL || c.imageURL || null,
      };
      if (self.dropInstanceID) {
        const claimBy = campaignEnd + CLAIM_WINDOW_MS;
        if (now < claimBy) {
          unclaimed.push({
            ...base,
            claimBy: Number.isFinite(claimBy) ? claimBy : null,
            campaignActive: live,
            // Twitch's inventory showed "Connect" for 13 of 13 such rewards, all with a link page
            // (2026-11-19). The flag alone is false on most campaigns, including ones earned
            // without linking, so without a link page it is not taken to mean "connect first".
            needsConnect: c.self?.isAccountConnected === false && /^https:\/\//i.test(c.accountLinkURL ?? ''),
            connectUrl: /^https:\/\//i.test(c.accountLinkURL ?? '') ? c.accountLinkURL : null,
          });
        }
        continue;
      }
      if (!live || self.hasPreconditionsMet === false) continue;
      // At or over its requirement, a running total is not today's progress: pendingDrops lists it.
      if (d.runningTotal && !(self.currentMinutesWatched < required)) continue;
      const end = dateOr(d.endAt, campaignEnd);
      if (now >= end) continue;
      // A multi-day campaign's later window has not opened yet: no minutes can land on it.
      if (now < dateOr(d.startAt, -Infinity)) continue;
      const minutes = self.currentMinutesWatched;
      if (typeof minutes !== 'number') continue;
      const remaining = Math.max(0, required - minutes);
      active.push({
        ...base,
        ...(d.unjudged ? { unjudged: true } : {}), // Twitch's numbers, never judged (rewardCampaigns).
        ...(d.held ? { held: true } : {}), // A held reward-inventory reading (rewardCampaigns).
        minutes,
        required,
        remaining,
        pct: Math.floor((Math.min(minutes, required) / required) * 100),
        endsAt: Number.isFinite(end) ? end : null,
        atRisk: remaining * 60000 > end - now,
      });
    }
  }
  return { active, unclaimed };
}

/**
 * Minutes credited over the recent minutes spent watching something that can earn. Rising is
 * not enough to call it healthy: Twitch can credit far below one minute per minute.
 */
export function creditRate(timeline) {
  const watched = timeline.filter((t) => t.w).slice(-RATE_WINDOW);
  const counted = watched.reduce((sum, t) => sum + (t.d ?? (t.g ? 1 : 0)), 0);
  return { watched: watched.length, counted: Math.min(counted, watched.length) };
}

/**
 * Minutes Twitch is crediting where they cannot help, or null. Measured 2026-11-09: Twitch kept
 * counting a channel badge already earned (363 of 360) and kept that channel credited ahead of an
 * open tab with 290 minutes left to earn; then it credited a drop needing 179 minutes with about
 * 95 left in its campaign. Twitch credits one channel at a time and nothing documented lets a
 * viewer choose, so the only remedy is stopping the stream it picked, which must be open here.
 */
/**
 * The session's drop when the reward inventory says it repeats and its current window is not known
 * to be done: its session minutes are a running total, so "over the requirement" proves nothing.
 * Done means a window still open at its requirement, or every repeat granted. Seen 2026-11-20: the
 * inventory read 60 of 60 at 17:49:43 with the window ending 17:50:15; Twitch then counted the next
 * window (2 of 60) while the running total 637 read as "already earned" for minutes on end.
 */
export function openWindowUnknown(session, rewardInv, now, drops = {}) {
  if (!session?.dropId) return [];
  const g = (rewardInv?.groups || []).find((x) => x.id === session.dropId && x.repeatTimes);
  // No reading for it (a failed ask, or the held answer expired): its own `:total` mark says its
  // session minutes have been a running total, so they still prove nothing (review, 2026-11-20).
  if (!g) return drops?.[`${session.dropId}:total`] && !(rewardInv?.groups || []).some((x) => x.id === session.dropId) ? [session.dropId] : [];
  const allGranted = g.grants != null && g.grants >= g.repeatTimes;
  const doneToday = g.windowEnd != null && now < g.windowEnd && typeof g.minutes === 'number' && g.minutes >= g.required;
  // Twitch saying the next window opens later: minutes until then really count for nothing.
  const waiting = g.nextEligibleAt != null && now < g.nextEligibleAt;
  return allGranted || doneToday || waiting ? [] : [g.id];
}

/**
 * Whether this poll should ask the reward inventory. At least every REWARD_HOLD_MS, and also once
 * a window it last read has ended since: the 15-minute hold kept a closed window's 60 of 60 for
 * 14 minutes after Twitch had started the next one (2026-11-20). One extra call per window.
 */
export function rewardsDue(prev, now) {
  const at = prev?.rewardCheck?.at;
  if (!at || now - at >= REWARD_HOLD_MS) return true;
  // After a failed ask, at most every REWARD_RETRY_MS: it fails on about half of real calls, and
  // retrying every poll for the held answer's 15 minutes is not "once" (review, 2026-11-20).
  if (prev.rewardCheck.ok === false && now - at < REWARD_RETRY_MS) return false;
  const read = prev?.rewardInv?.at ?? at;
  return (prev?.rewardInv?.groups || []).some((g) => g.windowEnd != null && g.windowEnd > read && g.windowEnd <= now);
}

/** When the session's repeating drop can start again, from the reward inventory: Twitch's own time, else the window's end. */
function nextStart(session, rewardInv, now) {
  const g = (rewardInv?.groups || []).find((x) => x.id === session?.dropId && x.repeatTimes);
  const t = g ? g.nextEligibleAt ?? g.windowEnd : null;
  return t != null && t > now ? t : null;
}

export function wastedCredit(session, active, streams, risen, running, names = new Map(), opens = null) {
  // Only a drop seen rising this poll. The session can keep naming a drop after it was earned
  // while the campaign's next drop does the rising, and that is ordinary earning.
  if (!session?.dropId || !risen?.has(session.dropId) || !streams.some((st) => st.login === session.login)) return null;
  // A running total over its requirement says nothing about today's drop.
  if (running?.has(session.dropId)) return null;
  // Minutes rising on another drop of the credited channel are being used, whatever the session
  // names (2026-11-19: it named GTAVI's DVD drop, done for the day, while the channel's badge rose).
  const channelCampaigns = streams.find((st) => st.login === session.login)?.campaignIds || [];
  // A held reading (rewardCampaigns) cannot show its rise this poll, so it may be the one rising:
  // without this, every failed reward-inventory call read "already earned" while the badge rose
  // (audit, 2026-11-22).
  if (active.some((d) => d.id !== session.dropId && (risen.has(d.id) || d.held) && channelCampaigns.includes(d.campaignId))) return null;
  const drop = active.find((d) => d.id === session.dropId);
  // Over the requirement, not at it: the minute that reaches it is the one that earns the drop
  // (seen 2026-11-14, 30 of 30 flagged as waste for one poll). A badge credited on reads 362 of 360.
  const earned = !drop && session.required > 0 && session.minutes > session.required;
  if (!earned && !drop?.atRisk) return null;
  const channel = session.displayName || session.login;
  // Named by the session, or the channel's own badge Twitch is still crediting past its
  // requirement while the session names a reward done for the day (all-views check, 2026-11-19).
  const channelBadges = (streams.find((st) => st.login === session.login)?.badges || []).flatMap((b) => b.drops || []);
  const badge = streams.flatMap((st) => st.badges || []).flatMap((b) => b.drops || []).find((d) => d.id === session.dropId)
    || channelBadges.find((d) => risen.has(d.id) && d.required > 0 && (d.minutes ?? 0) > d.required);
  const name = earned ? badge?.name || names.get(session.dropId) || 'drop' : drop.name;
  // The next start belongs to the session's drop. A badge past its requirement named instead of it
  // does not repeat, so "the next one can start" would be untrue for it.
  const ownDrop = !badge || badge.id === session.dropId;
  return wastedView({ reason: earned ? 'earned' : 'too_late', channel, name, opens: opens != null && earned && ownDrop ? opens : null }, session, active, streams);
}

/**
 * Another open tab with a drop it can still finish. Twitch decides which one gets the minutes.
 * Asked every poll, quiet ones included: a closed second tab must not leave the amber behind.
 */
function altTab(session, active, streams) {
  for (const st of streams) {
    if (st.login === session?.login || st.channelState !== 'eligible') continue;
    const d = active.find((x) => st.campaignIds?.includes(x.campaignId) && x.remaining > 0 && !x.atRisk);
    if (d) return { name: st.displayName || st.login, game: d.game || d.campaign };
  }
  return null;
}

/**
 * The wasted judgement as shown. Amber only when there is something to do (Tyler, 2026-11-20):
 * another open tab can earn, or the drop cannot finish in time. Already earned with nothing else
 * open is done, said plainly in grey, with the next start when Twitch's reward inventory gives one.
 */
export function wastedView(w, session, active, streams) {
  const alt = altTab(session, active, streams);
  const fix = alt ? ` ${alt.name} can earn ${alt.game}: close or pause ${w.channel}.` : '';
  const at = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  let message;
  if (w.reason === 'too_late') message = `Twitch is crediting ${w.channel}, but ${w.name} cannot finish before its campaign ends.${fix}`;
  else if (alt) message = `${w.channel}'s ${w.name} is already earned, but Twitch is still crediting it, so these minutes do nothing.${fix}`;
  else if (w.opens != null) message = `${w.name} is earned for today. The next one can start at ${at(w.opens)}.`;
  else message = `${w.name} is already earned, and nothing else open can earn right now.`;
  return { reason: w.reason, channel: w.channel, name: w.name, opens: w.opens ?? null, actionable: !!alt, message };
}

function classifyPlayer(stream, rec, now) {
  const { tab, player } = stream;
  if (tab?.discarded || tab?.frozen) return { state: 'asleep' };
  if (!player || !player.hasVideo) return { state: 'no_video' };
  if (player.ended) return { state: 'ended' };
  if (player.paused) return { state: 'paused' };
  const hasPrior = rec && rec.lastTime != null;
  if (hasPrior && now - rec.lastTimeAt < FRESH_READING_MS) {
    return { state: rec.playerState || 'playing', keepReading: true };
  }
  if (hasPrior && player.currentTime === rec.lastTime) return { state: 'frozen' };
  if (!hasPrior && player.readyState < 2) return { state: 'frozen' };
  return { state: 'playing' };
}

// A badge channel none of whose timed badges can finish before its campaign ends. Minutes Twitch
// never reported count as none, so the caller's message has to allow for progress it did not see.
// Seen 2026-11-15: a 180-minute badge with 70 minutes left read only "you may already have earned it".
function badgeTooLate(stream, now) {
  let worst = null;
  for (const b of stream.badges || []) {
    const timed = (b.drops || []).filter((d) => d.required > 0);
    if (!timed.length) continue;
    const end = Date.parse(b.endAt);
    if (Number.isNaN(end)) return null;
    const need = Math.min(...timed.map((d) => d.required - (d.minutes ?? 0)));
    if (need * 60000 <= end - now) return null;
    worst ??= { need, left: Math.max(0, Math.floor((end - now) / 60000)) };
  }
  return worst;
}

function classifyChannel(stream, active, inventoryIds, rewards, blocked, pending, rewardIds = new Set(), leftNear = null) {
  if (!stream.login) return 'not_channel';
  // No entry at all means it was not looked up (past the channel limit), not that it is offline.
  if (!stream.channel || stream.channel.unknown) return 'unknown';
  if (!stream.channel.live) return 'offline';
  const campaigns = stream.channel.campaigns || [];
  if (!campaigns.length) return stream.channel.subOnly ? 'sub_only' : 'no_drops';
  const owned = new Set(rewards.ids);
  let unstarted = false;
  let badgeUnseen = false;
  let badgeLeft = false;
  let isBlocked = false;
  let reward = false;
  for (const c of campaigns) {
    // A channel badge every timed drop of which left Twitch's in-progress list at its requirement.
    const left = !!leftNear && c.channelOwned && c.watchDrops?.length > 0 && c.watchDrops.every((d) => leftNear.has(d.id));
    if (active.some((d) => d.campaignId === c.id && d.remaining > 0 && !d.unjudged)) return 'eligible';
    // A reward drop earned for today waits for its next window: good news, and Twitch's numbers,
    // so the quiet reward state rather than a "not counting yet" warning every day.
    if (blocked.has(c.id) && rewardIds.has(c.id)) {
      reward = true;
      continue;
    }
    if (blocked.has(c.id)) isBlocked = true;
    // Twitch's numbers that are shown but never judged: a reward inventory reading or a session
    // running total. Flat there was the normal reading while Twitch counted (2026-11-18).
    if (active.some((d) => d.campaignId === c.id && d.remaining > 0 && d.unjudged) || pending.get(c.id)?.runningTotal) {
      reward = true;
      continue;
    }
    // Read from the session with a drop it reports nothing for: the same as never started.
    if (pending.has(c.id)) {
      if (left) badgeLeft = true;
      else if (c.channelOwned) badgeUnseen = true;
      else unstarted = true;
      continue;
    }
    if (inventoryIds.has(c.id)) continue;
    const allOwned = c.benefitIds?.length > 0 && c.benefitIds.every((id) => owned.has(id));
    if (allOwned) continue;
    if (left) badgeLeft = true;
    else if (c.channelOwned) badgeUnseen = true;
    else unstarted = true;
  }
  // Not in the inventory could mean about to start, needs a linked account, or a finished
  // campaign Twitch still lists. None of those is evidence of a hang, so it never reads as one.
  if (isBlocked) return 'blocked';
  if (reward) return 'reward';
  if (unstarted) return 'unstarted';
  // A timer badge with no session: Twitch is not reporting its minutes. There is no game account
  // to link, and what a session looks like once a badge is earned has not been seen, so this may
  // mean already earned. Not knowing is still worth saying. One that left the in-progress list at
  // its requirement is badge_left: no warning, the evidence said instead (2026-11-20).
  if (badgeUnseen) return 'badge_unseen';
  return badgeLeft ? 'badge_left' : 'finished';
}

/**
 * Campaigns a channel offers that Inventory leaves out, read from Twitch's reward inventory
 * (parseRewardInventory in twitch.js), joined on campaign ID and drop ID. Shaped like Inventory
 * campaigns, with every drop marked `unjudged`: shown with Twitch's numbers, but a flat reading
 * is never a hang, because on 2026-11-18 the tracker saw about 15 of the 250 minutes Twitch counted
 * on such a campaign. A repeating drop reads its 24-hour window: 0 once the window has ended,
 * "opens <time>" once today's is earned, done when every repeat is granted. A badge the session
 * answers for keeps the session, which has been measured. Drops it does not list are left out:
 * missing is unknown. Bound: the channels' own campaigns.
 */
/**
 * Badge campaigns Twitch's reward inventory has in progress that no open channel lists. Most are
 * from channels watched before, so being here means nothing; minutes rising here means an open
 * channel is earning a badge this tracker cannot see, which is Twitch having moved where it lists
 * them (a GTAVI channel, 2026-11-19). Only a fresh answer moves the marks. Bound: what the answer
 * holds (MAX_REWARD_GROUPS), since anything no longer in it is dropped.
 */
export function unplacedBadges(prev, groups, placed, now) {
  if (!Array.isArray(groups)) return Array.isArray(prev) ? prev : [];
  const old = new Map((Array.isArray(prev) ? prev : []).map((u) => [`${u.campaignId}/${u.id}`, u]));
  return groups
    .filter((g) => g.badge && !g.earned && g.status !== 'CLAIMED' && typeof g.minutes === 'number' && !placed.has(g.campaignId))
    .map((g) => {
      const o = old.get(`${g.campaignId}/${g.id}`);
      const first = o ? o.first : g.minutes;
      return {
        campaignId: g.campaignId,
        id: g.id,
        required: g.required,
        minutes: g.minutes,
        first,
        firstAt: o ? o.firstAt : now,
        at: now,
        rising: g.minutes > first,
      };
    });
}

/**
 * Badge groups seen leaving Twitch's in-progress reward list before reaching their requirement.
 * On 2026-11-20 a 180-minute badge read 179 at 08:14 UTC; at the next poll its group was gone
 * (every other group still listed) and the session's minutes moved to another drop: earned, by
 * every sign but a reading of 180. Only a seen transition counts: in the last good answer, absent
 * from this poll's fresh one, which is not cut short. A group back in the list drops its entry.
 * Bound: LEFT_BADGES_MAX, newest kept.
 */
export function leftBadges(prev, before, groups, now) {
  let out = Array.isArray(prev) ? prev : [];
  if (!Array.isArray(groups) || groups.length >= MAX_REWARD_GROUPS) return out;
  const listed = new Set(groups.map((g) => `${g.campaignId}/${g.id}`));
  out = out.filter((x) => !listed.has(`${x.campaignId}/${x.id}`));
  for (const g of before?.groups || []) {
    if (!g.badge || g.earned || g.status === 'CLAIMED' || typeof g.minutes !== 'number' || !(g.required > 0)) continue;
    const key = `${g.campaignId}/${g.id}`;
    if (listed.has(key) || g.minutes >= g.required || out.some((x) => `${x.campaignId}/${x.id}` === key)) continue;
    out = [...out, { campaignId: g.campaignId, id: g.id, minutes: g.minutes, required: g.required, readAt: before.at, at: now }];
  }
  return out.slice(-LEFT_BADGES_MAX);
}

/** Within this many minutes of its requirement, a badge leaving the list reads as likely earned. */
export const LEFT_NEAR_MINUTES = 2;

/** Credited drops the lists did not place, kept for Copy debug info (update, creditUnlisted). */
export const CREDIT_UNLISTED_MAX = 10;

/** How long a drop placed on a channel by its minutes stays there with no further rise (update). */
export const PLACED_KEEP_MS = 30 * 60000;

function rewardCampaigns(streams, inventoryIds, groups, sessions, now, fresh = false) {
  const out = new Map();
  if (!groups?.length) return [];
  for (const st of streams) {
    for (const c of st.channel?.campaigns || []) {
      if (inventoryIds.has(c.id) || out.has(c.id)) continue;
      const matched = (c.watchDrops || []).map((d) => [d, groups.find((g) => g.campaignId === c.id && g.id === d.id)]).filter(([, g]) => g);
      if (!matched.length) continue;
      const repeats = matched.some(([, g]) => g.repeatTimes);
      if (!repeats && (sessions || []).some((x) => c.watchDrops.some((d) => d.id === x.dropId) && typeof x.minutes === 'number')) continue;
      out.set(c.id, {
        id: c.id,
        name: c.name,
        endAt: c.endAt,
        imageURL: c.image,
        game: { name: c.channelOwned ? st.channel.displayName || st.login : c.game || c.name },
        fromRewards: true,
        timeBasedDrops: matched.map(([d, g]) => {
          const base = {
            id: d.id,
            name: d.name,
            requiredMinutesWatched: d.required,
            endAt: d.endAt,
            benefitEdges: [{ benefit: { name: d.name, imageAssetURL: d.image } }],
            // A channel's own badge is judged like any drop when this poll read it: its minutes
            // here rose one a minute (2026-11-19, 69 to 106 of 180), and leaving it unjudged hid a
            // 10-minute stall behind "today's reward drop is earned". Repeating rewards stay unjudged.
            // A held reading (this poll's call failed, which is about half of them) stays judged so
            // the channel keeps its state and hang clock, marked held: it cannot raise a stall by
            // itself. Unjudged, it turned the channel "reward" every other poll and reset the clock,
            // so a real stall never warned (audit, 2026-11-22).
            unjudged: !(c.channelOwned && !g.repeatTimes),
            ...(c.channelOwned && !g.repeatTimes && !fresh ? { held: true } : {}),
          };
          if (g.repeatTimes) {
            const done = g.grants != null && g.grants >= g.repeatTimes;
            const open = g.windowEnd != null && now < g.windowEnd;
            const today = open && g.minutes >= d.required;
            // Twitch's own "next eligible" when it gives one, else the window's end (inferred).
            const opens = g.nextEligibleAt ?? g.windowEnd;
            return {
              ...base,
              window: true, // Its minutes are the window's; the session's are a running total.
              // Today's earned: the next one can start when Twitch says.
              startAt: today ? new Date(opens).toISOString() : d.startAt,
              // Kept for My Drops, which shows it done with a timer to the next day (restingDrops).
              ...(today ? { restUntil: opens } : {}),
              self: { currentMinutesWatched: today || !open ? 0 : g.minutes, isClaimed: done, hasPreconditionsMet: g.preconditionsMet },
            };
          }
          const claimed = g.status === 'CLAIMED';
          return {
            ...base,
            startAt: d.startAt,
            self: {
              currentMinutesWatched: g.minutes,
              isClaimed: claimed,
              dropInstanceID: !claimed && (g.status === 'CLAIMABLE' || g.earned) ? 'reward' : null,
              hasPreconditionsMet: g.preconditionsMet,
            },
          };
        }),
      });
    }
  }
  return [...out.values()];
}

/**
 * Campaigns a channel offers that Inventory leaves out, read from the session instead. A channel's
 * own badge is never in Inventory. A game campaign can be missing too while Twitch credits it
 * (2026-11-12, a Streamer Awards Minecraft drop: Twitch's page showed it rising while this said
 * "may need your game account linked" and drew those minutes dead). Shaped like an Inventory
 * campaign, so everything downstream treats it the same: rising minutes are still the only proof.
 * The campaign's other watch drops come along with no minutes (null, not 0: Twitch reports none),
 * unless owned or already seen at their requirement. Without them a campaign whose named drop was
 * done read as finished while Twitch's page offered the next one (2026-11-19, 250 of 60 named,
 * a second 60-minute drop at 0 left out).
 */
function sessionCampaigns(streams, inventoryIds, sessions, rewards, previousDrops, now) {
  const out = new Map();
  const owned = new Set(rewards.ids);
  for (const st of streams) {
    for (const c of st.channel?.campaigns || []) {
      if (inventoryIds.has(c.id) || out.has(c.id)) continue;
      if (c.benefitIds?.length > 0 && c.benefitIds.every((id) => owned.has(id))) continue;
      const session = (sessions || []).find((x) => c.watchDrops?.some((d) => d.id === x.dropId));
      if (!session || typeof session.minutes !== 'number') continue;
      // A game campaign the session names at 0 has not started counting: that is still the
      // unstarted case (maybe linking), and it must not become a hang. Minutes on it mean it has.
      if (!c.channelOwned && !(session.minutes > 0)) continue;
      const done = (d) => (d.benefitIds?.length > 0 && d.benefitIds.every((id) => owned.has(id)))
        || previousDrops?.[d.id]?.peak >= d.required;
      // A drop whose window has closed can no longer count, and left in it would stop
      // blockedCampaigns before it reaches a later window.
      const closed = (d) => now >= dateOr(d.endAt, dateOr(c.endAt, Infinity));
      // A reward campaign: only the drop the session names. Its other watch drop was the final
      // reward, listed as 60 minutes but needing all 12 of the campaign's rewards (2026-11-19).
      const drops = c.watchDrops.filter((d) => d.id === session.dropId || (!c.rewardCampaign && !(done(d) || closed(d))));
      out.set(c.id, {
        id: c.id,
        name: c.name,
        endAt: c.endAt,
        imageURL: c.image,
        game: { name: c.channelOwned ? st.channel.displayName || st.login : c.game || c.name },
        timeBasedDrops: drops.map((d) => ({
          id: d.id,
          name: d.name,
          requiredMinutesWatched: d.required,
          startAt: d.startAt,
          endAt: d.endAt,
          benefitEdges: [{ benefit: { name: d.name, imageAssetURL: d.image } }],
          // On a reward campaign the session can count more than the drop: 250 of 60 on day two of
          // a drop that repeats in 24-hour windows (Twitch's reward inventory showed the window and
          // one grant; captured 2026-11-19). At or over its requirement there, the reading is not
          // this drop's progress: at exactly 60 it read "Watch time reached" on a later day. Under
          // it, it is shown, but never judged either: on day one (2026-11-18) every reading was
          // under 60 and the tracker saw about 15 of the 250 minutes Twitch counted, called a hang
          // and reloaded a tab. Kept under its own mark (`:total`), rising is still real credit.
          runningTotal: c.rewardCampaign && d.id === session.dropId,
          unjudged: c.rewardCampaign && d.id === session.dropId,
          self: { currentMinutesWatched: d.id === session.dropId ? session.minutes : null, isClaimed: false, hasPreconditionsMet: true },
        })),
      });
    }
  }
  return [...out.values()];
}

/**
 * Campaigns in Inventory whose next drop cannot count yet, by campaign id. Summarize leaves those
 * drops out of the active list, which alone would make the campaign read as finished.
 */
function blockedCampaigns(campaigns, now) {
  const out = new Map();
  for (const c of campaigns) {
    if (!isLive(c, now)) continue;
    for (const d of c.timeBasedDrops || []) {
      const self = d.self;
      if (!self || !(d.requiredMinutesWatched > 0) || self.isClaimed !== false || self.dropInstanceID) continue;
      if (typeof self.currentMinutesWatched === 'number' && self.currentMinutesWatched >= d.requiredMinutesWatched) continue;
      const opens = dateOr(d.startAt, -Infinity);
      if (now < opens) {
        if (!out.has(c.id)) out.set(c.id, { opens });
      } else if (self.hasPreconditionsMet === false) {
        if (!out.has(c.id)) out.set(c.id, { opens: null });
      } else {
        out.delete(c.id); // Another drop in it can earn right now.
        break;
      }
    }
  }
  return out;
}

/**
 * Drops of session campaigns open now that Twitch reports no minutes for. Not counting yet, never
 * a hang: there is no reading that could have risen. Kept apart from the active list, where
 * "minutes left" would make the channel eligible. Bound: the watch drops of the open channels.
 */
function pendingDrops(fromSessions, now) {
  const out = [];
  for (const c of fromSessions) {
    if (!isLive(c, now)) continue;
    for (const d of c.timeBasedDrops) {
      // No minutes at all, or a running total at or over the requirement (shown as unknown).
      const unknown = d.self.currentMinutesWatched == null || (d.runningTotal && !(d.self.currentMinutesWatched < d.requiredMinutesWatched));
      if (!unknown || now < dateOr(d.startAt, -Infinity)) continue;
      const end = dateOr(d.endAt, dateOr(c.endAt, Infinity));
      out.push({
        id: d.id,
        name: d.name,
        campaignId: c.id,
        campaign: c.name,
        game: c.game?.name || '',
        image: d.benefitEdges?.[0]?.benefit?.imageAssetURL || c.imageURL || null,
        minutes: null,
        required: d.requiredMinutesWatched,
        endsAt: Number.isFinite(end) ? end : null,
        runningTotal: d.runningTotal === true,
      });
    }
  }
  return out;
}

/**
 * Repeating reward drops done for today, with when the next day opens. Summarize leaves them out
 * (their next start is ahead), so without this the drop vanished from My Drops once earned for
 * the day, while Twitch's own panel keeps it as "Day complete" with "Day opens in 4h" (2026-11-22).
 * Kept apart from the active list, where it would count as progress. Bound: the watch drops of
 * the open channels' reward campaigns.
 */
function restingDrops(fromRewards, now) {
  const out = [];
  for (const c of fromRewards) {
    if (!isLive(c, now)) continue;
    for (const d of c.timeBasedDrops) {
      // Every repeat granted is done for good, not resting; a time already past is open again.
      if (d.restUntil == null || d.self.isClaimed || !(now < d.restUntil)) continue;
      const end = dateOr(d.endAt, dateOr(c.endAt, Infinity));
      // A next day after the campaign ends never comes.
      if (d.restUntil >= end) continue;
      out.push({
        id: d.id,
        name: d.name,
        campaignId: c.id,
        campaign: c.name,
        game: c.game?.name || '',
        image: d.benefitEdges?.[0]?.benefit?.imageAssetURL || c.imageURL || null,
        required: d.requiredMinutesWatched,
        opensAt: d.restUntil,
      });
    }
  }
  return out;
}

/** Remember owned rewards across polls: the field fails on about half of real calls. */
function mergeRewards(previous, seen) {
  const before = { ids: [], ...previous };
  if (!seen?.ids) return before;
  const ids = seen.complete ? seen.ids : [...new Set([...before.ids, ...seen.ids])];
  return { ids: ids.slice(0, REWARDS_MAX) };
}

/** The drop a minute mark belongs to: a running total is kept as `<drop id>:total`. */
const dropOf = (key) => (key.endsWith(':total') ? key.slice(0, -':total'.length) : key);

/**
 * Highest minutes seen per drop. A read that dips and comes back is not progress, or a value
 * flapping 65, 64, 65 would look like earning for ever. A drop missing from one answer keeps
 * its mark for the same reason. Only a dip that lasts is believed: multi-day campaigns really
 * do discard minutes when a day's window closes. A drop not seen for longer than GAP_MS takes its
 * next reading as a new baseline: those minutes were earned at some point nobody saw, not now.
 * Bound: DROPS_MAX marks, or as many as Twitch currently reports if that is more. Dropping a mark
 * still being reported would make it look new, and so a gain, on every poll.
 * A running total's mark is `<drop id>:total`; it rising still marks the drop itself as risen.
 */
function trackMinutes(previous, campaigns, sessions, firstGoodPoll, sessionOnly, now) {
  const peaks = {};
  for (const [id, rec] of Object.entries(previous ?? {})) {
    peaks[id] = typeof rec === 'number' ? { peak: rec, low: 0 } : rec; // Older versions stored a number.
  }
  let added = 0;
  const risen = new Set();
  const current = new Set();
  const see = (id, minutes) => {
    const rec = peaks[id];
    current.add(id);
    if (rec) {
      const stale = rec.at != null && now - rec.at > GAP_MS;
      rec.at = now;
      if (stale) {
        rec.peak = minutes;
        rec.low = 0;
        return;
      }
    }
    if (!rec) {
      // Inventory only lists a drop once Twitch has started it. A session already answers
      // before anyone watches, so its first reading is only ever a baseline.
      const appeared = !firstGoodPoll && minutes > 0 && !sessionOnly?.has(id);
      if (appeared) {
        added = Math.max(added, 1);
        risen.add(dropOf(id));
      }
      peaks[id] = { peak: minutes, low: 0, at: now };
    } else if (minutes > rec.peak) {
      added = Math.max(added, minutes - rec.peak); // Drops in a campaign tick together: largest, not sum.
      risen.add(dropOf(id));
      rec.peak = minutes;
      rec.low = 0;
    } else if (minutes < rec.peak) {
      rec.low += 1;
      // A state saved mid-dip by an older version has no lowAt: its clock starts now.
      if (rec.low === 1 || rec.lowAt == null) rec.lowAt = now;
      if (rec.low >= DIP_POLLS && now - rec.lowAt >= DIP_MS) {
        rec.peak = minutes;
        rec.low = 0;
        delete rec.lowAt;
      }
    } else {
      rec.low = 0;
      delete rec.lowAt;
    }
  };
  for (const c of campaigns) {
    for (const d of c.timeBasedDrops || []) {
      // A running total is kept under its own key: the reward inventory reports the same drop's
      // window (0 to 60) and the session its total (250), and a poll falling back from one to the
      // other must not read as 190 minutes credited.
      if (typeof d.self?.currentMinutesWatched === 'number') see(d.runningTotal ? `${d.id}:total` : d.id, d.self.currentMinutesWatched);
    }
  }
  // A second source: if Inventory were ever cached, the session could still show minutes landing.
  // Only a session reading it has not given before counts. If the two simply disagree, Inventory's
  // dip would lower the mark every few polls and the same reading would look like a gain each time.
  // A drop whose reading here is a reward window: the session's minutes for it are a running total,
  // a different number (250 beside 3), so they go to its `:total` mark, never to the window's.
  // A running total read from the session itself goes there too: an old window mark under the
  // drop's own ID would otherwise take the 250 as minutes credited.
  const windowed = new Set(campaigns.flatMap((c) => (c.timeBasedDrops || []).filter((d) => d.window).map((d) => d.id)));
  const totals = new Set(campaigns.flatMap((c) => (c.timeBasedDrops || []).filter((d) => d.window || d.runningTotal).map((d) => d.id)));
  for (const x of sessions || []) {
    // A running total stays a running total once its campaign leaves the channel's list: under the
    // drop's own ID it met the window's mark of 60 and counted 393 minutes in one poll (2026-11-20).
    const key = totals.has(x.dropId) || peaks[`${x.dropId}:total`] ? `${x.dropId}:total` : x.dropId;
    if (windowed.has(x.dropId) && !peaks[key] && typeof x.minutes === 'number') {
      peaks[key] = { peak: x.minutes, low: 0, at: now, session: x.minutes }; // A baseline, never a gain.
      current.add(key);
      continue;
    }
    const rec = peaks[key];
    if (!rec || typeof x.minutes !== 'number') continue;
    const fresh = rec.session == null || x.minutes > rec.session;
    rec.session = Math.max(rec.session ?? x.minutes, x.minutes);
    if (fresh && !firstGoodPoll && x.minutes > rec.peak) see(key, x.minutes);
  }
  let excess = Object.keys(peaks).length - DROPS_MAX;
  for (const id of Object.keys(peaks)) {
    if (excess <= 0) break;
    if (current.has(id)) continue;
    delete peaks[id];
    excess -= 1;
  }
  return { peaks, added, risen };
}

function diagnose(candidates, streams, active, unclaimed) {
  const playingCount = streams.filter((s) => s.playerState === 'playing').length;
  const named = (s) => s.displayName || s.login;
  const notPlaying = candidates.filter((s) => s.playerState !== 'playing');
  if (notPlaying.length === candidates.length) {
    const s = candidates[0];
    return { cause: s.playerState, message: PLAYER_STATES[s.playerState].stall(named(s)), tabId: s.tabId };
  }
  const playing = candidates.find((s) => s.playerState === 'playing');
  // Only when nothing else in that campaign has started. Drops in a campaign tick together, so a
  // later drop with minutes is earning regardless of the claim (seen 2026-11-09: a claim waiting
  // while the next drops rose), and blaming the claim hid a second stream and blocked auto-reload.
  const blocked = unclaimed.find((u) => {
    const rest = active.filter((d) => d.campaignId === u.campaignId);
    return rest.length > 0 && rest.every((d) => !d.minutes);
  });
  if (blocked) {
    return {
      cause: 'claim_first',
      message: `${blocked.name} is earned but unclaimed. The next drop in that campaign may not start until you claim it.`,
      tabId: playing.tabId,
    };
  }
  if (playingCount > STREAM_SOFT_LIMIT) {
    return {
      cause: 'too_many',
      message: `${playingCount} streams are playing here. Twitch reportedly stops counting above ${STREAM_SOFT_LIMIT} per IP. Close the extras.`,
      tabId: playing.tabId,
    };
  }
  // Measured 2026-11-09: with a second stream playing, on the same channel or another one, Twitch
  // stopped counting entirely, and closing it brought minutes back within about 2 min. Reloading
  // the earning tab would not remove the cause, so this is not a reloadable cause.
  // (docs/twitch-drops-facts.md, "Measured live"). It conflicts with one 2026-11-06 run where two
  // streams still earned, so the message says what is happening, not that the second one is the
  // cause. Kept to two short sentences (Tyler, 2026-11-22: the "in testing" one was noise).
  const other = streams.find((s) => s.playerState === 'playing' && s.tabId !== playing.tabId);
  if (other) {
    // A playing tab that is not a channel, such as the front page's autoplay, has no name.
    const message = other.login && other.login === playing.login
      ? `${named(playing)} stopped earning while playing in two tabs. Close one of them.`
      : named(other)
        ? `${named(playing)} stopped earning while ${named(other)} is also playing. Close or pause ${named(other)}.`
        : `${named(playing)} stopped earning while another Twitch tab is playing video. Close or pause that tab.`;
    return { cause: 'second_stream', message, tabId: playing.tabId, otherTabId: other.tabId };
  }
  return {
    cause: 'uncounted',
    message: `${named(playing)} stopped earning. Reload the tab if it stays stuck.`,
    tabId: playing.tabId,
  };
}

/**
 * obs: { error?: {kind,message} } or
 *      { campaigns, rewards: {ids, complete}, session, streams: [{tabId, login, channel, tab, player}] }
 */
export function update(prev, obs, now) {
  // Over the empty state, so state saved by an older version can never crash a poll.
  const s = { ...emptyState(), ...(prev ? structuredClone(prev) : {}) };
  if (!Array.isArray(s.timeline)) s.timeline = [];
  if (!s.verdict?.code) s.verdict = { code: 'starting' };
  s.lastPollAt = now;

  if (obs.error) {
    // Unknown is not stalled: keep the last good data and say what we cannot see.
    const code = obs.error.kind === 'auth' ? 'signed_out' : obs.error.kind === 'api_changed' ? 'api_changed' : 'error';
    s.verdict = { code, message: obs.error.message };
    return s;
  }

  if (s.lastOkAt != null && now - s.lastOkAt > GAP_MS) s.resumeAt = now;
  const firstGoodPoll = s.lastOkAt == null;
  if (firstGoodPoll) s.resumeAt = now;
  s.lastOkAt = now;

  s.rewards = mergeRewards(s.rewards, obs.rewards);
  // Twitch's reward inventory: this poll's answer, else the last good one for REWARD_HOLD_MS, so
  // one failed call (Inventory's reward fields fail on about half of real calls) does not flip a
  // channel between two sources and re-fire its notification. undefined: not asked this poll.
  const held = prev?.rewardInv && now - prev.rewardInv.at < REWARD_HOLD_MS ? prev.rewardInv : null;
  s.rewardInv = Array.isArray(obs.rewardGroups) ? { at: now, groups: obs.rewardGroups } : held;
  s.rewardCheck = obs.rewardGroups === undefined ? (prev?.rewardCheck ?? null)
    : { at: now, ok: Array.isArray(obs.rewardGroups), groups: Array.isArray(obs.rewardGroups) ? obs.rewardGroups.length : null };
  const inventoryIds0 = new Set(obs.campaigns.map((c) => c.id));
  const placed = new Set([
    ...inventoryIds0,
    ...(obs.streams || []).flatMap((st) => [...(st.channel?.campaigns || []), ...(st.channel?.badges || [])].map((c) => c.id)),
  ]);
  // A channel whose list (or badge list) could not be read would make its own badge look
  // unplaced: hold the marks.
  const blind = (obs.streams || []).some((st) => st.channel?.unknown || st.channel?.badgeLookupFailed);
  s.unplacedBadges = unplacedBadges(prev?.unplacedBadges, blind ? undefined : obs.rewardGroups, placed, now);
  s.leftBadges = leftBadges(prev?.leftBadges, prev?.rewardInv, obs.rewardGroups, now);
  const leftNear = new Set(s.leftBadges.filter((x) => x.required - x.minutes <= LEFT_NEAR_MINUTES).map((x) => x.id));
  // Fresh: answered this poll. A held answer is up to REWARD_HOLD_MS old, so a badge read from it
  // would look flat and must not be judged.
  const fromRewards = rewardCampaigns(obs.streams || [], inventoryIds0, s.rewardInv?.groups, obs.sessions, now, Array.isArray(obs.rewardGroups));
  const fromSessions = sessionCampaigns(obs.streams || [], new Set([...inventoryIds0, ...fromRewards.map((c) => c.id)]), obs.sessions, s.rewards, s.drops, now);
  const allCampaigns = [...obs.campaigns, ...fromRewards, ...fromSessions];
  const { active, unclaimed } = summarize(allCampaigns, now);
  // Session campaigns too: a drop of theirs whose window has not opened is "opens <date>".
  const blocked = blockedCampaigns(allCampaigns, now);
  s.pending = pendingDrops(fromSessions, now);
  s.resting = restingDrops(fromRewards, now);
  const pending = new Map();
  for (const d of s.pending) if (!pending.has(d.campaignId)) pending.set(d.campaignId, d);
  const known = obs.sessions || (obs.session ? [obs.session] : []);

  // First sight of a drop is a baseline, unless it appeared with minutes on a later poll,
  // which means Twitch just started it for us.
  // Reward inventory readings too: a campaign is only asked about once its channel is open, so its
  // first reading is old progress, not Twitch starting it.
  const sessionOnly = new Set([...fromSessions, ...fromRewards].flatMap((c) => c.timeBasedDrops.flatMap((d) => [d.id, `${d.id}:total`])));
  const { peaks, added, risen } = trackMinutes(s.drops, allCampaigns, known, firstGoodPoll, sessionOnly, now);
  s.drops = peaks;
  // Each mark keeps its drop's name, so a warning can still name a drop whose campaign has left
  // the channel's list while Twitch credits it ("Foxtrot's drop", 2026-11-20). Bound: the marks.
  for (const c of allCampaigns) {
    for (const d of c.timeBasedDrops || []) {
      const name = d.benefitEdges?.[0]?.benefit?.name || d.name;
      if (!name) continue;
      for (const key of [d.id, `${d.id}:total`]) if (peaks[key]) peaks[key].name = name;
    }
  }
  const gained = added > 0;
  if (gained) s.lastGainAt = now;

  const inventoryIds = new Set(allCampaigns.map((c) => c.id));
  // Minutes win over the lists (2026-11-22). Every miss so far was a channel's lists leaving out a
  // campaign Twitch was crediting there (a badge 11-19, a dismissed highlight 11-20, an OSRS drop
  // 11-22), and the tracker had the proof: the session naming the open channel with its drop
  // rising. Such a drop's campaign is placed on that channel, and kept there while the session
  // still names that drop on it and the drop is unfinished, so a hang afterwards still warns.
  // Only on a rise: a session alone names channels nobody is watching. Bound: one per open tab.
  const campaignOf = (dropId) => allCampaigns.find((c) => (c.timeBasedDrops || []).some((d) => d.id === dropId))?.id ?? null;
  const listedOn = (st) => new Set((st.channel?.campaigns || []).map((c) => c.id));
  // A reward running total or window reading placed here reads `reward`, shown and quiet, never
  // `eligible`: judging those was the 2026-11-18 false Hung and reload.
  const unfinished = (dropId) => active.some((d) => d.id === dropId && d.remaining > 0);
  const judged = (dropId) => active.some((d) => d.id === dropId && d.remaining > 0 && !d.unjudged);
  const placedHere = new Map();
  for (const st of obs.streams || []) {
    const was = (prev?.placed || []).find((p) => p.tabId === st.tabId && p.login === st.login);
    // A poll that says nothing (lookup failed, no session) keeps it unjudged: a hung drop never
    // rises again to restore it. It ends when the credit moves (a session names the drop on
    // another channel), the drop finishes, the lists hold it, the tab goes, or PLACED_KEEP_MS pass
    // with no rise (a stream that changed game must not read as hung for long).
    if (!st.login || !st.channel || st.channel.unknown || !st.channel.live) {
      if (was && st.channel?.unknown && now - was.lastRise < PLACED_KEEP_MS) placedHere.set(st.tabId, was);
      continue;
    }
    const here = known.filter((x) => x.login === st.login);
    const fresh = here.find((x) => risen.has(x.dropId) && unfinished(x.dropId) && campaignOf(x.dropId) && !listedOn(st).has(campaignOf(x.dropId)));
    const moved = was && known.some((x) => x.dropId === was.dropId && x.login !== st.login);
    // Twitch credits "while they're live in {Category}": a new category ends it at once, as a
    // listed campaign leaving the channel would ("may have changed game", no hang, no reload).
    // An unreadable category (undefined) says nothing and keeps it.
    const game = st.channel.gameId;
    const changedGame = was && game !== undefined && was.gameId !== undefined && game !== was.gameId;
    const keep = was && !moved && !changedGame && now - was.lastRise < PLACED_KEEP_MS && unfinished(was.dropId) && !listedOn(st).has(was.campaignId) ? was : null;
    const p = fresh
      ? { tabId: st.tabId, login: st.login, dropId: fresh.dropId, campaignId: campaignOf(fresh.dropId), gameId: game, since: was?.dropId === fresh.dropId && !changedGame ? was.since : now, lastRise: now }
      : keep && keep.gameId === undefined && game !== undefined ? { ...keep, gameId: game } : keep;
    if (p) placedHere.set(st.tabId, p);
  }
  s.placed = [...placedHere.values()];
  // States the placement overrides: the lists' view. reward (credited, quiet), unknown, offline
  // and not_channel are left as they are.
  const PLACEABLE = new Set(['no_drops', 'sub_only', 'unstarted', 'finished', 'blocked', 'badge_unseen', 'badge_left']);
  const tabs = {};
  const streams = (obs.streams || []).map((st) => {
    const old = s.tabs[st.tabId];
    const rec = old && old.login === st.login ? old : null;
    const { state: playerState, keepReading } = classifyPlayer(st, rec, now);
    const listedState = classifyChannel(st, active, inventoryIds, s.rewards, blocked, pending, new Set(fromRewards.map((c) => c.id)), leftNear);
    const place = placedHere.get(st.tabId);
    const channelState = place && PLACEABLE.has(listedState) ? (judged(place.dropId) ? 'eligible' : 'reward') : listedState;
    tabs[st.tabId] = {
      login: st.login,
      since: rec ? rec.since : now,
      lastTime: keepReading ? rec.lastTime : st.player?.currentTime ?? null,
      lastTimeAt: keepReading ? rec.lastTimeAt : now,
      playerState,
      channelState,
      // So one odd poll gets the same grace as any other, whenever the tab was opened.
      stateSince: rec?.channelState === channelState && rec.stateSince != null ? rec.stateSince : now,
      // When this tab last became able to earn, which is when a hang on it can start. A paused
      // tab or an offline channel was not hanging. A failed lookup says nothing, so it keeps this.
      ableSince: channelState === 'unknown'
        ? rec?.ableSince ?? null
        : channelState === 'eligible' && playerState !== 'paused' ? rec?.ableSince ?? now : null,
    };
    return {
      tabId: st.tabId,
      login: st.login,
      displayName: st.channel?.displayName || st.login,
      since: tabs[st.tabId].since,
      playerState,
      muted: !!st.player?.muted,
      hidden: !!st.player?.hidden,
      channelState,
      stateSince: tabs[st.tabId].stateSince,
      ableSince: tabs[st.tabId].ableSince,
      // What this channel can earn, so a panel on it lists only those. Bound: what Twitch lists for one channel.
      campaignIds: [...(st.channel?.campaigns || []).map((c) => c.id), ...(place && !listedOn(st).has(place.campaignId) ? [place.campaignId] : [])],
      // The lists' own view when minutes placed a campaign here, for Copy debug info.
      ...(place ? { listedState } : {}),
      // The drop a session campaign reports nothing for, so the headline can name it.
      pendingDrop: ['unstarted', 'badge_unseen'].includes(channelState) ? (st.channel?.campaigns || []).map((c) => pending.get(c.id)?.name).find(Boolean) ?? null : null,
      blockedOpens: channelState === 'blocked' ? [...(st.channel?.campaigns || [])].map((c) => blocked.get(c.id)).find(Boolean)?.opens ?? null : null,
      // A reward drop earned for today: when the next one can start.
      rewardOpens: channelState === 'reward' ? (st.channel?.campaigns || []).map((c) => blocked.get(c.id)?.opens).find(Boolean) ?? null : null,
      // Highest minutes seen, or null when Twitch has reported none. Sub drops never have any.
      badges: (st.channel?.badges || []).map((b) => ({
        ...b,
        drops: b.drops.map((d) => {
          const minutes = d.required > 0 ? s.drops[d.id]?.peak ?? null : null;
          // Seen leaving Twitch's in-progress list: its last reading, and whether that was close
          // enough to the requirement to read as earned.
          const gone = d.required > 0 ? s.leftBadges.find((x) => x.id === d.id && x.campaignId === b.id) : null;
          return { ...d, minutes, ...(gone ? { left: { minutes: gone.minutes, at: gone.readAt, near: leftNear.has(d.id) } } : {}) };
        }),
      })),
      badgeLookupFailed: !!st.channel?.badgeLookupFailed,
    };
  });
  s.tabs = tabs;
  // Each time the lists missed a credited drop, for Copy debug info: the next list rule to learn.
  // Bound: CREDIT_UNLISTED_MAX, newest kept.
  s.creditUnlisted = [...(prev?.creditUnlisted || [])];
  for (const st of streams) {
    const p = placedHere.get(st.tabId);
    if (!p || !st.listedState) continue;
    const i = s.creditUnlisted.findIndex((x) => x.login === p.login && x.dropId === p.dropId);
    const entry = { login: p.login, dropId: p.dropId, campaignId: p.campaignId, listedState: st.listedState, first: i >= 0 ? s.creditUnlisted[i].first : now, at: now };
    if (i >= 0) s.creditUnlisted.splice(i, 1);
    s.creditUnlisted.push(entry);
  }
  s.creditUnlisted = s.creditUnlisted.slice(-CREDIT_UNLISTED_MAX);

  // Twitch answers a session for every channel with a campaign, whether it is being watched or
  // not, so the credited one is whichever is rising. Otherwise keep naming the last one that did.
  // Nothing having risen means nothing has been credited, however many sessions answered.
  const session = known.find((x) => risen.has(x.dropId))
    || known.find((x) => x.dropId === s.session?.dropId)
    || null;
  for (const st of streams) {
    // A reward channel is never eligible, but rising there is real credit: without this its row
    // read "Not counting yet" under an "Earning on" headline.
    st.credited = !!session && session.login === st.login && (st.channelState === 'eligible' || st.channelState === 'reward');
  }
  s.streams = streams;
  s.session = session;
  // The campaign of the drop Twitch names as credited, from every campaign known, not just the
  // active list: an earned drop leaves that list while the session keeps naming it and its
  // campaign's next drop rises. The badge, chip and finish times compare against this.
  let credited = session ? allCampaigns.find((c) => (c.timeBasedDrops || []).some((d) => d.id === session.dropId))?.id ?? null : null;
  // Named but with nothing listed (today's reward drop done) while another listed drop on that
  // channel rises: that drop is what the minutes go to. Kept on quiet polls between its rises, so
  // the ring does not flick between its percentage and none (2026-11-19: a full ring with no
  // percentage while the channel's badge rose 69 to 72 of 180).
  if (credited && !active.some((d) => d.campaignId === credited)) {
    const here = streams.find((st) => st.login === session.login)?.campaignIds || [];
    const listedHere = (id) => active.some((d) => d.campaignId === id && here.includes(id));
    const rising = active.find((d) => risen.has(d.id) && here.includes(d.campaignId));
    const kept = prev?.creditedCampaign && prev.creditedCampaign !== credited && listedHere(prev.creditedCampaign) ? prev.creditedCampaign : null;
    credited = rising?.campaignId ?? kept ?? credited;
  }
  s.creditedCampaign = credited;
  s.active = active.sort((a, b) => risen.has(b.id) - risen.has(a.id) || (b.id === session?.dropId) - (a.id === session?.dropId) || a.remaining - b.remaining);
  s.unclaimed = unclaimed.sort((a, b) => (a.claimBy ?? Infinity) - (b.claimBy ?? Infinity) || 0);

  // Timeline: one entry per wall-clock minute.
  const bucket = Math.floor(now / 60000);
  const candidates = streams.filter((st) => st.channelState === 'eligible');
  // The tabs a headline about one tab should pick from: those in front, newest state first, or all
  // of them when none is. In front only on a player that answered hidden: false; a tab not read is
  // not known to be in front. Returns the same array when nothing is in front.
  const front = new Set((obs.streams || []).filter((st) => st.player && st.player.hidden === false).map((st) => st.tabId));
  const frontFirst = (list) => {
    const shown = list.filter((st) => front.has(st.tabId)).sort((a, b) => (b.stateSince ?? 0) - (a.stateSince ?? 0));
    return shown.length ? shown : list;
  };
  // Able to earn only on readings held from an earlier answer: its minutes this poll are not
  // known, so it counts neither as watched-without-credit nor as evidence of a stall.
  const heldOnly = (st) => {
    const ds = s.active.filter((d) => st.campaignIds?.includes(d.campaignId) && d.remaining > 0 && !d.unjudged);
    return ds.length > 0 && ds.every((d) => d.held);
  };
  const watching = candidates.some((st) => !heldOnly(st));
  const last = s.timeline[s.timeline.length - 1];
  if (last && last.m === bucket) {
    last.g = last.g || gained;
    last.w = last.w || watching;
    last.d = (last.d ?? 0) + added;
  } else {
    s.timeline.push({ m: bucket, g: gained, w: watching, d: added });
  }
  if (s.timeline.length > TIMELINE_MAX) s.timeline.splice(0, s.timeline.length - TIMELINE_MAX);
  s.rate = creditRate(s.timeline);
  // "Earning slowly" is about the channel Twitch credits now. Minutes from before it last changed
  // were another channel's (audit, 2026-11-22: 11 of 30 on a channel just opened, from the last
  // one's hang, about 18 minutes to clear). No credited channel known (a failed session) changes
  // nothing. The strip's count (s.rate) still covers every minute it draws. Bound: two scalars.
  const ratedLogin = session?.login || null;
  if (ratedLogin && ratedLogin !== s.rateLogin) {
    // First sight, as after an update: nothing to cut yet.
    s.rateFrom = s.rateLogin ? bucket : null;
    s.rateLogin = ratedLogin;
  }
  const ownRate = s.rateFrom != null ? creditRate(s.timeline.filter((t) => t.m >= s.rateFrom)) : s.rate;

  // Which tabs could earn, to tell a tab that went away from a channel that changed. A raid or a
  // channel going offline keeps the tab, so that still warns. Leaving is deliberate, so it does not.
  // Bound: tab ids from the current poll only.
  const openTabs = new Set(streams.map((st) => st.tabId));
  const earnerTabs = Array.isArray(prev?.earnerTabs) ? prev.earnerTabs : [];
  const stillOpen = earnerTabs.filter((id) => openTabs.has(id));
  s.earnerTabs = candidates.length ? candidates.map((st) => st.tabId) : stillOpen;
  if (candidates.length) {
    s.closedAt = null;
    s.closedName = null;
  } else if (earnerTabs.length && !stillOpen.length) {
    s.closedAt = now;
    s.closedName = prev?.streams?.find((st) => st.tabId === earnerTabs[0])?.displayName ?? null;
  } else if (gained && s.closedAt != null && now - s.closedAt >= CLOSE_SETTLE_MS) {
    // Too long after leaving to be that tab's last minute landing, so it is coming from elsewhere.
    s.closedAt = null;
    s.closedName = null;
  }

  // Verdict.
  // A missing <video> is not evidence: Twitch could have moved the player out of reach.
  const allDead = candidates.length > 0 && candidates.every((c) => !['playing', 'no_video'].includes(c.playerState));
  const unchecked = streams.some((st) => st.channelState === 'unknown');
  const limit = !candidates.length ? NO_STREAM_MS : allDead ? DEAD_PLAYER_MS : STALL_MS;
  // From saved state as well as the last verdict: one failed poll must not make it forget.
  const wasTracking = prev?.tracking === true || ['earning', 'stalled'].includes(prev?.verdict?.code) || prev?.lostAt != null;
  s.lostAt = null;
  if (s.lastGainAt != null && now - s.lastGainAt < limit && s.closedAt == null) {
    const slow = ownRate.watched >= RATE_MIN_MINUTES && ownRate.counted / ownRate.watched < SLOW_BELOW;
    // Judged on a poll where something rose; a quiet poll between credits keeps the last judgement
    // rather than flickering the warning off and on.
    // Kept only while the same channel is still credited and its tab still open: after the user
    // closed it, the old warning kept saying to close it (2026-11-14).
    const keep = prev?.verdict?.code === 'earning' && prev.verdict.wasted && session
      && streams.some((st) => st.login === session.login)
      && (prev.verdict.channel ?? null) === (session.displayName || null);
    const wasted = risen.size
      // Readings that are never judged are not judged as wasted either.
      ? wastedCredit(session, s.active, streams, risen, new Set([
        ...(s.pending || []).filter((d) => d.runningTotal).map((d) => d.id),
        // Only drops still active: today's reward drop, once earned, leaves the list and waits
        // for its next window, so the session's running total rising on it really is wasted
        // (all-views check, 2026-11-19; an earlier fix had excluded it and turned that green).
        ...s.active.filter((d) => d.unjudged).map((d) => d.id),
        ...openWindowUnknown(session, s.rewardInv, now, s.drops),
      ]), new Map([
        ...Object.entries(s.drops).filter(([, rec]) => rec?.name).map(([id, rec]) => [id.replace(/:total$/, ''), rec.name]),
        ...allCampaigns.flatMap((c) => (c.timeBasedDrops || []).map((d) => [d.id, d.benefitEdges?.[0]?.benefit?.name || d.name])),
      ]), nextStart(session, s.rewardInv, now))
      // A quiet poll keeps the judgement but asks again whether another tab can earn. A judgement
      // saved by 0.1.8 or older has no name to rebuild from and is kept as it was.
      : keep ? (prev.verdict.wasted.name ? wastedView(prev.verdict.wasted, session, s.active, streams) : prev.verdict.wasted) : null;
    // rate: the minutes "slowly" was judged on, for the chip's "N of the last N".
    s.verdict = { code: 'earning', channel: session?.displayName || null, slow, wasted, ...(slow ? { rate: ownRate } : {}) };
  } else if (!candidates.length && unchecked && prev?.verdict?.code === 'stalled'
    && streams.some((st) => st.channelState === 'unknown' && prev.streams?.some((p) => p.tabId === st.tabId && p.channelState === 'eligible'))) {
    // One failed lookup on the stalled tab says nothing new: the stall a fresh reading raised is
    // kept, not swapped for "Cannot check" every other poll (audit, 2026-11-22). Never raised here.
    s.verdict = prev.verdict;
  } else if (!candidates.length && unchecked) {
    // Could be earning-capable or not. Saying either would be a guess.
    // since: how long a lookup has been failing, from the channels themselves, so warning() can
    // wait GAP_MS. Clamped by resumeAt, as below: a laptop waking is not three minutes of failure.
    const since = Math.max(s.resumeAt ?? 0, Math.min(...streams.filter((st) => st.channelState === 'unknown').map((st) => st.stateSince ?? now)));
    s.verdict = { code: 'idle', hasStreams: true, limited: true, since, message: 'Cannot check whether your open streams can earn Drops right now.' };
  } else if (!candidates.length && streams.some((st) => st.channelState === 'reward')) {
    // Quiet on purpose: no warning, no hang, no reload. A flat reading here was normal while
    // Twitch counted every minute (2026-11-18), so it says nothing about whether it is counting.
    const [st] = frontFirst(streams.filter((x) => x.channelState === 'reward'));
    const shown = s.active.find((d) => d.unjudged && st.campaignIds.includes(d.campaignId));
    const total = (s.pending || []).find((d) => d.runningTotal && st.campaignIds.includes(d.campaignId));
    const at = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const message = st.rewardOpens != null
      ? `${st.displayName}: Twitch says today's reward is earned. The next one can start ${st.rewardOpens - now < 86400000 ? `at ${at(st.rewardOpens)}` : `on ${new Date(st.rewardOpens).toLocaleDateString([], { month: 'short', day: 'numeric' })}`}.`
      : shown
        ? `${st.displayName}'s ${shown.name}: ${Math.min(shown.minutes, shown.required)} of ${shown.required} minutes, as Twitch reports it.`
        // Why a flat reading here is not judged is in states.js (reward); it is not the user's concern.
        : `Progress for ${st.displayName}'s ${total?.name || 'reward'} could not be read. Twitch's Drops page shows it.`;
    s.verdict = { code: 'idle', hasStreams: true, reward: true, message };
  } else if (!candidates.length && streams.some((st) => ['unstarted', 'badge_unseen', 'blocked'].includes(st.channelState))) {
    // The tab in front is the one being looked at: a channel just opened gets its own grace and its
    // own name, not those of a background tab Twitch had not started for minutes (audit,
    // 2026-11-22: echo_247's "may need your game account linked" on every channel opened after it).
    const all = streams.filter((st) => ['unstarted', 'badge_unseen', 'blocked'].includes(st.channelState));
    const open = frontFirst(all);
    const inFront = open !== all;
    const since = Math.max(s.resumeAt ?? 0, inFront ? open[0].stateSince : Math.min(...open.map((st) => st.stateSince)));
    const first = open[0];
    const late = first.channelState === 'badge_unseen' ? badgeTooLate(first, now) : null;
    const message = {
      badge_unseen: late
        // "Already earned" stays first: the 2026-11-15 case was a badge Twitch's inventory lists
        // as claimed, with no session reported for it.
        ? `${first.displayName}'s badge has a watch timer, but Twitch is not reporting its minutes. You may already have earned it; if not, it needs ${span(late.need)} and its campaign ends in ${span(late.left)}, so it cannot finish in time.`
        : `${first.displayName}'s badge has a watch timer, but Twitch is not reporting its minutes. You may already have earned it.`,
      unstarted: first.pendingDrop
        // Only what is seen: no minutes rising here, none reported for that drop. Whether it is
        // locked, ticking with another drop or waiting is not known (2026-11-19).
        ? `No minutes are rising on ${first.displayName}, and Twitch reports none for its ${first.pendingDrop}.`
        : `${first.displayName} has a campaign that has not started counting. It may need your game account linked.`,
      // Within a day, the time: a daily reward's next window opens 24 hours after the last began.
      blocked: first.blockedOpens != null
        ? `${first.displayName}'s next drop opens ${first.blockedOpens - now < 86400000
          ? `at ${new Date(first.blockedOpens).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
          : new Date(first.blockedOpens).toLocaleDateString([], { month: 'short', day: 'numeric' })}.`
        : `${first.displayName}'s next drop has requirements not met yet. An earlier drop may need claiming first.`,
    }[first.channelState];
    s.verdict = now - since < STALL_MS
      ? { code: 'waiting', since }
      : {
        code: 'idle',
        hasStreams: true,
        limited: true,
        badge: first.channelState === 'badge_unseen',
        blocked: first.channelState === 'blocked',
        unstarted: first.channelState === 'unstarted',
        message,
      };
  } else if (!candidates.length && streams.some((st) => st.channelState === 'badge_left')) {
    // Not a warning: one reading short of the requirement, then gone from the list, is how an
    // earned badge looked (2026-11-20). The evidence is said, so it can be checked on Twitch.
    const [st] = frontFirst(streams.filter((x) => x.channelState === 'badge_left'));
    const name = st.displayName || st.login;
    const d = (st.badges || []).flatMap((b) => b.drops || []).find((x) => x.left?.near);
    const read = d ? ` at ${d.left.minutes} of ${d.required} minutes` : '';
    s.verdict = {
      code: 'idle',
      hasStreams: true,
      badgeLeft: true,
      // The evidence (left the in-progress list one reading short) is in states.js badge_left.
      message: `Twitch stopped listing ${name}'s badge${read}, so you have probably earned it. The badge picker in ${name}'s chat shows whether you have it.`,
    };
  } else if (!candidates.length) {
    const hasStreams = streams.some((st) => st.login);
    s.verdict = { code: 'idle', hasStreams };
    // Finishing a campaign with the tab left open is the good outcome, not a lost one.
    const earningOn = streams.find((st) => st.login === prev?.session?.login);
    const finished = earningOn ? earningOn.channelState === 'finished' : streams.some((st) => st.channelState === 'finished');
    // A tab that could earn is still open but no longer can: the channel changed game, went
    // offline or raided away. Closing it is deliberate, so that stays a plain idle.
    // Once LOST_SHOWN_MS has passed, lostAt is cleared and tracking drops, so the next poll no
    // longer counts as wasTracking and the plain idle sticks.
    const lostAt = prev?.lostAt ?? now;
    if (hasStreams && wasTracking && !finished && s.earnerTabs.length && now - lostAt < LOST_SHOWN_MS) {
      s.lostAt = lostAt;
      s.verdict.lost = true;
      s.verdict.message = 'No open stream can earn a drop now. The channel may have changed game, gone offline or raided away.';
    }
  } else {
    // The longest any tab has been able to earn. With every tab paused, none has, and how long
    // that has lasted comes from the last credit, so the warning still says it.
    const able = candidates.filter((c) => c.ableSince != null);
    const clock = Math.min(...(able.length ? able.map((c) => c.ableSince) : candidates.map((c) => c.since)));
    const since = Math.max(s.lastGainAt ?? 0, s.resumeAt ?? 0, clock);
    // Held readings alone never raise a stall, but keep one a fresh reading raised.
    const stale = candidates.every(heldOnly) && prev?.verdict?.code !== 'stalled';
    if (now - since < limit || stale) {
      s.verdict = { code: 'waiting', since };
    } else {
      s.verdict = { code: 'stalled', since, ...diagnose(candidates, streams, s.active, s.unclaimed) };
    }
  }
  const v = s.verdict;
  s.tracking = ['earning', 'stalled'].includes(v.code) || v.lost === true || ((v.limited === true || v.code === 'waiting') && wasTracking);
  return s;
}

/**
 * The one thing to interrupt the user about, or null. `key` identifies the episode, so a
 * notification fires once and a dismissed on-page pill stays dismissed until the next one.
 */
export function warning(state, now) {
  const v = state.verdict;
  const min = (t) => Math.max(1, Math.round((now - t) / 60000));
  switch (v.code) {
    case 'stalled':
      return { key: `stalled:${v.since}`, title: 'Drops not counting', short: `Drops not counting for ${min(v.since)} min`, message: v.message };
    case 'idle':
      // A drop that has not started or opens later is being tracked fine: Twitch is not counting
      // it, and there is usually nothing to do but wait. The panel says so; no pill, no
      // notification (Tyler, 2026-11-20).
      if (v.limited && (v.unstarted || v.blocked)) return null;
      // A failed channel lookup waits GAP_MS like a failed poll does: one blip is not news.
      // Before 2026-11-20 it notified on the first failed lookup. A badge without minutes has
      // already waited STALL_MS to get here, and has no since.
      if (v.limited && !v.badge && v.since != null && now - v.since < GAP_MS) return null;
      if (v.limited) return { key: 'limited', title: 'Drops not being tracked', short: 'Drops not being tracked', message: v.message };
      return v.lost ? { key: `lost:${state.lostAt}`, title: 'Stopped earning Drops', short: 'Stopped earning Drops', message: v.message } : null;
    case 'api_changed':
      return { key: 'api', title: 'Drops not being tracked', short: 'Drops not being tracked', message: `${v.message || 'Twitch changed its API'}. Opening your Drops page once may fix this.` };
    case 'signed_out':
      // Only once it had been tracking: a fresh install or a deliberate logged-out browser is not news.
      return state.lastOkAt != null ? { key: 'auth', title: 'Drops not being tracked', short: 'Drops not being tracked', message: 'Log in to twitch.tv in this browser.' } : null;
    case 'error':
      // A blip is normal. Only warn once the blind spot could hide a real stall.
      return state.lastOkAt != null && now - state.lastOkAt > GAP_MS
        ? { key: `err:${state.lastOkAt}`, title: 'Drops not being tracked', short: 'Drops not being tracked', message: `${v.message}. Progress is unknown.` }
        : null;
    default:
      return null;
  }
}

/** Things worth interrupting for, once each. Mutates next to record them. */
export function events(prev, next, now) {
  const out = [];
  const w = warning(next, now);
  if (w && w.key !== prev?.notifiedWarning) out.push({ type: 'warning', title: w.title, message: w.message });
  next.notifiedWarning = w ? w.key : null;
  const seen = new Set(prev?.notifiedClaims || []);
  for (const u of next.unclaimed) {
    // Twitch's inventory shows "Connect", not "Claim", until the game account is connected
    // (all 13 waiting rewards on 2026-11-19), so "ready to claim" would be untrue for those.
    if (u.campaignActive && !seen.has(u.id)) {
      out.push(u.needsConnect
        ? { type: 'claim', title: 'Drop earned', message: `${u.name} is earned. Twitch asks you to connect your game account before you can claim it.` }
        : { type: 'claim', title: 'Drop ready to claim', message: `${u.name} is ready to claim.` });
    }
  }
  next.notifiedClaims = next.unclaimed.filter((u) => u.campaignActive).map((u) => u.id);
  // A badge Twitch is counting that no open channel lists: once per campaign, since the Badges
  // tab note alone goes unseen. Bound: kept only while the campaign is in unplacedBadges.
  const told = new Set(prev?.notifiedUnplaced || []);
  const unplaced = next.unplacedBadges || [];
  for (const u of unplaced) {
    if (!u.rising || told.has(u.campaignId)) continue;
    told.add(u.campaignId);
    out.push({
      type: 'unplaced',
      title: 'Badge Drops Tracker cannot show',
      message: `Twitch is counting minutes on a badge (${u.minutes} of ${u.required} min) that no open channel lists. Twitch may have changed where it lists badges. Reload the channel's tab, then Copy debug info in Settings.`,
    });
  }
  next.notifiedUnplaced = [...told].filter((id) => unplaced.some((u) => u.campaignId === id));
  return out;
}

export function badge(state, prefs = {}) {
  const claim = prefs.claimReminders !== false && state.unclaimed?.some((u) => u.campaignActive);
  const v = state.verdict;
  // One colour rule with the chip and panel (states.js verdictTone).
  const tone = verdictTone(v);
  const color = TONE_COLORS[tone];
  switch (v.code) {
    // The toolbar badge shows about 3 characters: HUNG was cut to HUN in Brave (2026-11-13), and
    // STOP is as long. The words go in the icon's tooltip instead.
    case 'stalled': return { text: '!', color, title: 'Drops Tracker: Drops not counting' };
    case 'signed_out': return { text: 'OFF', color, title: 'Drops Tracker: log in to twitch.tv' };
    case 'error':
    case 'api_changed': return { text: '?', color, title: 'Drops Tracker: cannot read Twitch' };
    default: break;
  }
  // Tracking having stopped outranks a reward waiting, which can wait.
  if (v.lost) return { text: '!', color, title: 'Drops Tracker: stopped earning Drops' };
  if (v.limited && tone === 'unknown') return { text: '?', color };
  // A claim waiting does not colour the badge: amber read as something wrong (2026-11-09). The
  // number keeps showing the next drop; the chip and panel carry the claim.
  // A percentage only for the campaign Twitch names as credited: with the session on a drop not
  // listed (a reward read as a running total), the top drop is not what is rising.
  const cc = state.creditedCampaign;
  const top = state.active[0] && (!cc || state.active[0].campaignId === cc) ? state.active[0] : null;
  if (v.code === 'earning' && v.wasted?.reason === 'earned') {
    // Already earned: "!" when another open tab can earn, nothing when there is nothing to do.
    if (v.wasted.actionable) return { text: '!', color, title: 'Drops Tracker: close the tab Twitch is crediting' };
    // A drop still in progress on the credited campaign keeps its percentage, as on the chip.
    if (top) return { text: `${top.pct}%`, color };
    if (claim) return { text: 'CLM', color: TONE_COLORS.info };
    return { text: '', color };
  }
  if (v.code === 'earning' && (top || !claim)) return { text: top ? `${top.pct}%` : 'ON', color };
  if (claim) return { text: 'CLM', color: TONE_COLORS.info };
  if (v.code === 'waiting') return { text: '...', color };
  return { text: '', color };
}
