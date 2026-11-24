// The All Drops tab: every campaign running on Twitch, shaped for display. Pure, no chrome.*.
// Saved list bound: parseDirectory keeps at most DIRECTORY_MAX campaigns and each load replaces it.

export const CAMPAIGNS_PAGE = 'https://www.twitch.tv/drops/campaigns';
export const FRESH_MS = 30 * 60000; // Campaigns change daily at most, and each load opens a tab.
export const RETRY_MS = 5 * 60000; // After a failure, opening the tab must not open a page every time.
export const LOAD_TIMEOUT_MS = 25000; // Measured 1.4s on a normal load.

export function span(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  return minutes % 60 ? `${h}h ${minutes % 60}m` : `${h}h`;
}

export const day = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });

/**
 * Time left until `at`, for the timer on a drop done for today. Seconds only in the last hour, so it
 * visibly ticks when it matters: "1d 4h", "3h 59m", "34:12", then "Open now" until the next poll
 * picks the new day up.
 */
export function countdown(at, now) {
  const s = Math.ceil((at - now) / 1000);
  if (!(s > 0)) return 'Open now';
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  // With units, as the lines above: "1:29" beside "4h 11m" read as an hour and a half.
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export function isFresh(dir, now) {
  if (!dir?.triedAt) return false;
  return now - dir.triedAt < (dir.error ? RETRY_MS : FRESH_MS);
}

/** A failure keeps the last good list, marked with its age, so it never reads as "no campaigns". */
export function failedDirectory(prev, error, now) {
  return { campaigns: prev?.campaigns ?? [], at: prev?.at ?? null, triedAt: now, error };
}

export function directoryError(error) {
  switch (error?.kind) {
    case 'auth': return 'Log in to Twitch to see this list.';
    case 'timeout': return "Twitch's campaigns page did not answer. Open it below to fill this list.";
    case 'api_changed': return 'Twitch changed how this list loads. Your own progress is not affected.';
    default: return "Could not read Twitch's campaign list. Your own progress is not affected.";
  }
}

/**
 * A category's page from its name, which is all ChannelDropsCampaigns gives (no slug). Twitch's site
 * decodes the name twice, so a % has to be encoded twice (checked signed out, 2026-11-24). Two
 * categories can share a name, and the link then opens whichever Twitch picks.
 */
export function categoryUrl(name) {
  if (!name) return null;
  try {
    return `https://www.twitch.tv/directory/game/${encodeURIComponent(String(name).replaceAll('%', '%25'))}`;
  } catch {
    return null; // Half a surrogate pair, which a name clipped in storage can end with.
  }
}

export function endsText(end, now) {
  if (end == null) return '';
  const minutes = Math.max(1, Math.round((end - now) / 60000));
  if (minutes < 60) return `ends in ${minutes}m`;
  if (minutes < 24 * 60) return `ends in ${Math.floor(minutes / 60)}h`;
  return `ends ${day(end)}`;
}

function amountText(c) {
  if (c.kind === 'reward') return c.minutes > 0 ? span(c.minutes) : '';
  const drops = `${c.drops} ${c.drops === 1 ? 'drop' : 'drops'}`;
  if (c.minutes > 0) return `${drops}, ${span(c.minutes)}${c.subs ? ' or subs' : ''}`;
  return c.subs ? 'Subscribe to earn' : 'Not earned by watching';
}

function subText(c) {
  if (c.kind !== 'reward') return c.name;
  return c.sitewide ? 'Sitewide reward' : (c.owner || 'Reward');
}

/**
 * Rows for the tab: your campaigns first, then sitewide rewards, then whatever ends soonest. The
 * dates are checked here too because the saved list outlives them, and because Twitch was seen
 * still marking campaigns ACTIVE after they ended.
 * mine: state.active, the drops being earned.
 */
export function directoryRows(dir, mine, query, now) {
  const progress = new Map();
  for (const d of mine || []) {
    progress.set(d.campaignId, Math.max(progress.get(d.campaignId) ?? 0, d.pct));
  }
  const saved = Array.isArray(dir?.campaigns) ? dir.campaigns.filter(Boolean) : [];
  const live = saved.filter((c) => (c.endAt == null || now < c.endAt) && (c.startAt == null || now >= c.startAt));
  const wanted = (query || '').trim().toLowerCase();
  const rows = live
    .filter((c) => !wanted || `${c.game} ${c.name} ${c.owner}`.toLowerCase().includes(wanted))
    .map((c) => {
      const pct = progress.get(c.id);
      return {
        ...c,
        sub: subText(c),
        line: [amountText(c), endsText(c.endAt, now)].filter(Boolean).join(', '),
        pct: pct ?? null,
        // The furthest drop still being earned, not the campaign: earned drops are not in the list.
        tag: pct != null ? `Next drop ${pct}%` : (c.linked ? 'Linked' : ''),
        browseUrl: c.kind === 'reward' ? null : categoryUrl(c.game),
      };
    })
    .sort((a, b) => (
      (b.pct ?? -1) - (a.pct ?? -1)
      || Number(!!b.sitewide) - Number(!!a.sitewide)
      || (a.endAt ?? Infinity) - (b.endAt ?? Infinity)
      || String(a.game).localeCompare(String(b.game))
    ));
  return { rows, total: live.length };
}
