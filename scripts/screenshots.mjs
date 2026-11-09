// README screenshots. Run: npm run screenshots
// The real extension in a real browser, as in scripts/e2e.mjs: the panel, chip and pill are the
// product's own rendering. What is staged: the twitch.tv channel pages (local HTML with a canvas
// "stream", so nothing plays from Twitch and no slot is used on your IP) and the GQL answers.
// Campaigns, rewards and art are real ones seen on Twitch on 2026-11-07, loaded from Twitch's CDN.
// Channels are made-up names used only for these images (the tests use AlphaTV, Bravo and so on). Output: docs/screenshots/.
// With --store (npm run store-images): Chrome Web Store images instead, in docs/store/. The store
// takes only exactly 1280x800 screenshots, so the same scenes are shot full-frame at 1280x800, 1x,
// plus the 440x280 promo tile.
import { chromium } from 'playwright-core';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture } from './fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const STORE = process.argv.includes('--store');
const out = join(root, 'docs', STORE ? 'store' : 'screenshots');
mkdirSync(out, { recursive: true });
const BROWSER = process.env.E2E_BROWSER || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const W = 1280;
const H = STORE ? 800 : 900;
const SCALE = STORE ? 1 : 2;
// Store files get their upload order and size in the name: the README images share the plain
// names, and dropping one of those in the dashboard fails with "The image size is incorrect".
// Shots not listed here are not taken for the store (it allows five).
const STORE_NAMES = {
  'hero.png': '1-earning-1280x800.png',
  'hung.png': '2-not-counting-1280x800.png',
  'all-drops.png': '3-all-drops-1280x800.png',
  'badges.png': '4-badges-1280x800.png',
};
const target = (file) => (STORE ? STORE_NAMES[file] : file);
const CHAT_W = 340;
const log = (msg) => console.log(`ok - ${msg}`);
const fx = loadFixture(root, 'gql-2026-11-06.json');
const badgeFx = loadFixture(root, 'badge-2026-11-06.json');
const dashboardFx = loadFixture(root, 'dashboard-2026-11-06.json');

const CDN = 'https://static-cdn.jtvnw.net';
const reward = (id) => `${CDN}/twitch-quests-assets/REWARD/${id}.png`;
const box = (id) => `${CDN}/ttv-boxart/${id}-144x192.jpg`;
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString();

// ---------------------------------------------------------------- data

const SOT = {
  id: '1e876aca-9af6-451d-b744-21cdc44e73c9',
  name: 'Season 21 Drops 3',
  game: { id: '490377', name: 'Sea of Thieves', displayName: 'Sea of Thieves', slug: 'sea-of-thieves', boxArtURL: box('490377') },
  owner: 'Xbox Game Studios',
  startAt: '2026-11-04T10:00:00Z',
  endAt: '2026-11-11T09:59:59.999Z',
  drops: [
    { id: 'sot-30', minutes: 30, name: '75k Gold Nov 26', art: reward('41286ea2-697a-4a48-9a75-771de5434e93') },
    { id: 'sot-60', minutes: 60, name: '+1 Renown Nov 26', art: reward('78eb299c-5b37-439c-96d5-27d288ff9951') },
    { id: 'sot-120', minutes: 120, name: 'Face, Meet Palm Emote', art: reward('0b59b2b8-73e3-4b85-a250-296eb689eda6') },
    { id: 'sot-180', minutes: 180, name: 'Seeker of Free Loot Title', art: reward('afa42038-ed64-4a12-ba87-ccdea17906fd') },
    { id: 'sot-240', minutes: 240, name: 'Twilight Hunter Spyglass', art: reward('5a52507f-c622-4a5c-9a70-702b01e6d607') },
  ],
};

