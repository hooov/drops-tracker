import test from 'node:test';
import assert from 'node:assert/strict';
import { chipView, shouldCompact, fullWidth, STALE_MS } from '../extension/lib/chip.js';

const NOW = Date.parse('2026-11-06T15:00:00Z');
const drop = { name: 'Pouch of Violet Dust', minutes: 198, required: 240, pct: 82 };
const state = (verdict, over = {}) => ({ lastPollAt: NOW - 1000, active: [drop], unclaimed: [], verdict, ...over });

test('earning shows the percentage in green and names the channel', () => {
  const v = chipView(state({ code: 'earning', channel: 'AlphaTV' }), NOW);
  assert.equal(v.tone, 'ok');
  assert.equal(v.text, '82%');
  assert.match(v.title, /198\/240 min\. Earning on AlphaTV\./);
});

test('every failure to track is visibly not green', () => {
  const cases = [
    [{ code: 'stalled', since: NOW - 5 * 60000, message: 'Stuck.' }, 'bad', 'Hung 5m'],
    [{ code: 'idle', lost: true, message: 'Lost.' }, 'warn', 'Stopped'],
    [{ code: 'signed_out' }, 'warn', 'Drops off'],
    [{ code: 'api_changed' }, 'warn', 'Drops ?'],
    [{ code: 'error', message: 'Could not reach Twitch' }, 'warn', 'Drops ?'],
  ];
  for (const [verdict, tone, text] of cases) {
    const v = chipView(state(verdict), NOW);
    assert.deepEqual([v.tone, v.text], [tone, text], verdict.code);
  }
});

test('streams that cannot be checked are not green', () => {
  const v = chipView(state({ code: 'idle', limited: true, message: 'Cannot check.' }), NOW);
  assert.deepEqual([v.tone, v.text], ['warn', 'Drops ?']);
});

test('a tracker that stopped polling cannot keep showing green', () => {
  const v = chipView(state({ code: 'earning', channel: 'AlphaTV' }, { lastPollAt: NOW - STALE_MS - 60000 }), NOW);
  assert.equal(v.tone, 'warn');
  assert.equal(v.text, 'Drops ?');
  assert.match(v.title, /has not updated for 4 min/);
});

test('a stall outranks a claim', () => {
  const unclaimed = [{ name: 'Badge', campaignActive: true }];
  const v = chipView(state({ code: 'stalled', since: NOW - 60000, message: 'x' }, { unclaimed }), NOW);
  assert.equal(v.tone, 'bad');
  assert.match(v.text, /^Hung/);
});

test('a waiting claim keeps the ring green and the percentage showing, and counts the claim', () => {
  const unclaimed = [{ name: 'Badge', campaignActive: true }];
  const v = chipView(state({ code: 'earning', channel: 'Delta' }, { unclaimed }), NOW);
  assert.equal(v.text, '82%');
  assert.equal(v.pct, 82, 'the number in the ring when chat is narrow');
  assert.equal(v.tone, 'ok', 'green: a reward waiting is not something wrong');
  assert.equal(v.claims, 1);
  assert.match(v.title, /Badge is ready to claim/);
  assert.match(v.title, /Earning on Delta/);
});

test('several claims waiting are counted, and the title says how many', () => {
  const unclaimed = [{ name: 'A', campaignActive: true }, { name: 'B', campaignActive: true }, { name: 'Old', campaignActive: false }];
  const v = chipView(state({ code: 'earning', channel: 'Delta' }, { unclaimed }), NOW);
  assert.equal(v.claims, 2, 'only campaigns still running');
  assert.match(v.title, /^2 drops are ready to claim/);
});

test('no claim waiting: no count', () => {
  assert.equal(chipView(state({ code: 'earning' }), NOW).claims, 0);
});

test('a claim with nothing left to earn just says Claim, in purple', () => {
  const unclaimed = [{ name: 'Badge', campaignActive: true }];
  const v = chipView(state({ code: 'idle' }, { unclaimed, active: [] }), NOW);
  assert.deepEqual([v.text, v.pct, v.tone, v.claims], ['Claim', 100, 'info', 1]);
});

test('a waiting claim does not hide tracking having stopped or being unknown', () => {
  const unclaimed = [{ name: 'Badge', campaignActive: true }];
  const lost = chipView(state({ code: 'idle', lost: true, message: 'Lost.' }, { unclaimed }), NOW);
  assert.equal(lost.text, 'Stopped');
  assert.match(lost.title, /Badge is ready to claim/);
  const limited = chipView(state({ code: 'idle', limited: true, message: 'Cannot check.' }, { unclaimed }), NOW);
  assert.equal(limited.text, 'Drops ?');
  assert.match(limited.title, /Badge is ready to claim/);
});

test('a waiting claim is counted while not earning too, with the percentage', () => {
  const unclaimed = [{ name: 'Badge', campaignActive: true }];
  for (const code of ['idle', 'waiting']) {
    const v = chipView(state({ code }, { unclaimed }), NOW);
    assert.deepEqual([v.text, v.claims], ['82%', 1]);
  }
});

test('the label still falls back to the ring when the row has no room', () => {
  // The default 340px chat: a 324px row with 307px used, as measured.
  assert.equal(shouldCompact(324, 307, 32, '82%'), true);
  assert.equal(shouldCompact(500, 307, 32, '82%'), false);
});

test('a reward from an ended campaign is not counted', () => {
  const unclaimed = [{ name: 'Old', campaignActive: false }];
  const v = chipView(state({ code: 'earning' }, { unclaimed }), NOW);
  assert.deepEqual([v.text, v.claims, v.tone], ['82%', 0, 'ok']);
});

test('plain idle stays quiet, with or without drops in progress', () => {
  assert.deepEqual([chipView(state({ code: 'idle' }), NOW).tone, chipView(state({ code: 'idle' }), NOW).text], ['idle', '82%']);
  assert.equal(chipView(state({ code: 'idle' }, { active: [] }), NOW).text, 'Drops');
});

test('no state yet is neutral, not an error', () => {
  assert.equal(chipView(null, NOW).tone, 'idle');
});

test('compact decision: real row widths, stable whichever size the chip is at', () => {
  const others = 173 + 48 + 64; // Measured: points group, settings, send button with margin.
  const full = fullWidth('82%');
  const ring = 32;
  // Twitch's default 340px chat column gives a 324px row: too tight for the label.
  assert.equal(shouldCompact(324, others + ring, ring, '82%'), true);
  assert.equal(shouldCompact(324, others + full, full, '82%'), true);
  // A wider column fits it.
  assert.equal(shouldCompact(404, others + ring, ring, '82%'), false);
  assert.equal(shouldCompact(404, others + full, full, '82%'), false);
});

test('ring gets the progress even when the label is hidden', () => {
  assert.equal(chipView(state({ code: 'earning' }), NOW).pct, 82);
  assert.equal(chipView(state({ code: 'stalled', since: NOW, message: 'x' }), NOW).pct, 82);
  assert.equal(chipView(state({ code: 'idle' }, { active: [] }), NOW).pct, null);
});

test('earning slowly is amber and says the rate', () => {
  const v = chipView(state({ code: 'earning', channel: 'AlphaTV', slow: true }, { rate: { watched: 30, counted: 14 } }), NOW);
  assert.equal(v.tone, 'warn');
  assert.equal(v.text, '82%');
  assert.match(v.title, /Earning slowly on AlphaTV: 14 of the last 30 watched minutes counted/);
});
