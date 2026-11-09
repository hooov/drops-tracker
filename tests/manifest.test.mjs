import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ext = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const read = (path) => readFileSync(join(ext, path), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

/** Modules a Twitch page has to be allowed to load: what content.js imports, and what those import. */
function modulesLoadedOnThePage() {
  const found = new Set();
  const visit = (path) => {
    if (found.has(path)) return;
    found.add(path);
    for (const [, spec] of read(path).matchAll(/^import .* from '(\.[^']+)';$/gm)) {
      visit(posix.normalize(posix.join(posix.dirname(path), spec)));
    }
  };
  for (const [, path] of read('content.js').matchAll(/import\(chrome\.runtime\.getURL\('([^']+)'\)\)/g)) visit(path);
  return [...found];
}

const unlisted = (m) => {
  const allowed = new Set(m.web_accessible_resources.flatMap((w) => w.resources));
  return modulesLoadedOnThePage().filter((path) => !allowed.has(path));
};

test('the walk finds the modules, so the check below cannot pass by finding nothing', () => {
  const modules = modulesLoadedOnThePage();
  for (const path of ['lib/chip.js', 'lib/panel.js', 'lib/settings.js', 'lib/directory.js']) {
    assert.ok(modules.includes(path), path);
  }
});

test('every module the chat panel loads is web accessible, or Brave blocks it and the panel fails', () => {
  assert.deepEqual(unlisted(manifest), []);
});

test('that check does fail when a module is left out', () => {
  const stale = structuredClone(manifest);
  stale.web_accessible_resources[0].resources = stale.web_accessible_resources[0].resources.filter((r) => r !== 'lib/directory.js');
  assert.deepEqual(unlisted(stale), ['lib/directory.js']);
});

test('the page hook runs in the page and early enough to see the first request', () => {
  const hook = manifest.content_scripts.find((c) => c.js.includes('page-hook.js'));
  assert.equal(hook.world, 'MAIN');
  assert.equal(hook.run_at, 'document_start');
  const bridge = manifest.content_scripts.find((c) => c.js.includes('page-bridge.js'));
  assert.equal(bridge.world, undefined, 'the bridge needs extension APIs, so it cannot run in the page');
});

// Each permission is justified in the Chrome Web Store listing and described in the privacy policy
// at hovjsyy.dev/drops-tracker/privacy/. Adding one means updating both, and it may trigger a new
// install warning that disables the extension for existing users until they accept it.
test('permissions are exactly the reviewed set', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'cookies', 'notifications', 'scripting', 'storage', 'webRequest']);
  // Only the hosts the code uses (store-policy audit, 2026-11-09): the wildcard also covered
  // passport, dashboard and every other Twitch subdomain.
  assert.deepEqual(manifest.host_permissions, ['https://www.twitch.tv/*', 'https://m.twitch.tv/*', 'https://gql.twitch.tv/*']);
});

// "tabs" adds the "Read your browsing history" warning. Host permissions already expose url for
// Twitch tabs, which is all this reads, but only when every query is filtered to Twitch.
test('every tabs.query is filtered to Twitch or the active tab', () => {
  for (const file of ['background.js', 'popup.js']) {
    for (const [call] of read(file).matchAll(/chrome\.tabs\.query\([^)]*\)/g)) {
      assert.match(call, /url: (TWITCH_TABS|DROPS_PAGES)|active: true/, `${file}: ${call}`);
    }
  }
});
