// Pure state machine: (previous state, observation, time) -> next state. No chrome.* here.
// Bounds: timeline <= TIMELINE_MAX entries; tabs, drops and notified ids are rebuilt from
// the current observation each poll, so they cannot outgrow what Twitch currently reports.
// The states it writes (verdict codes, causes, channel and player states) are declared in
// states.js; the map of how they move is docs/state-machines.md.
import { PLAYER_STATES, RATE_MIN_MINUTES } from './states.js';

export { RATE_MIN_MINUTES };

export const STALL_MS = 4 * 60000; // Credit lands about every 60s (measured); 4 misses is a real stall.
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
const FRESH_READING_MS = 5000;
const CLOSE_SETTLE_MS = 2 * 60000; // Credit lands about every 60s, so one can still arrive after leaving.

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
            needsConnect: c.self?.isAccountConnected === false,
            connectUrl: /^https:\/\//i.test(c.accountLinkURL ?? '') ? c.accountLinkURL : null,
          });
        }
        continue;
      }
      if (!live || self.hasPreconditionsMet === false) continue;
      const end = dateOr(d.endAt, campaignEnd);
      if (now >= end) continue;
      // A multi-day campaign's later window has not opened yet: no minutes can land on it.
      if (now < dateOr(d.startAt, -Infinity)) continue;
      const minutes = self.currentMinutesWatched;
      if (typeof minutes !== 'number') continue;
      const remaining = Math.max(0, required - minutes);
      active.push({
        ...base,
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
export function wastedCredit(session, active, streams, risen) {
  // Only a drop seen rising this poll. The session can keep naming a drop after it was earned
  // while the campaign's next drop does the rising, and that is ordinary earning.
  if (!session?.dropId || !risen?.has(session.dropId) || !streams.some((st) => st.login === session.login)) return null;
  const drop = active.find((d) => d.id === session.dropId);
  const earned = !drop && session.required > 0 && session.minutes >= session.required;
  if (!earned && !drop?.atRisk) return null;
  const channel = session.displayName || session.login;
  const badge = streams.flatMap((st) => st.badges || []).flatMap((b) => b.drops || []).find((d) => d.id === session.dropId);
  const what = earned
    ? `${channel}'s ${badge?.name || 'drop'} is already earned, but Twitch is still crediting it, so these minutes do nothing.`
    : `Twitch is crediting ${channel}, but ${drop.name} cannot finish before its campaign ends.`;
  // Another open tab with a drop it can still finish. Twitch decides which one gets the minutes.
  let alt = null;
  for (const st of streams) {
    if (st.login === session.login || st.channelState !== 'eligible') continue;
    const d = active.find((x) => st.campaignIds?.includes(x.campaignId) && x.remaining > 0 && !x.atRisk);
    if (d) { alt = { name: st.displayName || st.login, game: d.game || d.campaign }; break; }
  }
  const fix = alt ? ` ${alt.name} can earn ${alt.game}: close or pause ${channel}.` : '';
  return { reason: earned ? 'earned' : 'too_late', message: what + fix };
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

function classifyChannel(stream, active, inventoryIds, rewards, blocked) {
  if (!stream.login) return 'not_channel';
  // No entry at all means it was not looked up (past the channel limit), not that it is offline.
  if (!stream.channel || stream.channel.unknown) return 'unknown';
  if (!stream.channel.live) return 'offline';
  const campaigns = stream.channel.campaigns || [];
  if (!campaigns.length) return stream.channel.subOnly ? 'sub_only' : 'no_drops';
  const owned = new Set(rewards.ids);
  let unstarted = false;
  let badgeUnseen = false;
  let isBlocked = false;
  for (const c of campaigns) {
    if (active.some((d) => d.campaignId === c.id && d.remaining > 0)) return 'eligible';
    if (blocked.has(c.id)) isBlocked = true;
    if (inventoryIds.has(c.id)) continue;
    const allOwned = c.benefitIds?.length > 0 && c.benefitIds.every((id) => owned.has(id));
    if (allOwned) continue;
    if (c.channelOwned) badgeUnseen = true;
    else unstarted = true;
  }
  // Not in the inventory could mean about to start, needs a linked account, or a finished
  // campaign Twitch still lists. None of those is evidence of a hang, so it never reads as one.
  if (isBlocked) return 'blocked';
  if (unstarted) return 'unstarted';
  // A timer badge with no session: Twitch is not reporting its minutes. There is no game account
  // to link, and what a session looks like once a badge is earned has not been seen, so this may
  // mean already earned. Not knowing is still worth saying.
  return badgeUnseen ? 'badge_unseen' : 'finished';
}

/**
 * A channel's own badge campaign never appears in Inventory, so the session is the only place
 * its minutes are reported. Shaped like an Inventory campaign, so everything downstream treats
 * it the same: rising minutes are still the only proof of earning.
 */
function sessionCampaigns(streams, inventoryIds, sessions, rewards) {
  const out = new Map();
  const owned = new Set(rewards.ids);
  for (const st of streams) {
    for (const c of st.channel?.campaigns || []) {
      // Badges only. A game campaign missing from Inventory is unstarted or needs linking, and
      // its session answering does not make it a hang.
      if (!c.channelOwned || inventoryIds.has(c.id) || out.has(c.id)) continue;
      if (c.benefitIds?.length > 0 && c.benefitIds.every((id) => owned.has(id))) continue;
      const session = (sessions || []).find((x) => c.watchDrops?.some((d) => d.id === x.dropId));
      if (!session || typeof session.minutes !== 'number') continue;
      const d = c.watchDrops.find((x) => x.id === session.dropId);
      out.set(c.id, {
        id: c.id,
        name: c.name,
        endAt: c.endAt,
        imageURL: c.image,
        game: { name: st.channel.displayName || st.login },
        timeBasedDrops: [{
          id: d.id,
          name: d.name,
          requiredMinutesWatched: d.required,
          startAt: d.startAt,
          endAt: d.endAt,
          benefitEdges: [{ benefit: { name: d.name, imageAssetURL: d.image } }],
          self: { currentMinutesWatched: session.minutes, isClaimed: false, hasPreconditionsMet: true },
        }],
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

/** Remember owned rewards across polls: the field fails on about half of real calls. */
function mergeRewards(previous, seen) {
  const before = { ids: [], ...previous };
  if (!seen?.ids) return before;
  const ids = seen.complete ? seen.ids : [...new Set([...before.ids, ...seen.ids])];
  return { ids: ids.slice(0, REWARDS_MAX) };
}

/**
 * Highest minutes seen per drop. A read that dips and comes back is not progress, or a value
 * flapping 65, 64, 65 would look like earning for ever. A drop missing from one answer keeps
 * its mark for the same reason. Only a dip that lasts is believed: multi-day campaigns really
 * do discard minutes when a day's window closes. A drop not seen for longer than GAP_MS takes its
 * next reading as a new baseline: those minutes were earned at some point nobody saw, not now.
 * Bound: DROPS_MAX marks, or as many as Twitch currently reports if that is more. Dropping a mark
 * still being reported would make it look new, and so a gain, on every poll.
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
        risen.add(id);
      }
      peaks[id] = { peak: minutes, low: 0, at: now };
    } else if (minutes > rec.peak) {
      added = Math.max(added, minutes - rec.peak); // Drops in a campaign tick together: largest, not sum.
      risen.add(id);
      rec.peak = minutes;
      rec.low = 0;
    } else if (minutes < rec.peak) {
      rec.low += 1;
      if (rec.low >= DIP_POLLS) {
        rec.peak = minutes;
        rec.low = 0;
      }
    } else {
      rec.low = 0;
    }
  };
  for (const c of campaigns) {
    for (const d of c.timeBasedDrops || []) {
      if (typeof d.self?.currentMinutesWatched === 'number') see(d.id, d.self.currentMinutesWatched);
    }
  }
  // A second source: if Inventory were ever cached, the session could still show minutes landing.
  // Only a session reading it has not given before counts. If the two simply disagree, Inventory's
  // dip would lower the mark every few polls and the same reading would look like a gain each time.
  for (const x of sessions || []) {
    const rec = peaks[x.dropId];
    if (!rec || typeof x.minutes !== 'number') continue;
    const fresh = rec.session == null || x.minutes > rec.session;
    rec.session = Math.max(rec.session ?? x.minutes, x.minutes);
    if (fresh && !firstGoodPoll && x.minutes > rec.peak) see(x.dropId, x.minutes);
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
  // streams still earned, so the message says what was seen rather than that two always fail.
  const other = streams.find((s) => s.playerState === 'playing' && s.tabId !== playing.tabId);
  if (other) {
    const tested = 'A second stream stopped Drops in testing until it was closed.';
    // A playing tab that is not a channel, such as the front page's autoplay, has no name.
    const message = other.login && other.login === playing.login
      ? `${named(playing)} is playing in two tabs, and Twitch is not adding minutes. ${tested} Close one of them.`
      : named(other)
        ? `${named(other)} is also playing, and Twitch is not adding minutes on ${named(playing)}. ${tested} Close or pause ${named(other)}.`
        : `Another Twitch tab is also playing video, and Twitch is not adding minutes on ${named(playing)}. ${tested} Close or pause that tab.`;
    return { cause: 'second_stream', message, tabId: playing.tabId, otherTabId: other.tabId };
  }
  return {
    cause: 'uncounted',
    message: `${named(playing)} is playing, but Twitch is not adding minutes. It can recover by itself; reload the tab if it stays stuck.`,
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
  const fromSessions = sessionCampaigns(obs.streams || [], new Set(obs.campaigns.map((c) => c.id)), obs.sessions, s.rewards);
  const allCampaigns = [...obs.campaigns, ...fromSessions];
  const { active, unclaimed } = summarize(allCampaigns, now);
  const blocked = blockedCampaigns(obs.campaigns, now);
  const known = obs.sessions || (obs.session ? [obs.session] : []);

  // First sight of a drop is a baseline, unless it appeared with minutes on a later poll,
  // which means Twitch just started it for us.
  const sessionOnly = new Set(fromSessions.flatMap((c) => c.timeBasedDrops.map((d) => d.id)));
  const { peaks, added, risen } = trackMinutes(s.drops, allCampaigns, known, firstGoodPoll, sessionOnly, now);
  s.drops = peaks;
  const gained = added > 0;
  if (gained) s.lastGainAt = now;

  const inventoryIds = new Set(allCampaigns.map((c) => c.id));
  const tabs = {};
  const streams = (obs.streams || []).map((st) => {
    const old = s.tabs[st.tabId];
    const rec = old && old.login === st.login ? old : null;
    const { state: playerState, keepReading } = classifyPlayer(st, rec, now);
    const channelState = classifyChannel(st, active, inventoryIds, s.rewards, blocked);
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
      campaignIds: (st.channel?.campaigns || []).map((c) => c.id),
      blockedOpens: channelState === 'blocked' ? [...(st.channel?.campaigns || [])].map((c) => blocked.get(c.id)).find(Boolean)?.opens ?? null : null,
      // Highest minutes seen, or null when Twitch has reported none. Sub drops never have any.
      badges: (st.channel?.badges || []).map((b) => ({
        ...b,
        drops: b.drops.map((d) => ({ ...d, minutes: d.required > 0 ? s.drops[d.id]?.peak ?? null : null })),
      })),
    };
  });
  s.tabs = tabs;

  // Twitch answers a session for every channel with a campaign, whether it is being watched or
  // not, so the credited one is whichever is rising. Otherwise keep naming the last one that did.
  // Nothing having risen means nothing has been credited, however many sessions answered.
  const session = known.find((x) => risen.has(x.dropId))
    || known.find((x) => x.dropId === s.session?.dropId)
    || null;
  for (const st of streams) {
    st.credited = !!session && session.login === st.login && st.channelState === 'eligible';
  }
  s.streams = streams;
  s.session = session;
  s.active = active.sort((a, b) => risen.has(b.id) - risen.has(a.id) || (b.id === session?.dropId) - (a.id === session?.dropId) || a.remaining - b.remaining);
  s.unclaimed = unclaimed.sort((a, b) => (a.claimBy ?? Infinity) - (b.claimBy ?? Infinity) || 0);

  // Timeline: one entry per wall-clock minute.
  const bucket = Math.floor(now / 60000);
  const candidates = streams.filter((st) => st.channelState === 'eligible');
  const last = s.timeline[s.timeline.length - 1];
  if (last && last.m === bucket) {
    last.g = last.g || gained;
    last.w = last.w || candidates.length > 0;
    last.d = (last.d ?? 0) + added;
  } else {
    s.timeline.push({ m: bucket, g: gained, w: candidates.length > 0, d: added });
  }
  if (s.timeline.length > TIMELINE_MAX) s.timeline.splice(0, s.timeline.length - TIMELINE_MAX);
  s.rate = creditRate(s.timeline);

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
    const slow = s.rate.watched >= RATE_MIN_MINUTES && s.rate.counted / s.rate.watched < SLOW_BELOW;
    // Judged on a poll where something rose; a quiet poll between credits keeps the last judgement
    // rather than flickering the warning off and on.
    const wasted = risen.size
      ? wastedCredit(session, s.active, streams, risen)
      : prev?.verdict?.code === 'earning' ? prev.verdict.wasted ?? null : null;
    s.verdict = { code: 'earning', channel: session?.displayName || null, slow, wasted };
  } else if (!candidates.length && unchecked) {
    // Could be earning-capable or not. Saying either would be a guess.
    s.verdict = { code: 'idle', hasStreams: true, limited: true, message: 'Cannot check whether your open streams can earn Drops right now.' };
  } else if (!candidates.length && streams.some((st) => ['unstarted', 'badge_unseen', 'blocked'].includes(st.channelState))) {
    const open = streams.filter((st) => ['unstarted', 'badge_unseen', 'blocked'].includes(st.channelState));
    const since = Math.max(s.resumeAt ?? 0, Math.min(...open.map((st) => st.stateSince)));
    const first = open[0];
    const message = {
      badge_unseen: `${first.displayName}'s badge has a watch timer, but Twitch is not reporting its minutes. You may already have earned it.`,
      unstarted: `${first.displayName} has a campaign that has not started counting. It may need your game account linked.`,
      blocked: first.blockedOpens != null
        ? `${first.displayName}'s next drop opens ${new Date(first.blockedOpens).toLocaleDateString([], { month: 'short', day: 'numeric' })}.`
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
        message,
      };
  } else if (!candidates.length) {
    const hasStreams = streams.some((st) => st.login);
    s.verdict = { code: 'idle', hasStreams };
    // Finishing a campaign with the tab left open is the good outcome, not a lost one.
    const earningOn = streams.find((st) => st.login === prev?.session?.login);
    const finished = earningOn ? earningOn.channelState === 'finished' : streams.some((st) => st.channelState === 'finished');
    // A tab that could earn is still open but no longer can: the channel changed game, went
    // offline or raided away. Closing it is deliberate, so that stays a plain idle.
    if (hasStreams && wasTracking && !finished && s.earnerTabs.length) {
      s.lostAt = prev?.lostAt ?? now;
      s.verdict.lost = true;
      s.verdict.message = 'No open stream can earn a drop now. The channel may have changed game, gone offline or raided away.';
    }
  } else {
    // The longest any tab has been able to earn. With every tab paused, none has, and how long
    // that has lasted comes from the last credit, so the warning still says it.
    const able = candidates.filter((c) => c.ableSince != null);
    const clock = Math.min(...(able.length ? able.map((c) => c.ableSince) : candidates.map((c) => c.since)));
    const since = Math.max(s.lastGainAt ?? 0, s.resumeAt ?? 0, clock);
    if (now - since < limit) {
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
    if (u.campaignActive && !seen.has(u.id)) out.push({ type: 'claim', title: 'Drop ready to claim', message: `${u.name} is ready to claim.` });
  }
  next.notifiedClaims = next.unclaimed.filter((u) => u.campaignActive).map((u) => u.id);
  return out;
}

export function badge(state, prefs = {}) {
  const claim = prefs.claimReminders !== false && state.unclaimed?.some((u) => u.campaignActive);
  switch (state.verdict.code) {
    case 'stalled': return { text: 'HUNG', color: '#d92d20' };
    case 'signed_out': return { text: 'OFF', color: '#667085' };
    case 'error':
    case 'api_changed': return { text: 'ERR', color: '#667085' };
    default: break;
  }
  // Tracking having stopped outranks a reward waiting, which can wait.
  if (state.verdict.lost) return { text: 'STOP', color: '#b54708' };
  if (state.verdict.limited) return { text: '?', color: '#b54708' };
  // A claim waiting does not colour the badge: amber read as something wrong (2026-11-09). The
  // number keeps showing the next drop; the chip and panel carry the claim.
  if (state.verdict.code === 'earning' && (state.active[0] || !claim)) {
    return { text: state.active[0] ? `${state.active[0].pct}%` : 'ON', color: state.verdict.slow || state.verdict.wasted ? '#b54708' : '#067647' };
  }
  if (claim) return { text: 'CLM', color: '#6941c6' };
  if (state.verdict.code === 'waiting') return { text: '...', color: '#175cd3' };
  return { text: '', color: '#667085' };
}
