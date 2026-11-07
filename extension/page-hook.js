// Runs in the page's own world on Twitch's Drops pages. Twitch's campaign list needs its
// integrity check, which only its own page can pass, so the extension cannot ask for the list.
// It reads the answer Twitch's page already received instead. Nothing here touches the request,
// its headers or any token, and a failure here must never affect the page.
(() => {
  const OPERATION = 'ViewerDropsDashboard';
  const GQL = 'https://gql.twitch.tv/gql';
  const realFetch = window.fetch;

  async function watch(copy, bodyText) {
    try {
      const text = await bodyText;
      const at = typeof text === 'string' && text.includes(OPERATION)
        ? [].concat(JSON.parse(text)).findIndex((o) => o?.operationName === OPERATION)
        : -1;
      if (at < 0) {
        copy.body?.cancel(); // An unread copy would hold the whole answer in memory.
        return;
      }
      const answer = await copy.json();
      const item = Array.isArray(answer) ? answer[at] : answer;
      window.postMessage({ source: 'drops-tracker', type: 'directory', item }, window.location.origin);
    } catch {
      // Twitch changed how it calls this. The panel reports the list as not loaded.
    }
  }

  window.fetch = function fetch(input, init) {
    let bodyText = null;
    try {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      if (url.startsWith(GQL)) {
        // A Request's body is used up by the real call, so it has to be copied first.
        bodyText = typeof init?.body === 'string' ? init.body : (input instanceof Request ? input.clone().text() : null);
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
