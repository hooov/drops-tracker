// A repeating reward drop's window ending between two reward inventory reads (2026-11-20: read
// 60 of 60 at 17:49:43, window ended 17:50:15, Twitch counting the next one by 17:52).
import test from 'node:test';
import assert from 'node:assert/strict';
import { rewardsDue, openWindowUnknown, REWARD_HOLD_MS, REWARD_RETRY_MS } from '../extension/lib/tracker.js';

const READ = Date.parse('2026-11-20T17:49:43Z');
const END = Date.parse('2026-11-20T17:50:15Z');
const group = (over = {}) => ({ id: 'dvd', campaignId: 'gta', required: 60, minutes: 60, grants: 2, repeatTimes: 6, windowEnd: END, ...over });
const prev = (groups, at = READ, checkAt = at) => ({ rewardCheck: { at: checkAt }, rewardInv: { at, groups } });

test('rewardsDue: asked once a window it read has ended, not every poll before or after', () => {
  assert.equal(rewardsDue(undefined, READ), true, 'nothing read yet');
  assert.equal(rewardsDue(prev([group()]), READ + 30000), false, 'window still open');
  assert.equal(rewardsDue(prev([group()]), END + 30000), true, 'ended since the read');
  const after = END + 60000;
  assert.equal(rewardsDue(prev([group({ windowEnd: END + 86400000 })], after), after + 60000), false, 'read after the roll: back to the hold');
  assert.equal(rewardsDue(prev([group({ windowEnd: READ - 1 })]), READ + 60000), false, 'a window already over when read');
  assert.equal(rewardsDue(prev([group()]), READ + REWARD_HOLD_MS), true, 'the hold still applies');
});

test('rewardsDue: a failed re-ask waits REWARD_RETRY_MS, and stops once the held answer is gone', () => {
  // A failed call moves rewardCheck.at (ok false) but keeps the held answer's own read time.
  const failedAt = END + 60000;
  const failed = { rewardCheck: { at: failedAt, ok: false }, rewardInv: { at: READ, groups: [group()] } };
  assert.equal(rewardsDue(failed, failedAt + 60000), false, 'not the very next poll');
  assert.equal(rewardsDue(failed, failedAt + REWARD_RETRY_MS - 1), false);
  assert.equal(rewardsDue(failed, failedAt + REWARD_RETRY_MS), true, 'one retry after the wait');
  assert.equal(rewardsDue({ rewardCheck: { at: failedAt, ok: false }, rewardInv: null }, failedAt + REWARD_RETRY_MS), false, 'held answer expired');
});

test('openWindowUnknown: only a window known to be done lets the running total be judged', () => {
  const session = { dropId: 'dvd' };
  assert.deepEqual(openWindowUnknown(session, { groups: [group()] }, END - 1000), [], 'open and at 60: really wasted');
  assert.deepEqual(openWindowUnknown(session, { groups: [group()] }, END + 1000), ['dvd'], 'window over: the next may be counting');
  assert.deepEqual(openWindowUnknown(session, { groups: [group({ minutes: 2 })] }, END - 1000), ['dvd'], 'window not done');
  assert.deepEqual(openWindowUnknown(session, { groups: [group({ grants: 6 })] }, END + 1000), [], 'every repeat granted');
  assert.deepEqual(openWindowUnknown(session, { groups: [group({ repeatTimes: null })] }, END + 1000), [], 'not a repeating drop');
  assert.deepEqual(openWindowUnknown({ dropId: 'other' }, { groups: [group()] }, END + 1000), []);
  assert.deepEqual(openWindowUnknown(session, null, END), []);
  assert.deepEqual(openWindowUnknown(session, { groups: [group({ nextEligibleAt: END + 3600000 })] }, END + 1000), [], 'Twitch says the next window opens later');
  assert.deepEqual(openWindowUnknown(session, { groups: [group({ nextEligibleAt: END })] }, END + 1000), ['dvd'], 'next window already eligible');
});

test('openWindowUnknown: no inventory reading, but the drop has been a running total', () => {
  const session = { dropId: 'dvd' };
  const marks = { 'dvd:total': { peak: 637 } };
  assert.deepEqual(openWindowUnknown(session, null, END, marks), ['dvd'], 'a failed or expired inventory does not make 637 of 60 "earned"');
  assert.deepEqual(openWindowUnknown(session, { groups: [] }, END, marks), ['dvd']);
  assert.deepEqual(openWindowUnknown(session, null, END, {}), [], 'never a running total: judged as before');
  assert.deepEqual(openWindowUnknown(session, { groups: [group()] }, END - 1000, marks), [], 'a reading wins over the mark');
});
