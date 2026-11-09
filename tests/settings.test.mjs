import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, refreshDue, autoReloadStep, autoReloadNote, DEFAULTS, DROPS_PAGES, RELOAD_MAX } from '../extension/lib/settings.js';

const MIN = 60000;
const on = (minutes) => ({ autoRefresh: true, autoRefreshMinutes: minutes, autoReload: true, devMode: false, claimReminders: true });

test('helpers on and developer mode off by default; bad stored values fall back to the defaults', () => {
  assert.deepEqual(normalize(undefined), DEFAULTS);
  assert.deepEqual(DEFAULTS, { autoRefresh: true, autoRefreshMinutes: 5, autoReload: true, devMode: false, claimReminders: true });
  assert.deepEqual(normalize({ autoRefresh: 'yes', autoRefreshMinutes: 7, autoReload: 1, devMode: 'on', claimReminders: 0 }), DEFAULTS);
  assert.deepEqual(normalize({ autoRefresh: true, autoRefreshMinutes: 10 }), on(10));
});

test('a saved off wins over a default-on setting, so turning one off sticks', () => {
  const off = normalize({ autoRefresh: false, autoReload: false, devMode: true, claimReminders: false });
  assert.deepEqual([off.autoRefresh, off.autoReload, off.devMode, off.claimReminders], [false, false, true, false]);
});

test('off never refreshes and clears the timer', () => {
  assert.deepEqual(refreshDue(normalize({ autoRefresh: false }), 1000, 999999999), { due: false, nextLastAt: null });
});

test('switching on starts the timer instead of reloading at once', () => {
  assert.deepEqual(refreshDue(on(5), null, 1000), { due: false, nextLastAt: 1000 });
});

test('refreshes when the interval passes, then restarts it', () => {
  assert.deepEqual(refreshDue(on(5), 0, 4 * MIN), { due: false, nextLastAt: 0 });
  assert.deepEqual(refreshDue(on(5), 0, 5 * MIN), { due: true, nextLastAt: 5 * MIN });
});

test('an alarm firing a few seconds early does not slip a whole minute', () => {
  assert.equal(refreshDue(on(5), 0, 5 * MIN - 3000).due, true);
  assert.equal(refreshDue(on(1), 0, MIN - 3000).due, true);
});

test('only ever targets the Drops pages, never stream tabs', () => {
  assert.deepEqual(DROPS_PAGES, ['https://www.twitch.tv/drops/*']);
});

const reload = { autoReload: true };
const hung = (cause = 'uncounted', since = 0, tabId = 7) => ({ verdict: { code: 'stalled', since, cause, tabId }, lastGainAt: null });

test('auto-reload is on by default, and switched off it never fires', () => {
  assert.equal(normalize(undefined).autoReload, true);
  assert.equal(autoReloadStep(null, hung(), normalize({}), 60 * MIN).tabId, 7);
  assert.equal(autoReloadStep(null, hung(), normalize({ autoReload: false }), 60 * MIN).tabId, null);
});

test('auto-reload waits past the 5 minute hangs that were measured', () => {
  assert.equal(autoReloadStep(null, hung(), reload, 5 * MIN).tabId, null);
  const first = autoReloadStep(null, hung(), reload, 6 * MIN);
  assert.equal(first.tabId, 7);
  assert.deepEqual(first.memo, { since: 0, tries: 1, lastAt: 6 * MIN, recoveredAt: null });
});

test('auto-reload waits 10 minutes between tries and stops at the limit', () => {
  let memo = null;
  const reloads = [];
  for (let m = 0; m <= 90; m++) {
    const step = autoReloadStep(memo, hung(), reload, m * MIN);
    if (step.tabId != null) reloads.push(m);
    memo = step.memo;
  }
  assert.deepEqual(reloads, [6, 16, 26]);
  assert.equal(reloads.length, RELOAD_MAX);
});

test('auto-reload never fires for what a reload cannot fix', () => {
  for (const cause of ['paused', 'too_many', 'second_stream', 'claim_first', 'no_video']) {
    assert.equal(autoReloadStep(null, hung(cause), reload, 60 * MIN).tabId, null, cause);
  }
  for (const cause of ['uncounted', 'frozen', 'ended', 'asleep']) {
    assert.equal(autoReloadStep(null, hung(cause), reload, 60 * MIN).tabId, 7, cause);
  }
});

