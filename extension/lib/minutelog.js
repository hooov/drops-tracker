// A record of each watched minute, to find out what lost minutes have in common. The cause is not
// known (docs/twitch-drops-facts.md), so this only records and compares. Pure, no chrome.*.
// Bound: LOG_MAX entries, oldest dropped. Only minutes with a channel that can earn are kept.

export const LOG_MAX = 1440; // A full day of watching.
export const MIN_TO_COMPARE = 10; // Fewer minutes than this on either side says nothing yet.

/**
 * The panel's minute strip, from the tracker's state.timeline (not this log): the last `span`
 * wall-clock minutes, oldest first, each 'gain', 'miss' (watched, nothing credited) or '' (not
 * watching). Twitch credits on its own clock, so a check can find nothing and the next one two
 * (measured 2026-11-09). That surplus fills the nearest earlier misses, so a late minute is not
 * drawn as lost while the count under it (creditRate in tracker.js) says it was counted.
 */
export function timelineCells(timeline, span = 30) {
  if (!timeline?.length) return [];
  const latest = timeline[timeline.length - 1].m;
  const byMinute = new Map(timeline.map((t) => [t.m, t]));
  const cells = [];
  for (let m = latest - span + 1; m <= latest; m++) {
    const t = byMinute.get(m);
    cells.push(t?.g ? 'gain' : t?.w ? 'miss' : '');
    let surplus = (t?.d ?? 0) - 1;
    for (let i = cells.length - 2; i >= 0 && surplus > 0; i--) {
      if (cells[i] === 'miss') { cells[i] = 'gain'; surplus--; }
    }
  }
  return cells;
}

/** What the tracker knew this minute, or null if nothing was being watched. */
export function logEntry(prev, obs, next, now) {
  const m = Math.floor(now / 60000);
  if (obs.error) return next.tracking ? { m, x: 1 } : null; // Unknown, so never counted as lost.
  const eligible = (next.streams || []).filter((s) => s.channelState === 'eligible');
  if (!eligible.length) return null;
  // The one Twitch credits if known. Otherwise the first that could earn.
  const primary = eligible.find((s) => s.credited) || eligible[0];
  const raw = (obs.streams || []).find((s) => s.tabId === primary.tabId);
  const player = raw?.player ?? {};
  const tab = raw?.tab ?? {};
  // How fast the video really advanced. 100 is normal, and a throttled or stuck player reads lower.
  const before = prev?.tabs?.[primary.tabId];
  let speed = null;
  if (before?.lastTime != null && before.login === primary.login && typeof player.currentTime === 'number') {
    const seconds = (now - before.lastTimeAt) / 1000;
    if (seconds >= 5) speed = Math.max(0, Math.min(200, Math.round(((player.currentTime - before.lastTime) / seconds) * 100)));
  }
  const minute = next.timeline?.[next.timeline.length - 1];
  return {
    m,
    d: minute?.m === m ? minute.d ?? 0 : 0, // Minutes Twitch credited during this minute.
    e: eligible.length,
    p: next.streams.filter((s) => s.playerState === 'playing').length,
    c: primary.login,
    cr: primary.credited ? 1 : 0,
    st: primary.playerState,
    h: player.hidden ? 1 : 0,
    a: tab.active ? 1 : 0,
    pm: player.playerMuted ? 1 : 0,
    v0: player.volumeZero ? 1 : 0,
    tm: tab.tabMuted ? 1 : 0,
    q: typeof player.videoHeight === 'number' && player.videoHeight > 0 ? player.videoHeight : null,
    s: speed,
    ad: player.ad ? 1 : 0,
  };
}

/** Adds an entry. A second poll in one minute, from opening the panel, replaces the first. */
export function addMinute(log, entry) {
  const list = Array.isArray(log) ? log : [];
  if (!entry) return list;
  const last = list[list.length - 1];
  if (last?.m === entry.m) {
    if (entry.x) return list; // A failed poll must not wipe what is known about this minute.
    return [...list.slice(0, -1), { ...entry, s: entry.s ?? last.s ?? null }];
  }
  return [...list, entry].slice(-LOG_MAX);
}

const FACTORS = [
  { yes: 'Two or more streams playing', no: 'One stream playing', test: (e) => (e.p >= 2 ? true : e.p === 1 ? false : null) },
  { yes: 'Tab in background', no: 'Tab in front', test: (e) => e.h === 1 },
  { yes: 'Player muted', no: 'Player sound on', test: (e) => e.pm === 1 || e.v0 === 1 },
  { yes: 'Browser tab muted', no: 'Browser tab not muted', test: (e) => e.tm === 1 },
  { yes: 'Below 480p', no: '480p or above', test: (e) => (e.q == null ? null : e.q < 480) },
  { yes: 'Player running slow', no: 'Player at full speed', test: (e) => (e.s == null ? null : e.s < 90) },
  { yes: 'During an ad', no: 'No ad showing', test: (e) => e.ad === 1 },
];

function tally(entries) {
  const watched = entries.length;
  // A late batch counts in full, but a group cannot have credited more than it watched.
  const counted = Math.min(watched, entries.reduce((sum, e) => sum + (e.d || 0), 0));
  return { watched, counted, pct: watched ? Math.round((counted / watched) * 100) : null };
}

/**
 * Credit rate on each side of each condition, biggest gap first. Showing a gap is not showing a
 * cause: conditions overlap, and only `comparable` rows have enough minutes on both sides to read.
 * Paused minutes are left out and counted apart: Twitch is not losing what nobody was playing, and
 * 52 of them in a muted background tab once made both of those read as the cause. A frozen or
 * asleep player stays in, since those are what this is trying to find.
 */
export function compareMinutes(log) {
  const logged = (Array.isArray(log) ? log : []).filter((e) => e && !e.x && e.e > 0);
  const minutes = logged.filter((e) => e.st !== 'paused');
  const rows = FACTORS.map((f) => {
    const yes = tally(minutes.filter((e) => f.test(e) === true));
    const no = tally(minutes.filter((e) => f.test(e) === false));
    const comparable = yes.watched >= MIN_TO_COMPARE && no.watched >= MIN_TO_COMPARE;
    return { yesLabel: f.yes, noLabel: f.no, yes, no, comparable, gap: comparable ? Math.abs(yes.pct - no.pct) : -1 };
  }).filter((r) => r.yes.watched > 0 || r.no.watched > 0);
  rows.sort((a, b) => b.gap - a.gap);
  return { total: tally(minutes), rows, paused: logged.length - minutes.length };
}
