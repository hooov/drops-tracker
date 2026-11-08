// The e2e and screenshot scripts run against the real clock, so captured campaign dates expire.
// On 2026-11-08 the e2e failed because a badge campaign in the fixture had ended for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture } from '../scripts/fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = (name) => JSON.parse(readFileSync(join(root, 'tests', 'fixtures', name), 'utf8'));
const DAY = 86400000;

for (const later of [0, 2 * DAY, 400 * DAY]) {
  test(`a campaign live at capture is still live ${later / DAY} days later`, () => {
    const now = Date.parse('2026-11-06T19:00:00Z') + later;
    const fx = loadFixture(root, 'badge-2026-11-06.json', now);
    const campaign = fx.mixed.viewerDropCampaigns[0];
    assert.ok(Date.parse(campaign.endAt) > now, 'campaign not ended');
    for (const d of campaign.timeBasedDrops) {
      assert.ok(Date.parse(d.startAt) < now, `${d.name} started`);
      assert.ok(Date.parse(d.endAt) > now, `${d.name} not ended`);
    }
  });
}

test('every timestamp moves by the same amount, and nothing else changes', () => {
  const shift = 5 * DAY;
  const now = Date.parse('2026-11-06T19:00:00Z') + shift;
  for (const name of ['gql-2026-11-06.json', 'dashboard-2026-11-06.json', 'badge-2026-11-06.json']) {
    const before = raw(name);
    const after = loadFixture(root, name, now);
    const walk = (a, b, path) => {
      if (typeof a === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(a)) {
        assert.equal(Date.parse(b) - Date.parse(a), shift, `${name} ${path}`);
      } else if (a && typeof a === 'object') {
        assert.deepEqual(Object.keys(b), Object.keys(a), `${name} ${path}`);
        for (const k of Object.keys(a)) walk(a[k], b[k], `${path}.${k}`);
      } else {
        assert.equal(b, a, `${name} ${path}`);
      }
    };
    walk(before, after, '');
  }
});
