// A channel badge leaving Twitch's in-progress reward list (tracker.js leftBadges). Seen
// 2026-11-20: 179 of 180 at one poll, gone at the next, every other group still listed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { leftBadges, update, events } from '../extension/lib/tracker.js';
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

// Replayed 2026-11-24, not captured: the last account's badge at 179 of 180 is not in the new one's list.
const answers = (rewardGroups, over = {}) => ({ campaigns: [], rewards: { ids: [], complete: true }, session: null, sessions: [], streams: [], rewardGroups, ...over });
const polls = (list) => list.reduce((s, obs, i) => update(s, obs, T0 + i * 60000), undefined);
const changed = { accountChanged: true };
const failedPoll = (kind, over = {}) => ({ error: { kind, message: 'x' }, ...over });

test('another account signs in: the last one\'s badge did not leave their list', () => {
  for (const [name, between] of [
    ['straight after', [answers([], changed)]],
    // The held answer must not stay to be compared with theirs a poll later.
    ['their first reward answer failing', [answers(null, changed)]],
    ['a signed-out poll between', [failedPoll('auth'), answers([], changed)]],
    ['a signed-out poll, then no fingerprint', [failedPoll('auth')]],
    ['their first poll failing', [failedPoll('network', changed)]],
  ]) {
    assert.deepEqual(polls([answers([group()]), ...between, answers([]), answers([])]).leftBadges, [], name);
  }
  const held = polls([answers([group()]), answers(null, changed)]);
  assert.equal(held.rewardInv, null, 'nor is it read as their progress for the 15 minutes an answer is held');
});

test('another account signs in: one the last one earned is forgotten', () => {
  const left = [answers([group()]), answers([])];
  assert.equal(polls(left).leftBadges.length, 1);
  assert.deepEqual(polls([...left, answers([], changed)]).leftBadges, []);
  assert.deepEqual(polls([...left, failedPoll('auth'), answers([])]).leftBadges, []);
});

test('the new account\'s own badge leaving is recorded, and a failed poll forgets nothing', () => {
  assert.equal(polls([answers([group({ minutes: 20 })]), answers([group()], changed), answers([])]).leftBadges.length, 1);
  for (const kind of ['network', 'api_changed']) {
    assert.equal(polls([answers([group()]), failedPoll(kind), answers([])]).leftBadges.length, 1, kind);
  }
});

test('another account with more minutes on a badge no channel lists: not rising', () => {
  const said = (list) => {
    let s;
    const out = [];
    for (const [i, obs] of list.entries()) {
      const next = update(s, obs, T0 + i * 60000);
      out.push(...events(s, next, T0 + i * 60000).filter((e) => e.type === 'unplaced'));
      s = next;
    }
    return { out, rising: s.unplacedBadges.map((u) => u.rising) };
  };
  const mine = answers([group({ minutes: 20 })]);
  const theirs = (over) => answers([group({ minutes: 40 })], over);
  for (const [name, list] of [
    ['straight after', [mine, theirs(changed), theirs()]],
    ['a signed-out poll between', [mine, failedPoll('auth'), theirs(changed), theirs()]],
    ['a signed-out poll, then no fingerprint', [mine, failedPoll('auth'), theirs()]],
    ['their first poll failing', [mine, failedPoll('network', changed), theirs()]],
    ['their first reward answer failing', [mine, answers(null, changed), theirs()]],
  ]) {
    assert.deepEqual(said(list), { out: [], rising: [false] }, name);
  }
  // Their own minutes rising still says it, once.
  const own = said([mine, theirs(changed), answers([group({ minutes: 41 })]), answers([group({ minutes: 42 })])]);
  assert.deepEqual([own.out.length, own.rising], [1, [true]]);
  assert.deepEqual(said([mine, failedPoll('network'), theirs()]).rising, [true], 'a failed poll forgets nothing');
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
