// The GQL operations Twitch's own page sends, so a change on Twitch's side (data moved to a new
// query, a query renamed) can be found from Copy debug info instead of by guessing. Pure, no chrome.*.
//
// Kept per operation: its hash, the names of its variables with their types (booleans verbatim,
// since they switch fields on and off; never a string or number value, which can be a user ID),
// where it was seen, and when. Bound: MAX_PAGE_OPS operations, the oldest seen dropped first.

export const MAX_PAGE_OPS = 150; // Twitch's channel page sent about 60 distinct operations.
const MAX_VARS = 20;
const MAX_WHERE = 6;
const NAME = /^[A-Za-z0-9_]{1,80}$/;
const HASH = /^[a-f0-9]{64}$/;

function shape(variables) {
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return {};
  const out = {};
  for (const [k, v] of Object.entries(variables).slice(0, MAX_VARS)) {
    if (!NAME.test(k)) continue;
    out[k] = typeof v === 'boolean' ? v : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  }
  return out;
}

/** Every operation in one request body, with no values that could identify anyone. */
export function extractOps(bodyText) {
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch { return []; }
  const ops = [];
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    const op = item?.operationName;
    if (typeof op !== 'string' || !NAME.test(op)) continue;
    const hash = item?.extensions?.persistedQuery?.sha256Hash;
    ops.push({ op, hash: HASH.test(hash ?? '') ? hash : null, vars: shape(item.variables) });
  }
  return ops;
}

/** What kind of Twitch page a URL is, never which channel: "channel", "drops/inventory", "home". */
export function pageKind(url, isChannel) {
  if (isChannel) return 'channel';
  let u;
  try { u = new URL(url); } catch { return 'unknown'; }
  const parts = u.pathname.split('/').filter(Boolean);
  if (!parts.length) return 'home';
  return parts.slice(0, 2).filter((p) => NAME.test(p)).join('/') || 'other';
}

/** stored: { op: { hash, vars, where: [], first, last, count } }. Returns the new map. */
export function addPageOps(stored, ops, where, now) {
  const next = { ...(stored && typeof stored === 'object' ? stored : {}) };
  for (const { op, hash, vars } of ops) {
    const old = next[op];
    const places = old?.where?.includes(where) ? old.where : [...(old?.where ?? []), where].slice(-MAX_WHERE);
    next[op] = { hash: hash ?? old?.hash ?? null, vars, where: places, first: old?.first ?? now, last: now, count: (old?.count ?? 0) + 1 };
  }
  const names = Object.keys(next);
  if (names.length > MAX_PAGE_OPS) {
    names.sort((a, b) => next[a].last - next[b].last);
    for (const op of names.slice(0, names.length - MAX_PAGE_OPS)) delete next[op];
  }
  return next;
}

/** The ones worth a line in the Debug tab: anything about drops, badges or rewards. */
export function dropOps(stored) {
  return Object.entries(stored ?? {})
    .filter(([op]) => /drop|badge|reward|campaign|quest/i.test(op))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([op, o]) => ({
      op,
      line: [
        o.hash ? o.hash.slice(0, 8) : 'no hash',
        (o.where ?? []).join(' '),
        Object.keys(o.vars ?? {}).join(',') || 'no vars',
        `x${o.count}`,
      ].join(', '),
    }));
}
