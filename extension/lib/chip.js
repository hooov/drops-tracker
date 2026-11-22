// What the chat-row chip says, from tracker state. Pure, so it can be tested without a page.
import { verdictTone } from './states.js';

export const STALE_MS = 3 * 60000; // Polls run every minute; older than this means the tracker itself stopped.

// First path segments on twitch.tv that are not channels.
export const RESERVED = new Set([
  '', 'directory', 'drops', 'settings', 'subscriptions', 'wallet', 'inventory', 'friends', 'following',
  'videos', 'search', 'downloads', 'jobs', 'turbo', 'prime', 'store', 'p', 'u', 'moderator', 'popout',
  'dashboard', 'broadcast', 'embed', 'clips', 'collections', 'team', 'event', 'products',
]);

/** The channel a twitch.tv page is about, or null. Lives here so the chip survives without the panel. */
export function channelFromPath(pathname) {
  const parts = (pathname || '').split('/').filter(Boolean).map((p) => p.toLowerCase());
  if (parts[0] === 'popout' || parts[0] === 'moderator') return parts[1] ?? null;
  return parts[0] && !RESERVED.has(parts[0]) ? parts[0] : null;
}

/**
 * Whether a channel page should ask for a check now rather than wait for the minute's poll:
 * 'new' when the last poll did not see this channel (just opened, or a channel change inside
 * Twitch's page), 'shown' when it saw it as a background tab and it is now in front (the headline
 * picks the tab in front, tracker.js frontFirst), null otherwise. content.js asks once per reason
 * and channel; a page the poll never sees (tab 21 and up) must not ask again and again.
 */
export function checkNeeded(state, login, visible) {
  if (!state || !login || !Array.isArray(state.streams)) return null;
  const here = state.streams.find((s) => s.login === login);
  if (!here) return 'new';
  return visible && here.hidden ? 'shown' : null;
}

/**
 * The drops worth showing on this channel, in the tracker's order. `from` names another tab when
 * those drops are earned there instead. login is null when no channel is in view (the toolbar popup
 * over another site). All Drops still lists every campaign with its progress.
 */
export function channelDrops(state, login, { pending = false } = {}) {
  const active = state?.active ?? [];
  const streams = state?.streams;
  const everything = { drops: active, from: null };
  // Saved by an older version, until its next poll.
  if (!Array.isArray(streams) || streams.some((s) => !Array.isArray(s.campaignIds))) return everything;
  const on = (list) => active.filter((d) => list.some((s) => s.campaignIds.includes(d.campaignId)));
  const here = login ? streams.find((s) => s.login === login) : null;
  // A failed lookup says nothing about what this channel can earn, so it must not hide progress.
  if (here?.channelState === 'unknown') return everything;
  // A drop Twitch reports no minutes for yet (minutes: null), on the channel being looked at only,
  // as Twitch's own panel lists it. Opt-in: the chip's percentage needs a drop with minutes.
  const unseen = pending && here ? (state.pending || []).filter((d) => here.campaignIds.includes(d.campaignId)) : [];
  // Done for today, with a timer to the next day (tracker.js restingDrops). Same opt-in: it is not
  // progress, so the chip's percentage never comes from it.
  const restOn = (list) => (pending ? (state.resting || []).filter((d) => list.some((s) => s.campaignIds.includes(d.campaignId))) : []);
  const resting = here ? restOn([here]) : [];
  if (here && (on([here]).length || unseen.length)) return { drops: [...on([here]), ...unseen, ...resting], from: null };
  // Watching one channel while another tab earns is a common setup, and hiding that would hide
  // the progress the verdict is talking about.
  const earners = streams.filter((s) => s.channelState === 'eligible');
  // A reward channel is never "eligible", but one Twitch credits is earning too: without it a
  // second tab showed a bare full ring while the reward channel's badge rose (2026-11-19).
  const credited = streams.filter((s) => s.credited && (s.channelState === 'eligible' || s.channelState === 'reward'));
  const elsewhere = credited.length ? credited : earners;
  const drops = on(elsewhere);
  if (drops.length) return { drops, from: elsewhere.length === 1 && elsewhere[0].login !== login ? elsewhere[0].displayName : null };
  // A channel whose only drop is done for today: shown only when no other tab's progress is, since
  // under "Watch Drops on <other tab>" it would read as that tab's, and hiding the progress the
  // verdict talks about is worse (review, 2026-11-22).
  // A campaign Twitch has not started on this channel: its drops with no minutes (tracker.js
  // upcoming), the same opt-in, and like a resting drop only when no other tab's progress is shown,
  // which the headline may be about (audit, 2026-11-22: an empty list read as broken).
  const notYet = pending && here ? (state.upcoming || []).filter((d) => here.campaignIds.includes(d.campaignId)) : [];
  if (resting.length || notYet.length) return { drops: [...resting, ...notYet], from: null };
  // Credited on a tab here that has nothing left to list, such as a channel badge already earned
  // that Twitch kept counting (seen 2026-11-09). Listing every drop in progress would suggest
  // those are what is rising; the verdict says what is.
  const sessionLogin = state.session?.login;
  const sessionTab = sessionLogin ? streams.find((s) => s.login === sessionLogin) : null;
  if (sessionTab) {
    // Its daily drop done for today is still worth showing, with its timer, off a channel only
    // (the toolbar popup): on another channel it would read as that channel's.
    const rest = here ? [] : restOn([sessionTab]);
    return { drops: rest, from: rest.length && sessionTab.login !== login ? sessionTab.displayName || sessionTab.login : null };
  }
  // Minutes rising with no tab here that can earn: a stream outside this browser. Listed only when
  // not looking at a channel; on a channel that cannot earn, other games' drops read as this
  // channel's (Tyler, 2026-11-09: Marvel Rivals and World of Tanks listed on a WoW channel).
  return state.verdict?.code === 'earning' && !here ? everything : { drops: [], from: null };
}

