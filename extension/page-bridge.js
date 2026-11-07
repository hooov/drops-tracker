// Passes what page-hook.js saw to the service worker. page-hook.js runs in the page's world,
// which cannot reach extension APIs.
addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== window.location.origin) return;
  if (e.data?.source !== 'drops-tracker' || e.data.type !== 'directory') return;
  if (!chrome.runtime?.id) return; // Extension reloaded: this instance is orphaned.
  chrome.runtime.sendMessage({ type: 'directoryCaptured', item: e.data.item }).catch(() => {});
});
