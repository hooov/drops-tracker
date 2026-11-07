// User settings and the auto-refresh timing. Pure, so it can be tested without a browser.

export const INTERVALS = [1, 5, 10, 30];
export const DEFAULTS = { autoRefresh: false, autoRefreshMinutes: 5, autoReload: false };
export const DROPS_PAGES = ['https://www.twitch.tv/drops/*'];
const JITTER_MS = 5000; // The alarm can fire slightly early; do not slip a whole minute over that.

export function normalize(raw) {
  return {
    autoRefresh: raw?.autoRefresh === true,
    autoRefreshMinutes: INTERVALS.includes(raw?.autoRefreshMinutes) ? raw.autoRefreshMinutes : DEFAULTS.autoRefreshMinutes,
    autoReload: raw?.autoReload === true,
  };
}

// Auto-reload of a hung stream tab. Hangs of about 5 minutes were measured, one of which recovered
// by itself, so it waits past that. Whether a reload really clears a hang has not been measured,
// which is why it is capped and reports what happened afterwards.
export const RELOAD_AFTER_MS = 6 * 60000;
export const RELOAD_GAP_MS = 10 * 60000;
export const RELOAD_MAX = 3;
const RECOVERED_SHOWN_MS = 30 * 60000;
// A reload cannot fix a tab you paused, too many streams, an unclaimed drop, or a player it cannot
// see, which could be Twitch moving it and would just reload for nothing.
const RELOADABLE = new Set(['uncounted', 'frozen', 'ended', 'asleep']);

/**
 * Whether to reload a stream tab now, and what to remember. memo is one small object, so this
 * cannot grow: { since, tries, lastAt, recoveredAt }, where since identifies the hang.
 */
export function autoReloadStep(memo, state, settings, now) {
  let next = memo ?? null;
  if (next?.lastAt != null && next.recoveredAt == null && state.lastGainAt > next.lastAt) {
    next = { ...next, recoveredAt: state.lastGainAt };
  }
  const none = { tabId: null, memo: next };
  const v = state.verdict;
  if (!settings.autoReload || v?.code !== 'stalled' || !RELOADABLE.has(v.cause) || v.tabId == null) return none;
  if (now - v.since < RELOAD_AFTER_MS - JITTER_MS) return none;
  const sameHang = next?.since === v.since;
  const tries = sameHang ? next.tries : 0;
  if (tries >= RELOAD_MAX) return none;
  if (sameHang && now - next.lastAt < RELOAD_GAP_MS - JITTER_MS) return none;
  return { tabId: v.tabId, memo: { since: v.since, tries: tries + 1, lastAt: now, recoveredAt: null } };
}

/** The panel's line about what auto-reload did, or an empty string. */
export function autoReloadNote(memo, state, now) {
  if (!memo?.lastAt) return '';
  const minutes = (t) => Math.max(0, Math.round(t / 60000));
  if (memo.recoveredAt != null) {
    if (now - memo.recoveredAt > RECOVERED_SHOWN_MS) return '';
    return `Minutes came back ${minutes(memo.recoveredAt - memo.lastAt)}m after an auto-reload.`;
  }
  const v = state?.verdict;
  if (v?.code !== 'stalled' || v.since !== memo.since) return '';
  if (memo.tries >= RELOAD_MAX) return `Auto-reloaded ${memo.tries} times and it did not help. It will not try again for this hang.`;
  return `Auto-reloaded ${memo.tries} of ${RELOAD_MAX}, ${minutes(now - memo.lastAt)}m ago.`;
}

/**
 * Whether the Drops page should reload now, and what to store as the last refresh time.
 * Switching it on starts the timer rather than reloading at once.
 */
export function refreshDue(settings, lastAt, now) {
  if (!settings.autoRefresh) return { due: false, nextLastAt: null };
  if (lastAt == null) return { due: false, nextLastAt: now };
  if (now - lastAt >= settings.autoRefreshMinutes * 60000 - JITTER_MS) return { due: true, nextLastAt: now };
  return { due: false, nextLastAt: lastAt };
}
