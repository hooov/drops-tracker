// Makes tests/fixtures/extension-storage/, the storage folder tests/leveldb.test.mjs reads.
// Run: node scripts/make-storage-fixture.mjs (needed again only to change the fixture).
// A real browser writes it, in a throwaway profile with a throwaway extension and made-up values,
// so the reader is checked against Chromium's own LevelDB and not against a writer of ours. Opens
// no page at all. Two sessions: enough is written in the first to make the browser flush a
// compressed table, and the second leaves newer values and a removal in the log.
import { chromium } from 'playwright-core';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'tests', 'fixtures', 'extension-storage');
const BROWSER = process.env.E2E_BROWSER || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const work = mkdtempSync(join(tmpdir(), 'drops-storage-fixture-'));
const ext = join(work, 'ext');
const profile = join(work, 'profile');
mkdirSync(ext);
writeFileSync(join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'storage fixture', version: '1', permissions: ['storage', 'unlimitedStorage'], background: { service_worker: 'sw.js' } }));
writeFileSync(join(ext, 'sw.js'), '');

async function session(run) {
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: BROWSER,
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    await sw.evaluate(run);
    return new URL(sw.url()).host;
  } finally {
    await ctx.close();
  }
}

try {
  await session(async () => {
    const set = (o) => chrome.storage.local.set(o);
    await set({ unchanged: { text: 'still here', accents: 'é 한글' }, gone: 'removed in the second session' });
    const rows = [];
    for (let i = 0; i < 400; i++) rows.push({ m: 1000 + i, c: `alphatv`, d: i % 2, note: `row ${i} of 400` });
    await set({ many: rows });
    // Just over LevelDB's 4 MB write buffer, so the next small write flushes a table and starts a
    // log with nothing large in it. The filler is removed first, so the table stays small.
    for (let i = 0; i < 21; i++) await set({ filler: 'x'.repeat(200000) + i });
    await set({ state: { n: 1, pad: 'abcdefgh'.repeat(500) } });
    await chrome.storage.local.remove('filler');
  });
  const id = await session(async () => {
    const set = (o) => chrome.storage.local.set(o);
    for (let i = 0; i < 3; i++) await set({ state: { n: 100 + i, pad: '' } });
    // Over one 32 KB log block, so its record is split.
    await set({ long: Array.from({ length: 9000 }, (_, i) => i).join(',') });
    await chrome.storage.local.remove('gone');
  });
  const src = join(profile, 'Default', 'Local Extension Settings', id);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // Not LOG: it is text and holds the folder's full path.
  for (const f of readdirSync(src).filter((x) => /^(\d+\.(ldb|log)|CURRENT|MANIFEST-\d+)$/.test(x))) {
    copyFileSync(join(src, f), join(out, f));
    console.log(f, statSync(join(out, f)).size);
  }
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
