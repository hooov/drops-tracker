// One meaning per colour (agreed with Tyler 2026-11-20, docs/state-audit.html): green earning,
// amber you should do something, red Twitch stopped counting, grey dashed "?" the tracker cannot
// see, grey nothing to do, blue checking, purple a reward to claim. The panel dot, the chip and the
// toolbar take their colour from verdictTone(), so they cannot drift apart again (the toolbar
// once said grey ERR beside an amber chip).
import test from 'node:test';
import assert from 'node:assert/strict';
import { verdictTone, TONE_COLORS, STALL_CAUSES } from '../extension/lib/states.js';
import { badge, warning } from '../extension/lib/tracker.js';
import { chipView } from '../extension/lib/chip.js';
import { verdictText } from '../extension/lib/panel.js';

const NOW = Date.parse('2026-11-20T18:00:00Z');
const MIN = 60000;
const drop = { id: 'd1', campaignId: 'c1', name: 'GTA DVD Chest', pct: 35, minutes: 21, required: 60, remaining: 39 };
const foxtrot = { login: 'foxtrot', displayName: 'Foxtrot', channelState: 'eligible', campaignIds: ['c1'], credited: true };
const echo = { login: 'echo_247', displayName: 'echo_247', channelState: 'eligible', campaignIds: ['c2'], credited: false };
const state = (verdict, over = {}) => ({
  verdict, active: [drop], streams: [foxtrot], unclaimed: [], pending: [], lastPollAt: NOW, lastOkAt: NOW, rate: { counted: 7, watched: 12 },
  session: { login: 'foxtrot', displayName: 'Foxtrot', dropId: 'd1' }, ...over,
});
const earned = (over = {}) => ({ reason: 'earned', channel: 'Foxtrot', name: 'GTA DVD Chest', actionable: false, opens: null, message: 'x', ...over });

// [name, state, expected { tone, chip text on foxtrot, toolbar text, warns }]
const rows = [
  ['earning', state({ code: 'earning', channel: 'Foxtrot' }), { tone: 'ok', chip: '35%', tb: '35%', warns: false }],
  ['earning slowly', state({ code: 'earning', channel: 'Foxtrot', slow: true }), { tone: 'ok', chip: '35%', tb: '35%', warns: false }],
  ['already earned, another tab can earn', state({ code: 'earning', channel: 'Foxtrot', wasted: earned({ actionable: true }) }, { streams: [foxtrot, echo] }), { tone: 'warn', chip: 'Close tab', tb: '!', warns: false }],
  // As it happens: today's reward drop, once earned, leaves the active list.
  ['already earned, nothing else can earn', state({ code: 'earning', channel: 'Foxtrot', wasted: earned() }, { active: [] }), { tone: 'idle', chip: 'Done', tb: '', warns: false }],
  ['already earned, a badge still in progress on the channel', state({ code: 'earning', channel: 'Foxtrot', wasted: earned() }), { tone: 'idle', chip: '35%', tb: '35%', warns: false }],
  ['too late', state({ code: 'earning', channel: 'Foxtrot', wasted: earned({ reason: 'too_late' }) }), { tone: 'warn', chip: '35%', tb: '35%', warns: false }],
  ['not counting', state({ code: 'stalled', since: NOW - 5 * MIN, cause: 'frozen', message: 'x' }), { tone: 'bad', chip: 'Hung 5m', tb: '!', warns: true }],
  ['stopped earning', state({ code: 'idle', hasStreams: true, lost: true, message: 'x' }, { lostAt: NOW - MIN }), { tone: 'warn', chip: 'Stopped', tb: '!', warns: true }],
  ['signed out', state({ code: 'signed_out', message: 'x' }), { tone: 'warn', chip: 'Log in', tb: 'OFF', warns: true }],
  ['not counting yet (unstarted)', state({ code: 'idle', hasStreams: true, limited: true, unstarted: true, message: 'x' }), { tone: 'idle', chip: 'Not yet', tb: '', warns: false }],
  ['not counting yet (blocked)', state({ code: 'idle', hasStreams: true, limited: true, blocked: true, message: 'x' }), { tone: 'idle', chip: 'Not yet', tb: '', warns: false }],
  ['cannot tell if finished', state({ code: 'idle', hasStreams: true, limited: true, unproven: true, message: 'x' }), { tone: 'idle', chip: '35%', tb: '', warns: false }],
  ['cannot track this badge', state({ code: 'idle', hasStreams: true, limited: true, badge: true, message: 'x' }), { tone: 'unknown', chip: 'Drops ?', tb: '?', warns: true }],
  ['cannot check streams, just now', state({ code: 'idle', hasStreams: true, limited: true, since: NOW - MIN, message: 'x' }), { tone: 'unknown', chip: 'Drops ?', tb: '?', warns: false }],
  ['cannot check streams, 3 min', state({ code: 'idle', hasStreams: true, limited: true, since: NOW - 3 * MIN, message: 'x' }), { tone: 'unknown', chip: 'Drops ?', tb: '?', warns: true }],
  ['cannot read Twitch', state({ code: 'error', message: 'x' }), { tone: 'unknown', chip: 'Drops ?', tb: '?', warns: false }],
  ['API changed', state({ code: 'api_changed', message: 'x' }), { tone: 'unknown', chip: 'Drops ?', tb: '?', warns: true }],
  ['starting', state({ code: 'starting' }), { tone: 'wait', chip: '35%', tb: '', warns: false }],
  ['checking', state({ code: 'waiting', since: NOW - MIN }), { tone: 'wait', chip: '35%', tb: '...', warns: false }],
  ['reward campaign', state({ code: 'idle', hasStreams: true, reward: true, message: 'x' }), { tone: 'idle', chip: '35%', tb: '', warns: false }],
  ['not earning', state({ code: 'idle', hasStreams: true }), { tone: 'idle', chip: '35%', tb: '', warns: false }],
];

