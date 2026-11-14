import { fetchSnapshot, extractHashes, parseLogin, parseDirectory, TwitchError } from './lib/twitch.js';
import { update, events, badge, warning } from './lib/tracker.js';
import { normalize, refreshDue, autoReloadStep, DROPS_PAGES } from './lib/settings.js';
import { CAMPAIGNS_PAGE, LOAD_TIMEOUT_MS, isFresh, failedDirectory } from './lib/directory.js';
import { logEntry, addMinute } from './lib/minutelog.js';

const ALARM = 'poll';
const MAX_TABS = 20;
const TWITCH_TABS = ['*://www.twitch.tv/*', '*://m.twitch.tv/*'];
const INJECT_TIMEOUT_MS = 5000;
const POLL_TIMEOUT_MS = 40000;

/** A hung tab or stalled call must not hold up every later poll. */
function limit(promise, ms, message) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

// Runs inside the Twitch tab. Stateless on purpose: no content script to orphan when the
// extension reloads, and it works on tabs that were already open at install.
function readPlayer() {
  const videos = [...document.querySelectorAll('video')];
  const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
  const v = videos.sort((a, b) => area(b) - area(a))[0];
  if (!v) return { hasVideo: false, hidden: document.hidden };
  return {
    hasVideo: true,
    paused: v.paused,
    ended: v.ended,
    readyState: v.readyState,
    currentTime: v.currentTime,
    muted: v.muted || v.volume === 0,
    hidden: document.hidden,
    // For the minute log only.
    playerMuted: v.muted,
    volumeZero: v.volume === 0,
    videoHeight: v.videoHeight,
    // Not seen on a real ad yet: if Twitch names these differently this just reads false.
    ad: !!document.querySelector('[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"]'),
  };
}

