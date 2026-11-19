# Contributing

Thanks for looking. This file is short on purpose: it is the list of things that are easy to get wrong here.

## Before you send a change
Run all three and make sure they pass:

```bash
npm run check
npm test
npm run e2e
```

New behaviour comes with a test. A test for a bug should fail on the old code first: run it before the fix and see it fail.

Failing on the old code proves the test sees a change, not that the new expectation is right. Take the expected value from what Twitch did and what the user should see, never from the fix. On 2026-11-19 a test written to match a fix ("a running total is never wasted") locked in a regression that switched a real warning off, until `tests/all-views.test.mjs` caught it. Every clause a fix adds needs a reason from a captured case; a fix that adds an extra rule "to be safe" is how that one happened.

## Rules that bite
- **Rising minutes are the only proof of earning.** `dropCurrentSession` keeps naming a channel during a hang, and Twitch answers a session for channels you are not even watching. Never derive "earning" from it.
- **Unknown is never stalled.** A failed or partial poll has its own verdict (`error`, `api_changed`, `signed_out`, `limited`). Calling it Hung trains people to ignore the warning. Before changing failure handling, read "What each Twitch failure does" in [docs/twitch-drops-facts.md](docs/twitch-drops-facts.md), and test against the real response bodies in `tests/fixtures/`. Real failures were not what you would guess: one response often carries good data and an error together.
- **Read-only, always.** No claiming, no simulated watching, no replaying Twitch's integrity token. The All Drops list is read from the answer Twitch's own page receives for this reason.
- **Never open real streams to test.** Each playing stream takes one of the few slots Twitch allows per IP, and a third can cost real progress on the streams you are actually watching. `scripts/e2e.mjs` fakes channel pages. To inspect real chat markup, use `twitch.tv/popout/<login>/chat`, which has no video.
- **The auth token stays in memory for one request.** Never store, log or return it. The e2e test checks that it is not in extension storage.
- **Every in-memory or stored collection needs a stated bound** (cap, prune or TTL), written next to it. The service worker and storage live for weeks.
- **Pure logic stays pure.** `extension/lib/*.js` other than `panel.js` must not touch `chrome.*`, so it stays testable in Node.
- **A new source of minutes changes every view, not one.** A reward-inventory reading, a session running total or a new query changes what "credited", "eligible" and "judged" mean, and each is read in several places: `classifyChannel`, `wastedCredit`, `creditedCampaign` and `badge()` in `tracker.js`, `channelDrops` and `chipViewOf` in `chip.js`, and the panel's finish times. On 2026-11-19 a channel badge on a reward channel broke four of these (a false "wasted" warning, a bare ring on its tab and on a second tab, no stall warning), found one bug report at a time. With a new source or state, grep those for the flag you changed, and write one test from the real capture that checks all of them at once: headline, wasted warning, chip percentage on that tab and on a second tab, toolbar badge, and a stall when the minutes go flat.
- **A new state goes in `extension/lib/states.js` first.** A verdict code, stall cause, channel state or player state, with what it means for the UI (label, colour, whether a reload helps), is declared there once and read everywhere. `tests/states.test.mjs` fails when `tracker.js` produces one that is not declared. How each state moves: [docs/state-machines.md](docs/state-machines.md).

## Adding a module the panel imports
Content scripts load panel modules by URL, so every file under `extension/lib/` the panel reaches must be listed in `web_accessible_resources` in `manifest.json`. `tests/manifest.test.mjs` checks this. After a manifest change, reload the extension: open tabs keep the old manifest until then and fail with "Failed to fetch dynamically imported module".

## An e2e wait that passes at once
Never pass an async function to Playwright's `waitForFunction`: it returns a Promise, which counts as truthy, so the wait passes immediately whatever the value (measured 2026-11-19: an always-false async predicate "passed" after 11ms; five e2e waits had been checking nothing). Use `until(page, fn, arg)` in `scripts/e2e.mjs`, which polls with `evaluate`. `tests/e2e-waits.test.mjs` fails if the pattern comes back.

## Testing in your own Brave
Checking a change against real Twitch before it ships, without opening extra streams:
- Reload the extension at brave://extensions, then the Twitch tab, so the page sends its queries again.
- Copy debug info (Settings, Developer mode) holds the state, the minute log and `pageOps`, the operations Twitch's page sent. A query Twitch moved data to shows up there.
- Snippets that read or change the extension's storage go in the **service worker** console: brave://extensions, the "service worker" link on the Drops Tracker card. The Twitch page's own console has no `chrome.storage`. Wrap them as `await (async () => { ... })()` so they print their result and can be run twice.
- No desktop notification: in that console, `await chrome.notifications.getPermissionLevel()` should say `granted`, and a `chrome.notifications.create` call should show one. If it does not appear, Windows is hiding it: Brave in Windows Settings > System > Notifications, and Do Not Disturb off (hit on 2026-11-19).
- Check every view the change can reach, not only the one reported: the panel headline, the chip on the channel's own tab and on a second tab, the toolbar badge and the Badges tab.

## Adding a captured fixture, or e2e failing days later with a campaign "finished"
`scripts/e2e.mjs` and `scripts/screenshots.mjs` run against the real clock, so they load fixtures through `loadFixture` in `scripts/fixtures.mjs`, which moves every timestamp forward by the time since capture. Never read a fixture there with plain `JSON.parse`: it passes on capture day and fails once a real campaign ends. All current fixtures share one capture time (`CAPTURED_AT`). A fixture captured on another day needs its own capture time there, or its campaigns will be shifted by the wrong amount.

## Writing down what you learn
If you measure something about Twitch (a field shape, a failure, a timing), add it to `docs/twitch-drops-facts.md` under the symptom someone would have in hand when they go looking, not under the mechanism. Say when it was measured and how sure it is.
