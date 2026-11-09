# State machines

Every state the extension keeps, what moves it, and where. The states themselves (verdict codes,
stall causes, channel and player states, and what each means for the UI) are declared once in
[`extension/lib/states.js`](../extension/lib/states.js); `tests/states.test.mjs` fails when
`tracker.js` can produce one that is not declared. This file is the map around those tables.
Measured Twitch behaviour behind the rules is in [twitch-drops-facts.md](twitch-drops-facts.md).

## Find it by what you see

| You see | Machine |
|---|---|
| Wrong headline in the panel ("Earning", "Not counting", "Stopped earning", "Cannot track") or wrong chip colour | [Verdict](#1-verdict) |
| "Not counting" names the wrong reason, or Reload is offered or not offered | [Stall cause](#2-stall-cause) |
| A hang reported too early or too late, or the hang's age jumps | [Hang clock](#3-hang-clock) |
| An Open streams row label is wrong ("Campaign finished", "Can earn, not credited") | [Channel state](#4-channel-state) and [Player state](#5-player-state) |
| "You left X", or "Stopped earning" after closing a tab | [Leaving the earning tab](#6-leaving-the-earning-tab) |
| Auto-reload reloads too often, never, or its note is wrong | [Auto-reload](#7-auto-reload) |
| All Drops empty, stuck loading, or a tab flashes up | [All Drops list](#8-all-drops-list) |
| PersistedQueryNotFound, or tracking stops after a Twitch deploy | [Query hashes](#9-query-hashes) |
| Minute strip or "N of the last N counted" looks wrong | [Minutes and rate](#10-minutes-and-rate) |

## 1. Verdict
`state.verdict`, written once per poll by `update()` in `lib/tracker.js`. Codes and the fields each
may carry: `VERDICT_CODES` in states.js. A field not listed for a code is left over: never read it.

- `starting`: before the first poll.
- `signed_out`, `api_changed`, `error`: from the poll's error kind. That branch returns early, so
  `tracking`, `lostAt`, `streams` and `session` keep the previous poll's values: unknown is never stalled.
- `earning`: minutes rose within the limit (`STALL_MS`, `DEAD_PLAYER_MS` when every player is
  visibly dead, `NO_STREAM_MS` with no eligible tab). Flags: `slow` (rate under `SLOW_BELOW` over
  `RATE_MIN_MINUTES`), `wasted` (see below), `channel` (Twitch's session name).
- `waiting`: something can earn and the first minute has not landed.
- `stalled`: the hang clock passed the limit; `cause` from `diagnose()`.
- `idle`: nothing open can earn. `lost` (was earning, the tab can no longer), `limited` (cannot
  tell: lookups failed, a badge timer, or the next drop cannot count yet). Only idle carries these.

`wasted` (`wastedCredit()`): the session's drop rose this poll but is already earned, or cannot
finish before its campaign ends, while the credited channel is open here. A quiet poll keeps the
last judgement so the warning does not flicker.

Colour: `verdictTone()` in states.js, for the panel and the chip. The badge (`badge()`), the pill
and notification (`warning()`), the chip text (`chipView()` in chip.js) and the panel text
(`verdictText()` in panel.js) each turn the verdict into words for their own space.

## 2. Stall cause
`verdict.cause`, from `diagnose()` in tracker.js, checked in this order: every candidate not playing
(the player state is the cause), `claim_first` (an earned drop and nothing else in its campaign
started), `too_many`, `second_stream`, else `uncounted`. `STALL_CAUSES` in states.js says, per
cause, whether Auto-reload may act and whether the panel offers Reload.

## 3. Hang clock
Per tab in `state.tabs[tabId]`: `since` (tab seen), `stateSince` (current channel state), `ableSince`
(could earn: eligible and not paused; asleep and frozen keep it running, unknown keeps the old one).
Poll level: `lastGainAt`, `resumeAt` (after a gap longer than `GAP_MS` the clock restarts).
`verdict.since` is derived from these, so it is not a stable id for one hang: a pause poll restarts it.
Anything that must follow one hang across that (Auto-reload) uses its own identity.

## 4. Channel state
`stream.channelState`, from `classifyChannel()`. `CHANNEL_STATES` in states.js; only `eligible` can
earn (`canEarn()`). Companions: `blockedOpens` only for `blocked`, `credited` only for eligible tabs
the session names. A failed lookup is `unknown`, which hides nothing and is never a hang.

## 5. Player state
`stream.playerState`, from `classifyPlayer()`: asleep (tab discarded or frozen by the browser),
no_video, ended, paused, frozen (time not moving, or not ready on first sight), playing. For 5s after
a reading it repeats the last state rather than judge on a fresh tab. Labels and stall messages:
`PLAYER_STATES` in states.js.

## 6. Leaving the earning tab
`earnerTabs`, `closedAt`, `closedName`, `lostAt` in tracker.js. Closing the earning tab sets
`closedAt`; a gain within `CLOSE_SETTLE_MS` still counts as that tab's last minute, a later one means
credit from elsewhere and clears it. An earner tab still open but no longer able to earn gives
`idle` + `lost`.

## 7. Auto-reload
`autoReloadStep()` in settings.js, memo `{ since, tries, lastAt, recoveredAt }` in storage as
`autoReload`, written by background.js. None, trying (1 to `RELOAD_MAX`), given up, recovered.
`sameHang()` is the one identity rule, for the step and the panel's note: the same hang until
minutes come back, or an hour with no reload.

## 8. All Drops list
Stored as `directory` `{ campaigns, at, triedAt, error }` (directory.js, background.js), plus
`directoryTab` so a tab left behind by a dead worker is closed on the next wake. States: never
loaded, fresh, failed with an older list kept, failed with none, loading (worker memory only).

## 9. Query hashes
Stored as `hashes` `{ working, learned }`. Twitch rotates persisted-query hashes; candidates are
tried as working, then pinned in twitch.js, then learned from twitch.tv's own requests.

## 10. Minutes and rate
`state.drops[id]` `{ peak, low, at, session }` (`trackMinutes()`): a lower reading must last
`DIP_POLLS` polls before it is believed; a gap longer than `GAP_MS` re-baselines. `state.timeline`
`{ m, g, w, d }` per wall-clock minute, at most `TIMELINE_MAX`. `creditRate()` sums `d`;
`timelineCells()` (minutelog.js) draws late credit on the minute it belonged to.

## Known rough edges (not bugs today, worth knowing before changing nearby code)
- Three notions of "out of date": the chip's own (`STALE_MS`, "Drops ?"), the panel's (shown as a
  read error), and content.js forcing a poll after `STALE_POLL_MS`.
- `lost` and `limited` are exclusive today, but `warning()` checks limited first and the badge,
  chip and panel check lost first.
- `closedAt` does not expire without a gain, so "You left X" stays while nothing open can earn.
- A forced All Drops reload while one is in flight is ignored, not queued.
- A `working` hash that stopped working stays first in line until another one works.
