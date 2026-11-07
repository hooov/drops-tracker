import { createPanel } from './lib/panel.js';
import { channelFromPath } from './lib/chip.js';

// The channel in the tab behind this popup, for the Badges tab. None when that tab is not Twitch.
let activeLogin = null;

const panel = createPanel(document.body, {
  reloadTab: (tabId) => chrome.runtime.sendMessage({ type: 'reloadTab', tabId }),
  channelLogin: () => activeLogin,
});

let current = null;
const show = (state) => { current = state; panel.render(current); };

chrome.storage.onChanged.addListener((changes) => { if (changes.state) show(changes.state.newValue); });
chrome.storage.local.get('state').then(({ state }) => show(state));
chrome.runtime.sendMessage({ type: 'poll' }).catch(() => {});
setInterval(() => panel.render(current), 1000);

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  let url = null;
  try { url = new URL(tab?.url); } catch { return; }
  if (/^(www\.|m\.)?twitch\.tv$/.test(url.hostname)) activeLogin = channelFromPath(url.pathname);
}).catch(() => {});
