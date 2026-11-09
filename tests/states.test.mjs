// The state tables in states.js must cover every state the tracker can produce, and nothing it
// cannot. These read tracker.js itself: a cause, channel state, player state or verdict code added
// there without its entry fails here, instead of showing as a blank label or a missing reload rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STALL_CAUSES, PLAYER_STATES, CHANNEL_STATES, VERDICT_CODES, verdictTone } from '../extension/lib/states.js';

const src = readFileSync(new URL('../extension/lib/tracker.js', import.meta.url), 'utf8');
/** The body of a top-level function in tracker.js, up to the next top-level declaration. */
function body(name) {
  const start = src.search(new RegExp(`\\nfunction ${name}\\(|\\nexport function ${name}\\(`));
  assert.ok(start >= 0, `${name} not found in tracker.js`);
  const rest = src.slice(start + 1);
  const end = rest.search(/\n(export )?(function|const|let) /);
  return end < 0 ? rest : rest.slice(0, end);
}
const literals = (text, re) => new Set([...text.matchAll(re)].map((m) => m[1]));
const sorted = (set) => [...set].sort();

test('every player state classifyPlayer returns is declared, and none that it never returns', () => {
  const returned = literals(body('classifyPlayer'), /state: '(\w+)'/g);
  assert.deepEqual(sorted(returned), Object.keys(PLAYER_STATES).sort());
});

test('every channel state classifyChannel returns is declared with a label, and none that it never returns', () => {
  const returned = literals(body('classifyChannel'), /return (?:[^;]*\? )?'(\w+)'/g);
  for (const m of body('classifyChannel').matchAll(/: '(\w+)'/g)) returned.add(m[1]);
  assert.deepEqual(sorted(returned), Object.keys(CHANNEL_STATES).sort());
  for (const [state, { label }] of Object.entries(CHANNEL_STATES)) assert.ok(label, `${state} has no label`);
});

test('every stall cause diagnose can give is declared: its own causes and every player state that explains a stall', () => {
  const own = literals(body('diagnose'), /cause: '(\w+)'/g);
  const fromPlayer = Object.entries(PLAYER_STATES).filter(([, p]) => p.stall).map(([k]) => k);
  assert.match(body('diagnose'), /cause: s\.playerState/, 'diagnose still passes the player state through as a cause');
  assert.deepEqual(sorted(new Set([...own, ...fromPlayer])), Object.keys(STALL_CAUSES).sort());
});

test('a cause Auto-reload acts on is always one the panel offers to reload', () => {
  for (const [cause, rule] of Object.entries(STALL_CAUSES)) {
    if (rule.autoReload) assert.equal(rule.reloadButton, true, cause);
  }
});

test('every stall message reads as a sentence with the tab named', () => {
  for (const [state, p] of Object.entries(PLAYER_STATES)) {
    if (!p.stall) continue;
    const text = p.stall('AlphaTV');
    assert.match(text, /AlphaTV/, state);
    assert.match(text, /\.$/, state);
  }
});

test('every verdict code the tracker writes is declared, and none that it never writes', () => {
  const written = literals(src, /code: '(\w+)'/g);
  // Error kinds map to codes through a table rather than a literal `code:`.
  for (const code of ['signed_out', 'api_changed', 'error']) assert.ok(src.includes(`'${code}'`), code);
  for (const code of ['signed_out', 'api_changed', 'error']) written.add(code);
  assert.deepEqual(sorted(written), Object.keys(VERDICT_CODES).sort());
});

test('every verdict code has a deliberate colour', () => {
  const expected = { starting: 'info', waiting: 'info', earning: 'ok', stalled: 'bad', idle: 'idle', signed_out: 'warn', api_changed: 'warn', error: 'warn' };
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(VERDICT_CODES).sort());
  for (const [code, tone] of Object.entries(expected)) assert.equal(verdictTone({ code }), tone, code);
  assert.equal(verdictTone({ code: 'earning', slow: true }), 'warn');
  assert.equal(verdictTone({ code: 'earning', wasted: { reason: 'earned' } }), 'warn');
  assert.equal(verdictTone({ code: 'idle', lost: true }), 'warn');
  assert.equal(verdictTone({ code: 'idle', limited: true }), 'warn');
});
