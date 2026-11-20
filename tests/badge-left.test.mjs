// A channel badge leaving Twitch's in-progress reward list (tracker.js leftBadges). Seen
// 2026-11-20: 179 of 180 at one poll, gone at the next, every other group still listed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { leftBadges } from '../extension/lib/tracker.js';
import { badgeSections } from '../extension/lib/badges.js';
import { MAX_REWARD_GROUPS } from '../extension/lib/states.js';

const T0 = Date.parse('2026-11-20T08:14:06Z');
const T1 = T0 + 60000;
const group = (over = {}) => ({ campaignId: 'camp-badge', id: 'grp-badge', badge: true, required: 180, minutes: 179, status: 'IN_PROGRESS', earned: false, ...over });
const other = { campaignId: 'camp-other', id: 'grp-other', badge: true, required: 180, minutes: 131, status: 'IN_PROGRESS', earned: false };

test('a badge gone from a fresh answer is recorded with its last reading', () => {
  const out = leftBadges([], { at: T0, groups: [group(), other] }, [other], T1);
  assert.deepEqual(out, [{ campaignId: 'camp-badge', id: 'grp-badge', minutes: 179, required: 180, readAt: T0, at: T1 }]);
});

test('a failed answer, or one that may be cut short, records nothing and keeps what it had', () => {
  const kept = [{ campaignId: 'x', id: 'y', minutes: 1, required: 2, readAt: T0, at: T0 }];
  assert.equal(leftBadges(kept, { at: T0, groups: [group()] }, null, T1), kept);
  const full = Array.from({ length: MAX_REWARD_GROUPS }, (_, i) => ({ ...other, id: `g${i}` }));
  assert.equal(leftBadges(kept, { at: T0, groups: [group()] }, full, T1), kept);
});

test('back in the list drops the record; earned, claimed or not a badge is never recorded', () => {
  const was = leftBadges([], { at: T0, groups: [group()] }, [], T1);
  assert.equal(was.length, 1);
  assert.deepEqual(leftBadges(was, { at: T1, groups: [] }, [group({ minutes: 179 })], T1 + 60000), []);
  for (const g of [group({ earned: true }), group({ status: 'CLAIMED' }), group({ badge: false }), group({ minutes: 180 })]) {
    assert.deepEqual(leftBadges([], { at: T0, groups: [g] }, [], T1), [], JSON.stringify(g));
  }
});

test('bounded: newest twenty kept', () => {
  let out = [];
  for (let i = 0; i < 25; i++) out = leftBadges(out, { at: T0 + i, groups: [group({ id: `g${i}` })] }, [], T0 + i + 1);
  assert.equal(out.length, 20);
  assert.equal(out[19].id, 'g24');
});

test('Badges tab: near the requirement reads likely earned, further off says it does not know why', () => {
  const stream = (left) => ({
    login: 'foxtrot', displayName: 'Foxtrot', channelState: 'badge_left',
    badges: [{ id: 'camp-badge', name: 'gta6', endAt: '2026-11-20T19:00:00Z', drops: [{ id: 'grp-badge', name: 'gta6', required: 180, minutes: left.minutes, left }] }],
  });
  const line = (left) => badgeSections([stream(left)], 'foxtrot', T1)[0].campaigns[0].drops[0];
  const near = line({ minutes: 179, at: T0, near: true });
  assert.equal(near.line, "Likely earned: left Twitch's in-progress list at 179 of 180 min");
  assert.deepEqual([near.pct, near.atRisk], [99, false]);
  assert.equal(line({ minutes: 60, at: T0, near: false }).line, "Left Twitch's in-progress list at 60 of 180 min, reason unknown");
});