/**
 * What the chip shows. `claims` is how many earned drops wait to be claimed, the same list as the
 * panel's "Ready to claim", drawn as a purple count (inside the ring beside the label, or on its
 * corner when chat is narrow) and never as the ring's colour: amber for a reward waiting read as
 * something wrong (Tyler, 2026-11-09). The word "Claim" stays for campaigns still running.
 */
export function chipView(state, now, login = null, prefs = {}) {
  // Claim reminders switched off (Settings): no count, no "Claim", no claim line in the title.
  const seen = prefs.claimReminders === false && state ? { ...state, unclaimed: [] } : state;
  const view = chipViewOf(seen, now, login);
  // Every earned drop still claimable, so it matches the panel's "Ready to claim" count.
  const claims = (seen?.unclaimed || []).length;
  return { ...view, claims };
}

function chipViewOf(state, now, login) {
  if (!state) return { tone: 'idle', text: 'Drops', pct: null, title: 'Drops Tracker is starting' };
  // While Twitch credits a drop that is not listed (a reward read as a running total, a badge
  // already earned), another listed drop's progress would read as what is rising.
  const cc = state.creditedCampaign;
  const elsewhere = state.verdict?.code === 'earning' && cc && !(state.active || []).some((d) => d.campaignId === cc);
  const top = elsewhere ? undefined : channelDrops(state, login).drops[0];
  const pct = top ? top.pct : null;
  // The tracker cannot see: a grey dashed ring, with "?" inside it when chat is too narrow for the label.
  const unknown = (title) => ({ tone: 'unknown', text: 'Drops ?', mark: '?', pct: null, title });
  if (state.lastPollAt && now - state.lastPollAt > STALE_MS) {
    const min = Math.round((now - state.lastPollAt) / 60000);
    return unknown(`Drops Tracker has not updated for ${min} min, so this may be out of date`);
  }
  const v = state.verdict;
  const tone = verdictTone(v);
  const label = pct != null ? `${pct}%` : null;
  // Clamped as the panel's bar is: a session can read past the requirement (362/360).
  const progress = top ? `${top.name}: ${Math.min(top.minutes, top.required)}/${top.required} min.` : '';
  const waiting = (state.unclaimed || []).filter((u) => u.campaignActive);
  const claim = waiting[0];
  switch (v.code) {
    case 'stalled':
      return { tone, text: `Hung ${Math.max(1, Math.round((now - v.since) / 60000))}m`, pct, title: `${progress} ${v.message}`.trim() };
    case 'signed_out':
      return { tone, text: 'Log in', pct, title: 'Not logged in to Twitch, so Drops cannot be tracked' };
    case 'api_changed':
      return unknown(`${v.message || 'Twitch changed its API'}. Opening your Drops page once may fix this.`);
    case 'error':
      return unknown(`${v.message}. Progress is unknown.`);
    default:
      break;
  }
  // Connect-first rewards read "Connect" on Twitch's inventory, so they are not "ready to claim".
  const connect = waiting.filter((u) => u.needsConnect).length;
  const connectOnly = waiting.length > 0 && connect === waiting.length;
  let claimNote = '';
  if (waiting.length === 1) claimNote = claim.needsConnect ? `${claim.name} is earned; connect your game account to claim it. ` : `${claim.name} is ready to claim. `;
  else if (waiting.length > 1) {
    claimNote = !connect ? `${waiting.length} drops are ready to claim. `
      : connectOnly ? `${waiting.length} drops are earned and need your game account connected to claim. `
        : `${waiting.length} earned drops to claim or connect. `;
  }
  // Tracking having stopped outranks a reward waiting, which can wait.
  if (v.lost) return { tone, text: 'Stopped', pct, title: `${claimNote}${progress} ${v.message}`.trim() };
  if (v.limited) {
    if (tone === 'unknown') return { ...unknown(`${claimNote}${progress} ${v.message}`.trim()), pct };
    return { tone, text: 'Not yet', pct, title: `${claimNote}${progress} ${v.message}`.trim() };
  }
  // Nothing left to earn here, only a reward: a full purple ring, not a warning.
  if (claim && !top) return { tone: 'info', text: connectOnly ? 'Connect' : 'Claim', pct: 100, title: claimNote.trim() };
  const view = runningView(v, tone, state.rate, label, pct, progress, login && login === state.session?.login);
  // A claim can wait a long time, so it must not hide the progress of the next drop or change what
  // the ring's colour says about earning. The count says it instead.
  return claim ? { ...view, title: `${claimNote}${view.title}` } : view;
}