test('auto-reload only acts on a hang with a tab to reload', () => {
  for (const verdict of [{ code: 'earning' }, { code: 'waiting', since: 0 }, { code: 'idle', limited: true }, { code: 'error' }, null]) {
    assert.equal(autoReloadStep(null, { verdict }, reload, 60 * MIN).tabId, null, JSON.stringify(verdict));
  }
  assert.equal(autoReloadStep(null, hung('uncounted', 0, null), reload, 60 * MIN).tabId, null);
});

test('a new hang gets its own tries', () => {
  const spent = { since: 0, tries: RELOAD_MAX, lastAt: 26 * MIN, recoveredAt: null };
  assert.equal(autoReloadStep(spent, hung('uncounted', 0), reload, 90 * MIN).tabId, null);
  assert.equal(autoReloadStep(spent, hung('uncounted', 80 * MIN), reload, 90 * MIN).tabId, 7);
});

test('auto-reload records whether minutes came back, and says so', () => {
  const memo = { since: 0, tries: 1, lastAt: 6 * MIN, recoveredAt: null };
  const stepped = autoReloadStep(memo, { verdict: { code: 'earning' }, lastGainAt: 9 * MIN }, reload, 9 * MIN);
  assert.equal(stepped.memo.recoveredAt, 9 * MIN);
  assert.equal(autoReloadNote(stepped.memo, { verdict: { code: 'earning' } }, 10 * MIN), 'Minutes came back 3m after an auto-reload.');
  assert.equal(autoReloadNote(stepped.memo, { verdict: { code: 'earning' } }, 45 * MIN), '', 'old news goes away');
});

test('a gain from before the reload is not credited to it', () => {
  const memo = { since: 0, tries: 1, lastAt: 6 * MIN, recoveredAt: null };
  assert.equal(autoReloadStep(memo, { verdict: { code: 'stalled' }, lastGainAt: 0 }, reload, 7 * MIN).memo.recoveredAt, null);
});

test('the note tracks tries and says when it gave up', () => {
  const state = hung();
  assert.equal(autoReloadNote({ since: 0, tries: 1, lastAt: 6 * MIN }, state, 8 * MIN), 'Auto-reloaded 1 of 3, 2m ago.');
  assert.match(autoReloadNote({ since: 0, tries: RELOAD_MAX, lastAt: 26 * MIN }, state, 30 * MIN), /did not help/);
  assert.equal(autoReloadNote({ since: 99, tries: 1, lastAt: 6 * MIN }, hung('uncounted', 3 * 60 * MIN), 3 * 60 * MIN + 8 * MIN), '', 'about another hang, hours later');
  // Same rule as the step: a pause poll restarting since mid-hang must not drop the note.
  assert.equal(autoReloadNote({ since: 99, tries: 1, lastAt: 6 * MIN }, state, 8 * MIN), 'Auto-reloaded 1 of 3, 2m ago.', 'same hang, new since');
  assert.equal(autoReloadNote(null, state, 8 * MIN), '');
});

test('a reload that leaves the player paused for a poll does not reset the 3-try cap', () => {
  // Each reload can briefly pause the player, which restarts the verdict's since. Without minutes
  // coming back in between, it is still the same hang.
  let memo = null;
  let reloads = 0;
  for (let i = 0; i < 6; i++) { // just under an hour after the last reload
    const since = i * 11 * MIN; // a fresh since every round, as a pause-then-play would give
    const step = autoReloadStep(memo, hung('uncounted', since), reload, since + 7 * MIN);
    if (step.tabId != null) reloads++;
    memo = step.memo;
  }
  assert.equal(reloads, RELOAD_MAX);
});

test('minutes coming back give the next hang a fresh budget', () => {
  let memo = { since: 0, tries: RELOAD_MAX, lastAt: 30 * MIN, recoveredAt: null };
  const state = { ...hung('uncounted', 40 * MIN), lastGainAt: 35 * MIN };
  const step = autoReloadStep(memo, state, reload, 47 * MIN);
  assert.equal(step.tabId, 7);
  assert.equal(step.memo.tries, 1);
  memo = { since: 0, tries: RELOAD_MAX, lastAt: 0, recoveredAt: null };
  assert.equal(autoReloadStep(memo, hung('uncounted', 2 * 60 * MIN), reload, 2 * 60 * MIN + 7 * MIN).tabId, 7, 'an hour later is a new hang');
});
