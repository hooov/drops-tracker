// Runs in the page's own world on twitch.tv pages. Some answers need Twitch's integrity check,
// which only its own page can pass, so the extension cannot ask for them. It reads the answer
// Twitch's page already received instead: the campaign list on the Drops page, and on a channel
// page the per-day rewards of a repeating reward drop (2026-11-22) and which reward groups are
// finished (2026-11-23), both from one answer. Nothing here touches the
// request, its headers or any token, and a failure here must never affect the page.
// It runs on the channel page that reports watched minutes, where a failed report loses the
// minute, so every other request passes straight through: no copy of its answer is taken
// (tests/page-hook.test.mjs).
(() => {
  // Operation read, and the message type it is passed on as (page-bridge.js).
  const OPERATIONS = { ViewerDropsDashboard: 'directory', DropChannelCampaignsProgress: 'dayRewards' };
  const NAMES = Object.keys(OPERATIONS);
  const GQL = 'https://gql.twitch.tv/gql';
  const realFetch = window.fetch;
  const names = (text) => typeof text === 'string' && NAMES.some((op) => text.includes(op));

  async function watch(copy, bodyText) {
    try {
      const text = await bodyText;
      const ops = names(text) ? [].concat(JSON.parse(text)).map((o) => o?.operationName) : [];
      const wanted = ops.map((op, at) => [OPERATIONS[op], at]).filter(([type]) => typeof type === 'string');
      if (!wanted.length) {
        copy.body?.cancel(); // An unread copy would hold the whole answer in memory.
        return;
      }
      const answer = await copy.json();
      for (const [type, at] of wanted) {
        const item = Array.isArray(answer) ? answer[at] : answer;
        if (!item || typeof item !== 'object') continue;
        window.postMessage({ source: 'drops-tracker', type, item }, window.location.origin);
      }
    } catch {
      // Twitch changed how it calls this. The panel reports the list as not loaded.
    }
  }

  window.fetch = function fetch(input, init) {
    let bodyText = null;
    try {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      if (url.startsWith(GQL)) {
        if (typeof init?.body === 'string') {
          // Known now: a request naming nothing read is left alone entirely.
          bodyText = names(init.body) ? init.body : null;
        } else if (input instanceof Request) {
          // A Request's body is used up by the real call, so it has to be copied first, and is
          // only known later: its answer is copied, then dropped unless it names one.
          bodyText = input.clone().text();
        }
      }
    } catch {
      bodyText = null;
    }
    const pending = realFetch.apply(this, arguments);
    if (!bodyText) return pending;
    // The copy has to be taken before the page gets the response: the page reads it at once,
    // and a body that has been read cannot be copied. A failed call passes straight through.
    return pending.then((res) => {
      try {
        watch(res.clone(), bodyText);
      } catch {
        // Nothing to report: the page still gets its answer.
      }
      return res;
    });
  };
})();
