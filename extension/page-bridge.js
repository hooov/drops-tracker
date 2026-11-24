// Passes what page-hook.js saw to the service worker. page-hook.js runs in the page's world,
// which cannot reach extension APIs.
const FORWARD = { directory: 'directoryCaptured', dayRewards: 'dayRewardsCaptured' };
addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== window.location.origin) return;
  const type = e.data?.source === 'drops-tracker' ? FORWARD[e.data.type] : null;
  if (typeof type !== 'string') return;
  if (!chrome.runtime?.id) return; // Extension reloaded: this instance is orphaned.
  chrome.runtime.sendMessage({ type, item: e.data.item }).catch(() => {});
});