// credited: this tab is the channel Twitch is crediting.
function runningView(v, tone, rate, label, pct, progress, credited) {
  if (v.code === 'earning') {
    const where = v.channel ? ` on ${v.channel}` : '';
    if (v.wasted) {
      const title = `${progress} ${v.wasted.message}`.trim();
      // "Done" only with nothing else in progress on this tab: a badge still rising here keeps its
      // own percentage on a quiet minute (2026-11-19, 71 of 180 while today's GTAVI drop was done).
      if (v.wasted.reason === 'earned' && !v.wasted.actionable) return { tone, text: label || 'Done', pct: pct ?? 100, title };
      // The action is on the credited tab; the tab that can earn keeps its own progress.
      if (v.wasted.reason === 'earned' && credited) return { tone, text: 'Close tab', pct, title };
      return { tone, text: label || 'Drops', pct, title };
    }
    if (v.slow) {
      // The count "slowly" was judged on: this channel's minutes only (tracker.js ownRate).
      const r = v.rate || rate;
      return { tone, text: label || 'Drops', pct, title: `${progress} Earning slowly${where}: ${r.counted} of the last ${r.watched} watched minutes counted.`.trim() };
    }
    return { tone, text: label || 'Drops', pct, title: `${progress} Earning${where}.`.trim() };
  }
  // Before the first poll lands. It used to fall through to "Not earning right now" in grey.
  if (v.code === 'starting') return { tone, text: label || 'Drops', pct, title: 'Checking your Drops progress.' };
  if (v.code === 'waiting') {
    return { tone, text: label || 'Drops', pct, title: `${progress} Waiting for the first minute to land.`.trim() };
  }
  // A reward channel is not known to be idle: Twitch's numbers there are shown, not judged.
  if (v.reward) return { tone, text: label || 'Drops', pct, title: `${progress} ${v.message}`.trim() };
  return { tone, text: label || 'Drops', pct, title: `${progress} Not earning right now.`.trim() };
}

/** Rough rendered width of the full chip: padding, ring and gap, plus the label at 14px semibold. */
export const fullWidth = (text) => 42 + text.length * 8;

/**
 * The row wraps onto a second line when it runs out of room, so fall back to the ring alone.
 * rowWidth and usedWidth include the chip at its current width, which is what makes this
 * stable: the same answer comes back whichever size the chip is already at.
 */
export function shouldCompact(rowWidth, usedWidth, chipWidth, text) {
  return rowWidth - usedWidth < fullWidth(text) - chipWidth;
}
