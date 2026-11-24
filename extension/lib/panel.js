// The details panel, shared by the chat chip and the toolbar popup. Layout and measurements
// follow Twitch's own "Drops & More" panel; see panel.css.
import { INTERVALS, normalize, autoReloadNote } from './settings.js';
import { STALE_MS, channelDrops, leftCards, waitingText } from './chip.js';
import { CAMPAIGNS_PAGE, directoryRows, directoryError, span, day, countdown } from './directory.js';
import { badgeSections, unearnedBadges, closeFirst, badgesListError } from './badges.js';
import { compareMinutes, timelineCells } from './minutelog.js';
import { debugRows, debugStreams, debugBundle } from './debug.js';
import { STALL_CAUSES, PLAYER_STATES, CHANNEL_STATES, verdictTone, canEarn, RATE_MIN_MINUTES } from './states.js';

const CLOSE_ICON = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
const RELOAD_ICON = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9M16 3v4h-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
const CLOCK_ICON = '<svg class="clock" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.6V8l2.4 1.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEVRON_ICON ='<svg class="chevron" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M8 5l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';

const TEMPLATE = `
  <div class="panel">
    <header class="head">
      <h1>Drops Tracker</h1>
      <button id="panel-close" class="round" type="button" aria-label="Close" hidden>${CLOSE_ICON}</button>
    </header>
    <div class="tabs" role="tablist">
      <button id="tab-mine" class="tab" type="button" role="tab" aria-selected="true" aria-controls="view-mine">My Drops<i class="tab-dot"></i></button>
      <button id="tab-all" class="tab" type="button" role="tab" aria-selected="false" aria-controls="view-all" tabindex="-1">All Drops</button>
      <button id="tab-badges" class="tab" type="button" role="tab" aria-selected="false" aria-controls="view-badges" tabindex="-1">Badges</button>
      <button id="tab-settings" class="tab" type="button" role="tab" aria-selected="false" aria-controls="view-settings" tabindex="-1">Settings</button>
    </div>
    <div id="view-mine" role="tabpanel" aria-labelledby="tab-mine">
    <div id="verdict" class="section status">
      <div class="status-line">
        <i class="dot"></i>
        <p id="verdict-title" class="strong">Checking</p>
        <span id="verdict-age" class="sub"></span>
      </div>
      <p id="verdict-detail" class="sub detail" hidden></p>
      <p id="auto-reload-note" class="sub detail" hidden></p>
      <button id="verdict-action" class="btn" type="button" hidden>Reload stream</button>
      <div id="timeline" class="timeline" role="img" hidden></div>
      <p id="rate" class="sub" hidden></p>
    </div>
    <div id="drops-section" class="section" hidden>
      <p id="drops-label" class="strong label">Watch Drops</p>
      <div id="drops"></div>
    </div>
    <div id="streams-section" class="section" hidden>
      <p class="strong label">Open streams</p>
      <div id="streams"></div>
    </div>
    <details id="unclaimed-section" class="section" hidden>
      <summary><span class="claim-head"><b id="unclaimed-count" class="count"></b><span id="unclaimed-summary" class="strong"></span></span>${CHEVRON_ICON}</summary>
      <div id="unclaimed"></div>
    </details>
    </div>
    <div id="view-all" role="tabpanel" aria-labelledby="tab-all" hidden>
      <div class="section">
        <div class="dir-head">
          <input id="dir-search" class="search" type="search" placeholder="Search games" aria-label="Search active Drops" autocomplete="off" spellcheck="false">
          <button id="dir-refresh" class="round" type="button" title="Load the list again" aria-label="Load the list again">${RELOAD_ICON}</button>
        </div>
        <p id="dir-status" class="sub" role="status"></p>
        <p id="dir-error" class="sub warn" hidden></p>
        <div id="dir-list" class="dir-list" tabindex="-1" hidden></div>
      </div>
    </div>
    <div id="view-badges" role="tabpanel" aria-labelledby="tab-badges" hidden>
      <div id="badge-channels"></div>
      <div class="section">
        <p class="strong label">Badges not earned yet</p>
        <p class="sub">Sitewide, and game badges on channels you open.</p>
        <div class="unearned-head">
          <p id="unearned-status" class="sub" role="status"></p>
          <button id="unearned-load" class="link" type="button">Load</button>
        </div>
        <p id="unearned-error" class="sub warn" hidden></p>
        <p id="unearned-close" class="sub" hidden></p>
        <div id="unearned-list" class="dir-list" tabindex="-1" hidden></div>
        <p id="unearned-none" class="sub dir-empty" hidden></p>
      </div>
    </div>
    <div id="view-settings" role="tabpanel" aria-labelledby="tab-settings" hidden>
    <div class="section">
      <div class="setting">
        <label for="auto-refresh">Auto-refresh Drops page</label>
        <span class="toggle">
          <input id="auto-refresh" type="checkbox" aria-describedby="auto-refresh-hint">
          <label for="auto-refresh" aria-hidden="true"></label>
        </span>
      </div>
      <p id="auto-refresh-hint" class="sub setting-hint">Twitch's Drops page never updates by itself. Stream tabs are never touched.</p>
      <div id="auto-refresh-every" class="setting every" hidden>
        <label for="auto-refresh-minutes" class="sub">Refresh every</label>
        <select id="auto-refresh-minutes" class="select"></select>
      </div>
    </div>
    <div class="section">
      <div class="setting">
        <label for="auto-reload">Auto-reload hung streams</label>
        <span class="toggle">
          <input id="auto-reload" type="checkbox" aria-describedby="auto-reload-hint">
          <label for="auto-reload" aria-hidden="true"></label>
        </span>
      </div>
      <p id="auto-reload-hint" class="sub setting-hint">After 6 minutes with no new minutes. At most 3 tries, never on a paused stream or when another stream is the likely cause.</p>
    </div>
    <div class="section">
      <div class="setting">
        <label for="claim-reminders">Claim reminders</label>
        <span class="toggle">
          <input id="claim-reminders" type="checkbox" aria-describedby="claim-reminders-hint">
          <label for="claim-reminders" aria-hidden="true"></label>
        </span>
      </div>
      <p id="claim-reminders-hint" class="sub setting-hint">The chip count, Ready to claim and its notification.</p>
      <!-- In Claim reminders' box: a section of its own made the Settings tab scroll in chat. -->
      <div class="setting next-setting">
        <label for="badge-alerts">Badge alerts</label>
        <span class="toggle">
          <input id="badge-alerts" type="checkbox" aria-describedby="badge-alerts-hint">
          <label for="badge-alerts" aria-hidden="true"></label>
        </span>
      </div>
      <p id="badge-alerts-hint" class="sub setting-hint">A desktop notification when a badge no open channel lists is rising.</p>
    </div>
    <p class="sub group-label">Advanced</p>
    <div class="section plain">
      <div class="setting">
        <label for="dev-mode">Developer mode</label>
        <span class="toggle">
          <input id="dev-mode" type="checkbox" aria-describedby="dev-mode-hint">
          <label for="dev-mode" aria-hidden="true"></label>
        </span>
      </div>
      <p id="dev-mode-hint" class="sub setting-hint">Debug tools for bug reports, shown below.</p>
    </div>
    <div id="debug-sections" hidden>
    <details id="log-section" class="section">
      <summary><span id="log-summary" class="strong">Lost minutes</span>${CHEVRON_ICON}</summary>
      <div id="log-rows"></div>
      <p id="log-paused" class="sub log-note" hidden></p>
      <p class="sub log-note">A gap is a lead, not a cause: these conditions overlap.</p>
      <div class="dir-links">
        <button id="log-copy" class="link" type="button">Copy log</button>
        <button id="log-clear" class="link" type="button">Clear</button>
      </div>
    </details>
    <details id="debug-status" class="section">
      <summary><span class="strong">Tracker status</span>${CHEVRON_ICON}</summary>
      <div id="debug-rows"></div>
      <p class="strong label debug-streams-label">Open streams</p>
      <div id="debug-streams"></div>
    </details>
    <div class="section">
      <div class="dir-links debug-actions">
        <button id="debug-poll" class="link" type="button">Check now</button>
        <button id="debug-copy" class="link" type="button">Copy debug info</button>
      </div>
      <p class="sub log-note">Copied text has your channels and progress, never your login.</p>
    </div>
    </div>
    </div>
    <footer class="foot">
      <span id="checked" class="sub"></span>
      <a id="foot-link" class="link" href="https://www.twitch.tv/drops/inventory" target="_blank" rel="noreferrer">Inventory</a>
    </footer>
  </div>`;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