// All Drops: real campaigns running on 2026-11-07, with their real box art.
const DIRECTORY = [
  [SOT.id, SOT.name, SOT.game.displayName, SOT.game.id, SOT.owner, SOT.endAt, SOT.drops.map((d) => d.minutes), true],
  ['5f277031-448e-4eb2-8817-45f56779633c', 'OWCS Stage 3 Playoffs', 'Overwatch', '515025', 'Blizzard Entertainment', '2026-11-23T07:59:59.999Z', [60, 120, 180, 240, 360, 480, 600, 720, 840, 900], true],
  ['90273492-0fd5-46d0-b1cf-60084d901adf', 'Ignite Stage2 W5', 'Marvel Rivals', '1264310518', 'NetEase Games', '2026-11-15T08:59:59.999Z', [30, 90, 120, 240, 360], false],
  ['9844bbb4-2a3f-4525-80a6-e1b7c314d50c', 'V7.2 Genshin Impact Drops', 'Genshin Impact', '513181', 'HoYoverse', '2026-11-24T03:59:59.999Z', [15, 30, 45, 60, 90], false],
  ['3df8df9c-6a8d-4c62-9e60-7809ec3d1e2e', 'WTCS Pro Grand Finals', 'War Thunder', '66366', 'Gaijin Entertainment', '2026-11-12T09:59:59.999Z', [30, 60, 120, 240, 360, 480, 600], false],
  ['20ad1ac0-78f4-4e4f-aadf-e59d8840b295', 'Enshrouded Artificer', 'Enshrouded', '737987407', 'Keen Games', '2026-11-17T13:59:59.999Z', [30, 60, 90, 120, 180, 240], false],
  ['e9411c3e-9d11-48f8-8da6-3ba5b9d7f827', 'ExileCon 2026', 'ExileCon', '1017541397', 'Grinding Gear Games', '2026-11-08T20:29:59.999Z', [120, 240, 360, 480], true],
  ['a0e134ff-e391-46bc-9ac6-0b1b2c826795', 'Modern Warfare 4 Season 1', 'Call of Duty: Warzone', '512710', 'Activision', '2026-12-04T04:59:59.999Z', [60, 120], false],
  ['e521dd0d-7211-4381-9efa-cf2bcf239944', 'FC Pro Open GQ', 'EA Sports FC 27', '123184772', 'Electronic Arts', '2026-11-10T21:48:59.999Z', [15, 60], false],
  ['3edfcdf2-5ec2-403b-946f-a64f9cd94036', 'Dune Drops #1', 'World of Tanks', '27546', 'Wargaming', '2026-11-09T15:59:59.999Z', [180], false],
  ['fab904fd-96c0-4b4c-8775-d2cb829f4563', 'Ludra Awakens', 'AION 2', '771448419', 'NCSOFT', '2026-11-18T07:59:59.999Z', [60, 120, 180, 240, 360, 480, 600, 720, 780, 840], false],
];
const BOXART_IGDB = new Set(['1264310518', '513181', '66366', '737987407', '123184772', '27546', '771448419']);

function dashboardAnswer(now) {
  const dropCampaigns = DIRECTORY.map(([id, name, game, gameId, owner, endAt, minutes, linked]) => ({
    id,
    name,
    status: 'ACTIVE',
    startAt: iso(now - 3 * DAY),
    endAt,
    accountLinkURL: 'https://example.com/link',
    detailsURL: '',
    game: { id: gameId, displayName: game, boxArtURL: BOXART_IGDB.has(gameId) ? `${CDN}/ttv-boxart/${gameId}_IGDB-144x192.jpg` : box(gameId) },
    owner: { id: owner, name: owner },
    self: { isAccountConnected: linked },
    timeBasedDrops: minutes.map((m, i) => ({ id: `${id}-${i}`, requiredMinutesWatched: m, requiredSubs: 0, requiredTurboSubs: 0 })),
  }));
  const rewards = structuredClone(dashboardFx.data.rewardCampaignsAvailableToUser).map((r) => ({ ...r, startsAt: iso(now - DAY), endsAt: iso(now + 60 * DAY) }));
  return [{ data: {} }, { data: { currentUser: { id: '0', login: 'viewer', dropCampaigns }, rewardCampaignsAvailableToUser: rewards } }];
}

const CHANNELS = {
  tiderunner: { id: '10000001', displayName: 'TideRunner', game: 'Sea of Thieves', title: 'Chill sailing with chat | Season 21 Drops ON', viewers: 1037, hue: 200 },
  kettletalk: { id: '10000002', displayName: 'KettleTalk', game: 'Just Chatting', title: 'Coffee and questions', viewers: 1405, hue: 330 },
  nightshiftrp: { id: '10000003', displayName: 'NightShiftRP', game: 'Grand Theft Auto V', title: '30th birthday stream, badges all week', viewers: 2210, hue: 40 },
};

// ---------------------------------------------------------------- staged twitch.tv page

const CHAT = [
  ['seaworthy_sam', '#ff7f50', 'that cannon shot was unreal'],
  ['mintleaf', '#00c8af', 'drops working for anyone else?'],
  ['k4rma', '#9acd32', 'yep, ticking for me'],
  ['lowtide', '#1e90ff', 'GG on that fort'],
  ['parrotfan99', '#daa520', 'parrot when'],
  ['ninefold', '#ff69b4', 'first time catching a stream live, hi all'],
  ['brineshrimp', '#8a2be2', 'one more voyage then sleep'],
  ['oatmilk', '#2e8b57', 'the spyglass looks so good'],
  ['harbor_light', '#d2691e', 'how long till the next drop?'],
  ['quietcove', '#5f9ea0', 'lurking with the stream on in the background'],
  ['mintleaf', '#00c8af', 'ok mine is moving now too'],
  ['skiff', '#b22222', 'that was a clean landing'],
];

