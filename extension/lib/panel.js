// The details panel, shared by the chat chip and the toolbar popup. Layout and measurements
// follow Twitch's own "Drops & More" panel; see panel.css.
import { INTERVALS, normalize, autoReloadNote } from './settings.js';
import { STALE_MS, channelDrops } from './chip.js';
import { CAMPAIGNS_PAGE, directoryRows, directoryError, span, day } from './directory.js';
import { badgeSections } from './badges.js';
import { compareMinutes, timelineCells } from './minutelog.js';
import { debugRows, debugStreams, debugBundle } from './debug.js';

const CLOSE_ICON = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
const RELOAD_ICON = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9M16 3v4h-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
const CHEVRON_ICON = '<svg class="chevron" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M8 5l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';

const TEMPLATE = `
  <div class="panel">
    <header class="head">
      <h1>Drops Tracker</h1>
      <button id="panel-close" class="round" type="button" aria-label="Close" hidden>${CLOSE_ICON}</button>
    </header>
    <div class="tabs" role="tablist">
      <button id="tab-mine" class="tab" type="button" role="tab" aria-selected="true" aria-controls="view-mine">My Drops<i class="tab-dot"></i></button>
      <button id="tab-all" class="tab" type="button" role="tab" aria-selected="false" aria-controls="view-all">All Drops</button>
      <button id="tab-badges" class="tab" type="button" role="tab" aria-selected="false" aria-controls="view-badges">Badges</button>
      <button id="tab-settings" class="tab" type="button" role="tab" aria-selected="false" aria-controls="view-settings">Settings</button>
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
      <summary><span id="unclaimed-summary" class="strong"></span>${CHEVRON_ICON}</summary>
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
    <div id="view-badges" role="tabpanel" aria-labelledby="tab-badges" hidden></div>
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
        <label for="dev-mode">Developer mode</label>
        <span class="toggle">
          <input id="dev-mode" type="checkbox" aria-describedby="dev-mode-hint">
          <label for="dev-mode" aria-hidden="true"></label>
        </span>
      </div>
      <p id="dev-mode-hint" class="sub setting-hint">Shows debug tools below: the lost minutes log, tracker status and debug info for bug reports.</p>
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

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function verdictText(state, now) {
  const v = state.verdict;
  const lastGood = state.lastOkAt ? ` Last good data ${ago(now - state.lastOkAt)}.` : '';
  switch (v.code) {
    case 'earning': {
      const where = v.channel ? ` on ${v.channel}` : '';
      // With an eligible tab open the session may just have failed, so do not claim it is elsewhere.
      const elsewhere = !v.channel && !state.streams?.some((s) => s.channelState === 'eligible');
      const detail = v.wasted?.message || (elsewhere ? 'Minutes are rising from a stream outside this browser.' : '');
      return [`${v.slow ? 'Earning slowly' : 'Earning'}${where}`, detail];
    }
    case 'waiting':
      return ['Checking', 'Waiting for the first minute to land.'];
    case 'stalled':
      return ['Not counting', v.message];
    case 'idle':
      if (v.lost) return ['Stopped earning', v.message];
      if (v.limited) return [v.badge ? 'Cannot track this badge' : v.blocked ? 'Not counting yet' : 'Cannot check streams', v.message];
      if (state.closedName) return ['Not earning', `You left ${state.closedName}, so nothing open can earn right now.`];
      return ['Not earning', v.hasStreams ? 'None of your open streams have Drops you need.' : 'No stream is open in this browser.'];
    case 'signed_out':
      return ['Signed out', 'Log in to twitch.tv in this browser.'];
    case 'api_changed':
      return ['Cannot track', `${v.message || 'Twitch changed its API'}. Opening your Drops page once may fix this, since the tracker learns from it. If not, it needs an update.${lastGood}`];
    case 'error':
      return ['Cannot read Twitch', `${v.message}. Progress is unknown, not stalled.${lastGood}`];
    default:
      return ['Checking', ''];
  }
}

const toneOf = (v) => {
  if (v.code === 'stalled') return 'bad';
  if (v.code === 'earning') return v.slow || v.wasted ? 'warn' : 'ok';
  if (v.code === 'waiting') return 'info';
  if (v.lost || v.limited || ['error', 'api_changed', 'signed_out'].includes(v.code)) return 'warn';
  return 'idle';
};

const CHANNEL_LABEL = {
  eligible: 'Can earn, not credited',
  no_drops: 'No Drops on this channel',
  sub_only: 'Drops here only come from subs',
  badge_unseen: 'Badge timer, no minutes reported',
  blocked: 'Next drop cannot count yet',
  finished: 'Campaign finished',
  offline: 'Offline',
  unknown: 'Cannot check this channel',
  unstarted: 'Campaign not started yet',
  not_channel: 'Uses a stream slot',
};
const PLAYER_LABEL = {
  asleep: 'Tab asleep',
  paused: 'Paused',
  frozen: 'Player frozen',
  ended: 'Player ended',
  no_video: 'No player',
};

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
  minutes.addEventListener('change', () => save({ autoRefreshMinutes: Number(minutes.value) }));
  let reloadMemo = null;
  let minuteLog = [];
  const debugExtra = { hashes: null, directory: null };
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
  };
  chrome.storage.onChanged.addListener(onStorage);
  chrome.storage.local.get(['settings', 'autoReload', 'minuteLog', 'hashes', 'directory']).then((r) => {
    showSettings(r.settings);
    reloadMemo = r.autoReload ?? null;
    minuteLog = r.minuteLog ?? [];
    debugExtra.hashes = r.hashes ?? null;
    debugExtra.directory = r.directory ?? null;
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
    const stored = await chrome.storage.local.get(['state', 'settings', 'hashes', 'autoReload', 'directory', 'minuteLog']);
    await copyText($('debug-copy'), 'Copy debug info', JSON.stringify(debugBundle({ ...stored, version }, Date.now())));
  });

  // All Drops. Always opens on My Drops, so a warning is the first thing seen.
  let directory = null;
  let directoryLoading = false;
  let openRow = null;
  let lastState = null;
  const allShown = () => !$('view-all').hidden;

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
        if (r.kind !== 'reward' && !r.linked && r.linkUrl) add(r.linkUrl, 'Link account');
        if (links.childElementCount) more.append(links);
        row.append(summary, more);
        return row;
      });
    });
  }

  async function loadDirectory(force) {
    directoryLoading = true;
    renderDirectory(Date.now());
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
  }

  function showTab(name) {
    for (const tab of ['mine', 'all', 'badges', 'settings']) {
      $(`view-${tab}`).hidden = tab !== name;
      $(`tab-${tab}`).setAttribute('aria-selected', String(tab === name));
    }
    const all = name === 'all';
    $('foot-link').textContent = all ? 'All Campaigns' : 'Inventory';
    $('foot-link').href = all ? CAMPAIGNS_PAGE : 'https://www.twitch.tv/drops/inventory';
    if (name === 'badges' && lastState) renderBadges(lastState, Date.now());
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
  $('dir-refresh').addEventListener('click', () => loadDirectory(true));
  $('dir-search').addEventListener('input', () => renderDirectory(Date.now()));
  // Twitch's page shortcuts would otherwise take typed letters: f for fullscreen, m for mute.
  // Escape still closes the panel, since that listener runs before this one, on the way down.
  for (const type of ['keydown', 'keypress', 'keyup']) {
    $('dir-search').addEventListener(type, (e) => e.stopPropagation());
  }

  const onDirectory = (changes) => {
    if (!changes.directory?.newValue) return;
    directory = changes.directory.newValue;
    if (allShown()) renderDirectory(Date.now());
  };
  chrome.storage.onChanged.addListener(onDirectory);

  function renderVerdict(state, now) {
    const v = state.verdict;
    $('verdict').dataset.tone = toneOf(v);
    $('tab-mine').dataset.tone = toneOf(v);
    const [title, detail] = verdictText(state, now);
    $('verdict-title').textContent = title;
    $('verdict-detail').textContent = detail;
    $('verdict-detail').hidden = !detail;
    const note = autoReloadNote(reloadMemo, state, now);
    $('auto-reload-note').textContent = note;
    $('auto-reload-note').hidden = !note;
    let age = '';
    if (v.code === 'stalled') age = span(Math.max(0, Math.round((now - v.since) / 60000)));
    else if (state.lastGainAt && v.code === 'earning') age = `+1m ${ago(now - state.lastGainAt)}`;
    $('verdict-age').textContent = age;
    const action = $('verdict-action');
    // A reload cannot fix these: the cause is another stream, or the user's own pause.
    const reloadable = v.code === 'stalled' && v.tabId != null && !['too_many', 'second_stream', 'paused'].includes(v.cause);
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

  function renderBadges(state, now) {
    const sections = badgeSections(state.streams, channelLogin?.() ?? null, now);
    setList($('view-badges'), JSON.stringify(sections), () => sections.map((sec) => {
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
    const { drops: list, from } = channelDrops(state, channelLogin?.() ?? null);
    $('drops-section').hidden = !list.length;
    $('drops-label').textContent = from ? `Watch Drops on ${from}` : 'Watch Drops';
    const ratio = state.rate?.watched >= 10 && state.rate.counted > 0 ? Math.min(1, state.rate.counted / state.rate.watched) : 1;
    const earning = state.verdict.code === 'earning';
    const rows = list.map((d) => {
      const left = span(d.remaining);
      const eta = earning ? `, about ${clock(now + (d.remaining / ratio) * 60000)}` : '';
      return { ...d, line: d.atRisk && d.endsAt ? `Watch ${left} to earn, ends ${day(d.endsAt)}` : `Watch ${left} to earn${eta}` };
    });
    setList($('drops'), JSON.stringify(rows.map((r) => [r.id, r.minutes, r.line, r.image])), () => rows.map((d) => {
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
      card.append(top, bar);
      return card;
    }));
  }

  function renderStreams(state) {
    const list = state.streams || [];
    $('streams-section').hidden = !list.length;
    // Twitch keeps naming the session channel during a hang (seen live), so the name alone
    // proves nothing: only say "earning" while minutes are actually rising.
    const earning = state.verdict.code === 'earning';
    const anyCredited = list.some((s) => s.credited);
    const rows = list.map((s) => {
      const problem = s.channelState === 'eligible' ? PLAYER_LABEL[s.playerState] : null;
      if (problem) return { ...s, label: problem, tone: 'bad' };
      if (s.credited && earning) return { ...s, label: 'Earning', tone: state.verdict.slow ? 'warn' : 'ok' };
      if (s.credited) return { ...s, label: 'Last credited', tone: '' };
      // "Not credited" says another channel is getting it, which needs one to be.
      if (s.channelState === 'eligible' && !anyCredited) return { ...s, label: 'Can earn', tone: '' };
      return { ...s, label: CHANNEL_LABEL[s.channelState], tone: '' };
    });
    setList($('streams'), JSON.stringify(rows.map((r) => [r.tabId, r.displayName, r.label, r.tone])), () => rows.map((s) => {
      const row = el('div', 'row');
      const text = el('div', 'row-text');
      text.append(el('p', 'strong ellipsis', s.displayName || 'Twitch page'), el('p', `sub ellipsis ${s.tone}`, s.label));
      row.append(text);
      if (s.login) {
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
    const list = state.unclaimed || [];
    $('unclaimed-section').hidden = !list.length;
    if (!list.length) return;
    $('unclaimed-summary').textContent = `${list.length} earned, not claimed`;
    setList($('unclaimed'), JSON.stringify(list.map((u) => [u.id, u.claimBy, u.needsConnect])), () => list.map((u) => {
      const row = el('div', 'row');
      const text = el('div', 'row-text');
      const by = u.claimBy ? `, by ${day(u.claimBy)}` : '';
      text.append(el('p', 'strong ellipsis', u.name), el('p', 'sub ellipsis', `${u.game || u.campaign}${by}`));
      const connect = u.needsConnect && u.connectUrl;
      const link = el('a', 'link', connect ? 'Connect' : 'Claim');
      link.href = connect ? u.connectUrl : 'https://www.twitch.tv/drops/inventory';
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
