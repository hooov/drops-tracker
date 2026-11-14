# Twitch Drops: what is known and how

This is the project's reference of measured facts about Twitch's private GQL API and how Drops behave in practice. Start from the symptom index: find the symptom you are seeing, and the entry says what was measured, what the extension does about it and where the code lives. The later sections hold the API shapes, failure handling and the reasons behind each threshold.

Measured 2026-11-06 on a real account unless marked otherwise. Channel names in examples are placeholders.

## Symptom index
- **Inventory page shows an old percentage**: it does not update after load. It read 79% while the server read 82%. Refreshing only fixes the display.
- **Minutes stop rising while the stream plays fine**: real server-side hangs, seen twice within 16 minutes on 2026-11-06 from about 15:06 UTC. One drop stayed at 195 of 240 for 5 min, then recovered with no action from this side. It then stayed at 198 for at least 5m20s, until sampling stopped. Cause unknown. What the browser tabs were doing at the time was not observed. A third, about 4 minutes, was watched from inside the page on 2026-11-09: the page sent every minute and Twitch accepted each one without counting it, while the same channel was also open in a second browser. See [Measured live](#measured-live-2026-11-09).
- **Is crediting tied to Twitch's integrity check, or what makes a minute count**: see [How a watched minute reaches Twitch](#how-a-watched-minute-reaches-twitch). The minute report carries the integrity token, but in the one hang watched live every report was sent and accepted, with the same channel open in two browsers at the time. Alone, one stream earned 19 of 19 minutes. With a second stream on another channel, it earned 0 in 10.5 minutes, and recovered once that stream closed.
- **Session names a channel but nothing is rising**: `dropCurrentSession` still named the channel throughout that hang. It is not proof of earning.
- **Stuck one minute short of a drop, with Twitch's page reading 99%**: seen once. See [Hang one minute short of a drop](#hang-one-minute-short-of-a-drop).
- **Minutes lost with no visible cause**: not known. See [Why minutes are lost](#why-minutes-are-lost).
- **Cannot track, or calls fail with PersistedQueryNotFound**: Twitch retired a hash. It repairs itself: `extension/background.js` watches Twitch's own page traffic for the four operations and tries those hashes when the pinned ones are stale. Inventory's hash is only sent on the Drops page, so open that once. To pin a new one, edit `PINNED` in `extension/lib/twitch.js`. On 2026-11-06 Twitch's page was already using a different Inventory hash (`3f6e2a...`) from the one first pinned (`8337eb...`), so assume this will happen.
- **"Cannot read Twitch" flickering while progress is fine**: a response can carry good data and an error together. `service error` on `gameEventDrops` hit 4 of 8 real calls, on either hash, with the drop data intact. `parseInventory` in `extension/lib/twitch.js` ignores errors on optional fields, using the error's `path`.
- **Says Signed out while logged in**: a wrong Client-ID gives the same 401 as a bad token when a token is sent. Without a token they differ: 400 for a bad ID, 200 for a good one. `post` in `extension/lib/twitch.js` uses that to tell them apart. A missing `auth-token` cookie while `twilight-user` remains is treated as Twitch having moved the token.
- **A long flat stretch where the player reads paused**: not a Twitch hang. On 2026-11-06 to 07 UTC, one tab (channel Delta) read paused at speed 0 whenever it was in the background, for about 55 minutes: 52 logged minutes with 4 credited. It played each of the three times it came to the front. What paused it is not known, because the log does not record that. It started within a minute of a video starting in another tab (echo_247), with the player muted, but the same tab had played hidden and muted for the five minutes before, so neither alone explains it. Credit runs on for up to about 2 minutes after a pause, so a pause does not show at once.
- **Lost minutes blamed on background or muted**: fixed 2026-11-07. `compareMinutes` in `extension/lib/minutelog.js` counted paused minutes with the rest. It now leaves them out and the panel says how many. Same real log, before and after: muted 26% to 82%, background 45% to 78%, one stream 52% to 95%, total 69% to 87%. Frozen and asleep players still count. Two streams now read 83% against 95% for one, but that includes a 15 minute hang, so it is not a measure of two streams alone.
- **The log stops while a tab is still open**: it only keeps minutes where a stream can earn. In one case the log stopped at 00:56 UTC with the tab reading paused, and the channel was offline when checked at 01:36, so its stream most likely ended then. The exact end time was not checked.
- **No drops listed on a channel, or the chip has no percentage**: by design, see `channelDrops` in `extension/lib/chip.js`. My Drops lists what this channel can earn, or else what another open tab can. A failed channel lookup hides nothing, since that is unknown rather than none. Progress on everything is still in All Drops.
- **Clicking the chip shows nothing, or the panel opens and vanishes within a second, or e2e times out waiting for `#drops-tracker-panel .panel`**: found 2026-11-09. On real popout chat, Twitch's channel points mount about a second after the chat row. `attach` in `extension/content.js` then moves the chip beside them, and it used to close the panel when it did. A click in that first second opened a panel that closed itself. The e2e clicks at once, so it failed every run from 2026-11-09. Now the panel follows the chip (`placePanel`) instead. If it recurs, `scripts/e2e.mjs` prints the host, sheet and timing state. An empty `hostVisibility` there means the panel was removed, not left unstyled. Separately, the panel stays `visibility:hidden` until `extension/panel.css` reports loaded or failed.
- **"<channel> is also playing" on a hang, with no Reload button**: a second stream was playing when minutes stopped. In the 2026-11-09 test, a second stream stopped Drops until it was closed, so this cause is never auto-reloaded. See `diagnose` in `extension/lib/tracker.js` and [Measured live](#measured-live-2026-11-09).
- **Minutes rising, but well under one per minute**: seen once, 2026-11-06 from 15:19 UTC: 15 minutes credited in 38, with the strip alternating added and missed. Measured again straight after: exactly +1 every 60s. Cause unknown. Rising alone is not healthy, so the tracker reports the rate and calls under 75% over 10+ watched minutes "Earning slowly".
- **Red squares in the minute strip while the line under it says every minute counted**: a minute credited late. Twitch credits on its own clock (see [Measured live](#measured-live-2026-11-09)), so one check can find nothing and the next find two. The count sums the minutes added, so it was always right. Until 2026-11-09 the strip coloured each check alone and drew the empty one red; `timelineCells` in `minutelog.js` now gives the surplus to the nearest earlier red square. A red square that stays red was never credited. The Lost minutes totals already counted a late batch in full.
- **Watch Drops lists another game's drops while you watch a channel that is not playing it**: the credited channel had nothing left to list (its channel badge already earned), and the list fell back to every drop in progress. Fixed 2026-11-09 in `channelDrops` (`chip.js`): it now lists nothing and the verdict says what is being credited. See [Which channel Twitch credits](#which-channel-twitch-credits).
- **"Earning", but the minutes go to a drop already earned, or one that cannot finish before its campaign ends**: Twitch picks the channel and kept doing both while another open tab could earn. Since 2026-11-09 the panel, chip and toolbar badge turn amber and name the tab that could earn instead (`wastedCredit` in `tracker.js`). See [Which channel Twitch credits](#which-channel-twitch-credits).
- **Panel looks off next to Twitch**: it follows the Drops & More panel, measured 2026-11-06: 326px wide, sections `--color-background-alt` with `--color-border-base` and 4px radius, cards `--color-background-float`, 40px art, 8px bar in `--color-background-progress-status`, type 18/500, 14/600, 12/400, round 32px icon buttons. Twitch's root font-size is 10px, so use px, not rem.
- **Scrollbars or the wrong font in the panel**: it must stay in a shadow root on the page. An iframe gets neither Twitch's font nor its tokens, and showed scrollbars at the display scaling used in testing.
- **`Drops ?` or "may need your game account linked" on a channel with a sub badge**: fixed 2026-11-06, see [Channel badge campaigns](#channel-badge-campaigns). A badge has no game account and is never in Inventory, so its absence there means nothing.
- **"May need your game account linked", repeated notifications, or dead minutes, while Twitch's page shows the drop rising**: a game campaign can be missing from Inventory while Twitch credits it. Seen 2026-11-12 on a Streamer Awards Minecraft drop (WOW Frog Hoodie), offered on the same channel as the Streamer Awards badge campaign. Why Inventory left it out is not known. Fixed 2026-11-13: when the session names one of the channel's game campaigns with minutes on it, `sessionCampaigns()` in `tracker.js` tracks it like an Inventory campaign. At 0 minutes it stays "not started" and is never a hang.
- **A channel's Drops panel on Twitch lists a watch drop that this calls sub-only or no Drops**: check the campaign's end time first. Twitch's panel loads once with the page and keeps a campaign that has since ended. Seen 2026-11-13: Streamer Awards 2026 Vote ended at 08:00 UTC and left the channel query on the next poll, while the panel opened at 07:56 still showed it.
- **Chip stranded at the far left of the row**: the points can mount after the row. `attach` in `extension/content.js` re-checks placement every tick.
- **"Failed to fetch dynamically imported module: lib/panel.js", or "Denying load of lib/...js"**: a tab opened after a code change but before pressing Reload on the extension. An unpacked extension's files are read from disk at once, but its manifest and content scripts only on Reload, so new code asks for a module the old manifest still blocks. Reproduced 2026-11-06. Reload fixes it, and errors already listed on the extension's card stay until cleared. If it survives a Reload, a module is missing from `web_accessible_resources`, which `tests/manifest.test.mjs` checks.
- **Chip missing from the chat row**: the hook is `[data-test-selector="chat-input-buttons-container"]` in `extension/content.js`. `npm run e2e` fails loudly if real Twitch stops matching it.
- **All Drops says the campaigns page did not answer, or a tab flashes up and nothing loads**: Twitch only gives that list to its own page (see [The All Drops list](#the-all-drops-list)). The hook is `extension/page-hook.js`, which wraps the page's `fetch`. If Twitch stops using `fetch` on that page or renames `ViewerDropsDashboard`, the capture finds nothing and the load times out at 25s. Never measured in a truly hidden tab on a logged-in account: the test browser reported itself visible, so if this fails only in the background, that is why.
- **All Drops does not update after moving to its page inside Twitch**: the hook only runs on a full load of `/drops/campaigns`. It was narrowed from all of `/drops/*` so that it stays off the Inventory page, where drops are claimed, because whether Twitch's integrity check reacts to a wrapped `fetch` is unknown. Measured on real Twitch: its exact code captured the real list with the page rendering normally, though by client-side navigation, not a real load or a hidden tab.
- **A stream reloaded by itself**: Auto-reload hung streams, on by default since 2026-11-09 (Settings tab). Timing and limits are in `autoReloadStep` in `extension/lib/settings.js`. It reloads only the tab the verdict names, and only while that tab is still on a channel. Whether a reload clears a hang has not been measured: the panel reports whether minutes came back, and that note is the evidence to collect.
  - The only real firing so far (2026-11-07 00:19:58 UTC) is no evidence. It hit a tab about 2 seconds after it came back from a 55 minute pause, because the hang was timed from the last gain, before the pause. "Minutes came back" was just the tab playing again.
  - Fixed the same day: a hang now counts from `ableSince` (in `extension/lib/tracker.js`), when a tab last became able to earn, so a tab back from a pause or offline waits as normal. Side effect: pausing and resuming during a real hang restarts its timer.
  - A reload also cleared the player's mute, so expect that.
- **"Campaign finished" on a campaign with drops left**, or **"Not counting yet"**: the next drop has unmet requirements or a later window, so it is left out of the active list. Now a `blocked` state that warns after 4 minutes.
- **"Stopped earning" after closing a stream yourself**: fixed 2026-11-06. It only warns if a tab that could earn is still open, as with a raid or the channel going offline, which keep the tab. A closed tab, or one sent to a non-channel page, reads "You left X". Moving that tab to another channel by hand looks the same as a raid, so it still warns. See `earnerTabs` in `update` in `extension/lib/tracker.js`.
- **Earning names no channel**: only a session whose drop has risen names one. Twitch answers a session for any channel with a campaign, watched or not, so naming the first to answer was wrong.
- **All Drops count differs from Twitch's page**: the list leaves out `EXPIRED`, and anything past its `endAt` even when marked `ACTIVE`. 142 returned on 2026-11-06: 119 `ACTIVE`, 23 `EXPIRED`, 116 inside their dates, 4 still `ACTIVE` after ending.
- **Chip stuck on dot only, or the row jumps to two lines**: the row is `flex-wrap: wrap-reverse`, so it wraps rather than overflows. At the default 340px chat the row is 324px wide and 307px is used with the dot, so the 58px label does not fit. The points group has `margin-right: auto`, which computes to all the free space, so width sums must ignore it.

## Why minutes are lost
Not known. No official explanation was found, and reports conflict on background tabs and muted players. `extension/lib/minutelog.js` records each watched minute and the panel's Lost minutes section compares conditions, to settle this with data.

**A second playing stream does not by itself lose minutes.** Logged on one channel (Delta), 2026-11-06 from 20:54 to 22:30 UTC, alternating one and two playing streams:

- One stream: 44 of 44 minutes credited.
- Two streams: 47 of 53, but 5 of the 6 misses fell in one 11 minute burst (21:16 to 21:26), and a repeat of the same test gave 97%.
- Tab in the background: 24 of 25. Player muted: 6 of 6. Neither was a problem here.

Two streams may raise the risk, or that burst may be unrelated: what differed between the two stretches was not recorded, including which channel the second stream was. On 2026-11-09 a second stream on another channel stopped credit completely for 10.5 minutes, until it was closed; see [Measured live](#measured-live-2026-11-09).

**Open questions:**

- The half-speed stretches earlier that day remain unexplained.
- Brave Shields (or another content blocker) blocking something: the minute log cannot see this, so it needs testing by hand.
- Ads: the ad reading in `extension/background.js` uses `data-a-target` names not yet seen on a real ad, so it can read false during one.

## How a watched minute reaches Twitch
Read on 2026-11-08 from Twitch's web client code (every JS chunk from `assets.twitch.tv` plus the Amazon IVS player's wasm, downloaded as static files with no player run). Steps 1 to 3 were then confirmed live; see [Measured live](#measured-live-2026-11-09) below.

1. **The player counts.** The live player is Amazon IVS compiled to wasm (`amazon-ivs-wasmworker.min-*.wasm`), with its own `MinuteWatchedController` and `PerMinuteTimer`. An hls.js backend exists behind the experiment `hlsjs_playback_adapter`, and a plain `<video>` module does the same. In the JS versions the timer starts on the `playing` event, stops on `pause`, `ended` and teardown, and resumes where it stopped. The first tick lands at a random 0 to 59s after play starts, then every 60s. Buffering does not stop it in the JS versions. The IVS version could not be read.
2. **It reports a `minute-watched` event** with `minutes_logged` and `seconds_offset`. The page adds: `muted`, `volume`, `time_spent_hidden`, `is_ad_playing`, `app_fullscreen`, `chat_visible`, `logged_in`, `user_id`, `broadcast_id`, `backend`, quality and `thermal_state`. So Twitch knows each minute's mute, volume and hidden time. Whether it uses them to decide credit is not known.
3. **It is sent through GQL, not to `spade.twitch.tv`.** The page batches events for 1s and sends them as the mutation `sendSpadeEvents` (`{data, repository:"twilight", encoding:"GZIP_B64"}`) to `gql.twitch.tv/gql`. The headers are the same as every GQL call: OAuth, Client-ID, Client-Session-Id, and **`Client-Integrity` whenever the page holds a token** (`cit_gql_rollout` was on in Twitch's settings). Exception: an event marked `nativeSpadeEnabled` is sent by the player itself, and where that goes was not found.
4. **A failed send loses the minute.** It is a plain `fetch`: the response is never read, so an error or an integrity challenge on it goes unanswered. After 3 failed network attempts, all of the page's analytics stop for 60s, and events in that window are thrown away, not retried.
5. **Twitch confirms over pubsub.** The page knows a message type `drop-progress` with `{channel_id, drop_id, current_progress_min, required_progress_min}` (from Twitch's staff pubsub simulator). It sits next to `user-drop-events` in Twitch's topic list. TwitchDropsMiner listens on `user-drop-events.<userID>` for it, which was not checked here.

**The integrity token.** Fetched at page boot from the integrity endpoint, which is guarded by Kasada (`k.twitchcdn.net`). Kasada guards only that endpoint and the login, signup and auth flow endpoints, nothing on the watch path. The token is refreshed at 90% of its lifetime. A failed fetch is retried 3 times, after about 5 to 10s, 25 to 50s and 125 to 250s. If all fail, the page logs a warning and carries on without a token.

**So, tied to integrity or not?** The minute report rides the same GQL path that integrity guards, and carries the token. Inventory works without it, and so does reading progress. Whether the server refuses to credit a minute sent without a valid token is not known; that happens on Twitch's side.

### Measured live, 2026-11-09
A signed-in tab on a channel (Golf) earning a channel badge, 03:16 to 03:30 UTC, in the app's browser pane. The page's own `gql` calls were logged from inside the page (operation names, which headers were present, the decoded events). Token values were never read out. The badge's minutes came from `DropCurrentSessionContext`, sampled every 15s.

**Not a clean single-stream test.** The same account had the same channel open in Brave the whole time, and a phone was playing another channel. If the phone was on the home Wi-Fi (not confirmed), that is three streams on one IP. The Brave tab sent its own minute reports, which were not logged, so a credit cannot always be tied to the report that earned it.

- Every `minute-watched` went out as `sendSpadeEvents` with `Client-Integrity` set, a 500 character token. Each got HTTP 200 with `statusCode: 204` inside. They came exactly 60s apart, at the same `seconds_offset` (30.27s) each time, and `minutes_logged` counted 1, 2, 3 and on. The native player path was not seen.
- Every other `gql` call the page made also carried `Client-Integrity`.
- Each report says how much video was really downloaded that minute: `transport_segments` 30 (2s segments) and `transport_download_bytes` about 25.8 MB at 720p. So Twitch can tell a playing stream from a page that only sends reports. The report also has `player_state`, `hidden`, `muted`, `volume`, `playback_rate`, `is_ad_playing` and the player's size.
- **Credits land about once a minute, but not on the report's beat.** At +245, +605, +665 and +725s, the session minutes rose within 2s of this tab's report. Two other credits (between +277 and +292s, and between +337 and +352s) matched none of this tab's reports. In the later two-channel run, two credits landed 3s *before* the report they would belong to. So a report is not what immediately triggers a credit; Twitch credits on its own clock, about once a minute.
- **A second player appears for about 43s at a time, even with Turbo.** At +245s Twitch logged `video_ad_pbyp_spawn`, with a muted 191px "picture-by-picture" player. That player sent its own `minute-watched` (`player: "picture-by-picture"`, `minutes_logged` 1) and despawned at +288s. The account has Turbo (`turbo: true` in every report) and Tyler reports seeing no ads, so whether an ad shows is not known; only the event names say "ad". The main player kept reporting throughout. In the clean pass below it happened twice more, and its report never earned an extra minute.
- **A hang, watched live:** after 274 at +352s, minutes stayed flat for about 4 minutes. The reports at +365, +425, +485 and +545s were all sent with the token, accepted with 204, and showed 30 segments downloaded and `Playing`. The count went up again at +607s, with nothing done, and kept rising by 1 a minute. The 4 missed minutes were not made up. After it, credits followed this tab's reports, where before it some had followed the Brave tab's. The hang also began about 75s after the picture-by-picture player despawned.

So this tab did everything right and Twitch did not count its minutes. A missing token or a failed send from this tab is ruled out. It does not show a hang with no cause: two players on one channel, possibly three streams on the IP, and a picture-by-picture spawn all overlap it. The likeliest reading is that Twitch was switching which player it counted, but that is a guess from one case.

**Clean pass, one stream only** (same channel, 03:34 to 03:54 UTC, Brave's tab closed and the phone stopped):
- 19 reports from the main player, and 19 minutes credited (282 to 301). Every minute counted, and there was no hang.
- All reports carried `Client-Integrity` and got 204.
- Each credit landed 0 to 28s after its report, usually within 13s (15s sampling).
- Two picture-by-picture spawns of 43s each (+397s and +1014s) caused no hang and no extra minute.

So one stream on one IP earned every minute for 19 minutes. A single clean pass cannot prove that one stream never hangs.

**Two streams, different channels** (03:56 to 04:12 UTC, both in the pane, same account, nothing else playing). The earning channel (Golf) was in the front tab. A second channel with no campaign (Hotel, Just Chatting, zeroed session, nothing in Inventory moved) was in a background tab.
- **No credit at all for 10.5 minutes** while both played: stuck at 302. All 11 of Golf's reports were sent with the token and got 204, with 30 segments each and `Playing`. Hotel's 11 reports (`hidden: true`) were also accepted. The session kept naming Golf throughout, so it is not proof of earning (as above).
- **Closing Hotel brought credit back within about 2 minutes.** It was closed at +642s. The report at +693s was not counted, the next was (303 by +765s), and then 1 a minute: 303 to 306 by +930s.
- This **conflicts with 2026-11-06**, when two streams earned 47 of 53 minutes (see [Why minutes are lost](#why-minutes-are-lost)). What differed is not known: that day's second channel, which tab was in front, and whether it was the same browser were not recorded.

Taken together: a second playing stream, whether on the same channel or another, is the only condition seen to stop credit live. Here it stopped it completely, not just slowed it. A reload of the earning tab was not tried; closing the other stream was what worked.

To repeat this measurement, use a stream that is already open: the DevTools Network panel, filtered to `gql`, shows each `sendSpadeEvents` call. Never open an extra stream to do it (see Limits). The extension must not read, copy or send any of this: its rule is read-only, no simulated watching and no token replay (CONTRIBUTING.md).

### Which channel Twitch credits

From two Copy debug info bundles taken in Tyler's own browser on 2026-11-09, 13:38 to 14:24 UTC, not the pane. Channel names replaced: Golf (a channel badge campaign, as above), India (Marvel Rivals), Juliet (World of Tanks).

- **Twitch kept crediting a channel badge already earned.** Golf's watch-time badge needs 360 minutes; the session reported 362, then 363, with the timeline rising about one a minute. Real credit that bought nothing. Twitch lists the badge as owned, so the tracker reads Golf as `finished`, and before the fix the panel said "Earning on Golf" over a list of unrelated drops in progress.
- **It kept that channel ahead of one that could earn.** India, with 290 minutes left on its last Marvel Rivals drop, was open and playing from 14:18:50. Over the next 6 minutes the minute log credits India once: Marvel Rivals went 69 to 70 while the badge went 362 to 363.
- **Then it picked a drop that cannot finish.** With Golf closed and Juliet opened, Twitch credited Juliet's 180-minute drop at 1 of 180, with about 95 minutes left in its campaign. India, still eligible and playing, got nothing.
- **Credit kept landing with three streams playing** (about 2 minutes with `p: 3` in the minute log), and with two. The two-stream test above stopped credit for 10.5 minutes. Not settled.
- **There is no known way to choose.** Twitch's help page says one channel at a time and names no control, and nothing in the crediting path above selects one. Which of several eligible channels it picks is not known. The only lever seen is stopping the stream it picked, which is what the amber warning says.

## Hang one minute short of a drop
Seen once, 2026-11-06. A 120 minute drop stuck at 119 from 22:53 UTC, with Inventory and the session agreeing and the player at full speed. Twitch's page read 99%, which can look finished. A pause or reload around 22:59 did not restart it. The second open stream was closed at about 23:06, and credit resumed at 23:08 after 15 flat minutes. Twitch recorded the grant at 23:08:10, the same minute credit resumed.

Three things line up with the hang ending, and they cannot be told apart yet:

- the second stream closing at about 23:06,
- the campaign's game account being linked in the same window (exact time not known),
- the hang simply ending by itself.

**Open hypothesis:** Twitch holds a drop back before granting it. This rests on one case, and the hangs at 195 and 198 of 240 were not at a threshold, so it cannot explain every hang. The same campaign's later drops, at 240, 360 and 480 minutes, can test it.

Linking is not needed to earn in general: drops on unlinked campaigns still reached earned. Whether linking is ever needed to claim is not known.

## Limits
- **Drops: one channel and one campaign at a time.** Twitch's help page ("How Drops Work") states both. More tabs do not speed it up. Measured: 1 minute per about 60s while two eligible channels were open, though only for about 100s.
- **Two streams per IP is a different rule.** It is reported for viewer counts, not Drops: with more than two open, none are said to count (botcrawl.com, Oct 2025, citing a Twitch message to partners; not verified against a Twitch document). Users report Drops stalling above two. Unconfirmed: progress kept rising during about 100s with three open, too short to settle it. Measured 2026-11-09: with **two** playing on one account, the second on a channel without a campaign, credit stopped for 10.5 minutes and came back about 2 minutes after the second was closed. This conflicts with 2026-11-06 (two streams, 47 of 53 credited), so the threshold is not settled. Later the same day, three playing in Tyler's browser kept credit landing for about 2 minutes ([Which channel Twitch credits](#which-channel-twitch-credits)). See [Measured live](#measured-live-2026-11-09). Do not open extra real streams to test this: a third stream on your IP can cost real progress, which is why `scripts/e2e.mjs` fakes channel pages.
- A channel only helps if it has a campaign. Live with no campaign returns `viewerDropCampaigns: null`.

## API shapes (`gql.twitch.tv`, persisted queries, Client-ID of the web client)
- `Inventory`: `currentUser.inventory.dropCampaignsInProgress[]`, each with `timeBasedDrops[].self.{currentMinutesWatched,dropInstanceID,isClaimed,hasPreconditionsMet}`. `currentMinutesWatched` is capped at the requirement. Works without a client-integrity token.
- Drops in one campaign tick together: two drops read 66 and 66 at once.
- `dropInstanceID` set and `isClaimed` false means earned, not claimed. Twitch help says claimable for 7 days after campaign end.
- `DropCurrentSessionContext` has three shapes. Empty `channelID`: `null`. Unrelated channel: zeroed object with `channel: null`. Channel with a campaign: the real session, naming the credited channel, even when that is not the ID you asked about.
- `DropsHighlightService_AvailableDrops(channelID)`: what a channel offers. Whether it hides campaigns the user already finished is unverified. A campaign listed there but missing from Inventory reads as "not started", which can say "may need your game account linked" but never Hung, unless the session reports minutes on one of its drops (see the symptom index).
- Twitch's newer Inventory hash replaces `gameEventDrops` with a paged `gameEventDropsConnection` (18 edges, `hasNextPage: true`). Its drop fields match. The older hash returns the full list, which is why it is tried first.
- Real failure shapes, all HTTP 200 unless noted: retired hash `{errors:[{message:"PersistedQueryNotFound",extensions:{code:"PERSISTED_QUERY_NOT_FOUND"}}]}`, per op within a batch. Missing token: `currentUser: null`, no errors. Unknown channel: `user: null` and `channel: null`, no errors. Bad token or bad Client-ID with a token: HTTP 401, non-array body. Bad or missing Client-ID without a token: HTTP 400.

## Channel badge campaigns
Channels can run their own badge campaigns (`brandName: "CREATOR_LED_BADGE_CAMPAIGN"` from `SideNavCreatorBadgeDrops`). Measured on three real ones, 2026-11-06:
- `DropsHighlightService_AvailableDrops` lists them with `game: null`, which is how the tracker recognises one. Real game campaigns carry a `game` object (checked on two live Marvel Rivals channels). The check is exactly null, so the field going missing cannot silence a game campaign.
- Two kinds: sub-only (one drop, `requiredSubs: 1`, watch minutes 0), and mixed, with separate sub and watch drops (1 sub or 180 min; 5 subs or 1440 min). Twitch's own text is "Subscribe or watch to earn different Drops!".
- **Never in Inventory**, on either hash. `dropCurrentSession` is the only place their minutes appear: mixed gave 3/180 and 3/1440 on the two channels asked about. Sub-only gave the zeroed session.
- **Session minutes do rise on a badge.** Sampled every 30s from 19:22 UTC: the badge on the channel being watched (Charlie) went from 3 to 5 over about 6 minutes, while another channel's badge stayed at 3 throughout, so it is not a value shared between channels. Whether Charlie's tab was open and playing the whole time was not observed. It then stayed at 5 until at least 19:31, cause unknown.
- A badge with a watch timer is tracked like any drop: open and playing with flat minutes reads as Hung after the normal 4 minutes. The session answers for a channel that is not being watched, so a reading alone proves nothing: a session-only drop's first reading is always a baseline, unlike Inventory, where a new drop means Twitch just started it.
- A timer badge with no session reads "Cannot track this badge" after 4 minutes. What the session returns once a badge is earned has not been seen, so this can fire on a badge you already own. `BadgeCollectionEarnedRewards` (`e50adec0...`, seen on the Inventory page) may be able to rule that out; not tried.
- One badge campaign ran on a channel streaming Grand Theft Auto V with `game: null`, so a badge campaign has no category of its own to compare the stream with.
- All 142 campaigns in `ViewerDropsDashboard` had a game, so All Drops does not list these. `SideNavCreatorBadgeDrops` needs channel IDs, so no sitewide list was found, and the Badges tab is per channel on purpose.
- Sub progress is not reported anywhere checked, so a sub drop shows what it takes and no bar. Nor does the tab know whether a badge is already earned, unless watch minutes have reached the requirement.

## The All Drops list
`ViewerDropsDashboard` (hash `69750554...`, seen 2026-11-06) is the only query found that lists every campaign. Called with the extension's plain headers it returns HTTP 200 and `{errors:[{message:"failed integrity check",extensions:{code:"IntegrityCheckFailed"},path:["currentUser","dropCampaigns"]}]}`, on both the new hash and an older one, even though Inventory passes without the check.

So the extension does not call it. Copying or replaying Twitch's integrity token would be working around its anti-bot check, and it must stay that way. Instead `extension/page-hook.js` reads the answer Twitch's own page received on a normal load, and `extension/background.js` opens that page in a background tab when the tab is opened and the saved list is old.

- That page: 0 `<video>` elements, list arrived in 1.4s through `fetch`, about 180 KB.
- Each campaign has game, owner, dates, status, `self.isAccountConnected`, `accountLinkURL` and each drop's minutes and subs. It has **no reward names**: those need a per-campaign query, so the list does not show them.
- `isAccountConnected` was false on 138 of 142, including campaigns earned without linking, so it is not a warning, only a quiet "Linked" tag when true.
- `rewardCampaignsAvailableToUser` holds separate reward campaigns with `isSitewide`, `status: "UNKNOWN"` and `minuteWatchedGoal`. It answered even when the integrity check failed.
- **Directory pages have `<video>` elements**: `/directory/category/<slug>` had 20 on one load, none with a source or playing, and 0 on others. They appear to be placeholders for hover previews. A `Browse streams` link only opens when clicked, but never open one automatically.
- `/directory/game/<name>` redirects to the category and drops its query string, so a link cannot pre-filter to Drops. `?tl=DropsEnabled` works on `/directory/category/<slug>` (30 of 30 cards), but this list has no slug.

## What each Twitch failure does
The rule: unknown is never Stalled, and blind never looks green. Tests in `tests/` and `scripts/e2e.mjs` cover each of these.

| Twitch-side change | What you see |
|---|---|
| Inventory hash retired | Tries other pinned, then learned hashes. Otherwise Cannot track, warning at once |
| Channel lookup hash retired | Progress still works. Rising reads Earning, otherwise Cannot check streams |
| Field fails inside a response | Ignored if optional. Otherwise Cannot read Twitch |
| Fields renamed or moved | Cannot read Twitch, or Cannot check this channel. Never "no Drops" or Hung |
| Unknown campaign status | Falls back to the dates |
| Minutes flapping or a drop vanishing for a poll | Not counted as progress |
| Client-ID changed, or token cookie moved | Cannot track, not Signed out |
| Integrity check required | Cannot track |
| 5xx or network failure | One retry, then Cannot read Twitch, warning after 3 min |
| 429 | Cannot read Twitch. No extra backoff: the poll is only a few requests a minute |
| Stalled response or hung tab | Timed out, and the next poll runs normally |
| `<video>` moved out of reach | "Cannot see a player" after the full 4 min, not a dead player at 2 |
| Chat row selectors changed | Chip disappears. Badge, notification and pill carry on |
| Session query fails on a badge channel | Cannot check this channel, not "no minutes reported" |
| Session query fails anywhere else | Progress still read from Inventory. Earning names no channel |
| Campaign list blocked, renamed or moved | All Drops says it could not load and keeps the last list with its age. Tracking is untouched. Never "no campaigns" |
| Campaigns page never answers | Times out at 25s, closes its tab, offers a link, retries at most every 5 min unless asked |

Known gap: a new top-level Twitch route with a playing video reads as a channel that does not exist, so it shows as Offline.

## Why the thresholds
- Auto-reload at 6 min, then 10 min apart, 3 times per hang: past the measured 5 min hangs, one of which recovered by itself, and capped because a reload interrupts the stream and may not help.
- Poll every 60s: the shortest useful alarm, and credit lands about every 60s.
- Not counting after 4 min without a gain: two or three misses happen, and a hang of 5 min was seen.
- 2 min when every eligible player is visibly dead, since no tick can be coming.
- 2.5 min with no eligible tab, so "earning" stops soon after the channel loses its drops.
- More than 3 min without good data restarts the clock: the PC slept or Twitch was unreachable, so nothing can be said about those minutes.

## Sources
- https://help.twitch.tv/s/article/mission-based-drops
- https://botcrawl.com/twitch-view-count-limit/
- https://github.com/DevilXD/TwitchDropsMiner (`constants.py`, `twitch.py`): operation names and hashes, and independent notes that Twitch sometimes stops reporting progress.
