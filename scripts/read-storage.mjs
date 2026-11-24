// Prints what this extension has stored in your own browser: each open stream's state, the reward
// IDs Twitch says you own, the day rewards, and how many minutes Twitch credited per unbroken run.
// For when Copy debug info is not enough (it leaves the owned IDs out) or not at hand.
// Run: npm run storage -- [--hook-since 2026-11-22T22:52Z] [--polls] [--compare bundle.json]
//   --hook-since  when the page hook went live, which storage does not say. Runs are split there.
//   --polls       also list every check still stored, oldest first (storage keeps a few hours).
//   --compare     a saved Copy debug info bundle to check this against. Exit 1 if they differ.
//   --id, --user-data, --profile  if the browser is not Brave's default profile on Windows, or the
//                 extension is not this checkout loaded unpacked.
// It opens one folder, `Local Extension Settings/<this extension's ID>`, copies it to a temp
// folder, reads the copy and deletes it. It never writes to the profile, opens no other file in it,
// uses no login and sends nothing. The output holds your channels: keep it out of the repo.
// Copying while the browser runs can catch a file half written. That prints "unreadable" (exit 2),
// never an empty result.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { LOG_MAX } from '../extension/lib/minutelog.js';
import { readDb, Unreadable } from './leveldb.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const COPY_TRIES = 3;
const RUN_MINUTES = 20; // Fewer says nothing about a rate.
const MAX_UNKNOWN = 1; // Unknown minutes in a row that still leave a run unbroken.

const iso = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
const minuteOf = (m) => iso(m * 60000).slice(0, 16).replace('T', ' ');

