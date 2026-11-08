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

## Rules that bite
- **Rising minutes are the only proof of earning.** `dropCurrentSession` keeps naming a channel during a hang, and Twitch answers a session for channels you are not even watching. Never derive "earning" from it.
- **Unknown is never stalled.** A failed or partial poll has its own verdict (`error`, `api_changed`, `signed_out`, `limited`). Calling it Hung trains people to ignore the warning. Before changing failure handling, read "What each Twitch failure does" in [docs/twitch-drops-facts.md](docs/twitch-drops-facts.md), and test against the real response bodies in `tests/fixtures/`. Real failures were not what you would guess: one response often carries good data and an error together.
- **Read-only, always.** No claiming, no simulated watching, no replaying Twitch's integrity token. The All Drops list is read from the answer Twitch's own page receives for this reason.
- **Never open real streams to test.** Each playing stream takes one of the few slots Twitch allows per IP, and a third can cost real progress on the streams you are actually watching. `scripts/e2e.mjs` fakes channel pages. To inspect real chat markup, use `twitch.tv/popout/<login>/chat`, which has no video.
- **The auth token stays in memory for one request.** Never store, log or return it. The e2e test checks that it is not in extension storage.
- **Every in-memory or stored collection needs a stated bound** (cap, prune or TTL), written next to it. The service worker and storage live for weeks.
- **Pure logic stays pure.** `extension/lib/*.js` other than `panel.js` must not touch `chrome.*`, so it stays testable in Node.

## Adding a module the panel imports
Content scripts load panel modules by URL, so every file under `extension/lib/` the panel reaches must be listed in `web_accessible_resources` in `manifest.json`. `tests/manifest.test.mjs` checks this. After a manifest change, reload the extension: open tabs keep the old manifest until then and fail with "Failed to fetch dynamically imported module".

## Adding a captured fixture, or e2e failing days later with a campaign "finished"
`scripts/e2e.mjs` and `scripts/screenshots.mjs` run against the real clock, so they load fixtures through `loadFixture` in `scripts/fixtures.mjs`, which moves every timestamp forward by the time since capture. Never read a fixture there with plain `JSON.parse`: it passes on capture day and fails once a real campaign ends. All current fixtures share one capture time (`CAPTURED_AT`). A fixture captured on another day needs its own capture time there, or its campaigns will be shifted by the wrong amount.

## Writing down what you learn
If you measure something about Twitch (a field shape, a failure, a timing), add it to `docs/twitch-drops-facts.md` under the symptom someone would have in hand when they go looking, not under the mechanism. Say when it was measured and how sure it is.