// Runs inside the Twitch tab. A small pill that exists only while something is wrong, because
// the toolbar badge cannot be seen in fullscreen. Shadow DOM keeps Twitch's CSS out of it.
function paintPill(w) {
  const ID = 'drops-tracker-pill';
  let host = document.getElementById(ID);
  if (!w) { host?.remove(); return; }
  if (!host) {
    host = document.createElement('div');
    host.id = ID;
    host.style.cssText = 'position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      div{display:flex;align-items:center;gap:8px;padding:2px 2px 2px 10px;border-radius:4px;
        background:var(--color-background-float,#323239);color:var(--color-text-base,#efeff1);
        font:600 12px/1.4 var(--font-base,Inter,"Helvetica Neue",Helvetica,Arial,sans-serif);white-space:nowrap;
        box-shadow:var(--shadow-elevation-2,0 4px 8px rgba(0,0,0,.6),0 0 4px rgba(0,0,0,.4))}
      i{width:8px;height:8px;border-radius:50%;background:var(--color-fill-error,#ff4f4d)}
      button{all:unset;cursor:pointer;width:24px;height:24px;border-radius:9000px;text-align:center;line-height:24px;font-size:16px;font-weight:400}
      button:hover{background:var(--color-background-button-text-hover,rgba(83,83,95,.48))}
      button:focus-visible{outline:2px solid var(--color-background-progress-status,#a970ff)}
    </style><div><i></i><span></span><button aria-label="Dismiss">×</button></div>`;
    root.querySelector('button').addEventListener('click', () => {
      host.dataset.dismissed = host.dataset.key;
      host.style.display = 'none';
    });
  }
  // The top layer hides anything outside the fullscreen element, so follow it there.
  const parent = document.fullscreenElement || document.documentElement;
  if (host.parentNode !== parent) parent.append(host);
  host.dataset.key = w.key;
  const label = host.shadowRoot.querySelector('span');
  label.textContent = w.short;
  label.title = w.message;
  host.style.display = host.dataset.dismissed === w.key ? 'none' : '';
}

async function paintWarnings(prevWarning, nextWarning) {
  if (!prevWarning && !nextWarning) return; // Nothing on screen and nothing to show: inject nothing.
  const tabs = (await chrome.tabs.query({ url: TWITCH_TABS })).slice(0, MAX_TABS);
  // Limited for the same reason as readStreams: one hung tab must not hold up the whole poll.
  await Promise.all(tabs.filter((t) => !t.discarded && !t.frozen).map((t) => limit(
    chrome.scripting.executeScript({ target: { tabId: t.id }, func: paintPill, args: [nextWarning] }),
    INJECT_TIMEOUT_MS,
    'Tab did not answer',
  ).catch(() => {}))); // Tab navigating or closing; next poll paints it.
}

async function readStreams() {
  const tabs = (await chrome.tabs.query({ url: TWITCH_TABS })).slice(0, MAX_TABS);
  return Promise.all(tabs.map(async (tab) => {
    let player = null;
    if (!tab.discarded && !tab.frozen) {
      try {
        const [res] = await limit(
          chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPlayer }),
          INJECT_TIMEOUT_MS,
          'Tab did not answer',
        );
        player = res?.result ?? null;
      } catch {
        player = null; // Tab navigating or closing; next poll re-reads it.
      }
    }
    return {
      tabId: tab.id,
      login: parseLogin(tab.url),
      tab: { discarded: !!tab.discarded, frozen: !!tab.frozen, active: !!tab.active, tabMuted: !!tab.mutedInfo?.muted },
      player,
    };
  }));
}

// Self-repair for rotated hashes. Twitch's own page sends the current one for each operation,
// so read it from there. Only the request body is requested, which holds no token, and only
// the four operations this extension uses are kept, so this cannot grow.
let hashWrites = Promise.resolve();
function updateHashes(change) {
  hashWrites = hashWrites.then(async () => {
    const { hashes } = await chrome.storage.local.get('hashes');
    const next = change(hashes ?? {});
    if (next) await chrome.storage.local.set({ hashes: next });
  }).catch(() => {});
  return hashWrites;
}

function saveWorkingHashes(working) {
  return updateHashes((h) => {
    const same = Object.entries(working).every(([op, hash]) => h.working?.[op] === hash);
    return same ? null : { ...h, working: { ...h.working, ...working } };
  });
}

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (!/^https:\/\/(www|m)\.twitch\.tv$/.test(details.initiator ?? '')) return; // Twitch's page, not us.
  const chunks = details.requestBody?.raw;
  if (!chunks?.length) return;
  const decoder = new TextDecoder();
  const seen = extractHashes(chunks.map((c) => (c.bytes ? decoder.decode(c.bytes) : '')).join(''));
  if (!Object.keys(seen).length) return;
  updateHashes((h) => {
    const same = Object.entries(seen).every(([op, hash]) => h.learned?.[op] === hash);
    return same ? null : { ...h, learned: { ...h.learned, ...seen } };
  });
}, { urls: ['https://gql.twitch.tv/*'], types: ['xmlhttprequest'] }, ['requestBody']);

async function observe() {
  const cookie = await chrome.cookies.get({ url: 'https://www.twitch.tv', name: 'auth-token' });
  if (!cookie?.value) {
    // Twitch's other login cookie still being there means it moved the token, not that you left.
    const other = await chrome.cookies.get({ url: 'https://www.twitch.tv', name: 'twilight-user' });
    return other?.value
      ? { error: { kind: 'api_changed', message: 'Twitch changed how it stores your login' } }
      : { error: { kind: 'auth', message: 'Not logged in to Twitch in this browser' } };
  }
  const tabs = await readStreams();
  // Keep channel pages, plus non-channel pages only if they are really playing video (front page).
  const relevant = tabs.filter((t) => t.login || (t.player?.hasVideo && !t.player.paused));
  try {
    const { hashes } = await chrome.storage.local.get('hashes');
    const snap = await fetchSnapshot(cookie.value, relevant.map((t) => t.login).filter(Boolean), fetch, hashes ?? {});
    await saveWorkingHashes(snap.working);
    return {
      campaigns: snap.campaigns,
      rewards: snap.rewards,
      session: snap.session,
      sessions: snap.sessions,
      streams: relevant.map((t) => ({ ...t, channel: t.login ? snap.channels[t.login] : null })),
    };
  } catch (e) {
    if (e instanceof TwitchError) return { error: { kind: e.kind, message: e.message } };
    return { error: { kind: 'bad_response', message: 'Unexpected data from Twitch' } };
  }
}

// Only ever recording, so a failure here must not touch tracking.
async function recordMinute(prev, obs, next, now) {
  const entry = logEntry(prev, obs, next, now);
  if (!entry) return;
  const { minuteLog } = await chrome.storage.local.get('minuteLog');
  await chrome.storage.local.set({ minuteLog: addMinute(minuteLog, entry) });
}

async function paintBadge(state, prefs) {
  const b = badge(state, prefs);
  await chrome.action.setBadgeText({ text: b.text });
  await chrome.action.setBadgeBackgroundColor({ color: b.color });
  await chrome.action.setTitle({ title: b.title || 'Drops Tracker' });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
}

function notify(ev) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/128.png',
    title: ev.title,
    message: ev.message,
  });
}

// The Drops page never updates by itself. Optional, and only ever these pages: reloading a
// stream tab would interrupt the watching that earns the drop.
async function refreshDropsPages(now) {
  const { settings, lastDropsRefreshAt } = await chrome.storage.local.get(['settings', 'lastDropsRefreshAt']);
  const { due, nextLastAt } = refreshDue(normalize(settings), lastDropsRefreshAt ?? null, now);
  if (nextLastAt !== (lastDropsRefreshAt ?? null)) await chrome.storage.local.set({ lastDropsRefreshAt: nextLastAt });
  if (!due) return;
  const tabs = await chrome.tabs.query({ url: DROPS_PAGES });
  await Promise.all(tabs.filter((t) => !t.discarded).map((t) => chrome.tabs.reload(t.id).catch(() => {})));
}

// On by default, can be switched off, and capped: see autoReloadStep. Only ever the tab the verdict names,
// and only if it is still on a channel, since the tab may have moved on since the poll.
async function autoReloadHung(state, now) {
  const { settings, autoReload } = await chrome.storage.local.get(['settings', 'autoReload']);
  const step = autoReloadStep(autoReload, state, normalize(settings), now);
  if (JSON.stringify(step.memo) !== JSON.stringify(autoReload ?? null)) await chrome.storage.local.set({ autoReload: step.memo });
  if (step.tabId == null) return;
  const tab = await chrome.tabs.get(step.tabId).catch(() => null);
  if (tab && parseLogin(tab.url)) await chrome.tabs.reload(step.tabId).catch(() => {});
}

// The All Drops list. Twitch only gives it to its own page, because of its integrity check, so
// the only way to read it without working around that check is to let the page load normally
// and read the answer: see page-hook.js. Only ever on request and at most every FRESH_MS, since
// it opens a tab. That page has no video, so it takes no stream slot (measured).
let captured = null;
let directoryFlight = null;

async function acceptCapture(item) {
  const now = Date.now();
  const { directory: prev } = await chrome.storage.local.get('directory');
  let next;
  try {
    next = { ...parseDirectory(item, now), at: now, triedAt: now, error: null };
  } catch (e) {
    next = failedDirectory(prev, { kind: e instanceof TwitchError ? e.kind : 'bad_response' }, now);
  }
  await chrome.storage.local.set({ directory: next });
  captured?.(next);
  return next;
}

// A worker that died mid-load leaves its tab behind. Runs once, before any new load can start.
const leftoverClosed = (async () => {
  const { directoryTab } = await chrome.storage.local.get('directoryTab');
  if (directoryTab == null) return;
  const tab = await chrome.tabs.get(directoryTab).catch(() => null);
  if (tab && !tab.active && tab.url?.startsWith(CAMPAIGNS_PAGE)) await chrome.tabs.remove(tab.id).catch(() => {});
  await chrome.storage.local.remove('directoryTab');
})().catch(() => {});

async function refreshDirectory(force) {
  await leftoverClosed;
  const { directory: prev } = await chrome.storage.local.get('directory');
  const now = Date.now();
  if (!force && isFresh(prev, now)) return prev;
  const fail = async (kind) => {
    const next = failedDirectory(prev, { kind }, now);
    await chrome.storage.local.set({ directory: next });
    return next;
  };
  const cookie = await chrome.cookies.get({ url: 'https://www.twitch.tv', name: 'auth-token' });
  if (!cookie?.value) return fail('auth');

  let timer;
  const answer = new Promise((resolve) => {
    captured = resolve;
    timer = setTimeout(() => resolve(null), LOAD_TIMEOUT_MS);
  });
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: CAMPAIGNS_PAGE, active: false });
    tabId = tab.id;
    await chrome.storage.local.set({ directoryTab: tabId });
    return (await answer) ?? await fail('timeout');
  } finally {
    clearTimeout(timer);
    captured = null;
    if (tabId != null) {
      // Someone who clicked over to it or sent it somewhere else has made it theirs.
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const where = tab?.pendingUrl || tab?.url || '';
      if (tab && !tab.active && where.startsWith(CAMPAIGNS_PAGE)) await chrome.tabs.remove(tabId).catch(() => {});
      await chrome.storage.local.remove('directoryTab');
    }
  }
}

function loadDirectory(force) {
  directoryFlight ??= refreshDirectory(force).finally(() => { directoryFlight = null; });
  return directoryFlight;
}

let inflight = null;

async function pollOnce() {
  const { state: prev } = await chrome.storage.local.get('state');
  const now = Date.now();
  const obs = await observe().catch(() => ({ error: { kind: 'bad_response', message: 'Unexpected data from Twitch' } }));
  // A throw here would freeze the badge on its last good news, so it must become a verdict.
  let next;
  try {
    next = update(prev, obs, now);
  } catch {
    next = update(prev, { error: { kind: 'bad_response', message: 'Unexpected data from Twitch' } }, now);
  }
  const evs = events(prev, next, now);
  await chrome.storage.local.set({ state: next });
  await recordMinute(prev, obs, next, now).catch(() => {});
  // Claim reminders off: no claim notification, no CLM. Claims are still marked as notified, so
  // switching it back on later does not bring a burst of old ones.
  const prefs = normalize((await chrome.storage.local.get('settings')).settings);
  await paintBadge(next, prefs);
  // Before anything that can be slow: saving above has already marked these as sent.
  evs.filter((e) => prefs.claimReminders || e.type !== 'claim').forEach(notify);
  await paintWarnings(prev?.notifiedWarning, warning(next, now));
  await refreshDropsPages(now).catch(() => {}); // Must never stop tracking.
  await autoReloadHung(next, now).catch(() => {}); // Nor must this.
  return next;
}

function poll() {
  inflight ??= limit(pollOnce(), POLL_TIMEOUT_MS, 'Poll timed out').finally(() => { inflight = null; });
  return inflight;
}

const pollQuietly = () => { poll().catch(() => {}); }; // The next alarm tries again.

function ensureAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

// Alarms normally survive restarts. Losing one would stop tracking for good, so check on every wake.
chrome.alarms.get(ALARM).then((a) => { if (!a) ensureAlarm(); });

// Manifest content scripts only reach tabs opened later. Add the chip to tabs already open.
async function injectOpenTabs() {
  const tabs = (await chrome.tabs.query({ url: TWITCH_TABS })).slice(0, MAX_TABS);
  await Promise.all(tabs.filter((t) => !t.discarded).map((t) => chrome.scripting
    .executeScript({ target: { tabId: t.id }, files: ['content.js'] })
    .catch(() => {})));
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); pollQuietly(); injectOpenTabs(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); pollQuietly(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) pollQuietly(); });
chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  chrome.tabs.create({ url: 'https://www.twitch.tv/drops/inventory' });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'poll') {
    poll().then(reply, () => reply(null));
    return true;
  }
  if (msg?.type === 'directory') {
    loadDirectory(msg.force === true).then(reply, () => reply(null));
    return true;
  }
  if (msg?.type === 'directoryCaptured' && sender.tab && sender.url?.startsWith(CAMPAIGNS_PAGE)) {
    acceptCapture(msg.item).then(() => reply(true), () => reply(false));
    return true;
  }
  if (msg?.type === 'reloadTab' && Number.isInteger(msg.tabId)) {
    chrome.tabs.reload(msg.tabId).then(() => reply(true), () => reply(false));
    return true;
  }
  return false;
});
