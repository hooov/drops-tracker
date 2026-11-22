// One rule every replay must keep, checked on every poll: a drop Twitch is crediting on an open
// channel is listed in that channel's My Drops, and the channel never reads "Sub drops only" or
// "No Drops". Every tracking miss so far broke it one case at a time (a channel badge 2026-11-19,
// a dismissed highlight 2026-11-20, an omitted OSRS watch drop 2026-11-22).
// "Crediting" is read from Twitch's own answers fed into the poll, never from the tracker's state:
// the session names an open channel, its minutes rose since the previous poll's answer, and they
// are under the drop's requirement (over it, a reward campaign's running total, not this drop).
// Harnesses import `update` from here instead of tracker.js.
import { update as realUpdate } from '../extension/lib/tracker.js';
import { channelDrops } from '../extension/lib/chip.js';

// The session answers each state was built from. Bound: a WeakMap, gone with the state.
const fedWith = new WeakMap();
export const checked = { polls: 0, credited: 0 };
// INVARIANT_COUNT=1 npm test: how many polls and credited drops each test file put through it.
if (process.env.INVARIANT_COUNT === '1') process.on('exit', () => console.log(`invariant ${process.argv[1]?.split(/[\\/]/).pop()}: ${checked.polls} polls, ${checked.credited} credited`));

/** The credited drops this poll that a view leaves out, as readable strings. */
export function creditedNotListed(prevSessions, sessions, state) {
  const out = [];
  for (const x of sessions || []) {
    if (!x?.login || !x.dropId || typeof x.minutes !== 'number' || !(x.minutes < x.required)) continue;
    const before = (prevSessions || []).find((p) => p?.dropId === x.dropId);
    if (!before || typeof before.minutes !== 'number' || !(x.minutes > before.minutes)) continue;
    const st = (state.streams || []).find((t) => t.login === x.login);
    if (!st) continue;
    checked.credited += 1;
    if (st.channelState === 'sub_only' || st.channelState === 'no_drops') out.push(`${x.login} reads ${st.channelState} while ${x.dropId} rises ${before.minutes} to ${x.minutes}`);
    const listed = channelDrops(state, x.login, { pending: true }).drops.some((d) => d.id === x.dropId);
    if (!listed) out.push(`${x.dropId} rising on ${x.login} is not in its My Drops`);
  }
  return out;
}

export function update(prev, obs, now) {
  const next = realUpdate(prev, obs, now);
  checked.polls += 1;
  const sessions = obs?.sessions || (obs?.session ? [obs.session] : null);
  if (sessions) {
    const bad = creditedNotListed(prev ? fedWith.get(prev) : null, sessions, next);
    if (bad.length) throw new Error(`Credited drop not tracked: ${bad.join('; ')}`);
    if (next && typeof next === 'object') fedWith.set(next, sessions);
  }
  return next;
}
