// What the chat-row chip says, from tracker state. Pure, so it can be tested without a page.

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
 * The drops worth showing on this channel, in the tracker's order. `from` names another tab when
 * those drops are earned there instead. login is null when no channel is in view (the toolbar popup
 * over another site). All Drops still lists every campaign with its progress.
 */
export function channelDrops(state, login) {
  const active = state?.active ?? [];
  const streams = state?.streams;
  const everything = { drops: active, from: null };
  // Saved by an older version, until its next poll.
  if (!Array.isArray(streams) || streams.some((s) => !Array.isArray(s.campaignIds))) return everything;
  const on = (list) => active.filter((d) => list.some((s) => s.campaignIds.includes(d.campaignId)));
  const here = login ? streams.find((s) => s.login === login) : null;
  // A failed lookup says nothing about what this channel can earn, so it must not hide progress.
  if (here?.channelState === 'unknown') return everything;
  if (here && on([here]).length) return { drops: on([here]), from: null };
  // Watching one channel while another tab earns is a common setup, and hiding that would hide
  // the progress the verdict is talking about.
  const earners = streams.filter((s) => s.channelState === 'eligible');
  const credited = earners.filter((s) => s.credited);
  const elsewhere = credited.length ? credited : earners;
  const drops = on(elsewhere);
  if (drops.length) return { drops, from: elsewhere.length === 1 && elsewhere[0].login !== login ? elsewhere[0].displayName : null };
  // Credited on a tab here that has nothing left to list, such as a channel badge already earned
  // that Twitch kept counting (seen 2026-11-09). Listing every drop in progress would suggest
  // those are what is rising; the verdict says what is.
  const sessionLogin = state.session?.login;
  if (sessionLogin && streams.some((s) => s.login === sessionLogin)) return { drops: [], from: null };
  // Minutes rising with no tab here that can earn: a stream outside this browser.
  return state.verdict?.code === 'earning' ? everything : { drops: [], from: null };
}

export function chipView(state, now, login = null) {
  if (!state) return { tone: 'idle', text: 'Drops', pct: null, title: 'Drops Tracker is starting' };
  const top = channelDrops(state, login).drops[0];
  const pct = top ? top.pct : null;
  if (state.lastPollAt && now - state.lastPollAt > STALE_MS) {
    const min = Math.round((now - state.lastPollAt) / 60000);
    return { tone: 'warn', text: 'Drops ?', pct, title: `Drops Tracker has not updated for ${min} min, so this may be out of date` };
  }
  const v = state.verdict;
  const label = pct != null ? `${pct}%` : null;
  const progress = top ? `${top.name}: ${top.minutes}/${top.required} min.` : '';
  const claim = state.unclaimed?.find((u) => u.campaignActive);
  switch (v.code) {
    case 'stalled':
      return { tone: 'bad', text: `Hung ${Math.max(1, Math.round((now - v.since) / 60000))}m`, pct, title: `${progress} ${v.message}`.trim() };
    case 'signed_out':
      return { tone: 'warn', text: 'Drops off', pct, title: 'Not logged in to Twitch, so Drops cannot be tracked' };
    case 'api_changed':
      return { tone: 'warn', text: 'Drops ?', pct, title: `${v.message || 'Twitch changed its API'}. Opening your Drops page once may fix this.` };
    case 'error':
      return { tone: 'warn', text: 'Drops ?', pct, title: `${v.message}. Progress is unknown.` };
    default:
      break;
  }
  const claimNote = claim ? `${claim.name} is ready to claim. ` : '';
  // Tracking having stopped outranks a reward waiting, which can wait.
  if (v.lost) return { tone: 'warn', text: 'Stopped', pct, title: `${claimNote}${progress} ${v.message}`.trim() };
  if (v.limited) return { tone: 'warn', text: 'Drops ?', pct, title: `${claimNote}${progress} ${v.message}`.trim() };
  if (claim && !top) return { tone: 'warn', text: 'Claim', pct: 100, title: `${claim.name} is ready to claim` };
  const view = runningView(v, state.rate, label, pct, progress);
  // A claim can wait a long time, so it must not hide the progress of the next drop. Amber, so it
  // still shows when chat is too narrow for the word and only the ring is left.
  return claim ? { ...view, tone: 'warn', text: `${label} Claim`, title: `${claimNote}${view.title}` } : view;
}

function runningView(v, rate, label, pct, progress) {
  if (v.code === 'earning') {
    const where = v.channel ? ` on ${v.channel}` : '';
    if (v.wasted) return { tone: 'warn', text: label || 'Drops', pct, title: `${progress} ${v.wasted.message}`.trim() };
    if (v.slow) {
      return { tone: 'warn', text: label || 'Drops', pct, title: `${progress} Earning slowly${where}: ${rate.counted} of the last ${rate.watched} watched minutes counted.`.trim() };
    }
    return { tone: 'ok', text: label || 'Drops', pct, title: `${progress} Earning${where}.`.trim() };
  }
  if (v.code === 'waiting') {
    return { tone: 'info', text: label || 'Drops', pct, title: `${progress} Waiting for the first minute to land.`.trim() };
  }
  return { tone: 'idle', text: label || 'Drops', pct, title: `${progress} Not earning right now.`.trim() };
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
