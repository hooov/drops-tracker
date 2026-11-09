// End-to-end check in a real browser with a throwaway profile. Run: npm run e2e
// What is real: Brave, manifest loading, service worker, cookies, tabs, script injection into
// tabs, badge, popup, Twitch's CORS and auth answers. What is faked: twitch.tv pages (local
// HTML, so no stream ever plays or adds a slot on your IP) and, after the first steps, GQL
// answers (from captured fixtures). Screenshots land in scripts/e2e-out/.
import { chromium } from 'playwright-core';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadFixture } from './fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const out = join(root, 'scripts', 'e2e-out');
mkdirSync(out, { recursive: true });
const fx = loadFixture(root, 'gql-2026-11-06.json');
const BROWSER = process.env.E2E_BROWSER || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const profile = mkdtempSync(join(tmpdir(), 'drops-e2e-'));
const step = (msg) => console.log(`ok - ${msg}`);

// A "stream" whose <video> really plays, from a canvas, so currentTime genuinely advances.
const FAKE_CHANNEL = `<!doctype html><title>fake</title><video id="v" muted autoplay width="640" height="360"></video><script>
  const c = document.createElement('canvas'); c.width = 64; c.height = 36;
  const g = c.getContext('2d'); let n = 0;
  setInterval(() => { g.fillStyle = n++ % 2 ? '#000' : '#fff'; g.fillRect(0, 0, 64, 36); }, 100);
  const v = document.getElementById('v'); v.srcObject = c.captureStream(10); v.play();
</script>
<div id="wrap" style="position:fixed;bottom:0;left:0;width:400px;background:#18181b;padding:8px 0"><div id="row-holder"></div></div>
<template id="row-template">
  <!-- Same hierarchy and layout rules as Twitch's real row, measured 2026-11-06. -->
  <div data-test-selector="chat-input-buttons-container" style="display:flex;flex-flow:row wrap-reverse;justify-content:flex-end;align-items:center">
    <div class="left" style="display:flex;align-items:center;flex:none;margin-right:auto">
      <div style="width:141px;height:32px"><div><div data-test-selector="community-points-summary" style="width:141px;height:32px;background:#333"></div></div></div>
      <div style="width:32px;height:32px;background:#444"></div>
    </div>
    <div class="settings" style="width:48px;height:32px;background:#444;flex:none"></div>
    <div class="send" style="width:60px;height:32px;background:#9147ff;flex:none;margin-left:4px"></div>
  </div>
</template>
<script>
  function buildRow() { document.getElementById('row-holder').replaceChildren(document.getElementById('row-template').content.cloneNode(true)); }
  buildRow();
</script>`;

// Twitch's campaigns page: no video, asks for the list in a batch, and reads the answer straight
// away. That last part matters: the hook must get its copy before the page uses up the body.
const FAKE_CAMPAIGNS = `<!doctype html><title>campaigns</title><script>
  fetch('https://gql.twitch.tv/gql', { method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify([{ operationName: 'SideNav' }, { operationName: 'ViewerDropsDashboard', variables: { fetchRewardCampaigns: true } }]) })
    .then((r) => r.json())
    .then((j) => { document.title = 'read:' + j.length; });
</script>`;
const dashboard = loadFixture(root, 'dashboard-2026-11-06.json');
let dashboardMode = 'ok';
let campaignPageLoads = 0;

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: BROWSER,
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 400, height: 720 },
});

