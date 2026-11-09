// The tracker's states, declared once. Every place that shows or acts on a state reads it from
// here, so a new state is added in one table instead of in three files, and tests/states.test.mjs
// fails when the tracker can produce a state that is missing from a table. Pure, no chrome.*.
// The map of how these move, and where: docs/state-machines.md.

/**
 * Why minutes stopped while a stream that can earn is open (verdict.cause, set by diagnose() in
 * tracker.js). autoReload: Auto-reload may reload the tab. reloadButton: the panel offers Reload.
 * They differ for no_video on purpose: a player the extension cannot see may only have been moved
 * by Twitch, so it never reloads by itself, but the user may choose to.
 */
export const STALL_CAUSES = {
  uncounted: { autoReload: true, reloadButton: true },
  frozen: { autoReload: true, reloadButton: true },
  ended: { autoReload: true, reloadButton: true },
  asleep: { autoReload: true, reloadButton: true },
  no_video: { autoReload: false, reloadButton: true },
  paused: { autoReload: false, reloadButton: false }, // The user's own pause.
  claim_first: { autoReload: false, reloadButton: false }, // A reload cannot claim a drop.
  too_many: { autoReload: false, reloadButton: false }, // The cause is the other streams.
  second_stream: { autoReload: false, reloadButton: false },
};

/**
 * A tab's video player (stream.playerState, from classifyPlayer() in tracker.js). label: the
 * Open streams row. stall: the stalled verdict's message when this is why, given the tab's name.
 * playing never explains a stall.
 */
export const PLAYER_STATES = {
  playing: { label: null, stall: null },
  asleep: { label: 'Tab asleep', stall: (name) => `The browser put the ${name} tab to sleep.` },
  paused: { label: 'Paused', stall: (name) => `${name} is paused.` },
  frozen: { label: 'Player frozen', stall: (name) => `The ${name} player is frozen.` },
  ended: { label: 'Player ended', stall: (name) => `The ${name} player has ended.` },
  no_video: { label: 'No player', stall: (name) => `Cannot see a player in the ${name} tab, and Twitch is not adding minutes.` },
};

/**
 * What a tab's channel can do for Drops (stream.channelState, from classifyChannel() in
 * tracker.js). Only eligible can earn. label: the Open streams row when it is not earning.
 */
export const CHANNEL_STATES = {
  eligible: { label: 'Can earn, not credited' },
  no_drops: { label: 'No Drops on this channel' },
  sub_only: { label: 'Drops here only come from subs' },
  badge_unseen: { label: 'Badge timer, no minutes reported' },
  blocked: { label: 'Next drop cannot count yet' },
  finished: { label: 'Campaign finished' },
  offline: { label: 'Offline' },
  unknown: { label: 'Cannot check this channel' },
  unstarted: { label: 'Campaign not started yet' },
  not_channel: { label: 'Uses a stream slot' },
};

/** The one channel state that can earn. */
export const canEarn = (stream) => stream?.channelState === 'eligible';

/**
 * Every verdict.code the tracker writes. The extra fields each one may carry are listed so a reader
 * knows what is meaningful where: anything else on a verdict is left over and must not be read.
 */
export const VERDICT_CODES = {
  starting: [], // Before the first poll.
  waiting: ['since'], // Something can earn; the first minute has not landed yet.
  earning: ['channel', 'slow', 'wasted'],
  stalled: ['since', 'cause', 'message', 'tabId', 'otherTabId'],
  idle: ['hasStreams', 'lost', 'limited', 'badge', 'blocked', 'message'],
  signed_out: ['message'],
  api_changed: ['message'],
  error: ['message'],
};

/**
 * One colour rule for the verdict, shared by the panel and the chip: bad when minutes stopped,
 * warn when earning is not as it should be or tracking is in doubt, info while waiting or
 * starting, ok when earning, idle otherwise. lost and limited only exist on idle.
 */
export function verdictTone(v) {
  switch (v?.code) {
    case 'stalled': return 'bad';
    case 'earning': return v.slow || v.wasted ? 'warn' : 'ok';
    case 'waiting':
    case 'starting': return 'info';
    case 'signed_out':
    case 'api_changed':
    case 'error': return 'warn';
    case 'idle': return v.lost || v.limited ? 'warn' : 'idle';
    default: return 'idle';
  }
}

/** Watched minutes before a credit rate means anything: below this, "slow" is not judged. */
export const RATE_MIN_MINUTES = 10;