/** Chromium's ID for an unpacked extension: a hash of its path, as the browser holds the path. */
export function unpackedId(path, platform = process.platform) {
  const bytes = Buffer.from(path, platform === 'win32' ? 'utf16le' : 'utf8');
  return [...createHash('sha256').update(bytes).digest('hex').slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const DB_FILE = /^(\d+\.(ldb|log)|CURRENT|MANIFEST-\d+)$/;

function listing(src) {
  try {
    return readdirSync(src).filter((f) => DB_FILE.test(f)).sort();
  } catch {
    throw new Unreadable('the extension\'s storage folder is not there, or cannot be listed');
  }
}

function readCopy(src) {
  const copy = mkdtempSync(join(tmpdir(), 'drops-storage-'));
  try {
    const names = listing(src);
    for (const f of names) {
      try {
        copyFileSync(join(src, f), join(copy, f));
      } catch {
        throw new Unreadable(`${f} could not be copied`);
      }
    }
    // The live log only ever grows. Any other change means the copy spans two states.
    const after = listing(src);
    if (!isDeepStrictEqual(names, after)) throw new Unreadable('the browser changed its files during the copy');
    for (const f of names.filter((x) => x.startsWith('MANIFEST') || x === 'CURRENT')) {
      if (!readFileSync(join(copy, f)).equals(readFileSync(join(src, f)))) throw new Unreadable('the browser changed its files during the copy');
    }
    return readDb(Object.fromEntries(names.map((f) => [f, readFileSync(join(copy, f))])));
  } finally {
    rmSync(copy, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** The storage in a folder, read from a copy of it. Throws Unreadable. */
export function readStorage(src) {
  for (let i = 1; ; i++) {
    try {
      return readCopy(src);
    } catch (e) {
      if (!(e instanceof Unreadable) || i >= COPY_TRIES) throw e;
    }
  }
}

function parse(key, text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Unreadable(`the stored ${key} is not whole`);
  }
}

/** Minutes, credited minutes and the longest stretch with none, over rows in order. */
function tally(rows) {
  let flat = 0;
  let longestFlat = 0;
  let credited = 0;
  for (const r of rows) {
    credited += r.d || 0;
    flat = r.d ? 0 : flat + 1;
    longestFlat = Math.max(longestFlat, flat);
  }
  return { rows: rows.length, credited, longestFlat };
}

/**
 * Unbroken stretches of minutes credited to one channel, oldest first. A failed check, or one
 * minute with no row, is unknown: it stays in the run and in its length, since credit landing in it
 * shows in the next row. Two in a row, another channel, an uncredited row or a change to or from a
 * reward reading end the run, and so does the hook going live (hookSince, ms). notCounted: why a
 * run says nothing about the credit rate under the hook; empty means it does.
 */
export function creditedRuns(minuteLog, hookSince) {
  const hookMinute = hookSince == null ? null : Math.ceil(hookSince / 60000);
  const afterHook = (m) => hookMinute != null && m >= hookMinute;
  const runs = [];
  let open = null;
  const close = () => {
    if (open) runs.push(open);
    open = null;
  };
  for (const r of Array.isArray(minuteLog) ? minuteLog : []) {
    if (!r || r.x) continue; // Unknown: the gap it leaves is counted at the next row.
    if (!r.cr) {
      close();
      continue;
    }
    const last = open?.list[open.list.length - 1];
    const joins = last && last.c === r.c && !!last.rw === !!r.rw && r.m - last.m - 1 <= MAX_UNKNOWN && afterHook(last.m) === afterHook(r.m);
    if (!joins) {
      close();
      open = { list: [] };
    }
    open.list.push(r);
  }
  close();
  return runs.map(({ list }) => {
    const from = list[0].m;
    const to = list[list.length - 1].m;
    const minutes = to - from + 1;
    const run = { channel: list[0].c, from, to, minutes, ...tally(list), unknown: minutes - list.length, reward: !!list[0].rw, hook: afterHook(from) };
    const streams = Math.max(...list.map((r) => r.p ?? 0));
    const stopped = list.filter((r) => r.st !== 'playing').length;
    run.notCounted = [
      hookMinute == null ? 'no --hook-since given' : run.hook ? null : 'before the hook',
      minutes < RUN_MINUTES ? `under ${RUN_MINUTES} minutes` : null,
      streams > 1 ? `${streams} streams playing` : null,
      stopped ? `not playing for ${stopped} of ${list.length}` : null,
      run.reward ? 'reward reading' : null,
    ].filter(Boolean);
    return run;
  });
}

/** Every credited row per channel, most rows first, broken runs and reward readings included. */
export function channelTotals(minuteLog) {
  const by = new Map();
  for (const r of Array.isArray(minuteLog) ? minuteLog : []) {
    if (!r?.cr || r.x) continue;
    if (!by.has(r.c)) by.set(r.c, []);
    by.get(r.c).push(r);
  }
  return [...by].map(([channel, rows]) => ({ channel, ...tally(rows), reward: rows.filter((r) => r.rw).length }))
    .sort((a, b) => b.rows - a.rows);
}

const ownedIds = (state) => (Array.isArray(state?.rewards?.ids) ? state.rewards.ids : null);

export function ownedText(state) {
  const ids = ownedIds(state);
  if (!ids) return ['Owned reward IDs: not stored'];
  if (!ids.length) return ['0 owned reward IDs stored (Twitch never answered, or listed none: not a proof of none)'];
  return [`${ids.length} owned reward ID${ids.length === 1 ? '' : 's'}`, ...ids.map((id) => `  ${id}`)];
}

export function streamLines(state) {
  return (state?.streams ?? []).map((s) => [
    `${s.login || 'a Twitch page'}: ${s.channelState}${s.listedState && s.listedState !== s.channelState ? ` (lists: ${s.listedState})` : ''}`,
    s.playerState,
    s.credited ? 'credited' : null,
    s.hidden ? 'background' : 'front',
    `campaigns ${s.campaignIds?.join(' ') || 'none'}`,
  ].filter(Boolean).join(', '));
}

const dayLines = (list) => (Array.isArray(list)
  ? [`${list.length} day reward groups`, ...list.map((g) => `  ${g.groupId}: ${(g.days || []).map((d) => d.name || '?').join(', ')}${g.at ? ` (stored ${iso(g.at)})` : ''}`)]
  : ['Day rewards: not stored']);

const claimLines = (list) => (Array.isArray(list)
  ? [`${list.length} finished reward group${list.length === 1 ? '' : 's'}`, ...list.map((x) => `  ${x.campaignId}/${x.groupId}${x.at != null ? ` (stored ${iso(x.at)})` : ''}`)]
  : ['Finished reward groups: not stored']);

function runLine(r) {
  const why = r.notCounted.length ? `not counted: ${r.notCounted.join(', ')}` : 'COUNTS';
  return `  ${r.channel} ${minuteOf(r.from)} to ${minuteOf(r.to).slice(11)} UTC: ${r.credited} of ${r.minutes} minutes credited, longest flat ${r.longestFlat}${r.unknown ? `, ${r.unknown} unknown` : ''} (${why})`;
}

/** The whole printout for one reading: state, minuteLog and dayRewards as stored, or as in a bundle. */
export function report({ state, minuteLog, dayRewards, claimedGroups }, { hookSince = null } = {}) {
  const runs = creditedRuns(minuteLog, hookSince);
  const counting = runs.filter((r) => !r.notCounted.length);
  const log = Array.isArray(minuteLog);
  return [
    `Last check: ${state?.lastPollAt ? iso(state.lastPollAt) : 'not stored'}`,
    '',
    state?.streams?.length ? 'Streams' : `Streams: ${Array.isArray(state?.streams) ? 'none open at that check' : 'not stored'}`,
    ...streamLines(state).map((l) => `  ${l}`),
    '',
    ...ownedText(state),
    '',
    ...dayLines(dayRewards),
    '',
    ...claimLines(claimedGroups),
    '',
    `Minute log: ${log ? `${minuteLog.length} rows` : 'not stored'}`,
    ...(log && minuteLog.length ? [
      'Credited rows per channel',
      ...channelTotals(minuteLog).map((t) => `  ${t.channel}: ${t.credited} of ${t.rows}, longest flat ${t.longestFlat}${t.reward ? `, ${t.reward} of them reward readings` : ''}`),
      'Credited runs',
      ...runs.map(runLine),
      `Runs that count for the credit rate: ${counting.length}${counting.length ? `, ${counting.reduce((n, r) => n + r.credited, 0)} of ${counting.reduce((n, r) => n + r.minutes, 0)} minutes` : ''}`,
    ] : []),
  ].join('\n');
}

/** One line per check still stored, oldest first. */
export function pollList(history) {
  return history.filter((h) => h.key === 'state' && h.value != null).map((h) => {
    const s = parse('state', h.value);
    const ids = ownedIds(s);
    const streams = (s.streams ?? []).map((x) => `${x.login || 'a Twitch page'}:${x.channelState}`).join(' ');
    return `${s.lastPollAt != null ? iso(s.lastPollAt) : 'no time'} owned ${ids ? ids.length : 'not stored'} | ${streams || 'no streams'}`;
  });
}

/**
 * A Copy debug info bundle against storage. The state is compared with the stored check it was
 * copied from (same lastPollAt), so both being right at different times cannot pass or fail it.
 * match: true, false, or null when there was not enough in common to say.
 */
export function compareBundle(history, bundle) {
  const lines = [];
  let bad = false;
  let blank = false;
  const versions = (key) => history.filter((h) => h.key === key && h.value != null).map((h) => ({ seq: h.seq, value: parse(key, h.value) }));
  const poll = versions('state').findLast((v) => v.value.lastPollAt === bundle.state?.lastPollAt);
  if (!poll || bundle.state?.lastPollAt == null) {
    blank = true;
    lines.push('state: the bundle\'s check is no longer stored, so it is not compared');
  } else {
    const fields = Object.keys(bundle.state);
    const off = fields.filter((f) => !isDeepStrictEqual(bundle.state[f], poll.value[f]));
    bad ||= off.length > 0;
    lines.push(`state at the bundle's check: ${fields.length - off.length} of ${fields.length} fields the same${off.length ? `, different: ${off.join(', ')}` : ''}`);
  }

  // Any stored version of the log may still hold a row: the newest has dropped its oldest ones, and
  // a minute's row can be replaced within that minute.
  const logs = versions('minuteLog').map((v) => new Map(v.value.map((r) => [r.m, r])));
  const oldest = logs.flatMap((l) => [...l.keys()]).reduce((a, b) => Math.min(a, b), Infinity);
  const rows = Array.isArray(bundle.minuteLog) ? bundle.minuteLog : [];
  // Only a full log drops its oldest rows, so a shorter one missing a row is a difference.
  const wasFull = logs.some((l) => l.size >= LOG_MAX);
  const inRange = rows.filter((r) => !wasFull || r.m >= oldest);
  const pushedOut = rows.length - inRange.length;
  const isSame = (r) => logs.some((l) => isDeepStrictEqual(l.get(r.m), r));
  // A second check in the minute the bundle was copied replaces that minute's row (addMinute).
  const newest = inRange[inRange.length - 1];
  const replaced = newest && !isSame(newest) && logs.some((l) => l.has(newest.m));
  const compared = replaced ? inRange.slice(0, -1) : inRange;
  const same = compared.filter(isSame);
  if (!same.length) blank = true;
  bad ||= same.length < compared.length;
  const notes = [
    pushedOut ? `${pushedOut} older ones no longer stored` : null,
    replaced ? 'its newest minute was still being written, not compared' : null,
  ].filter(Boolean);
  lines.push(`minute log: ${same.length} of ${compared.length} rows the same${notes.length ? ` (${notes.join('; ')})` : ''}`);

  const days = versions('dayRewards');
  const daysSame = days.some((v) => isDeepStrictEqual(v.value, bundle.dayRewards)) || (!days.length && !bundle.dayRewards?.length);
  // With the bundle's check gone, its day rewards may have been replaced since as well.
  if (!daysSame && !poll) blank = true;
  else bad ||= !daysSame;
  lines.push(`dayRewards: ${daysSame ? 'the same' : poll ? 'different' : 'that version is no longer stored, so they are not compared'}`);
  return { match: bad ? false : blank ? null : true, lines };
}

function main() {
  const { values: args } = parseArgs({ options: {
    'hook-since': { type: 'string' },
    polls: { type: 'boolean' },
    compare: { type: 'string' },
    id: { type: 'string' },
    'user-data': { type: 'string' },
    profile: { type: 'string', default: 'Default' },
  } });
  const hookSince = args['hook-since'] == null ? null : Date.parse(args['hook-since']);
  if (Number.isNaN(hookSince)) throw new Error('--hook-since is not a date');
  const id = args.id ?? unpackedId(realpathSync.native(join(root, 'extension')));
  if (!/^[a-p]{32}$/.test(id)) throw new Error('--id is not an extension ID');
  if (/[\\/]|^\.\.?$/.test(args.profile)) throw new Error('--profile is a folder name, such as Default');
  const userData = args['user-data'] ?? join(homedir(), 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data');
  // PowerShell saves text with a byte order mark (U+FEFF), which JSON does not allow.
  const text = args.compare ? readFileSync(args.compare, 'utf8') : null;
  const bundle = text == null ? null : JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

  const src = join(userData, args.profile, 'Local Extension Settings', id);
  const db = readStorage(src);
  const stored = (key) => (db.values.has(key) ? parse(key, db.values.get(key)) : undefined);
  const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
  console.log(`Extension ${id}, version in this checkout ${manifest.version} (the browser may still run an older one until Reload)`);
  if (db.tailDropped) console.log('The browser was writing during the copy: its unfinished last write is left out.');
  console.log(report({ state: stored('state'), minuteLog: stored('minuteLog'), dayRewards: stored('dayRewards'), claimedGroups: stored('claimedGroups') }, { hookSince }));
  if (args.polls) console.log(['', 'Checks still stored', ...pollList(db.history).map((l) => `  ${l}`)].join('\n'));
  if (bundle) {
    const c = compareBundle(db.history, bundle);
    console.log(['', `Against the bundle copied ${bundle.copiedAt}: ${c.match === null ? 'NOT ENOUGH IN COMMON' : c.match ? 'MATCH' : 'DIFFERENT'}`, ...c.lines.map((l) => `  ${l}`)].join('\n'));
    if (c.match !== true) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Unreadable ? `unreadable: ${e.message}` : e.message);
    process.exitCode = e instanceof Unreadable ? 2 : 1;
  }
}
