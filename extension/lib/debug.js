// The Debug tab: what the tracker currently believes, and a bundle to paste when reporting a
// problem. Pure, no chrome.*.

const ago = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
};
const when = (t, now) => (t == null ? 'never' : ago(now - t));
const short = (hash) => (typeof hash === 'string' ? hash.slice(0, 8) : 'none');

function verdictLine(v) {
  if (!v?.code) return 'none';
  const flags = ['cause', 'slow', 'wasted', 'lost', 'limited', 'badge', 'blocked']
    .filter((k) => v[k]).map((k) => (k === 'cause' ? v.cause : k));
  return [v.code, ...flags].join(', ');
}

function hashLines(hashes) {
  const ops = new Set([...Object.keys(hashes?.working ?? {}), ...Object.keys(hashes?.learned ?? {})]);
  return [...ops].sort().map((op) => [
    op,
    `using ${short(hashes?.working?.[op])}, page sent ${short(hashes?.learned?.[op])}`,
  ]);
}

/** Label and value pairs for the tab. Everything here is safe to show. */
export function debugRows({ state, hashes, autoReload, directory, minuteLog, version }, now) {
  const s = state ?? {};
  const session = s.session;
  const rows = [
    ['Version', version ?? 'unknown'],
    ['Verdict', verdictLine(s.verdict)],
    ['Last check', when(s.lastPollAt, now)],
    ['Last good data', when(s.lastOkAt, now)],
    ['Last minute credited', when(s.lastGainAt, now)],
    ['Recent rate', s.rate?.watched ? `${s.rate.counted} of ${s.rate.watched} counted` : 'none yet'],
    ['Credited channel', session ? `${session.login}, ${session.minutes ?? '?'} of ${session.required ?? '?'} min` : 'none'],
    ['Drops being earned', String(s.active?.length ?? 0)],
    ['Earned, not claimed', String(s.unclaimed?.length ?? 0)],
    ['Minute marks saved', String(Object.keys(s.drops ?? {}).length)],
    ['Auto-reload this hang', autoReload?.lastAt ? `${autoReload.tries} tries, last ${when(autoReload.lastAt, now)}` : 'none'],
    ['All Drops list', directory?.at ? `${directory.campaigns?.length ?? 0} saved, ${when(directory.at, now)}` : 'not loaded'],
    ['All Drops error', directory?.error?.kind ?? 'none'],
    ['Minute log', `${Array.isArray(minuteLog) ? minuteLog.length : 0} minutes`],
    ...hashLines(hashes),
  ];
  return rows.map(([label, value]) => ({ label, value: String(value) }));
}

/** One line per open stream, as the tracker read it on the last check. */
export function debugStreams(state) {
  return (state?.streams ?? []).map((st) => ({
    id: st.tabId,
    name: st.displayName || st.login || 'Twitch page',
    line: [
      st.channelState,
      st.playerState,
      st.credited ? 'credited' : null,
      st.hidden ? 'background' : 'front',
      st.muted ? 'muted' : null,
    ].filter(Boolean).join(', '),
  }));
}

// Named one by one so anything added to storage later stays out until someone decides otherwise.
const STATE_FIELDS = [
  'lastPollAt', 'lastOkAt', 'lastGainAt', 'resumeAt', 'closedAt', 'closedName', 'earnerTabs', 'tracking',
  'lostAt', 'verdict', 'rate', 'timeline', 'streams', 'session', 'active', 'unclaimed', 'tabs', 'drops',
];

/** What Copy debug info hands over. Built from named fields only, so a token can never ride along. */
export function debugBundle({ state, settings, hashes, autoReload, directory, minuteLog, version }, now) {
  const picked = {};
  for (const field of STATE_FIELDS) if (state?.[field] !== undefined) picked[field] = state[field];
  return {
    copiedAt: new Date(now).toISOString(),
    version: version ?? null,
    settings: settings ?? null,
    state: picked,
    hashes: { working: hashes?.working ?? {}, learned: hashes?.learned ?? {} },
    autoReload: autoReload ?? null,
    // The list itself is public and long, so only how it stands.
    directory: directory ? { at: directory.at ?? null, triedAt: directory.triedAt ?? null, error: directory.error ?? null, campaigns: directory.campaigns?.length ?? 0 } : null,
    minuteLog: Array.isArray(minuteLog) ? minuteLog : [],
  };
}