function channelPage(login) {
  const ch = CHANNELS[login];
  const chat = [...CHAT, ...CHAT].map(([who, color, text]) => `<div class="msg"><b style="color:${color}">${who}</b>: ${text}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${ch.displayName} - Twitch</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=block" rel="stylesheet">
<style>
  :root { --font-base: Inter, "Helvetica Neue", Helvetica, Arial, sans-serif; color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0e0e10; color: #efeff1; font: 400 13px/1.5 var(--font-base); overflow: hidden; }
  .top { height: 50px; background: #18181b; display: flex; align-items: center; gap: 18px; padding: 0 16px; box-shadow: 0 1px 2px rgba(0,0,0,.6); position: relative; z-index: 2; }
  .top .nav { font-weight: 600; font-size: 15px; color: #efeff1; }
  .top .nav.dim { color: #adadb8; font-weight: 500; }
  .search { margin: 0 auto; width: 380px; height: 36px; border-radius: 6px; background: #1f1f23; border: 1px solid #3a3a3d; color: #adadb8; display: flex; align-items: center; padding: 0 12px; }
  .me { width: 30px; height: 30px; border-radius: 50%; background: linear-gradient(135deg,#6441a5,#2b2b8a); }
  .main { position: absolute; top: 50px; left: 0; right: ${CHAT_W}px; bottom: 0; display: flex; }
  .rail { width: 50px; background: #1f1f23; display: flex; flex-direction: column; align-items: center; gap: 10px; padding-top: 12px; }
  .rail i { width: 30px; height: 30px; border-radius: 50%; display: block; }
  .stage { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .player { position: relative; }
  video { width: 100%; aspect-ratio: 16 / 9; background: #000; display: block; object-fit: cover; }
  .controls { position: absolute; left: 0; right: 0; bottom: 0; height: 64px; padding: 0 12px 6px; display: flex; align-items: flex-end; gap: 4px; background: linear-gradient(rgba(0,0,0,0), rgba(0,0,0,.55)); }
  .controls .btn { width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; color: #fff; }
  .controls .vol { width: 72px; height: 30px; display: flex; align-items: center; margin: 0 8px 0 2px; }
  .controls .vol i { position: relative; display: block; width: 100%; height: 4px; border-radius: 2px; background: rgba(255,255,255,.3); }
  .controls .vol i::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 70%; border-radius: 2px; background: #fff; }
  .controls .vol i::after { content: ''; position: absolute; left: 70%; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; background: #fff; }
  .controls .gap { flex: 1; }
  .info { display: flex; gap: 12px; padding: 14px 20px; align-items: flex-start; }
  .avatar { flex: none; width: 64px; height: 64px; border-radius: 50%; border: 3px solid #eb0400; padding: 3px; }
  .avatar span { display: flex; width: 100%; height: 100%; border-radius: 50%; align-items: center; justify-content: center; font-weight: 700; font-size: 22px; color: #fff; background: hsl(${ch.hue} 60% 42%); }
  .info h2 { margin: 2px 0 2px; font-size: 18px; font-weight: 600; }
  .info .title { font-weight: 600; font-size: 14px; }
  .info .game { color: #bf94ff; font-weight: 500; }
  .info .tag { display: inline-block; margin: 6px 6px 0 0; padding: 0 8px; border-radius: 10px; background: #2f2f35; color: #adadb8; font-size: 12px; font-weight: 600; }
  .live { margin-left: auto; text-align: right; color: #ff8280; font-weight: 600; }
  .panels { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; padding: 6px 20px 0; }
  .panels div { background: #18181b; border-radius: 6px; padding: 12px 14px; min-height: 120px; }
  .panels h3 { margin: 0 0 6px; font-size: 14px; font-weight: 600; }
  .panels p { margin: 0; color: #adadb8; }
  .live b { display: inline-block; background: #eb0400; color: #fff; border-radius: 4px; padding: 0 5px; font-size: 12px; margin-right: 6px; }
  .chat { position: absolute; top: 50px; right: 0; bottom: 0; width: ${CHAT_W}px; background: #18181b; border-left: 1px solid #2f2f35; display: flex; flex-direction: column; }
  .chat header { height: 50px; flex: none; display: flex; align-items: center; justify-content: center; border-bottom: 1px solid #2f2f35; font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
  .msgs { flex: 1; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; padding: 10px 0; }
  .msg { padding: 5px 20px; font-size: 13px; line-height: 20px; }
  .msg b { font-weight: 700; }
  .composer { flex: none; padding: 0 10px 10px; }
  .input { height: 40px; border-radius: 6px; background: #2f2f35; color: #adadb8; display: flex; align-items: center; padding: 0 12px; margin-bottom: 10px; border: 2px solid transparent; }
  .points { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 8px; border-radius: 4px; font-weight: 600; font-size: 13px; color: #efeff1; }
  .points i { width: 18px; height: 18px; border-radius: 50%; border: 3px solid #bf94ff; display: block; }
  .icon { width: 32px; height: 32px; border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #efeff1; }
  .send { height: 30px; padding: 0 10px; border-radius: 4px; background: #9147ff; color: #fff; font-weight: 600; display: flex; align-items: center; margin-left: 4px; }
</style></head><body>
<div class="top"><span class="nav">Following</span><span class="nav dim">Browse</span><div class="search">Search</div><div class="me"></div></div>
<div class="main">
  <div class="rail"><i style="background:hsl(200 55% 45%)"></i><i style="background:hsl(330 55% 45%)"></i><i style="background:hsl(40 70% 45%)"></i><i style="background:hsl(140 45% 38%)"></i><i style="background:hsl(270 45% 50%)"></i></div>
  <div class="stage">
    <div class="player">
      <video id="v" muted autoplay playsinline></video>
      <div class="controls">
        <div class="btn"><svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="4" width="3.5" height="12" rx="1"/><rect x="11.5" y="4" width="3.5" height="12" rx="1"/></svg></div>
        <div class="btn"><svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M3 7.5h3l4-3.5v12l-4-3.5H3z"/><path d="M13 6.5a5 5 0 0 1 0 7M15.5 4a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></div>
        <div class="vol"><i></i></div>
        <div class="gap"></div>
        <div class="btn"><svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm7.4 2.2-1.6-.3a6 6 0 0 0-.6-1.4l.9-1.4-1.3-1.3-1.4.9a6 6 0 0 0-1.4-.6L11.8 2h-1.6l-.3 1.6a6 6 0 0 0-1.4.6l-1.4-.9-1.3 1.3.9 1.4a6 6 0 0 0-.6 1.4L2.6 8.9v1.8l1.6.3c.1.5.3 1 .6 1.4l-.9 1.4 1.3 1.3 1.4-.9c.4.3.9.5 1.4.6l.3 1.6h1.8l.3-1.6c.5-.1 1-.3 1.4-.6l1.4.9 1.3-1.3-.9-1.4c.3-.4.5-.9.6-1.4l1.6-.3V9.2Z"/></svg></div>
        <div class="btn"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="4.5" width="15" height="11" rx="1.5"/><path d="M12.5 4.5v11"/></svg></div>
        <div class="btn"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 7.5V3h4.5M12.5 3H17v4.5M17 12.5V17h-4.5M7.5 17H3v-4.5"/></svg></div>
      </div>
    </div>
    <div class="info">
      <div class="avatar"><span>${ch.displayName[0]}</span></div>
      <div><h2>${ch.displayName}</h2><div class="title">${ch.title}</div><div class="game">${ch.game}</div><span class="tag">English</span><span class="tag">DropsEnabled</span></div>
      <div class="live"><b>LIVE</b>${ch.viewers.toLocaleString('en-US')}</div>
    </div>
    <div class="panels">
      <div><h3>About ${ch.displayName}</h3><p>Streaming most evenings. Be kind in chat and have fun.</p></div>
      <div><h3>Schedule</h3><p>Mon to Fri, 7 PM<br>Weekends: whenever the wind is right</p></div>
      <div><h3>Setup</h3><p>Questions about gear go in the Discord, not chat.</p></div>
    </div>
  </div>
</div>
<aside class="chat" id="wrap">
  <header>Stream chat</header>
  <div class="msgs">${chat}</div>
  <div class="composer">
    <div class="input">Send a message</div>
    <div data-test-selector="chat-input-buttons-container" style="display:flex;flex-flow:row wrap-reverse;justify-content:flex-end;align-items:center">
      <div style="display:flex;align-items:center;flex:none;margin-right:auto">
        <div><div><div data-test-selector="community-points-summary" class="points"><i></i>12.4K</div></div></div>
      </div>
      <div class="icon" style="flex:none"><svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm7.4 2.2-1.6-.3a6 6 0 0 0-.6-1.4l.9-1.4-1.3-1.3-1.4.9a6 6 0 0 0-1.4-.6L11.8 2h-1.6l-.3 1.6a6 6 0 0 0-1.4.6l-1.4-.9-1.3 1.3.9 1.4a6 6 0 0 0-.6 1.4L2.6 8.9v1.8l1.6.3c.1.5.3 1 .6 1.4l-.9 1.4 1.3 1.3 1.4-.9c.4.3.9.5 1.4.6l.3 1.6h1.8l.3-1.6c.5-.1 1-.3 1.4-.6l1.4.9 1.3-1.3-.9-1.4c.3-.4.5-.9.6-1.4l1.6-.3V9.2Z"/></svg></div>
      <div class="send" style="flex:none">Chat</div>
    </div>
  </div>
</aside>
<script>
  // A "stream" that really plays, so the extension reads a live player: a plain grey gradient,
  // redrawn every frame so the captured stream keeps advancing. The controls are HTML on top.
  const c = document.createElement('canvas'); c.width = 960; c.height = 540;
  const g = c.getContext('2d');
  function frame() {
    const bg = g.createRadialGradient(480, 230, 40, 480, 270, 620);
    bg.addColorStop(0, '#4a4a50'); bg.addColorStop(0.55, '#2c2c31'); bg.addColorStop(1, '#141417');
    g.fillStyle = bg; g.fillRect(0, 0, 960, 540);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  const v = document.getElementById('v'); v.srcObject = c.captureStream(24); v.play();
</script></body></html>`;
}

const CAMPAIGNS_PAGE = `<!doctype html><title>campaigns</title><script>
  fetch('https://gql.twitch.tv/gql', { method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify([{ operationName: 'SideNav' }, { operationName: 'ViewerDropsDashboard', variables: { fetchRewardCampaigns: true } }]) })
    .then((r) => r.json()).then((j) => { document.title = 'read:' + j.length; });
</script>`;

// ---------------------------------------------------------------- one browser per scene

/**
 * Each scene runs in its own profile with the worker's clock started in the past, so that after
 * its minutes of polling the clocks line up again and every "ago" and "about 4:12 PM" reads true.
 */
async function scene(name, { minutes, setup }) {
  const profile = mkdtempSync(join(tmpdir(), 'drops-shots-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: BROWSER,
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
    viewport: { width: W, height: H },
    deviceScaleFactor: SCALE,
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  try {
    await ctx.route('https://www.twitch.tv/**', (r) => {
      const url = new URL(r.request().url());
      if (url.pathname.startsWith('/drops/campaigns')) return r.fulfill({ contentType: 'text/html', body: CAMPAIGNS_PAGE });
      const login = url.pathname.split('/')[1];
      return r.fulfill({ contentType: 'text/html', body: channelPage(CHANNELS[login] ? login : 'tiderunner') });
    });
    await ctx.route('https://gql.twitch.tv/**', (r) => {
      if (!r.request().postData()?.includes('ViewerDropsDashboard')) return r.fallback();
      return r.fulfill({ headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(dashboardAnswer(Date.now())) });
    });
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const extId = new URL(sw.url()).host;
    const helper = await ctx.newPage();
    await helper.goto(`chrome-extension://${extId}/popup.html`);
    await sw.evaluate(() => chrome.cookies.set({ url: 'https://www.twitch.tv', name: 'auth-token', value: 'screenshotsnotarealtoken0000000', domain: '.twitch.tv', secure: true }));
    await sw.evaluate((m) => {
      self.__offset = -m * 60000;
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + self.__offset;
    }, minutes);
    const poll = () => helper.evaluate(() => chrome.runtime.sendMessage({ type: 'poll' }));
    // One minute per poll, like the real alarm. add: minutes Twitch credits in that minute.
    const tick = async (add = 0) => {
      await sw.evaluate((a) => { self.__offset += 60000; self.__minutes += a; }, add);
      return poll();
    };
    const api = { ctx, sw, helper, poll, tick, extId };
    await setup(api);
    log(name);
  } finally {
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

/** The fake GQL. Product code is untouched: only the worker's fetch is swapped, as in e2e. */
async function installTwitch(sw, data) {
  await sw.evaluate((d) => {
    Object.assign(self, { __d: d });
    self.fetch = async (_url, init) => {
      const D = self.__d;
      const ops = JSON.parse(init.body);
      return new Response(JSON.stringify(ops.map((o) => {
        const v = o.variables || {};
        switch (o.operationName) {
          case 'Inventory':
            return { data: { currentUser: { inventory: { dropCampaignsInProgress: D.inventory.map((c) => ({ ...c, timeBasedDrops: c.timeBasedDrops.map((t) => (t.self.ticking ? { ...t, self: { ...t.self, ticking: undefined, currentMinutesWatched: Math.min(self.__minutes, t.requiredMinutesWatched) } } : t)) })), gameEventDrops: [] } } } };
          case 'VideoPlayerStreamInfoOverlayChannel': {
            const ch = D.channels[v.channel];
            return { data: { user: ch ? { displayName: ch.displayName, id: ch.id, login: v.channel, stream: { id: `s${ch.id}`, tags: [], viewersCount: ch.viewers } } : null } };
          }
          case 'DropsHighlightService_AvailableDrops': {
            const login = Object.keys(D.channels).find((k) => D.channels[k].id === v.channelID);
            const list = self.__gone?.includes(login) ? null : D.available[login] ?? null;
            return { data: { channel: { id: v.channelID, viewerDropCampaigns: list } } };
          }
          default: {
            const login = Object.keys(D.channels).find((k) => D.channels[k].id === v.channelID);
            const s = D.session[login];
            return { data: { currentUser: { dropCurrentSession: s ? { ...s, currentMinutesWatched: Math.min(self.__minutes, s.requiredMinutesWatched) } : { channel: null, currentMinutesWatched: 0, dropID: '', game: null, requiredMinutesWatched: 0 } } } };
          }
        }
      })), { status: 200 });
    };
  }, data);
}

// Inventory as Twitch returns it, claimed drops included.
const SOT_INVENTORY = [
  {
    id: SOT.id, name: SOT.name, status: 'ACTIVE', startAt: SOT.startAt, endAt: SOT.endAt,
    accountLinkURL: 'https://example.com/link', self: { isAccountConnected: true },
    game: { id: '490377', name: 'Sea of Thieves', slug: 'sea-of-thieves' },
    timeBasedDrops: SOT.drops.map((d) => ({
      id: d.id, name: d.name, requiredMinutesWatched: d.minutes, requiredSubs: 0, preconditionDrops: null,
      startAt: SOT.startAt, endAt: SOT.endAt,
      benefitEdges: [{ benefit: { id: `${d.id}-b`, name: d.name, imageAssetURL: d.art }, entitlementLimit: 1 }],
      // The first two are already claimed. Drops in a campaign tick together (measured).
      self: d.minutes <= 60
        ? { currentMinutesWatched: d.minutes, currentSubs: 0, hasPreconditionsMet: true, isClaimed: true, dropInstanceID: 'claimed' }
        : { ticking: true, currentSubs: 0, hasPreconditionsMet: true, isClaimed: false, dropInstanceID: null },
    })),
  },
  {
    // Earned before the campaign ended, not claimed yet: still claimable for 7 days.
    id: 'e4f226c6-c9c3-4d99-9c13-e0050e004f9a', name: 'Frozen Trail', status: 'EXPIRED',
    startAt: '2026-10-08T11:00:00Z', endAt: '2026-11-04T12:44:59.999Z',
    accountLinkURL: 'https://example.com/link', self: { isAccountConnected: true },
    game: { id: '464339927', name: 'ARC Raiders', slug: 'arc-raiders' },
    timeBasedDrops: [{
      id: 'arc-mailbox', name: 'Mailbox', requiredMinutesWatched: 120, requiredSubs: 0, preconditionDrops: null,
      startAt: '2026-10-08T11:00:00Z', endAt: '2026-11-04T12:44:59.999Z',
      benefitEdges: [{ benefit: { id: 'arc-mailbox-b', name: 'Mailbox' }, entitlementLimit: 1 }],
      self: { currentMinutesWatched: 120, currentSubs: 0, hasPreconditionsMet: true, isClaimed: false, dropInstanceID: 'earned' },
    }],
  },
];

const SOT_AVAILABLE = [{
  id: SOT.id,
  name: SOT.name,
  endAt: SOT.endAt,
  game: { id: SOT.game.id, displayName: SOT.game.displayName },
  summary: { includesMWRequirement: true, includesSubRequirement: false, isRewardCampaign: false, isSitewide: false },
  timeBasedDrops: SOT.drops.map((d) => ({
    id: d.id, name: d.name, requiredMinutesWatched: d.minutes, requiredSubs: 0, startAt: SOT.startAt, endAt: SOT.endAt,
    benefitEdges: [{ benefit: { id: `${d.id}-b`, name: d.name, imageAssetURL: d.art }, entitlementLimit: 1 }],
  })),
}];

const SOT_DATA = {
  channels: CHANNELS,
  available: { tiderunner: SOT_AVAILABLE },
  session: { tiderunner: { channel: { displayName: 'TideRunner', id: '10000001', name: 'tiderunner' }, dropID: 'sot-120', game: { displayName: 'Sea of Thieves', id: '490377' }, requiredMinutesWatched: 120 } },
  inventory: SOT_INVENTORY,
};

// ---------------------------------------------------------------- helpers on the channel page

async function openChannel(ctx, login) {
  const page = await ctx.newPage();
  await page.goto(`https://www.twitch.tv/${login}`);
  await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.3);
  await page.evaluate(() => document.fonts.ready);
  return page;
}
const chipOf = (page) => page.evaluate(() => {
  const h = document.getElementById('drops-tracker-chip');
  return h ? { tone: h.dataset.tone, text: h.shadowRoot.querySelector('span').textContent } : null;
});
async function openPanel(page, tab = 'mine') {
  if (!await page.evaluate(() => !!document.getElementById('drops-tracker-panel'))) {
    await page.evaluate(() => document.getElementById('drops-tracker-chip').shadowRoot.querySelector('button').click());
  }
  await page.waitForFunction(() => document.getElementById('drops-tracker-panel')?.style.visibility === '');
  if (tab !== 'mine') await page.click(`#drops-tracker-panel #tab-${tab}`);
  // Art comes from Twitch's CDN: wait for it, so no card is caught half-drawn.
  await page.waitForFunction(() => [...document.getElementById('drops-tracker-panel').shadowRoot.querySelectorAll('img')].every((i) => i.complete));
  await page.mouse.move(5, 300); // No hover highlight left on the chip.
  await page.waitForTimeout(700);
}
// A click outside, not Escape: Escape hands focus back to the chip, which then shows a focus ring.
const closePanel = async (page) => {
  await page.mouse.click(400, 300);
  await page.waitForFunction(() => !document.getElementById('drops-tracker-panel'));
};

/** The right part of the page: the edge of the stream, the chat and the panel over it. */
async function shotChat(page, file, { left = W - CHAT_W } = {}) {
  if (STORE) return target(file) && page.screenshot({ path: join(out, target(file)) }); // The whole frame.
  // From a few lines of chat above the panel down to the chip, so short tabs carry no empty chat.
  const panelTop = await page.evaluate(() => document.getElementById('drops-tracker-panel').getBoundingClientRect().top);
  const top = Math.max(50, Math.floor(panelTop) - 96);
  await page.screenshot({ path: join(out, file), clip: { x: left, y: top, width: W - left, height: H - top } });
}
async function chipClip(page) {
  return page.evaluate(() => {
    const row = document.querySelector('[data-test-selector="chat-input-buttons-container"]').getBoundingClientRect();
    return { x: row.left - 6, y: row.top - 8, width: row.width + 12, height: row.height + 16 };
  });
}

// ---------------------------------------------------------------- scenes

const chipShots = [];

// 1. Earning: the main view, the All Drops and Settings tabs, and the chip itself.
await scene('earning: hero, My Drops, All Drops, Settings, chip', {
  minutes: 31,
  setup: async ({ ctx, sw, helper, poll, tick }) => {
    await installTwitch(sw, SOT_DATA);
    await sw.evaluate(() => { self.__minutes = 72; });
    const alpha = await openChannel(ctx, 'tiderunner');
    await openChannel(ctx, 'kettletalk');
    await poll();
    for (let i = 0; i < 31; i++) await tick(1);
    const s = await helper.evaluate(async () => (await chrome.storage.local.get('state')).state);
    if (s.verdict.code !== 'earning') throw new Error(`expected earning, got ${JSON.stringify(s.verdict)}`);
    await alpha.bringToFront();
    await alpha.waitForFunction(() => document.getElementById('drops-tracker-chip')?.dataset.tone === 'ok');
    chipShots.push(['Earning', await alpha.screenshot({ clip: await chipClip(alpha) })]);

    await openPanel(alpha);
    await alpha.screenshot({ path: join(out, target('hero.png')) });
    await shotChat(alpha, 'my-drops.png');

    await openPanel(alpha, 'all');
    await alpha.waitForSelector('#drops-tracker-panel #dir-list .dir-row', { timeout: 20000 });
    await alpha.bringToFront();
    await alpha.waitForFunction(() => [...document.getElementById('drops-tracker-panel').shadowRoot.querySelectorAll('#dir-list img')].slice(0, 8).every((i) => i.complete && i.naturalWidth));
    await alpha.waitForTimeout(500);
    await shotChat(alpha, 'all-drops.png');

    // The Lost minutes log, seeded with a realistic evening: one stream credits almost every
    // minute, a second stream playing loses some.
    await helper.evaluate(() => {
      const now = Math.floor(Date.now() / 60000);
      const minuteLog = [];
      for (let i = 0; i < 186; i++) {
        const two = i >= 70 && i < 118;
        const hidden = i % 9 < 4;
        const missed = two ? i % 6 === 0 : i % 47 === 0;
        minuteLog.push({ m: now - 186 + i, d: missed ? 0 : 1, e: 1, p: two ? 2 : 1, c: 'tiderunner', cr: 1, st: 'playing', h: hidden ? 1 : 0, a: hidden ? 0 : 1, pm: i % 5 === 0 ? 1 : 0, v0: 0, tm: 0, q: 1080, s: 100, ad: i % 31 === 0 ? 1 : 0 });
      }
      for (let i = 0; i < 4; i++) minuteLog.push({ m: now + i - 190, st: 'paused', d: 0, e: 1, p: 1, c: 'tiderunner', cr: 1, h: 1, a: 0, pm: 0, v0: 0, tm: 0, q: 1080, s: 0, ad: 0 });
      // The debug tools only show with Developer mode on.
      return chrome.storage.local.set({ minuteLog, settings: { autoRefresh: true, autoRefreshMinutes: 5, autoReload: true, devMode: true } });
    });
    await openPanel(alpha, 'settings');
    await alpha.click('#drops-tracker-panel #log-section summary');
    await alpha.waitForTimeout(500);
    await shotChat(alpha, 'debug.png');
    await closePanel(alpha);

    // Narrow chat: the label gives way and the percentage moves into the ring.
    await alpha.evaluate(() => { document.getElementById('wrap').style.width = '220px'; });
    await alpha.waitForTimeout(2500);
    const seen = await alpha.evaluate(() => {
      const row = document.querySelector('[data-test-selector="chat-input-buttons-container"]');
      const chip = document.getElementById('drops-tracker-chip');
      return { compact: chip.dataset.compact, row: row.offsetWidth, kids: [...row.children].map((c) => c.offsetWidth), chip: chip.offsetWidth, parent: chip.parentElement?.className };
    });
    console.log('   narrow chat:', JSON.stringify(seen));
    await alpha.waitForFunction(() => document.getElementById('drops-tracker-chip').dataset.compact === 'true', null, { timeout: 5000 });
    await alpha.waitForTimeout(300);
    chipShots.push(['Narrow chat', await alpha.screenshot({ clip: await chipClip(alpha) })]);

    // A drop waiting to be claimed: a purple count, on the ring's corner here, inside it when wide.
    await helper.evaluate(async () => {
      const { state } = await chrome.storage.local.get('state');
      await chrome.storage.local.set({ state: { ...state, unclaimed: [{ id: 'claim', name: '+1 Renown Nov 26', campaign: 'Season 21 Drops 3', campaignActive: true }] } });
    });
    await alpha.waitForFunction(() => document.getElementById('drops-tracker-chip').dataset.claims === '1');
    await alpha.waitForTimeout(300);
    const narrowClaim = await alpha.screenshot({ clip: await chipClip(alpha) });
    await alpha.evaluate(() => { document.getElementById('wrap').style.width = ''; });
    await alpha.waitForFunction(() => document.getElementById('drops-tracker-chip').dataset.compact === 'false', null, { timeout: 5000 });
    await alpha.waitForTimeout(300);
    chipShots.push(['Claim waiting', await alpha.screenshot({ clip: await chipClip(alpha) })]);
    chipShots.push(['Claim, narrow chat', narrowClaim]);
  },
});

// 2. Hung: the stream plays fine but Twitch stops adding minutes. Warning pill, red chip.
await scene('hung: pill, chip and panel', {
  minutes: 30,
  setup: async ({ ctx, sw, helper, poll, tick }) => {
    await installTwitch(sw, SOT_DATA);
    await sw.evaluate(() => { self.__minutes = 72; });
    // One stream only: with a second one playing the verdict names it instead (measured
    // 2026-11-09), and this image shows the general case with its Reload button.
    const alpha = await openChannel(ctx, 'tiderunner');
    await poll();
    for (let i = 0; i < 24; i++) await tick(1);
    for (let i = 0; i < 6; i++) await tick();
    const s = await helper.evaluate(async () => (await chrome.storage.local.get('state')).state);
    if (s.verdict.code !== 'stalled') throw new Error(`expected stalled, got ${JSON.stringify(s.verdict)}`);
    await alpha.bringToFront();
    await alpha.waitForFunction(() => document.getElementById('drops-tracker-chip')?.dataset.tone === 'bad');
    await alpha.waitForFunction(() => document.getElementById('drops-tracker-pill')?.style.display !== 'none');
    chipShots.push(['Not counting', await alpha.screenshot({ clip: await chipClip(alpha) })]);
    await openPanel(alpha);
    await alpha.screenshot({ path: join(out, target('hung.png')) });

    // Then the channel switches to a game with no drops: earning stops without any error.
    await tick(1);
    await sw.evaluate(() => { self.__gone = ['tiderunner']; });
    for (let i = 0; i < 3; i++) await tick();
    await closePanel(alpha);
    await alpha.waitForFunction(() => document.getElementById('drops-tracker-chip')?.shadowRoot.querySelector('span').textContent === 'Stopped');
    await alpha.mouse.move(5, 300);
    await alpha.waitForTimeout(300);
    chipShots.push(['Stopped', await alpha.screenshot({ clip: await chipClip(alpha) })]);
  },
});

// 3. Badges: a channel's own sub and watch badges.
await scene('badges tab', {
  minutes: 12,
  setup: async ({ ctx, sw, poll, tick }) => {
    const mixed = structuredClone(badgeFx.mixed.viewerDropCampaigns);
    await installTwitch(sw, {
      channels: CHANNELS,
      available: { tiderunner: SOT_AVAILABLE, nightshiftrp: mixed },
      session: {
        tiderunner: SOT_DATA.session.tiderunner,
        nightshiftrp: { ...badgeFx.mixedSession, channel: { displayName: 'NightShiftRP', id: '10000003', name: 'nightshiftrp' } },
      },
      inventory: SOT_INVENTORY,
    });
    await sw.evaluate(() => { self.__minutes = 101; });
    const charlie = await openChannel(ctx, 'nightshiftrp');
    await poll();
    for (let i = 0; i < 12; i++) await tick(1);
    await charlie.bringToFront();
    await charlie.waitForFunction(() => document.getElementById('drops-tracker-chip')?.dataset.tone === 'ok');
    await openPanel(charlie, 'badges');
    await shotChat(charlie, 'badges.png');
  },
});

// 4. The chip's states side by side, as captured above. The store has no use for it.
if (!STORE) {
  const profile = mkdtempSync(join(tmpdir(), 'drops-shots-'));
  const ctx = await chromium.launchPersistentContext(profile, { executablePath: BROWSER, headless: true, viewport: { width: 900, height: 200 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const cells = chipShots.map(([label, png]) => `<figure><img src="data:image/png;base64,${png.toString('base64')}"><figcaption>${label}</figcaption></figure>`).join('');
  await page.setContent(`<!doctype html><link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;600&display=block" rel="stylesheet">
  <style>body{margin:0;background:#0e0e10;font:500 13px Inter,Arial,sans-serif;color:#adadb8}
  .grid{display:inline-grid;grid-template-columns:repeat(${chipShots.length},auto);gap:20px;padding:24px}
  figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:10px}
  img{height:48px;border-radius:6px;background:#18181b;outline:1px solid #2f2f35}
  figcaption{letter-spacing:.02em}</style><div class="grid">${cells}</div>`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.locator('.grid').screenshot({ path: join(out, 'chip-states.png') });
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
  log('chip states');
}

// 5. Store only: the 440x280 small promo tile, which places the listing higher in store results.
if (STORE) {
  const profile = mkdtempSync(join(tmpdir(), 'drops-shots-'));
  const ctx = await chromium.launchPersistentContext(profile, { executablePath: BROWSER, headless: true, viewport: { width: 440, height: 280 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const icon = readFileSync(join(ext, 'icons', '128.png')).toString('base64');
  await page.setContent(`<!doctype html><link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700&display=block" rel="stylesheet">
  <style>html,body{margin:0;width:440px;height:280px;overflow:hidden}
  body{background:#18181b;font-family:Inter,Arial,sans-serif;display:flex;align-items:center;gap:6px;padding:0 30px 0 18px;box-sizing:border-box}
  img{width:136px;height:136px;flex:none}
  h1{margin:0 0 10px;font-size:32px;font-weight:700;color:#efeff1;letter-spacing:-.01em;line-height:1.1}
  p{margin:0;font-size:16px;font-weight:500;color:#adadb8;line-height:1.4}</style>
  <img src="data:image/png;base64,${icon}"><div><h1>Drops Tracker</h1><p>Know the moment Twitch stops counting your Drops minutes.</p></div>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(out, 'promo-tile-440x280.png') });
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
  log('promo tile');
}
console.log(`screenshots in ${out}`);
