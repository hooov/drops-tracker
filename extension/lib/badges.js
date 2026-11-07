// The Badges tab: the badge drops of the channel being looked at. Pure, no chrome.*.
import { span, day } from './directory.js';

function dropRow(d, campaignEnd, now) {
  if (d.required <= 0) {
    return { ...d, pct: null, line: d.subs > 1 ? `${d.subs} subs or gifts to earn` : 'Subscribe or gift a sub to earn', atRisk: false };
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
  if (!stream.badges?.length) return { title, note: 'No badge drops on this channel.', campaigns: [] };
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

/**
 * login: the channel being looked at. Without one (the toolbar popup over a page that is not a
 * channel), every open channel that has badges.
 */
export function badgeSections(streams, login, now) {
  const open = (streams || []).filter((s) => s.login);
  if (login) {
    const stream = open.find((s) => s.login === login);
    if (stream) return [section(stream, now)];
    return [{ title: null, note: "No data for this channel yet. It needs its own page open in this browser.", campaigns: [] }];
  }
  const withBadges = open.filter((s) => s.badges?.length);
  if (withBadges.length) return withBadges.map((s) => section(s, now));
  return [{ title: null, note: 'Open a channel to see its badge drops.', campaigns: [] }];
}
