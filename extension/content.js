// Status chip in Twitch's chat button row. Clicking it opens the details panel in place.
// Twitch rebuilds this row on channel changes, so a once-a-second check re-attaches the chip.
// A timer rather than a MutationObserver because chat mutates the page constantly.
(async () => {
  if (!chrome.runtime?.id) return;
  window.__dropsTrackerStop?.(); // Re-injected on install or update: replace the old instance.

  const { chipView, shouldCompact, channelFromPath } = await import(chrome.runtime.getURL('lib/chip.js'));
  // The panel must not be able to take the chip down with it. Brave reads an unpacked extension's
  // files from disk at once but its manifest only on Reload, so a tab opened in between gets new
  // code whose new modules are still blocked (seen 2026-11-06). The chip is the warning: it stays.
  const panelModule = import(chrome.runtime.getURL('lib/panel.js')).catch(() => null);
  const CHIP_ID = 'drops-tracker-chip';
  const PANEL_ID = 'drops-tracker-panel';
  // Twitch's test hooks first, then its class names. If both go, the chip goes too, and the
  // badge, notification and pill carry on without it.
  const ROW = '[data-test-selector="chat-input-buttons-container"], .chat-input__buttons-container';
  const POINTS = '[data-test-selector="community-points-summary"], .community-points-summary';
  const STALE_POLL_MS = 70000;
  const PANEL_WIDTH = 326;
  const RING_LENGTH = 2 * Math.PI * 13.5;

  document.getElementById(CHIP_ID)?.remove();
  document.getElementById(PANEL_ID)?.remove();

  let state = null;
  let panelHost = null;
  let panel = null;

  const chip = document.createElement('div');
  chip.id = CHIP_ID;
  chip.style.cssText = 'display:inline-flex;flex:none;align-items:center;';
  const shadow = chip.attachShadow({ mode: 'open' });
  // Same size, shape and hover as Twitch's icon buttons in this row.
  shadow.innerHTML = `<style>
    :host{--tone:var(--color-opac-gl-2,rgba(173,173,184,.35))}
    :host([data-tone="ok"]){--tone:var(--color-fill-success,#00f593)}
    :host([data-tone="bad"]){--tone:var(--color-fill-error,#ff4f4d)}
    :host([data-tone="warn"]){--tone:var(--color-fill-warn,#ffb31a)}
    :host([data-tone="info"]){--tone:var(--color-background-progress-status,#a970ff)}
    button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;min-width:32px;
      padding:0 6px;border-radius:9000px;cursor:pointer;font:600 14px/1 var(--font-base,Inter,"Helvetica Neue",Helvetica,Arial,sans-serif);white-space:nowrap}
    button:hover,button[aria-expanded="true"]{background:var(--color-background-button-text-hover,rgba(83,83,95,.48))}
    button:focus-visible{outline:2px solid var(--color-background-progress-status,#a970ff);outline-offset:-2px}
    svg{flex:none;width:20px;height:20px;stroke-width:4.5}
    .track{stroke:var(--color-background-progress,rgba(83,83,95,.55))}
    .arc{stroke:var(--tone);stroke-linecap:round}
    text{display:none;fill:currentColor;stroke:none;font-size:12.5px;font-weight:700;text-anchor:middle;dominant-baseline:central}
    text.wide{font-size:10.5px}
    /* No room for the label: a bigger ring with the number inside, so the percentage always shows. */
    :host([data-compact="true"]) button{padding:0 1px}
    :host([data-compact="true"]) svg{width:30px;height:30px;stroke-width:3}
    :host([data-compact="true"]) text{display:block}
    :host([data-compact="true"]) span{display:none}
    :host([data-tone="bad"]) span{color:var(--color-text-error,#ff8280)}
    :host([data-tone="warn"]) span{color:var(--color-fill-warn,#ffb31a)}
  </style><button type="button" aria-haspopup="dialog" aria-expanded="false">
    <svg viewBox="0 0 32 32" aria-hidden="true" fill="none">
      <circle class="track" cx="16" cy="16" r="13.5"/>
      <circle class="arc" cx="16" cy="16" r="13.5" transform="rotate(-90 16 16)"/>
      <text x="16" y="16.5"></text>
    </svg><span></span></button>`;
  const button = shadow.querySelector('button');
  const arc = shadow.querySelector('.arc');
  const number = shadow.querySelector('text');
  const label = shadow.querySelector('span');

  function paint() {
    const view = chipView(state, Date.now(), channelFromPath(location.pathname));
    chip.dataset.tone = view.tone;
    // No percentage to show: a full ring, so the colour still reads.
    const fraction = view.pct == null ? 1 : view.pct / 100;
    arc.setAttribute('stroke-dasharray', `${(fraction * RING_LENGTH).toFixed(2)} ${RING_LENGTH.toFixed(2)}`);
    number.textContent = view.pct == null ? '' : String(view.pct);
    number.classList.toggle('wide', view.pct === 100);
    label.textContent = view.text;
    button.title = view.title;
    button.setAttribute('aria-label', `Drops Tracker: ${view.title}`);
    return view;
  }

  function closePanel(refocus) {
    if (!panelHost) return;
    panel?.destroy();
    panelHost.remove();
    panelHost = null;
    panel = null;
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus();
  }

  function placePanel() {
    if (!panelHost) return;
    const r = button.getBoundingClientRect();
    const bottom = Math.max(8, innerHeight - r.top + 8);
    panelHost.style.left = `${Math.max(8, Math.min(r.left, innerWidth - PANEL_WIDTH - 10))}px`;
    panelHost.style.bottom = `${bottom}px`;
    // Grows to fit its content. Only a window shorter than the panel ever needs to scroll.
    panelHost.style.maxHeight = `${innerHeight - bottom - 8}px`;
    // Custom properties reach into the shadow root: the All Drops list sizes itself from this.
    panelHost.style.setProperty('--dt-avail', `${innerHeight - bottom - 8}px`);
  }

  function openPanel(createPanel) {
    panelHost = document.createElement('div');
    panelHost.id = PANEL_ID;
    panelHost.setAttribute('role', 'dialog');
    panelHost.setAttribute('aria-label', 'Drops Tracker');
    // Hidden until the stylesheet arrives, so it never flashes unstyled.
    panelHost.style.cssText = 'position:fixed;z-index:2147483646;visibility:hidden;overflow:hidden auto;scrollbar-width:none;'
      + 'border:1px solid var(--color-border-base,rgba(83,83,95,.48));border-radius:4px;'
      + 'box-shadow:var(--shadow-elevation-2,0 4px 8px rgba(0,0,0,.6),0 0 4px rgba(0,0,0,.4));';
    const root = panelHost.attachShadow({ mode: 'open' });
    if (createPanel) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = chrome.runtime.getURL('panel.css');
      const reveal = () => { if (panelHost) panelHost.style.visibility = ''; };
      css.addEventListener('load', reveal);
      css.addEventListener('error', reveal);
      root.append(css);
      panel = createPanel(root, {
        reloadTab: (tabId) => chrome.runtime.sendMessage({ type: 'reloadTab', tabId }),
        onClose: () => closePanel(false),
        // Read every render: Twitch changes channel without loading a new page.
        channelLogin: () => channelFromPath(location.pathname),
      });
      panel.render(state);
    } else {
      const note = document.createElement('p');
      note.id = 'panel-failed';
      note.style.cssText = 'width:280px;margin:0;padding:12px;background:var(--color-background-base,#18181b);color:var(--color-text-base,#efeff1);font:400 13px/1.4 var(--font-base,Inter,"Helvetica Neue",Helvetica,Arial,sans-serif);';
      note.textContent = 'The panel could not load, usually because Drops Tracker was just updated. Press Reload on it at brave://extensions.';
      root.append(note);
      panelHost.style.visibility = '';
    }
    (document.fullscreenElement || document.body).append(panelHost);
    placePanel();
    button.setAttribute('aria-expanded', 'true');
    chrome.runtime.sendMessage({ type: 'poll' }).catch(() => {});
  }

  const onPointer = (e) => {
    if (panelHost && !e.composedPath().includes(panelHost) && !e.composedPath().includes(chip)) closePanel(false);
  };
  const onKey = (e) => { if (e.key === 'Escape' && panelHost) closePanel(true); };
  button.addEventListener('click', async () => {
    if (panelHost) { closePanel(false); return; }
    const mod = await panelModule;
    if (!panelHost) openPanel(mod?.createPanel);
  });
  addEventListener('resize', placePanel);
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey, true);

  function attach() {
    const row = document.querySelector(ROW);
    if (!row) {
      if (chip.isConnected) chip.remove();
      closePanel(false);
      return;
    }
    // Beside the points when they exist. Channels without points have no left group, so
    // the chip becomes its own left group and pushes the rest right, as the group would.
    // Re-checked every tick: the points can mount after the row, which would otherwise
    // strand the chip at the far left for good.
    const points = row.querySelector(POINTS);
    const group = points && [...row.children].find((c) => c.contains(points));
    if (group ? chip.parentElement === group : row.contains(chip)) return;
    if (group) {
      chip.style.marginRight = '';
      group.append(chip);
    } else {
      chip.style.marginRight = 'auto';
      row.prepend(chip);
    }
    // Follow the chip rather than close: the points mount about a second after the row (real
    // popout chat, 2026-11-09), so closing here shut a panel opened in that first second.
    placePanel();
  }

  function fit(view) {
    const row = chip.parentElement?.closest(ROW);
    if (!row || !row.offsetWidth) return;
    // Left margins only, capped: the group's margin-right:auto computes to all the free space,
    // which would make the row always look full and pin the chip to the ring alone.
    const used = [...row.children].reduce((sum, c) => (
      sum + c.offsetWidth + Math.min(16, parseFloat(getComputedStyle(c).marginLeft) || 0)
    ), 0);
    chip.dataset.compact = String(shouldCompact(row.offsetWidth, used, chip.offsetWidth, view.text));
  }

  function tick() {
    if (!chrome.runtime?.id) { stop(); return; } // Extension reloaded: this instance is orphaned.
    // A page change Twitch makes must not throw on every tick or disturb the page. Try again next tick.
    try {
      attach();
      fit(paint());
      panel?.render(state);
    } catch {
      // Nothing useful to do; the toolbar badge still reports.
    }
  }

  const timer = setInterval(tick, 1000);
  const onStorage = (changes) => { if (changes.state) { state = changes.state.newValue; tick(); } };
  chrome.storage.onChanged.addListener(onStorage);

  function stop() {
    clearInterval(timer);
    removeEventListener('resize', placePanel);
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    if (chrome.runtime?.id) chrome.storage.onChanged.removeListener(onStorage);
    closePanel(false);
    chip.remove();
    window.__dropsTrackerStop = null;
  }
  window.__dropsTrackerStop = stop;

  ({ state } = await chrome.storage.local.get('state'));
  tick();
  if (!state?.lastPollAt || Date.now() - state.lastPollAt > STALE_POLL_MS) {
    chrome.runtime.sendMessage({ type: 'poll' }).catch(() => {});
  }
})();
