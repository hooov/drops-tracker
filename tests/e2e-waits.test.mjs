// Playwright's waitForFunction with an async predicate passes at once: the Promise it returns
// counts as truthy (measured 2026-11-19: an always-false one "passed" after 11ms, a sync one timed
// out). Five e2e waits had been checking nothing. Use until() in scripts/e2e.mjs instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

test('no script waits on an async waitForFunction predicate', () => {
  const dir = new URL('../scripts/', import.meta.url);
  const hits = readdirSync(dir).filter((f) => f.endsWith('.mjs')).flatMap((f) => readFileSync(new URL(f, dir), 'utf8')
    .split('\n')
    .map((line, i) => [f, i + 1, line])
    .filter(([, , line]) => /waitForFunction\(\s*async\b/.test(line)));
  assert.deepEqual(hits.map(([f, n]) => `${f}:${n}`), []);
});

test('the check catches the pattern it is for', () => {
  assert.ok(/waitForFunction\(\s*async\b/.test("await page.waitForFunction(async () => (await x()).ok);"));
  assert.ok(!/waitForFunction\(\s*async\b/.test("await page.waitForFunction(() => document.title === 'x');"));
});
