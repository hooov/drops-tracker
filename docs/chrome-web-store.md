# Chrome Web Store listing

Everything the developer dashboard asks for, ready to paste. Keep it in step with the extension: a
change to what it reads, stores or sends must update the privacy tab answers here and the policy at
https://hovjsyy.dev/drops-tracker/privacy/ (source: the `hooov/hovjsyy.dev` repo).

## Files
| Field | File | Made by |
|---|---|---|
| Package | `dist/drops-tracker-<version>.zip` | `npm run package` |
| Screenshots, 1280x800, upload in their numbered order | `docs/store/1-earning-1280x800.png` to `4-badges-1280x800.png` | `npm run store-images` |
| Small promo tile, 440x280 | `docs/store/promo-tile-440x280.png` | `npm run store-images` |

Take store images only from `docs/store/`. The README images in `docs/screenshots/` are other sizes, and the dashboard rejects them with "The image size is incorrect".
| Store icon, 128x128 | taken from the package | `npm run icons` |

Bump `version` in `extension/manifest.json` before every upload after the first: the store rejects a version it has already seen.

## Store listing tab
**Title:** comes from the manifest: Drops Tracker

**Summary:** comes from the manifest description (132 characters at most).

**Category:** Entertainment

**Language:** English

**Description:**
```
Twitch's Drops progress only updates when you reload the page, and sometimes Twitch quietly stops counting your watch-time while the stream keeps playing normally. You find out an hour later.

Drops Tracker asks Twitch once a minute how many minutes you actually have, and treats rising minutes as the only proof that you are earning.

WHAT YOU SEE
- A small chip in the chat row, beside your channel points, with your progress
- "Hung" when minutes stop rising while a stream that can earn is open, with the likely cause: paused, frozen player, too many streams open, or a drop waiting to be claimed
- A toolbar badge, a desktop notification, and an on-page warning that stays visible in fullscreen
- My Drops: what the channel you are on can earn, with progress and time left
- All Drops: every Drops campaign running on Twitch right now
- Badges: a channel's own sub and watch-time badges

WHAT IT NEVER DOES
It is read-only. It never claims a drop, never simulates watching, and never opens a stream for you. It talks only to Twitch, has no analytics, and sends nothing to the developer.

PRIVACY
Your Twitch login is read from your browser for each check and sent only to Twitch. Everything the extension keeps stays on your device. Full policy: https://hovjsyy.dev/drops-tracker/privacy/

Open source (GPL-3.0): https://github.com/hooov/drops-tracker

Unofficial and not affiliated with Twitch.
```

**Homepage URL:** https://hovjsyy.dev/drops-tracker/

**Support URL:** https://github.com/hooov/drops-tracker/issues

**Official URL:** leave empty unless hovjsyy.dev is verified in Google Search Console under the same Google account.

**Mature content:** No

## Privacy practices tab
**Single purpose:**
```
Shows whether Twitch is actually crediting Drops watch-minutes for the streams you have open, and warns you when it stops.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| alarms | Checks Drops progress with Twitch once a minute. An alarm keeps that check running while the service worker is asleep. |
| cookies | Reads the user's own Twitch sign-in cookie (auth-token) on twitch.tv to request their Drops progress from Twitch, the same way twitch.tv does. It is read for each request, sent only to gql.twitch.tv, and never stored or sent anywhere else. |
| notifications | Shows a desktop notification when Drops minutes stop rising, because the toolbar badge cannot be seen while a stream is fullscreen. |
| scripting | Reads the video player's state (playing, paused, frozen, muted) in open Twitch tabs to explain why minutes stopped, and shows a small warning on the Twitch page. Only on twitch.tv. |
| storage | Keeps the latest tracking state, the user's settings, and a log of watched minutes capped at one day, all locally. |
| webRequest | Observes the request bodies twitch.tv sends to gql.twitch.tv, only to learn the current query identifiers when Twitch rotates them, so the extension keeps working. Non-blocking; nothing else from those requests is kept, and headers are not read. |
| Host permission `https://*.twitch.tv/*` | The extension only works on Twitch. Content scripts on www.twitch.tv add the progress chip and panel, and progress is requested from gql.twitch.tv. It does not run on any other site. |

**Are you using remote code?** No.
```
All JavaScript ships in the package. The only dynamic import() calls load the extension's own files through chrome.runtime.getURL.
```

**Data usage, what user data is collected:** tick these four, nothing else. Over-disclosing costs nothing; under-disclosing is a policy violation.
- **Authentication information:** the Twitch auth-token cookie, sent to Twitch.
- **Web history:** the addresses of open twitch.tv tabs, from which channel names are sent to Twitch to look up their Drops.
- **User activity:** the request bodies Twitch's own page sends to gql.twitch.tv (network monitoring), kept only for query identifiers.
- **Website content:** video player state and Twitch's Drops data shown in the panel.

**Certifications:** tick all three (not sold to third parties, not used for unrelated purposes, not used for creditworthiness or lending).

**Privacy policy URL:** https://hovjsyy.dev/drops-tracker/privacy/

## Distribution tab
**Visibility:** Public. **Regions:** All regions. **Payment:** Free.

## Test instructions for the reviewer
```
Sign in to Twitch in the browser, then open any live channel that has Drops enabled (twitch.tv/directory, "Drops Enabled" tag). Within a minute the chip beside the channel points reads the drop's progress, and the toolbar badge shows the percentage. Click the chip or the toolbar icon for the panel; the All Drops tab lists every campaign on Twitch.

Signed out, the chip and panel say "Signed out" and no request is sent to Twitch with a login.
```

## Account (once, before the first upload)
- One-time registration fee, paid by the account owner.
- Contact email: hovjsy@proton.me, verified from the dashboard's Account tab.
- Trader declaration (EU): non-trader, if the extension stays free with no business behind it.
- 2-Step Verification on the Google account, which the dashboard requires before publishing.
