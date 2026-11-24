# State machines

Every state the extension keeps, what moves it, and where. The states themselves (verdict codes,
stall causes, channel and player states, and what each means for the UI) are declared once in
[`extension/lib/states.js`](../extension/lib/states.js); `tests/states.test.mjs` fails when
`tracker.js` can produce one that is not declared. This file is the map around those tables.
Measured Twitch behaviour behind the rules is in [twitch-drops-facts.md](twitch-drops-facts.md).

## Find it by what you see

| You see | Machine |
|---|---|
| Wrong headline in the panel ("Earning", "Not counting", "Stopped earning", "Cannot track", "Badge likely earned", "Drop likely earned") or wrong chip colour | [Verdict](#1-verdict) |
| A drop with no claim step (a BADGE reward) finished and nothing was said, or "Drop likely earned" on one not earned | [Channel state](#4-channel-state), `state.leftDrops` |
| "Minutes are rising from a stream outside this browser" or another drop's percentage right after a reward campaign finished, or finishing one said nothing | [Channel state](#4-channel-state), `state.rewardsDone` |
| "Cannot tell if finished", or a finished reward campaign reading "Not counting yet" | [Channel state](#4-channel-state), `reward_unproven` |
| "Not counting" names the wrong reason, or Reload is offered or not offered | [Stall cause](#2-stall-cause) |
| A hang reported too early or too late, or the hang's age jumps | [Hang clock](#3-hang-clock) |
| An Open streams row label is wrong ("Campaign finished", "Can earn, not credited") | [Channel state](#4-channel-state) and [Player state](#5-player-state) |
| A daily drop done for today missing from Watch Drops, or its clock pill / "Opens again at" wrong | [Channel state](#4-channel-state), `state.resting` |
| A reward drop's card names the list's reward ("GTA DVD Chest") or the wrong day, not the badge Twitch's panel shows | [Channel state](#4-channel-state), storage `dayRewards` |
| "You left X", or "Stopped earning" after closing a tab | [Leaving the earning tab](#6-leaving-the-earning-tab) |
| Auto-reload reloads too often, never, or its note is wrong | [Auto-reload](#7-auto-reload) |
| All Drops empty, stuck loading, or a tab flashes up | [All Drops list](#8-all-drops-list) |
| PersistedQueryNotFound, or tracking stops after a Twitch deploy | [Query hashes](#9-query-hashes) |
| Minute strip or "N of the last N counted" looks wrong | [Minutes and rate](#10-minutes-and-rate) |
| A channel just opened shows nothing, another channel's drops, or another tab's "Not counting yet" | [Verdict](#1-verdict) (which tab), [Minutes and rate](#10-minutes-and-rate) (polls) |
| "Earning slowly" on a channel that counts every minute | [Minutes and rate](#10-minutes-and-rate) |
| A channel's Watch Drops empty before its first minute | [Channel state](#4-channel-state), `state.upcoming` |

## 1. Verdict
`state.verdict`, written once per poll by `update()` in `lib/tracker.js`. Codes and the fields each
may carry: `VERDICT_CODES` in states.js. A field not listed for a code is left over: never read it.

- `starting`: before the first poll.
- `signed_out`, `api_changed`, `error`: from the poll's error kind. That branch returns early, so
  `tracking`, `lostAt`, `streams` and `session` keep the previous poll's values: unknown is never stalled.
- `earning`: minutes rose within the limit (`STALL_MS`, `DEAD_PLAYER_MS` when every player is
  visibly dead, `NO_STREAM_MS` with no eligible tab), unless no tab can earn and the channel that
  gain landed on (`state.lastGainLogin`) has had its reward campaign seen finishing since. Flags: `slow` (rate under `SLOW_BELOW` over
  `RATE_MIN_MINUTES`, counted only since the credited channel last changed, carried as `rate`; see
  section 10), `wasted` (see below), `channel` (Twitch's session name).
- `waiting`: something can earn and the first minute has not landed. Also the first `STALL_MS` of
  a channel that cannot count yet (`unstarted`, `reward_unproven`, `badge_unseen`, `blocked`),
  except a `blocked` one with `blockedOpens`: Twitch's own opening time is said at once.
- `stalled`: the hang clock passed the limit; `cause` from `diagnose()`.
- `idle`: nothing open can earn. `lost` (was earning, the tab can no longer; not when the tab that
  was earning, by the last session or `lastGainLogin`, is itself `finished` or `badge_left`; judged
  before `badgeLeft` and `dropLeft`, which last as long as their campaign and would hide it for
  another tab), `limited` (cannot
  tell: lookups failed, a badge timer, or the next drop cannot count yet), `badgeLeft` (a channel
  is `badge_left`: "Badge likely earned", grey, no warning, the last reading said), `dropLeft` (a
  `finished` channel whose game drop is in `state.leftDrops`: "Drop likely earned", the same, and
  the chip's title carries the message), `rewardDone` (the `finished` channel the last minute
  landed on, whose reward campaign is in `state.rewardsDone` since: "Campaign finished", grey, the
  same, until a minute lands anywhere; after `lost` and a tab just left). Only idle carries these.
  `lost` lasts `LOST_SHOWN_MS` (10 min) from `lostAt`, then settles to a plain idle and does not
  come back until something earns again: left amber with nothing to act on, it read as a fault.
- Which tab an idle headline names (not counting yet, reward, badge likely earned): the tab in
  front (`frontFirst()`: a player that answered `hidden: false`, newest `stateSince` first), else
  the first in tab order. For not counting yet the grace (`STALL_MS`, shown as `waiting`) is that
  tab's own. Before 2026-11-22 a background tab past its grace put its "may need your game
  account linked" on every channel opened after it. The warning key is the same whichever tab is
  named, and `events()` keeps the notified key through a `waiting` verdict, so a tab opened in
  front of a warning badge tab does not bring its notification back.

`wasted` (`wastedCredit()`): the session's drop rose this poll but is already earned, or cannot
finish before its campaign ends, while the credited channel is open here. A quiet poll keeps the
last judgement so the warning does not flicker. A session drop the reward inventory says repeats
is never "earned" from its session minutes (a running total) unless its window is still open at
its requirement, every repeat is granted, or Twitch's `nextEligibleAt` is still ahead
(`openWindowUnknown()`). With no inventory reading for it, a `:total` mark on the drop counts as
proof of a running total, so it is not judged either. `wasted.actionable`: another open tab can
earn (asked again on every poll, quiet ones too, through `wastedView()`). Only then, or for
`too_late`, is it amber; already earned with nothing else to earn is grey "Done for today on X"
(with the next start from the reward inventory) or "Already earned on X", and the chip reads
"Done" unless a drop on that tab is still in progress. "Close tab" shows only on the credited tab.

Colour: one meaning per colour (agreed with Tyler 2026-11-20): `ok` green earning (slow too,
`SLOW_TONE`), `warn` amber you should do something (the panel says what: too late, close a tab,
stopped earning, log in), `bad` red Twitch stopped counting, `unknown` grey dashed ring with "?"
the tracker cannot see (cannot read Twitch, API changed, cannot check streams, a badge with no
minutes, the chip out of date), `idle` grey nothing to do (including "Not counting yet"), `wait`
blue checking, `info` purple a reward to claim and nothing else. `verdictTone()` in states.js is
the one source; the toolbar takes its colour from `TONE_COLORS[verdictTone(v)]`, and
`tests/tones.test.mjs` checks panel, chip and toolbar agree for every state. A new tone needs a
rule in panel.css and in content.js's chip CSS, or it falls back to plain grey without an error.
The badge (`badge()`), the pill and notification (`warning()`), the chip text (`chipView()` in
chip.js) and the panel text (`verdictText()` in panel.js) each turn the verdict into words for
their own space. "Not counting yet" raises no pill or notification; "Cannot check streams" only
after `GAP_MS` (its verdict carries `since`).

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
earn (`canEarn()`). Minutes override it: a tab whose session-named drop rose this poll, on a
campaign its lists do not hold, is `eligible` with that campaign in `campaignIds` and its
lists' own state in `listedState` (`reward` instead of `eligible` for a never-judged reading).
`state.placed` is kept through polls that say nothing and ends when the credit moves, the drop
finishes, the lists hold it, the tab goes, the stream's category (`channel.gameId`) changes, or
`PLACED_KEEP_MS` pass with no rise. Tabs already
`reward`, `unknown`, `offline` or `not_channel` are left alone. Each case is logged in
`state.creditUnlisted`, last 10. Companions: `blockedOpens` only for `blocked`, `credited` for the tab the session names when
it is eligible or its drop is a reward running total (`creditedCampaign` in state is that drop's
campaign, which the badge, chip and finish times compare against), `pendingDrop` only for `unstarted`/`badge_unseen` when a campaign built from the
session has a drop Twitch reports no minutes for (`pendingDrops()`, kept as `state.pending`, listed
in Watch Drops on its channel without a bar and never in `active`). An `unstarted` channel's game
campaigns that no session names (not badges, not reward campaigns, not owned, not ended) are kept
as `state.upcoming` (at most `UPCOMING_MAX`), listed the same way, but only when no other tab's
progress is shown, as for a resting drop. `reward`: a campaign read from
Twitch's reward inventory (`rewardCampaigns()`, active rows marked `unjudged`, except a channel's own non-repeating badge read fresh that poll, which is judged and makes its channel `eligible`) or a session running
total. Never a candidate, so never waiting, stalled or reloaded; verdict `idle` + `reward` when
nothing rises, `earning` when either reading rises; `rewardOpens` on the stream when today's reward
drop is earned and the next can start later. A repeating drop is named for the day's reward (name
and art) when Twitch's channel page has given its day rewards, two or more (storage `dayRewards`, from
`page-hook.js`; `dayIndex()` picks the day as Twitch's panel does), else for the list's reward. That drop is also kept as `state.resting`
(`restingDrops()`, from `restUntil` set in `rewardCampaigns()`: Twitch's `nextEligibleAt`, else the
window end), never in `active`. Watch Drops lists it on its own channel only, full with a clock pill
counting down (`countdown()` in directory.js): beside that channel's other drops, or alone when no other
tab's progress is listed (never under "Watch Drops on <other tab>"). The popup off a channel shows the
session channel's. It leaves the list once
the time passes, every repeat is granted, or the time falls after the campaign end. Between that time and
the next poll the pill reads "Open now". The reward inventory answer is kept as
`state.rewardInv` (`{ at, groups }`, held `REWARD_HOLD_MS` after a failed call) and the last
call's outcome as `state.rewardCheck`. A failed lookup is `unknown`,
which hides nothing and is never a hang. A held answer keeps a channel's own badge judged and its
tab `eligible` with its `ableSince`, but its drops are `held`: a poll whose only earnable drops
are held stays `waiting` (or keeps a `stalled` a fresh reading raised) and is not counted as
watched (audit, 2026-11-22: unjudged, the tab flipped to `reward` and the clock reset). It is asked when a channel offers a campaign Inventory
leaves out, at least every `REWARD_HOLD_MS` while any channel is live, and once after a window
it read has ended (`rewardsDue()`; after a failed ask, at most every `REWARD_RETRY_MS`). A
campaign read from `ChannelDropsCampaigns` (any one whose groups earn on this channel, dismissed
or not; `earnsHere()` in twitch.js) counts as "offered" like any other, so a
channel with one that Inventory leaves out asks the reward inventory every poll, as a listed one
always did. `state.unplacedBadges`
(`unplacedBadges()`): its badge campaigns that no open channel lists, each with its first and
latest minutes; `rising` when they went up. Moved only by a fresh answer, and held when an open
channel's list could not be read. It changes no channel state or verdict: a rising one is said at
the top of the Badges tab, and all are counted in Debug.

`reward_unproven`: a reward campaign that names no game, with no progress in any list, not owned and
not claimed: finished and not started look the same. Headline "Cannot tell if finished" after the
same grace as `unstarted`, grey, no warning, no toolbar mark; `unprovenReward` on the stream names
the campaign. `unstarted` on the same channel wins. A reward campaign counts as finished when every
watch group is owned or in storage `claimedGroups` (at most `MAX_CLAIMED_GROUPS`, dropped when the
campaign ends), which `parseClaimedGroups()` fills from the channel page's
`DropChannelCampaignsProgress` answer (`page-hook.js`): CLAIMED with every repeat granted. A fresh
answer replaces its own groups, so a flag it no longer supports (another account) goes; one with an
error changes nothing. Checked last, so minutes or an in-progress reading win over a flag.

`state.rewardsDone` (`rewardsDone()`): reward campaigns seen going from in progress to finished.
`state.rewardsCounting` (`rewardsCounting()`) is each reward campaign an open channel offers that the
reward inventory listed. One of those moves to `rewardsDone` when a later answer (`state.rewardInv`,
held through failed calls; not one cut short at `MAX_REWARD_GROUPS`) leaves it out, nothing in `active` or `pending` reads it, and
every watch group is owned or claimed. One finished before it was ever seen counting is in neither:
its channel reads `finished` with the plain "Not earning". `events()` notifies once per campaign
("Campaign finished", type `earned`), remembered in `state.notifiedRewards`. An entry ends when the
inventory lists the campaign again or it ends; newest 20 kept in each list.

`state.leftBadges` (`leftBadges()`): badge groups seen leaving the in-progress list, `{ minutes,
readAt }` of their last reading. Only a transition counts: listed in the last good answer, absent
from this poll's fresh one (not one cut short at `MAX_REWARD_GROUPS`); back in the list clears it;
newest 20 kept. Within `LEFT_NEAR_MINUTES` (2) of the requirement it reads as likely earned: a
channel badge whose every timed drop is like that makes its channel `badge_left` instead of
`badge_unseen`, and the Badges tab line says "Likely earned". Further off, the line says it left
and why is unknown, and the channel stays `badge_unseen`.

`state.leftDrops` (`leftDrops()`): the same rule for a game drop, from Inventory. `state.nearDone`
(`nearDrops()`) is each poll's Inventory drops in `active` within `LEFT_NEAR_MINUTES` of their
requirement (60 of 60 included), plus earlier ones Inventory has let go of while another list
still holds them (the session naming the drop rebuilds it in `active`). One of those that a later
good poll finds in no list (`active`, `unclaimed`, `pending`, `resting`) and not listed unclaimed
by Inventory, before its window ends, is recorded: likely earned. Only Inventory's own drops start
a candidate, since a drop built from the session or the reward inventory lapses whenever its tab
closes or a lookup fails. Inventory listing it as claimed counts as gone (no claim step was seen). A channel whose every watch drop of a game campaign is there
reads `finished` (not `unstarted`, "may need linking"), with nothing re-listed in `upcoming`, and
the idle verdict is `dropLeft`. Its Open streams row reads "Drop likely earned" too, and My Drops
keeps a full card for it (`leftCards` in chip.js, from the stream's `leftDrop`; never in
`channelDrops`, so the chip's percentage ignores it). `events()` notifies once per drop ("Drop likely earned", type
`earned`, not a warning), remembered in `state.notifiedLeft` apart from `leftDrops`, so a drop
listed again for a poll is not announced twice. Entries end when Inventory lists the drop
unclaimed again or its window ends; newest 20 kept, 50 notified IDs. Seen 2026-11-22: RuneScape Bones, a BADGE
reward with no claim step, left at 59 of 60 with nothing said, and Tyler had it.

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
`DIP_POLLS` polls and `DIP_MS` (`lowAt`) before it is believed, so extra polls (a page asking for a
check, below) cannot shorten it; a gap longer than `GAP_MS` re-baselines. `state.timeline`
`{ m, g, w, d }` per wall-clock minute, at most `TIMELINE_MAX`; `w` (watched) needs a tab able to
earn for a full minute (`FULL_MINUTE_MS`, from `ableSince` or `resumeAt`) or credit landing, since
a first check is only a baseline. `creditRate()` sums `d`;
`timelineCells()` (minutelog.js) draws late credit on the minute it belonged to. `state.rate` covers
the whole strip and is what its caption says; `verdict.slow` is judged on the minutes since the
credited channel (`rateLogin`) last changed (`rateFrom`, a minute number), so a channel just opened
is not "slow" from the last one's hang. A poll with no credited channel known changes neither.

Polls: the alarm once a minute, plus a check asked for at once by a page whose channel the last
poll did not see, or that comes to the front after being seen behind (`checkNeeded()` in chip.js,
once per reason and channel per page), spaced `SOON_GAP_MS` (10 s) apart by the worker with one
timer. Opening the panel and the toolbar popup also poll.

## Known rough edges (not bugs today, worth knowing before changing nearby code)
- Three notions of "out of date": the chip's own (`STALE_MS`, "Drops ?"), the panel's (shown as a
  read error), and content.js forcing a poll after `STALE_POLL_MS` (a separate path from
  `checkNeeded()`).
- `lost` and `limited` are exclusive today, but `warning()` checks limited first and the badge,
  chip and panel check lost first.
- `closedAt` does not expire without a gain, so "You left X" stays while nothing open can earn.
- A forced All Drops reload while one is in flight is ignored, not queued.
- A `working` hash that stopped working stays first in line until another one works.