for (const [name, s, want] of rows) {
  test(`${name}: one colour on panel, chip and toolbar`, () => {
    const chip = chipView(s, NOW, 'foxtrot');
    const tb = badge(s);
    assert.deepEqual(
      { tone: verdictTone(s.verdict), chipTone: chip.tone, chip: chip.text, tb: tb.text, tbColor: tb.color, warns: !!warning(s, NOW) },
      { tone: want.tone, chipTone: want.tone, chip: want.chip, tb: want.tb, tbColor: TONE_COLORS[want.tone], warns: want.warns },
    );
  });
}

test('already earned with another tab that can earn: "Close tab" only on the credited tab', () => {
  const s = rows.find(([n]) => n === 'already earned, another tab can earn')[1];
  const other = chipView(s, NOW, 'echo_247');
  assert.equal(other.tone, 'warn');
  assert.notEqual(other.text, 'Close tab', 'the tab to keep must not say close');
});

test('cannot see: the compact ring shows "?" since there is no percentage', () => {
  const s = rows.find(([n]) => n === 'cannot read Twitch')[1];
  assert.equal(chipView(s, NOW, 'foxtrot').mark, '?');
});

test('a chip with no poll for 3 minutes reads unknown, not amber', () => {
  const s = state({ code: 'earning', channel: 'Foxtrot' }, { lastPollAt: NOW - 4 * MIN });
  assert.deepEqual([chipView(s, NOW, 'foxtrot').tone, chipView(s, NOW, 'foxtrot').text], ['unknown', 'Drops ?']);
});

test('done for today: headline says so, and it wins over slow', () => {
  const s = state({ code: 'earning', channel: 'Foxtrot', slow: true, wasted: earned({ opens: NOW + 6 * 3600000 }) });
  assert.equal(verdictText(s, NOW)[0], 'Done for today on Foxtrot');
  const once = state({ code: 'earning', channel: 'Foxtrot', wasted: earned() });
  assert.equal(verdictText(once, NOW)[0], 'Already earned on Foxtrot');
});

test('a claim waiting keeps purple on the toolbar when not earning', () => {
  const s = state({ code: 'idle', hasStreams: true }, { unclaimed: [{ id: 'u', name: 'Chest', campaignActive: true }], active: [] });
  assert.deepEqual(badge(s), { text: 'CLM', color: TONE_COLORS.info });
});

test('colours only: Auto-reload and the Reload button are unchanged', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(STALL_CAUSES).map(([k, v]) => [k, [v.autoReload, v.reloadButton]])), {
    uncounted: [true, true], frozen: [true, true], ended: [true, true], asleep: [true, true], no_video: [false, true],
    paused: [false, false], claim_first: [false, false], too_many: [false, false], second_stream: [false, false],
  });
});