/** How long "Checking" has lasted, beside its headline. Empty when the start is unknown or ahead. */
export function waitedFor(since, now) {
  if (!(since > 0) || since > now) return '';
  const s = Math.round((now - since) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function verdictText(state, now, login = null) {
  const v = state.verdict;
  const lastGood = state.lastOkAt ? ` Last good data ${ago(now - state.lastOkAt)}.` : '';
  switch (v.code) {
    case 'earning': {
      const where = v.channel ? ` on ${v.channel}` : '';
      // Already earned with nothing else open that can earn: done, which wins over slow.
      if (v.wasted?.reason === 'earned' && !v.wasted.actionable && v.wasted.name) {
        return [`${v.wasted.opens != null ? 'Done for today' : 'Already earned'}${where}`, v.wasted.message];
      }
      // With an eligible tab open the session may just have failed, so do not claim it is elsewhere.
      const elsewhere = !v.channel && !state.streams?.some((s) => s.channelState === 'eligible');
      const detail = v.wasted?.message || (elsewhere ? 'Minutes are rising from a stream outside this browser.' : '');
      return [`${v.slow ? 'Earning slowly' : 'Earning'}${where}`, detail];
    }
    case 'waiting':
      return ['Checking', waitingText(state, login)];
    case 'stalled':
      return ['Not counting', v.message];
    case 'idle':
      if (v.lost) return ['Stopped earning', v.message];
      // "Cannot check streams" is for failed lookups only: a campaign Twitch has not started was
      // shown under it (2026-11-13), which read as the extension failing.
      if (v.unproven) return ['Cannot tell if finished', v.message];
      if (v.limited) return [v.badge ? 'Cannot track this badge' : v.blocked || v.unstarted ? 'Not counting yet' : 'Cannot check streams', v.message];
      if (v.badgeLeft) return ['Badge likely earned', v.message];
      if (v.dropLeft) return ['Drop likely earned', v.message];
      if (v.rewardDone) return ['Campaign finished', v.message];
      // Twitch's numbers shown, nothing judged: see the reward channel state in states.js.
      if (v.reward) return ['Reward campaign', v.message];
      if (state.closedName) return ['Not earning', `You left ${state.closedName}, so nothing open can earn right now.`];
      if (!v.hasStreams) return ['Not earning', 'No stream is open in this browser.'];
      {
        // An offline channel may well run Drops; "none have Drops" would say it does not.
        const offline = (state.streams || []).find((s) => s.channelState === 'offline');
        if (offline) return ['Not earning', `${offline.displayName || offline.login} is offline, so it cannot earn right now.`];
      }
      return ['Not earning', 'None of your open streams have Drops you need.'];
    case 'signed_out':
      return ['Signed out', 'Log in to twitch.tv in this browser.'];
    case 'api_changed':
      return ['Cannot track', `${v.message || 'Twitch changed its API'}. Opening your Drops page once may fix this. If not, the extension needs an update.${lastGood}`];
    case 'error':
      return ['Cannot read Twitch', `${v.message}. Progress is unknown, not stalled.${lastGood}`];
    default:
      return ['Checking', ''];
  }
}

// The verdict's colour and the channel and player labels are declared with the states, in states.js.
const toneOf = verdictTone;
// The panel's tabs, in order: the tab bar, showTab and the arrow keys all read this.
const TABS = ['mine', 'all', 'badges', 'settings'];

/** Rebuild a list only when its content changed, so a button under the cursor survives the 1s tick. */
function setList(box, signature, build) {
  if (box.dataset.sig === signature) return;
  box.dataset.sig = signature;
  box.replaceChildren(...build());
}

export function createPanel(root, { reloadTab, onClose, channelLogin } = {}) {
  const holder = el('div');
  holder.innerHTML = TEMPLATE;
  root.append(holder.firstElementChild);
  const $ = (id) => root.querySelector(`#${id}`);

  if (onClose) {
    $('panel-close').hidden = false;
    $('panel-close').addEventListener('click', onClose);
  }

  // Settings live in storage, so the chat panel and the toolbar popup stay in step.
  const toggle = $('auto-refresh');
  const minutes = $('auto-refresh-minutes');
  minutes.append(...INTERVALS.map((m) => {
    const opt = el('option', '', m === 1 ? '1 minute' : `${m} minutes`);
    opt.value = String(m);
    return opt;
  }));
  let settings = normalize();
  const showSettings = (raw) => {
    settings = normalize(raw);
    toggle.checked = settings.autoRefresh;
    minutes.value = String(settings.autoRefreshMinutes);
    $('auto-refresh-every').hidden = !settings.autoRefresh;
    $('auto-reload').checked = settings.autoReload;
    $('dev-mode').checked = settings.devMode;
    $('claim-reminders').checked = settings.claimReminders;
    $('badge-alerts').checked = settings.badgeAlerts;
    if (lastState) renderUnclaimed(lastState);
    const wasHidden = $('debug-sections').hidden;
    $('debug-sections').hidden = !settings.devMode;
    if (wasHidden && settings.devMode && !$('view-settings').hidden) renderDebug(lastState, Date.now());
  };
  const save = (change) => {
    showSettings({ ...settings, ...change });
    chrome.storage.local.set({ settings });
  };
  toggle.addEventListener('change', () => save({ autoRefresh: toggle.checked }));
  $('auto-reload').addEventListener('change', () => save({ autoReload: $('auto-reload').checked }));
  $('dev-mode').addEventListener('change', () => save({ devMode: $('dev-mode').checked }));
  $('claim-reminders').addEventListener('change', () => save({ claimReminders: $('claim-reminders').checked }));
  $('badge-alerts').addEventListener('change', () => save({ badgeAlerts: $('badge-alerts').checked }));
  minutes.addEventListener('change', () => save({ autoRefreshMinutes: Number(minutes.value) }));
  let reloadMemo = null;
  let minuteLog = [];
  const debugExtra = { hashes: null, directory: null, pageOps: null };
  const version = chrome.runtime.getManifest?.().version ?? null;

  function renderDebug(state, now) {
    const rows = debugRows({ state, version, autoReload: reloadMemo, minuteLog, ...debugExtra }, now);
    setList($('debug-rows'), JSON.stringify(rows), () => rows.map((r) => {
      const row = el('div', 'debug-row');
      row.append(el('span', 'sub', r.label), el('span', 'sub debug-value', r.value));
      return row;
    }));
    const streams = debugStreams(state);
    setList($('debug-streams'), JSON.stringify(streams), () => {
      if (!streams.length) return [el('p', 'sub', 'None seen on the last check.')];
      return streams.map((s) => {
        const row = el('div', 'debug-row');
        row.append(el('span', 'sub', s.name), el('span', 'sub debug-value', s.line));
        return row;
      });
    });
  }

  const flash = (button, text, back) => {
    const b = button;
    b.textContent = text;
    setTimeout(() => { b.textContent = back; }, 2000);
  };

  // Worked out only when the log changes, not on every 1s render.
  function renderLog() {
    const { total, rows, paused } = compareMinutes(minuteLog);
    $('log-summary').textContent = total.watched ? `Lost minutes: ${total.watched - total.counted} of ${total.watched} watched` : 'Lost minutes';
    $('log-paused').textContent = paused ? `${paused} paused ${paused === 1 ? 'minute' : 'minutes'} left out.` : '';
    $('log-paused').hidden = !paused;
    const lines = rows.filter((r) => r.comparable);
    setList($('log-rows'), JSON.stringify([lines, total.watched]), () => {
      if (!total.watched) return [el('p', 'sub', 'No watched minutes logged yet.')];
      if (!lines.length) return [el('p', 'sub', 'Needs more minutes under different conditions before anything can be compared.')];
      return lines.map((r) => {
        const box = el('div', 'log-row');
        box.append(
          el('p', 'sub', `${r.yesLabel}: ${r.yes.counted} of ${r.yes.watched} counted (${r.yes.pct}%)`),
          el('p', 'sub', `${r.noLabel}: ${r.no.counted} of ${r.no.watched} counted (${r.no.pct}%)`),
        );
        return box;
      });
    });
  }

  const onStorage = (changes) => {
    if (changes.settings) showSettings(changes.settings.newValue);
    if (changes.autoReload) reloadMemo = changes.autoReload.newValue ?? null;
    if (changes.minuteLog) {
      minuteLog = changes.minuteLog.newValue ?? [];
      renderLog();
    }
    if (changes.hashes) debugExtra.hashes = changes.hashes.newValue;
    if (changes.directory) debugExtra.directory = changes.directory.newValue;
    if (changes.pageOps) debugExtra.pageOps = changes.pageOps.newValue;
  };
  chrome.storage.onChanged.addListener(onStorage);
  chrome.storage.local.get(['settings', 'autoReload', 'minuteLog', 'hashes', 'directory', 'pageOps']).then((r) => {
    showSettings(r.settings);
    reloadMemo = r.autoReload ?? null;
    minuteLog = r.minuteLog ?? [];
    debugExtra.hashes = r.hashes ?? null;
    debugExtra.directory = r.directory ?? null;
    debugExtra.pageOps = r.pageOps ?? null;
    renderLog();
  });
  const copyText = async (button, back, text) => {
    try {
      await navigator.clipboard.writeText(text);
      flash(button, 'Copied', back);
    } catch {
      flash(button, 'Copy failed', back);
    }
  };
  $('log-copy').addEventListener('click', () => copyText($('log-copy'), 'Copy log', JSON.stringify(minuteLog)));
  $('log-clear').addEventListener('click', () => chrome.storage.local.remove('minuteLog'));
  $('debug-poll').addEventListener('click', () => {
    flash($('debug-poll'), 'Checking', 'Check now');
    chrome.runtime.sendMessage({ type: 'poll' }).catch(() => {});
  });
  $('debug-copy').addEventListener('click', async () => {
    // Read fresh, so it is what is really stored rather than what this panel last saw.
    const stored = await chrome.storage.local.get(['state', 'settings', 'hashes', 'autoReload', 'directory', 'minuteLog', 'pageOps', 'dayRewards']);
    await copyText($('debug-copy'), 'Copy debug info', JSON.stringify(debugBundle({ ...stored, version }, Date.now())));
  });

  // All Drops. Always opens on My Drops, so a warning is the first thing seen.
  let directory = null;
  let directoryLoading = false;
  let openRow = null;
  let lastState = null;
  const allShown = () => !$('view-all').hidden;
  const badgesShown = () => !$('view-badges').hidden;
  let seenBadges = []; // Storage seenBadges and claimedGroups, with their bounds (twitch.js).
  let claimedGroups = [];
  const openUnearned = new Set(); // Rows left open. Bound: the rows drawn (renderUnearned).
  const keepBadges = (seen, claimed) => {
    seenBadges = Array.isArray(seen) ? seen : [];
    claimedGroups = Array.isArray(claimed) ? claimed : [];
  };
  const redrawBadges = () => { if (badgesShown() && lastState) renderBadges(lastState, Date.now()); };

  function renderDirectory(now) {
    const { rows, total } = directoryRows(directory, lastState?.active, $('dir-search').value, now);
    const hasList = directory?.at != null;
    const updated = hasList ? `, updated ${ago(now - directory.at)}` : '';
    const searching = $('dir-search').value.trim();
    let status = '';
    if (directoryLoading && !hasList) status = 'Loading. A Twitch tab opens in the background for a moment.';
    else if (directoryLoading) status = 'Updating. A Twitch tab opens in the background for a moment.';
    else if (hasList) status = `${searching ? `${rows.length} of ${total}` : total} active${updated}`;
    $('dir-status').textContent = status;
    $('dir-status').hidden = !status;
    $('dir-error').textContent = directory?.error && !directoryLoading ? directoryError(directory.error) : '';
    $('dir-error').hidden = !$('dir-error').textContent;
    $('dir-refresh').disabled = directoryLoading;

    const list = $('dir-list');
    list.hidden = !hasList;
    if (!hasList) return;
    const signature = JSON.stringify([rows.map((r) => [r.id, r.line, r.tag]), searching]);
    setList(list, signature, () => {
      if (!rows.length) return [el('p', 'sub dir-empty', searching ? `No active Drops match "${searching}".` : 'Twitch lists no active campaigns.')];
      return rows.map((r) => {
        const row = el('details', 'dir-row');
        row.open = r.id === openRow;
        row.addEventListener('toggle', () => {
          if (row.open) openRow = r.id;
          else if (openRow === r.id) openRow = null;
        });
        const summary = el('summary');
        // Always there, so missing art cannot knock a row out of line with the others.
        const art = el('div', 'boxart');
        if (r.art) {
          const img = el('img');
          img.loading = 'lazy';
          img.src = r.art;
          img.alt = '';
          img.addEventListener('error', () => img.remove());
          art.append(img);
        }
        summary.append(art);
        const text = el('div', 'row-text');
        text.append(el('p', 'strong ellipsis', r.game), el('p', 'sub ellipsis', r.sub), el('p', 'sub ellipsis', r.line));
        summary.append(text);
        if (r.tag) summary.append(el('span', r.pct != null ? 'tag ok' : 'tag', r.tag));
        const more = el('div', 'dir-more');
        const facts = [r.kind === 'reward' ? r.rewards?.join(', ') : r.owner, r.endAt ? `Ends ${new Date(r.endAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''];
        more.append(el('p', 'sub', facts.filter(Boolean).join('. ')));
        const links = el('div', 'dir-links');
        const add = (href, label) => {
          const a = el('a', 'link', label);
          a.href = href;
          a.target = '_blank';
          a.rel = 'noreferrer';
          links.append(a);
        };
        if (r.browseUrl) add(r.browseUrl, 'Browse streams');
        if (r.kind === 'reward' && r.linkUrl) add(r.linkUrl, 'Details');
        // Twitch's inventory has the connect button; publishers' own link pages vary.
        if (r.kind !== 'reward' && !r.linked) add('https://www.twitch.tv/drops/inventory', 'Link account');
        if (links.childElementCount) more.append(links);
        row.append(summary, more);
        return row;
      });
    });
  }

  async function loadDirectory(force) {
    directoryLoading = true;
    renderDirectory(Date.now());
    redrawBadges();
    let reply = null;
    try {
      reply = await chrome.runtime.sendMessage({ type: 'directory', force });
    } catch {
      reply = null; // Worker restarting. The saved list below still shows, with its age.
    }
    directoryLoading = false;
    if (reply) directory = reply;
    else if (directory?.at == null) directory = { campaigns: [], at: null, error: { kind: 'network' } }; // Never a blank tab.
    if (allShown()) renderDirectory(Date.now());
    redrawBadges();
  }

  function showTab(name) {
    for (const tab of TABS) {
      $(`view-${tab}`).hidden = tab !== name;
      $(`tab-${tab}`).setAttribute('aria-selected', String(tab === name));
      $(`tab-${tab}`).tabIndex = tab === name ? 0 : -1;
    }
    const all = name === 'all';
    $('foot-link').textContent = all ? 'All Campaigns' : 'Inventory';
    $('foot-link').href = all ? CAMPAIGNS_PAGE : 'https://www.twitch.tv/drops/inventory';
    if (name === 'badges') {
      redrawBadges();
      chrome.storage.local.get(['directory', 'seenBadges', 'claimedGroups']).then((r) => {
        directory = r.directory ?? directory;
        keepBadges(r.seenBadges, r.claimedGroups);
        redrawBadges();
      }).catch(() => {}); // The extension was reloaded under this panel: what is drawn stays.
    }
    if (name === 'settings' && settings.devMode) renderDebug(lastState, Date.now());
    if (!all) return;
    chrome.storage.local.get('directory').then((r) => {
      directory = r.directory ?? directory;
      if (allShown()) renderDirectory(Date.now());
    });
    loadDirectory(false);
  }
  $('tab-mine').addEventListener('click', () => showTab('mine'));
  $('tab-all').addEventListener('click', () => showTab('all'));
  $('tab-badges').addEventListener('click', () => showTab('badges'));
  $('tab-settings').addEventListener('click', () => showTab('settings'));
  // A tablist: one Tab stop, arrows (and Home/End) move between tabs.
  root.querySelector('.tabs').addEventListener('keydown', (e) => {
    const at = TABS.findIndex((t) => $(`tab-${t}`).getAttribute('aria-selected') === 'true');
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    const name = TABS[(to + TABS.length) % TABS.length];
    showTab(name);
    $(`tab-${name}`).focus();
  });
  $('dir-refresh').addEventListener('click', () => loadDirectory(true));
  $('unearned-load').addEventListener('click', () => loadDirectory(true));
  $('dir-search').addEventListener('input', () => renderDirectory(Date.now()));
  // Twitch's page shortcuts would otherwise take typed letters: f for fullscreen, m for mute.
  // Escape still closes the panel, since that listener runs before this one, on the way down.
  for (const type of ['keydown', 'keypress', 'keyup']) {
    $('dir-search').addEventListener(type, (e) => e.stopPropagation());
  }

  const onDirectory = (changes) => {
    if (changes.seenBadges || changes.claimedGroups) {
      keepBadges(
        changes.seenBadges ? changes.seenBadges.newValue : seenBadges,
        changes.claimedGroups ? changes.claimedGroups.newValue : claimedGroups,
      );
    }
    if (changes.directory?.newValue) {
      directory = changes.directory.newValue;
      if (allShown()) renderDirectory(Date.now());
    }
    if (changes.seenBadges || changes.claimedGroups || changes.directory) redrawBadges();
  };
  chrome.storage.onChanged.addListener(onDirectory);

  function renderVerdict(state, now) {
    const v = state.verdict;
    $('verdict').dataset.tone = toneOf(v);
    $('tab-mine').dataset.tone = toneOf(v);
    const [title, detail] = verdictText(state, now, channelLogin?.() ?? null);
    $('verdict-title').textContent = title;
    // "Drop likely earned" sends the reader to their inventory, so the link sits with the sentence
    // and not only in the footer. Rebuilt only on a change: a link replaced every second loses clicks.
    const box = $('verdict-detail');
    const toInventory = v.code === 'idle' && v.dropLeft === true;
    const sig = `${toInventory ? 'inventory ' : ''}${detail}`;
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      box.textContent = detail;
      if (toInventory) {
        const link = el('a', 'link', 'Open inventory');
        link.href = 'https://www.twitch.tv/drops/inventory';
        link.target = '_blank';
        link.rel = 'noreferrer';
        box.append(' ', link);
      }
    }
    box.hidden = !detail;
    const note = autoReloadNote(reloadMemo, state, now);
    $('auto-reload-note').textContent = note;
    $('auto-reload-note').hidden = !note;
    let age = '';
    if (v.code === 'stalled') age = span(Math.max(0, Math.round((now - v.since) / 60000)));
    else if (state.lastGainAt && v.code === 'earning') age = `+1m ${ago(now - state.lastGainAt)}`;
    // How long it has been checking, where a hang shows how long it has hung.
    else if (v.code === 'waiting') age = waitedFor(v.since, now);
    $('verdict-age').textContent = age;
    const action = $('verdict-action');
    // Which causes a reload can help is declared with the causes (STALL_CAUSES in states.js).
    const reloadable = v.code === 'stalled' && v.tabId != null && !!STALL_CAUSES[v.cause]?.reloadButton;
    action.hidden = !reloadable;
    action.onclick = reloadable ? () => reloadTab?.(v.tabId) : null;
  }

  /**
   * The minute strip, drawn in screen pixels. As 30 grid columns it sat on fractional pixels, and
   * at 125% display scaling squares came out 9 or 10 screen pixels wide with gaps of 2 or 3
   * (measured in the e2e). Layout rounds to 1/64 px, so no CSS sizing fixes that; a canvas does.
   * Redrawn only when the cells, size, scaling or colours change.
   */
  function drawTimeline(box, cells) {
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.floor(box.clientWidth * dpr);
    const h = Math.max(1, Math.round(box.clientHeight * dpr));
    if (!w || !cells.length) return;
    const cs = getComputedStyle(box);
    const colors = { gain: cs.getPropertyValue('--dt-brand').trim(), miss: cs.getPropertyValue('--dt-bad').trim(), '': cs.getPropertyValue('--dt-track').trim() };
    const key = JSON.stringify([cells, w, h, dpr, colors]);
    let canvas = box.querySelector('canvas');
    if (canvas && canvas.dataset.key === key) return;
    if (!canvas) box.replaceChildren(canvas = document.createElement('canvas'));
    canvas.dataset.key = key;
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${w / dpr}px`;
    canvas.style.height = `${h / dpr}px`;
    // Every gap identical, which is what showed. The squares fill the width, so the spare pixels
    // are spread one per square: some are one screen pixel wider, spaced evenly.
    const gap = Math.max(1, Math.round(2 * dpr));
    const room = w - gap * (cells.length - 1);
    const g = canvas.getContext('2d');
    cells.forEach((c, i) => {
      const left = Math.round((room * i) / cells.length) + gap * i;
      const right = Math.round((room * (i + 1)) / cells.length) + gap * i;
      g.fillStyle = colors[c] || colors[''];
      g.fillRect(left, 0, right - left, h);
    });
  }

  function renderTimeline(state) {
    const box = $('timeline');
    box.hidden = !state.timeline?.length;
    const rate = $('rate');
    rate.hidden = true;
    if (box.hidden) return;
    const cells = timelineCells(state.timeline);
    box.dataset.cells = cells.join(',');
    drawTimeline(box, cells);
    const r = state.rate;
    if (r?.watched) {
      rate.hidden = false;
      rate.textContent = `${r.counted} of the last ${r.watched} watched minutes counted`;
      box.setAttribute('aria-label', rate.textContent);
    }
  }

  // Badges not earned yet. Read from storage only: showing the tab never opens a Twitch page, the
  // Load button does, as All Drops does when its own tab is shown.
  function renderUnearned(state, now) {
    const rows = unearnedBadges({ state, seen: seenBadges, directory, claimed: claimedGroups }, now);
    const hasList = directory?.at != null;
    $('unearned-status').textContent = directoryLoading
      ? 'Loading. A Twitch tab opens in the background for a moment.'
      : hasList ? `Sitewide list updated ${ago(now - directory.at)}` : 'Sitewide list not loaded';
    $('unearned-load').textContent = hasList ? 'Load again' : 'Load';
    $('unearned-load').disabled = directoryLoading;
    $('unearned-error').textContent = directoryLoading ? '' : badgesListError(directory?.error);
    $('unearned-error').hidden = !$('unearned-error').textContent;
    // Never "all earned": it only knows the campaigns it has come across.
    $('unearned-none').textContent = hasList || seenBadges.length ? 'None among the campaigns seen so far.' : '';
    $('unearned-none').hidden = rows.length > 0 || !$('unearned-none').textContent;
    $('unearned-close').textContent = closeFirst(rows, state);
    $('unearned-close').hidden = !$('unearned-close').textContent;
    const list = $('unearned-list');
    list.hidden = !rows.length;
    for (const id of openUnearned) if (!rows.some((r) => r.id === id)) openUnearned.delete(id);
    // Minutes rising redraw this every minute, which must not throw the keyboard out of the list.
    const held = list.getRootNode().activeElement;
    const heldRow = list.contains(held) ? held.closest('.dir-row') : null;
    const heldPart = held?.tagName === 'A' ? 'a' : 'summary';
    setList(list, JSON.stringify(rows), () => rows.map((r) => {
      const row = el('details', 'dir-row');
      row.dataset.id = r.id;
      row.open = openUnearned.has(r.id); // A poll redraws the list: what was open stays open.
      row.addEventListener('toggle', () => { if (row.isConnected) openUnearned[row.open ? 'add' : 'delete'](r.id); });
      const summary = el('summary');
      const art = el('div', 'boxart');
      if (r.art) {
        const img = el('img');
        img.loading = 'lazy';
        img.src = r.art;
        img.alt = '';
        img.addEventListener('error', () => img.remove());
        art.append(img);
      }
      const text = el('div', 'row-text');
      text.append(el('p', 'strong ellipsis', r.name), el('p', 'sub', r.status));
      if (r.watch) text.append(el('p', 'sub', r.watch));
      if (r.late) text.append(el('p', 'sub warn', 'Cannot finish before it ends'));
      text.append(el('p', 'sub ellipsis', r.ends));
      summary.append(art, text);
      if (r.next) summary.append(el('span', 'tag next', 'Next'));
      const more = el('div', 'dir-more');
      for (const m of r.missing) {
        const said = [
          m.unknown && r.kind === 'missing' ? 'cannot tell if earned' : '',
          m.watch ?? '',
          m.late ? 'cannot finish before it ends' : '',
        ].filter(Boolean).join(', ');
        more.append(el('p', 'sub', said ? `${m.name}: ${said}` : m.name));
      }
      if (r.more) more.append(el('p', 'sub', 'Some badges may need more than watching.'));
      if (r.where) more.append(el('p', 'sub', r.where));
      if (r.link) {
        const links = el('div', 'dir-links');
        const a = el('a', 'link', r.link.label);
        a.href = r.link.href;
        a.target = '_blank';
        a.rel = 'noreferrer';
        links.append(a);
        more.append(links);
      }
      row.append(summary, more);
      return row;
    }));
    if (heldRow && !heldRow.isConnected) {
      [...list.children].find((x) => x.dataset.id === heldRow.dataset.id)?.querySelector(heldPart)?.focus({ preventScroll: true });
    }
  }

  function renderBadges(state, now) {
    const sections = badgeSections(state.streams, channelLogin?.() ?? null, now, state.unplacedBadges);
    renderUnearned(state, now);
    setList($('badge-channels'), JSON.stringify(sections), () => sections.map((sec) => {
      const box = el('div', 'section');
      if (sec.title) box.append(el('p', 'strong label', sec.title));
      if (sec.note) box.append(el('p', 'sub', sec.note));
      for (const c of sec.campaigns) {
        box.append(el('p', 'sub label', c.ends));
        for (const d of c.drops) {
          const card = el('div', 'card');
          const top = el('div', 'card-top');
          if (d.image) {
            const img = el('img', 'art');
            img.src = d.image;
            img.alt = '';
            img.addEventListener('error', () => img.remove());
            top.append(img);
          }
          const text = el('div', 'card-text');
          text.append(el('p', 'strong ellipsis', d.name), el('p', d.atRisk ? 'sub warn' : 'sub', d.line));
          top.append(text);
          card.append(top);
          if (d.pct != null) {
            const bar = el('div', 'bar');
            bar.setAttribute('role', 'progressbar');
            bar.setAttribute('aria-valuenow', String(d.pct));
            bar.setAttribute('aria-valuemin', '0');
            bar.setAttribute('aria-valuemax', '100');
            bar.setAttribute('aria-label', `${d.name}: ${d.minutes} of ${d.required} minutes`);
            bar.title = `${d.minutes} of ${d.required} minutes`;
            const fill = el('i');
            fill.style.width = `${d.pct}%`;
            bar.append(fill);
            card.append(bar);
          }
          box.append(card);
        }
      }
      return box;
    }));
  }

  function renderDrops(state, now) {
    const { drops: own, from } = channelDrops(state, channelLogin?.() ?? null, { pending: true });
    // Likely earned: kept as a card. Not under "Watch Drops on <other tab>", where it would read as
    // that tab's.
    const list = from ? own : [...own, ...leftCards(state, channelLogin?.() ?? null)];
    $('drops-section').hidden = !list.length;
    $('drops-label').textContent = from ? `Watch Drops on ${from}` : 'Watch Drops';
    const ratio = state.rate?.watched >= RATE_MIN_MINUTES && state.rate.counted > 0 ? Math.min(1, state.rate.counted / state.rate.watched) : 1;
    // A finish time only for drops the minutes are going to: not while they are being wasted
    // elsewhere, and not for another campaign than the one Twitch names as credited.
    const credited = state.active?.find((x) => x.id === state.session?.dropId)?.campaignId;
    // A session naming a drop not listed (a reward read as a running total) is credit going
    // elsewhere, so no listed drop gets a finish time.
    const cc = state.creditedCampaign ?? credited;
    const timed = (d) => state.verdict.code === 'earning' && !state.verdict.wasted && (!cc || d.campaignId === cc);
    const rows = list.map((d) => {
      // Done for today (tracker.js restingDrops): full, with a timer to the next day beside the bar.
      if (d.opensAt != null) {
        const when = d.opensAt - now < 86400000 ? clock(d.opensAt) : `${day(d.opensAt)}, ${clock(d.opensAt)}`;
        // "Next day at 9:21 PM" read as tomorrow when it was four hours off (walk-through, 2026-11-23).
        return { ...d, minutes: d.required, pct: 100, line: `Day complete, ${d.required}/${d.required}. Opens again at ${when}` };
      }
      // Likely earned (chip.js leftCards): full, with the reading it left at in words, since a bar
      // one minute short beside "probably earned" reads as missed.
      if (d.likely) return { ...d, minutes: d.required, pct: 100, line: `Probably earned. Left Twitch's list at ${d.read}/${d.required}` };
      // No minutes reported: the whole requirement, no bar and no finish time (as the Badges tab).
      // A sibling can tick with the drop the session names (facts), so the full time is an upper bound.
      if (d.minutes == null) return { ...d, line: d.runningTotal ? `Needs ${span(d.required)}, progress not readable here` : `Watch up to ${span(d.required)} to earn` };
      // Reached but still listed, as a session-only drop is (it never gets an instance ID): read
      // "Watch 0m to earn" live on 2026-11-19.
      if (d.remaining <= 0) return { ...d, line: 'Watch time reached' };
      const left = span(d.remaining);
      // None for a reward reading: how fast Twitch's numbers there move is not known.
      const eta = timed(d) && !d.unjudged ? `, about ${clock(now + (d.remaining / ratio) * 60000)}` : '';
      return { ...d, line: d.atRisk && d.endsAt ? `Watch ${left} to earn, ends ${day(d.endsAt)}` : `Watch ${left} to earn${eta}` };
    });
    // opensAt too: the pill keeps its target from the build, and Twitch's time can move within a minute.
    setList($('drops'), JSON.stringify(rows.map((r) => [r.id, r.minutes, r.line, r.image, r.opensAt])), () => rows.map((d) => {
      const card = el('div', 'card');
      const top = el('div', 'card-top');
      if (d.image) {
        const img = el('img', 'art');
        img.src = d.image;
        img.alt = '';
        img.addEventListener('error', () => img.remove()); // A dead art URL must not show a broken icon.
        top.append(img);
      }
      const text = el('div', 'card-text');
      text.append(el('p', 'strong ellipsis', d.name), el('p', 'sub ellipsis', d.game || d.campaign), el('p', d.atRisk ? 'sub warn' : 'sub', d.line));
      top.append(text);
      if (d.minutes == null) {
        card.append(top);
        return card;
      }
      const bar = el('div', 'bar');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuenow', String(d.pct));
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      bar.setAttribute('aria-label', d.likely ? `${d.name}: probably earned` : `${d.name}: ${d.minutes} of ${d.required} minutes`);
      bar.title = d.likely ? `Last shown at ${d.read} of ${d.required} minutes` : `${d.minutes} of ${d.required} minutes`;
      const fill = el('i');
      fill.style.width = `${d.pct}%`;
      bar.append(fill);
      // The exact minutes at a glance; they used to show only on hover.
      const barRow = el('div', 'bar-row');
      if (d.likely) {
        // The reading is in the line above: "59/60" beside a full bar would contradict it.
        barRow.append(bar);
      } else if (d.opensAt != null) {
        // The timer takes the minutes' place (they move to the line above). Its text is set below
        // on every render, so the card is not rebuilt each second.
        const pill = el('span', 'timer-pill');
        pill.dataset.opens = String(d.opensAt);
        pill.title = `Next day opens at ${clock(d.opensAt)}`;
        pill.innerHTML = CLOCK_ICON;
        pill.append(el('span', 'timer-left'));
        barRow.append(bar, pill);
      } else {
        barRow.append(bar, el('span', 'sub bar-min', `${Math.min(d.minutes, d.required)}/${d.required}`));
      }
      card.append(top, barRow);
      return card;
    }));
    for (const pill of $('drops').querySelectorAll('.timer-pill')) {
      const left = countdown(Number(pill.dataset.opens), now);
      const text = pill.querySelector('.timer-left');
      if (text.textContent !== left) text.textContent = left;
    }
  }

  function renderStreams(state) {
    const list = state.streams || [];
    $('streams-section').hidden = !list.length;
    // Twitch keeps naming the session channel during a hang (seen live), so the name alone
    // proves nothing: only say "earning" while minutes are actually rising.
    const earning = state.verdict.code === 'earning';
    const anyCredited = list.some((s) => s.credited);
    const rows = list.map((s) => {
      const problem = canEarn(s) ? PLAYER_STATES[s.playerState]?.label : null;
      if (problem) return { ...s, label: problem, tone: 'bad' };
      if (s.credited && earning) {
        // Same rule as the headline: amber only when another tab can earn (2026-11-20).
        const w = state.verdict.wasted;
        // The headline's words (verdictText).
        if (w?.reason === 'earned') return { ...s, label: w.opens != null && !w.actionable ? 'Done for today' : 'Already earned', tone: w.actionable ? 'warn' : '' };
        return { ...s, label: 'Earning', tone: 'ok' };
      }
      if (s.credited) return { ...s, label: 'Last credited', tone: '' };
      // "Not credited" says another channel is getting it, which needs one to be.
      if (s.channelState === 'eligible' && !anyCredited) return { ...s, label: 'Can earn', tone: '' };
      // The headline's own words: "Campaign finished" under "Drop likely earned" said it for certain.
      if (s.channelState === 'finished' && s.leftDrop) return { ...s, label: 'Drop likely earned', tone: '' };
      return { ...s, label: CHANNEL_STATES[s.channelState]?.label, tone: '' };
    });
    setList($('streams'), JSON.stringify(rows.map((r) => [r.tabId, r.displayName, r.label, r.tone])), () => rows.map((s) => {
      const row = el('div', 'row');
      const text = el('div', 'row-text');
      text.append(el('p', 'strong ellipsis', s.displayName || 'Twitch page'), el('p', `sub ellipsis ${s.tone}`, s.label));
      row.append(text);
      // No reload on the stream that is earning: it only invites breaking what works.
      // Nor on one done for today: nothing is wrong with it.
      if (s.login && s.label !== 'Earning' && s.label !== 'Done for today') {
        const btn = el('button', 'round');
        btn.type = 'button';
        btn.innerHTML = RELOAD_ICON;
        btn.title = `Reload ${s.displayName}`;
        btn.setAttribute('aria-label', btn.title);
        btn.onclick = () => reloadTab?.(s.tabId);
        row.append(btn);
      }
      return row;
    }));
  }

  function renderUnclaimed(state) {
    const list = settings.claimReminders ? state.unclaimed || [] : [];
    $('unclaimed-section').hidden = !list.length;
    if (!list.length) return;
    // The same purple count as the chip, so the two read as one thing.
    $('unclaimed-count').textContent = String(list.length);
    // As Twitch's inventory words it: "Connect" rows are earned but not claimable yet.
    const connect = list.filter((u) => u.needsConnect).length;
    $('unclaimed-summary').textContent = !connect ? 'Ready to claim' : connect === list.length ? 'Earned, connect to claim' : 'Ready to claim or connect';
    setList($('unclaimed'), JSON.stringify(list.map((u) => [u.id, u.claimBy, u.needsConnect])), () => list.map((u) => {
      const row = el('div', 'row');
      const text = el('div', 'row-text');
      const by = u.claimBy ? `, by ${day(u.claimBy)}` : '';
      text.append(el('p', 'strong ellipsis', u.name), el('p', 'sub ellipsis', `${u.game || u.campaign}${by}`));
      // Both go to Twitch's inventory, which has the claim and connect buttons itself. The
      // campaign's own link page varies by publisher and sometimes is not one (Tyler, 2026-11-09).
      const link = el('a', 'link', u.needsConnect ? 'Connect' : 'Claim');
      link.href = 'https://www.twitch.tv/drops/inventory';
      link.target = '_blank';
      link.rel = 'noreferrer';
      row.append(text, link);
      return row;
    }));
  }

  return {
    destroy() {
      if (chrome.runtime?.id) {
        chrome.storage.onChanged.removeListener(onStorage);
        chrome.storage.onChanged.removeListener(onDirectory);
      }
    },
    render(saved) {
      if (!saved) return;
      const now = Date.now();
      // A tracker that stopped polling must not keep showing its last good news.
      const stale = saved.lastPollAt && now - saved.lastPollAt > STALE_MS;
      const state = stale
        ? { ...saved, verdict: { code: 'error', message: `Drops Tracker has not updated for ${Math.round((now - saved.lastPollAt) / 60000)} min` } }
        : saved;
      renderVerdict(state, now);
      renderTimeline(state);
      renderDrops(state, now);
      renderStreams(state);
      renderUnclaimed(state);
      lastState = state;
      if (allShown()) renderDirectory(now);
      if (!$('view-badges').hidden) renderBadges(state, now);
      if (!$('view-settings').hidden && settings.devMode) renderDebug(state, now);
      $('checked').textContent = state.lastPollAt ? `Checked ${ago(now - state.lastPollAt)}` : '';
    },
  };
}
