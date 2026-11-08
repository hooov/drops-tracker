// Loads a captured Twitch answer from tests/fixtures for the scripts that run against the real
// clock (e2e, screenshots). The captures hold real dates, so a campaign that was live when it was
// captured has ended by now, and the extension rightly calls it finished: the e2e failed that
// way on 2026-11-08, two days after capture. Every timestamp is moved forward by the time since
// capture, so each campaign is exactly as live, ended or upcoming as it was then.
// Unit tests do not use this: they pass their own fixed "now".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// All fixtures were captured on 2026-11-06, before 19:38 UTC (git history), and after every
// time in them that the tests treat as past.
const CAPTURED_AT = Date.parse('2026-11-06T19:00:00Z');
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function loadFixture(root, name, now = Date.now()) {
  const shift = now - CAPTURED_AT;
  const text = readFileSync(join(root, 'tests', 'fixtures', name), 'utf8');
  return JSON.parse(text, (key, value) => (
    typeof value === 'string' && ISO_INSTANT.test(value)
      ? new Date(Date.parse(value) + shift).toISOString()
      : value
  ));
}
