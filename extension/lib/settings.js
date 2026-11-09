// User settings and the auto-refresh timing. Pure, so it can be tested without a browser.
import { STALL_CAUSES } from './states.js';

export const INTERVALS = [1, 5, 10, 30];
// Both helpers are on by default (Tyler's call, 2026-11-09, for the store release). devMode only
// shows the debug tools in the Settings tab. claimReminders off hides every claim prompt.
export const DEFAULTS = { autoRefresh: true, autoRefreshMinutes: 5, autoReload: true, devMode: false, claimReminders: true };
export const DROPS_PAGES = ['https://www.twitch.tv/drops/*'];
const JITTER_MS = 5000; // The alarm can fire slightly early; do not slip a whole minute over that.

// A saved choice wins, so turning a default-on setting off sticks. Anything that is not a real
// boolean falls back to the default rather than to off.
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

export function normalize(raw) {
  return {
    autoRefresh: bool(raw?.autoRefresh, DEFAULTS.autoRefresh),
    autoRefreshMinutes: INTERVALS.includes(raw?.autoRefreshMinutes) ? raw.autoRefreshMinutes : DEFAULTS.autoRefreshMinutes,
    autoReload: bool(raw?.autoReload, DEFAULTS.autoReload),
    devMode: bool(raw?.devMode, DEFAULTS.devMode),
    claimReminders: bool(raw?.claimReminders, DEFAULTS.claimReminders),
  };
}

// Auto-reload of a hung stream tab. Hangs of about 5 minutes were measured, one of which recovered
// by itself, so it waits past that. Whether a reload really clears a hang has not been measured,
// which is why it is capped and reports what happened afterwards.
export const RELOAD_AFTER_MS = 6 * 60000;
export const RELOAD_GAP_MS = 10 * 60000;
export const RELOAD_MAX = 3;
const SAME_HANG_MS = 60 * 60000; // With no minutes back, a hang within this of the last reload is the same one.
const RECOVERED_SHOWN_MS = 30 * 60000;
// Which causes Auto-reload may act on is declared with the causes, in states.js.

/**
 * Whether the memo belongs to the hang the verdict describes. Until minutes come back it is the
 * same hang: a reload can leave the player paused for a poll, which restarts the verdict's `since`,
 * and keying on that alone gave every reload a fresh budget, so the cap of RELOAD_MAX never held.
 * An hour with no reload ends it too, so a later session starts clean. One rule for the step and
 * the panel's note, which used to disagree and dropped the note mid-hang.
 */
function sameHang(memo, v, now) {
  return memo != null && (memo.since === v.since
    || (memo.recoveredAt == null && memo.lastAt != null && now - memo.lastAt < SAME_HANG_MS));
}

/**
 * Whether to reload a stream tab now, and what to remember. memo is one small object, so this
 * cannot grow: { since, tries, lastAt, recoveredAt }. States: none (null), trying (tries 1 to
 * RELOAD_MAX, recoveredAt null), given up (tries at RELOAD_MAX), recovered (recoveredAt set).
 */
export function autoReloadStep(memo, state, settings, now) {
  let next = memo ?? null;
  if (next?.lastAt != null && next.recoveredAt == null && state.lastGainAt > next.lastAt) {
    next = { ...next, recoveredAt: state.lastGainAt };
  }
  const none = { tabId: null, memo: next };
  const v = state.verdict;
  if (!settings.autoReload || v?.code !== 'stalled' || !STALL_CAUSES[v.cause]?.autoReload || v.tabId == null) return none;
  if (now - v.since < RELOAD_AFTER_MS - JITTER_MS) return none;
  const same = sameHang(next, v, now);
  const tries = same ? next.tries : 0;
  if (tries >= RELOAD_MAX) return same && next.since !== v.since ? { ...none, memo: { ...next, since: v.since } } : none;
  if (same && now - next.lastAt < RELOAD_GAP_MS - JITTER_MS) return none;
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
  if (v?.code !== 'stalled' || !sameHang(memo, v, now)) return '';
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
