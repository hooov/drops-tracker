// page-hook.js, the real file, run in a sandbox with a fake fetch. Since 2026-11-22 it runs on
// every twitch.tv page, including the channel page that reports watched minutes, where a failed
// report loses the minute. So it must leave every other request alone: no copy of the answer
// unless the request names an operation it reads, and the page always gets the real response.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../extension/page-hook.js', import.meta.url), 'utf8');
const GQL = 'https://gql.twitch.tv/gql';

function sandbox(answer) {
  const posted = [];
  const calls = { clones: 0 };
  const realFetch = async () => {
    const res = new Response(JSON.stringify(answer), { status: 200 });
    const clone = res.clone.bind(res);
    res.clone = () => { calls.clones += 1; return clone(); };
    return res;
  };
  const win = {
    fetch: realFetch,
    // Plain copies: objects made in the sandbox fail strict comparison with this realm's.
    postMessage: (msg, origin) => posted.push(JSON.parse(JSON.stringify({ msg, origin }))),
    location: { origin: 'https://www.twitch.tv' },
  };
  win.window = win;
  vm.createContext(Object.assign(win, { Request, Response, JSON, Promise, Array }));
  vm.runInContext(code, win);
  return { win, posted, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('a request for any other operation: the answer is not copied, the page gets it whole', async () => {
  // sendSpadeEvents reports watched minutes; a claim from the channel panel goes the same way.
  for (const op of ['sendSpadeEvents', 'DropsPage_ClaimDropRewards']) {
    const { win, posted, calls } = sandbox([{ data: { ok: op } }]);
    const res = await win.fetch(GQL, { method: 'POST', body: JSON.stringify([{ operationName: op, variables: {} }]) });
    assert.deepEqual(await res.json(), [{ data: { ok: op } }], op);
    await settle();
    assert.deepEqual([calls.clones, posted], [0, []], op);
  }
});

test('the same with a Request: copied to read its name, then dropped, the page gets it whole', async () => {
  const body = [{ operationName: 'sendSpadeEvents', variables: {} }];
  const { win, posted, calls } = sandbox([{ data: { ok: true } }]);
  const res = await win.fetch(new Request(GQL, { method: 'POST', body: JSON.stringify(body) }));
  assert.deepEqual(await res.json(), [{ data: { ok: true } }]);
  await settle();
  assert.equal(calls.clones, 1, 'its body is only known after the call');
  assert.deepEqual(posted, []);
});

test('DropChannelCampaignsProgress: passed on as dayRewards, and the page still gets its answer', async () => {
  const answer = [{ data: { x: 1 } }, { data: { channelDropCampaignsProgress: [] } }];
  const { win, posted } = sandbox(answer);
  const body = [{ operationName: 'Other' }, { operationName: 'DropChannelCampaignsProgress', variables: { channelID: '1' } }];
  const res = await win.fetch(GQL, { method: 'POST', body: JSON.stringify(body) });
  assert.deepEqual(await res.json(), answer);
  await settle();
  assert.deepEqual(posted, [{ msg: { source: 'drops-tracker', type: 'dayRewards', item: answer[1] }, origin: 'https://www.twitch.tv' }]);
});

test('ViewerDropsDashboard: still passed on as directory', async () => {
  const answer = { data: { currentUser: {} } };
  const { win, posted } = sandbox(answer);
  await win.fetch(GQL, { method: 'POST', body: JSON.stringify({ operationName: 'ViewerDropsDashboard' }) });
  await settle();
  assert.deepEqual(posted.map((p) => p.msg.type), ['directory']);
});

test('not GQL, or an answer that is not JSON: passed through, nothing posted, nothing thrown', async () => {
  const { win, posted, calls } = sandbox('x');
  const res = await win.fetch('https://www.twitch.tv/other', { method: 'POST', body: '{"operationName":"DropChannelCampaignsProgress"}' });
  assert.equal(await res.text(), '"x"');
  const res2 = await win.fetch(GQL, { method: 'POST', body: '{"operationName":"DropChannelCampaignsProgress"}' });
  assert.equal(await res2.text(), '"x"', 'an answer of the wrong shape still reaches the page');
  await settle();
  assert.equal(calls.clones, 1, 'only the GQL call it reads');
  assert.deepEqual(posted, []);
});