try {
  // The popout chat page stays real: it has no video, so it adds no stream, and it proves the
  // chip and panel work on Twitch's actual markup and headers rather than on a copy of them.
  await ctx.route('https://www.twitch.tv/**', (r) => {
    const url = r.request().url();
    if (url.includes('/popout/')) return r.continue();
    if (url.includes('/drops/campaigns')) {
      campaignPageLoads++;
      return r.fulfill({ contentType: 'text/html', body: dashboardMode === 'silent' ? '<!doctype html><title>campaigns</title>' : FAKE_CAMPAIGNS });
    }
    return r.fulfill({ contentType: 'text/html', body: FAKE_CHANNEL });
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  step(`extension loaded in real browser (${extId})`);

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  const state = () => popup.evaluate(async () => (await chrome.storage.local.get('state')).state);
  const poll = () => popup.evaluate(() => chrome.runtime.sendMessage({ type: 'poll' }));
  const badgeText = () => popup.evaluate(() => chrome.action.getBadgeText({}));
  const shot = async (name) => {
    await popup.bringToFront();
    await popup.waitForTimeout(1200);
    await popup.screenshot({ path: join(out, `${name}.png`), fullPage: true });
  };

  // 1. No login at all.
  let s = await poll();
  assert.equal(s.verdict.code, 'signed_out');
  assert.equal(await badgeText(), 'OFF');
  await shot('1-signed-out');
  step('no cookie: signed out, without calling Twitch');

  // Settings tab on a fresh install: both helpers on, the debug tools hidden behind Developer mode.
  await popup.click('#tab-settings');
  assert.equal(await popup.isChecked('#auto-refresh'), true, 'Auto-refresh is on by default');
  assert.equal(await popup.isChecked('#auto-reload'), true, 'Auto-reload is on by default');
  assert.equal(await popup.isChecked('#dev-mode'), false, 'Developer mode is off by default');
  assert.equal(await popup.isVisible('#log-section'), false, 'debug tools stay hidden until Developer mode');
  await shot('0-settings-default');
  await popup.locator('.toggle').nth(2).click();
  assert.equal(await popup.isVisible('#log-section'), true);
  assert.equal(await popup.isVisible('#debug-status'), true);
  assert.deepEqual(await popup.evaluate(async () => (await chrome.storage.local.get('settings')).settings),
    { autoRefresh: true, autoRefreshMinutes: 5, autoReload: true, devMode: true });
  // From here both helpers are switched off, as a user can, so the steps below control when they act.
  await popup.evaluate(() => chrome.storage.local.set({ settings: { autoRefresh: false, autoRefreshMinutes: 5, autoReload: false, devMode: true } }));
  await popup.waitForFunction(() => !document.getElementById('auto-reload').checked);
  await popup.click('#tab-mine');
  step('Settings tab: Auto-refresh and Auto-reload on by default; Developer mode shows the debug tools');

  // 2. Real Twitch, from the extension's own origin: CORS must pass and auth failures must map.
  const anon = await sw.evaluate(async () => {
    const r = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'text/plain' },
      body: JSON.stringify([{ operationName: 'VideoPlayerStreamInfoOverlayChannel', variables: { channel: 'twitch' }, extensions: { persistedQuery: { version: 1, sha256Hash: '198492e0857f6aedead9665c81c5a06d67b25b58034649687124083ff288597d' } } }]),
    });
    const j = await r.json();
    return { status: r.status, login: j[0]?.data?.user?.login };
  });
  assert.equal(anon.status, 200);
  assert.equal(anon.login, 'twitch');
  step('real GQL call from the service worker passes CORS and returns data');

  await sw.evaluate(() => chrome.cookies.set({ url: 'https://www.twitch.tv', name: 'auth-token', value: 'e2einvalidtoken0000000000000000', domain: '.twitch.tv', secure: true }));
  s = await poll();
  assert.equal(s.verdict.code, 'signed_out', `real Twitch with a bad token gave ${JSON.stringify(s.verdict)}`);
  step(`real Twitch rejects a bad token and it reads as signed out ("${s.verdict.message}")`);

  // 3. From here GQL is answered from fixtures. fetch is swapped from outside; product code is untouched.
  await sw.evaluate((fixtures) => {
    self.__minutes = 195;
    self.__offset = 0;
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + self.__offset;
    self.fetch = async (_url, init) => {
      const answer = JSON.parse(init.body).map((o) => {
        const v = o.variables;
        switch (o.operationName) {
          case 'Inventory': {
            const campaigns = structuredClone(fixtures.campaigns);
            campaigns[1].timeBasedDrops[0].self.currentMinutesWatched = self.__minutes;
            if (self.__art) campaigns[1].timeBasedDrops[0].benefitEdges[0].benefit.imageAssetURL = self.__art;
            return { data: { currentUser: { inventory: { dropCampaignsInProgress: campaigns, gameEventDrops: [fixtures.rewardSample] } } } };
          }
          case 'VideoPlayerStreamInfoOverlayChannel':
            return { data: { user: v.channel === 'bravo' ? fixtures.channelBravo : fixtures.channelAlpha } };
          case 'DropsHighlightService_AvailableDrops':
            return { data: { channel: v.channelID === '10000001' && !self.__noCampaigns ? fixtures.availableEligible : fixtures.availableNone } };
          default:
            return { data: { currentUser: { dropCurrentSession: v.channelID === '10000001' ? fixtures.sessionCredited : fixtures.sessionUnrelatedChannelId } } };
        }
      });
      const ops = JSON.parse(init.body);
      return new Response(JSON.stringify(self.__transform ? self.__transform(answer, ops) : answer), { status: 200 });
    };
  }, fx);
  // The popup reads the clock too, so it has to move with the worker's.
  await popup.evaluate(() => {
    window.__offset = 0;
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + window.__offset;
  });
  const advance = async (minutes, added = 0) => {
    await sw.evaluate(([m, a]) => { self.__offset += m * 60000; self.__minutes += a; }, [minutes, added]);
    await popup.evaluate((m) => { window.__offset += m * 60000; }, minutes);
  };

  const alpha = await ctx.newPage();
  await alpha.goto('https://www.twitch.tv/alphatv');
  const bravo = await ctx.newPage();
  await bravo.goto('https://www.twitch.tv/bravo');
  await alpha.waitForFunction(() => document.querySelector('video').currentTime > 0.3);
  await bravo.waitForFunction(() => document.querySelector('video').currentTime > 0.3);

  s = await poll();
  assert.equal(s.verdict.code, 'waiting');
  assert.equal(s.streams.length, 2);
  assert.equal(s.streams.every((t) => t.playerState === 'playing'), true);
  step('injection reads real video state from both tabs; first poll says Checking');

  await advance(1, 1);
  await alpha.waitForTimeout(600);
  s = await poll();
  assert.equal(s.verdict.code, 'earning');
  assert.equal(s.verdict.channel, 'AlphaTV');
  assert.equal(await badgeText(), '81%');
  const byLogin = Object.fromEntries(s.streams.map((t) => [t.login, t]));
  assert.equal(byLogin.alphatv.credited, true);
  assert.equal(byLogin.bravo.channelState, 'no_drops');
  // Five more minutes, the last two credited late as Twitch does: nothing, then two at once.
  for (const added of [1, 1, 1, 0, 2]) { await advance(1, added); await alpha.waitForTimeout(150); await poll(); }
  const lastCells = await popup.waitForFunction(() => {
    const cells = (document.getElementById('timeline').dataset.cells || '').split(',').slice(-2);
    return cells.length === 2 && cells.every(Boolean) && cells;
  }).then((h) => h.jsonValue());
  assert.deepEqual(lastCells, ['gain', 'gain'], 'a minute credited late must not be drawn as lost');
  // Even squares and gaps at 125% display scaling. As grid columns on fractional pixels they were
  // 9 or 10 screen pixels wide with 2 or 3 pixel gaps. Read from the pixels actually drawn, and
  // check the canvas maps 1:1 onto the screen so nothing rescales them.
  const cdp = await ctx.newCDPSession(popup);
  const view = await popup.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: view.w, height: view.h, deviceScaleFactor: 1.25, mobile: false });
  await popup.waitForTimeout(1500); // The panel re-renders every second.
  const strip = await popup.evaluate(() => {
    const canvas = document.querySelector('#timeline canvas');
    const dpr = devicePixelRatio;
    const row = canvas.getContext('2d').getImageData(0, canvas.height >> 1, canvas.width, 1).data;
    const runs = [];
    for (let x = 0; x < canvas.width; x++) {
      const on = row[x * 4 + 3] > 0;
      if (runs.length && runs[runs.length - 1].on === on) runs[runs.length - 1].n++;
      else runs.push({ on, n: 1 });
    }
    const inner = runs.slice(runs[0].on ? 0 : 1, runs[runs.length - 1].on ? runs.length : -1);
    return {
      dpr,
      oneToOne: canvas.width === Math.round(parseFloat(canvas.style.width) * dpr) && Math.abs(canvas.getBoundingClientRect().width * dpr - canvas.width) < 0.5,
      squares: inner.filter((r) => r.on).length,
      widths: [...new Set(inner.filter((r) => r.on).map((r) => r.n))],
      gaps: [...new Set(inner.filter((r) => !r.on).map((r) => r.n))],
    };
  });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.detach();
  assert.equal(strip.dpr, 1.25);
  assert.equal(strip.oneToOne, true, `strip canvas is rescaled on screen: ${JSON.stringify(strip)}`);
  assert.equal(strip.squares, 30, JSON.stringify(strip));
  // Gaps identical; squares share the spare pixels, so they may differ by one screen pixel.
  assert.ok(Math.max(...strip.widths) - Math.min(...strip.widths) <= 1, `squares differ in width on screen: ${JSON.stringify(strip)}`);
  assert.equal(strip.gaps.length, 1, `gaps differ on screen: ${JSON.stringify(strip)}`);
  await shot('2-earning');
  const size = await popup.evaluate(() => { const p = document.querySelector('.panel'); return { w: p.offsetWidth, h: p.offsetHeight }; });
  assert.equal(size.w, 326, 'same width as Twitch\'s own panel');
  console.log(`   toolbar panel is ${size.w}x${size.h}px`);
  step('minutes rising: Earning, badge 81%, AlphaTV credited, Bravo labelled as no drops, late minute drawn as counted, strip gaps even at 125%');

  // Chat chip: read the real shadow DOM on the real tab.
  const chip = (page) => page.evaluate(() => {
    const host = document.getElementById('drops-tracker-chip');
    if (!host) return null;
    const label = host.shadowRoot.querySelector('span');
    return { tone: host.dataset.tone, text: label.textContent, labelShown: getComputedStyle(label).display !== 'none', title: host.shadowRoot.querySelector('button').title, inGroup: !!host.closest('.left') };
  });
  const rowHeight = (page) => page.evaluate(() => document.querySelector('[data-test-selector="chat-input-buttons-container"]').offsetHeight);
  await alpha.bringToFront();
  await alpha.waitForFunction(() => document.getElementById('drops-tracker-chip')?.dataset.tone === 'ok');
  let c = await chip(alpha);
  assert.equal(c.text, '83%'); // 195 + 6 added so far = 201 of 240
  assert.equal(c.inGroup, true);
  assert.match(c.title, /Earning on AlphaTV/);
  assert.equal(await rowHeight(alpha), 32, 'chip must not wrap the row');
  await alpha.screenshot({ path: join(out, '8-chip-earning.png') });
  step('chip sits beside the points, reads 83% in green, row stays one line');

  // Twitch rebuilding the row must not lose the chip.
  await alpha.evaluate(() => buildRow());
  await alpha.waitForFunction(() => document.querySelector('[data-test-selector="chat-input-buttons-container"] #drops-tracker-chip'));
  step('chip re-attaches after Twitch rebuilds the row');

  // The points can mount after the row. The chip must not stay stranded at the far left.
  await alpha.evaluate(() => {
    buildRow();
    window.__points = document.querySelector('[data-test-selector="community-points-summary"]');
    window.__pointsParent = window.__points.parentElement;
    window.__points.remove();
  });
  await alpha.waitForFunction(() => {
    const host = document.getElementById('drops-tracker-chip');
    return host?.parentElement?.matches('[data-test-selector="chat-input-buttons-container"]');
  });
  await alpha.evaluate(() => window.__pointsParent.append(window.__points));
  await alpha.waitForFunction(() => document.getElementById('drops-tracker-chip')?.closest('.left'));
  assert.equal(await alpha.evaluate(() => document.getElementById('drops-tracker-chip').style.marginRight), '');
  step('chip moves beside the points when they mount late');

  // Tight chat column: ring with the number inside, and still no second line.
  await alpha.evaluate(() => { document.getElementById('wrap').style.width = '320px'; });
  await alpha.waitForFunction(() => document.getElementById('drops-tracker-chip').dataset.compact === 'true');
  assert.equal(await rowHeight(alpha), 32, 'compact chip must not wrap the row');
  c = await chip(alpha);
  assert.equal(c.labelShown, false);
  const inRing = await alpha.evaluate(() => {
    const host = document.getElementById('drops-tracker-chip');
    const t = host.shadowRoot.querySelector('text');
    const r = t.getBoundingClientRect();
    const ring = host.shadowRoot.querySelector('svg').getBoundingClientRect();
    return { text: t.textContent, shown: getComputedStyle(t).display !== 'none', fits: r.width < ring.width - 6, width: host.offsetWidth, ring: ring.width };
  });
  assert.equal(inRing.text, '83');
  assert.equal(inRing.shown, true);
  assert.equal(inRing.fits, true, JSON.stringify(inRing));
  assert.equal(inRing.width, 32, 'same width as the icon buttons beside it');
  await alpha.screenshot({ path: join(out, '12-ring-with-number.png'), clip: { x: 0, y: 672, width: 340, height: 48 } });
  await alpha.evaluate(() => { document.getElementById('wrap').style.width = '400px'; });
  await alpha.waitForFunction(() => document.getElementById('drops-tracker-chip').dataset.compact === 'false');
  assert.equal(await rowHeight(alpha), 32);
  step(`320px chat column: ${inRing.text} shown inside the ring on one line; label returns when wider`);

  // Clicking opens the panel in the page itself. Playwright's selectors pierce open shadow roots.
  await alpha.evaluate(() => document.getElementById('drops-tracker-chip').shadowRoot.querySelector('button').click());
  await alpha.waitForSelector('#drops-tracker-panel .panel');
  assert.match(await alpha.textContent('#drops-tracker-panel #verdict-title'), /Earning on AlphaTV/);
  await alpha.waitForFunction(() => document.getElementById('drops-tracker-panel').style.visibility === '');
  const panel = await alpha.evaluate(() => {
    const host = document.getElementById('drops-tracker-panel');
    const r = host.getBoundingClientRect();
    const b = document.getElementById('drops-tracker-chip').getBoundingClientRect();
    const inner = host.shadowRoot.querySelector('.panel');
    const cs = getComputedStyle(inner);
    return {
      w: r.width, h: r.height, gap: b.top - r.bottom, left: r.left,
      extraY: host.scrollHeight - host.clientHeight, extraX: host.scrollWidth - host.clientWidth,
      iframes: host.shadowRoot.querySelectorAll('iframe').length,
      bg: cs.backgroundColor, width: inner.offsetWidth,
      close: !host.shadowRoot.getElementById('panel-close').hidden,
    };
  });
  assert.ok(panel.gap >= 0 && panel.left >= 0, JSON.stringify(panel));
  assert.equal(panel.iframes, 0);
  assert.deepEqual([panel.extraY, panel.extraX], [0, 0], 'panel must not scroll in either direction');
  assert.equal(panel.width, 326);
  assert.equal(panel.bg, 'rgb(24, 24, 27)');
  assert.equal(panel.close, true);
  await alpha.screenshot({ path: join(out, '9-chip-panel.png') });
  // Buttons must survive the 1s refresh, or a click between press and release gets lost.
  const same = await alpha.evaluate(async () => {
    const root = document.getElementById('drops-tracker-panel').shadowRoot;
    const before = root.querySelector('#streams button');
    await new Promise((r) => setTimeout(r, 2200));
    return before === root.querySelector('#streams button');
  });
  assert.equal(same, true, 'stream rows must not be rebuilt when nothing changed');
  await alpha.mouse.click(5, 5);
  await alpha.waitForFunction(() => !document.getElementById('drops-tracker-panel'));
  step(`click opens the panel above the chip (${Math.round(panel.w)}x${Math.round(panel.h)}px); click outside closes it`);

  // Real Twitch page: markup, headers and iframe with nothing faked. Logged out in this profile.
  const real = await ctx.newPage();
  await real.goto('https://www.twitch.tv/popout/twitch/chat', { waitUntil: 'domcontentloaded' });
  const realRow = await real.waitForSelector('[data-test-selector="chat-input-buttons-container"]', { timeout: 25000 }).catch(() => null);
  assert.ok(realRow, 'selector no longer matches Twitch: the chat row hook has changed');
  await real.waitForFunction(() => document.getElementById('drops-tracker-chip'), { timeout: 5000 });
  assert.equal(await real.evaluate(() => document.querySelectorAll('video').length), 0, 'this page must not play a stream');
  await real.evaluate(() => document.getElementById('drops-tracker-chip').shadowRoot.querySelector('button').click());
  await real.waitForSelector('#drops-tracker-panel .panel').catch(async (err) => {
    // This has timed out now and then on real Twitch only. Say what state it was left in.
    const seen = await real.evaluate(() => {
      const host = document.getElementById('drops-tracker-panel');
      const link = host?.shadowRoot?.querySelector('link');
      const r = host?.shadowRoot?.querySelector('.panel')?.getBoundingClientRect();
      return {
        hostVisibility: host?.style.visibility,
        sheetLoaded: !!link?.sheet,
        linkConnected: link?.isConnected,
        rect: r ? [r.width, r.height] : null,
        pageVisibility: document.visibilityState,
        timing: performance.getEntriesByType('resource').filter((e) => e.name.includes('panel.css')).map((e) => e.duration),
      };
    });
    console.error('panel stayed hidden on real Twitch:', JSON.stringify(seen));
    throw err;
  });
  await real.waitForFunction(() => document.getElementById('drops-tracker-panel').style.visibility === '', null, { timeout: 8000 });
  // Proves the stylesheet loaded under Twitch's real headers and Twitch's own tokens resolve.
  const realStyle = await real.evaluate(() => {
    const p = document.getElementById('drops-tracker-panel').shadowRoot.querySelector('.panel');
    const cs = getComputedStyle(p);
    return { width: p.offsetWidth, font: cs.fontFamily, token: getComputedStyle(document.documentElement).getPropertyValue('--font-base').trim() };
  });
  assert.equal(realStyle.width, 326);
  assert.match(realStyle.font, /Inter/);
  assert.ok(realStyle.token, 'Twitch no longer exposes the design tokens this panel relies on');
  await real.screenshot({ path: join(out, '10-chip-on-real-twitch.png') });
  step(`on real twitch.tv: chip mounted, panel styled from Twitch's own tokens ("${await real.textContent('#drops-tracker-panel #verdict-title')}")`);
  // The look, judged on real Twitch in dark theme with realistic data rather than on a test page.
  await real.evaluate(() => localStorage.setItem('twilight.theme', '1'));
  await real.reload({ waitUntil: 'domcontentloaded' });
  await real.waitForSelector('[data-test-selector="chat-input-buttons-container"]', { timeout: 25000 });
  await sw.evaluate(() => chrome.cookies.set({ url: 'https://www.twitch.tv', name: 'auth-token', value: 'e2einvalidtoken0000000000000000', domain: '.twitch.tv', secure: true }));
  await sw.evaluate(() => { self.__art = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22%3E%3Crect width=%2240%22 height=%2240%22 rx=%224%22 fill=%22%235b3a9e%22/%3E%3C/svg%3E'; });
  for (let i = 0; i < 2; i++) { await advance(1, 1); s = await poll(); }
  assert.equal(s.verdict.code, 'earning', JSON.stringify(s.verdict));
  await real.waitForFunction(() => document.getElementById('drops-tracker-chip')?.dataset.tone === 'ok');
  await real.evaluate(() => document.getElementById('drops-tracker-chip').shadowRoot.querySelector('button').click());
  await real.waitForFunction(() => document.getElementById('drops-tracker-panel')?.style.visibility === '');
  await real.bringToFront();
  await real.waitForTimeout(500);
  await real.screenshot({ path: join(out, '11-panel-on-real-twitch-dark.png') });
  await real.keyboard.press('Escape');
  await real.setViewportSize({ width: 300, height: 720 });
  await real.waitForFunction(() => document.getElementById('drops-tracker-chip').dataset.compact === 'true');
  const ringText = await real.evaluate(() => {
    const t = document.getElementById('drops-tracker-chip').shadowRoot.querySelector('text');
    return { text: t.textContent, fill: getComputedStyle(t).fill };
  });
  assert.ok(ringText.text, 'the percentage must show in the ring');
  assert.equal(ringText.fill, 'rgb(239, 239, 241)', 'number must use Twitch\'s text colour, not black');
  await real.screenshot({ path: join(out, '14-ring-on-real-twitch.png'), clip: { x: 0, y: 660, width: 300, height: 60 } });
  // The learner must see real traffic from Twitch's real page.
  const realLearned = await real.evaluate(() => 0).then(() => popup.evaluate(async () => (await chrome.storage.local.get('hashes')).hashes?.learned ?? {}));
  console.log('   hashes learned from real twitch.tv traffic:', Object.keys(realLearned).join(', ') || '(none on this logged-out page)');
  await real.close();
  // Real Twitch clears the invalid auth cookie, so put it back for the faked steps below.
  await sw.evaluate(() => chrome.cookies.set({ url: 'https://www.twitch.tv', name: 'auth-token', value: 'e2einvalidtoken0000000000000000', domain: '.twitch.tv', secure: true }));
  await poll();

  // 4. Player healthy, Twitch stops counting.
  // One minute per poll like the real alarm; one jump of 5 would read as PC sleep and restart the clock.
  for (let i = 0; i < 5; i++) { await advance(1); await alpha.waitForTimeout(150); s = await poll(); }
  // Bravo is playing too, so a second stream is the named cause (measured 2026-11-09: one stopped
  // credit until closed), and Reload is not offered because reloading AlphaTV would not fix it.
  assert.equal(s.verdict.code, 'stalled');
  assert.equal(s.verdict.cause, 'second_stream');
  assert.match(await popup.textContent('#verdict-detail'), /Bravo is also playing/);
  assert.equal(await popup.isHidden('#verdict-action'), true, 'no Reload button for a second-stream hang');
  step('hang with a second stream playing: names Bravo as the likely cause, offers no reload');
  // Pause Bravo: from here the hang has no visible cause, which is what Reload and Auto-reload are for.
  await bravo.evaluate(() => document.querySelector('video').pause());
  s = await poll();
  assert.equal(s.verdict.code, 'stalled');
  assert.equal(s.verdict.cause, 'uncounted');
  assert.equal(await badgeText(), 'HUNG');
  await shot('3-stalled-uncounted');
  assert.match(await popup.textContent('#verdict-age'), /^[1-9]\d*m$/);
  assert.match(await popup.textContent('#streams'), /Last credited/);
  assert.doesNotMatch(await popup.textContent('#streams'), /Earning/);
  const bg = await popup.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(bg, 'rgb(24, 24, 27)');
  step('no minutes for 5 min: Not counting, badge HUNG, dark UI, no false "earning" label');

  // On-page warning: real DOM on the real tab, readable without opening anything.
  const pillText = (page) => page.evaluate(() => {
    const h = document.getElementById('drops-tracker-pill');
    return h && h.style.display !== 'none' ? h.shadowRoot.querySelector('span').textContent : null;
  });
  assert.match(await pillText(alpha), /^Drops not counting for [1-9]\d* min$/);
  await alpha.waitForFunction(() => document.getElementById('drops-tracker-chip').dataset.tone === 'bad');
  assert.match((await chip(alpha)).text, /^Hung [1-9]\d*m$/);
  await alpha.bringToFront();
  await alpha.screenshot({ path: join(out, '6-on-page-pill.png') });
  const box = await alpha.evaluate(() => {
    const r = document.getElementById('drops-tracker-pill').getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  assert.ok(box.h <= 30 && box.w <= 260, `pill too big: ${JSON.stringify(box)}`);
  await alpha.evaluate(() => document.getElementById('drops-tracker-pill').shadowRoot.querySelector('button').click());
  await advance(1);
  s = await poll();
  assert.equal(await pillText(alpha), null, 'dismissed pill stays dismissed this episode');
  step(`pill shows on the stream tab at ${Math.round(box.w)}x${Math.round(box.h)}px and stays dismissed`);

  // 5. The reload button really reloads the right tab, and progress recovering clears the alarm.
  const reloaded = alpha.waitForEvent('load', { timeout: 10000 });
  await popup.bringToFront();
  await popup.click('#verdict-action');
  await reloaded;
  await advance(1, 1);
  await alpha.waitForFunction(() => document.querySelector('video').currentTime > 0.3);
  s = await poll();
  assert.equal(s.verdict.code, 'earning');
  assert.equal(await badgeText(), '85%'); // 195 + 9 added so far = 204 of 240
  assert.equal(await pillText(bravo), null);
  step('Reload button reloads the AlphaTV tab; next minute clears the alarm and the pill');

  // Silent loss: the channel changes game while you watch.
  await sw.evaluate(() => { self.__noCampaigns = true; });
  for (let i = 0; i < 3; i++) { await advance(1); await alpha.waitForTimeout(150); s = await poll(); }
  assert.equal(s.verdict.lost, true, JSON.stringify(s.verdict));
  assert.equal(await badgeText(), 'STOP');
  assert.equal(await pillText(alpha), 'Stopped earning Drops');
  await shot('7-stopped-earning');
  await sw.evaluate(() => { self.__noCampaigns = false; });
  await advance(1, 1);
  s = await poll();
  assert.equal(s.verdict.code, 'earning');
  assert.equal(await pillText(alpha), null);
  step('channel losing its drops mid-watch warns: badge STOP and pill, cleared on recovery');

  // 6. A genuinely hung player: not paused, no data, clock not moving.
  await alpha.evaluate(() => { const v = document.querySelector('video'); v.srcObject = null; v.play().catch(() => {}); });
  await poll();
  for (let i = 0; i < 3; i++) { await advance(1); await alpha.waitForTimeout(150); s = await poll(); }
  assert.equal(s.verdict.cause, 'frozen', JSON.stringify(s.verdict));
  await shot('4-stalled-frozen');
  step('hung player detected and named');

  // Auto-refresh of the Drops page, driven through the real toggle.
  const dropsPage = await ctx.newPage();
  await dropsPage.goto('https://www.twitch.tv/drops/inventory');
  let dropsLoads = 0;
  let streamLoads = 0;
  dropsPage.on('load', () => { dropsLoads++; });
  alpha.on('load', () => { streamLoads++; });
  await popup.bringToFront();
  await popup.click('#tab-settings');
  assert.equal(await popup.isChecked('#auto-refresh'), false, 'off, as switched off at the start');
  assert.equal(await popup.isVisible('#auto-refresh-every'), false);
  for (let i = 0; i < 6; i++) { await advance(1); await poll(); }
  await dropsPage.waitForTimeout(800);
  assert.equal(dropsLoads, 0, 'off means never');
  await popup.click('.toggle');
  assert.equal(await popup.isChecked('#auto-refresh'), true);
  assert.equal(await popup.inputValue('#auto-refresh-minutes'), '5');
  await poll(); // Starts the timer without reloading.
  for (let i = 0; i < 4; i++) { await advance(1); await poll(); }
  await dropsPage.waitForTimeout(800);
  assert.equal(dropsLoads, 0, 'not before the interval');
  await advance(1);
  await poll();
  await dropsPage.waitForTimeout(1200);
  assert.equal(dropsLoads, 1, 'reloads once at the interval');
  await popup.selectOption('#auto-refresh-minutes', '1');
  await advance(1);
  await poll();
  await dropsPage.waitForTimeout(1200);
  assert.equal(dropsLoads, 2, 'a new interval applies');
  assert.equal(streamLoads, 0, 'stream tabs must never be reloaded by this');
  await popup.screenshot({ path: join(out, '13-auto-refresh-on.png'), fullPage: true });
  const savedSettings = await popup.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.deepEqual(savedSettings, { autoRefresh: true, autoRefreshMinutes: 1, autoReload: false, devMode: true });
  await popup.click('.toggle');
  await advance(2);
  await poll();
  await dropsPage.waitForTimeout(800);
  assert.equal(dropsLoads, 2, 'switching off stops it');
  await dropsPage.close();
  await popup.click('#tab-mine');
  step('auto-refresh: off when switched off, reloads the Drops page on the chosen interval, never a stream tab');

  // What Twitch breaking looks like. Bodies are the real ones captured on 2026-11-06.
  const STALE = { errors: [{ message: 'PersistedQueryNotFound', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }] };
  const earningNow = async () => { await advance(1, 1); return poll(); };

  // The rewards field failing, as it does on about half of real calls, must change nothing.
  await sw.evaluate(() => {
    self.__transform = (answer, ops) => answer.map((a, i) => {
      if (ops[i].operationName !== 'Inventory') return a;
      a.data.currentUser.inventory.gameEventDrops = null;
      return { ...a, errors: [{ message: 'service error', path: ['currentUser', 'inventory', 'gameEventDrops'] }] };
    });
  });
  s = await earningNow();
  assert.equal(s.verdict.code, 'earning', JSON.stringify(s.verdict));
  assert.notEqual(await badgeText(), 'ERR');
  step('real partial error on rewards: still reads progress, stays Earning');

  // A channel lookup hash retiring: progress keeps working, and eligibility is not guessed.
  await sw.evaluate((stale) => {
    self.__transform = (answer, ops) => answer.map((a, i) => (ops[i].operationName === 'DropsHighlightService_AvailableDrops' ? stale : a));
  }, STALE);
  s = await earningNow();
  assert.equal(s.verdict.code, 'earning');
  for (let i = 0; i < 4; i++) { await advance(1); s = await poll(); }
  assert.equal(s.verdict.limited, true, JSON.stringify(s.verdict));
  assert.notEqual(s.verdict.code, 'stalled', 'a blind spot must not be called a stall');
  assert.equal(await badgeText(), '?');
  await shot('15-cannot-check-streams');
  await sw.evaluate(() => { self.__transform = null; });
  s = await earningNow();
  assert.equal(s.verdict.code, 'earning');
  step('channel lookup retired: progress still read, says it cannot check rather than Hung; recovers');

  // Inventory's hashes all retiring, and repair from Twitch's own page. The fake channel page
  // sends a real request, so the real webRequest listener really sees it.
  const NEW_HASH = 'c'.repeat(64);
  await alpha.evaluate(async (hash) => {
    await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'text/plain' },
      body: JSON.stringify([{ operationName: 'Inventory', variables: {}, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }]),
    }).catch(() => {});
  }, NEW_HASH);
  await popup.waitForFunction(async (hash) => (await chrome.storage.local.get('hashes')).hashes?.learned?.Inventory === hash, NEW_HASH, { timeout: 5000 });
  await sw.evaluate(([stale, hash]) => {
    self.__transform = (answer, ops) => answer.map((a, i) => (ops[i].operationName === 'Inventory' && ops[i].extensions.persistedQuery.sha256Hash !== hash ? stale : a));
  }, [STALE, NEW_HASH]);
  s = await earningNow();
  assert.equal(s.verdict.code, 'earning', `should self-repair: ${JSON.stringify(s.verdict)}`);
  const working = await popup.evaluate(async () => (await chrome.storage.local.get('hashes')).hashes.working.Inventory);
  assert.equal(working, NEW_HASH);
  step('every pinned Inventory hash retired: repaired itself from a hash Twitch\'s page used');

  // No hash left at all: says so, keeps the data, and warns straight away.
  await popup.evaluate(() => chrome.storage.local.remove('hashes'));
  await sw.evaluate((stale) => {
    self.__transform = (answer, ops) => answer.map((a, i) => (ops[i].operationName === 'Inventory' ? stale : a));
  }, STALE);
  s = await poll();
  assert.equal(s.verdict.code, 'api_changed', JSON.stringify(s.verdict));
  assert.equal(await badgeText(), 'ERR');
  assert.equal(s.active.length, 1, 'last good data kept');
  assert.equal(await pillText(alpha), 'Drops not being tracked');
  await shot('16-cannot-track');
  step('all hashes dead: Cannot track, tells you how to repair it, warns at once, not Hung');

  // Malformed data must become a visible error, then recover without a reload.
  await sw.evaluate(() => {
    self.__transform = (answer, ops) => answer.map((a, i) => {
      if (ops[i].operationName === 'Inventory') a.data.currentUser.inventory.dropCampaignsInProgress = [null];
      return a;
    });
  });
  s = await poll();
  assert.equal(s.verdict.code, 'error', JSON.stringify(s.verdict));
  assert.equal(await badgeText(), 'ERR');
  await sw.evaluate(() => { self.__transform = null; });
  s = await earningNow();
  assert.equal(s.verdict.code, 'earning');
  step('malformed campaign data: shows an error, polling survives, recovers by itself');

  // Saved state from an older or damaged version must not stop polling.
  await popup.evaluate(() => chrome.storage.local.set({ state: { verdict: null, timeline: 'x', drops: 5 } }));
  s = await poll();
  assert.ok(s?.verdict?.code, 'poll must survive damaged state');
  s = await earningNow();
  assert.equal(s.verdict.code, 'earning');
  step('damaged saved state: polling survives');

  // Minutes going where they cannot help: the panel says so in amber, from the tracker's verdict.
  const wastedMsg = "AlphaTV's loyalty badge is already earned, but Twitch is still crediting it, so these minutes do nothing. Bravo can earn Marvel Rivals: close or pause AlphaTV.";
  await popup.evaluate(async (message) => {
    const { state } = await chrome.storage.local.get('state');
    await chrome.storage.local.set({ state: { ...state, verdict: { ...state.verdict, code: 'earning', wasted: { reason: 'earned', message } } } });
  }, wastedMsg);
  await popup.waitForFunction(() => document.getElementById('verdict').dataset.tone === 'warn');
  assert.equal(await popup.textContent('#verdict-detail'), wastedMsg);
  assert.match(await popup.textContent('#verdict-title'), /^Earning/);
  s = await poll();
  await popup.waitForFunction(() => document.getElementById('verdict').dataset.tone === 'ok');
  step('minutes credited to an earned drop: amber, says which tab could earn instead; clears on the next poll');

  // A tracker that stopped polling must not keep showing good news.
  await popup.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    await chrome.storage.local.set({ state: { ...state, lastPollAt: Date.now() - 10 * 60000 } });
  });
  await popup.waitForFunction(() => document.querySelector('#verdict-title').textContent === 'Cannot read Twitch');
  assert.match(await popup.textContent('#verdict-detail'), /has not updated for 10 min/);
  s = await poll();
  assert.equal(await popup.textContent('#verdict-title').then((t) => t.startsWith('Earning') || t === 'Checking'), true);
  step('stopped polling: the panel stops saying Earning and says so; clears on the next poll');

  // A channel's own badge campaign, from real answers: never in Inventory, so only the session
  // reports it. A timer badge is tracked like any drop: flat warns, and rising reads as earning.
  const badgeFx = loadFixture(root, 'badge-2026-11-06.json');
  await sw.evaluate((b) => {
    self.__badgeMinutes = 3;
    self.__transform = (answer, ops) => answer.map((a, i) => {
      switch (ops[i].operationName) {
        case 'Inventory': a.data.currentUser.inventory.dropCampaignsInProgress = []; return a;
        case 'DropsHighlightService_AvailableDrops': return { data: { channel: ops[i].variables.channelID === '10000001' ? b.mixed : { viewerDropCampaigns: null } } };
        case 'DropCurrentSessionContext': return { data: { currentUser: { dropCurrentSession: ops[i].variables.channelID === '10000001' ? { ...b.mixedSession, channel: { displayName: 'AlphaTV', id: '10000001', name: 'alphatv' }, currentMinutesWatched: self.__badgeMinutes } : b.zeroedSession } } };
        default: return a;
      }
    });
  }, badgeFx);
  for (let i = 0; i < 6; i++) { await advance(1); s = await poll(); }
  const badgeRow = s.streams.find((t) => t.login === 'alphatv');
  assert.equal(badgeRow.channelState, 'eligible', JSON.stringify(s.streams));
  assert.notEqual(s.verdict.limited, true, 'a timer badge must not read as Drops ?');
  assert.equal(s.verdict.code, 'stalled', JSON.stringify(s.verdict));
  assert.equal(await badgeText(), 'HUNG');
  assert.match(await pillText(alpha), /^Drops not counting for /);
  await popup.bringToFront();
  await popup.waitForFunction(() => /The Two Rings/.test(document.getElementById('drops').textContent));
  assert.equal(await popup.isVisible('#drops-section'), true, 'a timer badge is listed with the other drops');
  await shot('21-badge-flat');
  await sw.evaluate(() => { self.__badgeMinutes = 4; });
  await advance(1);
  s = await poll();
  assert.equal(s.verdict.code, 'earning', JSON.stringify(s.verdict));
  assert.equal(s.verdict.channel, 'AlphaTV');
  assert.equal(s.streams.find((t) => t.login === 'alphatv').channelState, 'eligible');
  await shot('22-badge-earning');
  // The Badges tab. The popup sits over a non-channel page here, so it lists any open channel.
  await popup.click('#tab-badges');
  await popup.waitForFunction(() => /The Two Rings/.test(document.getElementById('view-badges').textContent));
  const badgesShown = await popup.textContent('#view-badges');
  assert.match(badgesShown, /AlphaTV/);
  assert.match(badgesShown, /The Big Three-O/);
  assert.match(badgesShown, /Subscribe or gift a sub to earn/);
  assert.match(badgesShown, /Watch 2h 56m to earn/);
  assert.doesNotMatch(badgesShown, /Bravo/, 'a channel with no badges is left out here');
  assert.equal(await popup.locator('#view-badges .bar').count(), 1, 'only the watch drop has a bar');
  assert.equal(await popup.isVisible('#verdict'), false);
  await shot('23-badges-tab');
  await popup.click('#tab-mine');
  assert.equal(await popup.isVisible('#verdict'), true);
  // In chat it follows the channel of that page, including one with no badges.
  await alpha.bringToFront();
  await alpha.evaluate(() => document.getElementById('drops-tracker-chip').shadowRoot.querySelector('button').click());
  await alpha.waitForFunction(() => document.getElementById('drops-tracker-panel')?.style.visibility === '');
  await alpha.click('#drops-tracker-panel #tab-badges');
  await alpha.waitForFunction(() => /The Two Rings/.test(document.getElementById('drops-tracker-panel').shadowRoot.getElementById('view-badges').textContent));
  await alpha.screenshot({ path: join(out, '24-badges-in-chat.png') });
  const chatBadgeFit = await alpha.evaluate(() => { const h = document.getElementById('drops-tracker-panel'); return h.scrollHeight - h.clientHeight; });
  assert.equal(chatBadgeFit, 0, 'the Badges tab must not scroll');
  await alpha.keyboard.press('Escape');
  await bravo.bringToFront();
  await bravo.evaluate(() => document.getElementById('drops-tracker-chip').shadowRoot.querySelector('button').click());
  await bravo.waitForFunction(() => document.getElementById('drops-tracker-panel')?.style.visibility === '');
  await bravo.click('#drops-tracker-panel #tab-badges');
  await bravo.waitForFunction(() => /No badge drops on this channel/.test(document.getElementById('drops-tracker-panel').shadowRoot.getElementById('view-badges').textContent));
  // Bravo has no drops, and AlphaTV is earning in another tab: the list says that is where they are.
  await bravo.click('#drops-tracker-panel #tab-mine');
  assert.equal(await bravo.textContent('#drops-tracker-panel #drops-label'), 'Watch Drops on AlphaTV');
  assert.match(await bravo.textContent('#drops-tracker-panel #drops'), /The Two Rings/);
  assert.equal(await bravo.locator('#drops-tracker-panel #drops .card').count(), s.active.filter((d) => s.streams.find((t) => t.login === 'alphatv').campaignIds.includes(d.campaignId)).length);
  await bravo.keyboard.press('Escape');
  step('a channel with no drops lists only what another open tab is earning, and names that tab');
  await popup.bringToFront();
  step('Badges tab: shows sub and watch drops with progress, follows the channel, and says when there are none');
  await sw.evaluate(() => { self.__transform = null; self.__minutes += 1; });
  await advance(1);
  s = await poll();
  step('timer badge: listed in My Drops, flat minutes warn as HUNG, rising minutes read as earning');

  // Auto-reload, through the real toggle and real tab reloads. The channel page is fake, so no
  // stream plays. A badge is tracked the same way, so what holds here holds for one.
  let alphaLoads = 0;
  let bravoLoads = 0;
  const onAlphaLoad = () => { alphaLoads++; };
  const onBravoLoad = () => { bravoLoads++; };
  alpha.on('load', onAlphaLoad);
  bravo.on('load', onBravoLoad);
  const flatPoll = async () => {
    await advance(1);
    await alpha.waitForFunction(() => document.querySelector('video')?.readyState >= 2 && document.querySelector('video').currentTime > 0.1);
    await alpha.waitForTimeout(120);
    s = await poll();
    await alpha.waitForTimeout(150);
  };
  await alpha.evaluate(() => { const v = document.querySelector('video'); if (!v.srcObject) location.reload(); });
  await alpha.waitForFunction(() => document.querySelector('video')?.currentTime > 0.3);
  alphaLoads = 0;
  await popup.bringToFront();
  assert.equal(await popup.isChecked('#auto-reload'), false, 'off, as switched off at the start');
  await advance(1, 1);
  await poll();
  for (let i = 0; i < 9; i++) await flatPoll();
  assert.equal(s.verdict.code, 'stalled', JSON.stringify(s.verdict));
  assert.equal(alphaLoads, 0, 'off means never, however long it is hung');
  await popup.click('#tab-settings');
  await popup.locator('.toggle').nth(1).click();
  assert.equal(await popup.isChecked('#auto-reload'), true);
  await popup.click('#tab-mine');
  assert.equal((await popup.evaluate(async () => (await chrome.storage.local.get('settings')).settings)).autoReload, true);
  await flatPoll();
  await alpha.waitForFunction(() => document.querySelector('video')?.currentTime > 0.1);
  assert.equal(alphaLoads, 1, 'reloads the hung tab once switched on, past the wait');
  await popup.bringToFront();
  await popup.waitForFunction(() => /Auto-reloaded 1 of 3/.test(document.getElementById('auto-reload-note').textContent));
  await popup.screenshot({ path: join(out, '25-auto-reloaded.png'), fullPage: true });
  for (let i = 0; i < 9; i++) await flatPoll();
  assert.equal(alphaLoads, 1, 'waits 10 minutes between tries');
  await flatPoll();
  assert.equal(alphaLoads, 2);
  for (let i = 0; i < 10; i++) await flatPoll();
  assert.equal(alphaLoads, 3);
  for (let i = 0; i < 12; i++) await flatPoll();
  assert.equal(alphaLoads, 3, 'stops at the limit for one hang');
  await popup.bringToFront();
  await popup.waitForFunction(() => /did not help/.test(document.getElementById('auto-reload-note').textContent));
  assert.equal(bravoLoads, 0, 'never reloads a tab that is not the hung one');
  await advance(1, 1);
  s = await poll();
  assert.equal(s.verdict.code, 'earning', JSON.stringify(s.verdict));
  await popup.waitForFunction(() => /Minutes came back \d+m after an auto-reload/.test(document.getElementById('auto-reload-note').textContent));
  await popup.click('#tab-settings');
  await popup.locator('.toggle').nth(1).click();
  assert.equal(await popup.isChecked('#auto-reload'), false);
  await popup.click('#tab-mine');
  alpha.off('load', onAlphaLoad);
  bravo.off('load', onBravoLoad);
  await alpha.waitForFunction(() => document.getElementById('drops-tracker-chip'));
  step('auto-reload: off when switched off, reloads only the hung tab, 10 minutes apart, stops at 3, reports recovery');

  // The minute log, read from a real video in a real tab through the real poll.
  // Bravo was paused at step 4; the log is checked with both playing.
  await bravo.evaluate(() => document.querySelector('video').play());
  await bravo.waitForFunction(() => !document.querySelector('video').paused);
  await alpha.bringToFront();
  await alpha.waitForFunction(() => document.querySelector('video')?.currentTime > 0.3);
  await popup.evaluate(() => chrome.storage.local.remove('minuteLog'));
  await advance(1, 1);
  await poll();
  await advance(1, 1);
  await poll();
  const logged = await popup.evaluate(async () => (await chrome.storage.local.get('minuteLog')).minuteLog);
  assert.ok(logged?.length >= 1, 'a watched minute must be logged');
  const minuteSeen = logged[logged.length - 1];
  assert.equal(minuteSeen.c, 'alphatv');
  assert.equal(minuteSeen.d, 1);
  assert.equal(minuteSeen.e, 1, 'only one of the two channels can earn');
  assert.equal(minuteSeen.p, 2, 'both fake streams are playing');
  assert.equal(minuteSeen.pm, 1, 'the fake player is muted');
  assert.equal(minuteSeen.v0, 0, 'its volume is not zero');
  assert.equal(minuteSeen.tm, 0);
  assert.equal(minuteSeen.q, 36, 'the fake video is 36px tall');
  assert.equal(minuteSeen.ad, 0);
  assert.equal(typeof minuteSeen.s, 'number');
  await popup.evaluate(async () => {
    const minuteLog = [];
    for (let m = 0; m < 12; m++) minuteLog.push({ m, d: 1, e: 1, p: 1, h: 0, pm: 0, v0: 0, tm: 0, q: 720, s: 100, ad: 0 });
    for (let m = 12; m < 24; m++) minuteLog.push({ m, d: 0, e: 1, p: 2, h: 0, pm: 0, v0: 0, tm: 0, q: 720, s: 100, ad: 0 });
    for (let m = 24; m < 27; m++) minuteLog.push({ m, st: 'paused', d: 0, e: 1, p: 1, h: 1, pm: 1, v0: 0, tm: 0, q: 720, s: 0, ad: 0 });
    await chrome.storage.local.set({ minuteLog });
  });
  await popup.bringToFront();
  await popup.waitForFunction(() => /Lost minutes: 12 of 24 watched/.test(document.getElementById('log-summary').textContent));
  await popup.click('#tab-settings');
  assert.equal(await popup.isVisible('#verdict'), false, 'the tabs show one view at a time');
  await popup.click('#log-section summary');
  const logText = await popup.textContent('#log-rows');
  assert.match(logText, /Two or more streams playing: 0 of 12 counted \(0%\)/);
  assert.match(logText, /One stream playing: 12 of 12 counted \(100%\)/);
  assert.equal(await popup.textContent('#log-paused'), '3 paused minutes left out.');
  await popup.screenshot({ path: join(out, '26-minute-log.png'), fullPage: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `chrome-extension://${extId}` }).catch(() => {});
  await popup.click('#log-copy');
  await popup.waitForFunction(() => /Copied|Copy failed/.test(document.getElementById('log-copy').textContent));
  const copied = await popup.textContent('#log-copy');
  console.log(`   copy from the toolbar panel: ${copied}`);
  await popup.click('#log-clear');
  await popup.waitForFunction(() => /No watched minutes logged yet/.test(document.getElementById('log-rows').textContent));
  assert.equal(await popup.textContent('#log-summary'), 'Lost minutes');
  assert.equal(await popup.isVisible('#log-paused'), false);

  // The Debug tab, read off the real state, and a copy read back from the real clipboard.
  await popup.click('#debug-status summary');
  const debugShown = await popup.textContent('#debug-rows');
  assert.match(debugShown, /Verdict/);
  assert.match(debugShown, /Last check/);
  assert.match(debugShown, new RegExp(`Version${JSON.parse(readFileSync(join(ext, 'manifest.json'))).version.replace(/\./g, '\\.')}`));
  assert.match(await popup.textContent('#debug-streams'), /AlphaTV.*eligible.*playing/);
  await popup.screenshot({ path: join(out, '27-debug-tab.png'), fullPage: true });
  const beforeCheck = (await state()).lastPollAt;
  await advance(1);
  await popup.click('#debug-poll');
  await popup.waitForFunction(async (t) => (await chrome.storage.local.get('state')).state.lastPollAt > t, beforeCheck, { timeout: 8000 });
  // Reading the clipboard back is refused in this test browser, so see the text on its way in.
  await popup.evaluate(() => {
    const real = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text) => { window.__copied = text; return real(text); };
  });
  await popup.click('#debug-copy');
  await popup.waitForFunction(() => /Copied|Copy failed/.test(document.getElementById('debug-copy').textContent));
  assert.equal(await popup.textContent('#debug-copy'), 'Copied', 'the toolbar panel must be able to copy');
  const pasted = JSON.parse(await popup.evaluate(() => window.__copied));
  assert.equal(typeof pasted.state.verdict.code, 'string');
  assert.ok(pasted.state.streams.length >= 2);
  assert.equal(pasted.settings.autoReload, false);
  assert.ok(Object.keys(pasted.hashes.working).length > 0, 'the working query hashes are what a Twitch change needs');
  assert.equal(JSON.stringify(pasted).includes('e2einvalidtoken'), false, 'the login token must never be copied');
  await popup.click('#tab-mine');
  assert.equal(await popup.isVisible('#auto-reload'), false, 'settings live in the Settings tab');
  step('minute log: records real player state each minute, compares conditions, clears');
  // In the chat panel too, where the module has to load under Twitch's page.
  await alpha.bringToFront();
  await alpha.evaluate(() => document.getElementById('drops-tracker-chip').shadowRoot.querySelector('button').click());
  await alpha.waitForFunction(() => document.getElementById('drops-tracker-panel')?.style.visibility === '');
  await alpha.click('#drops-tracker-panel #tab-settings');
  await alpha.waitForSelector('#drops-tracker-panel #auto-reload-note', { state: 'attached' });
  const debugFit = await alpha.evaluate(() => { const h = document.getElementById('drops-tracker-panel'); return h.scrollHeight - h.clientHeight; });
  assert.equal(debugFit, 0, 'the Settings tab must not scroll while its sections are closed');
  await alpha.screenshot({ path: join(out, '28-debug-in-chat.png') });
  await alpha.keyboard.press('Escape');
  await popup.bringToFront();
  step('Settings tab with Developer mode: holds the settings and log, shows real state, runs a check, copies with no token');

  // All Drops. The list only comes from Twitch's own page, so this drives the real path: a real
  // background tab, the real page-world hook on a real fetch, the real bridge to the worker.
  const realNow = Date.now();
  const inDays = (d) => new Date(realNow + d * 86400000).toISOString();
  const liveCampaign = (i, patch = {}) => ({
    ...structuredClone(dashboard.data.currentUser.dropCampaigns[0]),
    id: `live-${i}`,
    name: `Campaign ${i}`,
    startAt: inDays(-1),
    endAt: inDays(1 + i / 10),
    game: { boxArtURL: null, displayName: `Game ${i}`, id: String(i) },
    ...patch,
  });
  const buildDashboard = (count, extra = []) => [
    { data: {} },
    {
      data: {
        currentUser: {
          id: '0',
          login: 'fixture',
          dropCampaigns: [
            ...Array.from({ length: count }, (_, i) => liveCampaign(i)),
            liveCampaign(900, { id: fx.campaigns[1].id, name: 'Mine', game: { boxArtURL: null, displayName: 'Tracked Game', id: '900' }, endAt: inDays(30) }),
            liveCampaign(901, { name: 'Over', game: { boxArtURL: null, displayName: 'Expired Game', id: '901' }, status: 'EXPIRED', endAt: inDays(-1) }),
            liveCampaign(902, { name: 'Lag', game: { boxArtURL: null, displayName: 'Ended Still Active', id: '902' }, endAt: inDays(-0.01) }),
            ...extra,
          ],
        },
        rewardCampaignsAvailableToUser: [{ ...structuredClone(dashboard.data.rewardCampaignsAvailableToUser[0]), startsAt: inDays(-1), endsAt: inDays(60) }],
      },
    },
  ];
  let dashboardBody = buildDashboard(115);
  await ctx.route('https://gql.twitch.tv/**', (r) => {
    if (!r.request().postData()?.includes('ViewerDropsDashboard')) return r.fallback();
    const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    if (dashboardMode === 'integrity') {
      return r.fulfill({ headers, body: JSON.stringify([{ data: {} }, { errors: [{ message: 'failed integrity check', extensions: { code: 'IntegrityCheckFailed' }, path: ['currentUser', 'dropCampaigns'] }], data: { currentUser: { id: '0', login: 'x', dropCampaigns: null }, rewardCampaignsAvailableToUser: [] } }]) });
    }
    return r.fulfill({ headers, body: JSON.stringify(dashboardBody) });
  });
  // Real Twitch clears an invalid token whenever it sees one, so put it back before each step that needs it.
  const fakeLogin = () => sw.evaluate(() => chrome.cookies.set({ url: 'https://www.twitch.tv', name: 'auth-token', value: 'e2einvalidtoken0000000000000000', domain: '.twitch.tv', secure: true }));
  const campaignTabs = () => ctx.pages().filter((p) => p.url().includes('/drops/campaigns')).length;
  const dirRows = (page) => page.$$eval('#dir-list .dir-row', (rows) => rows.map((r) => r.querySelector('.strong').textContent));

  await popup.bringToFront();
  assert.equal(await popup.isVisible('#view-mine'), true, 'must open on My Drops so a warning is seen first');
  assert.equal(campaignPageLoads, 0, 'nothing loads until the tab is opened');
  await sw.evaluate(() => { self.__created = []; chrome.tabs.onCreated.addListener((t) => self.__created.push(t.active)); });
  await popup.click('#tab-all');
  await popup.waitForSelector('#dir-list .dir-row', { timeout: 15000 });
  let dirText = await popup.textContent('#dir-status');
  assert.match(dirText, /^117 active, updated /, 'expired and ended campaigns must not count');
  let rows = await dirRows(popup);
  assert.equal(rows[0], 'Tracked Game', 'your campaign comes first');
  assert.equal(rows[1], 'Pokémon Night Out Campaign', 'then the sitewide reward');
  assert.equal(rows.includes('Expired Game'), false);
  assert.equal(rows.includes('Ended Still Active'), false);
  assert.match(await popup.textContent('#dir-list .dir-row .tag'), /^\d+% done$/);
  assert.equal(campaignPageLoads, 1);
  assert.deepEqual(await sw.evaluate(() => self.__created), [false], 'the tab must open in the background');
  await popup.waitForFunction(async () => (await chrome.tabs.query({ url: 'https://www.twitch.tv/drops/campaigns*' })).length === 0);
  assert.equal(campaignTabs(), 0, 'the background tab must close itself');
  step('All Drops: opened from a background tab that closes itself; yours first, expired and ended left out');

  // The whole point of the layout: 117 rows in a panel that does not scroll.
  await popup.waitForTimeout(300);
  await popup.setViewportSize({ width: 326, height: 600 });
  const popupFit = await popup.evaluate(() => {
    const list = document.getElementById('dir-list');
    return { page: document.documentElement.scrollHeight, listMax: getComputedStyle(list).maxHeight, scrolls: list.scrollHeight > list.clientHeight, height: list.clientHeight, width: document.querySelector('.panel').offsetWidth, sideways: list.scrollWidth - list.clientWidth };
  });
  assert.ok(popupFit.page <= 600, `popup must fit its 600px limit: ${JSON.stringify(popupFit)}`);
  assert.equal(popupFit.scrolls, true);
  assert.equal(popupFit.width, 326);
  assert.equal(popupFit.sideways, 0);
  assert.notEqual(popupFit.listMax, 'none', 'the CSS size must really apply in a browser');
  await popup.screenshot({ path: join(out, '17-all-drops.png') });
  step(`117 campaigns fit: list scrolls inside (${popupFit.height}px), panel ${popupFit.page}px with no scroll of its own`);

  // Search, and that a row opens with the right links.
  await popup.fill('#dir-search', 'game 11');
  await popup.waitForFunction(() => document.querySelectorAll('#dir-list .dir-row').length < 10);
  assert.match(await popup.textContent('#dir-status'), /^\d+ of 117 active/);
  await popup.click('#dir-list .dir-row summary');
  const opened = await popup.$eval('#dir-list .dir-row', (r) => ({ open: r.open, links: [...r.querySelectorAll('a')].map((a) => [a.textContent, a.href]) }));
  assert.equal(opened.open, true);
  assert.deepEqual(opened.links.map((l) => l[0]), ['Browse streams', 'Link account']);
  assert.match(opened.links[0][1], /^https:\/\/www\.twitch\.tv\/directory\/game\/Game%2011/);
  await popup.waitForTimeout(1500);
  assert.equal(await popup.$eval('#dir-list .dir-row', (r) => r.open), true, 'the 1s refresh must not close an open row');
  await popup.screenshot({ path: join(out, '18-all-drops-search.png') });
  await popup.fill('#dir-search', 'zzzz');
  await popup.waitForFunction(() => /No active Drops match/.test(document.getElementById('dir-list').textContent));
  await popup.fill('#dir-search', '');
  step('search filters and says when nothing matches; an open row survives the 1s refresh');

  // No extra page loads from a list that is still fresh.
  await popup.click('#tab-mine');
  assert.equal(await popup.isVisible('#verdict'), true);
  await popup.click('#tab-all');
  await popup.waitForSelector('#dir-list .dir-row');
  await popup.waitForTimeout(400);
  assert.equal(campaignPageLoads, 1, 'a fresh list must not open another tab');
  step('reopening the tab uses the saved list and opens nothing');

  // Twitch failing: the old list stays with its age, the failure says so, the tab still closes.
  dashboardMode = 'integrity';
  await fakeLogin();
  await popup.click('#dir-refresh');
  await popup.waitForFunction(() => !document.getElementById('dir-error').hidden, null, { timeout: 15000 });
  assert.match(await popup.textContent('#dir-error'), /changed how this list loads/);
  assert.equal((await dirRows(popup)).length, 117, 'a failure must keep the last list');
  await popup.waitForFunction(async () => (await chrome.tabs.query({ url: 'https://www.twitch.tv/drops/campaigns*' })).length === 0);
  await popup.screenshot({ path: join(out, '19-all-drops-failed.png') });
  step('integrity failure: says so, keeps the last list, closes the tab');

  dashboardMode = 'silent';
  await fakeLogin();
  await popup.click('#dir-refresh');
  await popup.waitForFunction(() => /did not answer/.test(document.getElementById('dir-error').textContent), null, { timeout: 35000 });
  assert.equal(await popup.$eval('#foot-link', (a) => a.href), 'https://www.twitch.tv/drops/campaigns', 'the fallback link must be there');
  await popup.waitForFunction(async () => (await chrome.tabs.query({ url: 'https://www.twitch.tv/drops/campaigns*' })).length === 0);
  const beforeRetry = campaignPageLoads;
  await popup.click('#tab-mine');
  await popup.click('#tab-all');
  await popup.waitForTimeout(600);
  assert.equal(campaignPageLoads, beforeRetry, 'a recent failure must not reopen a tab on every click');
  step('Twitch\'s page never answering: times out, tab closed, offers the link, no retry on every click');

  // Visiting the page yourself repairs the list, with no background tab involved.
  dashboardMode = 'ok';
  dashboardBody = buildDashboard(3, [liveCampaign(903, { game: { boxArtURL: null, displayName: 'New <b>Game</b>', id: '903' } })]);
  const visit = await ctx.newPage();
  await visit.goto('https://www.twitch.tv/drops/campaigns');
  await visit.waitForFunction(() => document.title === 'read:2', null, { timeout: 8000 });
  await popup.bringToFront();
  await popup.waitForFunction(() => document.querySelectorAll('#dir-list .dir-row').length === 6, null, { timeout: 8000 });
  assert.equal(await popup.isVisible('#dir-error'), false, 'a good answer clears the failure');
  const injected = await popup.$$eval('#dir-list b', (b) => b.length);
  assert.equal(injected, 0, 'names from Twitch must never become markup');
  await visit.close();
  step('visiting Twitch\'s page refreshes the list by itself and clears the failure; names cannot inject markup');

  // Logged out: says so without opening a page.
  await sw.evaluate(() => chrome.cookies.remove({ url: 'https://www.twitch.tv', name: 'auth-token' }));
  const beforeOut = campaignPageLoads;
  await popup.click('#dir-refresh');
  await popup.waitForFunction(() => /Log in/.test(document.getElementById('dir-error').textContent));
  assert.equal(campaignPageLoads, beforeOut);
  step('signed out: says so and opens nothing');

  // The chat panel, on the page, where Twitch's keyboard shortcuts live.
  dashboardBody = buildDashboard(115);
  await fakeLogin();
  await popup.click('#dir-refresh');
  await popup.waitForFunction(() => document.querySelectorAll('#dir-list .dir-row').length === 117, null, { timeout: 15000 });
  await alpha.bringToFront();
  await alpha.setViewportSize({ width: 400, height: 720 });
  await alpha.evaluate(() => {
    window.__keys = 0;
    document.addEventListener('keydown', () => { window.__keys++; });
    document.getElementById('drops-tracker-chip').shadowRoot.querySelector('button').click();
  });
  await alpha.waitForFunction(() => document.getElementById('drops-tracker-panel')?.style.visibility === '');
  await alpha.click('#drops-tracker-panel #tab-all');
  await alpha.waitForSelector('#drops-tracker-panel #dir-list .dir-row');
  const chatFit = await alpha.evaluate(() => {
    const host = document.getElementById('drops-tracker-panel');
    const list = host.shadowRoot.getElementById('dir-list');
    const chip = document.getElementById('drops-tracker-chip').getBoundingClientRect();
    const r = host.getBoundingClientRect();
    return { extraY: host.scrollHeight - host.clientHeight, extraX: host.scrollWidth - host.clientWidth, top: r.top, gap: chip.top - r.bottom, scrolls: list.scrollHeight > list.clientHeight, width: host.shadowRoot.querySelector('.panel').offsetWidth, avail: host.style.getPropertyValue('--dt-avail') };
  });
  assert.deepEqual([chatFit.extraY, chatFit.extraX], [0, 0], `chat panel must not scroll: ${JSON.stringify(chatFit)}`);
  assert.ok(chatFit.top >= 0 && chatFit.gap >= 0, JSON.stringify(chatFit));
  assert.equal(chatFit.scrolls, true);
  await alpha.screenshot({ path: join(out, '20-all-drops-in-chat.png') });
  await alpha.click('#drops-tracker-panel #dir-search');
  await alpha.keyboard.type('fm');
  assert.equal(await alpha.inputValue('#drops-tracker-panel #dir-search'), 'fm');
  assert.equal(await alpha.evaluate(() => window.__keys), 0, 'typed letters must not reach Twitch\'s page shortcuts');
  await alpha.keyboard.press('Escape');
  await alpha.waitForFunction(() => !document.getElementById('drops-tracker-panel'));
  step(`in chat: list fits above the chip (${chatFit.avail} free), typing stays out of Twitch's shortcuts, Escape still closes`);

  // A worker that died mid-load must not leave its tab open for good.
  await popup.bringToFront();
  await popup.evaluate(async () => {
    const t = await chrome.tabs.create({ url: 'https://www.twitch.tv/drops/campaigns', active: false });
    await chrome.storage.local.set({ directoryTab: t.id });
  });
  await fakeLogin();

  // 7. Failure must not look like a stall, and must not lose the last good data.
  await sw.evaluate(() => { self.__realFakeFetch = self.fetch; self.fetch = async () => { throw new TypeError('offline'); }; });
  s = await poll();
  assert.equal(s.verdict.code, 'error');
  assert.equal(await badgeText(), 'ERR');
  assert.equal(s.active.length, 1);
  await shot('5-network-error');
  step('network failure: Cannot read Twitch, not Stalled, last data kept');

  // 8. The token must never be persisted.
  const stored = await popup.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  assert.ok(!stored.includes('e2einvalidtoken'), 'token leaked into storage');
  step('auth token is not in extension storage');

  // 9. Reloading the extension with Twitch tabs open: what every update does.
  await alpha.bringToFront();
  await alpha.evaluate(() => { document.getElementById('drops-tracker-chip').dataset.old = 'yes'; });
  // The same call as the Reload button on brave://extensions. chrome.runtime.reload() is no use
  // here: on a command-line-loaded extension it leaves it unloaded (ERR_BLOCKED_BY_CLIENT).
  const extensionsPage = await ctx.newPage();
  await extensionsPage.goto('chrome://extensions/');
  // Developer mode is part of the install steps. With it off the browser disables an unpacked
  // extension on reload (disable reason: unsupportedDeveloperExtension).
  await extensionsPage.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await extensionsPage.evaluate((id) => chrome.developerPrivate.reload(id, { failQuietly: false }), extId);
  await alpha.bringToFront();
  // A chip without the mark can only have come from the reloaded extension.
  await alpha.waitForFunction(() => {
    const c = document.querySelectorAll('#drops-tracker-chip');
    return c.length === 1 && !c[0].dataset.old;
  }, null, { timeout: 15000 }).catch(async (e) => {
    const seen = await alpha.evaluate(() => [...document.querySelectorAll('#drops-tracker-chip')].map((c) => ({ old: c.dataset.old, tone: c.dataset.tone })));
    const info = await extensionsPage.evaluate((id) => new Promise((res) => chrome.developerPrivate.getExtensionInfo(id, (x) => res(x && { state: x.state, reasons: x.disableReasons, runtimeErrors: x.runtimeErrors?.map((r) => r.message), manifestErrors: x.manifestErrors?.map((r) => r.message), location: x.location }))), extId).catch((err) => err.message.split('\n')[0]);
    console.log('reload diag chips', JSON.stringify(seen), 'workers', ctx.serviceWorkers().length, 'info', JSON.stringify(info));
    throw e;
  });
  await alpha.evaluate(() => document.getElementById('drops-tracker-chip').shadowRoot.querySelector('button').click());
  await alpha.waitForSelector('#drops-tracker-panel .panel');
  step('extension reload: open tab ends with exactly one working chip, no tab reload needed');
  // The tab planted before step 7 stands for one left by a worker that died mid-load.
  for (let i = 0; i < 40 && campaignTabs() > 0; i++) await alpha.waitForTimeout(250);
  assert.equal(campaignTabs(), 0, 'a tab left by a dead worker must be closed on the next wake');
  step('a background tab left behind by a dead worker closes on the next wake');

  // New files with the old manifest: a tab opened after a code change but before pressing Reload.
  // The panel is blocked, and the chip must survive that and say what to do.
  const staleDir = mkdtempSync(join(tmpdir(), 'drops-e2e-stale-'));
  const staleExt = join(staleDir, 'ext');
  cpSync(ext, staleExt, { recursive: true });
  const staleManifest = JSON.parse(readFileSync(join(staleExt, 'manifest.json')));
  staleManifest.web_accessible_resources[0].resources = staleManifest.web_accessible_resources[0].resources.filter((r) => r !== 'lib/directory.js');
  writeFileSync(join(staleExt, 'manifest.json'), JSON.stringify(staleManifest));
  const staleCtx = await chromium.launchPersistentContext(join(staleDir, 'profile'), {
    executablePath: BROWSER,
    headless: true,
    args: [`--disable-extensions-except=${staleExt}`, `--load-extension=${staleExt}`],
  });
  try {
    await staleCtx.route('https://www.twitch.tv/**', (r) => r.fulfill({ contentType: 'text/html', body: FAKE_CHANNEL }));
    const page = await staleCtx.newPage();
    const uncaught = [];
    page.on('pageerror', (e) => uncaught.push(e.message));
    await page.goto('https://www.twitch.tv/golf');
    await page.waitForFunction(() => document.getElementById('drops-tracker-chip')?.dataset.tone, null, { timeout: 8000 });
    await page.evaluate(() => document.getElementById('drops-tracker-chip').shadowRoot.querySelector('button').click());
    await page.waitForSelector('#drops-tracker-panel #panel-failed', { timeout: 5000 });
    assert.match(await page.textContent('#drops-tracker-panel #panel-failed'), /Press Reload/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('drops-tracker-panel'));
    assert.deepEqual(uncaught, []);
    step('panel blocked by a stale manifest: chip stays, click says to press Reload, Escape closes it');
  } finally {
    await staleCtx.close();
    rmSync(staleDir, { recursive: true, force: true });
  }

  console.log(`\nE2E PASS. Screenshots in ${out}`);
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
}
